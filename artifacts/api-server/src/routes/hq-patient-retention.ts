/**
 * HQ Patient retention — how many patients each practice onboarded, and how
 * many are still active, still buying, or have gone quiet.
 *
 * Definitions live once, in the `patient_retention_*` SQL functions (see the
 * migration): onboarded = claimed + activated account; active = an App usage
 * activity day in the trailing 30 days; inactive = onboarded and not active,
 * tiered by days quiet (30–60 / 60–90 / 90+); buying = an order paid in the
 * trailing 90 days or a subscription active on the date. Every patient is in
 * exactly one of active / inactive, and patients belong to exactly one office,
 * so network figures are plain sums of the per-office rows.
 *
 * Headline counts are as of the range end; the series measures each period
 * end (weekly up to 120 days, monthly beyond — the rule is shared with the web
 * demo via @workspace/app-usage-insights). One RPC call returns every office ×
 * every period end, so the request cost is bounded by the range, not the
 * number of practices. Same gate and office scoping as the App usage routes:
 * HQ analytics readers only; optional `office` narrows to one enabled practice
 * (404 when unknown or disabled).
 */
import { Router, type IRouter } from "express";
import { requireHqPermission } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { retentionPeriodFor, retentionPeriodWindows, type RetentionPeriod, type RetentionPeriodWindow } from "@workspace/app-usage-insights";
import { parseRange, type DateRangeKeys } from "./operational-rollups";

const router: IRouter = Router();

const RANGE_ERROR = "Use valid start and end date keys spanning at most 366 days.";
const OFFICE_ERROR = "Office not found.";
// Provider ids are text (`live-…` for real offices, `acct-p1`-style legacy
// seeds), not UUIDs: accept any bounded, printable id and let the exact lookup
// decide whether the office exists.
const PROVIDER_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

export interface RetentionInactiveTiers {
  days30to60: number;
  days60to90: number;
  days90plus: number;
}

export interface RetentionCounts {
  onboarded: number;
  active: number;
  buying: number;
  inactive: number;
  activePct: number | null;
  buyingPct: number | null;
  inactiveTiers: RetentionInactiveTiers;
}

export interface RetentionPoint {
  periodStart: string;
  periodEnd: string;
  onboarded: number;
  active: number;
  buying: number;
  inactive: number;
}

export interface RetentionOfficeRow {
  providerId: string;
  officeName: string;
  providerName: string;
  firstOnboardedDate: string | null;
  available: boolean;
  counts: RetentionCounts | null;
  series: RetentionPoint[];
}

export interface RetentionNetwork {
  firstOnboardedDate: string | null;
  available: boolean;
  counts: RetentionCounts | null;
  series: RetentionPoint[];
}

export interface RetentionResult {
  range: DateRangeKeys;
  asOf: string;
  period: RetentionPeriod;
  office: { id: string; name: string } | null;
  network: RetentionNetwork;
  offices: RetentionOfficeRow[];
}

/** One raw RPC row: an office at one as-of date. */
export interface RetentionPointRow {
  provider_id: string;
  office_name: string | null;
  provider_name: string | null;
  first_onboarded_on: string | null;
  as_of: string;
  onboarded: number;
  active: number;
  buying: number;
  inactive: number;
  inactive_30_60: number;
  inactive_60_90: number;
  inactive_90_plus: number;
}

function sharePct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function dateKey(value: unknown): string | null {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null;
}

export function retentionPointRowDto(raw: Record<string, unknown>): RetentionPointRow {
  return {
    provider_id: String(raw.provider_id),
    office_name: typeof raw.office_name === "string" ? raw.office_name : null,
    provider_name: typeof raw.provider_name === "string" ? raw.provider_name : null,
    first_onboarded_on: dateKey(raw.first_onboarded_on),
    as_of: dateKey(raw.as_of) ?? "",
    onboarded: num(raw.onboarded),
    active: num(raw.active),
    buying: num(raw.buying),
    inactive: num(raw.inactive),
    inactive_30_60: num(raw.inactive_30_60),
    inactive_60_90: num(raw.inactive_60_90),
    inactive_90_plus: num(raw.inactive_90_plus),
  };
}

export function retentionCounts(row: Pick<RetentionPointRow, "onboarded" | "active" | "buying" | "inactive" | "inactive_30_60" | "inactive_60_90" | "inactive_90_plus">): RetentionCounts {
  return {
    onboarded: row.onboarded,
    active: row.active,
    buying: row.buying,
    inactive: row.inactive,
    activePct: sharePct(row.active, row.onboarded),
    buyingPct: sharePct(row.buying, row.onboarded),
    inactiveTiers: { days30to60: row.inactive_30_60, days60to90: row.inactive_60_90, days90plus: row.inactive_90_plus },
  };
}

const ZERO_ROW = { onboarded: 0, active: 0, buying: 0, inactive: 0, inactive_30_60: 0, inactive_60_90: 0, inactive_90_plus: 0 };

function sumRows(rows: Array<Pick<RetentionPointRow, keyof typeof ZERO_ROW>>) {
  const total = { ...ZERO_ROW };
  for (const row of rows) for (const key of Object.keys(ZERO_ROW) as Array<keyof typeof ZERO_ROW>) total[key] += row[key];
  return total;
}

