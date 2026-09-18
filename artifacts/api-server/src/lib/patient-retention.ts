/**
 * HQ patient retention — the pure half of the `/hq/patient-retention` route.
 *
 * Lifecycle buckets, evaluated per patient as of one date (the SQL function
 * `patient_retention_offices` applies them; this module documents them and
 * assembles its rows):
 *
 *   onboarded  real-account patient (auth user attached, activated, not
 *              archived) claimed — or created, for self-made accounts — on
 *              or before the date
 *   active     an app-activity day (presence or any recorded action, the
 *              App usage source) in the trailing 30 days
 *   inactive   onboarded and not active — every onboarded patient is in
 *              exactly one of active / inactive; inactive is tiered by days
 *              since the last activity day (or since onboarding when there
 *              never was one): under 30, 30–59, 60–89, 90+
 *   buying     a paid order in the trailing 90 days or a subscription active
 *              on the date; `subscribed` is the subscription half on its own
 *
 * The trend is sampled at the range start, every step boundary inside the
 * range (week ends for ranges up to 13 weeks, month ends beyond) and the
 * range end. "New in range" = onboarded at the range end minus onboarded the
 * day before the range start, so it is exact rather than a series difference.
 */

export const ACTIVE_WINDOW_DAYS = 30;
export const BUYING_WINDOW_DAYS = 90;
/** Ranges longer than this sample month ends; shorter ranges sample week ends. */
export const WEEKLY_STEP_MAX_DAYS = 91;
/** Hard cap on as-of dates per request (the SQL function refuses more). */
export const MAX_SAMPLE_DATES = 120;

export type RetentionStep = "week" | "month";

export interface RetentionCounts {
  onboarded: number;
  /** Onboarded within the requested range (exact, not a series difference). */
  newInRange: number;
  active: number;
  inactive: number;
  buying: number;
  subscribed: number;
  inactiveUnder30: number;
  inactive30to60: number;
  inactive60to90: number;
  inactive90plus: number;
  activePct: number | null;
  buyingPct: number | null;
  inactivePct: number | null;
}

export interface RetentionPoint {
  date: string;
  onboarded: number;
  active: number;
  buying: number;
  inactive: number;
}

export interface RetentionOfficeRow {
  providerId: string;
  officeName: string;
  providerName: string;
  firstPatientDate: string | null;
  /** False when the office had no patient record by the range end — figures are unavailable, not zero. */
  available: boolean;
  metrics: RetentionCounts | null;
  series: RetentionPoint[];
}

export interface RetentionResult {
  range: { start: string; end: string };
  asOf: string;
  step: RetentionStep;
  network: {
    firstPatientDate: string | null;
    available: boolean;
    metrics: RetentionCounts | null;
    series: RetentionPoint[];
  };
  offices: RetentionOfficeRow[];
}

/** One raw row from `patient_retention_offices` (numbers may arrive as strings). */
export interface RetentionRawRow {
  provider_id: string;
  office_name: string | null;
  provider_name: string | null;
  first_patient_date: string | null;
  as_of: string;
  onboarded: number | string;
  active: number | string;
  buying: number | string;
  subscribed: number | string;
  inactive_under_30: number | string;
  inactive_30_60: number | string;
  inactive_60_90: number | string;
  inactive_90_plus: number | string;
}

const DAY_MS = 86_400_000;

