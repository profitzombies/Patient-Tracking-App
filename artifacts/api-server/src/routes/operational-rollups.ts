import { Router, type IRouter } from "express";
import { resolveOfficeScope, respondOfficeScopeDenied } from "../auth/office-scope";
import { requireHqPermission } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { loadAppReviewOfficeIds, loadInactiveOfficeIds } from "../lib/office-status";
import { inboxMetrics } from "./staff-conversations";
import {
  assembleInsights,
  isInsightsDataset,
  previousRangeOf,
  type DayHourBucket,
  type InsightsBounds,
  type InsightsDataset,
} from "@workspace/app-usage-insights";

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
  const [metrics, inbox] = await Promise.all([
    Promise.resolve(operationalMetrics(result.json[0] as Record<string, unknown> | undefined)),
    inboxMetrics(providerId),
  ]);
  return { ...metrics, inbox };
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
  const [result, inactiveOffices] = await Promise.all([
    supabaseAdmin("POST", "/rest/v1/rpc/nonfinancial_office_rollup", {
      p_provider_id: providerId,
      p_start: range.start,
      p_end: range.end,
    }),
    // The rollup only knows access_disabled (set once an office is fully
    // offboarded); offices mid-offboarding leave the comparison here.
    providerId === null ? loadInactiveOfficeIds() : Promise.resolve(new Set<string>()),
  ]);
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`office rollup failed (${result.status})`);
  }
  return (result.json as Record<string, unknown>[])
    .filter((row) => !inactiveOffices.has(String(row.provider_id)))
    .map((row) => officeRollupDto(row, range));
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

/* ------------------------------------------------------------ app usage */

/**
 * Active app users. An active app user is a patient with a real account who,
 * on a local day, opened the app (presence) or performed any in-app action
 * the server records. Weekly = trailing 7 days, monthly = trailing 30 days.
 * The network tiles (`network.*`) end on each patient's local TODAY (live
 * "now" figures); the per-office rows and both series end on the range end.
 * Patients belong to exactly one office, so network figures are sums of the
 * per-office distinct counts.
 */
export interface AppUsageOfficeRow {
  providerId: string;
  officeName: string;
  providerName: string;
  firstPatientDate: string | null;
  available: boolean;
  metrics: {
    activatedPatients: number;
    weeklyActive: number;
    monthlyActive: number;
    weeklySharePct: number | null;
    monthlySharePct: number | null;
  } | null;
  series: AppUsagePoint[];
}

export interface AppUsagePoint {
  date: string;
  weeklyActive: number;
  monthlyActive: number;
}

function sharePct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function appUsageOfficeDto(row: Record<string, unknown>, range: DateRangeKeys) {
  const n = (key: string) => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const firstPatientDate = typeof row.first_patient_date === "string" ? row.first_patient_date.slice(0, 10) : null;
  const available = firstPatientDate !== null && firstPatientDate <= range.end;
  const activatedPatients = n("activated_patients");
  const weeklyActive = n("weekly_active");
  const monthlyActive = n("monthly_active");
  const office: AppUsageOfficeRow = {
    providerId: String(row.provider_id),
    officeName: String(row.office_name ?? row.provider_name ?? "Office"),
    providerName: String(row.provider_name ?? row.office_name ?? ""),
    firstPatientDate,
    available,
    metrics: available
      ? {
          activatedPatients,
          weeklyActive,
          monthlyActive,
          weeklySharePct: sharePct(weeklyActive, activatedPatients),
          monthlySharePct: sharePct(monthlyActive, activatedPatients),
        }
      : null,
    series: [],
  };
  // Live ("today") figures ride alongside for the network totals.
  const live = {
    activatedPatientsNow: n("activated_patients_now"),
    activeNow: n("active_now"),
    activeToday: n("active_today"),
    weeklyActiveToday: n("weekly_active_today"),
    monthlyActiveToday: n("monthly_active_today"),
  };
  return { office, live };
}

export function appUsagePointDto(row: Record<string, unknown>): AppUsagePoint {
  const n = (key: string) => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  return { date: String(row.date).slice(0, 10), weeklyActive: n("weekly_active"), monthlyActive: n("monthly_active") };
}

async function loadAppUsageOffices(range: DateRangeKeys, at: Date) {
  // The App Review office's sample patients are not app usage: drop it before
  // the network sums (the RPC only knows access_disabled).
  const [result, reviewOffices] = await Promise.all([
    supabaseAdmin("POST", "/rest/v1/rpc/patient_app_usage_offices", {
      p_start: range.start,
      p_end: range.end,
      p_at: at.toISOString(),
    }),
    loadAppReviewOfficeIds(),
  ]);
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`app usage offices failed (${result.status})`);
  }
  return (result.json as Record<string, unknown>[])
    .filter((row) => !reviewOffices.has(String(row.provider_id)))
    .map((row) => appUsageOfficeDto(row, range));
}

