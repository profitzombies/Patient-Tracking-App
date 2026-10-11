/**
 * Staff leaderboard tab (mobile) — live branch for signed-in staff, a quiet
 * holding frame while signed out (the root layout redirects).
 *
 *   pnpm --filter @workspace/thinnr-mobile run test:leaderboard
 *
 * Renders the REAL app/(tabs)/leaderboard.tsx under react-test-renderer
 * (stubs via tsconfig.leaderboard.json, global fetch scripted) and proves:
 *
 *   - signed in → the live endpoint is called with the session bearer and
 *     never names an office; rows are the server rows ordered by the server
 *     rank for the chosen metric (ties share a rank, podium tint follows the
 *     rank); metric switch re-sorts without a refetch; period and stage
 *     chips refetch; not-rankable count and definitions ride the footer; no
 *     provider chips; no synthetic disclaimer; rows open live records;
 *   - explicit states: loading, error with retry (after the transient
 *     retries), unauthorized without retry, no rankable patients, empty
 *     stage; a live failure never shows seeded rows;
 *   - resolving session → spinner, no seeded rows, no live call;
 *   - signed out → the holding frame: no rows, no chips, no live call;
 *   - signing out mid-session drops the live board.
 */
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LeaderboardRow, OfficeLeaderboardData } from '../lib/office-roster-api';
import { setStubSession, setStubSessionLoadingTicks, setStubRefreshResult } from './leaderboard-stubs/supabase';
import { fetchOfficeLeaderboard } from '../lib/office-roster-api';
import { routerLog } from './provider-training-stubs/expo-router';
import LeaderboardScreen from '../app/(tabs)/leaderboard';
import { verifyLivePatientRecord } from './verify-live-patient-record';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Platform.OS is 'web' under the stub, so screen state persists to localStorage.
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); },
};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const settle = async (ticks = 8) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}
const all = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props.testID === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string): ReactTestInstance | undefined => all(root, id)[0];
const press = async (root: ReactTestInstance, id: string) => {
  const node = one(root, id);
  if (!node) throw new Error(`no testID=${id}`);
  await act(async () => { await node.props.onPress(); });
  await settle();
};
const rowIds = (root: ReactTestInstance) => root
  .findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string' && node.props.testID.startsWith('leaderboard-row-'))
  .map((node) => String(node.props.testID).slice('leaderboard-row-'.length));
