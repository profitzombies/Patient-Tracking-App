/**
 * Office "When patients use the app" — the HQ Insights section rendered on
 * the office Analytics page, scoped to ONE practice.
 *
 * Renders the REAL Analytics page (src/pages/Analytics.tsx) under
 * react-test-renderer against a scripted global fetch and proves:
 *
 * - the standalone office demo shows the program-wide seed with NO practice
 *   selector and issues no request;
 * - the HQ demo drill-in shows the drilled-in account's own slice, byte-
 *   identical to the HQ page filtered to that practice;
 * - signed-in provider staff read /office/app-usage-insights for their own
 *   office (no office param), poll on the app-usage cadence with an
 *   identity-scoped key, and switch datasets through the chips;
 * - HQ drilling into a live office sends ?office=<providerId>;
 * - a failed read shows explicit Error tiles and a retry that refetches.
 *
 * Run: pnpm --filter @workspace/thinnr-operations run test:office-insights
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { DateRangeProvider } from '../src/contexts/date-range';
import Analytics from '../src/pages/Analytics';
import { DEFAULT_DATE_RANGE } from '../src/lib/date-range-keys';
import { demoAppUsageInsights, demoOfficeAppUsageInsights } from '../src/data/hq/app-usage-insights-demo';
import { DEFAULT_OFFICE_INSIGHTS_DATASET } from '../src/components/office/OfficeAppUsageInsights';
import { APP_USAGE_REFRESH_MS } from '../src/lib/app-usage';
import { WEEKDAY_LONG, assembleInsights, formatHourWindow, formatWindowLabel, previousRangeOf, type AppUsageInsights, type DayHourBucket, type InsightsDataset } from '@workspace/app-usage-insights';

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
g.document ??= { createElement: () => ({ click() {}, set href(_: string) {}, set download(_: string) {} }) };
g.URL.createObjectURL ??= () => 'blob:test';
g.URL.revokeObjectURL ??= () => {};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function textOf(instance: ReactTestInstance | undefined): string {
  if (!instance) return '';
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
const tiles = (root: ReactTestInstance) => ['text-insights-peak-window', 'text-insights-best-day', 'text-insights-busiest-hour', 'text-insights-weekend-share'].map((id) => textOf(byTestId(root, id)[0]));
const changes = (root: ReactTestInstance) => (byTestId(root, 'list-insights-changes')[0]?.findAll((n) => n.type === 'li') ?? []).map((li) => textOf(li));
/** The visible figures a seeded insights payload should produce (tiles + change lines). */
function expectedFrom(data: AppUsageInsights) {
  const t = data.tiles;
  return {
    tiles: [
      t.peakWindow ? formatWindowLabel(t.peakWindow) : '—',
      t.bestDay ? WEEKDAY_LONG[t.bestDay.weekday] : '—',
      t.busiestHour ? formatHourWindow(t.busiestHour.hour, t.busiestHour.hour) : '—',
      t.weekendSharePct === null ? '—' : `${t.weekendSharePct}%`,
    ],
    changes: data.changes.map((c) => c.text),
  };
}

