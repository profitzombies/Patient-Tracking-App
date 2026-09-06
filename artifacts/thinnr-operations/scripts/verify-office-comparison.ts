/**
 * Office comparison — hermetic rules check.
 *
 * Pins the client-side rules the HQ comparison table, the account-detail
 * metric strip, and the live Analytics page share (src/lib/office-analytics.ts)
 * plus the live-mode date-range bounds:
 *
 *   1. Sorting: unavailable offices always sink; null avg-lbs sinks within a
 *      direction; ties break on office name; asc/desc honoured.
 *   2. Ranking: 1 = best, lower-is-better columns invert, ties share a rank,
 *      unavailable offices are unranked.
 *   3. Drill targets: every metric maps to the matching office list under
 *      both the HQ drill-in root and the office's own root.
 *   4. Formatting: unavailable is "—" (never 0), pounds keep one decimal,
 *      percentages with no denominator stay null.
 *   5. Network totals only sum available offices and count unavailable ones.
 *   6. Live date-range bounds: default is the last 30 days ending on the given
 *      today, span capped at 366 days, normalization clamps into bounds; the
 *      demo bounds are untouched (anchor 2026-08-22).
 *
 *   pnpm --filter @workspace/thinnr-operations run test:office-comparison
 */
import type { OfficeComparisonRow, OfficeRangeMetrics } from '@workspace/api-client-react';
import {
  DEFAULT_COMPARISON_SORT,
  OFFICE_METRIC_COLUMNS,
  drillHref,
  formatMetric,
  formatPercent,
  hqOfficeRoot,
  percentOf,
  rankOffices,
  seriesTotal,
  seriesValues,
  sortComparisonRows,
  sumComparison,
  unavailableReason,
} from '../src/lib/office-analytics';
import { sparklineSummary } from '../src/lib/sparkline-summary';
import { expiryLabel } from '../src/lib/export-jobs';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const metrics = (overrides: Partial<OfficeRangeMetrics>): OfficeRangeMetrics => ({
  totalPatients: 10,
  activePatients: 8,
  enrollments: 2,
  engaged: 4,
  needsAttention: 3,
  inactive: 1,
  invited: 1,
  loggingLapsed: 2,
  checkInsOverdue: 1,
  loggingPatients: 5,
  checkInPatients: 6,
  loggingAdherencePct: 63,
  checkInAdherencePct: 75,
  avgPoundsLost: 4.25,
  ...overrides,
});

const row = (providerId: string, officeName: string, m: OfficeRangeMetrics | null, series = [] as OfficeComparisonRow['series']): OfficeComparisonRow => ({
  providerId,
  officeName,
  providerName: `${officeName} MD`,
  firstPatientDate: m ? '2026-09-01' : null,
  available: m !== null,
  metrics: m,
  series,
});

const rows: OfficeComparisonRow[] = [
  row('a', 'Aspen', metrics({ activePatients: 8, needsAttention: 3, avgPoundsLost: 4.25 })),
  row('b', 'Birch', metrics({ activePatients: 12, needsAttention: 1, avgPoundsLost: null })),
  row('c', 'Cedar', metrics({ activePatients: 8, needsAttention: 1, avgPoundsLost: 6 })),
  row('z', 'Zinnia', null),
];

// 1. Sorting
const byActiveDesc = sortComparisonRows(rows, DEFAULT_COMPARISON_SORT).map((r) => r.providerId);
check('default sort: active desc, ties by name, unavailable last', byActiveDesc.join() === 'b,a,c,z', byActiveDesc.join());
const byActiveAsc = sortComparisonRows(rows, { key: 'activePatients', direction: 'asc' }).map((r) => r.providerId);
check('asc sort keeps unavailable last', byActiveAsc.join() === 'a,c,b,z', byActiveAsc.join());
const byLbsDesc = sortComparisonRows(rows, { key: 'avgPoundsLost', direction: 'desc' }).map((r) => r.providerId);
check('null avg lbs sinks below real values (desc)', byLbsDesc.join() === 'c,a,b,z', byLbsDesc.join());
const byLbsAsc = sortComparisonRows(rows, { key: 'avgPoundsLost', direction: 'asc' }).map((r) => r.providerId);
check('null avg lbs sinks below real values (asc)', byLbsAsc.join() === 'a,c,b,z', byLbsAsc.join());
const byName = sortComparisonRows(rows, { key: 'officeName', direction: 'desc' }).map((r) => r.providerId);
check('name sort desc still parks unavailable last', byName.join() === 'c,b,a,z', byName.join());
check('sort does not mutate input', rows[0].providerId === 'a' && rows[3].providerId === 'z');

// 2. Ranking
const activeRanks = rankOffices(rows, 'activePatients');
check('rank: higher active = 1, ties share rank', activeRanks.get('b') === 1 && activeRanks.get('a') === 2 && activeRanks.get('c') === 2, JSON.stringify([...activeRanks]));
check('rank: unavailable office unranked', activeRanks.get('z') === null);
const attentionRanks = rankOffices(rows, 'needsAttention');
check('rank: lower-is-better inverts (needs attention)', attentionRanks.get('b') === 1 && attentionRanks.get('c') === 1 && attentionRanks.get('a') === 3, JSON.stringify([...attentionRanks]));
const lbsRanks = rankOffices(rows, 'avgPoundsLost');
check('rank: null metric unranked, others ranked', lbsRanks.get('c') === 1 && lbsRanks.get('a') === 2 && lbsRanks.get('b') === null);

