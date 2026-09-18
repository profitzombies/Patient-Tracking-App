/**
 * HQ App usage Insights — the one rule engine shared by the API (live
 * rollups) and the operations web app (seeded demo). Given per-day,
 * per-local-hour buckets for the current and previous period it produces the
 * series, the weekday × hour heatmap, the four summary tiles, and the
 * rule-based "What changed" list, so demo and live figures can never drift.
 *
 * Bucket hours are the PATIENT'S local hour; hour -1 means the source only
 * knew the day (daily-only backfill). Those rows count toward totals, series,
 * best-day and weekend share — never the heatmap, busiest hour, or peak
 * window.
 */

export const INSIGHTS_DATASETS = [
  { key: "app_open", label: "App opens", singular: "app open", plural: "app opens" },
  { key: "food_log", label: "Food logs", singular: "food log", plural: "food logs" },
  { key: "water_log", label: "Water", singular: "water log", plural: "water logs" },
  { key: "weigh_in", label: "Weigh-ins", singular: "weigh-in", plural: "weigh-ins" },
  { key: "progress_photo", label: "Progress photos", singular: "progress photo", plural: "progress photos" },
  { key: "coach_message", label: "Coach messages", singular: "coach message", plural: "coach messages" },
  { key: "care_team_message", label: "Care-team messages", singular: "care-team message", plural: "care-team messages" },
  { key: "medication_log", label: "Medication logs", singular: "medication log", plural: "medication logs" },
  { key: "order", label: "Orders", singular: "order", plural: "orders" },
] as const;

export type InsightsDataset = (typeof INSIGHTS_DATASETS)[number]["key"];
export const INSIGHTS_DATASET_KEYS: readonly InsightsDataset[] = INSIGHTS_DATASETS.map((d) => d.key);

export function isInsightsDataset(value: unknown): value is InsightsDataset {
  return typeof value === "string" && (INSIGHTS_DATASET_KEYS as readonly string[]).includes(value);
}

export function datasetMeta(key: InsightsDataset) {
  return INSIGHTS_DATASETS.find((d) => d.key === key) ?? INSIGHTS_DATASETS[0];
}

/** Hour-of-day tracking needs this many days before the heatmap is called complete. */
export const HOURLY_COMPLETE_DAYS = 7;

export interface DayHourBucket {
  /** Patient-local calendar day, YYYY-MM-DD. */
  day: string;
  /** Patient-local hour 0-23, or -1 when only the day is known. */
  hour: number;
  events: number;
  patients: number;
}

export interface InsightsRange {
  start: string;
  end: string;
}

export interface InsightsBounds {
  /** Earliest local day with any event for this dataset (any source). */
  firstDay: string | null;
  /** Earliest local day with a real hour — where the heatmap starts. */
  firstHourlyDay: string | null;
}

export interface InsightsInput {
  dataset: InsightsDataset;
  range: InsightsRange;
  /** ISO instant the figures were assembled. */
  asOf: string;
  office: { id: string; name: string } | null;
  bounds: InsightsBounds;
  current: DayHourBucket[];
  previous: DayHourBucket[];
}

export interface SeriesPoint {
  date: string;
  count: number;
}

export interface HeatmapCell {
  weekday: number;
  hour: number;
  count: number;
}

export interface InsightsWindow {
  weekday: number;
  startHour: number;
  /** Inclusive last hour of the window. */
  endHour: number;
  count: number;
}

export interface InsightsChange {
  kind: "trend" | "day" | "window" | "tracking" | "quiet";
  text: string;
}

export interface AppUsageInsightsResult {
  dataset: InsightsDataset;
  label: string;
  range: InsightsRange;
  previousRange: InsightsRange;
  asOf: string;
  office: { id: string; name: string } | null;
  hourly: {
    /** First day with hour-of-day data, null when none yet. */
    since: string | null;
    /** Days of hourly data available by the range end. */
    days: number;
    /** True once at least HOURLY_COMPLETE_DAYS of hourly data exist. */
    complete: boolean;
  };
  totals: {
    current: number;
    previous: number;
    /** Rounded percent change; null when the previous period had none. */
    changePct: number | null;
    /** Distinct-patient figure summed per bucket — an upper bound, shown as "patient-buckets". */
    patientDays: number;
  };
  current: SeriesPoint[];
  previous: SeriesPoint[];
  /** 7 × 24 cells, weekday-major (Sunday = 0), hourly events only. */
  heatmap: HeatmapCell[];
  peak: HeatmapCell | null;
  tiles: {
    peakWindow: InsightsWindow | null;
    bestDay: { weekday: number; count: number; sharePct: number } | null;
    busiestHour: { hour: number; count: number; sharePct: number } | null;
    weekendSharePct: number | null;
  };
  changes: InsightsChange[];
}

