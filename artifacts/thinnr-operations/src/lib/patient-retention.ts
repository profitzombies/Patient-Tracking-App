/**
 * Shared vocabulary for the HQ "Patient retention" page.
 *
 * Four lifecycle buckets, defined once here in plain language (the page shows
 * them verbatim) and computed once in the database:
 *
 *  - Onboarded: a patient whose account is claimed and activated.
 *  - Active: an onboarded patient who opened the app or logged anything in
 *    the trailing 30 days — the App usage notion of "active" (real accounts
 *    only, staff excluded).
 *  - Buying: an onboarded patient with an order paid in the trailing 90 days
 *    or a subscription active on the date.
 *  - Inactive: onboarded and not active — every patient is in exactly one of
 *    active / inactive. Inactive patients are tiered by days since their last
 *    activity (30–60, 60–90, 90+).
 *
 * Headline counts are as of the selected range end; the trend measures each
 * period end (weekly up to 120 days, monthly beyond).
 */
import type { PatientRetentionCounts, PatientRetentionOfficeRow, PatientRetentionPoint, PatientRetentionResult } from '@workspace/api-client-react';
import { retentionPeriodLabel, type RetentionPeriod } from '@workspace/app-usage-insights';

export const RETENTION_DEFINITIONS: ReadonlyArray<{ term: string; text: string }> = [
  { term: 'Onboarded', text: 'A patient whose account has been claimed and activated in an enabled practice, counted from the day they claimed it. Archived patients are excluded.' },
  { term: 'Active', text: 'An onboarded patient who opened the app or logged anything (meal, water, check-in, weight, photo, or coach message) in the 30 days ending on the date. Staff use never counts — the same rule as App usage.' },
  { term: 'Buying', text: 'An onboarded patient with an order paid in the 90 days ending on the date, or a subscription that is active on that date. Refunded orders still count as a purchase; pending and failed payments never do.' },
  { term: 'Inactive', text: 'An onboarded patient who is not active — no app activity for 30 days or more. Every onboarded patient is either active or inactive, never both. Quiet time counts from the last activity day; a patient who never opened the app is quiet since the day they were onboarded, so the 30–60 tier also holds recent joiners who have not opened the app yet.' },
];

export type RetentionCountKey = 'onboarded' | 'active' | 'buying' | 'inactive';
export type RetentionMetricKey = RetentionCountKey | 'activePct' | 'buyingPct';
export type RetentionSortKey = RetentionMetricKey | 'officeName';

export interface RetentionColumn {
  key: RetentionMetricKey;
  label: string;
  short: string;
  help: string;
  format: 'count' | 'percent';
}

export const RETENTION_COLUMNS: readonly RetentionColumn[] = [
  { key: 'onboarded', label: 'Onboarded', short: 'Onboarded', help: 'Patients with a claimed, activated account by the range end', format: 'count' },
  { key: 'active', label: 'Active', short: 'Active', help: 'Onboarded patients who opened the app or logged anything in the 30 days ending on the range end', format: 'count' },
  { key: 'buying', label: 'Buying', short: 'Buying', help: 'Onboarded patients with an order paid in the 90 days ending on the range end, or a subscription active on it', format: 'count' },
  { key: 'inactive', label: 'Inactive', short: 'Inactive', help: 'Onboarded patients with no app activity for 30 days or more', format: 'count' },
  { key: 'activePct', label: 'Active share', short: 'Active %', help: 'Active as a share of onboarded', format: 'percent' },
  { key: 'buyingPct', label: 'Buying share', short: 'Buying %', help: 'Buying as a share of onboarded', format: 'percent' },
];

export interface RetentionSort {
  key: RetentionSortKey;
  direction: 'asc' | 'desc';
}

export const DEFAULT_RETENTION_SORT: RetentionSort = { key: 'onboarded', direction: 'desc' };

const fmtCount = (value: number) => value.toLocaleString('en-US');

export function retentionMetricValue(counts: PatientRetentionCounts | null | undefined, key: RetentionMetricKey): number | null {
  if (!counts) return null;
  return counts[key];
}

