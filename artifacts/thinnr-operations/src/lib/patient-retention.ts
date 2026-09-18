/**
 * Shared vocabulary for the HQ "Patient retention" page.
 *
 * Every onboarded patient (real account, activated, not archived) is in
 * exactly one of two states as of a date: active (an app-activity day in the
 * trailing 30 days — the App usage definition) or inactive, and the inactive
 * group is tiered by how long they have been quiet. Buying is independent:
 * a paid order in the trailing 90 days or a subscription active on the date.
 * The page, the table, the demo dataset and the regression script read these
 * rules so the same number is defined, formatted, sorted and ranked the same
 * way everywhere.
 */
import type { PatientRetentionCounts, PatientRetentionOfficeRow, PatientRetentionPoint } from '@workspace/api-client-react';

/** How often the live page re-reads the figures while it stays open (same cadence as App usage). */
export const PATIENT_RETENTION_REFRESH_MS = 30_000;

export const ONBOARDED_DEFINITION =
  'A patient counts as onboarded once they have a real THINNR account through a practice (claimed or created, activated, not archived).';
export const ACTIVE_DEFINITION =
  'Active means they opened the app or logged anything (meal, water, check-in, weight, photo, or coach message) in the last 30 days — the same rule as App usage. Everyone else is inactive, grouped by how long they have been quiet.';
export const BUYING_DEFINITION =
  'Buying means a paid order in the last 90 days or a subscription that was active on the date. Fully refunded orders do not count; a partly refunded order still does.';

export type RetentionMetricKey = keyof PatientRetentionCounts;
export type RetentionSortKey = RetentionMetricKey | 'officeName';
export type RetentionSeriesKey = keyof Omit<PatientRetentionPoint, 'date'>;

export interface RetentionColumn {
  key: RetentionMetricKey;
  label: string;
  /** Narrow header label. */
  short: string;
  /** Plain-language help for headers and screen readers. */
  help: string;
  format: 'count' | 'percent';
}

/** Table columns, left to right. */
export const RETENTION_COLUMNS: readonly RetentionColumn[] = [
  { key: 'onboarded', label: 'Onboarded', short: 'Onboarded', help: 'Patients with a real account through this practice as of the range end', format: 'count' },
  { key: 'newInRange', label: 'New in range', short: 'New', help: 'Patients onboarded within the selected range', format: 'count' },
  { key: 'active', label: 'Active', short: 'Active', help: 'Onboarded patients who opened the app or logged anything in the 30 days ending on the range end', format: 'count' },
  { key: 'activePct', label: 'Active share', short: 'Active %', help: "Active patients as a share of the practice's onboarded patients", format: 'percent' },
  { key: 'buying', label: 'Buying', short: 'Buying', help: 'Onboarded patients with a paid order in the last 90 days or a subscription active on the range end', format: 'count' },
  { key: 'buyingPct', label: 'Buying share', short: 'Buying %', help: "Buying patients as a share of the practice's onboarded patients", format: 'percent' },
  { key: 'inactive', label: 'Inactive', short: 'Inactive', help: 'Onboarded patients with no app activity in the last 30 days', format: 'count' },
  { key: 'inactive30to60', label: 'Quiet 30–60 days', short: '30–60d', help: 'Inactive patients whose last activity was 30 to 59 days ago', format: 'count' },
  { key: 'inactive60to90', label: 'Quiet 60–90 days', short: '60–90d', help: 'Inactive patients whose last activity was 60 to 89 days ago', format: 'count' },
  { key: 'inactive90plus', label: 'Quiet 90+ days', short: '90d+', help: 'Inactive patients whose last activity was 90 or more days ago (or who never opened the app after onboarding that long ago)', format: 'count' },
];

/** The inactive tiers, oldest last — the breakdown tiles and the table share this order. */
export const INACTIVE_TIERS: readonly { key: RetentionMetricKey; label: string; help: string }[] = [
  { key: 'inactiveUnder30', label: 'Quiet under 30 days', help: 'Onboarded less than 30 days ago and never opened the app yet' },
  { key: 'inactive30to60', label: 'Quiet 30–60 days', help: 'Last activity 30 to 59 days ago' },
  { key: 'inactive60to90', label: 'Quiet 60–90 days', help: 'Last activity 60 to 89 days ago' },
  { key: 'inactive90plus', label: 'Quiet 90+ days', help: 'Last activity 90 or more days ago' },
];

export interface RetentionSort {
  key: RetentionSortKey;
  direction: 'asc' | 'desc';
}

export const DEFAULT_RETENTION_RANK_KEY: RetentionMetricKey = 'onboarded';
export const DEFAULT_RETENTION_SORT: RetentionSort = { key: DEFAULT_RETENTION_RANK_KEY, direction: 'desc' };

export function retentionMetricValue(metrics: PatientRetentionCounts | null | undefined, key: RetentionMetricKey): number | null {
  if (!metrics) return null;
  return metrics[key];
}

const fmtCount = (value: number) => value.toLocaleString('en-US');

/** Unavailable is "—" (never 0); shares carry a percent sign; counts are grouped. */
export function formatRetentionMetric(key: RetentionMetricKey, value: number | null): string {
  if (value == null) return '—';
  const column = RETENTION_COLUMNS.find((entry) => entry.key === key);
  const percent = column ? column.format === 'percent' : key.endsWith('Pct');
  return percent ? `${Math.round(value)}%` : fmtCount(value);
}