/* ------------------------------------------------------------ scripted API */
const requests: string[] = [];
const insightsRequests = () => requests.filter((r) => r.includes('/api/office/app-usage-insights?'));
let insightsStatus = 200;
const LIVE_OFFICE = { id: 'live-4f2c9a1b0d3e', name: 'Lakeside Weight & Wellness' };
/** Live fixture: Tue 12-2pm block, a Thu 7pm spike, a day-only Saturday row; previous period half the volume. */
function liveInsights(dataset: InsightsDataset, start: string, end: string, office: string | null) {
  const range = { start, end };
  const previous = previousRangeOf(range);
  const day = (offset: number, from = start) => {
    const [y, m, d] = from.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
  };
  const current: DayHourBucket[] = [
    { day: day(1), hour: 12, events: 10, patients: 4 }, { day: day(1), hour: 13, events: 6, patients: 3 }, { day: day(1), hour: 14, events: 2, patients: 1 },
    { day: day(3), hour: 19, events: 14, patients: 7 }, { day: day(5), hour: -1, events: 8, patients: 2 },
  ];
  const prior: DayHourBucket[] = [{ day: day(1, previous.start), hour: 12, events: 20, patients: 5 }];
  return assembleInsights({
    dataset, range, asOf: new Date().toISOString(),
    office: { id: office ?? 'live-own', name: office ? LIVE_OFFICE.name : 'Own Office' },
    bounds: { firstDay: '2026-03-01', firstHourlyDay: dataset === 'food_log' || dataset === 'water_log' ? end : '2026-03-01' },
    current, previous: prior,
  });
}
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url}`);
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/api/office/app-usage-insights')) {
    if (insightsStatus !== 200) return json({ error: 'Insights are unavailable right now.' }, insightsStatus);
    const params = new URL(url, 'http://test.local').searchParams;
    return json(liveInsights(params.get('dataset') as InsightsDataset, params.get('start') ?? '', params.get('end') ?? '', params.get('office')));
  }
  // The rest of the live page (range metrics, exports list) is out of scope here: fail it loudly so
  // the insights section is proven independent of its neighbours.
  if (url.includes('/api/office/analytics') || url.includes('/api/exports')) return json({ error: 'not in this suite' }, 500);
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

/* ------------------------------------------------------------ demo, unscoped */
console.log('demo — standalone office');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  __setScope(null);
  requests.length = 0;
  const { renderer, unmount } = await mount(Analytics, '/analytics');
  await settle();
  const root = renderer.root;
  check('demo analytics page renders the synthetic deck', textOf(byTestId(root, 'text-page-title')[0]) === 'Revenue & Outcomes');
  check('demo page makes no request', requests.length === 0, requests.join('\n'));
  check('the Insights section is on the office page', byTestId(root, 'section-app-usage-insights').length === 1);
  check('no practice selector on the office version', byTestId(root, 'select-insights-office').length === 0);
  const program = demoOfficeAppUsageInsights(DEFAULT_OFFICE_INSIGHTS_DATASET, DEFAULT_DATE_RANGE, null);
  const hqAll = demoAppUsageInsights(DEFAULT_OFFICE_INSIGHTS_DATASET, DEFAULT_DATE_RANGE, null);
  check('unscoped office demo is the whole-program seed HQ shows for all practices',
    JSON.stringify(program) === JSON.stringify(hqAll) && program.office === null && program.totals.current > 0);
  const expected = expectedFrom(program);
  check('tiles show the seeded program figures', tiles(root).join('|') === expected.tiles.join('|'), `${tiles(root).join('|')} vs ${expected.tiles.join('|')}`);
  check('what-changed lines come from the shared rule engine', changes(root).join('\n') === expected.changes.join('\n'), changes(root).join('\n'));
  check('the chart caption never names a practice unscoped', !JSON.stringify(renderer.toJSON()).includes(' at Jenkins'));

  await act(async () => { byTestId(root, 'chip-insights-food_log')[0].props.onClick(); });
  await settle();
  const food = expectedFrom(demoOfficeAppUsageInsights('food_log', DEFAULT_DATE_RANGE, null));
  check('switching datasets re-seeds without a request', requests.length === 0 && tiles(root).join('|') === food.tiles.join('|'), tiles(root).join('|'));
  check('food logs show the tracked-since note', byTestId(root, 'text-insights-tracked-since').length === 1);
  await unmount();
}

/* ------------------------------------------------------------ demo, drill-in */
console.log('demo — HQ drill-in');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  const account = { id: 'acct-p1', providerId: 'p1', officeName: 'Jenkins Aesthetics & Wellness', activePatientCount: 142 };
  __setScope(account);
  requests.length = 0;
  const { renderer, unmount } = await mount(Analytics, '/admin/accounts/acct-p1/office/analytics');
  await settle();
  const root = renderer.root;
  check('drill-in demo makes no request', requests.length === 0, requests.join('\n'));
  check('still no practice selector under the drill-in', byTestId(root, 'select-insights-office').length === 0);
  const slice = demoOfficeAppUsageInsights(DEFAULT_OFFICE_INSIGHTS_DATASET, DEFAULT_DATE_RANGE, account);
  const hqSlice = demoAppUsageInsights(DEFAULT_OFFICE_INSIGHTS_DATASET, DEFAULT_DATE_RANGE, 'acct-p1');
  const program = demoOfficeAppUsageInsights(DEFAULT_OFFICE_INSIGHTS_DATASET, DEFAULT_DATE_RANGE, null);
  check('drilled-in account slice is byte-identical to the HQ page filtered to that practice',
    JSON.stringify(slice) === JSON.stringify(hqSlice) && slice.office?.name === 'Jenkins Aesthetics & Wellness');
  check('the slice is the practice, not the program', slice.totals.current < program.totals.current && slice.totals.current > 0, `${slice.totals.current} vs ${program.totals.current}`);
  const expected = expectedFrom(slice);
  check('drill-in tiles show that account\'s figures', tiles(root).join('|') === expected.tiles.join('|'), `${tiles(root).join('|')} vs ${expected.tiles.join('|')}`);
  check('drill-in what-changed names nothing but the practice figures', changes(root).join('\n') === expected.changes.join('\n'), changes(root).join('\n'));

  // A session-added account (not one of the four seeded practices) seeds from its own patient count.
  const added = { id: 'acct-new', providerId: null, officeName: 'New Practice', activePatientCount: 12 };
  const addedSlice = demoOfficeAppUsageInsights(DEFAULT_OFFICE_INSIGHTS_DATASET, DEFAULT_DATE_RANGE, added);
  check('an unseeded account gets its own small slice, never the program total',
    addedSlice.office?.id === 'acct-new' && addedSlice.totals.current < slice.totals.current, String(addedSlice.totals.current));
  await unmount();
}

/* ------------------------------------------------------------ live, own office */
console.log('live — provider staff');
{
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1', displayName: 'Pat Provider' }, hqRole: null, claimedWorkspace: { officeName: 'Own Office' } });
  __setScope(null);
  __setSupabaseSession('token');
  requests.length = 0;
  const { renderer, client, unmount } = await mount(Analytics, '/analytics');
  await settle();
  const root = renderer.root;
  check('live analytics page renders', textOf(byTestId(root, 'text-page-title')[0]) === 'Engagement & Outcomes');
  check('provider staff ask for their own office without an office param',
    insightsRequests().length === 1 && /GET \/api\/office\/app-usage-insights\?dataset=app_open&start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}$/.test(insightsRequests()[0]), requests.join('\n'));
  check('no practice selector live either', byTestId(root, 'select-insights-office').length === 0);
  const url = new URL(insightsRequests()[0].split(' ')[1], 'http://test.local');
  const expected = expectedFrom(liveInsights('app_open', url.searchParams.get('start')!, url.searchParams.get('end')!, null));
  check('live tiles reflect the served figures', tiles(root).join('|') === expected.tiles.join('|'), `${tiles(root).join('|')} vs ${expected.tiles.join('|')}`);
  check('trend line reads the served totals', changes(root)[0] === 'App opens are up 100% vs the previous 30 days (40 vs 20).', changes(root)[0]);
  check('the neighbouring range metrics failing does not touch the insights',
    requests.some((r) => r.includes('/api/office/analytics?')) && byTestId(root, 'text-insights-chart-error').length === 0 && tiles(root).every((t) => t !== 'Error'));
  const query = client.getQueryCache().findAll().find((q) => JSON.stringify(q.queryKey).includes('/api/office/app-usage-insights'));
  const observer = query?.observers[0] as { options?: { refetchInterval?: number } } | undefined;
  check('insights poll on the app-usage cadence with an identity-scoped key',
    observer?.options?.refetchInterval === APP_USAGE_REFRESH_MS && JSON.stringify(query?.queryKey).includes('"staff-1"'), JSON.stringify(query?.queryKey));

  await act(async () => { byTestId(root, 'chip-insights-weigh_in')[0].props.onClick(); });
  await settle();
  check('switching chips requests the new dataset', insightsRequests().length === 2 && insightsRequests()[1].includes('dataset=weigh_in&'), requests.join('\n'));

  insightsStatus = 500;
  await act(async () => { byTestId(root, 'chip-insights-order')[0].props.onClick(); });
  await settle();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });
  await settle();
  check('a failed read shows Error tiles and notices, never zeroes',
    tiles(root).every((t) => t === 'Error') && byTestId(root, 'text-insights-heatmap-error').length === 1 && byTestId(root, 'text-insights-chart-error').length === 1, tiles(root).join('|'));
  insightsStatus = 200;
  const before = insightsRequests().length;
  await act(async () => { byTestId(root, 'text-insights-heatmap-error')[0].findAll((n) => n.type === 'button')[0].props.onClick(); });
  await settle();
  check('Try again refetches and recovers', insightsRequests().length === before + 1 && byTestId(root, 'text-insights-heatmap-error').length === 0 && tiles(root)[1] !== 'Error', tiles(root).join('|'));
  await unmount();
}

/* ------------------------------------------------------------ live, HQ drill-in */
console.log('live — HQ drill-in');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1', displayName: 'Ada Admin' }, hqRole: 'Admin' });
  __setScope({ id: LIVE_OFFICE.id, providerId: LIVE_OFFICE.id, officeName: LIVE_OFFICE.name, activePatientCount: 40 });
  requests.length = 0;
  const { renderer, unmount } = await mount(Analytics, `/admin/accounts/${LIVE_OFFICE.id}/office/analytics`);
  await settle();
  const root = renderer.root;
  check('HQ drill-in sends office= on the insights request',
    insightsRequests().length === 1 && insightsRequests()[0].endsWith(`&office=${LIVE_OFFICE.id}`), requests.join('\n'));
  const url = new URL(insightsRequests()[0].split(' ')[1], 'http://test.local');
  const expected = expectedFrom(liveInsights('app_open', url.searchParams.get('start')!, url.searchParams.get('end')!, LIVE_OFFICE.id));
  check('drill-in shows the served figures with no selector',
    byTestId(root, 'select-insights-office').length === 0 && tiles(root).join('|') === expected.tiles.join('|'), tiles(root).join('|'));
  await unmount();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall office insights checks passed');