/* ------------------------------------------------------------- calendar */

const DAY_MS = 86_400_000;

export function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function shiftDay(day: string, days: number): string {
  return new Date(dayMs(day) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetweenInclusive(start: string, end: string): number {
  return Math.round((dayMs(end) - dayMs(start)) / DAY_MS) + 1;
}

/** 0 = Sunday … 6 = Saturday for a YYYY-MM-DD day key. */
export function weekdayOf(day: string): number {
  return new Date(dayMs(day)).getUTCDay();
}

/** The same-length period immediately before `range`. */
export function previousRangeOf(range: InsightsRange): InsightsRange {
  const length = daysBetweenInclusive(range.start, range.end);
  const end = shiftDay(range.start, -1);
  return { start: shiftDay(end, -(length - 1)), end };
}

export function eachDay(range: InsightsRange): string[] {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = shiftDay(d, 1)) out.push(d);
  return out;
}

/* ------------------------------------------------------------ formatting */

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;

/** "12am", "1am" … "12pm", "11pm". */
export function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

/** "6–9pm" style window: start hour through the END of the last hour. */
export function formatHourWindow(startHour: number, endHour: number): string {
  const endExclusive = (endHour + 1) % 24;
  const startSuffix = startHour < 12 ? "am" : "pm";
  const endSuffix = endExclusive < 12 ? "am" : "pm";
  const startLabel = startSuffix === endSuffix ? String(startHour % 12 === 0 ? 12 : startHour % 12) : formatHour(startHour);
  return `${startLabel}–${formatHour(endExclusive)}`;
}

export function countNoun(count: number, dataset: InsightsDataset): string {
  const meta = datasetMeta(dataset);
  return `${count.toLocaleString("en-US")} ${count === 1 ? meta.singular : meta.plural}`;
}

/** "Thu · 2pm — 14 food logs" */
export function heatmapTooltip(cell: HeatmapCell, dataset: InsightsDataset): string {
  return `${WEEKDAY_SHORT[cell.weekday]} · ${formatHour(cell.hour)} — ${countNoun(cell.count, dataset)}`;
}

export function formatWindowLabel(window: InsightsWindow): string {
  return `${WEEKDAY_SHORT[window.weekday]} ${formatHourWindow(window.startHour, window.endHour)}`;
}

function formatLongDay(day: string): string {
  return new Date(dayMs(day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/* -------------------------------------------------------------- assembly */

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function seriesFor(range: InsightsRange, buckets: DayHourBucket[]): SeriesPoint[] {
  const byDay = new Map<string, number>();
  for (const b of buckets) byDay.set(b.day, (byDay.get(b.day) ?? 0) + b.events);
  return eachDay(range).map((date) => ({ date, count: byDay.get(date) ?? 0 }));
}

const WINDOW_HOURS = 3;

export function assembleInsights(input: InsightsInput): AppUsageInsightsResult {
  const { dataset, range } = input;
  const meta = datasetMeta(dataset);
  const previousRange = previousRangeOf(range);
  const inRange = (b: DayHourBucket, r: InsightsRange) => b.day >= r.start && b.day <= r.end && b.events > 0;
  const current = input.current.filter((b) => inRange(b, range));
  const previous = input.previous.filter((b) => inRange(b, previousRange));

  const totalCurrent = current.reduce((sum, b) => sum + b.events, 0);
  const totalPrevious = previous.reduce((sum, b) => sum + b.events, 0);
  const patientDays = current.reduce((sum, b) => sum + b.patients, 0);
  const changePct = totalPrevious > 0 ? Math.round(((totalCurrent - totalPrevious) / totalPrevious) * 100) : null;

  // Heatmap and hour-based tiles: hourly rows only.
  const grid: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const byWeekday = Array<number>(7).fill(0);
  const byHour = Array<number>(24).fill(0);
  let hourlyTotal = 0;
  let weekendTotal = 0;
  for (const b of current) {
    const weekday = weekdayOf(b.day);
    byWeekday[weekday] += b.events;
    if (weekday === 0 || weekday === 6) weekendTotal += b.events;
    if (b.hour >= 0 && b.hour <= 23) {
      grid[weekday][b.hour] += b.events;
      byHour[b.hour] += b.events;
      hourlyTotal += b.events;
    }
  }
  const heatmap: HeatmapCell[] = [];
  let peak: HeatmapCell | null = null;
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = { weekday, hour, count: grid[weekday][hour] };
      heatmap.push(cell);
      if (cell.count > 0 && (!peak || cell.count > peak.count)) peak = cell;
    }
  }

  let peakWindow: InsightsWindow | null = null;
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let start = 0; start <= 24 - WINDOW_HOURS; start += 1) {
      let count = 0;
      for (let h = start; h < start + WINDOW_HOURS; h += 1) count += grid[weekday][h];
      if (count > 0 && (!peakWindow || count > peakWindow.count)) {
        peakWindow = { weekday, startHour: start, endHour: start + WINDOW_HOURS - 1, count };
      }
    }
  }

  let bestDay: AppUsageInsightsResult["tiles"]["bestDay"] = null;
  for (let weekday = 0; weekday < 7; weekday += 1) {
    if (byWeekday[weekday] > 0 && (!bestDay || byWeekday[weekday] > bestDay.count)) {
      bestDay = { weekday, count: byWeekday[weekday], sharePct: pct(byWeekday[weekday], totalCurrent) };
    }
  }
  let busiestHour: AppUsageInsightsResult["tiles"]["busiestHour"] = null;
  for (let hour = 0; hour < 24; hour += 1) {
    if (byHour[hour] > 0 && (!busiestHour || byHour[hour] > busiestHour.count)) {
      busiestHour = { hour, count: byHour[hour], sharePct: pct(byHour[hour], hourlyTotal) };
    }
  }
  const weekendSharePct = totalCurrent > 0 ? pct(weekendTotal, totalCurrent) : null;

  // Hour-of-day coverage: days from the first hourly day through the range
  // end (or through the as-of day when the range runs past it).
  const since = input.bounds.firstHourlyDay;
  const asOfDay = input.asOf.slice(0, 10);
  const coverageEnd = range.end < asOfDay ? range.end : asOfDay;
  const hourlyDays = since && since <= coverageEnd ? daysBetweenInclusive(since, coverageEnd) : 0;
  const hourly = { since, days: hourlyDays, complete: hourlyDays >= HOURLY_COMPLETE_DAYS };

  const changes: InsightsChange[] = [];
  const periodDays = daysBetweenInclusive(range.start, range.end);
  const periodLabel = periodDays === 1 ? "the previous day" : `the previous ${periodDays} days`;
  if (totalCurrent === 0) {
    changes.push({ kind: "quiet", text: `No ${meta.plural} were recorded in this range${input.office ? ` for ${input.office.name}` : ""}.` });
  } else if (changePct === null) {
    changes.push({ kind: "trend", text: `${cap(meta.plural)}: ${totalCurrent.toLocaleString("en-US")} this period, none in ${periodLabel} to compare against.` });
  } else if (Math.abs(changePct) < 3) {
    changes.push({ kind: "trend", text: `${cap(meta.plural)} are about level with ${periodLabel} (${totalCurrent.toLocaleString("en-US")} vs ${totalPrevious.toLocaleString("en-US")}).` });
  } else {
    changes.push({
      kind: "trend",
      text: `${cap(meta.plural)} are ${changePct > 0 ? "up" : "down"} ${Math.abs(changePct)}% vs ${periodLabel} (${totalCurrent.toLocaleString("en-US")} vs ${totalPrevious.toLocaleString("en-US")}).`,
    });
  }
  if (bestDay) {
    changes.push({ kind: "day", text: `${WEEKDAY_PLURAL[bestDay.weekday]} are the strongest day with ${bestDay.sharePct}% of ${meta.plural}.` });
  }
  if (peakWindow) {
    changes.push({ kind: "window", text: `Busiest window: ${formatWindowLabel(peakWindow)} in patients' local time (${countNoun(peakWindow.count, dataset)}).` });
  }
  if (!hourly.complete) {
    changes.push({
      kind: "tracking",
      text: since
        ? `Time-of-day tracking for ${meta.plural} started ${formatLongDay(since)}; the heatmap fills in after ${HOURLY_COMPLETE_DAYS} days.`
        : `Time-of-day tracking for ${meta.plural} has not recorded an hour yet; the heatmap fills in after ${HOURLY_COMPLETE_DAYS} days.`,
    });
  }

  return {
    dataset,
    label: meta.label,
    range,
    previousRange,
    asOf: input.asOf,
    office: input.office,
    hourly,
    totals: { current: totalCurrent, previous: totalPrevious, changePct, patientDays },
    current: seriesFor(range, current),
    previous: seriesFor(previousRange, previous),
    heatmap,
    peak,
    tiles: { peakWindow, bestDay, busiestHour, weekendSharePct },
    changes,
  };
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ----------------------------------------------------------- demo seed */

/**
 * Deterministic seeded buckets for the guided demo: a smooth weekly rhythm
 * shaped per dataset, so the demo shows the same shapes as live data (morning
 * weigh-ins, meal-time food logs, evening coach chats) without a clock.
 */
export function seedDemoBuckets(dataset: InsightsDataset, range: InsightsRange, patients = 180, salt = ""): DayHourBucket[] {
  const profile = DEMO_PROFILES[dataset];
  const out: DayHourBucket[] = [];
  let seed = hashString(`${dataset}:${salt}:${range.start}`);
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (const day of eachDay(range)) {
    const weekday = weekdayOf(day);
    const dayFactor = profile.weekday[weekday] * (1 + 0.12 * Math.sin(dayMs(day) / DAY_MS / 5.3));
    for (let hour = 0; hour < 24; hour += 1) {
      const expected = patients * profile.perPatientPerDay * dayFactor * profile.hour[hour];
      const events = Math.max(0, Math.round(expected * (0.75 + next() * 0.5)));
      if (events === 0) continue;
      out.push({ day, hour, events, patients: Math.max(1, Math.min(events, Math.round(events * 0.8))) });
    }
  }
  return out;
}

function hashString(text: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

function normalize(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  return values.map((v) => v / sum);
}

const MEALS = normalize([0.1, 0.05, 0.02, 0.02, 0.05, 0.3, 1.2, 2.4, 2.0, 1.0, 0.8, 1.6, 3.0, 2.4, 1.0, 0.8, 1.2, 2.2, 3.4, 3.0, 1.8, 1.2, 0.7, 0.3]);
const MORNING = normalize([0.1, 0.05, 0.02, 0.02, 0.2, 1.4, 3.6, 4.2, 3.0, 1.6, 0.8, 0.5, 0.4, 0.3, 0.3, 0.3, 0.4, 0.5, 0.6, 0.6, 0.5, 0.4, 0.2, 0.1]);
const EVENING = normalize([0.3, 0.1, 0.05, 0.02, 0.05, 0.2, 0.6, 1.0, 1.0, 0.9, 0.9, 1.1, 1.3, 1.1, 0.9, 0.9, 1.1, 1.6, 2.4, 3.2, 3.6, 3.0, 1.8, 0.8]);
const DAYTIME = normalize([0.1, 0.05, 0.02, 0.02, 0.05, 0.3, 0.9, 1.6, 2.2, 2.6, 2.6, 2.4, 2.2, 2.4, 2.4, 2.2, 1.9, 1.6, 1.4, 1.1, 0.8, 0.5, 0.3, 0.2]);
const WEEKDAYS_HEAVY = [0.7, 1.15, 1.2, 1.1, 1.05, 0.95, 0.75];
const FLAT = [0.95, 1.05, 1.05, 1.0, 1.0, 0.95, 0.95];
const WEEKEND_LIGHT = [0.55, 1.2, 1.15, 1.1, 1.1, 1.0, 0.6];

const DEMO_PROFILES: Record<InsightsDataset, { hour: number[]; weekday: number[]; perPatientPerDay: number }> = {
  app_open: { hour: MEALS, weekday: FLAT, perPatientPerDay: 2.6 },
  food_log: { hour: MEALS, weekday: WEEKDAYS_HEAVY, perPatientPerDay: 2.1 },
  water_log: { hour: DAYTIME, weekday: FLAT, perPatientPerDay: 1.4 },
  weigh_in: { hour: MORNING, weekday: FLAT, perPatientPerDay: 0.55 },
  progress_photo: { hour: MORNING, weekday: [1.3, 1.0, 0.8, 0.8, 0.8, 0.9, 1.2], perPatientPerDay: 0.06 },
  coach_message: { hour: EVENING, weekday: WEEKDAYS_HEAVY, perPatientPerDay: 0.45 },
  care_team_message: { hour: DAYTIME, weekday: WEEKEND_LIGHT, perPatientPerDay: 0.08 },
  medication_log: { hour: MORNING, weekday: FLAT, perPatientPerDay: 0.7 },
  order: { hour: DAYTIME, weekday: WEEKEND_LIGHT, perPatientPerDay: 0.025 },
};

export * from "./retention-periods";