/** Unavailable is "—" (never 0); shares carry a percent sign and one decimal only when it matters; counts are grouped. */
export function formatRetentionMetric(key: RetentionMetricKey, value: number | null): string {
  if (value == null) return '—';
  const column = RETENTION_COLUMNS.find((entry) => entry.key === key);
  return column?.format === 'percent' ? `${Math.round(value)}%` : fmtCount(value);
}

/** "84% of onboarded" for the tiles; honest when nobody is onboarded. */
export function shareOfOnboarded(pct: number | null): string {
  return pct == null ? 'No onboarded patients yet' : `${Math.round(pct)}% of onboarded`;
}

/** Sort rows; unavailable offices always sink to the bottom, ties break on office name. */
export function sortRetentionRows(rows: readonly PatientRetentionOfficeRow[], sort: RetentionSort): PatientRetentionOfficeRow[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (sort.key === 'officeName') return dir * a.officeName.localeCompare(b.officeName);
    const av = retentionMetricValue(a.counts, sort.key);
    const bv = retentionMetricValue(b.counts, sort.key);
    if (av == null && bv == null) return a.officeName.localeCompare(b.officeName);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return dir * (av - bv);
    return a.officeName.localeCompare(b.officeName);
  });
}

export const RETENTION_SERIES: ReadonlyArray<{ key: RetentionCountKey; label: string }> = [
  { key: 'onboarded', label: 'Onboarded' },
  { key: 'active', label: 'Active' },
  { key: 'buying', label: 'Buying' },
  { key: 'inactive', label: 'Inactive' },
];

/** Chart-ready columns keyed by period end. */
export function retentionChartSeries(series: readonly PatientRetentionPoint[]) {
  return {
    dates: series.map((point) => point.periodEnd),
    onboarded: series.map((point) => point.onboarded),
    active: series.map((point) => point.active),
    buying: series.map((point) => point.buying),
    inactive: series.map((point) => point.inactive),
  };
}

/** Axis / readout label for a period end, e.g. "Aug" for a full month or "Aug 22" for a week or a clamped month. */
export function retentionPointLabel(series: readonly PatientRetentionPoint[], period: RetentionPeriod, key: string): string {
  const point = series.find((entry) => entry.periodEnd === key);
  return point ? retentionPeriodLabel({ start: point.periodStart, end: point.periodEnd }, period) : key;
}

export function periodNoun(period: RetentionPeriod): string {
  return period === 'week' ? 'week' : 'month';
}

/** The inactive breakdown as ordered rows with the share of all inactive patients (null when none). */
export function inactiveTierRows(counts: PatientRetentionCounts | null | undefined) {
  const tiers = counts?.inactiveTiers;
  const inactive = counts?.inactive ?? 0;
  const pct = (value: number) => (inactive > 0 ? Math.round((value / inactive) * 100) : null);
  return [
    { key: 'days30to60', label: '30–60 days quiet', value: tiers?.days30to60 ?? 0, pct: pct(tiers?.days30to60 ?? 0) },
    { key: 'days60to90', label: '60–90 days quiet', value: tiers?.days60to90 ?? 0, pct: pct(tiers?.days60to90 ?? 0) },
    { key: 'days90plus', label: '90+ days quiet', value: tiers?.days90plus ?? 0, pct: pct(tiers?.days90plus ?? 0) },
  ];
}

export function retentionUnavailableReason(firstOnboardedDate: string | null, rangeEnd: string): string {
  if (firstOnboardedDate === null) return 'This office has no onboarded patient yet.';
  return `This office onboarded its first patient on ${firstOnboardedDate}, after the range end (${rangeEnd}).`;
}

export function countRetentionUnavailable(rows: readonly PatientRetentionOfficeRow[]): number {
  return rows.filter((row) => !row.available).length;
}

/** The "all practices" total row: the network counts, which are exact sums of the available offices. */
export function retentionTotalCounts(data: PatientRetentionResult | undefined): PatientRetentionCounts | null {
  return data?.network.counts ?? null;
}
