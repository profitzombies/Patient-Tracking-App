/**
 * HQ System health panel + "file unavailable" state.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:system-health
 *
 * Rendered against the REAL pages under react-test-renderer (session /
 * scope / HQ-directory contexts stubbed via tsconfig.system-health.json,
 * global fetch scripted):
 *
 *   System health (HQ Admin)
 *     - every job renders with its status chip (healthy / failing / stale /
 *       never ran / running / on demand), last success + counts, last failure
 *       + error, retry/backoff line, and recent item failures;
 *     - the summary tiles count failing, stale-or-never-ran, running, healthy;
 *     - "Run now" posts to the job's run endpoint without dryRun, "Dry run"
 *       posts with dryRun:true, and a 202 answer keeps the page polling;
 *     - a 409 (lease held elsewhere) surfaces as a toast, not a crash;
 *     - the patient-only job offers no buttons;
 *     - the recent-runs table lists runs newest first with trigger + counts;
 *     - a 502 from the ledger renders the error notice, never an empty
 *       healthy-looking board;
 *     - the demo persona sees the unavailable note and makes no request.
 *     - the patient push outbox tiles show backlog size, oldest due age, and
 *       in-flight rows; an unreadable outbox shows dashes and a notice, never
 *       zeros.
 *
 *   (The HQ Files page has its own suites: test:files / test:office-files.)
 *
 * Pure half: the status → label/class mapping and the counts formatter.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import SystemHealth, { STATUS_LABEL, formatAge, formatCounts, statusClass } from '../src/pages/admin/SystemHealth';
import { useToast } from '../src/hooks/use-toast';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.location ??= { assign: () => {} };

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

// ─── Fixture ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const HOUR = 3_600_000;

function job(name: string, overrides: Record<string, unknown>) {
  return {
    name,
    title: name.replace(/-/g, ' '),
    description: `${name} description`,
    intervalMs: HOUR,
    schedule: 'Every hour',
    status: 'ok',
    running: false,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    lastStartedAt: hoursAgo(0.5),
    lastFinishedAt: hoursAgo(0.5),
    lastStatus: 'succeeded',
    lastSuccessAt: hoursAgo(0.5),
    lastSuccessCounts: { scanned: 12, deleted: 4 },
    lastFailureAt: null,
    lastError: null,
    recentFailures: [],
    ...overrides,
  };
}

let jobs = [
  job('abandoned-uploads', {}),
  job('reconcile-storage', {
    intervalMs: 6 * HOUR, schedule: 'Every 6 hours', status: 'failing', consecutiveFailures: 2, lastStatus: 'failed',
    lastFailureAt: hoursAgo(1), lastError: '2 items failed', nextEligibleAt: new Date(NOW + 600_000).toISOString(),
    lastSuccessAt: hoursAgo(13), lastSuccessCounts: { objects: 900, orphansDeleted: 1 },
    recentFailures: [
      { item: '/objects/hq-files/f1/file-x', error: 'storage returned 503', occurredAt: hoursAgo(1) },
      { item: '/objects/hq-files/f2/file-y', error: 'storage returned 503', occurredAt: hoursAgo(1) },
    ],
  }),
  job('retention-chat', { intervalMs: 24 * HOUR, schedule: 'Every day', status: 'stale', lastSuccessAt: hoursAgo(100), lastStartedAt: hoursAgo(100), lastFinishedAt: hoursAgo(100) }),
  job('retention-audit', { intervalMs: 24 * HOUR, schedule: 'Every day', status: 'never_ran', lastStatus: null, lastSuccessAt: null, lastStartedAt: null, lastFinishedAt: null, lastSuccessCounts: null }),
  job('retention-exports', { intervalMs: 15 * 60_000, schedule: 'Every 15 minutes', status: 'running', running: true, lastStartedAt: hoursAgo(0.01) }),
  job('patient-media-cleanup', { intervalMs: null, schedule: 'On demand', status: 'on_demand', lastSuccessCounts: { requested: 1, rowsRemoved: 1 } }),
];

const recentRuns = [
  { id: 'run-3', jobName: 'reconcile-storage', trigger: 'schedule', dryRun: false, status: 'failed', owner: 'api:1', startedAt: hoursAgo(1), finishedAt: hoursAgo(1), counts: { objects: 900 }, failureCount: 2, error: '2 items failed' },
  { id: 'run-2', jobName: 'patient-media-cleanup', trigger: 'user', dryRun: false, status: 'succeeded', owner: 'api:1', startedAt: hoursAgo(2), finishedAt: hoursAgo(2), counts: { requested: 1, rowsRemoved: 1 }, failureCount: 0, error: null },
  { id: 'run-1', jobName: 'abandoned-uploads', trigger: 'manual', dryRun: true, status: 'succeeded', owner: 'api:1', startedAt: hoursAgo(3), finishedAt: hoursAgo(3), counts: {}, failureCount: 0, error: null },
];

let healthStatus = 200;
type OutboxFixture = { due: number; oldestDueAt: string | null; oldestDueAgeMs: number | null; inFlight: number } | null;
let outbox: OutboxFixture = { due: 4200, oldestDueAt: new Date(NOW - 12 * 60_000).toISOString(), oldestDueAgeMs: 12 * 60_000, inFlight: 200 };
let runAnswer: (name: string, dryRun: boolean) => { status: number; body: unknown } = (name, dryRun) => ({
  status: 200,
  body: { run: { id: 'run-9', jobName: name, trigger: 'manual', dryRun, status: 'succeeded', owner: 'api:1', startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString(), counts: dryRun ? { wouldDelete: 3 } : { deleted: 3 }, failureCount: 0, error: null } },
});

const requests: Array<{ url: string; method: string; body: unknown }> = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null;
  requests.push({ url, method, body });
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  const run = /\/api\/hq\/system-health\/jobs\/([^/]+)\/run$/.exec(url);
  if (run && method === 'POST') {
    const answer = runAnswer(decodeURIComponent(run[1]), body?.dryRun === true);
    return json(answer.body, answer.status);
  }
  if (url.includes('/api/hq/system-health')) {
    if (healthStatus !== 200) return json({ error: 'Could not load system health right now.' }, healthStatus);
    return json({ asOf: new Date(NOW).toISOString(), jobs, recentRuns, outbox });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

/** DOM-free stand-in for the Radix Toaster: renders each toast's title and description as plain text. */
function ToastList() {
  const { toasts } = useToast();
  return (
    <ul data-testid="toast-list">
      {toasts.map((t) => (
        <li key={t.id} data-testid={`toast-${t.variant ?? 'default'}`}>{String(t.title ?? '')} {String(t.description ?? '')}</li>
      ))}
    </ul>
  );
}

