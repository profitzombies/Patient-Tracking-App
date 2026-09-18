/**
 * HQ App usage — rules + page states.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:app-usage
 *
 * Pure half (src/lib/app-usage.ts + src/data/hq/app-usage-demo.ts):
 *   - sorting: unavailable offices always sink, null shares sink within a
 *     direction, ties break on office name, asc/desc honoured;
 *   - ranking: 1 = highest, ties share a rank, unavailable offices unranked;
 *   - formatting: unavailable is "—" (never 0), shares carry "%", counts group;
 *   - the seeded demo partitions exactly (office figures sum to the network
 *     figures, 632 activated patients), is a pure function of the range
 *     (byte-stable across calls), and honours "available since first patient".
 *
 * Rendered half (REAL pages under react-test-renderer; session / HQ
 * directory / supabase contexts stubbed via tsconfig.system-health.json,
 * global fetch scripted):
 *   - demo persona: the page and the overview tiles show the seeded figures
 *     and make NO request;
 *   - signed-in HQ: loading state first (no seeded numbers), then the live
 *     tiles with shares, the "Updated …" stamp, the trend chart, the
 *     per-practice table with the unavailable office chip + note, office
 *     links to the account page, 30-second polling on an identity-scoped key;
 *   - a range with no activated patient shows the unavailable notice, not 0;
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
import type { AppUsageOfficeRow, AppUsageResult } from '@workspace/api-client-react';
import { __setSession } from './a11y-stubs/session';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { DateRangeProvider } from '../src/contexts/date-range';
import AppUsage from '../src/pages/admin/AppUsage';
import HqOverview from '../src/pages/admin/HqOverview';
import { canHq, permissionForAdminPath } from '../src/data/hq/team';
import { DEFAULT_DATE_RANGE, DEMO_TODAY_KEY } from '../src/lib/date-range-keys';
import { DEMO_APP_USAGE_OFFICES, demoAppUsage } from '../src/data/hq/app-usage-demo';
import {
  APP_USAGE_COLUMNS,
  APP_USAGE_REFRESH_MS,
  DEFAULT_APP_USAGE_SORT,
  countUnavailable,
  formatUpdatedAt,
  formatUsageMetric,
  rankAppUsageRows,
  shareDetail,
  sharePercent,
  sortAppUsageRows,
  usageChartSeries,
  usageUnavailableReason,
} from '../src/lib/app-usage';

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

// ─── Pure rules ──────────────────────────────────────────────────────────────

const row = (id: string, name: string, metrics: Partial<NonNullable<AppUsageOfficeRow['metrics']>> | null, extra: Partial<AppUsageOfficeRow> = {}): AppUsageOfficeRow => ({
  providerId: id,
  officeName: name,
  providerName: `${name} lead`,
  firstPatientDate: metrics ? '2026-01-05' : '2026-12-01',
  available: metrics !== null,
  metrics: metrics
    ? { activatedPatients: 100, weeklyActive: 40, monthlyActive: 70, weeklySharePct: 40, monthlySharePct: 70, ...metrics }
    : null,
  series: metrics ? [{ date: '2026-09-01', weeklyActive: 30, monthlyActive: 60 }, { date: '2026-09-02', weeklyActive: metrics.weeklyActive ?? 40, monthlyActive: metrics.monthlyActive ?? 70 }] : [],
  ...extra,
});

console.log('rules');
{
  const rows = [
    row('a', 'Alpha', { weeklyActive: 40 }),
    row('b', 'Bravo', { weeklyActive: 55, weeklySharePct: null, activatedPatients: 0 }),
    row('c', 'Charlie', { weeklyActive: 40 }),
    row('z', 'Zulu', null),
  ];
  const desc = sortAppUsageRows(rows, DEFAULT_APP_USAGE_SORT).map((r) => r.providerId);
  check('default sort: weekly desc, ties by name, unavailable last', desc.join() === 'b,a,c,z', desc.join());
  const asc = sortAppUsageRows(rows, { key: 'weeklyActive', direction: 'asc' }).map((r) => r.providerId);
  check('asc sort keeps unavailable last', asc.join() === 'a,c,b,z', asc.join());
  const byShare = sortAppUsageRows(rows, { key: 'weeklySharePct', direction: 'desc' }).map((r) => r.providerId);
  check('null share sinks within available rows', byShare.join() === 'a,c,b,z', byShare.join());
  const byName = sortAppUsageRows(rows, { key: 'officeName', direction: 'desc' }).map((r) => r.providerId);
  check('name sort desc still sinks unavailable', byName.join() === 'c,b,a,z', byName.join());

  const ranks = rankAppUsageRows(rows, 'weeklyActive');
  check('rank: 1 = highest, ties share, unavailable unranked',
    ranks.get('b') === 1 && ranks.get('a') === 2 && ranks.get('c') === 2 && ranks.get('z') === null,
    JSON.stringify([...ranks]));
  const shareRanks = rankAppUsageRows(rows, 'weeklySharePct');
  check('null share is unranked', shareRanks.get('b') === null && shareRanks.get('a') === 1);

  check('format: unavailable is "—", counts group, shares carry %',
    formatUsageMetric('weeklyActive', null) === '—' && formatUsageMetric('monthlyActive', 1234) === '1,234' && formatUsageMetric('weeklySharePct', 62.4) === '62%');
  check('sharePercent: no denominator → null, else rounded', sharePercent(5, 0) === null && sharePercent(1, 3) === 33);
  check('shareDetail copy', shareDetail(31, 632) === '31% of 632 activated patients' && shareDetail(null, 0) === 'No activated patients yet' && shareDetail(null, 4) === 'Share unavailable');
  check('columns: two counts then two shares', APP_USAGE_COLUMNS.map((c) => c.format).join() === 'count,count,percent,percent');
  check('countUnavailable', countUnavailable(rows) === 1);
  check('unavailable reason names the first patient date',
    usageUnavailableReason('2026-12-01', '2026-09-30').includes('2026-12-01') && usageUnavailableReason(null, '2026-09-30').startsWith('No activated patient'));
  const chart = usageChartSeries(rows[0].series);
  check('chart series split by key', chart.dates.join() === '2026-09-01,2026-09-02' && chart.weekly.join() === '30,40' && chart.monthly.join() === '60,70');
  check('refresh interval is 30 seconds', APP_USAGE_REFRESH_MS === 30_000);
  check('updated stamp: null before first read, time-of-day once landed',
    formatUpdatedAt(undefined) === null && formatUpdatedAt(0) === null && /^Updated \d{1,2}:\d{2}:\d{2} (AM|PM)$/.test(formatUpdatedAt(Date.now())!));
  const yesterday = Date.now() - 36 * 3_600_000;
  check('updated stamp from another day carries the date', /^Updated [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2}:\d{2} (AM|PM)$/.test(formatUpdatedAt(yesterday)!), formatUpdatedAt(yesterday)!);
}

console.log('demo dataset');
{
  const first = demoAppUsage(DEFAULT_DATE_RANGE);
  const second = demoAppUsage({ ...DEFAULT_DATE_RANGE });
  check('byte-stable for the same range', JSON.stringify(first) === JSON.stringify(second));
  check('anchored: as-of is the demo date, never the clock', first.asOf.startsWith(DEMO_TODAY_KEY));
  const activated = DEMO_APP_USAGE_OFFICES.reduce((sum, office) => sum + office.patients, 0);
  check('632 activated patients partition the network', activated === 632 && first.network.activatedPatients === 632);
  const sumWeekly = first.offices.reduce((sum, office) => sum + (office.metrics?.weeklyActive ?? 0), 0);
  const sumMonthly = first.offices.reduce((sum, office) => sum + (office.metrics?.monthlyActive ?? 0), 0);
  check('office weekly/monthly sum exactly to the network figures at the anchor',
    sumWeekly === first.network.weeklyActive && sumMonthly === first.network.monthlyActive
      && sumWeekly === first.network.atRangeEnd.weeklyActive && sumMonthly === first.network.atRangeEnd.monthlyActive);
  const expectedWeekly = DEMO_APP_USAGE_OFFICES.map((office) => Math.round(office.patients * office.weeklyRatio));
  check('anchor figures are the plain ratios (Jenkins 142 × 0.63 = 89)',
    first.offices.map((office) => office.metrics!.weeklyActive).join() === expectedWeekly.join() && expectedWeekly[0] === 89,
    first.offices.map((office) => office.metrics!.weeklyActive).join());
  check('weekly ≤ monthly ≤ activated for every office and every day',
    first.offices.every((office) => office.series.every((p) => p.weeklyActive <= p.monthlyActive && p.monthlyActive <= office.metrics!.activatedPatients)));
  check('network series sums the office series day by day',
    first.network.series.length === 30 && first.network.series.every((point) =>
      point.weeklyActive === first.offices.reduce((sum, office) => sum + (office.series.find((p) => p.date === point.date)?.weeklyActive ?? 0), 0)));
  check('now tiles carry fixed shares of activated patients',
    first.network.activeNow === Math.round(632 * 0.04) && first.network.activeToday === Math.round(632 * 0.31)
      && first.network.activeNowSharePct === 4 && first.network.activeTodaySharePct === 31);
  const early = demoAppUsage({ start: '2025-11-01', end: '2025-11-30' });
  check('a range before an office\'s first patient marks it unavailable (not zero)',
    early.offices.filter((office) => !office.available).length === 3 && early.offices[0].available && early.offices[0].metrics!.weeklyActive > 0
      && early.offices[1].metrics === null && early.offices[1].series.length === 0);
  check('now tiles stay anchored regardless of the range', early.network.weeklyActive === first.network.weeklyActive && early.network.atRangeEnd.weeklyActive < first.network.atRangeEnd.weeklyActive);
  const none = demoAppUsage({ start: '2025-09-01', end: '2025-09-30' });
  check('a range before every office → network unavailable, empty series', none.network.available === false && none.network.series.length === 0 && none.network.atRangeEnd.activatedPatients === 0);
  check('demo offices keep the seeded account ids', first.offices.map((o) => o.providerId).join() === 'acct-p1,acct-p2,acct-p3,acct-p4');
}

console.log('permissions');
{
  check('/admin/app-usage maps to the overview (analytics) permission', permissionForAdminPath('/admin/app-usage') === 'overview');
  check('Admin and Super Admin may open it', canHq('Admin', 'overview') && canHq('Super Admin', 'overview'));
  check('Support, Content and Clinical may not', !canHq('Support', 'overview') && !canHq('Content', 'overview') && !canHq('Clinical', 'overview'));
}

// ─── Rendered pages ──────────────────────────────────────────────────────────

const LIVE_ROWS: AppUsageOfficeRow[] = [
  row('office-a', 'Harbor Clinic', { activatedPatients: 120, weeklyActive: 61, monthlyActive: 98, weeklySharePct: 51, monthlySharePct: 82 }, { firstPatientDate: '2026-03-01' }),
  row('office-b', 'Summit Health', { activatedPatients: 80, weeklyActive: 47, monthlyActive: 66, weeklySharePct: 59, monthlySharePct: 83 }, { firstPatientDate: '2026-04-15' }),
  row('office-c', 'Newest Office', null, { firstPatientDate: '2027-01-02' }),
];
function liveResult(rangeStart: string, rangeEnd: string, overrides: Partial<AppUsageResult['network']> = {}): AppUsageResult {
  return {
    range: { start: rangeStart, end: rangeEnd },
    asOf: new Date().toISOString(),
    network: {
      firstPatientDate: '2026-03-01',
      available: true,
      activatedPatients: 200,
      activeNow: 7,
      activeToday: 63,
      weeklyActive: 108,
      monthlyActive: 164,
      activeNowSharePct: 4,
      activeTodaySharePct: 32,
      weeklySharePct: 54,
      monthlySharePct: 82,
      atRangeEnd: { activatedPatients: 200, weeklyActive: 108, monthlyActive: 164, weeklySharePct: 54, monthlySharePct: 82 },
      series: [
        { date: '2026-09-01', weeklyActive: 90, monthlyActive: 150 },
        { date: '2026-09-02', weeklyActive: 108, monthlyActive: 164 },
      ],
      ...overrides,
    },
    offices: LIVE_ROWS,
  };
}

const requests: string[] = [];
let usageStatus = 200;
let usageOverrides: Partial<AppUsageResult['network']> = {};
let holdUsage: (() => void) | null = null;
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url}`);
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/api/hq/app-usage')) {
    if (holdUsage) await new Promise<void>((resolve) => { holdUsage = resolve; });
    if (usageStatus !== 200) return json({ error: 'App usage is unavailable right now.' }, usageStatus);
    const params = new URL(url, 'http://test.local').searchParams;
    return json(liveResult(params.get('start') ?? '', params.get('end') ?? '', usageOverrides));
  }
  if (url.includes('/api/hq/office-comparison')) return json({ range: { start: '', end: '' }, asOf: new Date().toISOString(), offices: [] });
  if (url.includes('/api/hq/overview')) return json({ error: 'not in this suite' }, 500);
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

console.log('demo page');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  __setHqData({ accounts: [] });
  requests.length = 0;
  const { renderer, unmount } = await mount(AppUsage, '/admin/app-usage');
  await settle();
  const root = renderer.root;
  const expected = demoAppUsage(DEFAULT_DATE_RANGE);
  check('demo page makes no request', requests.length === 0, requests.join('\n'));
  check('demo tiles show the seeded network figures',
    textOf(byTestId(root, 'text-usage-weekly')[0]) === expected.network.weeklyActive.toLocaleString('en-US')
      && textOf(byTestId(root, 'text-usage-monthly')[0]) === expected.network.monthlyActive.toLocaleString('en-US')
      && textOf(byTestId(root, 'text-usage-active-now')[0]) === String(expected.network.activeNow)
      && textOf(byTestId(root, 'text-usage-active-today')[0]) === String(expected.network.activeToday));
  check('demo header is anchored to the demo date', textOf(byTestId(root, 'text-app-usage-asof')[0]).includes('2026') && textOf(byTestId(root, 'text-app-usage-updated')[0]) === 'Demo figures');
  check('demo table lists the four seeded offices, all available',
    byTestId(root, 'table-app-usage').length === 1 && root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('row-app-usage-')).length === 4
      && byTestId(root, 'text-app-usage-unavailable-note').length === 0);
  const link = byTestId(root, 'link-usage-office-acct-p1')[0];
  check('office name links to the account page', link?.props.href === '/admin/accounts/acct-p1');
  const chartFigure = byTestId(root, 'chart-app-usage')[0];
  const spoken = chartFigure?.findAll((n) => n.props.role === 'img' && typeof n.props['aria-label'] === 'string')[0]?.props['aria-label'] as string | undefined;
  check('trend chart renders with a spoken summary', byTestId(root, 'chart-app-usage').length === 1 && !!spoken && spoken.includes('Weekly active') && spoken.includes('Monthly active'), spoken);
  const cell = byTestId(root, 'usage-cell-weeklyActive-acct-p1')[0];
  check('Jenkins weekly cell reads 89', textOf(cell) === '89', textOf(cell));
  await unmount();
}

console.log('demo overview tiles');
{
  requests.length = 0;
  const { renderer, unmount } = await mount(HqOverview, '/admin');
  await settle();
  const root = renderer.root;
  const expected = demoAppUsage(DEFAULT_DATE_RANGE).network;
  const weekly = byTestId(root, 'text-hq-weekly-active')[0];
  const monthly = byTestId(root, 'text-hq-monthly-active')[0];
  check('demo overview makes no request', requests.length === 0, requests.join('\n'));
  check('overview tiles carry the seeded weekly/monthly figures and link to the page',
    weekly?.props.href === '/admin/app-usage' && monthly?.props.href === '/admin/app-usage'
      && textOf(weekly).includes(expected.weeklyActive.toLocaleString('en-US')) && textOf(monthly).includes(expected.monthlyActive.toLocaleString('en-US'))
      && textOf(weekly).includes(`of ${expected.activatedPatients} activated patients`));
  await unmount();
}

console.log('live page');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1', displayName: 'Ada Admin' }, hqRole: 'Admin' });
  __setSupabaseSession('token');
  requests.length = 0;
  holdUsage = () => {};
  const { renderer, client, unmount } = await mount(AppUsage, '/admin/app-usage');
  await settle(2);
  const root = renderer.root;
  check('loading: tiles show — and the chart/table show loading copy (no seeded numbers)',
    textOf(byTestId(root, 'text-usage-weekly')[0]) === '—' && byTestId(root, 'text-app-usage-chart-loading').length === 1
      && byTestId(root, 'text-app-usage-table-loading').length === 1 && byTestId(root, 'table-app-usage').length === 0
      && byTestId(root, 'text-app-usage-updated').length === 0);
  const release = holdUsage; holdUsage = null; release();
  await settle();
  check('one live request with the shared range', requests.length === 1 && /GET \/api\/hq\/app-usage\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}$/.test(requests[0]), requests.join('\n'));
  check('ready: network tiles with shares',
    textOf(byTestId(root, 'text-usage-active-now')[0]) === '7' && textOf(byTestId(root, 'text-usage-active-today')[0]) === '63'
      && textOf(byTestId(root, 'text-usage-weekly')[0]) === '108' && textOf(byTestId(root, 'text-usage-monthly')[0]) === '164'
      && JSON.stringify(renderer.toJSON()).includes('54% of 200 activated patients'));
  check('header shows when the data last landed', /^Updated \d{1,2}:\d{2}:\d{2} (AM|PM)$/.test(textOf(byTestId(root, 'text-app-usage-updated')[0])), textOf(byTestId(root, 'text-app-usage-updated')[0]));
  check('chart renders the two rolling series', byTestId(root, 'chart-app-usage').length === 1);
  check('table: unavailable office chip + note; available rows carry figures',
    byTestId(root, 'text-usage-unavailable-office-c').length === 1
      && textOf(byTestId(root, 'text-app-usage-unavailable-note')[0]) === '1 of 3 offices have no data in this range and are shown as unavailable.'
      && textOf(byTestId(root, 'usage-cell-weeklyActive-office-a')[0]) === '61' && textOf(byTestId(root, 'usage-cell-monthlySharePct-office-b')[0]) === '83%'
      && textOf(byTestId(root, 'usage-sparkline-office-c')[0]) === '—');
  check('rank follows weekly active; unavailable is unranked',
    textOf(byTestId(root, 'usage-rank-office-a')[0]) === '1' && textOf(byTestId(root, 'usage-rank-office-b')[0]) === '2' && textOf(byTestId(root, 'usage-rank-office-c')[0]) === '—');
  check('office rows link to the account page', byTestId(root, 'link-usage-office-office-a')[0]?.props.href === '/admin/accounts/office-a');
  const query = client.getQueryCache().findAll().find((q) => JSON.stringify(q.queryKey).includes('/api/hq/app-usage'));
  const observer = query?.observers[0] as { options?: { refetchInterval?: number } } | undefined;
  check('polls every 30 seconds on an identity-scoped key',
    observer?.options?.refetchInterval === 30_000 && JSON.stringify(query?.queryKey).includes('"hq-1"'), JSON.stringify(query?.queryKey));

  // Sorting by monthly share re-ranks; unavailable still last.
  await act(async () => { byTestId(root, 'sort-usage-monthlySharePct')[0].props.onClick(); });
  const order = root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('row-app-usage-')).map((n) => n.props['data-testid']);
  check('sorting by monthly share reorders and keeps unavailable last', order.join() === 'row-app-usage-office-b,row-app-usage-office-a,row-app-usage-office-c'
    && textOf(byTestId(root, 'usage-rank-office-b')[0]) === '1', order.join());
  await unmount();
}

console.log('live page — no activated patient in range');
{
  requests.length = 0;
  usageOverrides = { available: false, series: [], atRangeEnd: { activatedPatients: 0, weeklyActive: 0, monthlyActive: 0, weeklySharePct: null, monthlySharePct: null } };
  const { renderer, unmount } = await mount(AppUsage, '/admin/app-usage');
  await settle();
  check('chart area says unavailable, not zero', byTestId(renderer.root, 'text-app-usage-chart-unavailable').length === 1 && byTestId(renderer.root, 'chart-app-usage').length === 0);
  usageOverrides = {};
  await unmount();
}

console.log('live page — failure');
{
  requests.length = 0;
  usageStatus = 502;
  const { renderer, unmount } = await mount(AppUsage, '/admin/app-usage');
  // The page retries once (retry: 1) before reporting, so wait out the retry delay.
  await settle();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });
  await settle();
  const root = renderer.root;
  check('the failed read was retried exactly once before reporting', requests.length === 2, String(requests.length));
  const alerts = root.findAll((n) => n.props.role === 'alert' && typeof n.type === 'string');
  check('a 502 renders error notices and Error tiles, never seeded figures',
    alerts.length === 2 && textOf(byTestId(root, 'text-usage-weekly')[0]) === 'Error' && byTestId(root, 'table-app-usage').length === 0
      && JSON.stringify(renderer.toJSON()).includes('Failed to load'));
  usageStatus = 200;
  const before = requests.length;
  const retry = byTestId(root, 'text-app-usage-chart-error')[0].findAll((n) => n.type === 'button')[0];
  await act(async () => { retry.props.onClick(); });
  await settle();
  check('Try again refetches and recovers', requests.length === before + 1 && textOf(byTestId(root, 'text-usage-weekly')[0]) === '108' && byTestId(root, 'table-app-usage').length === 1);
  await unmount();
}

console.log('live overview tiles');
{
  requests.length = 0;
  const { renderer, unmount } = await mount(HqOverview, '/admin');
  await settle();
  const root = renderer.root;
  const weekly = byTestId(root, 'text-hq-weekly-active')[0];
  const monthly = byTestId(root, 'text-hq-monthly-active')[0];
  check('live overview asks for app usage', requests.some((r) => r.includes('/api/hq/app-usage')), requests.join('\n'));
  check('live overview tiles show the live figures and link to the page',
    weekly?.props.href === '/admin/app-usage' && monthly?.props.href === '/admin/app-usage'
      && textOf(weekly).includes('108') && textOf(monthly).includes('164') && textOf(weekly).includes('54% of 200 activated patients'));
  await unmount();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall app usage checks passed');