const rankOf = (root: ReactTestInstance, id: string) => {
  const row = one(root, `leaderboard-row-${id}`)!;
  return textOf(row).match(/#\d+/)?.[0] ?? '';
};

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

const BOARD: OfficeLeaderboardData = {
  office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics' },
  period: 'program', stage: 'all', asOf: '2026-09-07', windowDays: null,
  rows: [
    row('pat-b', 'Blake Nguyen', 'BN', { poundsLost: 25, percentLost: 10, baselineWeight: 250, latestWeight: 225, goalCompletion: null, ranks: { percent: 1, pounds: 1, goal: 3, adherence: 2 } }),
    row('pat-a', 'Casey Ortiz', 'CO', { ranks: { percent: 1, pounds: 2, goal: 1, adherence: 3 }, adherence: { score: 40, eligibleDays: 30, loggedDays: 10, checkInDays: 10, waterGoalDays: 10, loggedRate: 0.33, checkInRate: 0.33, waterRate: 0.33 } }),
    row('pat-c', 'Devon Reyes', 'DR', { poundsLost: 5, percentLost: 2.5, goalCompletion: 12.5, program: { startDate: '2026-07-01', day: 69, stage: 'maintenance', week: null }, ranks: { percent: 3, pounds: 3, goal: 2, adherence: 1 }, adherence: { score: 95, eligibleDays: 30, loggedDays: 30, checkInDays: 28, waterGoalDays: 25, loggedRate: 1, checkInRate: 0.93, waterRate: 0.83 } }),
  ],
  notRankable: { total: 2, reasons: [{ reason: 'paused', label: 'Paused', count: 1 }, { reason: 'no_weigh_in', label: 'No weigh-in yet', count: 1 }] },
  definitions: {
    adherence: 'Adherence blends three daily habits over the period: 40% logged days, 40% check-in days, 20% water goal days.',
    loss: 'Pounds and percent lost compare the latest weigh-in with the baseline.',
    goal: 'Goal completion is program to date.',
    eligibility: 'Only activated patients with a starting weight and a weigh-in are ranked.',
    ties: 'Ties share a rank.',
  },
};

type Script = { status: number; body: unknown } | { delay: true; status?: number; body?: unknown } | 'network-error';
let requests: Array<{ url: string; auth: string | undefined }> = [];
let script: (url: URL) => Script = () => ({ status: 200, body: BOARD });
let release: (() => void) | null = null;

(globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  requests.push({ url: href, auth: headers.Authorization });
  if (url.pathname !== '/api/office/leaderboard') throw new Error(`unexpected fetch ${href}`);
  const next = script(url);
  if (next === 'network-error') throw new TypeError('fetch failed');
  if ('delay' in next) {
    await new Promise<void>((resolve) => { release = resolve; });
    return new Response(JSON.stringify(next.body ?? BOARD), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
};

async function mount(): Promise<{ renderer: ReactTestRenderer; root: ReactTestInstance }> {
  const client = new QueryClient();
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <LeaderboardScreen />
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root };
}

function reset() {
  requests = [];
  release = null;
  script = () => ({ status: 200, body: BOARD });
  routerLog.length = 0;
  memory.clear();
  setStubRefreshResult(null);
}

const STAFF = { access_token: 'staff-token', user: { id: 'staff-1' } };

async function main() {
  console.log('signed-in staff — live board');
  {
    reset();
    setStubSession(STAFF);
    const { renderer, root } = await mount();
    check('calls the live endpoint with the bearer, default period/stage, and no office', requests.length === 1 && requests[0].url === 'http://api.test/api/office/leaderboard?period=program&stage=all' && requests[0].auth === 'Bearer staff-token', JSON.stringify(requests));
    check('rows are the server rows in % order (tie, then alphabetical)', rowIds(root).join(',') === 'pat-b,pat-a,pat-c', rowIds(root).join(','));
    check('tied rows share #1, third is #3', rankOf(root, 'pat-b') === '#1' && rankOf(root, 'pat-a') === '#1' && rankOf(root, 'pat-c') === '#3', [rankOf(root, 'pat-b'), rankOf(root, 'pat-a'), rankOf(root, 'pat-c')].join(' '));
    const rankBadgeBg = (id: string) => {
      const rowNode = one(root, `leaderboard-row-${id}`)!;
      // The rank Text's colour token is the podium tone (gold/silver/bronze).
      const badge = rowNode.findAll((node) => node.type === 'Text' && /^#\d+$/.test(textOf(node)))[0];
      return JSON.stringify(badge.props.style);
    };
    check('podium tint follows the shared rank (both #1 share the gold tone, #3 bronze)', rankBadgeBg('pat-b') === rankBadgeBg('pat-a') && rankBadgeBg('pat-b') !== rankBadgeBg('pat-c') && rankBadgeBg('pat-b').includes('color'), `${rankBadgeBg('pat-b')} vs ${rankBadgeBg('pat-c')}`);
    check('names and initials come from the server verbatim', textOf(one(root, 'leaderboard-row-pat-a')!).includes('CO') && textOf(one(root, 'leaderboard-row-pat-a')!).includes('Casey Ortiz'));
    check('% metric shows percent and pounds', textOf(one(root, 'leaderboard-metric-pat-a')!) === '10.0%' && textOf(one(root, 'leaderboard-row-pat-a')!).includes('20.0 lbs lost'));
    check('scope line names the office, period and UTC compute date', textOf(one(root, 'leaderboard-live-scope')!) === 'BEACON HILL AESTHETICS — PROGRAM TO DATE — COMPUTED 2026-09-07 UTC', textOf(one(root, 'leaderboard-live-scope')!));
    check('footer separates the not-rankable count with reasons', textOf(one(root, 'leaderboard-live-counts')!) === '3 ranked  ·  2 not yet rankable · Paused 1 · No weigh-in yet 1', textOf(one(root, 'leaderboard-live-counts')!));
    check('definitions come from the server', textOf(one(root, 'leaderboard-live-definitions')!).includes('40% logged days') && textOf(one(root, 'leaderboard-live-definitions')!).includes('Ties share a rank.'));
    check('no provider chips, period chips present, no synthetic disclaimer', !one(root, 'provider-filter-all') && Boolean(one(root, 'period-filter-30d')) && !textOf(root).includes('SYNTHETIC DEMO DATA'));
    await press(root, 'leaderboard-row-pat-a');
    check('live rows open the matching live record, never the seeded route',
      routerLog.length === 1 && routerLog[0].method === 'push' && routerLog[0].target === '/office-patient/pat-a',
      JSON.stringify(routerLog));
    check('live row announces a navigation control',
      ['link', 'button'].includes(one(root, 'leaderboard-row-pat-a')!.props.accessibilityRole));

    await press(root, 'pill-adherence');
    check('adherence metric re-sorts by server rank without refetching', rowIds(root).join(',') === 'pat-c,pat-b,pat-a' && requests.length === 1, `${rowIds(root).join(',')} req=${requests.length}`);
    check('adherence cell shows score and habit counts', textOf(one(root, 'leaderboard-metric-pat-c')!) === '95/100' && textOf(one(root, 'leaderboard-row-pat-c')!).includes('log 30 · chk 28 · h2o 25 of 30d'), textOf(one(root, 'leaderboard-row-pat-c')!));
    await press(root, 'pill-goal');
    check('goal metric: no-goal row trails with a dash, never 0%', rowIds(root).join(',') === 'pat-a,pat-c,pat-b' && textOf(one(root, 'leaderboard-metric-pat-b')!) === '—' && textOf(one(root, 'leaderboard-row-pat-b')!).includes('no goal weight set'));
    await press(root, 'pill-pounds');
    check('pounds metric orders by pounds rank', rowIds(root).join(',') === 'pat-b,pat-a,pat-c' && textOf(one(root, 'leaderboard-metric-pat-b')!) === '25.0 lbs');

    await press(root, 'period-filter-30d');
    check('period chip refetches with period=30d', requests[requests.length - 1].url.endsWith('?period=30d&stage=all') && textOf(one(root, 'leaderboard-live-scope')!).includes('LAST 30 DAYS'), requests.map((r) => r.url).join(' | '));
    await press(root, 'stage-filter-maintenance');
    check('stage chip refetches server-side', requests[requests.length - 1].url.endsWith('?period=30d&stage=maintenance'), requests.map((r) => r.url).join(' | '));

    // Signing out mid-session drops the live board; nothing seeded replaces it.
    await act(async () => { setStubSession(null); });
    await settle();
    check('signing out drops the live board (no rows, no chips, holding frame)', rowIds(root).length === 0 && Boolean(one(root, 'leaderboard-signed-out')) && !one(root, 'provider-filter-all') && !one(root, 'period-filter-30d'));
    renderer.unmount();
  }

  console.log('\nleaderboard account handoff during a pending 401');
  {
    reset();
    setStubSession(STAFF);
    script = () => ({ delay: true, status: 401, body: { error: 'Expired' } });
    const { renderer, root } = await mount();
    const releaseOldRequest = release;
    const OTHER = { access_token: 'other-token', user: { id: 'staff-2' } };
    const otherBoard = { ...BOARD, rows: [{ ...BOARD.rows[0], id: 'other-patient', name: 'Other Office Patient' }] };
    setStubRefreshResult(OTHER);
    script = () => ({ status: 200, body: otherBoard });
    await act(async () => setStubSession(OTHER));
    await settle();
    check('second account gets its own board', rowIds(root).join(',') === 'other-patient');
    await act(async () => { releaseOldRequest?.(); });
    await settle();
    check('old 401 cannot retry using the replacement account bearer', requests.length === 2);
    script = () => ({ status: 200, body: BOARD });
    await act(async () => setStubSession(STAFF));
    await settle();
    check('returning to the first account never renders replacement-account PHI',
      rowIds(root).join(',') === 'pat-b,pat-a,pat-c' && !textOf(root).includes('Other Office Patient') && requests[requests.length - 1].auth === 'Bearer staff-token');
    await act(async () => renderer.unmount());

    // Also pin the narrow refresh race: the session changes inside refreshSession,
    // after the pre-refresh identity check but before a retry can be issued.
    reset();
    setStubSession(STAFF);
    setStubRefreshResult(OTHER);
    script = () => ({ status: 401, body: { error: 'Expired' } });
    let rejected = false;
    try { await fetchOfficeLeaderboard({ period: 'program', stage: 'all' }, { userId: STAFF.user.id }); }
    catch (error) { rejected = error instanceof Error && error.message.includes('session changed'); }
    check('refresh result must still match the query owner before retrying', rejected && requests.length === 1);
  }

  console.log('\nsigned-in staff — explicit states');
  {
    reset();
    setStubSession(STAFF);
    script = () => ({ delay: true });
    const pending = await mount();
    check('loading state while the ranking is in flight (no rows, no disclaimer)', Boolean(one(pending.root, 'leaderboard-live-loading')) && rowIds(pending.root).length === 0 && !textOf(pending.root).includes('SYNTHETIC'));
    await act(async () => { release?.(); });
    await settle();
    check('rows replace the loading state', rowIds(pending.root).length === 3 && !one(pending.root, 'leaderboard-live-loading'));
    pending.renderer.unmount();

    reset();
    setStubSession(STAFF);
    script = () => ({ status: 502, body: { error: 'The leaderboard could not be computed right now.' } });
    const failed = await mount();
    check('5xx keeps loading through its transient retries', Boolean(one(failed.root, 'leaderboard-live-loading')) && requests.length === 1, `req=${requests.length}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3300)); });
    await settle();
    const error = one(failed.root, 'leaderboard-live-error');
    check('502 → explicit error with the server message and retry (3 requests)', Boolean(error) && textOf(error!).includes('could not be computed') && Boolean(one(failed.root, 'leaderboard-live-retry')) && requests.length === 3, error ? `${textOf(error)} req=${requests.length}` : 'no error node');
    check('a live failure never falls back to seeded rows', rowIds(failed.root).length === 0 && !textOf(failed.root).includes('SYNTHETIC'));
    script = () => ({ status: 200, body: BOARD });
    await press(failed.root, 'leaderboard-live-retry');
    check('retry refetches and renders the rows', rowIds(failed.root).length === 3, `rows=${rowIds(failed.root).length}`);
    failed.renderer.unmount();

    reset();
    setStubSession(STAFF);
    script = () => 'network-error';
    const offline = await mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3300)); });
    await settle();
    const offlineError = one(offline.root, 'leaderboard-live-error');
    check('network failure → the client\'s connection wording, with retry', Boolean(offlineError) && textOf(offlineError!).includes('Couldn’t reach the roster service') && Boolean(one(offline.root, 'leaderboard-live-retry')), offlineError ? textOf(offlineError) : 'none');
    offline.renderer.unmount();

    reset();
    setStubSession(STAFF);
    script = () => ({ status: 403, body: { error: 'Your HQ role does not have permission to do this.' } });
    const denied = await mount();
    const deniedNode = one(denied.root, 'leaderboard-live-error');
    check('403 → unauthorized wording, no retry, no automatic retries, no seeded rows', Boolean(deniedNode) && textOf(deniedNode!).includes("don't have access") && !one(denied.root, 'leaderboard-live-retry') && requests.length === 1 && rowIds(denied.root).length === 0, deniedNode ? `${textOf(deniedNode)} req=${requests.length}` : 'none');
    denied.renderer.unmount();

    reset();
    setStubSession(STAFF);
    script = () => ({ status: 401, body: { error: 'Sign in required.' } });
    const expired = await mount();
    const expiredNode = one(expired.root, 'leaderboard-live-error');
    check('401 (after the refresh hop) → unauthorized wording, never the demo board', Boolean(expiredNode) && textOf(expiredNode!).includes("don't have access") && !textOf(expired.root).includes('SYNTHETIC'), expiredNode ? textOf(expiredNode) : 'none');
    expired.renderer.unmount();

    reset();
    setStubSession(STAFF);
    script = () => ({ status: 200, body: { ...BOARD, rows: [], notRankable: { total: 3, reasons: [{ reason: 'no_weigh_in', label: 'No weigh-in yet', count: 3 }] } } });
    const empty = await mount();
    check('no rankable patients → explicit empty state naming the reason count', Boolean(one(empty.root, 'leaderboard-live-empty')) && textOf(one(empty.root, 'leaderboard-live-empty')!).includes('No rankable patients yet') && textOf(one(empty.root, 'leaderboard-live-counts')!).includes('3 not yet rankable'));
    empty.renderer.unmount();

    reset();
    setStubSession(STAFF);
    script = () => ({ status: 200, body: { ...BOARD, rows: [], notRankable: { total: 0, reasons: [] } } });
    const none = await mount();
    check('no patients at all → distinct wording', textOf(one(none.root, 'leaderboard-live-empty')!).includes('No patients to rank yet'));
    await press(none.root, 'stage-filter-protocol');
    check('empty stage → stage wording', textOf(one(none.root, 'leaderboard-live-empty')!).includes('No patients in this stage'));
    none.renderer.unmount();
  }

  console.log('\nresolving session');
  {
    reset();
    setStubSession(STAFF);
    setStubSessionLoadingTicks(1);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={new QueryClient()}>
          <LeaderboardScreen />
        </QueryClientProvider>,
      );
    });
    const root = renderer!.root;
    check('while the session resolves: spinner, no seeded rows, no live call', Boolean(one(root, 'leaderboard-session-loading')) && rowIds(root).length === 0 && requests.length === 0);
    await settle();
    check('once resolved as signed in, the live board loads (no demo flash)', rowIds(root).join(',') === 'pat-b,pat-a,pat-c' && requests.length === 1, rowIds(root).join(','));
    renderer!.unmount();
  }

  console.log('\nsigned out');
  {
    reset();
    setStubSession(null);
    const { renderer, root } = await mount();
    const requestsBefore = requests.length;
    check('signed out renders the holding frame: no rows, no chips, no live call', rowIds(root).length === 0 && Boolean(one(root, 'leaderboard-signed-out')) && !one(root, 'provider-filter-all') && !one(root, 'period-filter-30d') && requestsBefore === 0, `rows=${rowIds(root).length} req=${requests.length}`);
    check('signed out never navigates', routerLog.length === 0, JSON.stringify(routerLog));
    renderer.unmount();
  }

  failures += await verifyLivePatientRecord();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall mobile leaderboard checks passed');
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