// 3. Drill targets
const drills = Object.fromEntries(OFFICE_METRIC_COLUMNS.map((c) => [c.key, drillHref(hqOfficeRoot('acct-x'), c.drill)]));
check('drill: patients → office patients list', drills.totalPatients === '/admin/accounts/acct-x/office/patients', drills.totalPatients);
check('drill: active → status=active', drills.activePatients === '/admin/accounts/acct-x/office/patients?status=active', drills.activePatients);
check('drill: lapsed → reason=logging_lapsed', drills.loggingLapsed === '/admin/accounts/acct-x/office/patients?reason=logging_lapsed', drills.loggingLapsed);
check('drill: overdue → reason=check_in_overdue', drills.checkInsOverdue === '/admin/accounts/acct-x/office/patients?reason=check_in_overdue', drills.checkInsOverdue);
check('drill: needs attention / engaged / enrollments → office overview', drills.needsAttention === '/admin/accounts/acct-x/office' && drills.engaged === drills.needsAttention && drills.enrollments === drills.needsAttention);
check('drill: office root "" → own app paths', drillHref('', OFFICE_METRIC_COLUMNS[1].drill) === '/patients?status=active' && drillHref('', { page: 'overview' }) === '/');
check('every column has help text and a label', OFFICE_METRIC_COLUMNS.every((c) => c.help.length > 10 && c.label && c.short));

// 4. Formatting
check('format: unavailable renders "—", never 0', formatMetric('activePatients', null) === '—' && formatMetric('avgPoundsLost', null) === '—');
check('format: pounds one decimal, counts grouped', formatMetric('avgPoundsLost', 4.25) === '4.3' && formatMetric('totalPatients', 1234) === '1,234');
check('percent: no denominator → null → "—"', percentOf(3, 0) === null && percentOf(null, 5) === null && formatPercent(null) === '—');
check('percent: rounds', percentOf(1, 3) === 33 && formatPercent(50) === '50%');
check('unavailable reason names the first patient date when range predates it', unavailableReason('2026-09-01', '2026-08-15').includes('2026-09-01') && unavailableReason('2026-09-01', '2026-08-15').includes('not zero'));
check('unavailable reason handles no data at all', unavailableReason(null, '2026-09-01').toLowerCase().includes('no patient data'));

// 5. Totals + series
const totals = sumComparison(rows);
check('totals: sum available offices only', totals.activePatients === 28 && totals.availableOffices === 3 && totals.unavailableOffices === 1, JSON.stringify(totals));
const series = [
  { date: '2026-09-01', activePatients: 1, engagedPatients: 1, enrollments: 1, checkIns: 0 },
  { date: '2026-09-02', activePatients: 2, engagedPatients: 1, enrollments: 1, checkIns: 2 },
  { date: '2026-09-03', activePatients: 2, engagedPatients: 2, enrollments: 0, checkIns: 1 },
];
check('series: values + totals', seriesValues(series, 'engagedPatients').join() === '1,1,2' && seriesTotal(series, 'checkIns') === 3);
check('sparkline summary announces direction and endpoints', sparklineSummary([1, 1, 2], 'engaged').includes('up') && sparklineSummary([], 'engaged').startsWith('No '));

// 6. Live date-range bounds
const dateRange = await import('../src/lib/date-range-keys');
const live = dateRange.rangeBoundsFor('live', '2026-09-06');
check('live bounds: default = last 30 days ending today', live.defaultRange.start === '2026-08-08' && live.defaultRange.end === '2026-09-06', JSON.stringify(live.defaultRange));
check('live bounds: max = today, min = 366-day window', live.maxKey === '2026-09-06' && live.minKey === '2025-09-06', `${live.minKey}..${live.maxKey}`);
const clamped = dateRange.normalizeRange({ start: '2027-01-01', end: '2024-01-01' }, live);
check('live normalize: orders and clamps into bounds', clamped.start === live.minKey && clamped.end === live.maxKey, JSON.stringify(clamped));
const demo = dateRange.rangeBoundsFor('demo');
check('demo bounds untouched: anchor 2026-08-22, default Jul 24 – Aug 22', demo.maxKey === '2026-08-22' && demo.defaultRange.start === '2026-07-24' && demo.minKey === '2026-01-01');
check('demo normalize default still clamps to the demo window', dateRange.normalizeRange({ start: '2026-09-01', end: '2026-09-06' }).end === '2026-08-22');

// Exports expiry copy
const now = Date.parse('2026-09-06T12:00:00Z');
check('expiry label: minutes / hours / expired', expiryLabel('2026-09-06T12:30:00Z', now) === 'Expires in 30 min' && expiryLabel('2026-09-07T11:00:00Z', now) === 'Expires in 23 h' && expiryLabel('2026-09-06T11:00:00Z', now) === 'Expired');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nOffice comparison rules verified.');
