/**
 * HQ Customer health — rules + page states.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:customer-health
 *
 * Pure half (src/lib/customer-health.ts):
 *   - URL state: ?group= / ?sort= / ?dir= round-trip, unknown values fall
 *     back, the default sort and "all offices" leave a bare URL;
 *   - filtering by bucket and by attention; sorting on every column with
 *     "No orders on record" sinking both ways and ties reading like the rank;
 *   - formatting of days-since and counts; the definitions note is built from
 *     the server's constants (weights, targets, bounds, caveat).
 *
 * Rendered half (REAL page under react-test-renderer; session / HQ directory
 * / supabase contexts stubbed via tsconfig.system-health.json, global fetch
 * scripted):
 *   - loading first (tiles "—", no table, no numbers), then live tiles, the
 *     ranked table with band pills, New badge, "No orders on record", flags,
 *     account links, the attention section worst-first and the definitions;
 *   - clicking a tile narrows the table and writes ?group=; clicking again
 *     clears it; sorting writes ?sort=&dir= and reorders; a shared URL
 *     restores both; the page never reads the shared date range;
 *   - Refresh refetches and the "Updated" stamp is present;
 *   - a 502 renders Error tiles and the error notices (never zeros); Try
 *     again recovers;
 *   - Support / Content lack the page permission; Admin has it.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CustomerHealthDefinitions, CustomerHealthOffice, CustomerHealthResult } from '@workspace/api-client-react';
import { __setSession } from './a11y-stubs/session';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import CustomerHealth from '../src/pages/admin/CustomerHealth';
import { canHq, permissionForAdminPath } from '../src/data/hq/team';
import {
  BUCKET_ORDER,
  DEFAULT_HEALTH_SORT,
  HEALTH_COLUMNS,
  countFlagged,
  filterHealthRows,
  formatDaysAgo,
  healthDefinitions,
  healthSearchFor,
  nextSort,
  parseHealthSearch,
  sortHealthRows,
} from '../src/lib/customer-health';

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
const rowIds = (root: ReactTestInstance) => root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('row-health-') && typeof n.type === 'string').map((n) => n.props['data-testid'].replace('row-health-', ''));
const attentionIds = (root: ReactTestInstance) => root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('attention-health-') && typeof n.type === 'string').map((n) => n.props['data-testid'].replace('attention-health-', ''));
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

// ─── Fixture ─────────────────────────────────────────────────────────────────

const DEFINITIONS: CustomerHealthDefinitions = {
  weights: { recency: 40, subscribers: 15, appUsers: 15, activeAppUsers: 15, staff: 15 },
  targets: { subscribers: 10, appUsers: 25, staff: 3 },
  recencyFullDays: 30, recencyZeroDays: 365,
  bucketBounds: { active: 90, quiet3to6: 180, quiet6to12: 365 },
  bandThresholds: { healthy: 70, watch: 40 },
  newOfficeDays: 90,
  attentionRules: { leavingActive: { from: 60, to: 90 }, passingSixMonths: { from: 150, to: 180 }, activeUsersDropPct: 30, activeUsersDropMinPrior: 3 },
};

const NOW = new Date('2026-10-09T15:00:00Z');
const DAY = 86_400_000;
const agoIso = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function office(id: string, name: string, partial: Partial<CustomerHealthOffice>): CustomerHealthOffice {
  const days = partial.daysSinceLastOrder ?? null;
  return {
    providerId: id, officeName: name, providerName: `${name} lead`,
    rank: 0, score: 0, band: 'atRisk',
    parts: { recency: 0, subscribers: 0, appUsers: 0, activeAppUsers: 0, staff: 0 },
    bucket: 'quietOverYear', isNew: false,
    lastOrderDate: days === null ? null : agoIso(days).slice(0, 10), lastOrderAt: days === null ? null : agoIso(days), daysSinceLastOrder: days,
    officeAgeDays: 400, activeSubscribers: 0, cancellingSubscriptions: 0, appUsers: 0, activeAppUsers30d: 0, activeAppUsersPrior30d: 0, staffEnrolled: 0,
    flags: [],
    ...partial,
  };
}

const OFFICES: CustomerHealthOffice[] = [
  office('harbor', 'Harbor Clinic', { rank: 1, score: 92, band: 'healthy', bucket: 'active', daysSinceLastOrder: 12, activeSubscribers: 14, appUsers: 40, activeAppUsers30d: 31, staffEnrolled: 4 }),
  office('summit', 'Summit Health', { rank: 2, score: 58, band: 'watch', bucket: 'active', daysSinceLastOrder: 75, activeSubscribers: 5, appUsers: 18, activeAppUsers30d: 6, activeAppUsersPrior30d: 10, staffEnrolled: 2,
    flags: [{ kind: 'leavingActive', reason: 'Last order 75 days ago — about to leave Active (90-day mark).' }, { kind: 'activeUsersDrop', reason: 'Active app users down 40% — 6 in the last 30 days vs 10 in the 30 days before.' }] }),
  office('cedar', 'Cedar Wellness', { rank: 3, score: 41, band: 'watch', bucket: 'quiet3to6', daysSinceLastOrder: 160, activeSubscribers: 3, appUsers: 12, activeAppUsers30d: 5, staffEnrolled: 1,
    flags: [{ kind: 'passingSixMonths', reason: 'Last order 160 days ago — about to pass six months without an order.' }] }),
  office('birch', 'Birch Medical', { rank: 4, score: 22, band: 'atRisk', bucket: 'quiet6to12', daysSinceLastOrder: 300, activeSubscribers: 1, cancellingSubscriptions: 1, appUsers: 6, activeAppUsers30d: 1, staffEnrolled: 1,
    flags: [{ kind: 'subscriptionsCancelling', reason: '1 active subscription set to cancel at period end.' }, { kind: 'atRisk', reason: 'Health score is At risk (below 40) and the office is not new.' }] }),
  office('aspen', 'Aspen Family Care', { rank: 5, score: 9, band: 'atRisk', bucket: 'quietOverYear', daysSinceLastOrder: null, appUsers: 3, activeAppUsers30d: 1, staffEnrolled: 1,
    flags: [{ kind: 'atRisk', reason: 'Health score is At risk (below 40) and the office is not new.' }] }),
  office('willow', 'Willow Springs', { rank: 6, score: 0, band: 'atRisk', bucket: 'quietOverYear', daysSinceLastOrder: null, isNew: true, officeAgeDays: 12 }),
];

function liveResult(): CustomerHealthResult {
  return {
    generatedAt: NOW.toISOString(),
    offices: OFFICES,
    bucketCounts: { active: 2, quiet3to6: 1, quiet6to12: 1, quietOverYear: 2 },
    bandCounts: { healthy: 1, watch: 2, atRisk: 3 },
    attention: [OFFICES[4], OFFICES[3], OFFICES[2], OFFICES[1]],
    definitions: DEFINITIONS,
  };
}

// ─── Pure rules ──────────────────────────────────────────────────────────────

console.log('rules');
{
  check('default URL state: no group, rank asc', JSON.stringify(parseHealthSearch('')) === JSON.stringify({ group: null, sort: DEFAULT_HEALTH_SORT }));
  check('?group=&sort=&dir= round-trip', JSON.stringify(parseHealthSearch('?group=quiet3to6&sort=score&dir=asc')) === JSON.stringify({ group: 'quiet3to6', sort: { key: 'score', direction: 'asc' } }));
  check('attention is a group too', parseHealthSearch('group=attention').group === 'attention');
  check('unknown group / sort / dir fall back quietly', parseHealthSearch('?group=nope&sort=bogus&dir=sideways').group === null && parseHealthSearch('?sort=bogus').sort.key === 'rank'
    && parseHealthSearch('?sort=score&dir=sideways').sort.direction === 'desc' && parseHealthSearch('?sort=officeName').sort.direction === 'asc');
  check('default state writes a bare URL; others write group/sort/dir', healthSearchFor({ group: null, sort: DEFAULT_HEALTH_SORT }) === ''
    && healthSearchFor({ group: 'active', sort: { key: 'appUsers', direction: 'desc' } }) === '?group=active&sort=appUsers&dir=desc');
  check('healthSearchFor keeps unrelated params', healthSearchFor({ group: null, sort: DEFAULT_HEALTH_SORT }, '?foo=1&sort=score&dir=asc&group=active') === '?foo=1');
  check('nextSort: new column starts in its natural direction, same column flips',
    JSON.stringify(nextSort(DEFAULT_HEALTH_SORT, 'score')) === JSON.stringify({ key: 'score', direction: 'desc' })
      && JSON.stringify(nextSort({ key: 'score', direction: 'desc' }, 'score')) === JSON.stringify({ key: 'score', direction: 'asc' })
      && nextSort(DEFAULT_HEALTH_SORT, 'daysSinceLastOrder').direction === 'asc' && nextSort(DEFAULT_HEALTH_SORT, 'bucket').direction === 'asc');
  check('columns: rank, office, score, last order, subscribers, app users, active, staff, recency',
    HEALTH_COLUMNS.map((c) => c.key).join() === 'rank,officeName,score,daysSinceLastOrder,activeSubscribers,appUsers,activeAppUsers30d,staffEnrolled,bucket');

  check('filter by bucket', filterHealthRows(OFFICES, 'active').map((o) => o.providerId).join() === 'harbor,summit' && filterHealthRows(OFFICES, 'quietOverYear').map((o) => o.providerId).join() === 'aspen,willow');
  check('filter by attention = any flag', filterHealthRows(OFFICES, 'attention').map((o) => o.providerId).join() === 'summit,cedar,birch,aspen' && countFlagged(OFFICES) === 4);
  check('no group = every row', filterHealthRows(OFFICES, null).length === 6);

  const ids = (rows: CustomerHealthOffice[]) => rows.map((o) => o.providerId).join();
  check('rank asc is the ranking', ids(sortHealthRows(OFFICES, DEFAULT_HEALTH_SORT)) === 'harbor,summit,cedar,birch,aspen,willow');
  check('score desc = rank asc; score asc reverses', ids(sortHealthRows(OFFICES, { key: 'score', direction: 'desc' })) === 'harbor,summit,cedar,birch,aspen,willow'
    && ids(sortHealthRows(OFFICES, { key: 'score', direction: 'asc' })) === 'willow,aspen,birch,cedar,summit,harbor');
  check('last order: no orders sink both ways, ties by rank', ids(sortHealthRows(OFFICES, { key: 'daysSinceLastOrder', direction: 'asc' })) === 'harbor,summit,cedar,birch,aspen,willow'
    && ids(sortHealthRows(OFFICES, { key: 'daysSinceLastOrder', direction: 'desc' })) === 'birch,cedar,summit,harbor,aspen,willow');
  check('office name sorts alphabetically', ids(sortHealthRows(OFFICES, { key: 'officeName', direction: 'asc' })) === 'aspen,birch,cedar,harbor,summit,willow');
  check('counts sort high-first with rank as the tiebreak', ids(sortHealthRows(OFFICES, { key: 'staffEnrolled', direction: 'desc' })) === 'harbor,summit,cedar,birch,aspen,willow'
    && ids(sortHealthRows(OFFICES, { key: 'appUsers', direction: 'asc' })) === 'willow,aspen,birch,cedar,summit,harbor');
  check('bucket sorts in group order', ids(sortHealthRows(OFFICES, { key: 'bucket', direction: 'desc' })) === 'aspen,willow,birch,cedar,harbor,summit' && BUCKET_ORDER.join() === 'active,quiet3to6,quiet6to12,quietOverYear');

  check('formatDaysAgo', formatDaysAgo(null) === 'No orders on record' && formatDaysAgo(0) === 'Today' && formatDaysAgo(1) === '1 day ago' && formatDaysAgo(1234) === '1,234 days ago');

  const defs = healthDefinitions(DEFINITIONS);
  const text = (term: string) => defs.find((d) => d.term === term)?.text ?? '';
  check('definitions cover customers, order, groups, New, caveat, four counts, score, bands, attention',
    defs.map((d) => d.term).join('|') === 'Customers|Most recent order|Order-recency groups|New|No orders on record|App subscribers|App users|Active app users|Staff enrolled|Health score|Bands|Needs attention this week');
  check('group bounds come from the server constants', text('Order-recency groups').includes('last 90 days') && text('Order-recency groups').includes('91–180') && text('Order-recency groups').includes('181–365') && text('Order-recency groups').includes('more than 365'));
  check('score weights and targets are spelled out', text('Health score').includes('Most recent order 40 points') && text('Health score').includes('30 days or less') && text('Health score').includes('zero at 365')
    && text('Health score').includes('App subscribers 15 points, full at 10') && text('Health score').includes('App users 15 points, full at 25') && text('Health score').includes('Staff enrolled 15 points, full at 3'));
  check('bands and attention rules read from constants', text('Bands').includes('Healthy 70') && text('Bands').includes('Watch 40–69') && text('Bands').includes('below 40')
    && text('Needs attention this week').includes('60–90') && text('Needs attention this week').includes('150–180') && text('Needs attention this week').includes('30% or more') && text('Needs attention this week').includes('at least 3'));
  check('the migrated-office caveat is plain', text('No orders on record').includes('old system') && text('No orders on record').includes('No orders on record'));
  check('New rule and sandbox exclusion are stated', text('New').includes('90 days') && text('Most recent order').includes('Sandbox'));
}

console.log('permissions');
{
  check('/admin/customer-health maps to the overview (analytics) permission', permissionForAdminPath('/admin/customer-health') === 'overview');
  check('Admin and Super Admin may open it', canHq('Admin', 'overview') && canHq('Super Admin', 'overview'));
  check('Support and Content may not', !canHq('Support', 'overview') && !canHq('Content', 'overview'));
}

// ─── Rendered page ───────────────────────────────────────────────────────────

const requests: string[] = [];
const healthRequests = () => requests.filter((r) => r.includes('/api/hq/customer-health'));
let status = 200;
let hold: (() => void) | null = null;
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url}`);
  const json = (payload: unknown, code = 200) => new Response(JSON.stringify(payload), { status: code, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/api/hq/customer-health')) {
    if (hold) await new Promise<void>((resolve) => { hold = resolve; });
    if (status !== 200) return json({ error: 'Could not load customer health right now.' }, status);
    return json(liveResult());
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
        <Router hook={location.hook}>
          <Route path="/admin/customer-health"><CustomerHealth /></Route>
        </Router>
      </QueryClientProvider>,
    );
  });
  return { renderer: renderer!, client, currentUrl, unmount: async () => { await act(async () => { renderer!.unmount(); }); client.clear(); } };
}

__setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1', displayName: 'Ada Admin' }, hqRole: 'Admin' });
__setSupabaseSession('token');
__setHqData({ accounts: [] });

console.log('live page');
{
  requests.length = 0;
  hold = () => {};
  const { renderer, client, currentUrl, unmount } = await mount('/admin/customer-health');
  await settle(2);
  const root = renderer.root;
  const snapshot = () => JSON.stringify(renderer.toJSON());
  check('loading: tiles show — and the table / attention / definitions show loading copy (no numbers)',
    textOf(byTestId(root, 'text-health-active')[0]) === '—' && textOf(byTestId(root, 'text-health-attention')[0]) === '—'
      && byTestId(root, 'text-health-table-loading').length === 1 && byTestId(root, 'text-health-attention-loading').length === 1 && byTestId(root, 'text-health-definitions-loading').length === 1
      && byTestId(root, 'table-customer-health').length === 0 && byTestId(root, 'text-health-updated').length === 0 && !snapshot().includes('"0"'));
  check('refresh control is disabled while loading', byTestId(root, 'button-health-refresh')[0].props.disabled === true);
  const release = hold; hold = null; release();
  await settle();
  check('one live request, no date-range params', healthRequests().length === 1 && /GET \/api\/hq\/customer-health$/.test(healthRequests()[0]), requests.join('\n'));
  check('ready: bucket tiles and the attention tile carry the counts',
    textOf(byTestId(root, 'text-health-active')[0]) === '2' && textOf(byTestId(root, 'text-health-quiet3to6')[0]) === '1' && textOf(byTestId(root, 'text-health-quiet6to12')[0]) === '1'
      && textOf(byTestId(root, 'text-health-quietOverYear')[0]) === '2' && textOf(byTestId(root, 'text-health-attention')[0]) === '4');
  check('header shows the as-of date and when the data landed', textOf(byTestId(root, 'text-health-asof')[0]).includes('2026') && /^Updated \d{1,2}:\d{2}:\d{2} (AM|PM)$/.test(textOf(byTestId(root, 'text-health-updated')[0])), textOf(byTestId(root, 'text-health-updated')[0] ?? root));
  check('table lists every office in rank order', byTestId(root, 'table-customer-health').length === 1 && rowIds(root).join() === 'harbor,summit,cedar,birch,aspen,willow', rowIds(root).join());
  check('rank, score and band pill per row', textOf(byTestId(root, 'health-rank-harbor')[0]) === '1' && textOf(byTestId(root, 'health-score-harbor')[0]) === '92'
    && textOf(byTestId(root, 'health-band-harbor')[0]) === 'Healthy' && textOf(byTestId(root, 'health-band-summit')[0]) === 'Watch' && textOf(byTestId(root, 'health-band-birch')[0]) === 'At risk');
  check('last order reads date + days since; no order reads "No orders on record"',
    textOf(byTestId(root, 'health-last-order-harbor')[0]).includes('12 days ago') && textOf(byTestId(root, 'health-last-order-harbor')[0]).includes('2026')
      && textOf(byTestId(root, 'health-last-order-aspen')[0]) === 'No orders on record');
  check('counts per row', textOf(byTestId(root, 'health-cell-activeSubscribers-harbor')[0]) === '14' && textOf(byTestId(root, 'health-cell-appUsers-harbor')[0]) === '40'
    && textOf(byTestId(root, 'health-cell-activeAppUsers30d-harbor')[0]) === '31' && textOf(byTestId(root, 'health-cell-staffEnrolled-harbor')[0]) === '4' && textOf(byTestId(root, 'health-cell-appUsers-willow')[0]) === '0');
  check('recency group and flags in the last column', textOf(byTestId(root, 'health-bucket-cedar')[0]) === 'Quiet 3–6 mo' && byTestId(root, 'health-flags-summit')[0].children.length === 2
    && textOf(byTestId(root, 'health-flags-summit')[0]).includes('about to leave Active') && byTestId(root, 'health-flags-harbor').length === 0);
  check('New badge on the young office only', textOf(byTestId(root, 'link-health-office-willow')[0]).includes('New') && !textOf(byTestId(root, 'link-health-office-aspen')[0]).includes('New'));
  check('office names link to the HQ account page', byTestId(root, 'link-health-office-harbor')[0].props.href === '/admin/accounts/harbor');
  check('attention section lists flagged offices worst first with reasons and a score', attentionIds(root).join() === 'aspen,birch,cedar,summit'
    && textOf(byTestId(root, 'attention-health-birch')[0]).includes('set to cancel at period end') && textOf(byTestId(root, 'attention-score-aspen')[0]) === '9'
    && textOf(byTestId(root, 'attention-health-aspen')[0]).includes('No orders on record'));
  check('definitions are on the page with the caveat', byTestId(root, 'text-health-definitions').length === 1 && textOf(byTestId(root, 'text-health-definitions')[0]).includes('old system'));
  check('no group banner at rest; bare URL', byTestId(root, 'banner-health-group').length === 0 && currentUrl() === '/admin/customer-health');
  const query = client.getQueryCache().findAll().find((q) => JSON.stringify(q.queryKey).includes('/api/hq/customer-health'));
  check('query key is identity-scoped', JSON.stringify(query?.queryKey).includes('"hq-1"'), JSON.stringify(query?.queryKey));

  // Clicking a tile narrows and writes ?group=.
  await act(async () => { byTestId(root, 'tile-health-quietOverYear')[0].props.onClick(); });
  await settle(2);
  check('clicking a bucket tile narrows the table and writes ?group=', currentUrl() === '/admin/customer-health?group=quietOverYear' && rowIds(root).join() === 'aspen,willow'
    && byTestId(root, 'tile-health-quietOverYear')[0].props['aria-pressed'] === true && byTestId(root, 'banner-health-group').length === 1
    && textOf(byTestId(root, 'text-health-group-name')[0]) === 'Quiet over a year / never', `${currentUrl()} | ${rowIds(root).join()}`);
  check('narrowing made no new request', healthRequests().length === 1);
  await act(async () => { byTestId(root, 'tile-health-attention')[0].props.onClick(); });
  await settle(2);
  check('the attention tile narrows to flagged offices', currentUrl().includes('group=attention') && rowIds(root).join() === 'summit,cedar,birch,aspen', rowIds(root).join());
  await act(async () => { byTestId(root, 'tile-health-attention')[0].props.onClick(); });
  await settle(2);
  check('clicking the pressed tile again clears the group', currentUrl() === '/admin/customer-health' && rowIds(root).length === 6 && byTestId(root, 'banner-health-group').length === 0);

  // Sorting writes ?sort=&dir= and reorders; header aria-sort follows.
  await act(async () => { byTestId(root, 'sort-health-appUsers')[0].props.onClick(); });
  await settle(2);
  const appUsersHeader = root.findAll((n) => n.type === 'th' && n.props['aria-sort'] === 'descending');
  check('sorting by app users writes ?sort=appUsers&dir=desc and reorders', currentUrl() === '/admin/customer-health?sort=appUsers&dir=desc'
    && rowIds(root).join() === 'harbor,summit,cedar,birch,aspen,willow' && appUsersHeader.length === 1 && textOf(appUsersHeader[0]).includes('App users'), currentUrl());
  await act(async () => { byTestId(root, 'sort-health-appUsers')[0].props.onClick(); });
  await settle(2);
  check('clicking the same header flips to asc', currentUrl() === '/admin/customer-health?sort=appUsers&dir=asc' && rowIds(root).join() === 'willow,aspen,birch,cedar,summit,harbor', `${currentUrl()} | ${rowIds(root).join()}`);
  await act(async () => { byTestId(root, 'tile-health-active')[0].props.onClick(); });
  await settle(2);
  check('group and sort compose in the URL', currentUrl() === '/admin/customer-health?sort=appUsers&dir=asc&group=active' && rowIds(root).join() === 'summit,harbor', currentUrl());

  // Refresh refetches.
  const before = healthRequests().length;
  await act(async () => { byTestId(root, 'button-health-refresh')[0].props.onClick(); });
  await settle();
  check('Refresh issues a new request and the table stays', healthRequests().length === before + 1 && rowIds(root).join() === 'summit,harbor');
  await unmount();

  const shared = await mount('/admin/customer-health?group=quiet3to6&sort=officeName&dir=desc');
  await settle();
  check('a shared URL restores group and sort', rowIds(shared.renderer.root).join() === 'cedar' && byTestId(shared.renderer.root, 'tile-health-quiet3to6')[0].props['aria-pressed'] === true
    && shared.renderer.root.findAll((n) => n.type === 'th' && n.props['aria-sort'] === 'descending').length === 1);
  await shared.unmount();

  const empty = await mount('/admin/customer-health?group=quiet3to6');
  await settle();
  await act(async () => { byTestId(empty.renderer.root, 'sort-health-rank')[0].props.onClick(); });
  await settle(2);
  check('a group with nothing in it after a filter still reads honestly', rowIds(empty.renderer.root).join() === 'cedar');
  await empty.unmount();
}

console.log('live page — failure');
{
  requests.length = 0;
  status = 502;
  const { renderer, unmount } = await mount('/admin/customer-health?group=active');
  // The page retries once (retry: 1) before reporting, so wait out the retry delay.
  await settle();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });
  await settle();
  const root = renderer.root;
  check('the failed read was retried exactly once before reporting', healthRequests().length === 2, String(healthRequests().length));
  check('a 502 renders Error tiles and the error notices (never zeros)',
    textOf(byTestId(root, 'text-health-active')[0]) === 'Error' && textOf(byTestId(root, 'text-health-attention')[0]) === 'Error'
      && byTestId(root, 'text-health-table-error').length === 1 && byTestId(root, 'text-health-attention-error').length === 1
      && byTestId(root, 'table-customer-health').length === 0 && byTestId(root, 'text-health-updated').length === 0 && !JSON.stringify(renderer.toJSON()).includes('"0"'));
  const before = healthRequests().length;
  status = 200;
  const retry = byTestId(root, 'text-health-table-error')[0].findAll((n) => n.type === 'button')[0];
  await act(async () => { retry.props.onClick(); });
  await settle();
  check('Try again refetches and recovers with the URL group intact', healthRequests().length > before && rowIds(root).join() === 'harbor,summit' && textOf(byTestId(root, 'text-health-active')[0]) === '2');
  await unmount();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall customer health checks passed');
