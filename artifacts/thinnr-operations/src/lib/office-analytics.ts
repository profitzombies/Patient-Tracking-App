/**
 * Shared vocabulary for the live office-dimensioned analytics.
 *
 * The HQ comparison table, the per-account metric strip, and the office
 * Analytics page all read the same OfficeRangeMetrics shape from the API.
 * This module holds the column definitions (label, formatter, sort value)
 * and the drill-through targets so every number links to the same list the
 * same way, and so the operations regression scripts can assert against the
 * exact rules the screens use.
 */
import type { OfficeComparisonRow, OfficeRangeMetrics, OfficeSeriesPoint } from '@workspace/api-client-react';

export type OfficeMetricKey =
  | 'totalPatients'
  | 'activePatients'
  | 'enrollments'
  | 'engaged'
  | 'needsAttention'
  | 'loggingLapsed'
  | 'checkInsOverdue'
  | 'avgPoundsLost';

export interface OfficeMetricColumn {
  key: OfficeMetricKey;
  label: string;
  /** Narrow header label. */
  short: string;
  /** Plain-language help for headers and screen readers. */
  help: string;
  /** Which office list a click on this figure opens (relative to the office root). */
  drill: OfficeDrill;
  /** Lower values are better (needs attention, lapsed, overdue). */
  lowerIsBetter?: boolean;
}

/**
 * Drill targets, expressed relative to an office root so the same map serves
 * the HQ drill-in (/admin/accounts/:id/office) and the office's own app (/).
 */
export type OfficeDrill =
  | { page: 'patients'; query?: Record<string, string> }
  | { page: 'overview' };

export const OFFICE_METRIC_COLUMNS: readonly OfficeMetricColumn[] = [
  { key: 'totalPatients', label: 'Patients', short: 'Patients', help: 'Patients on the roster as of the range end', drill: { page: 'patients' } },
  { key: 'activePatients', label: 'Active', short: 'Active', help: 'Patients active as of the range end', drill: { page: 'patients', query: { status: 'active' } } },
  { key: 'enrollments', label: 'Enrollments', short: 'Enrolled', help: 'Patients who joined during the range', drill: { page: 'overview' } },
  { key: 'engaged', label: 'Engaged', short: 'Engaged', help: 'Active patients with any activity (meal log, weight, check-in, water, photo, or sign-in) in the 7 days ending on the range end', drill: { page: 'overview' } },
  { key: 'needsAttention', label: 'Needs attention', short: 'Attention', help: 'Active patients flagged inactive, lapsed, or overdue as of the range end', drill: { page: 'overview' }, lowerIsBetter: true },
  { key: 'loggingLapsed', label: 'Lapsed', short: 'Lapsed', help: 'Active patients with no meal log in 3+ days as of the range end', drill: { page: 'patients', query: { reason: 'logging_lapsed' } }, lowerIsBetter: true },
  { key: 'checkInsOverdue', label: 'Overdue', short: 'Overdue', help: 'Active patients whose check-in is overdue as of the range end', drill: { page: 'patients', query: { reason: 'check_in_overdue' } }, lowerIsBetter: true },
  { key: 'avgPoundsLost', label: 'Avg lbs lost', short: 'Avg lbs', help: 'Average pounds lost across active patients with a recorded weight, as of the range end', drill: { page: 'patients', query: { status: 'active' } } },
];

export const OFFICE_METRIC_BY_KEY: Readonly<Record<OfficeMetricKey, OfficeMetricColumn>> = Object.fromEntries(
  OFFICE_METRIC_COLUMNS.map((column) => [column.key, column]),
) as Record<OfficeMetricKey, OfficeMetricColumn>;

