/**
 * Shared vocabulary for the HQ "App usage" reporting (active app users).
 *
 * An active app user is a real-account patient who, on a given day, either
 * opened the app (presence heartbeat) or performed any server-recorded
 * action. Weekly = trailing 7 days, monthly = trailing 30 days, both ending
 * on the selected range end (or today for the live "now" tiles). The page,
 * the overview tiles, and the regression script all read these rules so the
 * same number is formatted, sorted, and ranked the same way everywhere.
 */
import type { AppUsageOfficeMetrics, AppUsageOfficeRow, AppUsagePoint } from '@workspace/api-client-react';

/** How often the live page re-reads the figures while it stays open. */
export const APP_USAGE_REFRESH_MS = 30_000;

export type AppUsageMetricKey = 'weeklyActive' | 'monthlyActive' | 'weeklySharePct' | 'monthlySharePct';
export type AppUsageSortKey = AppUsageMetricKey | 'officeName';
export type AppUsageSeriesKey = keyof Omit<AppUsagePoint, 'date'>;

export interface AppUsageColumn {
  key: AppUsageMetricKey;
  label: string;
  /** Narrow header label. */
  short: string;
  /** Plain-language help for headers and screen readers. */
  help: string;
  format: 'count' | 'percent';
}

export const APP_USAGE_COLUMNS: readonly AppUsageColumn[] = [
  { key: 'weeklyActive', label: 'Weekly active', short: 'Weekly', help: 'Distinct patients who opened the app or logged anything in the 7 days ending on the range end', format: 'count' },
  { key: 'monthlyActive', label: 'Monthly active', short: 'Monthly', help: 'Distinct patients who opened the app or logged anything in the 30 days ending on the range end', format: 'count' },
  { key: 'weeklySharePct', label: 'Weekly share', short: 'Weekly %', help: "Weekly active users as a share of the office's activated patients", format: 'percent' },
  { key: 'monthlySharePct', label: 'Monthly share', short: 'Monthly %', help: "Monthly active users as a share of the office's activated patients", format: 'percent' },
];

export interface AppUsageSort {
  key: AppUsageSortKey;
  direction: 'asc' | 'desc';
}

export const DEFAULT_APP_USAGE_RANK_KEY: AppUsageMetricKey = 'weeklyActive';
export const DEFAULT_APP_USAGE_SORT: AppUsageSort = { key: DEFAULT_APP_USAGE_RANK_KEY, direction: 'desc' };

export function usageMetricValue(metrics: AppUsageOfficeMetrics | null | undefined, key: AppUsageMetricKey): number | null {
  if (!metrics) return null;
  return metrics[key];
}

const fmtCount = (value: number) => value.toLocaleString('en-US');

/** Unavailable is "—" (never 0); shares carry a percent sign; counts are grouped. */
export function formatUsageMetric(key: AppUsageMetricKey, value: number | null): string {
  if (value == null) return '—';
  const column = APP_USAGE_COLUMNS.find((entry) => entry.key === key);
  return column?.format === 'percent' ? `${Math.round(value)}%` : fmtCount(value);
}

/** Percent helper that keeps "no denominator" honest instead of showing 0%. */
export function sharePercent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}

/** Tile detail line: "31% of 632 activated patients" (or an honest fallback when there is no denominator). */
export function shareDetail(pct: number | null, activated: number): string {
  if (pct == null) return activated > 0 ? 'Share unavailable' : 'No activated patients yet';
  return `${pct}% of ${fmtCount(activated)} activated patients`;
}

/**
 * Sorting: unavailable offices always sink to the bottom regardless of
 * direction, null shares sink within a direction, ties break on office name.
 */
export function sortAppUsageRows(rows: readonly AppUsageOfficeRow[], sort: AppUsageSort): AppUsageOfficeRow[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (sort.key === 'officeName') {
      return dir * a.officeName.localeCompare(b.officeName) || a.officeName.localeCompare(b.officeName);
    }
    const av = usageMetricValue(a.metrics, sort.key);
    const bv = usageMetricValue(b.metrics, sort.key);
    if (av == null && bv == null) return a.officeName.localeCompare(b.officeName);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return dir * (av - bv);
    return a.officeName.localeCompare(b.officeName);
  });
}

/** Rank 1 = highest value; ties share a rank; unavailable offices and null shares are unranked. */
export function rankAppUsageRows(rows: readonly AppUsageOfficeRow[], key: AppUsageMetricKey): Map<string, number | null> {
  const ranked = rows
    .map((row) => ({ id: row.providerId, value: row.available ? usageMetricValue(row.metrics, key) : null }))
    .filter((entry): entry is { id: string; value: number } => entry.value != null)
    .sort((a, b) => b.value - a.value);
  const ranks = new Map<string, number | null>(rows.map((row) => [row.providerId, null]));
  let rank = 0;
  let previous: number | null = null;
  ranked.forEach((entry, index) => {
    if (previous === null || entry.value !== previous) rank = index + 1;
    previous = entry.value;
    ranks.set(entry.id, rank);
  });
  return ranks;
}

export function usageSeriesValues(series: readonly AppUsagePoint[], key: AppUsageSeriesKey): number[] {
  return series.map((point) => point[key]);
}

/** Chart inputs: one x key per day and the two rolling series. */
export function usageChartSeries(series: readonly AppUsagePoint[]) {
  return {
    dates: series.map((point) => point.date),
    weekly: usageSeriesValues(series, 'weeklyActive'),
    monthly: usageSeriesValues(series, 'monthlyActive'),
  };
}

/** Copy for the "unavailable" state: the range ends before the office had any patient. */
export function usageUnavailableReason(firstPatientDate: string | null, rangeEnd: string): string {
  if (!firstPatientDate) return 'No activated patient has been recorded for this office yet.';
  if (rangeEnd < firstPatientDate) {
    return `This range ends before the first activated patient (${firstPatientDate}). Figures are unavailable, not zero.`;
  }
  return 'Figures are unavailable for this range.';
}

export function countUnavailable(rows: readonly AppUsageOfficeRow[]): number {
  return rows.filter((row) => !row.available).length;
}

/** "Updated 12:04:31 PM" in the device's local clock; null before the first read lands. */
export function formatUpdatedAt(updatedAtMs: number | null | undefined, now: Date = new Date()): string | null {
  if (!updatedAtMs) return null;
  const at = new Date(updatedAtMs);
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return sameDay ? `Updated ${time}` : `Updated ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}
