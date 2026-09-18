/**
 * HQ Patient retention — rules + page states.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:patient-retention
 *
 * Pure half (src/lib/patient-retention.ts + src/data/hq/patient-retention-demo.ts):
 *   - sorting: unavailable offices always sink, null shares sink, ties break
 *     on office name, asc/desc honoured;
 *   - formatting: unavailable is "—" (never 0), shares carry "%", counts group;
 *   - period rule: weekly up to 120 days, monthly beyond (shared lib);
 *   - the seeded demo partitions exactly (office figures sum to the network
 *     figures; 632 onboarded at the anchor), keeps every patient in exactly
 *     one of active / inactive, tiers sum to inactive, agrees with the App
 *     usage monthly-active figures on the demo date, is byte-stable, honours
 *     "available since first patient", and narrows to one office.
 *
 * Rendered half (REAL page under react-test-renderer; session / HQ directory
 * / supabase contexts stubbed via tsconfig.system-health.json, global fetch
 * scripted):
 *   - demo persona: seeded tiles, chart, table with total row, inactive tiers,
 *     definitions, NO request; choosing a practice narrows via ?office=;
 *   - signed-in HQ: loading first (no seeded numbers), then live tiles with
 *     shares, the per-practice table with the unavailable chip + note, the
 *     total row equal to the network counts, office= on the narrowed request;
 *   - a range with no onboarded patient shows the unavailable notice, not 0;
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
import { retentionPeriodFor, retentionPeriodWindows } from '@workspace/app-usage-insights';
import { __setSession } from './a11y-stubs/session';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { DateRangeProvider } from '../src/contexts/date-range';
import PatientRetention from '../src/pages/admin/PatientRetention';
import { canHq, permissionForAdminPath } from '../src/data/hq/team';
import { DEFAULT_DATE_RANGE, DEMO_TODAY_KEY } from '../src/lib/date-range-keys';
import { demoAppUsage } from '../src/data/hq/app-usage-demo';
import { DEMO_RETENTION_OFFICES, demoPatientRetention } from '../src/data/hq/patient-retention-demo';
import {
  DEFAULT_RETENTION_SORT,
  RETENTION_COLUMNS,
  RETENTION_DEFINITIONS,
  countRetentionUnavailable,
  formatRetentionMetric,
  inactiveTierRows,
  retentionChartSeries,
  retentionPointLabel,
  retentionUnavailableReason,
  shareOfOnboarded,
  sortRetentionRows,
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
const rowIds = (root: ReactTestInstance) => root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('row-retention-') && n.props['data-testid'] !== 'row-retention-total').map((n) => n.props['data-testid'].replace('row-retention-', ''));
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const fmt = (value: number) => value.toLocaleString('en-US');

// ─── Pure rules ──────────────────────────────────────────────────────────────

const counts = (partial: Partial<PatientRetentionCounts> = {}): PatientRetentionCounts => ({
  onboarded: 100, active: 70, buying: 40, inactive: 30, activePct: 70, buyingPct: 40,
  inactiveTiers: { days30to60: 15, days60to90: 10, days90plus: 5 },
  ...partial,
});
const row = (id: string, name: string, c: PatientRetentionCounts | null, extra: Partial<PatientRetentionOfficeRow> = {}): PatientRetentionOfficeRow => ({
  providerId: id, officeName: name, providerName: `${name} lead`,
  firstOnboardedDate: c ? '2026-01-05' : '2026-12-01', available: c !== null, counts: c,
  series: c ? [{ periodStart: '2026-08-20', periodEnd: '2026-08-26', onboarded: 90, active: 60, buying: 35, inactive: 30 }, { periodStart: '2026-08-27', periodEnd: '2026-09-02', ...c }] : [],
  ...extra,
});

console.log('rules');
{
  const rows = [
    row('a', 'Alpha', counts({ onboarded: 100 })),
    row('b', 'Bravo', counts({ onboarded: 120, activePct: null, buyingPct: null })),
    row('c', 'Charlie', counts({ onboarded: 100 })),
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
  check('format: unavailable is "—", counts group, shares carry %',
    formatRetentionMetric('onboarded', null) === '—' && formatRetentionMetric('active', 1234) === '1,234' && formatRetentionMetric('activePct', 62.4) === '62%');
  check('shareOfOnboarded copy', shareOfOnboarded(84) === '84% of onboarded' && shareOfOnboarded(null) === 'No onboarded patients yet');
  check('columns: four counts then two shares', RETENTION_COLUMNS.map((c) => c.key).join() === 'onboarded,active,buying,inactive,activePct,buyingPct');
  check('unavailable reasons', retentionUnavailableReason(null, '2026-09-18') === 'This office has no onboarded patient yet.' && retentionUnavailableReason('2026-10-01', '2026-09-18').includes('after the range end'));
  check('countRetentionUnavailable', countRetentionUnavailable(rows) === 1);
  const tiers = inactiveTierRows(counts());
  check('inactive tiers in order with shares of inactive', tiers.map((t) => `${t.key}:${t.value}:${t.pct}`).join() === 'days30to60:15:50,days60to90:10:33,days90plus:5:17');
  check('inactive tiers with nobody inactive carry null shares', inactiveTierRows(counts({ inactive: 0, inactiveTiers: { days30to60: 0, days60to90: 0, days90plus: 0 } })).every((t) => t.pct === null && t.value === 0));
  check('definitions cover the four buckets, in plain language', RETENTION_DEFINITIONS.map((d) => d.term).join() === 'Onboarded,Active,Buying,Inactive'
    && RETENTION_DEFINITIONS[1].text.includes('30 days') && RETENTION_DEFINITIONS[1].text.includes('Staff use never counts')
    && RETENTION_DEFINITIONS[2].text.includes('90 days') && RETENTION_DEFINITIONS[3].text.includes('never both'));
  const chart = retentionChartSeries(rows[0].series);
  check('chart series keyed by period end', chart.dates.join() === '2026-08-26,2026-09-02' && chart.onboarded.join() === '90,100' && chart.inactive.join() === '30,30');
  check('point labels: weeks read as the end day, full months as the month', retentionPointLabel(rows[0].series, 'week', '2026-09-02') === 'Sep 2'
    && retentionPointLabel([{ periodStart: '2026-08-01', periodEnd: '2026-08-31', onboarded: 0, active: 0, buying: 0, inactive: 0 }], 'month', '2026-08-31') === 'Aug',
    retentionPointLabel(rows[0].series, 'week', '2026-09-02'));
  check('period rule: 120 days weekly, 121 monthly', retentionPeriodFor({ start: '2026-05-22', end: '2026-09-18' }) === 'week' && retentionPeriodFor({ start: '2026-05-21', end: '2026-09-18' }) === 'month');
}

console.log('demo dataset');
{
  const first = demoPatientRetention(DEFAULT_DATE_RANGE);
  const second = demoPatientRetention({ ...DEFAULT_DATE_RANGE });
  check('byte-stable for the same range', JSON.stringify(first) === JSON.stringify(second));
  check('anchored: as-of is the demo date, never the clock', first.asOf.startsWith(DEMO_TODAY_KEY) && DEFAULT_DATE_RANGE.end === DEMO_TODAY_KEY);
  const net = first.network.counts!;
  check('632 onboarded patients partition the network at the anchor', net.onboarded === 632 && first.offices.reduce((s, o) => s + (o.counts?.onboarded ?? 0), 0) === 632);
  const sum = (key: 'active' | 'buying' | 'inactive') => first.offices.reduce((s, o) => s + (o.counts?.[key] ?? 0), 0);
  check('office active/buying/inactive sum exactly to the network', sum('active') === net.active && sum('buying') === net.buying && sum('inactive') === net.inactive);
  check('every patient is active or inactive, never both, everywhere', first.offices.every((o) => o.counts!.active + o.counts!.inactive === o.counts!.onboarded && o.series.every((p) => p.active + p.inactive === p.onboarded)) && net.active + net.inactive === net.onboarded);
  check('tiers sum to inactive for every office and the network', first.offices.every((o) => { const t = o.counts!.inactiveTiers; return t.days30to60 + t.days60to90 + t.days90plus === o.counts!.inactive; })
    && net.inactiveTiers.days30to60 + net.inactiveTiers.days60to90 + net.inactiveTiers.days90plus === net.inactive);
  check('buying ≤ onboarded, active ≤ onboarded on every point', first.offices.every((o) => o.series.every((p) => p.buying <= p.onboarded && p.active <= p.onboarded)));
  const usage = demoAppUsage(DEFAULT_DATE_RANGE);
  check('active at the anchor equals the App usage monthly active per office (the two pages agree)',
    first.offices.every((o) => o.counts!.active === usage.offices.find((u) => u.providerId === o.providerId)!.metrics!.monthlyActive) && net.active === usage.network.monthlyActive,
    `${first.offices.map((o) => o.counts!.active).join()} vs ${usage.offices.map((u) => u.metrics!.monthlyActive).join()}`);
  check('the story is believable: 70–90% active, 40–70% buying network-wide', net.activePct! >= 70 && net.activePct! <= 90 && net.buyingPct! >= 40 && net.buyingPct! <= 70, `${net.activePct}% / ${net.buyingPct}%`);
  check('default 30-day range is weekly with the last point on the range end',
    first.period === 'week' && first.network.series.length === retentionPeriodWindows(DEFAULT_DATE_RANGE).length && first.network.series.at(-1)!.periodEnd === DEFAULT_DATE_RANGE.end
      && first.network.series.at(-1)!.onboarded === 632);
  check('network series sums the office series period by period',
    first.network.series.every((point) => point.active === first.offices.reduce((s, o) => s + (o.series.find((p) => p.periodEnd === point.periodEnd)?.active ?? 0), 0)));
  check('onboarding grows over time (never shrinks before the anchor)', first.offices.every((o) => o.series.every((p, i, arr) => i === 0 || p.onboarded >= arr[i - 1].onboarded)));
  const long = demoPatientRetention({ start: '2026-01-01', end: DEMO_TODAY_KEY });
  check('a long range switches to months; Kim (first patient Mar 2) has no January/February points',
    long.period === 'month' && long.offices[3].series[0].periodEnd === '2026-03-31' && long.offices[0].series[0].periodEnd === '2026-01-31' && long.network.series[0].periodEnd === '2026-01-31',
    long.offices.map((o) => o.series[0]?.periodEnd).join());
  check('young offices carry no 90+ tier before they are 90 days old',
    demoPatientRetention({ start: '2026-04-01', end: '2026-04-30' }).offices[3].counts!.inactiveTiers.days90plus === 0);
  const early = demoPatientRetention({ start: '2025-11-01', end: '2025-11-30' });
  check('a range before an office\'s first patient marks it unavailable (not zero)',
    early.offices.filter((o) => !o.available).length === 3 && early.offices[0].available && early.offices[0].counts!.onboarded > 0 && early.offices[1].counts === null && early.offices[1].series.length === 0);
  const none = demoPatientRetention({ start: '2025-09-01', end: '2025-09-30' });
  check('a range before every office → network unavailable, null counts, empty series', none.network.available === false && none.network.counts === null && none.network.series.length === 0);
  const narrowed = demoPatientRetention(DEFAULT_DATE_RANGE, 'acct-p2');
  check('narrowing to one office: one row, network mirrors it, office named',
    narrowed.offices.length === 1 && narrowed.office?.name === 'Chen Metabolic Health' && JSON.stringify(narrowed.network.counts) === JSON.stringify(narrowed.offices[0].counts)
      && JSON.stringify(narrowed.network.counts) === JSON.stringify(first.offices[1].counts));
  check('demo offices keep the seeded account ids', first.offices.map((o) => o.providerId).join() === 'acct-p1,acct-p2,acct-p3,acct-p4' && DEMO_RETENTION_OFFICES.length === 4);
}

console.log('permissions');
{
  check('/admin/patient-retention maps to the overview (analytics) permission', permissionForAdminPath('/admin/patient-retention') === 'overview');
  check('Admin and Super Admin may open it', canHq('Admin', 'overview') && canHq('Super Admin', 'overview'));
  check('Support, Content and Clinical may not', !canHq('Support', 'overview') && !canHq('Content', 'overview') && !canHq('Clinical', 'overview'));
}

// ─── Rendered page ───────────────────────────────────────────────────────────

const LIVE_ROWS: PatientRetentionOfficeRow[] = [
  row('office-a', 'Harbor Clinic', counts({ onboarded: 120, active: 98, buying: 61, inactive: 22, activePct: 81.7, buyingPct: 50.8, inactiveTiers: { days30to60: 12, days60to90: 6, days90plus: 4 } }), { firstOnboardedDate: '2026-03-01' }),
  row('office-b', 'Summit Health', counts({ onboarded: 80, active: 66, buying: 47, inactive: 14, activePct: 82.5, buyingPct: 58.8, inactiveTiers: { days30to60: 8, days60to90: 4, days90plus: 2 } }), { firstOnboardedDate: '2026-04-15' }),
  row('office-c', 'Newest Office', null, { firstOnboardedDate: '2027-01-02' }),
];
const LIVE_NETWORK = counts({ onboarded: 200, active: 164, buying: 108, inactive: 36, activePct: 82, buyingPct: 54, inactiveTiers: { days30to60: 20, days60to90: 10, days90plus: 6 } });
function liveResult(start: string, end: string, office: string | null, overrides: Partial<PatientRetentionResult['network']> = {}): PatientRetentionResult {
  const offices = office ? LIVE_ROWS.filter((r) => r.providerId === office) : LIVE_ROWS;
  const network = office
    ? { firstOnboardedDate: offices[0]?.firstOnboardedDate ?? null, available: offices[0]?.available ?? false, counts: offices[0]?.counts ?? null, series: offices[0]?.series ?? [] }
    : { firstOnboardedDate: '2026-03-01', available: true, counts: LIVE_NETWORK, series: [
        { periodStart: '2026-08-20', periodEnd: '2026-08-26', onboarded: 180, active: 150, buying: 90, inactive: 30 },
        { periodStart: '2026-08-27', periodEnd: '2026-09-02', onboarded: 200, active: 164, buying: 108, inactive: 36 },
      ] };
  return {
    range: { start, end }, asOf: new Date().toISOString(), period: 'week',
    office: office ? { id: office, name: offices[0]?.officeName ?? office } : null,
    network: { ...network, ...overrides },
    offices,
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
    if (status !== 200) return json({ error: 'Could not load patient retention right now.' }, status);
    const params = new URL(url, 'http://test.local').searchParams;
    return json(liveResult(params.get('start') ?? '', params.get('end') ?? '', params.get('office'), overrides));
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

async function mount(path: string) {
  const location = memoryLocation({ path, record: true });
  const currentUrl = () => location.history[location.history.length - 1];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DateRangeProvider>
          <Router hook={location.hook}>
            <Route path="/admin/patient-retention"><PatientRetention /></Route>
          </Router>
        </DateRangeProvider>
      </QueryClientProvider>,
    );
  });
  return { renderer: renderer!, client, currentUrl, unmount: async () => { await act(async () => { renderer!.unmount(); }); client.clear(); } };
}

console.log('demo page');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  __setHqData({ accounts: [] });
  requests.length = 0;
  const { renderer, currentUrl, unmount } = await mount('/admin/patient-retention');
  await settle();
  const root = renderer.root;
  const expected = demoPatientRetention(DEFAULT_DATE_RANGE);
  const net = expected.network.counts!;
  check('demo page makes no request', requests.length === 0, requests.join('\n'));
  check('demo tiles show the seeded network figures',
    textOf(byTestId(root, 'text-retention-onboarded')[0]) === '632' && textOf(byTestId(root, 'text-retention-active')[0]) === fmt(net.active)
      && textOf(byTestId(root, 'text-retention-buying')[0]) === fmt(net.buying) && textOf(byTestId(root, 'text-retention-inactive')[0]) === fmt(net.inactive));
  check('tile details carry the share of onboarded', JSON.stringify(renderer.toJSON()).includes(`${Math.round(net.activePct!)}% of onboarded`));
  check('demo header is anchored to the demo date and scoped to all practices',
    textOf(byTestId(root, 'text-retention-asof')[0]).includes('2026') && textOf(byTestId(root, 'text-retention-updated')[0]) === 'Demo figures' && textOf(byTestId(root, 'text-retention-scope')[0]) === 'All practices');
  check('demo table lists the four seeded offices, all available, sorted by onboarded desc',
    byTestId(root, 'table-patient-retention').length === 1 && rowIds(root).join() === 'acct-p3,acct-p2,acct-p1,acct-p4' && byTestId(root, 'text-retention-unavailable-note').length === 0, rowIds(root).join());
  check('total row equals the network counts', textOf(byTestId(root, 'retention-total-onboarded')[0]) === '632' && textOf(byTestId(root, 'retention-total-active')[0]) === fmt(net.active)
    && textOf(byTestId(root, 'retention-total-activePct')[0]) === `${Math.round(net.activePct!)}%`);
  check('Jenkins active cell equals its App usage monthly active', textOf(byTestId(root, 'retention-cell-active-acct-p1')[0]) === fmt(demoAppUsage(DEFAULT_DATE_RANGE).offices[0].metrics!.monthlyActive));
  const chartFigure = byTestId(root, 'chart-patient-retention')[0];
  const spoken = chartFigure?.findAll((n) => n.props.role === 'img' && typeof n.props['aria-label'] === 'string')[0]?.props['aria-label'] as string | undefined;
  check('trend chart renders the four series with a spoken summary', !!spoken && ['Onboarded', 'Active', 'Buying', 'Inactive'].every((label) => spoken!.includes(label)), spoken);
  check('inactive tiers list the three bands summing to the inactive tile',
    byTestId(root, 'list-retention-tiers').length === 1
      && ['days30to60', 'days60to90', 'days90plus'].reduce((s, key) => s + Number(textOf(byTestId(root, `retention-tier-value-${key}`)[0]).replace(/,/g, '')), 0) === net.inactive);
  check('definitions are on the page', byTestId(root, 'text-retention-definitions').length === 1 && textOf(byTestId(root, 'text-retention-definitions')[0]).includes('never both'));
  check('no office banner at rest', byTestId(root, 'banner-retention-office').length === 0);

  // Sorting by buying share reorders; header aria-sort follows.
  await act(async () => { byTestId(root, 'sort-retention-buyingPct')[0].props.onClick(); });
  const byBuying = [...expected.offices].sort((a, b) => b.counts!.buyingPct! - a.counts!.buyingPct!).map((o) => o.providerId).join();
  check('sorting by buying share reorders the rows', rowIds(root).join() === byBuying, rowIds(root).join());

  // Choosing a practice narrows the page through the URL.
  await act(async () => { byTestId(root, 'button-retention-office-acct-p2')[0].props.onClick(); });
  await settle(2);
  const narrowed = demoPatientRetention(DEFAULT_DATE_RANGE, 'acct-p2');
  check('choosing a practice writes ?office= and narrows tiles, scope and table', currentUrl().includes('office=acct-p2')
    && textOf(byTestId(root, 'text-retention-onboarded')[0]) === fmt(narrowed.network.counts!.onboarded) && textOf(byTestId(root, 'text-retention-scope')[0]) === 'Chen Metabolic Health'
    && rowIds(root).join() === 'acct-p2' && byTestId(root, 'banner-retention-office').length === 1 && byTestId(root, 'button-retention-office-acct-p2')[0].props['aria-pressed'] === true,
    `${currentUrl()} | ${rowIds(root).join()}`);
  check('demo narrowing still makes no request', requests.length === 0);
  await act(async () => { byTestId(root, 'button-retention-all-practices')[0].props.onClick(); });
  await settle(2);
  check('"Show all practices" clears the office and restores the four rows', !currentUrl().includes('office=') && rowIds(root).length === 4 && byTestId(root, 'banner-retention-office').length === 0);
  await unmount();

  const stale = await mount('/admin/patient-retention?office=acct-nope');
  await settle();
  check('an unknown seeded office in the URL falls back to all practices', rowIds(stale.renderer.root).length === 4 && byTestId(stale.renderer.root, 'banner-retention-office').length === 0);
  await stale.unmount();
}

console.log('live page');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1', displayName: 'Ada Admin' }, hqRole: 'Admin' });
  __setSupabaseSession('token');
  requests.length = 0;
  hold = () => {};
  const { renderer, client, currentUrl, unmount } = await mount('/admin/patient-retention');
  await settle(2);
  const root = renderer.root;
  check('loading: tiles show — and the chart/table/tiers show loading copy (no seeded numbers)',
    textOf(byTestId(root, 'text-retention-onboarded')[0]) === '—' && byTestId(root, 'text-retention-chart-loading').length === 1
      && byTestId(root, 'text-retention-table-loading').length === 1 && byTestId(root, 'text-retention-tiers-loading').length === 1
      && byTestId(root, 'table-patient-retention').length === 0 && byTestId(root, 'text-retention-updated').length === 0);
  const release = hold; hold = null; release();
  await settle();
  check('one live request with the shared range and no office', retentionRequests().length === 1 && /GET \/api\/hq\/patient-retention\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}$/.test(retentionRequests()[0]), requests.join('\n'));
  check('ready: network tiles with shares',
    textOf(byTestId(root, 'text-retention-onboarded')[0]) === '200' && textOf(byTestId(root, 'text-retention-active')[0]) === '164'
      && textOf(byTestId(root, 'text-retention-buying')[0]) === '108' && textOf(byTestId(root, 'text-retention-inactive')[0]) === '36'
      && JSON.stringify(renderer.toJSON()).includes('82% of onboarded') && JSON.stringify(renderer.toJSON()).includes('54% of onboarded') && JSON.stringify(renderer.toJSON()).includes('18% of onboarded'));
  check('header shows when the data last landed', /^Updated \d{1,2}:\d{2}:\d{2} (AM|PM)$/.test(textOf(byTestId(root, 'text-retention-updated')[0])), textOf(byTestId(root, 'text-retention-updated')[0]));
  check('chart renders', byTestId(root, 'chart-patient-retention').length === 1);
  check('table: unavailable office chip + note; available rows carry figures; total row = network',
    byTestId(root, 'text-retention-unavailable-office-c').length === 1
      && textOf(byTestId(root, 'text-retention-unavailable-note')[0]) === '1 of 3 offices have no onboarded patient in this range and are shown as unavailable.'
      && textOf(byTestId(root, 'retention-cell-onboarded-office-a')[0]) === '120' && textOf(byTestId(root, 'retention-cell-buyingPct-office-b')[0]) === '59%'
      && textOf(byTestId(root, 'retention-total-onboarded')[0]) === '200' && textOf(byTestId(root, 'retention-total-buyingPct')[0]) === '54%'
      && rowIds(root).join() === 'office-a,office-b,office-c');
  check('inactive tiers show the live breakdown', textOf(byTestId(root, 'retention-tier-value-days30to60')[0]) === '20' && textOf(byTestId(root, 'retention-tier-value-days90plus')[0]) === '6');
  const query = client.getQueryCache().findAll().find((q) => JSON.stringify(q.queryKey).includes('/api/hq/patient-retention'));
  check('query key is identity-scoped', JSON.stringify(query?.queryKey).includes('"hq-1"'), JSON.stringify(query?.queryKey));

  // Narrowing to an office issues a new request with office= and the tiles follow.
  await act(async () => { byTestId(root, 'button-retention-office-office-b')[0].props.onClick(); });
  await settle();
  check('choosing a practice requests office= and narrows the page', currentUrl().includes('office=office-b')
    && retentionRequests().some((r) => r.includes('office=office-b')) && textOf(byTestId(root, 'text-retention-onboarded')[0]) === '80'
    && textOf(byTestId(root, 'text-retention-office-name')[0]) === 'Summit Health' && rowIds(root).join() === 'office-b', `${currentUrl()} | ${requests.join('\n')}`);
  await unmount();
}

console.log('live page — no onboarded patient in range');
{
  requests.length = 0;
  overrides = { available: false, counts: null, series: [] };
  const { renderer, unmount } = await mount('/admin/patient-retention');
  await settle();
  const root = renderer.root;
  check('tiles read — with "Unavailable for this range"; chart and tiers say unavailable, not zero',
    textOf(byTestId(root, 'text-retention-onboarded')[0]) === '—' && JSON.stringify(renderer.toJSON()).includes('Unavailable for this range')
      && byTestId(root, 'text-retention-chart-unavailable').length === 1 && byTestId(root, 'text-retention-tiers-unavailable').length === 1
      && textOf(byTestId(root, 'retention-total-onboarded')[0]) === '—');
  overrides = {};
  await unmount();
}

console.log('live page — failure');
{
  requests.length = 0;
  status = 502;
  const { renderer, unmount } = await mount('/admin/patient-retention');
  // The page retries once (retry: 1) before reporting, so wait out the retry delay.
  await settle();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });
  await settle();
  const root = renderer.root;
  check('the failed read was retried exactly once before reporting', retentionRequests().length === 2, String(retentionRequests().length));
  check('a 502 renders Error tiles and the error notices (never zeros)',
    textOf(byTestId(root, 'text-retention-onboarded')[0]) === 'Error' && textOf(byTestId(root, 'text-retention-inactive')[0]) === 'Error'
      && byTestId(root, 'text-retention-chart-error').length === 1 && byTestId(root, 'text-retention-table-error').length === 1 && byTestId(root, 'text-retention-tiers-error').length === 1
      && byTestId(root, 'table-patient-retention').length === 0 && !JSON.stringify(renderer.toJSON()).includes('"0"'));
  const before = retentionRequests().length;
  status = 200;
  const retry = byTestId(root, 'text-retention-chart-error')[0].findAll((n) => n.type === 'button')[0];
  await act(async () => { retry.props.onClick(); });
  await settle();
  check('Try again refetches and recovers', retentionRequests().length > before && textOf(byTestId(root, 'text-retention-onboarded')[0]) === '200');
  await unmount();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall patient retention checks passed');