export function metricValue(metrics: OfficeRangeMetrics | null | undefined, key: OfficeMetricKey): number | null {
  if (!metrics) return null;
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** "—" for unavailable; whole numbers for counts; one decimal for pounds. */
export function formatMetric(key: OfficeMetricKey, value: number | null): string {
  if (value == null) return '—';
  if (key === 'avgPoundsLost') return value.toFixed(1);
  return value.toLocaleString('en-US');
}

/** Build the href for a drill target under an office root ('' for the office app itself). */
export function drillHref(officeRoot: string, drill: OfficeDrill): string {
  const root = officeRoot.replace(/\/+$/, '');
  if (drill.page === 'overview') return root || '/';
  const search = drill.query ? new URLSearchParams(drill.query).toString() : '';
  return `${root}/patients${search ? `?${search}` : ''}`;
}

/** Office root for an HQ drill-in into one provider account. */
export function hqOfficeRoot(accountId: string): string {
  return `/admin/accounts/${accountId}/office`;
}

export type SortDirection = 'asc' | 'desc';
export type ComparisonSortKey = OfficeMetricKey | 'officeName';

export interface ComparisonSort {
  key: ComparisonSortKey;
  direction: SortDirection;
}

export const DEFAULT_RANK_KEY: OfficeMetricKey = 'activePatients';
export const DEFAULT_COMPARISON_SORT: ComparisonSort = { key: DEFAULT_RANK_KEY, direction: 'desc' };

/**
 * Sort rows for the comparison table. Unavailable offices (no data for the
 * range) always sink to the bottom regardless of direction so "—" never
 * outranks a real figure; ties fall back to office name.
 */
export function sortComparisonRows(rows: readonly OfficeComparisonRow[], sort: ComparisonSort): OfficeComparisonRow[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (sort.key === 'officeName') {
      return sign * a.officeName.localeCompare(b.officeName, 'en-US') || a.providerId.localeCompare(b.providerId);
    }
    const av = metricValue(a.metrics, sort.key);
    const bv = metricValue(b.metrics, sort.key);
    if (av == null && bv == null) return a.officeName.localeCompare(b.officeName, 'en-US');
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return sign * (av - bv);
    return a.officeName.localeCompare(b.officeName, 'en-US');
  });
}

/**
 * Rank offices 1..n on a metric (1 = best). "Best" honours lowerIsBetter,
 * ties share a rank (competition ranking), unavailable offices are unranked.
 */
export function rankOffices(rows: readonly OfficeComparisonRow[], key: OfficeMetricKey): Map<string, number | null> {
  const column = OFFICE_METRIC_BY_KEY[key];
  const scored = rows
    .map((row) => ({ id: row.providerId, value: row.available ? metricValue(row.metrics, key) : null }))
    .filter((entry): entry is { id: string; value: number } => entry.value != null)
    .sort((a, b) => (column.lowerIsBetter ? a.value - b.value : b.value - a.value));
  const ranks = new Map<string, number | null>(rows.map((row) => [row.providerId, null]));
  let rank = 0;
  scored.forEach((entry, index) => {
    if (index === 0 || entry.value !== scored[index - 1].value) rank = index + 1;
    ranks.set(entry.id, rank);
  });
  return ranks;
}

export type SeriesKey = keyof Omit<OfficeSeriesPoint, 'date'>;

export function seriesValues(series: readonly OfficeSeriesPoint[], key: SeriesKey): number[] {
  return series.map((point) => point[key]);
}

/** Sum of a daily series (enrollments / check-ins are per-day counts). */
export function seriesTotal(series: readonly OfficeSeriesPoint[], key: SeriesKey): number {
  return series.reduce((sum, point) => sum + point[key], 0);
}

/** Percent helper that keeps "no denominator" honest instead of showing 0%. */
export function percentOf(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}

export function formatPercent(value: number | null): string {
  return value == null ? '—' : `${value}%`;
}

/** Copy for the "unavailable" state: the range ends before the office had any data. */
export function unavailableReason(firstPatientDate: string | null, rangeEnd: string): string {
  if (!firstPatientDate) return 'No patient data has been recorded for this office yet.';
  if (rangeEnd < firstPatientDate) {
    return `This range ends before the first recorded patient (${firstPatientDate}). Figures are unavailable, not zero.`;
  }
  return 'Figures are unavailable for this range.';
}

/** Network totals across the offices that have data for the range. */
export function sumComparison(rows: readonly OfficeComparisonRow[]) {
  const available = rows.filter((row) => row.available && row.metrics);
  const total = (pick: (row: OfficeComparisonRow) => number) => available.reduce((sum, row) => sum + pick(row), 0);
  return {
    availableOffices: available.length,
    unavailableOffices: rows.length - available.length,
    totalPatients: total((row) => row.metrics!.totalPatients),
    activePatients: total((row) => row.metrics!.activePatients),
    enrollments: total((row) => row.metrics!.enrollments),
    engaged: total((row) => row.metrics!.engaged),
    needsAttention: total((row) => row.metrics!.needsAttention),
    loggingLapsed: total((row) => row.metrics!.loggingLapsed),
    checkInsOverdue: total((row) => row.metrics!.checkInsOverdue),
  };
}
