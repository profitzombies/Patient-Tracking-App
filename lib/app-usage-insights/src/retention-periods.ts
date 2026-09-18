/**
 * HQ Patient retention — the period rule shared by the API (live series) and
 * the operations web app (seeded demo), so the trend chart buckets a range
 * identically in both.
 *
 * Every point is measured "as of" its period end: onboarded-so-far, active in
 * the trailing 30 days, buying in the trailing 90 days, and the inactive
 * remainder. Ranges up to RETENTION_WEEKLY_MAX_DAYS are shown week by week
 * (7-day blocks walked back from the range end, the first clamped to the range
 * start); longer ranges month by month (calendar months clamped to the range).
 * The last period always ends on the range end, so the headline tiles equal
 * the final point of the series.
 */

export type RetentionPeriod = "week" | "month";

export interface RetentionPeriodWindow {
  /** Inclusive first day (YYYY-MM-DD). */
  start: string;
  /** Inclusive last day — the "as of" date for the point. */
  end: string;
}

/** Ranges at most this long are bucketed weekly; longer ones monthly. */
export const RETENTION_WEEKLY_MAX_DAYS = 120;

const DAY_MS = 86_400_000;

function dayNumber(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function keyOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive day count of a range (1 when start = end). */
export function retentionRangeDays(range: RetentionPeriodWindow): number {
  return dayNumber(range.end) - dayNumber(range.start) + 1;
}

export function retentionPeriodFor(range: RetentionPeriodWindow): RetentionPeriod {
  return retentionRangeDays(range) <= RETENTION_WEEKLY_MAX_DAYS ? "week" : "month";
}

/** The chronological period windows covering a range (see the file comment). */
export function retentionPeriodWindows(range: RetentionPeriodWindow, period: RetentionPeriod = retentionPeriodFor(range)): RetentionPeriodWindow[] {
  const start = dayNumber(range.start);
  const end = dayNumber(range.end);
  if (end < start) return [];
  const windows: RetentionPeriodWindow[] = [];
  if (period === "week") {
    for (let periodEnd = end; periodEnd >= start; periodEnd -= 7) {
      windows.unshift({ start: keyOfDay(Math.max(start, periodEnd - 6)), end: keyOfDay(periodEnd) });
    }
    return windows;
  }
  let cursor = start;
  while (cursor <= end) {
    const date = new Date(cursor * DAY_MS);
    const monthEnd = Math.round(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0) / DAY_MS);
    const periodEnd = Math.min(end, monthEnd);
    windows.push({ start: keyOfDay(cursor), end: keyOfDay(periodEnd) });
    cursor = periodEnd + 1;
  }
  return windows;
}

/** Short axis label for a period end: "Aug 22" for weeks, "Aug" (or "Aug 22" when clamped mid-month) for months. */
export function retentionPeriodLabel(window: RetentionPeriodWindow, period: RetentionPeriod): string {
  const [year, month, day] = window.end.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const monthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (period === "month" && day === monthEnd) return date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