/**
 * Assemble the response from the raw office × date rows. An office is
 * "available" once it has an onboarded patient by the range end; before that
 * its figures are null (unavailable), never zero. Series points start at the
 * office's first onboarded patient. The network is the sum of available
 * offices, with a point for every period some office has data for.
 */
export function assembleRetention(input: {
  range: DateRangeKeys;
  asOf: string;
  office: { id: string; name: string } | null;
  rows: RetentionPointRow[];
}): RetentionResult {
  const { range, asOf, office, rows } = input;
  const period = retentionPeriodFor(range);
  const windows = retentionPeriodWindows(range, period);
  const byOffice = new Map<string, RetentionPointRow[]>();
  for (const row of rows) {
    const list = byOffice.get(row.provider_id) ?? [];
    list.push(row);
    byOffice.set(row.provider_id, list);
  }
  const pointOf = (window: RetentionPeriodWindow, row: Pick<RetentionPointRow, "onboarded" | "active" | "buying" | "inactive">): RetentionPoint => ({
    periodStart: window.start,
    periodEnd: window.end,
    onboarded: row.onboarded,
    active: row.active,
    buying: row.buying,
    inactive: row.inactive,
  });
  const offices: RetentionOfficeRow[] = [];
  for (const [providerId, list] of byOffice) {
    const first = list[0];
    const firstOnboardedDate = first.first_onboarded_on;
    const available = firstOnboardedDate !== null && firstOnboardedDate <= range.end;
    const atDate = new Map(list.map((row) => [row.as_of, row]));
    const end = atDate.get(range.end);
    const series = available
      ? windows.flatMap((window) => {
          const row = atDate.get(window.end);
          return row && window.end >= (firstOnboardedDate ?? "") ? [pointOf(window, row)] : [];
        })
      : [];
    offices.push({
      providerId,
      officeName: first.office_name ?? first.provider_name ?? "Office",
      providerName: first.provider_name ?? first.office_name ?? "",
      firstOnboardedDate,
      available,
      counts: available && end ? retentionCounts(end) : null,
      series,
    });
  }
  offices.sort((a, b) => a.officeName.localeCompare(b.officeName) || a.providerId.localeCompare(b.providerId));

  const availableOffices = offices.filter((row) => row.available);
  const firstOnboardedDate = offices.map((row) => row.firstOnboardedDate).filter((d): d is string => d !== null).sort()[0] ?? null;
  const networkSeries: RetentionPoint[] = windows.flatMap((window) => {
    const points = availableOffices.flatMap((row) => row.series.filter((point) => point.periodEnd === window.end));
    return points.length > 0 ? [pointOf(window, sumRows(points.map((p) => ({ ...ZERO_ROW, ...p }))))] : [];
  });
  const endRows = availableOffices.flatMap((row) => {
    const list = byOffice.get(row.providerId) ?? [];
    return list.filter((r) => r.as_of === range.end);
  });
  return {
    range,
    asOf,
    period,
    office,
    network: {
      firstOnboardedDate,
      available: availableOffices.length > 0,
      counts: availableOffices.length > 0 ? retentionCounts(sumRows(endRows)) : null,
      series: networkSeries,
    },
    offices,
  };
}

async function loadRetentionRows(range: DateRangeKeys, providerId: string | null): Promise<RetentionPointRow[]> {
  const dates = Array.from(new Set([...retentionPeriodWindows(range).map((window) => window.end), range.end]));
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_retention_points", {
    p_dates: dates,
    p_provider_id: providerId,
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`patient retention points failed (${result.status})`);
  }
  return (result.json as Record<string, unknown>[]).map(retentionPointRowDto);
}

/** Enabled office by id, or null when unknown / disabled (mirrors the app-usage office rows). */
async function loadOffice(providerId: string): Promise<{ id: string; name: string } | null> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&access_disabled=is.false&select=provider_id,provider_name,office_name&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`patient retention office failed (${result.status})`);
  }
  const row = result.json[0] as { provider_id?: unknown; provider_name?: unknown; office_name?: unknown } | undefined;
  if (!row) return null;
  return { id: String(row.provider_id), name: String(row.office_name ?? row.provider_name ?? "Unnamed office") };
}

router.get("/hq/patient-retention", requireHqPermission("analytics_read"), async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const range = parseRange(query);
  if (!range) {
    res.status(400).json({ error: RANGE_ERROR });
    return;
  }
  const officeParam = typeof query.office === "string" && query.office.trim() !== "" ? query.office.trim() : null;
  if (officeParam !== null && !PROVIDER_ID_RE.test(officeParam)) {
    res.status(404).json({ error: OFFICE_ERROR });
    return;
  }
  try {
    const office = officeParam ? await loadOffice(officeParam) : null;
    if (officeParam && !office) {
      res.status(404).json({ error: OFFICE_ERROR });
      return;
    }
    const rows = await loadRetentionRows(range, office?.id ?? null);
    res.json(assembleRetention({ range, asOf: new Date().toISOString(), office, rows }));
  } catch (error) {
    req.log?.error({ err: error }, "HQ patient retention failed");
    res.status(502).json({ error: "Could not load patient retention right now." });
  }
});

export default router;