/** Percent helper that keeps "no denominator" honest instead of showing 0%. */
export function retentionShare(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** "62% of 632 onboarded" — tile detail copy. */
export function shareOfOnboarded(pct: number | null, onboarded: number): string {
  if (onboarded <= 0) return 'No onboarded patients yet';
  if (pct == null) return 'Share unavailable';
  return `${Math.round(pct)}% of ${fmtCount(onboarded)} onboarded`;
}

/** Unavailable offices always sink; null values sink within a direction; ties break on office name. */
export function sortRetentionRows(rows: readonly PatientRetentionOfficeRow[], sort: RetentionSort): PatientRetentionOfficeRow[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (sort.key === 'officeName') return a.officeName.localeCompare(b.officeName) * dir;
    const av = retentionMetricValue(a.metrics, sort.key);
    const bv = retentionMetricValue(b.metrics, sort.key);
    if (av == null && bv == null) return a.officeName.localeCompare(b.officeName);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return (av - bv) * dir;
    return a.officeName.localeCompare(b.officeName);
  });
}

/** 1 = highest value of `key`; ties share a rank; unavailable / null rows are unranked. */
export function rankRetentionRows(rows: readonly PatientRetentionOfficeRow[], key: RetentionMetricKey): Map<string, number | null> {
  const ranked = rows
    .map((row) => ({ id: row.providerId, value: row.available ? retentionMetricValue(row.metrics, key) : null }))
    .filter((entry): entry is { id: string; value: number } => entry.value != null)
    .sort((a, b) => b.value - a.value);
  const ranks = new Map<string, number | null>(rows.map((row) => [row.providerId, null]));
  ranked.forEach((entry, index) => {
    const previous = index > 0 ? ranked[index - 1] : null;
    const rank = previous && previous.value === entry.value ? ranks.get(previous.id)! : index + 1;
    ranks.set(entry.id, rank);
  });
  return ranks;
}

export function retentionSeriesValues(series: readonly PatientRetentionPoint[], key: RetentionSeriesKey): number[] {
  return series.map((point) => point[key]);
}

/** Chart inputs: one date axis plus the four lifecycle lines. */
export function retentionChartSeries(series: readonly PatientRetentionPoint[]) {
  return {
    dates: series.map((point) => point.date),
    onboarded: retentionSeriesValues(series, 'onboarded'),
    active: retentionSeriesValues(series, 'active'),
    buying: retentionSeriesValues(series, 'buying'),
    inactive: retentionSeriesValues(series, 'inactive'),
  };
}

/** Copy for the "unavailable" state: the range ends before the office had any patient. */
export function retentionUnavailableReason(firstPatientDate: string | null, rangeEnd: string): string {
  if (!firstPatientDate) return 'No patient has been recorded for this office yet.';
  if (rangeEnd < firstPatientDate) {
    return `This range ends before the first patient (${firstPatientDate}). Figures are unavailable, not zero.`;
  }
  return 'Figures are unavailable for this range.';
}

export function countRetentionUnavailable(rows: readonly PatientRetentionOfficeRow[]): number {
  return rows.filter((row) => !row.available).length;
}

/**
 * The all-practices row for the table foot: sums of the available offices
 * (a patient belongs to exactly one office), shares recomputed from the sums.
 */
export function totalRetentionCounts(rows: readonly PatientRetentionOfficeRow[]): PatientRetentionCounts | null {
  const available = rows.filter((row) => row.available && row.metrics);
  if (available.length === 0) return null;
  const sum = (key: Exclude<RetentionMetricKey, 'activePct' | 'buyingPct' | 'inactivePct'>) =>
    available.reduce((total, row) => total + (row.metrics?.[key] ?? 0), 0);
  const onboarded = sum('onboarded');
  const active = sum('active');
  const buying = sum('buying');
  const inactive = sum('inactive');
  return {
    onboarded,
    newInRange: sum('newInRange'),
    active,
    inactive,
    buying,
    subscribed: sum('subscribed'),
    inactiveUnder30: sum('inactiveUnder30'),
    inactive30to60: sum('inactive30to60'),
    inactive60to90: sum('inactive60to90'),
    inactive90plus: sum('inactive90plus'),
    activePct: retentionShare(active, onboarded),
    buyingPct: retentionShare(buying, onboarded),
    inactivePct: retentionShare(inactive, onboarded),
  };
}

/** Whole days since the epoch for a YYYY-MM-DD key (timezone-proof). */
export function retentionDayNumber(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function retentionKeyOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The trend's sample dates for a range — the same rule the server applies:
 * the range start, week ends (ranges up to 13 weeks) or month ends beyond,
 * and the range end; a boundary within half a step of the start is dropped.
 * The demo dataset uses it so demo and live charts have the same shape.
 */
export function retentionSampleDates(start: string, end: string): { step: 'week' | 'month'; dates: string[] } {
  const startDay = retentionDayNumber(start);
  const endDay = retentionDayNumber(end);
  const step: 'week' | 'month' = endDay - startDay + 1 > 91 ? 'month' : 'week';
  const set = new Set<string>([start, end]);
  if (step === 'month') {
    const floor = startDay + 14;
    let cursor = new Date(startDay * 86_400_000);
    for (;;) {
      const monthEnd = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0) / 86_400_000;
      if (monthEnd >= endDay) break;
      if (monthEnd >= floor) set.add(retentionKeyOfDay(monthEnd));
      cursor = new Date((monthEnd + 1) * 86_400_000);
    }
  } else {
    const floor = startDay + 4;
    for (let cursor = endDay - 7; cursor >= floor; cursor -= 7) set.add(retentionKeyOfDay(cursor));
  }
  return { step, dates: [...set].sort() };
}