async function render(path: string, element: React.ReactElement) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={loc.hook}>
          {element}
          <ToastList />
        </Router>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root, loc };
}

// ─── Pure half ───────────────────────────────────────────────────────────────

console.log('status mapping and counts formatter');
{
  check('every status has a label', (['ok', 'failing', 'stale', 'never_ran', 'running', 'on_demand'] as const).every((s) => STATUS_LABEL[s].length > 0));
  check('failing is the only destructive chip', statusClass('failing').includes('text-destructive') && !statusClass('stale').includes('text-destructive') && !statusClass('ok').includes('text-destructive'));
  check('stale and never_ran share the warning chip', statusClass('stale') === statusClass('never_ran'));
  check('counts sort by key and read in words', formatCounts({ scanned: 12, deleted: 4, missing_flagged: 1, rowsRemoved: 2 }) === 'deleted 4 · missing flagged 1 · rows removed 2 · scanned 12');
  check('empty counts read as nothing to do; null as a dash', formatCounts({}) === 'nothing to do' && formatCounts(null) === '—');
}

// ─── System health ───────────────────────────────────────────────────────────

console.log('\nsystem health: admin board');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin' });
  __setHqData({ accounts: [] });
  __setSupabaseSession('hq-token');
  const { root } = await render('/admin/system-health', <SystemHealth />);
  check('summary tiles count failing / stale-or-never / running / healthy',
    textOf(byTestId(root, 'metric-jobs-failing')[0]) === '1' && textOf(byTestId(root, 'metric-jobs-stale')[0]) === '2' && textOf(byTestId(root, 'metric-jobs-running')[0]) === '1' && textOf(byTestId(root, 'metric-jobs-healthy')[0]) === '1',
    `${textOf(byTestId(root, 'metric-jobs-failing')[0])}/${textOf(byTestId(root, 'metric-jobs-stale')[0])}/${textOf(byTestId(root, 'metric-jobs-running')[0])}/${textOf(byTestId(root, 'metric-jobs-healthy')[0])}`);
  check('every job renders a card', jobs.every((j) => byTestId(root, `job-${j.name}`).length === 1));
  const chip = (name: string) => textOf(byTestId(root, `chip-job-status-${name}`)[0]);
  check('status chips read healthy / failing / stale / never ran / running / on demand',
    chip('abandoned-uploads') === 'Healthy' && chip('reconcile-storage') === 'Failing' && chip('retention-chat') === 'Stale' && chip('retention-audit') === 'Never ran' && chip('retention-exports') === 'Running' && chip('patient-media-cleanup') === 'On demand');
  check('healthy job shows its last success time and counts', textOf(byTestId(root, 'text-job-last-success-abandoned-uploads')[0]).includes('ago') && textOf(byTestId(root, 'text-job-last-counts-abandoned-uploads')[0]) === 'deleted 4 · scanned 12');
  const failing = byTestId(root, 'job-reconcile-storage')[0];
  check('failing job shows last failure, last error, backoff, and both item failures',
    textOf(byTestId(root, 'text-job-last-error-reconcile-storage')[0]) === '2 items failed'
      && textOf(byTestId(root, 'text-job-retries-reconcile-storage')[0]).includes('2 consecutive failures') && textOf(byTestId(root, 'text-job-retries-reconcile-storage')[0]).includes('next try')
      && byTestId(root, 'list-job-failures-reconcile-storage').length === 1 && textOf(failing).includes('/objects/hq-files/f1/file-x') && textOf(failing).includes('/objects/hq-files/f2/file-y') && textOf(failing).includes('storage returned 503'));
  check('never-ran job reads Never with no failure', textOf(byTestId(root, 'text-job-last-success-retention-audit')[0]) === 'Never' && textOf(byTestId(root, 'text-job-last-failure-retention-audit')[0]) === 'None recorded');
  check('running job disables both buttons', byTestId(root, 'button-run-now-retention-exports')[0].props.disabled === true && byTestId(root, 'button-dry-run-retention-exports')[0].props.disabled === true);
  check('the patient-only job offers no buttons', byTestId(root, 'button-run-now-patient-media-cleanup').length === 0 && byTestId(root, 'button-dry-run-patient-media-cleanup').length === 0 && byTestId(root, 'text-job-user-only-patient-media-cleanup').length === 1);
  const rows = root.findAll((node) => node.type === 'tr' && typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('row-run-'));
  check('recent runs list newest first with trigger, dry-run marker, and counts',
    rows.map((r) => r.props['data-testid']).join(',') === 'row-run-run-3,row-run-run-2,row-run-run-1'
      && textOf(rows[0]).includes('Scheduled') && textOf(rows[0]).includes('Failed — 2 items failed')
      && textOf(rows[1]).includes('User action') && textOf(rows[1]).includes('requested 1 · rows removed 1')
      && textOf(rows[2]).includes('Run now · dry run') && textOf(rows[2]).includes('nothing to do'));

  // Run now → POST without dryRun, toast with counts, health refetched.
  const before = requests.length;
  await act(async () => { byTestId(root, 'button-run-now-abandoned-uploads')[0].props.onClick(); });
  await settle();
  const runPosts = requests.slice(before).filter((r) => r.method === 'POST' && r.url.includes('/system-health/jobs/abandoned-uploads/run'));
  check('Run now posts once to the job endpoint without dryRun', runPosts.length === 1 && runPosts[0].body?.dryRun !== true, JSON.stringify(runPosts.map((r) => r.body)));
  check('the health board is refetched after the run', requests.slice(before).some((r) => r.method === 'GET' && r.url.includes('/api/hq/system-health')));
  check('a toast reports the finished run with its counts', textOf(root).includes('Job finished') && textOf(root).includes('deleted 3'));

  // Dry run → dryRun:true.
  const beforeDry = requests.length;
  await act(async () => { byTestId(root, 'button-dry-run-retention-chat')[0].props.onClick(); });
  await settle();
  const dryPosts = requests.slice(beforeDry).filter((r) => r.method === 'POST' && r.url.includes('/system-health/jobs/retention-chat/run'));
  check('Dry run posts with dryRun:true and reports would-delete counts', dryPosts.length === 1 && dryPosts[0].body?.dryRun === true && textOf(root).includes('Dry run finished') && textOf(root).includes('would delete 3'));

  // 202 → started toast; 409 → not-started toast with the server message.
  runAnswer = () => ({ status: 202, body: { status: 'running', startedAt: new Date(NOW).toISOString() } });
  await act(async () => { byTestId(root, 'button-run-now-retention-audit')[0].props.onClick(); });
  await settle();
  check('a 202 answer reads as started and keeps polling', textOf(root).includes('Job started') && textOf(root).includes('still running'));
  runAnswer = () => ({ status: 409, body: { error: 'That job is already running.' } });
  await act(async () => { byTestId(root, 'button-run-now-abandoned-uploads')[0].props.onClick(); });
  await settle();
  check('a 409 answer surfaces the server reason without crashing', textOf(root).includes('not started') && textOf(root).includes('That job is already running.') && byTestId(root, 'system-health-jobs').length === 1);
}

