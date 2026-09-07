import { Router, type IRouter } from "express";
import { resolveOfficeScope, respondOfficeScopeDenied } from "../auth/office-scope";
import { requireHqPermission } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";

const router: IRouter = Router();

export function operationalMetrics(row: Record<string, unknown> | undefined) {
  const n = (key: string) => {
    const value = Number(row?.[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    providerCount: n("provider_count"),
    totalPatients: n("total_patients"),
    activePatients: n("active_patients"),
    enrollments30d: n("enrollments_30d"),
    engaged7d: n("engaged_7d"),
    needsAttention: n("needs_attention"),
    inactive: n("inactive"),
    invited: n("invited"),
    watchlist: n("watchlist"),
    loggingLapsed: n("logging_lapsed"),
    checkInsOverdue: n("check_ins_overdue"),
    avgPoundsLost: row?.avg_pounds_lost == null ? null : n("avg_pounds_lost"),
  };
}

async function load(providerId: string | null) {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/nonfinancial_operational_rollup", {
    p_provider_id: providerId,
    p_as_of: new Date().toISOString().slice(0, 10),
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`operational rollup failed (${result.status})`);
  }
  return operationalMetrics(result.json[0] as Record<string, unknown> | undefined);
}

/* ---------------------------------------------------------------- ranges */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_RANGE_DAYS = 366;

function utcDateKey(value: string): number | null {
  if (!DATE_KEY.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

export interface DateRangeKeys {
  start: string;
  end: string;
}

/**
 * Validate a `start`/`end` query pair: real calendar days, start <= end,
 * at most a year. Returns null (and the caller answers 400) otherwise.
 */
export function parseRange(query: Record<string, unknown>): DateRangeKeys | null {
  const start = typeof query.start === "string" ? query.start : "";
  const end = typeof query.end === "string" ? query.end : "";
  const startMs = utcDateKey(start);
  const endMs = utcDateKey(end);
  if (startMs === null || endMs === null || startMs > endMs) return null;
  if ((endMs - startMs) / 86_400_000 + 1 > MAX_RANGE_DAYS) return null;
  return { start, end };
}

const RANGE_ERROR = "Use valid start and end date keys spanning at most 366 days.";

/* ------------------------------------------------------- office rollups */

/**
 * One office's figures for a range. Point-in-time counts are as of the range
 * END; enrollments count inside the range; engaged / logging / check-in
 * patients (and the adherence percentages derived from them) use the trailing
 * 7-day window ending on the range end; avgPoundsLost averages ACTIVE
 * patients with recorded weights. `available` is false when the whole range
 * predates the office's first patient record — the UI shows "unavailable"
 * for those, never zero.
 */
export function officeRollupDto(row: Record<string, unknown>, range: DateRangeKeys) {
  const n = (key: string) => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const firstPatientDate = typeof row.first_patient_date === "string" ? row.first_patient_date.slice(0, 10) : null;
  const available = firstPatientDate !== null && firstPatientDate <= range.end;
  const activePatients = n("active_patients");
  const checkInPatients = n("check_in_patients");
  const loggingPatients = n("logging_patients");
  const rate = (part: number) => (activePatients > 0 ? Math.round((part / activePatients) * 1000) / 10 : null);
  return {
    providerId: String(row.provider_id),
    officeName: String(row.office_name ?? row.provider_name ?? "Office"),
    providerName: String(row.provider_name ?? row.office_name ?? ""),
    firstPatientDate,
    available,
    metrics: available
      ? {
          totalPatients: n("total_patients"),
          activePatients,
          enrollments: n("enrollments"),
          engaged: n("engaged"),
          needsAttention: n("needs_attention"),
          inactive: n("inactive"),
          invited: n("invited"),
          loggingLapsed: n("logging_lapsed"),
          checkInsOverdue: n("check_ins_overdue"),
          loggingPatients,
          checkInPatients,
          loggingAdherencePct: rate(loggingPatients),
          checkInAdherencePct: rate(checkInPatients),
          avgPoundsLost: row.avg_pounds_lost == null ? null : n("avg_pounds_lost"),
        }
      : null,
  };
}

export type OfficeRollupDto = ReturnType<typeof officeRollupDto>;

export function seriesPointDto(row: Record<string, unknown>) {
  const n = (key: string) => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    date: String(row.date).slice(0, 10),
    activePatients: n("active_patients"),
    engagedPatients: n("engaged_patients"),
    enrollments: n("enrollments"),
    checkIns: n("check_ins"),
  };
}

export type SeriesPointDto = ReturnType<typeof seriesPointDto>;

export async function loadOfficeRollups(providerId: string | null, range: DateRangeKeys): Promise<OfficeRollupDto[]> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/nonfinancial_office_rollup", {
    p_provider_id: providerId,
    p_start: range.start,
    p_end: range.end,
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`office rollup failed (${result.status})`);
  }
  return (result.json as Record<string, unknown>[]).map((row) => officeRollupDto(row, range));
}

