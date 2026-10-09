/**
 * Shared vocabulary for the HQ "Customer health" page.
 *
 * The score, buckets, bands and attention flags are computed on the server
 * (api-server/src/customer-health/scoring.ts) and echoed back with the
 * constants they were computed with (`definitions`). This module only holds
 * the page-side rules: the URL-persisted group filter and sort, column
 * metadata, formatting, and the plain-language definitions note built from
 * the server's constants so the two can never drift.
 */
import type { CustomerHealthBand, CustomerHealthBucket, CustomerHealthDefinitions, CustomerHealthOffice } from '@workspace/api-client-react';

export const CUSTOMER_HEALTH_PATH = '/admin/customer-health';

/** A tile the account manager can click: one of the four buckets, or the attention list. */
export type HealthGroup = CustomerHealthBucket | 'attention';

export const BUCKET_ORDER: readonly CustomerHealthBucket[] = ['active', 'quiet3to6', 'quiet6to12', 'quietOverYear'];

export const BUCKET_LABELS: Record<CustomerHealthBucket, string> = {
  active: 'Active',
  quiet3to6: 'Quiet 3–6 months',
  quiet6to12: 'Quiet 6–12 months',
  quietOverYear: 'Quiet over a year / never',
};

export const BUCKET_SHORT: Record<CustomerHealthBucket, string> = {
  active: 'Active',
  quiet3to6: 'Quiet 3–6 mo',
  quiet6to12: 'Quiet 6–12 mo',
  quietOverYear: 'Quiet 1 yr+ / never',
};

export const BUCKET_DETAIL: Record<CustomerHealthBucket, string> = {
  active: 'Ordered in the last 90 days',
  quiet3to6: 'Last order 91–180 days ago',
  quiet6to12: 'Last order 181–365 days ago',
  quietOverYear: 'More than a year, or no orders on record',
};

export const BAND_LABELS: Record<CustomerHealthBand, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  atRisk: 'At risk',
};

export const GROUP_LABELS: Record<HealthGroup, string> = { ...BUCKET_LABELS, attention: 'Needs attention this week' };

const GROUPS: readonly HealthGroup[] = [...BUCKET_ORDER, 'attention'];

export function isHealthGroup(value: string | null | undefined): value is HealthGroup {
  return typeof value === 'string' && (GROUPS as readonly string[]).includes(value);
}

export type HealthSortKey =
  | 'rank'
  | 'officeName'
  | 'score'
  | 'scoreChange'
  | 'daysSinceLastOrder'
  | 'activeSubscribers'
  | 'appUsers'
  | 'activeAppUsers30d'
  | 'staffEnrolled'
  | 'bucket';

export interface HealthColumn {
  key: HealthSortKey;
  label: string;
  short: string;
  help: string;
  align: 'left' | 'right';
}

export const HEALTH_COLUMNS: readonly HealthColumn[] = [
  { key: 'rank', label: 'Rank', short: '#', help: 'Position by health score; tied scores share a rank', align: 'right' },
  { key: 'officeName', label: 'Office', short: 'Office', help: 'The practice; opens its HQ account page', align: 'left' },
  { key: 'score', label: 'Health score', short: 'Score', help: 'Health score out of 100 with its band', align: 'right' },
  { key: 'scoreChange', label: 'Change since last week', short: 'vs last week', help: 'Health score now minus the score the Monday weekly run recorded last week; — before the first weekly run', align: 'right' },
  { key: 'daysSinceLastOrder', label: 'Last order', short: 'Last order', help: 'Date of the most recent paid shop order and days since', align: 'right' },
  { key: 'activeSubscribers', label: 'App subscribers', short: 'Subscribers', help: 'Distinct patients with an active product subscription', align: 'right' },
  { key: 'appUsers', label: 'App users', short: 'App users', help: 'Patients with a claimed, activated account', align: 'right' },
  { key: 'activeAppUsers30d', label: 'Active app users (30 days)', short: 'Active 30d', help: 'App users with an app activity day in the trailing 30 days', align: 'right' },
  { key: 'staffEnrolled', label: 'Staff enrolled', short: 'Staff', help: 'Enabled team members plus the provider account holder', align: 'right' },
  { key: 'bucket', label: 'Order recency and flags', short: 'Recency / flags', help: 'Which order-recency group the office is in, plus any attention flags', align: 'left' },
];