console.log('\nsystem health: push outbox backlog');
{
  const { root } = await render('/admin/system-health', <SystemHealth />);
  check('backlog size, oldest due age, and in-flight rows are shown',
    textOf(byTestId(root, 'metric-outbox-due')[0]) === '4,200' && textOf(byTestId(root, 'metric-outbox-oldest-age')[0]) === '12m' && textOf(byTestId(root, 'metric-outbox-in-flight')[0]) === '200',
    `${textOf(byTestId(root, 'metric-outbox-due')[0])} / ${textOf(byTestId(root, 'metric-outbox-oldest-age')[0])} / ${textOf(byTestId(root, 'metric-outbox-in-flight')[0])}`);
  check('a twelve-minute oldest age reads as the drain falling behind', textOf(byTestId(root, 'system-health-outbox')[0]).includes('Drain is behind') && byTestId(root, 'text-outbox-unreadable').length === 0);
  check('formatAge covers seconds, minutes, hours, and days',
    formatAge(12_000) === '12s' && formatAge(4 * 60_000) === '4m' && formatAge(2 * 3_600_000 + 5 * 60_000) === '2h 05m' && formatAge(3 * 86_400_000 + 4 * 3_600_000) === '3d 4h' && formatAge(null) === '—');

  outbox = { due: 0, oldestDueAt: null, oldestDueAgeMs: null, inFlight: 0 };
  const idle = await render('/admin/system-health', <SystemHealth />);
  check('an empty outbox shows zeros with a dash for the age', textOf(byTestId(idle.root, 'metric-outbox-due')[0]) === '0' && textOf(byTestId(idle.root, 'metric-outbox-oldest-age')[0]) === '—' && textOf(byTestId(idle.root, 'system-health-outbox')[0]).includes('Nothing waiting'));

  outbox = null;
  const unreadable = await render('/admin/system-health', <SystemHealth />);
  check('an unreadable outbox shows dashes and a notice, never zeros',
    textOf(byTestId(unreadable.root, 'metric-outbox-due')[0]) === '—' && textOf(byTestId(unreadable.root, 'metric-outbox-in-flight')[0]) === '—' && byTestId(unreadable.root, 'text-outbox-unreadable').length === 1
      && byTestId(unreadable.root, 'job-retention-chat').length === 1);
  outbox = { due: 4200, oldestDueAt: new Date(NOW - 12 * 60_000).toISOString(), oldestDueAgeMs: 12 * 60_000, inFlight: 200 };
}

