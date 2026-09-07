/**
 * Live leaderboard — the REAL Leaderboard page under react-test-renderer.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:leaderboard
 *
 * Session / provider-scope / HQ-directory contexts are stubbed through
 * tsconfig.leaderboard.json; global fetch is scripted. Proves:
 *
 *   - signed-in office staff: the live endpoint is called with NO office,
 *     rows come from the server (never the seeded board), server ranks are
 *     shown (ties share a rank, podium tint follows the rank), the metric
 *     switch re-sorts client-side without refetching, the period and stage
 *     selects refetch with the new query, the definitions ride the header,
 *     the not-rankable count is separated from the rows, row links open the
 *     patient record, and the demo provider select is absent;
 *   - HQ drill-in: an office picker defaults to the drilled-in office,
 *     "All offices" switches to office=all with cross-office links;
 *   - explicit states: loading, error (with retry), unauthorized (no retry),
 *     no rankable patients, empty stage;
 *   - a live failure never falls back to seeded rows;
 *   - auth resolution shows a session check, not seeded rows;
 *   - the guided demo (signed-out) still renders the seeded board and never
 *     calls the live endpoint.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import type { LeaderboardRow, OfficeLeaderboard } from '../src/lib/office-roster';
import Leaderboard from '../src/pages/Leaderboard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

function row(id: string, name: string, initials: string, over: Partial<LeaderboardRow> & { ranks: LeaderboardRow['ranks'] }): LeaderboardRow {
  return {
    id, providerId: 'office-1', officeName: null, name, initials,
    program: { startDate: '2026-06-01', day: 99, stage: 'protocol', week: 3 },
    asOfDate: '2026-09-07', periodStart: '2026-06-01',
    baselineWeight: 200, baselineWeightDate: null, latestWeight: 180, latestWeightDate: '2026-09-05',
    poundsLost: 20, percentLost: 10, goalCompletion: 50,
    adherence: { score: 72, eligibleDays: 30, loggedDays: 24, checkInDays: 18, waterGoalDays: 9, loggedRate: 0.8, checkInRate: 0.6, waterRate: 0.3 },
    ...over,
  };
}

const DEFINITIONS = {
  adherence: 'Adherence blends three daily habits over the period: 40% logged days, 40% check-in days, 20% water goal days.',
  loss: 'Pounds and percent lost compare the latest weigh-in with the baseline.',
  goal: 'Goal completion is program to date.',
  eligibility: 'Only activated patients with a starting weight and a weigh-in are ranked.',
  ties: 'Ties share a rank.',
};

const BOARD: OfficeLeaderboard = {
  office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics' },
  offices: [],
  period: 'program', stage: 'all', asOf: '2026-09-07', windowDays: null,
  rows: [
    // Two patients tied on % lost (shared rank 1), a third behind them.
    row('pat-b', 'Blake Nguyen', 'BN', { poundsLost: 25, percentLost: 10, baselineWeight: 250, latestWeight: 225, goalCompletion: null, ranks: { percent: 1, pounds: 1, goal: 3, adherence: 2 } }),
    row('pat-a', 'Casey Ortiz', 'CO', { ranks: { percent: 1, pounds: 2, goal: 1, adherence: 3 }, adherence: { score: 40, eligibleDays: 30, loggedDays: 10, checkInDays: 10, waterGoalDays: 10, loggedRate: 0.33, checkInRate: 0.33, waterRate: 0.33 } }),
    row('pat-c', 'Devon Reyes', 'DR', { poundsLost: 5, percentLost: 2.5, goalCompletion: 12.5, program: { startDate: '2026-07-01', day: 69, stage: 'maintenance', week: null }, ranks: { percent: 3, pounds: 3, goal: 2, adherence: 1 }, adherence: { score: 95, eligibleDays: 30, loggedDays: 30, checkInDays: 28, waterGoalDays: 25, loggedRate: 1, checkInRate: 0.93, waterRate: 0.83 } }),
  ],
  notRankable: { total: 2, reasons: [{ reason: 'paused', label: 'Paused', count: 1 }, { reason: 'no_weigh_in', label: 'No weigh-in yet', count: 1 }] },
  definitions: DEFINITIONS,
};

const NETWORK: OfficeLeaderboard = {
  ...BOARD,
  office: null,
  offices: [{ providerId: 'office-1', officeName: 'Beacon Hill Aesthetics' }, { providerId: 'office-2', officeName: 'Lakeside Clinic' }],
  rows: [
    row('pat-z', 'Zoe Park', 'ZP', { providerId: 'office-2', officeName: 'Lakeside Clinic', poundsLost: 50, percentLost: 25, ranks: { percent: 1, pounds: 1, goal: 1, adherence: 1 } }),
    { ...BOARD.rows[0], officeName: 'Beacon Hill Aesthetics', ranks: { percent: 2, pounds: 2, goal: 3, adherence: 2 } },
  ],
};

type Script = { status: number; body: unknown } | { delay: true };
let requests: string[] = [];
let script: (url: URL) => Script = () => ({ status: 200, body: BOARD });
let release: (() => void) | null = null;

g.fetch = async (input: string | URL | Request) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href, 'http://ops.test');
  if (url.pathname === '/api/office/leaderboard') {
    requests.push(url.search);
    const next = script(url);
    if ('delay' in next) {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify(BOARD), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected fetch ${href}`);
};

interface Rendered { renderer: ReactTestRenderer; root: ReactTestInstance; loc: ReturnType<typeof memoryLocation> }

async function settle(n = 10) {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function render(path = '/leaderboard'): Promise<Rendered> {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <PatientSessionProvider>
          <Router hook={loc.hook}>
            <Leaderboard />
          </Router>
        </PatientSessionProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root, loc };
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

function byTestId(root: ReactTestInstance, id: string): ReactTestInstance | undefined {
  return root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string')[0];
}

function rowIds(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => typeof node.type === 'string' && typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('row-leaderboard-'))
    .map((node) => String(node.props['data-testid']).slice('row-leaderboard-'.length));
}

function rankText(root: ReactTestInstance, id: string): string {
  return textOf(byTestId(root, `text-rank-${id}`)!);
}

function selectByTestId(root: ReactTestInstance, id: string): ReactTestInstance | undefined {
  return root.findAll((node) => node.type === 'select' && node.props['data-testid'] === id)[0];
}

async function choose(select: ReactTestInstance, value: string) {
  await act(async () => { select.props.onChange({ target: { value } }); });
  await settle();
}

function linkHref(root: ReactTestInstance, id: string): string {
  const link = root.findAll((node) => node.props['data-testid'] === `link-leaderboard-patient-${id}`)[0];
  return String(link?.props.href ?? link?.props.to ?? '');
}

function staffSignedIn() {
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' } });
  __setScope(null);
  __setSupabaseSession('staff-token');
  __setHqData({ accounts: [] });
}

function hqDrillIn() {
  const accounts = [
    { id: 'office-2', providerId: 'office-2', officeName: 'Lakeside Clinic' },
    { id: 'office-1', providerId: 'office-1', officeName: 'Beacon Hill Aesthetics' },
  ];
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' } });
  __setScope(accounts[1]);
  __setSupabaseSession('hq-token');
  __setHqData({ accounts });
}

function reset() {
  requests = [];
  release = null;
  script = () => ({ status: 200, body: BOARD });
}

// ─── Office staff ────────────────────────────────────────────────────────────

console.log('office staff — live board');
{
  reset();
  staffSignedIn();
  const { renderer, root } = await render();
  check('calls the live endpoint with no office and the default period/stage', requests.length === 1 && requests[0] === '?period=program&stage=all', requests.join(' | '));
  check('rows are the server rows in % order (tie, then alphabetical)', rowIds(root).join(',') === 'pat-b,pat-a,pat-c', rowIds(root).join(','));
  check('no seeded demo patient leaks in', !rowIds(root).some((id) => !id.startsWith('pat-')));
  check('tied rows share rank #1 and the third is #3', rankText(root, 'pat-b') === '#1' && rankText(root, 'pat-a') === '#1' && rankText(root, 'pat-c') === '#3', [rankText(root, 'pat-b'), rankText(root, 'pat-a'), rankText(root, 'pat-c')].join(' '));
  const goldTint = (id: string) => String(byTestId(root, `text-rank-${id}`)!.props.className).includes('#97631e');
  check('podium tint follows the shared rank (both #1 gold)', goldTint('pat-b') && goldTint('pat-a') && !goldTint('pat-c'));
  check('initials and names come from the server verbatim', textOf(byTestId(root, 'row-leaderboard-pat-a')!).includes('CO') && textOf(byTestId(root, 'row-leaderboard-pat-a')!).includes('Casey Ortiz'));
  check('row links open the live patient record', linkHref(root, 'pat-a') === '/patients/pat-a' && linkHref(root, 'pat-c') === '/patients/pat-c', linkHref(root, 'pat-a'));
  check('definitions ride the page header', textOf(byTestId(root, 'text-leaderboard-definitions')!).includes('40% logged days') && textOf(byTestId(root, 'text-leaderboard-definitions')!).includes('Ties share a rank.'));
  check('board names the office, period and the UTC compute date with the local-day caveat', textOf(byTestId(root, 'text-leaderboard-board')!).includes('Beacon Hill Aesthetics') && textOf(byTestId(root, 'text-leaderboard-scope')!).includes('Program to date — computed Sep 7, 2026 UTC, each patient on their own local day'), textOf(byTestId(root, 'text-leaderboard-scope')!));
  check('not-rankable count is separated from the rows, with reasons', textOf(byTestId(root, 'text-leaderboard-not-rankable')!).replace(/\s+/g, ' ') === '2 not yet rankable · Paused 1 · No weigh-in yet 1' && textOf(byTestId(root, 'text-leaderboard-ranked-count')!) === '3 ranked', textOf(byTestId(root, 'text-leaderboard-not-rankable')!));
  check('demo provider select is absent; period select present', !selectByTestId(root, 'select-leaderboard-provider') && Boolean(selectByTestId(root, 'select-leaderboard-period')) && !selectByTestId(root, 'select-leaderboard-office'));
  const metricA = textOf(byTestId(root, 'text-metric-pat-a')!);
  check('% metric shows percent and pounds', metricA.includes('10.0%') && metricA.includes('20.0 lbs lost'), metricA);

  // Metric switch: client-side re-sort, no refetch.
  await choose(selectByTestId(root, 'select-leaderboard-metric')!, 'adherence');
  check('adherence metric re-sorts by server adherence rank without refetching', rowIds(root).join(',') === 'pat-c,pat-b,pat-a' && requests.length === 1, `${rowIds(root).join(',')} req=${requests.length}`);
  check('adherence cell shows score and the three habit counts', textOf(byTestId(root, 'text-metric-pat-c')!).includes('95/100') && textOf(byTestId(root, 'text-metric-pat-c')!).includes('logged 30/30 · check-ins 28/30 · water 25/30'), textOf(byTestId(root, 'text-metric-pat-c')!));
  await choose(selectByTestId(root, 'select-leaderboard-metric')!, 'goal');
  check('goal metric: no-goal row trails and shows a dash, not 0%', rowIds(root).join(',') === 'pat-a,pat-c,pat-b' && textOf(byTestId(root, 'text-metric-pat-b')!).includes('—') && textOf(byTestId(root, 'text-metric-pat-b')!).includes('no goal weight set'), textOf(byTestId(root, 'text-metric-pat-b')!));
  await choose(selectByTestId(root, 'select-leaderboard-metric')!, 'pounds');
  check('pounds metric orders by pounds rank', rowIds(root).join(',') === 'pat-b,pat-a,pat-c' && textOf(byTestId(root, 'text-metric-pat-b')!).includes('25.0 lbs'));

  // Period + stage refetch.
  await choose(selectByTestId(root, 'select-leaderboard-period')!, '30d');
  check('period change refetches with period=30d', requests[requests.length - 1] === '?period=30d&stage=all', requests.join(' | '));
  check('scope line follows the period', textOf(byTestId(root, 'text-leaderboard-scope')!).startsWith('Last 30 days'));
  await choose(selectByTestId(root, 'select-leaderboard-stage')!, 'maintenance');
  check('stage change refetches server-side (stage=maintenance)', requests[requests.length - 1] === '?period=30d&stage=maintenance', requests.join(' | '));
  renderer.unmount();
}

console.log('\noffice staff — explicit states');
{
  reset();
  staffSignedIn();
  script = () => ({ delay: true });
  const pending = await render();
  check('loading state while the ranking is in flight', Boolean(byTestId(pending.root, 'text-leaderboard-loading')) && rowIds(pending.root).length === 0);
  await act(async () => { release?.(); });
  await settle();
  check('rows replace the loading state once the response lands', rowIds(pending.root).length === 3 && !byTestId(pending.root, 'text-leaderboard-loading'));
  pending.renderer.unmount();

  reset();
  script = () => ({ status: 502, body: { error: 'The leaderboard could not be computed right now.' } });
  const failed = await render();
  check('5xx is retried before surfacing (still loading after the first failure)', Boolean(byTestId(failed.root, 'text-leaderboard-loading')) && requests.length === 1, `req=${requests.length}`);
  // Two background retries (1s + 2s backoff) precede the error state.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3300)); });
  await settle();
  check('502 exhausts its retries (3 requests total)', requests.length === 3, `req=${requests.length}`);
  const error = byTestId(failed.root, 'text-leaderboard-error');
  check('502 → explicit error with the server message and a retry', Boolean(error) && textOf(error!).includes('could not be computed') && Boolean(byTestId(failed.root, 'button-leaderboard-retry')), error ? textOf(error) : 'no error node');
  check('a live failure never falls back to seeded rows', rowIds(failed.root).length === 0 && !byTestId(failed.root, 'text-leaderboard-empty'));
  script = () => ({ status: 200, body: BOARD });
  await act(async () => { byTestId(failed.root, 'button-leaderboard-retry')!.props.onClick(); });
  await settle();
  check('retry refetches and renders the rows', rowIds(failed.root).length === 3 && requests.length === 4, `rows=${rowIds(failed.root).length} req=${requests.length}`);
  failed.renderer.unmount();

  reset();
  script = () => ({ status: 403, body: { error: 'Your HQ role does not have permission to do this.' } });
  const denied = await render();
  const deniedNode = byTestId(denied.root, 'text-leaderboard-error');
  check('403 → unauthorized wording without a retry button, and no automatic retries', Boolean(deniedNode) && textOf(deniedNode!).includes("don't have access") && !byTestId(denied.root, 'button-leaderboard-retry') && requests.length === 1, deniedNode ? `${textOf(deniedNode)} req=${requests.length}` : 'none');
  denied.renderer.unmount();

  reset();
  script = () => ({ status: 200, body: { ...BOARD, rows: [], notRankable: { total: 3, reasons: [{ reason: 'no_weigh_in', label: 'No weigh-in yet', count: 3 }] } } });
  const empty = await render();
  check('no rankable patients → explicit empty state that names the reason count', textOf(byTestId(empty.root, 'text-leaderboard-empty')!) === 'No rankable patients yet' && textOf(byTestId(empty.root, 'text-leaderboard-not-rankable')!).includes('3 not yet rankable'));
  empty.renderer.unmount();

  reset();
  script = () => ({ status: 200, body: { ...BOARD, rows: [], notRankable: { total: 0, reasons: [] } } });
  const none = await render();
  check('no patients at all → distinct wording', textOf(byTestId(none.root, 'text-leaderboard-empty')!) === 'No patients to rank yet');
  none.renderer.unmount();
}

// ─── HQ drill-in ─────────────────────────────────────────────────────────────

console.log('\nHQ drill-in');
{
  reset();
  hqDrillIn();
  script = (url) => ({ status: 200, body: url.searchParams.get('office') === 'all' ? NETWORK : BOARD });
  const { renderer, root } = await render();
  const office = selectByTestId(root, 'select-leaderboard-office');
  check('office picker defaults to the drilled-in office', Boolean(office) && office!.props.value === 'office-1' && requests[0] === '?period=program&stage=all&office=office-1', requests.join(' | '));
  const options = office!.findAll((node) => node.type === 'option').map((node) => `${node.props.value}:${textOf(node)}`);
  check('picker lists All offices first, then offices alphabetically', options.join(',') === 'all:All offices,office-1:Beacon Hill Aesthetics,office-2:Lakeside Clinic', options.join(','));
  check('single-office links stay relative inside the drill-in', linkHref(root, 'pat-a') === '/patients/pat-a');
  await choose(office!, 'all');
  check('All offices → office=all', requests[requests.length - 1] === '?period=program&stage=all&office=all', requests.join(' | '));
  check('network board shows the office on each row and names the board', textOf(byTestId(root, 'row-leaderboard-pat-z')!).includes('Lakeside Clinic') && textOf(byTestId(root, 'text-leaderboard-board')!).includes('All offices'));
  check('cross-office links target that office\'s drill-in', linkHref(root, 'pat-z') === '~/admin/accounts/office-2/office/patients/pat-z' && linkHref(root, 'pat-b') === '~/admin/accounts/office-1/office/patients/pat-b', linkHref(root, 'pat-z'));
  await choose(office!, 'office-2');
  check('picking another office queries it explicitly', requests[requests.length - 1] === '?period=program&stage=all&office=office-2');
  renderer.unmount();
}

// ─── Resolving session ───────────────────────────────────────────────────────

console.log('\nauth resolving');
{
  reset();
  __setSession({ authStatus: 'loading', authRole: null, authUser: null });
  __setScope(null);
  const { renderer, root } = await render();
  check('while the session resolves: a session check, no seeded rows, no live call', Boolean(byTestId(root, 'text-leaderboard-loading')) && rowIds(root).length === 0 && requests.length === 0);
  renderer.unmount();
}

// ─── Guided demo ─────────────────────────────────────────────────────────────

console.log('\nguided demo (signed out)');
{
  reset();
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null });
  __setScope(null);
  __setSupabaseSession(null);
  const { renderer, root } = await render();
  const ids = rowIds(root);
  check('seeded board renders with many patients and never calls the live endpoint', ids.length > 10 && requests.length === 0, `rows=${ids.length} req=${requests.length}`);
  check('demo keeps its provider select and has no period/office selects', Boolean(selectByTestId(root, 'select-leaderboard-provider')) && !selectByTestId(root, 'select-leaderboard-period') && !selectByTestId(root, 'select-leaderboard-office'));
  check('demo ranks are positional (#1, #2, #3 …)', rankText(root, ids[0]) === '#1' && rankText(root, ids[1]) === '#2' && rankText(root, ids[2]) === '#3');
  check('demo header wording unchanged', textOf(byTestId(root, 'text-leaderboard-scope')!).startsWith("Ranked over each patient's full program to date") && !byTestId(root, 'text-leaderboard-definitions'));
  renderer.unmount();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall leaderboard checks passed');