async function loadAppUsageSeries(range: DateRangeKeys): Promise<Map<string, AppUsagePoint[]>> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_app_usage_daily", {
    p_start: range.start,
    p_end: range.end,
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`app usage daily series failed (${result.status})`);
  }
  const byOffice = new Map<string, AppUsagePoint[]>();
  for (const raw of result.json as Record<string, unknown>[]) {
    const id = String(raw.provider_id);
    const list = byOffice.get(id) ?? [];
    list.push(appUsagePointDto(raw));
    byOffice.set(id, list);
  }
  return byOffice;
}

/**
 * Assemble the HQ app-usage payload from the two RPC result sets. Exported so
 * the network arithmetic (sums, shares, trimmed series) is unit-testable.
 */
export function assembleAppUsage(
  range: DateRangeKeys,
  rows: ReturnType<typeof appUsageOfficeDto>[],
  series: Map<string, AppUsagePoint[]>,
  asOf: Date,
) {
  const offices = rows.map(({ office }) => ({
    ...office,
    series: office.firstPatientDate
      ? (series.get(office.providerId) ?? []).filter((point) => point.date >= office.firstPatientDate!)
      : [],
  }));
  const sum = (pick: (row: ReturnType<typeof appUsageOfficeDto>) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const activatedPatients = sum((row) => row.live.activatedPatientsNow);
  const activatedAtRangeEnd = sum((row) => row.office.metrics?.activatedPatients ?? 0);
  const weeklyAtRangeEnd = sum((row) => row.office.metrics?.weeklyActive ?? 0);
  const monthlyAtRangeEnd = sum((row) => row.office.metrics?.monthlyActive ?? 0);
  const activeNow = sum((row) => row.live.activeNow);
  const activeToday = sum((row) => row.live.activeToday);
  const weeklyActive = sum((row) => row.live.weeklyActiveToday);
  const monthlyActive = sum((row) => row.live.monthlyActiveToday);
  // Network series: sum per date across the offices that have data that day.
  const byDate = new Map<string, AppUsagePoint>();
  for (const office of offices) {
    for (const point of office.series) {
      const current = byDate.get(point.date) ?? { date: point.date, weeklyActive: 0, monthlyActive: 0 };
      current.weeklyActive += point.weeklyActive;
      current.monthlyActive += point.monthlyActive;
      byDate.set(point.date, current);
    }
  }
  const networkSeries = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const firstPatientDates = offices.map((office) => office.firstPatientDate).filter((d): d is string => d !== null).sort();
  const firstPatientDate = firstPatientDates[0] ?? null;
  return {
    range,
    asOf: asOf.toISOString(),
    network: {
      firstPatientDate,
      available: firstPatientDate !== null && firstPatientDate <= range.end,
      activatedPatients,
      activeNow,
      activeToday,
      weeklyActive,
      monthlyActive,
      activeNowSharePct: sharePct(activeNow, activatedPatients),
      activeTodaySharePct: sharePct(activeToday, activatedPatients),
      weeklySharePct: sharePct(weeklyActive, activatedPatients),
      monthlySharePct: sharePct(monthlyActive, activatedPatients),
      atRangeEnd: {
        activatedPatients: activatedAtRangeEnd,
        weeklyActive: weeklyAtRangeEnd,
        monthlyActive: monthlyAtRangeEnd,
        weeklySharePct: sharePct(weeklyAtRangeEnd, activatedAtRangeEnd),
        monthlySharePct: sharePct(monthlyAtRangeEnd, activatedAtRangeEnd),
      },
      series: networkSeries,
    },
    offices,
  };
}

export type AppUsageResult = ReturnType<typeof assembleAppUsage>;

/* -------------------------------------------------------------- routes */

router.get("/office/overview", async (req, res) => {
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
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

/** Live weekly / monthly active app users, network-wide and per office. */
router.get("/hq/app-usage", requireHqPermission("analytics_read"), async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>);
  if (!range) {
    res.status(400).json({ error: RANGE_ERROR });
    return;
  }
  try {
    const now = new Date();
    const [rows, series] = await Promise.all([loadAppUsageOffices(range, now), loadAppUsageSeries(range)]);
    res.json(assembleAppUsage(range, rows, series, now));
  } catch (error) {
    req.log?.error({ err: error }, "HQ app usage failed");
    res.status(502).json({ error: "Could not load app usage right now." });
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
      request: req,
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


/* --------------------------------------------------------- app insights */

// Provider ids are text (`live-…` for real offices, `acct-p1`-style legacy
// seeds), not UUIDs: accept any bounded, printable id and let the exact
// (URL-encoded) lookup decide whether the office exists.
const PROVIDER_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const INSIGHTS_DATASET_ERROR = "Use one of the app usage datasets.";

function insightBucketDto(row: Record<string, unknown>): DayHourBucket {
  const n = (value: unknown) => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
  };
  return {
    day: String(row.local_day ?? "").slice(0, 10),
    hour: n(row.local_hour),
    events: n(row.events),
    patients: n(row.patients),
  };
}

async function loadInsightBuckets(dataset: InsightsDataset, range: DateRangeKeys, providerId: string | null): Promise<DayHourBucket[]> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_app_event_insights", {
    p_feature: dataset,
    p_start: range.start,
    p_end: range.end,
    p_provider_id: providerId,
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`app usage insights failed (${result.status})`);
  }
  return (result.json as Record<string, unknown>[]).map(insightBucketDto);
}