console.log('\nsystem health: ledger unavailable');
{
  healthStatus = 502;
  const { root } = await render('/admin/system-health', <SystemHealth />);
  check('a 502 renders the error notice and no job cards', byTestId(root, 'text-system-health-error').length === 1 && root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('job-')).length === 0);
  check('tiles show dashes rather than zeros', textOf(byTestId(root, 'metric-jobs-failing')[0]) === '—' && textOf(byTestId(root, 'metric-jobs-healthy')[0]) === '—' && textOf(byTestId(root, 'metric-outbox-due')[0]) === '—');
  healthStatus = 200;
}

console.log('\nsystem health: demo persona and non-admin role');
{
  const before = requests.length;
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  __setSupabaseSession(null);
  const demo = await render('/admin/system-health', <SystemHealth />);
  check('demo note shown, no board, no request', byTestId(demo.root, 'text-system-health-demo-note').length === 1 && byTestId(demo.root, 'system-health-summary').length === 0 && requests.length === before);
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-2' }, hqRole: 'Content' });
  __setSupabaseSession('hq-token');
  const content = await render('/admin/system-health', <SystemHealth />);
  check('a Content role sees the role note and makes no request', textOf(byTestId(content.root, 'text-system-health-demo-note')[0]).includes('role') && requests.length === before);
}

console.log(failures === 0 ? '\nall system-health checks passed' : `\n${failures} system-health check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