function keyToMs(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

function msToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(key: string, days: number): string {
  return msToKey(keyToMs(key) + days * DAY_MS);
}

function rangeDays(start: string, end: string): number {
  return Math.round((keyToMs(end) - keyToMs(start)) / DAY_MS) + 1;
}

/** Last day of the month containing `key`. */
function monthEnd(key: string): string {
  const d = new Date(keyToMs(key));
  return msToKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

export function stepForRange(start: string, end: string): RetentionStep {
  return rangeDays(start, end) > WEEKLY_STEP_MAX_DAYS ? "month" : "week";
}

/**
 * Sorted, de-duplicated as-of dates for the trend: the range start, each
 * step boundary strictly inside the range, and the range end.
 */
export function sampleDates(start: string, end: string): { step: RetentionStep; dates: string[] } {
  const step = stepForRange(start, end);
  const set = new Set<string>([start, end]);
  // A boundary that lands right after the start would only duplicate the
  // start point, so boundaries keep a minimum gap from it (half a step).
  if (step === "month") {
    const floor = addDays(start, 14);
    for (let cursor = monthEnd(start); cursor < end; cursor = monthEnd(addDays(cursor, 1))) if (cursor >= floor) set.add(cursor);
  } else {
    const floor = addDays(start, 4);
    for (let cursor = addDays(end, -7); cursor >= floor; cursor = addDays(cursor, -7)) set.add(cursor);
  }
  const dates = [...set].sort();
  if (dates.length > MAX_SAMPLE_DATES) throw new Error(`too many sample dates (${dates.length})`);
  return { step, dates };
}

/** The as-of dates handed to the SQL function: the day before the range plus every sample date. */
export function requestDates(start: string, end: string): string[] {
  return [addDays(start, -1), ...sampleDates(start, end).dates];
}

export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/** Thrown when the RPC payload does not match the contract — the route turns it into a 502, never into zeroes. */
export class RetentionShapeError extends Error {}

/** A count column must be a finite non-negative number (PostgREST may serialise bigint as a string). */
function n(value: number | string | null | undefined, column: string): number {
  if (value === null || value === undefined || value === "") throw new RetentionShapeError(`patient retention: missing ${column}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new RetentionShapeError(`patient retention: invalid ${column} (${String(value)})`);
  return parsed;
}

interface Tally {
  onboarded: number;
  active: number;
  buying: number;
  subscribed: number;
  inactiveUnder30: number;
  inactive30to60: number;
  inactive60to90: number;
  inactive90plus: number;
}

/** Zero seed for sums only — never a stand-in for a missing RPC row. */
const EMPTY_TALLY: Tally = { onboarded: 0, active: 0, buying: 0, subscribed: 0, inactiveUnder30: 0, inactive30to60: 0, inactive60to90: 0, inactive90plus: 0 };

function tallyOf(row: RetentionRawRow): Tally {
  return {
    onboarded: n(row.onboarded, "onboarded"),
    active: n(row.active, "active"),
    buying: n(row.buying, "buying"),
    subscribed: n(row.subscribed, "subscribed"),
    inactiveUnder30: n(row.inactive_under_30, "inactive_under_30"),
    inactive30to60: n(row.inactive_30_60, "inactive_30_60"),
    inactive60to90: n(row.inactive_60_90, "inactive_60_90"),
    inactive90plus: n(row.inactive_90_plus, "inactive_90_plus"),
  };
}

function addTally(a: Tally, b: Tally): Tally {
  return {
    onboarded: a.onboarded + b.onboarded,
    active: a.active + b.active,
    buying: a.buying + b.buying,
    subscribed: a.subscribed + b.subscribed,
    inactiveUnder30: a.inactiveUnder30 + b.inactiveUnder30,
    inactive30to60: a.inactive30to60 + b.inactive30to60,
    inactive60to90: a.inactive60to90 + b.inactive60to90,
    inactive90plus: a.inactive90plus + b.inactive90plus,
  };
}

function inactiveOf(t: Tally): number {
  return t.inactiveUnder30 + t.inactive30to60 + t.inactive60to90 + t.inactive90plus;
}

/** Counts + shares for one (office or network) tally, given the day-before-range onboarded figure. */
export function countsFrom(t: Tally, onboardedBefore: number): RetentionCounts {
  const inactive = inactiveOf(t);
  return {
    onboarded: t.onboarded,
    newInRange: Math.max(0, t.onboarded - onboardedBefore),
    active: t.active,
    inactive,
    buying: t.buying,
    subscribed: t.subscribed,
    inactiveUnder30: t.inactiveUnder30,
    inactive30to60: t.inactive30to60,
    inactive60to90: t.inactive60to90,
    inactive90plus: t.inactive90plus,
    activePct: pct(t.active, t.onboarded),
    buyingPct: pct(t.buying, t.onboarded),
    inactivePct: pct(inactive, t.onboarded),
  };
}

function pointFrom(date: string, t: Tally): RetentionPoint {
  return { date, onboarded: t.onboarded, active: t.active, buying: t.buying, inactive: inactiveOf(t) };
}

/**
 * Assemble the route payload from the raw RPC rows. Offices without a patient
 * record by the range end are `available: false` with null metrics; the
 * network sums the available offices (patients belong to exactly one office).
 */
export function assembleRetention(range: { start: string; end: string }, raw: RetentionRawRow[], asOf: Date): RetentionResult {
  const { step, dates } = sampleDates(range.start, range.end);
  const before = addDays(range.start, -1);
  const byOffice = new Map<string, { row: RetentionRawRow; byDate: Map<string, Tally> }>();
  const expectedDates = new Set([before, ...dates]);
  for (const row of raw) {
    if (!row || typeof row.provider_id !== "string" || row.provider_id === "") throw new RetentionShapeError("patient retention: row without provider_id");
    const id = row.provider_id;
    const asOf = String(row.as_of ?? "").slice(0, 10);
    if (!expectedDates.has(asOf)) throw new RetentionShapeError(`patient retention: unexpected as_of ${asOf || "(missing)"}`);
    const entry = byOffice.get(id) ?? { row, byDate: new Map<string, Tally>() };
    entry.byDate.set(asOf, tallyOf(row));
    byOffice.set(id, entry);
  }

  const offices: RetentionOfficeRow[] = [];
  for (const { row, byDate } of byOffice.values()) {
    const firstPatientDate = typeof row.first_patient_date === "string" ? row.first_patient_date.slice(0, 10) : null;
    const available = firstPatientDate !== null && firstPatientDate <= range.end;
    // The RPC returns one row per office per requested date; a hole means the payload is not the one we asked for.
    const at = (date: string) => {
      const tally = byDate.get(date);
      if (!tally) throw new RetentionShapeError(`patient retention: office ${row.provider_id} has no row for ${date}`);
      return tally;
    };
    offices.push({
      providerId: String(row.provider_id),
      officeName: String(row.office_name ?? row.provider_name ?? "Office"),
      providerName: String(row.provider_name ?? row.office_name ?? ""),
      firstPatientDate,
      available,
      metrics: available ? countsFrom(at(range.end), at(before).onboarded) : null,
      series: available ? dates.filter((date) => date >= firstPatientDate!).map((date) => pointFrom(date, at(date))) : [],
    });
  }
  offices.sort((a, b) => a.officeName.localeCompare(b.officeName) || a.providerId.localeCompare(b.providerId));

  const availableOffices = offices.filter((office) => office.available);
  const sumAt = (date: string) =>
    availableOffices.reduce((total, office) => {
      const tally = byOffice.get(office.providerId)!.byDate.get(date);
      if (!tally) throw new RetentionShapeError(`patient retention: office ${office.providerId} has no row for ${date}`);
      return addTally(total, tally);
    }, EMPTY_TALLY);
  const firstDates = offices.map((office) => office.firstPatientDate).filter((date): date is string => date !== null).sort();
  const networkFirst = firstDates[0] ?? null;
  const networkAvailable = availableOffices.length > 0;
  // Like the office series, a network point exists only once some office has data for it.
  const networkSeries = networkAvailable
    ? dates.filter((date) => date >= networkFirst!).map((date) => pointFrom(date, sumAt(date)))
    : [];

  return {
    range: { start: range.start, end: range.end },
    asOf: asOf.toISOString(),
    step,
    network: {
      firstPatientDate: networkFirst,
      available: networkAvailable,
      metrics: networkAvailable ? countsFrom(sumAt(range.end), sumAt(before).onboarded) : null,
      series: networkSeries,
    },
    offices,
  };
}