export async function loadOfficeSeries(providerId: string | null, range: DateRangeKeys): Promise<Map<string, SeriesPointDto[]>> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/nonfinancial_office_daily", {
    p_provider_id: providerId,
    p_start: range.start,
    p_end: range.end,
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`office daily series failed (${result.status})`);
  }
  const byOffice = new Map<string, SeriesPointDto[]>();
  for (const raw of result.json as Record<string, unknown>[]) {
    const id = String(raw.provider_id);
    const list = byOffice.get(id) ?? [];
    list.push(seriesPointDto(raw));
    byOffice.set(id, list);
  }
  return byOffice;
}

/**
 * Trim a series to the days the office actually has data for (from its
 * first patient record onward) so a sparkline never draws a flat zero run
 * for days that predate the dataset.
 */
function availableSeries(points: SeriesPointDto[] | undefined, firstPatientDate: string | null): SeriesPointDto[] {
  if (!points || !firstPatientDate) return [];
  return points.filter((point) => point.date >= firstPatientDate);
}

/* -------------------------------------------------------------- routes */

router.get("/office/overview", async (req, res) => {
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      respondOfficeScopeDenied(req, res, resolved);
      return;
    }
    res.json({
      scope: { kind: "office", providerId: resolved.scope.providerId, officeName: resolved.scope.officeName },
      asOf: new Date().toISOString(),
      metrics: await load(resolved.scope.providerId),
    });
  } catch (error) {
    req.log?.error({ err: error }, "office rollup failed");
    res.status(502).json({ error: "Could not load the office overview right now." });
  }
});

router.get("/hq/overview", requireHqPermission("analytics_read"), async (req, res) => {
  try {
    res.json({
      scope: { kind: "hq", providerId: null, officeName: null },
      asOf: new Date().toISOString(),
      metrics: await load(null),
    });
  } catch (error) {
    req.log?.error({ err: error }, "HQ rollup failed");
    res.status(502).json({ error: "Could not load the HQ overview right now." });
  }
});

/** Every enabled office for a range, with its daily engagement series. */
router.get("/hq/office-comparison", requireHqPermission("analytics_read"), async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>);
  if (!range) {
    res.status(400).json({ error: RANGE_ERROR });
    return;
  }
  try {
    const [offices, series] = await Promise.all([loadOfficeRollups(null, range), loadOfficeSeries(null, range)]);
    res.json({
      range,
      asOf: new Date().toISOString(),
      offices: offices.map((office) => ({
        ...office,
        series: availableSeries(series.get(office.providerId), office.firstPatientDate),
      })),
    });
  } catch (error) {
    req.log?.error({ err: error }, "HQ office comparison failed");
    res.status(502).json({ error: "Could not load the office comparison right now." });
  }
});

/** One office's range figures + daily series (own office, or HQ by id). */
router.get("/office/analytics", async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>);
  if (!range) {
    res.status(400).json({ error: RANGE_ERROR });
    return;
  }
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      respondOfficeScopeDenied(req, res, resolved);
      return;
    }
    const providerId = resolved.scope.providerId;
    const [offices, series] = await Promise.all([loadOfficeRollups(providerId, range), loadOfficeSeries(providerId, range)]);
    const office = offices.find((row) => row.providerId === providerId);
    if (!office) {
      res.status(404).json({ error: "That office isn't available." });
      return;
    }
    res.json({
      office: { providerId, officeName: resolved.scope.officeName },
      range,
      asOf: new Date().toISOString(),
      firstPatientDate: office.firstPatientDate,
      available: office.available,
      metrics: office.metrics,
      series: availableSeries(series.get(providerId), office.firstPatientDate),
    });
  } catch (error) {
    req.log?.error({ err: error }, "office analytics failed");
    res.status(502).json({ error: "Could not load office analytics right now." });
  }
});

export default router;