const SORT_KEYS: readonly string[] = HEALTH_COLUMNS.map((column) => column.key);

export function isHealthSortKey(value: string | null | undefined): value is HealthSortKey {
  return typeof value === 'string' && SORT_KEYS.includes(value);
}

export interface HealthSort {
  key: HealthSortKey;
  direction: 'asc' | 'desc';
}

export const DEFAULT_HEALTH_SORT: HealthSort = { key: 'rank', direction: 'asc' };

/** The direction a column starts in when first chosen: counts and score high-first, rank / name / recency low-first. */
export function defaultDirectionFor(key: HealthSortKey): 'asc' | 'desc' {
  return key === 'rank' || key === 'officeName' || key === 'daysSinceLastOrder' || key === 'bucket' ? 'asc' : 'desc';
}

export function nextSort(current: HealthSort, key: HealthSortKey): HealthSort {
  if (current.key !== key) return { key, direction: defaultDirectionFor(key) };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

export interface HealthUrlState {
  group: HealthGroup | null;
  sort: HealthSort;
}

/** Filter and sort live in the query string (`?group=&sort=&dir=`); unknown values fall back quietly. */
export function parseHealthSearch(search: string): HealthUrlState {
  const params = new URLSearchParams(search);
  const group = params.get('group');
  const sort = params.get('sort');
  const dir = params.get('dir');
  return {
    group: isHealthGroup(group) ? group : null,
    sort: isHealthSortKey(sort)
      ? { key: sort, direction: dir === 'asc' || dir === 'desc' ? dir : defaultDirectionFor(sort) }
      : DEFAULT_HEALTH_SORT,
  };
}

/** The query string for a state; the default sort and "all offices" are omitted so the bare URL stays canonical. */
export function healthSearchFor(state: HealthUrlState, base = ''): string {
  const params = new URLSearchParams(base);
  if (state.group) params.set('group', state.group); else params.delete('group');
  if (state.sort.key === DEFAULT_HEALTH_SORT.key && state.sort.direction === DEFAULT_HEALTH_SORT.direction) {
    params.delete('sort'); params.delete('dir');
  } else {
    params.set('sort', state.sort.key); params.set('dir', state.sort.direction);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function filterHealthRows(rows: readonly CustomerHealthOffice[], group: HealthGroup | null): CustomerHealthOffice[] {
  if (!group) return [...rows];
  if (group === 'attention') return rows.filter((row) => row.flags.length > 0);
  return rows.filter((row) => row.bucket === group);
}

const bucketIndex = (bucket: CustomerHealthBucket) => BUCKET_ORDER.indexOf(bucket);

function compareNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  // "No orders on record" (and "—" before the first weekly snapshot) always sinks, whichever direction the column is sorted.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return dir * (a - b);
}

/** Sort rows; ties break on rank then office name so the order is stable and reads like the ranking. */
export function sortHealthRows(rows: readonly CustomerHealthOffice[], sort: HealthSort): CustomerHealthOffice[] {
  const dir: 1 | -1 = sort.direction === 'asc' ? 1 : -1;
  const tie = (a: CustomerHealthOffice, b: CustomerHealthOffice) => a.rank - b.rank || a.officeName.localeCompare(b.officeName) || a.providerId.localeCompare(b.providerId);
  return [...rows].sort((a, b) => {
    let primary = 0;
    switch (sort.key) {
      case 'officeName': primary = dir * a.officeName.localeCompare(b.officeName); break;
      case 'daysSinceLastOrder': primary = compareNullable(a.daysSinceLastOrder, b.daysSinceLastOrder, dir); break;
      case 'scoreChange': primary = compareNullable(a.scoreChange, b.scoreChange, dir); break;
      case 'bucket': primary = dir * (bucketIndex(a.bucket) - bucketIndex(b.bucket)); break;
      default: primary = dir * (a[sort.key] - b[sort.key]);
    }
    return primary || tie(a, b);
  });
}

const fmtCount = (value: number) => value.toLocaleString('en-US');

export function formatCount(value: number): string {
  return fmtCount(value);
}

export function formatDaysAgo(days: number | null): string {
  if (days === null) return 'No orders on record';
  if (days === 0) return 'Today';
  return days === 1 ? '1 day ago' : `${fmtCount(days)} days ago`;
}

/** "vs last week": signed change, "0" for no movement, an em dash before the first weekly snapshot. */
export function formatScoreChange(change: number | null): string {
  if (change === null) return '—';
  if (change === 0) return '0';
  return change > 0 ? `+${fmtCount(change)}` : `−${fmtCount(Math.abs(change))}`;
}

/** Plain words for screen readers and tooltips. */
export function describeScoreChange(change: number | null): string {
  if (change === null) return 'No weekly snapshot yet';
  if (change === 0) return 'Unchanged since last week';
  return `${change > 0 ? 'Up' : 'Down'} ${fmtCount(Math.abs(change))} since last week`;
}

export function countFlagged(rows: readonly CustomerHealthOffice[]): number {
  return rows.filter((row) => row.flags.length > 0).length;
}

export interface HealthDefinition { term: string; text: string }

/** The definitions note, built from the constants the server scored with. */
export function healthDefinitions(d: CustomerHealthDefinitions): HealthDefinition[] {
  const { weights, targets, bucketBounds, bandThresholds, attentionRules } = d;
  return [
    { term: 'Customers', text: 'Every provider office that is enabled and not offboarding or offboarded. Offboarded offices are left out of the ranking.' },
    { term: 'Most recent order', text: 'The latest paid shop order owned by the office, in live mode, including orders refunded or disputed later. Sandbox and test-mode orders never count.' },
    { term: 'Order-recency groups', text: `Active = ordered in the last ${bucketBounds.active} days. Quiet 3–6 months = ${bucketBounds.active + 1}–${bucketBounds.quiet3to6} days. Quiet 6–12 months = ${bucketBounds.quiet3to6 + 1}–${bucketBounds.quiet6to12} days. Quiet over a year / never = more than ${bucketBounds.quiet6to12} days, or no order on record.` },
    { term: 'New', text: `An office created within the last ${d.newOfficeDays} days with no order yet. It sits in the last group but is not read as lapsed.` },
    { term: 'No orders on record', text: 'Order history from the old system is not in this database. An office that migrated over reads "No orders on record" until it places an order here, even if it bought regularly before.' },
    { term: 'App subscribers', text: 'Distinct patients of the office with an active product subscription — people, not subscription rows.' },
    { term: 'App users', text: 'The office\'s patients with a claimed, activated, non-archived account — the same rule Patient retention uses for "onboarded".' },
    { term: 'Active app users', text: 'App users with an app activity day in the trailing 30 days: opened the app or logged anything, the same feed App usage reads. Staff use never counts.' },
    { term: 'Staff enrolled', text: 'Enabled, linked team members of the office plus the provider account holder, who is the implicit owner.' },
    { term: 'Health score', text: `Out of 100. Most recent order ${weights.recency} points — full points at ${d.recencyFullDays} days or less since the last order, falling evenly to zero at ${d.recencyZeroDays} days; no order on record scores zero. App subscribers ${weights.subscribers} points, full at ${targets.subscribers}. App users ${weights.appUsers} points, full at ${targets.appUsers}. Active app users ${weights.activeAppUsers} points, scaled by the share of app users active in 30 days (zero with no app users). Staff enrolled ${weights.staff} points, full at ${targets.staff}.` },
    { term: 'Bands', text: `Healthy ${bandThresholds.healthy} and above. Watch ${bandThresholds.watch}–${bandThresholds.healthy - 1}. At risk below ${bandThresholds.watch}. Tied scores share a rank.` },
    { term: 'Change since last week', text: 'Every Monday at 9:00 am in the organization\'s time zone a weekly run records each office\'s score. The change is today\'s score minus the score recorded in the previous week\'s run — "—" until that first run exists. The same run sends the Monday summary email to HQ members who turned it on for themselves.' },
    { term: 'Needs attention this week', text: `Flagged when any of these hold: last order ${attentionRules.leavingActive.from}–${attentionRules.leavingActive.to} days ago (about to leave Active); last order ${attentionRules.passingSixMonths.from}–${attentionRules.passingSixMonths.to} days ago (about to pass six months); active app users down ${attentionRules.activeUsersDropPct}% or more versus the previous 30 days (only when that window had at least ${attentionRules.activeUsersDropMinPrior}); one or more active subscriptions set to cancel at period end; or the score is At risk and the office is not New.` },
  ];
}
