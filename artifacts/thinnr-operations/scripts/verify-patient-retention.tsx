/**
 * HQ Patient retention — rules + page states.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:patient-retention
 *
 * Pure half (src/lib/patient-retention.ts + src/data/hq/patient-retention-demo.ts):
 *   - sorting: unavailable offices always sink, null shares sink within a
 *     direction, ties break on office name, asc/desc honoured;
 *   - ranking: 1 = highest, ties share a rank, unavailable offices unranked;
 *   - formatting: unavailable is "—" (never 0), shares carry "%", counts group;
 *   - the all-practices total sums available offices and recomputes shares;
 *   - sample dates follow the server rule (week ends ≤ 13 weeks, else month
 *     ends; near-start boundary dropped; bracketed by start and end);
 *   - the seeded demo agrees with App usage at the anchor (onboarded = the
 *     632 activated patients, active = monthly active per office), keeps
 *     every patient in exactly one of active/inactive with tiers summing to
 *     inactive, is a pure function of the range, and honours "available
 *     since first patient".
 *
 * Rendered half (REAL page under react-test-renderer; session / HQ
 * directory / supabase contexts stubbed via tsconfig.system-health.json,
 * global fetch scripted):
 *   - demo persona: the page shows the seeded figures and makes NO request;
 *   - focusing a practice (dropdown or row button) narrows tiles, chart and
 *     tiers to that office, purely client-side; clearing restores the network;
 *   - signed-in HQ: loading state first (no seeded numbers), then the live
 *     tiles with shares, the "Updated …" stamp, the trend chart, the tier
 *     tiles, the per-practice table with total row + unavailable chip/note,
 *     office links to the account page, 30-second polling on an
 *     identity-scoped key, sortable columns;
 *   - a range before any patient shows the unavailable notice, not 0;
 *   - a 502 renders the error notices and "Error" tiles; Try again refetches;
 *   - Support / Content / Clinical lack the page permission; Admin has it.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PatientRetentionCounts, PatientRetentionOfficeRow, PatientRetentionResult } from '@workspace/api-client-react';
import { __setSession } from './a11y-stubs/session';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { DateRangeProvider } from '../src/contexts/date-range';
import PatientRetention from '../src/pages/admin/PatientRetention';
import { canHq, permissionForAdminPath } from '../src/data/hq/team';
import { DEFAULT_DATE_RANGE, DEMO_TODAY_KEY, addDaysToKey } from '../src/lib/date-range-keys';
import { DEMO_APP_USAGE_OFFICES, demoAppUsage } from '../src/data/hq/app-usage-demo';
import { demoPatientRetention } from '../src/data/hq/patient-retention-demo';
import {
  DEFAULT_RETENTION_SORT,
  INACTIVE_TIERS,
  RETENTION_COLUMNS,
  countRetentionUnavailable,
  formatRetentionMetric,
  rankRetentionRows,
  retentionChartSeries,
  retentionSampleDates,
  retentionShare,
  retentionUnavailableReason,
  shareOfOnboarded,
  sortRetentionRows,
  totalRetentionCounts,
} from '../src/lib/patient-retention';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.window.innerWidth ??= 1280;
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.location ??= { assign: () => {} };
g.window.setInterval ??= (...args: Parameters<typeof setInterval>) => setInterval(...args);
g.window.clearInterval ??= (id: ReturnType<typeof setInterval>) => clearInterval(id);

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const num = (text: string) => Number(text.replace(/,/g, ''));

// ─── Pure rules ──────────────────────────────────────────────────────────────

function counts(partial: Partial<PatientRetentionCounts> = {}): PatientRetentionCounts {
  const base: PatientRetentionCounts = {
    onboarded: 100, newInRange: 10, active: 70, inactive: 30, buying: 50, subscribed: 35,
    inactiveUnder30: 6, inactive30to60: 9, inactive60to90: 5, inactive90plus: 10,
    activePct: 70, buyingPct: 50, inactivePct: 30,
  };
  return { ...base, ...partial };
}

const row = (id: string, name: string, metrics: Partial<PatientRetentionCounts> | null, extra: Partial<PatientRetentionOfficeRow> = {}): PatientRetentionOfficeRow => ({
  providerId: id,
  officeName: name,
  providerName: `${name} lead`,
  firstPatientDate: metrics ? '2026-01-05' : '2026-12-01',
  available: metrics !== null,
  metrics: metrics ? counts(metrics) : null,
  series: metrics
    ? [{ date: '2026-08-24', onboarded: 90, active: 60, buying: 40, inactive: 30 }, { date: '2026-09-22', onboarded: 100, active: metrics.active ?? 70, buying: metrics.buying ?? 50, inactive: 100 - (metrics.active ?? 70) }]
    : [],
  ...extra,
});

console.log('rules');
{
  const rows = [
    row('a', 'Alpha', { onboarded: 100 }),
    row('b', 'Bravo', { onboarded: 150, activePct: null, buyingPct: null, inactivePct: null }),
    row('c', 'Charlie', { onboarded: 100 }),
    row('z', 'Zulu', null),
  ];
  const desc = sortRetentionRows(rows, DEFAULT_RETENTION_SORT).map((r) => r.providerId);
  check('default sort: onboarded desc, ties by name, unavailable last', desc.join() === 'b,a,c,z', desc.join());
  const asc = sortRetentionRows(rows, { key: 'onboarded', direction: 'asc' }).map((r) => r.providerId);
  check('asc sort keeps unavailable last', asc.join() === 'a,c,b,z', asc.join());
  const byShare = sortRetentionRows(rows, { key: 'activePct', direction: 'desc' }).map((r) => r.providerId);
  check('null share sinks within available rows', byShare.join() === 'a,c,b,z', byShare.join());
  const byName = sortRetentionRows(rows, { key: 'officeName', direction: 'desc' }).map((r) => r.providerId);
  check('name sort desc still sinks unavailable', byName.join() === 'c,b,a,z', byName.join());

  const ranks = rankRetentionRows(rows, 'onboarded');
  check('rank: 1 = highest, ties share, unavailable unranked',
    ranks.get('b') === 1 && ranks.get('a') === 2 && ranks.get('c') === 2 && ranks.get('z') === null, JSON.stringify([...ranks]));
  check('null share is unranked', rankRetentionRows(rows, 'activePct').get('b') === null && rankRetentionRows(rows, 'activePct').get('a') === 1);

  check('format: unavailable is "—", counts group, shares carry %',
    formatRetentionMetric('onboarded', null) === '—' && formatRetentionMetric('active', 1234) === '1,234' && formatRetentionMetric('activePct', 62.4) === '62%');
  check('retentionShare: no denominator → null, else one decimal', retentionShare(5, 0) === null && retentionShare(1, 3) === 33.3);
  check('shareOfOnboarded copy', shareOfOnboarded(31, 632) === '31% of 632 onboarded' && shareOfOnboarded(null, 0) === 'No onboarded patients yet' && shareOfOnboarded(null, 4) === 'Share unavailable');
  check('columns: onboarded first, four inactive-ish columns last', RETENTION_COLUMNS[0].key === 'onboarded' && RETENTION_COLUMNS[RETENTION_COLUMNS.length - 1].key === 'inactive90plus');
  check('tiers: four, oldest last', INACTIVE_TIERS.length === 4 && INACTIVE_TIERS[3].key === 'inactive90plus');

  const total = totalRetentionCounts(rows)!;
  check('total sums available offices and recomputes shares',
    total.onboarded === 350 && total.active === 210 && total.activePct === 60 && total.inactive90plus === 30 && total.newInRange === 30, JSON.stringify(total));
  check('total is null with no available office', totalRetentionCounts([row('z', 'Zulu', null)]) === null);
  check('unavailable reason names the first patient date', retentionUnavailableReason('2026-12-01', '2026-09-22').includes('2026-12-01') && countRetentionUnavailable(rows) === 1);
  const chart = retentionChartSeries(rows[0].series);
  check('chart series unpack the four lines', chart.dates.length === 2 && chart.onboarded[1] === 100 && chart.inactive[1] === 30);
}

console.log('sample dates (mirror of the server rule)');
{
  check('short range: week ends bracketed by start and end',
    retentionSampleDates('2026-07-24', '2026-08-22').dates.join() === '2026-07-24,2026-08-01,2026-08-08,2026-08-15,2026-08-22'
      && retentionSampleDates('2026-07-24', '2026-08-22').step === 'week');
  check('long range: month ends, near-start boundary dropped',
    retentionSampleDates('2026-01-25', '2026-08-22').dates.join() === '2026-01-25,2026-02-28,2026-03-31,2026-04-30,2026-05-31,2026-06-30,2026-07-31,2026-08-22'
      && retentionSampleDates('2026-01-25', '2026-08-22').step === 'month');
  check('month-end range end is not duplicated', retentionSampleDates('2026-05-01', '2026-08-31').dates.filter((d) => d === '2026-08-31').length === 1);
  check('single day', retentionSampleDates('2026-08-22', '2026-08-22').dates.join() === '2026-08-22');
}

console.log('demo dataset');
{
  const first = demoPatientRetention(DEFAULT_DATE_RANGE);
  const again = demoPatientRetention(DEFAULT_DATE_RANGE);
  check('demo is byte-stable across calls', JSON.stringify(first) === JSON.stringify(again));
  check('demo is anchored to the demo date, not the clock', first.asOf.startsWith(DEMO_TODAY_KEY) && DEFAULT_DATE_RANGE.end === DEMO_TODAY_KEY);
  const usage = demoAppUsage(DEFAULT_DATE_RANGE);
  check('at the anchor each office\'s onboarded = its App usage activated patients (632 total)',
    first.offices.every((office, i) => office.metrics!.onboarded === DEMO_APP_USAGE_OFFICES[i].patients) && first.network.metrics!.onboarded === 632);
  check('at the anchor each office\'s active = its App usage monthly active',
    first.offices.every((office, i) => office.metrics!.active === usage.offices[i].metrics!.monthlyActive), first.offices.map((o) => o.metrics!.active).join());
  const partitions = (m: PatientRetentionCounts) => m.active + m.inactive === m.onboarded && m.inactiveUnder30 + m.inactive30to60 + m.inactive60to90 + m.inactive90plus === m.inactive;
  check('every patient is in exactly one of active/inactive and the tiers sum to inactive (offices + network)',
    first.offices.every((o) => partitions(o.metrics!)) && partitions(first.network.metrics!));
  check('buying ≤ onboarded, subscribed ≤ buying, tiers non-negative',
    first.offices.every((o) => o.metrics!.buying <= o.metrics!.onboarded && o.metrics!.subscribed <= o.metrics!.buying
      && [o.metrics!.inactiveUnder30, o.metrics!.inactive30to60, o.metrics!.inactive60to90, o.metrics!.inactive90plus].every((n) => n >= 0)));
  check('network counts are the sum of the office counts',
    (['onboarded', 'active', 'buying', 'inactive', 'newInRange', 'inactive90plus'] as const).every((key) => first.network.metrics![key] === first.offices.reduce((sum, o) => sum + o.metrics![key], 0)));
  check('network series sums office series at each sample date and ends on the headline figures',
    first.network.series.every((point) => point.onboarded === first.offices.reduce((sum, o) => sum + (o.series.find((p) => p.date === point.date)?.onboarded ?? 0), 0))
      && first.network.series[first.network.series.length - 1].active === first.network.metrics!.active && first.step === 'week');
  check('onboarding never falls across the range', first.offices.every((o) => o.series.every((p, i, all) => i === 0 || p.onboarded >= all[i - 1].onboarded)));
  check('new in range is onboarded now minus onboarded the day before the range',
    first.network.metrics!.newInRange > 0
      && first.network.metrics!.newInRange === first.network.metrics!.onboarded - demoPatientRetention({ start: '2026-01-01', end: addDaysToKey(DEFAULT_DATE_RANGE.start, -1) }).network.metrics!.onboarded);
  const early = demoPatientRetention({ start: '2025-11-01', end: '2025-11-30' });
  check('a range before an office\'s first patient marks it unavailable (not zero)',
    early.offices.filter((office) => !office.available).length === 3 && early.offices[0].available && early.offices[0].metrics!.onboarded > 0
      && early.offices[1].metrics === null && early.offices[1].series.length === 0);
  check('a young office has no 60–90 / 90+ quiet patients yet',
    early.offices[0].metrics!.inactive60to90 === 0 && early.offices[0].metrics!.inactive90plus === 0 && early.offices[0].metrics!.inactive > 0);
  const none = demoPatientRetention({ start: '2025-09-01', end: '2025-09-30' });
  check('a range before every office → network unavailable, empty series', none.network.available === false && none.network.metrics === null && none.network.series.length === 0);
  const year = demoPatientRetention({ start: '2025-08-23', end: '2026-08-22' });
  check('a year-long range samples month by month (from the first patient onwards)', year.step === 'month' && year.network.series.length >= 10 && year.network.series.length <= 14 && year.network.series[0].date >= '2025-10-06');
  check('demo offices keep the seeded account ids', first.offices.map((o) => o.providerId).join() === 'acct-p1,acct-p2,acct-p3,acct-p4');
}

console.log('permissions');
{
  check('/admin/retention maps to the overview (analytics) permission', permissionForAdminPath('/admin/retention') === 'overview');
  check('Admin and Super Admin may open it', canHq('Admin', 'overview') && canHq('Super Admin', 'overview'));
  check('Support, Content and Clinical may not', !canHq('Support', 'overview') && !canHq('Content', 'overview') && !canHq('Clinical', 'overview'));
}

// ─── Rendered page ───────────────────────────────────────────────────────────

const LIVE_ROWS: PatientRetentionOfficeRow[] = [
  row('office-a', 'Harbor Clinic', { onboarded: 120, newInRange: 12, active: 98, inactive: 22, buying: 61, subscribed: 40, inactiveUnder30: 4, inactive30to60: 6, inactive60to90: 5, inactive90plus: 7, activePct: 81.7, buyingPct: 50.8, inactivePct: 18.3 }, { firstPatientDate: '2026-03-01' }),
  row('office-b', 'Summit Health', { onboarded: 80, newInRange: 8, active: 66, inactive: 14, buying: 47, subscribed: 30, inactiveUnder30: 2, inactive30to60: 3, inactive60to90: 4, inactive90plus: 5, activePct: 82.5, buyingPct: 58.8, inactivePct: 17.5 }, { firstPatientDate: '2026-04-15' }),
  row('office-c', 'Newest Office', null, { firstPatientDate: '2027-01-02' }),
];
function liveResult(rangeStart: string, rangeEnd: string, overrides: Partial<PatientRetentionResult['network']> = {}): PatientRetentionResult {
  return {
    range: { start: rangeStart, end: rangeEnd },
    asOf: new Date().toISOString(),
    step: 'week',
    network: {
      firstPatientDate: '2026-03-01',
      available: true,
      metrics: counts({ onboarded: 200, newInRange: 20, active: 164, inactive: 36, buying: 108, subscribed: 70, inactiveUnder30: 6, inactive30to60: 9, inactive60to90: 9, inactive90plus: 12, activePct: 82, buyingPct: 54, inactivePct: 18 }),
      series: [
        { date: '2026-08-24', onboarded: 180, active: 150, buying: 90, inactive: 30 },
        { date: '2026-09-22', onboarded: 200, active: 164, buying: 108, inactive: 36 },
      ],
      ...overrides,
    },
    offices: LIVE_ROWS,
  };
}

const requests: string[] = [];
const retentionRequests = () => requests.filter((r) => r.includes('/api/hq/patient-retention?'));
let status = 200;
let overrides: Partial<PatientRetentionResult['network']> = {};
let hold: (() => void) | null = null;
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url}`);
  const json = (payload: unknown, code = 200) => new Response(JSON.stringify(payload), { status: code, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/api/hq/patient-retention')) {
    if (hold) await new Promise<void>((resolve) => { hold = resolve; });
    if (status !== 200) return json({ error: 'Patient retention is unavailable right now.' }, status);
    const params = new URL(url, 'http://test.local').searchParams;
    return json(liveResult(params.get('start') ?? '', params.get('end') ?? '', overrides));
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

async function mount(Page: React.ComponentType, path: string) {
  const location = memoryLocation({ path });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DateRangeProvider>
          <Router hook={location.hook}>
            <Route path={path}><Page /></Route>
          </Router>
        </DateRangeProvider>
      </QueryClientProvider>,
    );
  });
  return { renderer: renderer!, client, unmount: async () => { await act(async () => { renderer!.unmount(); }); client.clear(); } };
}
const rowIds = (root: ReactTestInstance) => root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('row-retention-') && n.props['data-testid'] !== 'row-retention-total').map((n) => n.props['data-testid']);

console.log('demo page');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  __setHqData({ accounts: [] });
  requests.length = 0;
  const { renderer, unmount } = await mount(PatientRetention, '/admin/retention');
  await settle();
  const root = renderer.root;
  const expected = demoPatientRetention(DEFAULT_DATE_RANGE);
  const net = expected.network.metrics!;
  check('demo page makes no request', requests.length === 0, requests.join('\n'));
  check('demo tiles show the seeded network figures',
    num(textOf(byTestId(root, 'text-retention-onboarded')[0])) === net.onboarded && num(textOf(byTestId(root, 'text-retention-active')[0])) === net.active
      && num(textOf(byTestId(root, 'text-retention-buying')[0])) === net.buying && num(textOf(byTestId(root, 'text-retention-inactive')[0])) === net.inactive
      && net.onboarded === 632);
  check('tier tiles carry the seeded breakdown and sum to inactive',
    INACTIVE_TIERS.reduce((sum, tier) => sum + num(textOf(byTestId(root, `text-retention-${tier.key}`)[0])), 0) === net.inactive);
  check('definitions are on the page in plain language', textOf(byTestId(root, 'text-retention-definition')[0]).includes('last 30 days') && textOf(byTestId(root, 'text-retention-definition')[0]).includes('last 90 days'));
  check('demo header is anchored to the demo date', textOf(byTestId(root, 'text-retention-asof')[0]).includes('2026') && textOf(byTestId(root, 'text-retention-updated')[0]) === 'Demo figures');
  check('demo table lists the four seeded offices plus the total row',
    byTestId(root, 'table-patient-retention').length === 1 && rowIds(root).length === 4 && byTestId(root, 'row-retention-total').length === 1
      && num(textOf(byTestId(root, 'retention-total-onboarded')[0])) === 632 && byTestId(root, 'text-retention-unavailable-note').length === 0);
  check('office name links to the account page', byTestId(root, 'link-retention-office-acct-p1')[0]?.props.href === '/admin/accounts/acct-p1');
  const chartFigure = byTestId(root, 'chart-patient-retention')[0];
  const spoken = chartFigure?.findAll((n) => n.props.role === 'img' && typeof n.props['aria-label'] === 'string')[0]?.props['aria-label'] as string | undefined;
  check('trend chart renders with a spoken summary of the four lines', !!spoken && spoken.includes('Onboarded') && spoken.includes('Active') && spoken.includes('Buying') && spoken.includes('Inactive'), spoken);
  check('Jenkins active cell equals its App usage monthly active', num(textOf(byTestId(root, 'retention-cell-active-acct-p1')[0])) === demoAppUsage(DEFAULT_DATE_RANGE).offices[0].metrics!.monthlyActive);

  // Focus a practice from the row button, then clear it from the notice.
  const jenkins = expected.offices[0].metrics!;
  await act(async () => { byTestId(root, 'button-retention-focus-acct-p1')[0].props.onClick(); });
  check('focusing a practice narrows the tiles, tiers and chart to that office (no request)',
    num(textOf(byTestId(root, 'text-retention-onboarded')[0])) === jenkins.onboarded && num(textOf(byTestId(root, 'text-retention-inactive90plus')[0])) === jenkins.inactive90plus
      && textOf(byTestId(root, 'text-retention-focus')[0]).includes('Jenkins Aesthetics & Wellness') && byTestId(root, 'select-retention-office')[0].props.value === 'acct-p1'
      && byTestId(root, 'row-retention-acct-p1')[0].props['data-focused'] === 'true' && byTestId(root, 'button-retention-focus-acct-p1')[0].props['aria-pressed'] === true
      && requests.length === 0);
  await act(async () => { byTestId(root, 'select-retention-office')[0].props.onChange({ target: { value: 'acct-p2' } }); });
  check('the dropdown switches the focused practice', num(textOf(byTestId(root, 'text-retention-onboarded')[0])) === expected.offices[1].metrics!.onboarded);
  await act(async () => { byTestId(root, 'button-retention-focus-clear')[0].props.onClick(); });
  check('clearing focus restores the network figures', num(textOf(byTestId(root, 'text-retention-onboarded')[0])) === 632 && byTestId(root, 'text-retention-focus').length === 0);
  await unmount();
}

console.log('live page');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1', displayName: 'Ada Admin' }, hqRole: 'Admin' });
  __setSupabaseSession('token');
  requests.length = 0;
  hold = () => {};
  const { renderer, client, unmount } = await mount(PatientRetention, '/admin/retention');
  await settle(2);
  const root = renderer.root;
  check('loading: tiles show — and the chart/table show loading copy (no seeded numbers)',
    textOf(byTestId(root, 'text-retention-onboarded')[0]) === '—' && byTestId(root, 'text-retention-chart-loading').length === 1
      && byTestId(root, 'text-retention-table-loading').length === 1 && byTestId(root, 'table-patient-retention').length === 0
      && byTestId(root, 'text-retention-updated').length === 0 && byTestId(root, 'select-retention-office')[0].props.disabled === true);
  const release = hold; hold = null; release();
  await settle();
  check('one live request with the shared range', retentionRequests().length === 1 && /GET \/api\/hq\/patient-retention\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}$/.test(retentionRequests()[0]), requests.join('\n'));
  const json = JSON.stringify(renderer.toJSON());
  check('ready: network tiles with shares and the new-in-range note',
    textOf(byTestId(root, 'text-retention-onboarded')[0]) === '200' && textOf(byTestId(root, 'text-retention-active')[0]) === '164'
      && textOf(byTestId(root, 'text-retention-buying')[0]) === '108' && textOf(byTestId(root, 'text-retention-inactive')[0]) === '36'
      && json.includes('82% of 200 onboarded') && json.includes('+20 new in this range') && json.includes('70 on a subscription'));
  check('tier tiles show the live breakdown with shares of inactive',
    textOf(byTestId(root, 'text-retention-inactive90plus')[0]) === '12' && json.includes('33% of inactive'));
  check('header shows when the data last landed', /^Updated \d{1,2}:\d{2}:\d{2} (AM|PM)$/.test(textOf(byTestId(root, 'text-retention-updated')[0])), textOf(byTestId(root, 'text-retention-updated')[0]));
  check('chart renders', byTestId(root, 'chart-patient-retention').length === 1);
  check('table: unavailable office chip + note; available rows carry figures; total row sums',
    byTestId(root, 'text-retention-unavailable-office-c').length === 1
      && textOf(byTestId(root, 'text-retention-unavailable-note')[0]) === '1 of 3 practices had no patient by the end of this range and are shown as unavailable.'
      && textOf(byTestId(root, 'retention-cell-active-office-a')[0]) === '98' && textOf(byTestId(root, 'retention-cell-buyingPct-office-b')[0]) === '59%'
      && textOf(byTestId(root, 'retention-sparkline-office-c')[0]) === '—' && byTestId(root, 'button-retention-focus-office-c').length === 0
      && textOf(byTestId(root, 'retention-total-onboarded')[0]) === '200' && textOf(byTestId(root, 'retention-total-activePct')[0]) === '82%');
  check('rank follows onboarded; unavailable is unranked',
    textOf(byTestId(root, 'retention-rank-office-a')[0]) === '1' && textOf(byTestId(root, 'retention-rank-office-b')[0]) === '2' && textOf(byTestId(root, 'retention-rank-office-c')[0]) === '—');
  check('office rows link to the account page', byTestId(root, 'link-retention-office-office-a')[0]?.props.href === '/admin/accounts/office-a');
  const query = client.getQueryCache().findAll().find((q) => JSON.stringify(q.queryKey).includes('/api/hq/patient-retention'));
  const observer = query?.observers[0] as { options?: { refetchInterval?: number } } | undefined;
  check('polls every 30 seconds on an identity-scoped key',
    observer?.options?.refetchInterval === 30_000 && JSON.stringify(query?.queryKey).includes('"hq-1"'), JSON.stringify(query?.queryKey));

  await act(async () => { byTestId(root, 'sort-retention-buyingPct')[0].props.onClick(); });
  check('sorting by buying share reorders and keeps unavailable last', rowIds(root).join() === 'row-retention-office-b,row-retention-office-a,row-retention-office-c'
    && textOf(byTestId(root, 'retention-rank-office-b')[0]) === '1', rowIds(root).join());

  const before = retentionRequests().length;
  await act(async () => { byTestId(root, 'button-retention-focus-office-b')[0].props.onClick(); });
  check('focusing a live practice is client-side (no new request) and narrows the tiles',
    retentionRequests().length === before && textOf(byTestId(root, 'text-retention-onboarded')[0]) === '80' && textOf(byTestId(root, 'text-retention-inactive60to90')[0]) === '4');
  await unmount();
}

console.log('live page — no patient in range');
{
  requests.length = 0;
  overrides = { available: false, metrics: null, series: [] };
  const { renderer, unmount } = await mount(PatientRetention, '/admin/retention');
  await settle();
  check('chart area says unavailable, not zero; tiles show —',
    byTestId(renderer.root, 'text-retention-chart-unavailable').length === 1 && byTestId(renderer.root, 'chart-patient-retention').length === 0
      && textOf(byTestId(renderer.root, 'text-retention-onboarded')[0]) === '—');
  overrides = {};
  await unmount();
}

console.log('live page — failure');
{
  requests.length = 0;
  status = 502;
  const { renderer, unmount } = await mount(PatientRetention, '/admin/retention');
  // The page retries once (retry: 1) before reporting, so wait out the retry delay.
  await settle();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });
  await settle();
  const root = renderer.root;
  check('the failed read was retried exactly once before reporting', retentionRequests().length === 2, String(retentionRequests().length));
  const alerts = root.findAll((n) => n.props.role === 'alert' && typeof n.type === 'string');
  check('a 502 renders error notices and Error tiles, never seeded figures',
    alerts.length === 2 && textOf(byTestId(root, 'text-retention-onboarded')[0]) === 'Error' && textOf(byTestId(root, 'text-retention-inactive90plus')[0]) === 'Error'
      && byTestId(root, 'table-patient-retention').length === 0 && JSON.stringify(renderer.toJSON()).includes('Failed to load'));
  status = 200;
  const before = retentionRequests().length;
  const retry = byTestId(root, 'text-retention-chart-error')[0].findAll((n) => n.type === 'button')[0];
  await act(async () => { retry.props.onClick(); });
  await settle();
  check('Try again refetches and recovers', retentionRequests().length === before + 1 && textOf(byTestId(root, 'text-retention-onboarded')[0]) === '200' && byTestId(root, 'table-patient-retention').length === 1);
  await unmount();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall patient retention checks passed');