async function loadInsightBounds(dataset: InsightsDataset, providerId: string | null): Promise<InsightsBounds> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_app_event_bounds", {
    p_feature: dataset,
    p_provider_id: providerId,
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`app usage insight bounds failed (${result.status})`);
  }
  const row = (result.json[0] ?? {}) as { first_day?: unknown; first_hourly_day?: unknown };
  const day = (value: unknown) => (typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null);
  return { firstDay: day(row.first_day), firstHourlyDay: day(row.first_hourly_day) };
}

/** Enabled office by id, or null when unknown / disabled (mirrors the app-usage office rows). */
async function loadInsightOffice(providerId: string): Promise<{ id: string; name: string } | null> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&access_disabled=is.false&select=provider_id,provider_name,office_name&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`app usage insight office failed (${result.status})`);
  }
  const row = result.json[0] as { provider_id?: unknown; provider_name?: unknown; office_name?: unknown } | undefined;
  if (!row) return null;
  return { id: String(row.provider_id), name: String(row.office_name ?? row.provider_name ?? "Unnamed office") };
}

/**
 * HQ Insights: one dataset over a range (current + same-length previous
 * period), the local-time weekday × hour heatmap, tiles and what-changed —
 * all assembled by the shared rule engine. Optional `office` narrows every
 * figure to one enabled practice (404 when unknown or disabled).
 */
router.get("/hq/app-usage-insights", requireHqPermission("analytics_read"), async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const range = parseRange(query);
  if (!range) {
    res.status(400).json({ error: RANGE_ERROR });
    return;
  }
  if (!isInsightsDataset(query.dataset)) {
    res.status(400).json({ error: INSIGHTS_DATASET_ERROR });
    return;
  }
  const dataset = query.dataset;
  const officeParam = typeof query.office === "string" && query.office.trim() !== "" ? query.office.trim() : null;
  if (officeParam !== null && !PROVIDER_ID_RE.test(officeParam)) {
    res.status(404).json({ error: "Office not found." });
    return;
  }
  try {
    const office = officeParam ? await loadInsightOffice(officeParam) : null;
    if (officeParam && !office) {
      res.status(404).json({ error: "Office not found." });
      return;
    }
    const providerId = office?.id ?? null;
    const previous = previousRangeOf(range);
    const [current, prior, bounds] = await Promise.all([
      loadInsightBuckets(dataset, range, providerId),
      loadInsightBuckets(dataset, previous, providerId),
      loadInsightBounds(dataset, providerId),
    ]);
    res.json(assembleInsights({ dataset, range, asOf: new Date().toISOString(), office, bounds, current, previous: prior }));
  } catch (error) {
    req.log?.error({ err: error }, "HQ app usage insights failed");
    res.status(502).json({ error: "Could not load app usage insights right now." });
  }
});

/**
 * Office Insights: the same dataset / range / heatmap / tiles / what-changed
 * as the HQ read, pinned to ONE practice by the office-scope resolver (own
 * office for provider staff; `?office=` for HQ drilling in). Provider staff
 * can never widen the scope — the office id comes from their membership.
 */
router.get("/office/app-usage-insights", async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const range = parseRange(query);
  if (!range) {
    res.status(400).json({ error: RANGE_ERROR });
    return;
  }
  if (!isInsightsDataset(query.dataset)) {
    res.status(400).json({ error: INSIGHTS_DATASET_ERROR });
    return;
  }
  const dataset = query.dataset;
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId: typeof query.office === "string" ? query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      respondOfficeScopeDenied(req, res, resolved);
      return;
    }
    const providerId = resolved.scope.providerId;
    const office = { id: providerId, name: resolved.scope.officeName };
    const previous = previousRangeOf(range);
    const [current, prior, bounds] = await Promise.all([
      loadInsightBuckets(dataset, range, providerId),
      loadInsightBuckets(dataset, previous, providerId),
      loadInsightBounds(dataset, providerId),
    ]);
    res.json(assembleInsights({ dataset, range, asOf: new Date().toISOString(), office, bounds, current, previous: prior }));
  } catch (error) {
    req.log?.error({ err: error }, "office app usage insights failed");
    res.status(502).json({ error: "Could not load app usage insights right now." });
  }
});

export default router;
