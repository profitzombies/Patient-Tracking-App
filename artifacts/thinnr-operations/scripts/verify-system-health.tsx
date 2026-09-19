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
 *     - the demo persona sees the unavailable note and makes no request;
 *     - the External trigger card: a fresh tick reads Ticking, a stale
 *       tick on a server with no timers of its own raises the red warning,
 *       the same gap with timers running is only a note, and a missing
 *       tick reads Never reached.
 *     - the patient push outbox tiles show backlog size, oldest due age, and
 *       in-flight rows; an unreadable outbox shows dashes and a notice, never
 *       zeros.
 *
 *   Login codes per active patient (verification cost)
 *     - this month's tiles and the per-month table come straight from the
 *       API's patientSignIns; a month with no active patients shows a dash;
 *     - a null metric (ledger unreadable) reads as unavailable, never zero.
 *
 *   (The HQ Files page has its own suite, scripts/verify-files.tsx, which
 *   owns the missing-file behaviour that used to be checked here.)
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
import SystemHealth, { STATUS_LABEL, externalTriggerSeverity, formatAge, formatCounts, monthLabel, ratioLabel, statusClass } from '../src/pages/admin/SystemHealth';
import { useToast } from '../src/hooks/use-toast';
import { formatBytes, formatDelta, formatMs } from '../src/pages/admin/SystemPerformance';

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

const tickAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const tick = (kind: 'jobs' | 'notifications', minutes: number | null, extra: Record<string, unknown> = {}) => ({
  kind,
  status: minutes === null ? 'never' : minutes > 5 ? 'stale' : 'ok',
  lastAt: minutes === null ? null : tickAgo(minutes),
  owner: minutes === null ? null : 'api-1:42:abcd',
  lastResult: minutes === null ? null : 'succeeded',
  summary: minutes === null ? null : kind === 'jobs' ? { jobsDue: 2, jobsRan: 2, officeExports: 1, patientExports: 0, purges: 0, drainFailures: 0 } : { outboxSent: 3, outboxClaimed: 3 },
  error: null,
  ...extra,
});
let externalTrigger: Record<string, unknown> = {
  staleAfterMs: 300_000,
  inProcessTimers: { jobs: false, notifications: false },
  ticks: [tick('jobs', 1), tick('notifications', 2)],
};

let healthStatus = 200;
type OutboxFixture = { due: number; oldestDueAt: string | null; oldestDueAgeMs: number | null; inFlight: number } | null;
let outbox: OutboxFixture = { due: 4200, oldestDueAt: new Date(NOW - 12 * 60_000).toISOString(), oldestDueAgeMs: 12 * 60_000, inFlight: 200 };
type WarehouseSyncFixture = {
  last_success_at: string | null; last_poll_at: string | null; last_error: string | null; last_window: { start: string; end: string } | null;
  rows_seen_24h: number; transitions_24h: number; errors_24h: number; polls_24h: number; failed_polls_24h: number;
  stalled: boolean; stalled_after_minutes: number; back_ordered: number; awaiting_tracking: number;
} | null | undefined;
type WarehouseFixture = { pending: number; due: number; sent24h: number; failed24h: number; retries24h: number; needs_attention: number; auto_submit: boolean; recent_failures: Array<{ order_id: string; order_number: string | null; error: string | null; at: string | null; state: 'pending' | 'sent' | 'needs_attention' | 'skipped' }>; sync?: WarehouseSyncFixture } | null | undefined;
const healthySync: WarehouseSyncFixture = {
  last_success_at: new Date(NOW - 9 * 60_000).toISOString(), last_poll_at: new Date(NOW - 9 * 60_000).toISOString(), last_error: null,
  last_window: { start: new Date(NOW - 3 * 3_600_000).toISOString(), end: new Date(NOW - 9 * 60_000).toISOString() },
  rows_seen_24h: 118, transitions_24h: 7, errors_24h: 0, polls_24h: 96, failed_polls_24h: 0, stalled: false, stalled_after_minutes: 60, back_ordered: 2, awaiting_tracking: 0,
};
let warehouse: WarehouseFixture = {
  pending: 3, due: 1, sent24h: 41, failed24h: 2, retries24h: 1, needs_attention: 1, auto_submit: true,
  recent_failures: [{ order_id: 'order-77', order_number: 'TH-4Q7K2M', error: 'ItemSKU not recognized: REGULATE-OLD', at: new Date(NOW - 40 * 60_000).toISOString(), state: 'needs_attention' }],
  sync: healthySync,
};
let runAnswer: (name: string, dryRun: boolean) => { status: number; body: unknown } = (name, dryRun) => ({
  status: 200,
  body: { run: { id: 'run-9', jobName: name, trigger: 'manual', dryRun, status: 'succeeded', owner: 'api:1', startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString(), counts: dryRun ? { wouldDelete: 3 } : { deleted: 3 }, failureCount: 0, error: null } },
});

const family = (name: string, p95Ms: number, requests: number, level: 'ok' | 'amber' | 'red', extra: Partial<Record<string, unknown>> = {}) => ({
  family: name, streaming: false, requests, errors: 0, dbShare: 1, aiShare: 0, meanMs: p95Ms / 2, p50Ms: Math.round(p95Ms / 3), p95Ms, maxMs: p95Ms * 2, level, ...extra,
});
const statement = (id: string, query: string, calls: number, totalMs: number, meanMs: number) => ({ queryId: id, role: 'authenticator', query, calls, totalMs, meanMs, maxMs: meanMs * 3, rows: calls * 4, sharedBlocksRead: 12 });
const MB = 1024 * 1024;
const thresholdConfig = {
  latency: { defaultAmberMs: 1500, defaultRedMs: 4000, streamingAmberMs: 20_000, streamingRedMs: 45_000, minRequests: 20 },
  dbGrowth: { amberBytesPerDay: 250 * MB, redBytesPerDay: 1024 * MB },
  storageGrowth: { amberBytesPerDay: 2048 * MB, redBytesPerDay: 10240 * MB },
};
type PerformanceFixture = {
  asOf: string;
  latency: { lastHour: { since: string; families: ReturnType<typeof family>[] }; lastDay: { since: string; families: ReturnType<typeof family>[] } } | null;
  slowStatements: { statsResetAt: string | null; byTotal: ReturnType<typeof statement>[]; byMean: ReturnType<typeof statement>[] } | null;
  growth: Record<string, unknown> | null;
  thresholds: { level: 'ok' | 'amber' | 'red'; config: typeof thresholdConfig; findings: Array<Record<string, unknown>> };
};
const healthyPerformance = (): PerformanceFixture => ({
  asOf: new Date(NOW).toISOString(),
  latency: {
    lastHour: { since: new Date(NOW - 3_600_000).toISOString(), families: [family('office/roster', 1840, 63, 'amber'), family('health', 12, 400, 'ok'), family('coach/chat', 9_000, 30, 'ok', { streaming: true, aiShare: 1 }), family('patient/diary', 6_000, 3, 'ok')] },
    lastDay: { since: new Date(NOW - 86_400_000).toISOString(), families: [family('office/roster', 900, 1_500, 'ok'), family('health', 10, 9_000, 'ok')] },
  },
  slowStatements: {
    statsResetAt: new Date(NOW - 5 * 86_400_000).toISOString(),
    byTotal: [statement('101', 'SELECT * FROM diary_entries WHERE patient_id = $1', 12_000, 90_000, 7.5), statement('102', 'select hq_request_latency($1)', 80, 12_000, 150)],
    byMean: [statement('102', 'select hq_request_latency($1)', 80, 12_000, 150), statement('101', 'SELECT * FROM diary_entries WHERE patient_id = $1', 12_000, 90_000, 7.5)],
  },
  growth: {
    latestDate: '2026-09-18', previousDate: '2026-09-17',
    database: { bytes: 900 * MB, previousBytes: 600 * MB, deltaBytes: 300 * MB, deltaPercent: 50, bytesPerDay: 300 * MB, level: 'amber' },
    storage: { bytes: 5 * 1024 * MB, previousBytes: 5 * 1024 * MB - 100 * MB, deltaBytes: 100 * MB, deltaPercent: 2, bytesPerDay: 100 * MB, level: 'ok' },
    tables: [
      { name: 'public.diary_entries', totalBytes: 400 * MB, tableBytes: 300 * MB, indexBytes: 100 * MB, rowEstimate: 1_250_000, deltaBytes: 250 * MB },
      { name: 'public.approved_foods', totalBytes: 90 * MB, tableBytes: 60 * MB, indexBytes: 30 * MB, rowEstimate: 129_000, deltaBytes: 0 },
    ],
    storagePrefixes: [{ name: '/objects/patient-media/', bytes: 4 * 1024 * MB, objectCount: 18_400, deltaBytes: 90 * MB }],
    history: [
      { date: '2026-09-16', databaseBytes: 500 * MB, storageBytes: 4_900 * MB },
      { date: '2026-09-17', databaseBytes: 600 * MB, storageBytes: 5_020 * MB },
      { date: '2026-09-18', databaseBytes: 900 * MB, storageBytes: 5_120 * MB },
    ],
  },
  thresholds: {
    level: 'amber', config: thresholdConfig,
    findings: [
      { metric: 'p95_latency', level: 'amber', family: 'office/roster', value: 1840, limit: 1500, message: 'office/roster: p95 1840 ms over the last hour (63 requests) is above the 1500 ms amber limit.' },
      { metric: 'db_growth', level: 'amber', family: null, value: 300 * MB, limit: 250 * MB, message: 'Database grew 300.0 MB per day, above the 250 MB amber limit.' },
    ],
  },
});
let performance: PerformanceFixture = healthyPerformance();
let performanceStatus = 200;

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
  if (url.includes('/api/hq/system-health/performance')) {
    if (performanceStatus !== 200) return json({ error: 'Could not load performance right now.' }, performanceStatus);
    return json(performance);
  }
  if (url.includes('/api/hq/system-health')) {
    if (healthStatus !== 200) return json({ error: 'Could not load system health right now.' }, healthStatus);
    return json({ asOf: new Date(NOW).toISOString(), jobs, recentRuns, outbox, patientSignIns, externalTrigger, warehouse });
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
  const sev = (timers: { jobs: boolean; notifications: boolean }, ticks: Array<ReturnType<typeof tick>>) =>
    externalTriggerSeverity({ staleAfterMs: 300_000, inProcessTimers: timers, ticks } as never);
  check('fresh ticks are ok whatever the timers', sev({ jobs: false, notifications: false }, [tick('jobs', 1), tick('notifications', 4)]) === 'ok');
  check('a stale tick with no in-process timers is a warning', sev({ jobs: false, notifications: false }, [tick('jobs', 9), tick('notifications', 1)]) === 'warning');
  check('a never tick with no in-process timers is a warning', sev({ jobs: true, notifications: false }, [tick('jobs', 1), tick('notifications', null)]) === 'warning');
  check('a stale tick while that timer still runs is only a note', sev({ jobs: true, notifications: true }, [tick('jobs', 9), tick('notifications', null)]) === 'note');
  check('missing health reads ok', externalTriggerSeverity(null) === 'ok' && externalTriggerSeverity(undefined) === 'ok');
}

// ─── System health ───────────────────────────────────────────────────────────

// Login codes per active patient: newest month first, as the API answers.
type SignInMonth = { month: string; smsSignIns: number; patientsWithSmsSignIn: number; newDeviceSmsSignIns: number; signups: number; activePatients: number; smsPerActivePatient: number | null };
const signInMonths: SignInMonth[] = [
  { month: '2026-09-01', smsSignIns: 30, patientsWithSmsSignIn: 12, newDeviceSmsSignIns: 9, signups: 4, activePatients: 120, smsPerActivePatient: 0.25 },
  { month: '2026-08-01', smsSignIns: 3, patientsWithSmsSignIn: 3, newDeviceSmsSignIns: 0, signups: 0, activePatients: 0, smsPerActivePatient: null },
];
let patientSignIns: SignInMonth[] | null = signInMonths;

console.log('\nsystem health: admin board');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin' });
  __setHqData({ accounts: [] });
  __setSupabaseSession('hq-token');
  const { root } = await render('/admin/system-health', <SystemHealth />);
  check('summary tiles count failing / stale-or-never / running / healthy',
    textOf(byTestId(root, 'metric-jobs-failing')[0]) === '1' && textOf(byTestId(root, 'metric-jobs-stale')[0]) === '2' && textOf(byTestId(root, 'metric-jobs-running')[0]) === '1' && textOf(byTestId(root, 'metric-jobs-healthy')[0]) === '1',
    `${textOf(byTestId(root, 'metric-jobs-failing')[0])}/${textOf(byTestId(root, 'metric-jobs-stale')[0])}/${textOf(byTestId(root, 'metric-jobs-running')[0])}/${textOf(byTestId(root, 'metric-jobs-healthy')[0])}`);
  check('login-code tiles show this month: codes per active patient, codes, patients, active',
    textOf(byTestId(root, 'metric-sms-per-active-patient')[0]) === '0.25' && textOf(byTestId(root, 'metric-sms-sign-ins')[0]) === '30'
      && textOf(byTestId(root, 'metric-patients-with-sms')[0]) === '12' && textOf(byTestId(root, 'metric-active-patients')[0]) === '120'
      && textOf(byTestId(root, 'verification-cost-summary')[0]).includes('Sep 2026 so far') && textOf(byTestId(root, 'verification-cost-summary')[0]).includes('9 on a new device'),
    textOf(byTestId(root, 'verification-cost-summary')[0]));
  check('the month table lists every month newest first with a dash where nobody was active',
    byTestId(root, 'row-sign-ins-2026-09').length === 1 && byTestId(root, 'row-sign-ins-2026-08').length === 1
      && textOf(byTestId(root, 'text-sms-ratio-2026-09')[0]) === '0.25' && textOf(byTestId(root, 'text-sms-ratio-2026-08')[0]) === '—'
      && textOf(byTestId(root, 'table-verification-cost')[0]).indexOf('Sep 2026') < textOf(byTestId(root, 'table-verification-cost')[0]).indexOf('Aug 2026'));
  check('no unavailable notice while the ledger answers', byTestId(root, 'text-verification-cost-unavailable').length === 0);
  check('month labels do not shift with the timezone', monthLabel('2026-01-01') === 'Jan 2026' && monthLabel('2026-12-01') === 'Dec 2026' && ratioLabel(1) === '1.00' && ratioLabel(null) === '—');
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

console.log('\nsystem health: warehouse submissions');
{
  const { root } = await render('/admin/system-health', <SystemHealth />);
  const tile = (id: string) => textOf(byTestId(root, `metric-warehouse-${id}`)[0]);
  check('the last 24 h of warehouse submissions show sent, failed, retried, waiting and needs-attention counts',
    tile('sent') === '41' && tile('failed') === '2' && tile('retries') === '1' && tile('pending') === '3' && tile('attention') === '1',
    `${tile('sent')} / ${tile('failed')} / ${tile('retries')} / ${tile('pending')} / ${tile('attention')}`);
  check('a due intent and an open rejection read as work to do', textOf(byTestId(root, 'system-health-warehouse')[0]).includes('1 due now') && textOf(byTestId(root, 'system-health-warehouse')[0]).includes('Fix and retry in Fulfillment'));
  const failure = byTestId(root, 'warehouse-failure-order-77')[0];
  const failureLink = failure?.findAll((node: any) => node.type === 'a')[0];
  check('recent failures list the order number, the warehouse message, and link to Fulfillment',
    Boolean(failure) && textOf(failure).includes('TH-4Q7K2M') && textOf(failure).includes('ItemSKU not recognized: REGULATE-OLD') && failureLink?.props.href === '/admin/payments/fulfillment',
    failure ? textOf(failure) : '(no failure row)');
  check('auto-submit on shows no paused notice', byTestId(root, 'text-warehouse-paused').length === 0 && byTestId(root, 'text-warehouse-unreadable').length === 0);

  const syncTile = (id: string) => textOf(byTestId(root, `metric-warehouse-sync-${id}`)[0]);
  const syncText = textOf(byTestId(root, 'system-health-warehouse-sync')[0]);
  check('the status feed shows rows seen, transitions applied and row errors for the last 24 h, with the last poll time',
    syncTile('rows') === '118' && syncTile('transitions') === '7' && syncTile('errors') === '0' && syncTile('last-poll') === 'Sep 18, 2026 22:09' && syncText.includes('96 in 24 h') && syncText.includes('No failed polls') && byTestId(root, 'text-warehouse-sync-stalled').length === 0,
    `${syncTile('rows')} / ${syncTile('transitions')} / ${syncTile('errors')} / ${syncTile('last-poll')}`);
  check('back-ordered orders at the warehouse are counted under the feed', textOf(byTestId(root, 'text-warehouse-sync-flags')[0]) === '2 back-ordered at the warehouse');

  warehouse = { ...warehouse!, sync: { ...healthySync!, last_success_at: new Date(NOW - 95 * 60_000).toISOString(), last_poll_at: new Date(NOW - 4 * 60_000).toISOString(), last_error: 'WarehouseCraft 503', failed_polls_24h: 6, stalled: true, back_ordered: 0, awaiting_tracking: 1 } };
  const stalled = await render('/admin/system-health', <SystemHealth />);
  check('a stalled feed shows an alert naming the threshold and the last error, and the last-success tile says so',
    byTestId(stalled.root, 'text-warehouse-sync-stalled').length === 1 && textOf(byTestId(stalled.root, 'text-warehouse-sync-stalled')[0]).includes('over 60 minutes') && textOf(byTestId(stalled.root, 'text-warehouse-sync-stalled')[0]).includes('WarehouseCraft 503')
      && textOf(byTestId(stalled.root, 'system-health-warehouse-sync')[0]).includes('Feed stalled') && textOf(byTestId(stalled.root, 'text-warehouse-sync-flags')[0]) === '1 shipped without a tracking number yet',
    textOf(byTestId(stalled.root, 'text-warehouse-sync-stalled')[0]));

  warehouse = { ...warehouse!, sync: null };
  const syncUnreadable = await render('/admin/system-health', <SystemHealth />);
  check('an unreadable poll ledger shows dashes and a notice, never zeros',
    textOf(byTestId(syncUnreadable.root, 'metric-warehouse-sync-rows')[0]) === '—' && textOf(byTestId(syncUnreadable.root, 'metric-warehouse-sync-last-poll')[0]) === '—' && byTestId(syncUnreadable.root, 'text-warehouse-sync-unreadable').length === 1 && byTestId(syncUnreadable.root, 'text-warehouse-sync-stalled').length === 0);

  warehouse = { pending: 5, due: 5, sent24h: 0, failed24h: 0, retries24h: 0, needs_attention: 0, auto_submit: false, recent_failures: [] };
  const legacy = await render('/admin/system-health', <SystemHealth />);
  check('a payload without the feed block renders no status feed section', byTestId(legacy.root, 'system-health-warehouse-sync').length === 0);
  const paused = await render('/admin/system-health', <SystemHealth />);
  check('the kill switch off shows a paused notice with the queued count, and no failure list',
    byTestId(paused.root, 'text-warehouse-paused').length === 1 && textOf(byTestId(paused.root, 'text-warehouse-paused')[0]).includes('5 paid orders are queued') && byTestId(paused.root, 'list-warehouse-failures').length === 0,
    textOf(byTestId(paused.root, 'text-warehouse-paused')[0]));

  warehouse = null;
  const unreadable = await render('/admin/system-health', <SystemHealth />);
  check('an unreadable submission queue shows dashes and a notice, never zeros',
    textOf(byTestId(unreadable.root, 'metric-warehouse-sent')[0]) === '—' && textOf(byTestId(unreadable.root, 'metric-warehouse-pending')[0]) === '—' && byTestId(unreadable.root, 'text-warehouse-unreadable').length === 1
      && textOf(byTestId(unreadable.root, 'system-health-warehouse')[0]).includes('Queue unreadable'));

  warehouse = undefined;
  const absent = await render('/admin/system-health', <SystemHealth />);
  check('an API without the warehouse field shows dashes with no unreadable alarm',
    textOf(byTestId(absent.root, 'metric-warehouse-sent')[0]) === '—' && byTestId(absent.root, 'text-warehouse-unreadable').length === 0);
  warehouse = { pending: 3, due: 1, sent24h: 41, failed24h: 2, retries24h: 1, needs_attention: 1, auto_submit: true, recent_failures: [] };
}

console.log('\nsystem health: sign-in ledger unreadable');
{
  patientSignIns = null;
  const { root } = await render('/admin/system-health', <SystemHealth />);
  check('a null metric reads as unavailable, never as zero codes',
    byTestId(root, 'text-verification-cost-unavailable').length === 1 && byTestId(root, 'verification-cost-summary').length === 0 && byTestId(root, 'table-verification-cost').length === 0);
  check('job cards still render', byTestId(root, 'job-abandoned-uploads').length === 1);
  patientSignIns = signInMonths;
}

console.log('\nsystem health: external trigger fresh');
{
  const { root } = await render('/admin/system-health', <SystemHealth />);
  check('external trigger card shows both fresh ticks as Ticking with their last time and counts',
    byTestId(root, 'system-health-external-trigger').length === 1
      && textOf(byTestId(root, 'chip-tick-status-jobs')[0]) === 'Ticking' && textOf(byTestId(root, 'chip-tick-status-notifications')[0]) === 'Ticking'
      && textOf(byTestId(root, 'text-tick-last-jobs')[0]).includes('1 minute ago') && textOf(byTestId(root, 'text-tick-detail-jobs')[0]).includes('jobs ran 2')
      && textOf(byTestId(root, 'text-tick-detail-jobs')[0]).includes('office exports 1') && textOf(byTestId(root, 'text-tick-detail-notifications')[0]).includes('outbox sent 3'),
    `${textOf(byTestId(root, 'text-tick-last-jobs')[0])} | ${textOf(byTestId(root, 'text-tick-detail-jobs')[0])}`);
  check('no warning or note while the trigger is fresh', byTestId(root, 'text-external-trigger-warning').length === 0 && byTestId(root, 'text-external-trigger-note').length === 0);
}

console.log('\nsystem health: external trigger stale on autoscale (no in-process timers)');
{
  externalTrigger = { staleAfterMs: 300_000, inProcessTimers: { jobs: false, notifications: false }, ticks: [tick('jobs', 12, { lastResult: 'failed', error: 'ledger unreachable' }), tick('notifications', null)] };
  const { root } = await render('/admin/system-health', <SystemHealth />);
  const warning = byTestId(root, 'text-external-trigger-warning');
  check('a stale jobs tick and a never notifications tick raise the red warning',
    warning.length === 1 && warning[0].props.role === 'alert' && textOf(warning[0]).includes('more than 5 minutes') && byTestId(root, 'text-external-trigger-note').length === 0,
    warning[0] ? textOf(warning[0]) : 'no warning');
  check('chips read Stale and Never reached in the destructive style',
    textOf(byTestId(root, 'chip-tick-status-jobs')[0]) === 'Stale' && textOf(byTestId(root, 'chip-tick-status-notifications')[0]) === 'Never reached'
      && String(byTestId(root, 'chip-tick-status-jobs')[0].props.className).includes('text-destructive'));
  check('a failed last tick shows its error; a never tick reads as not recorded',
    textOf(byTestId(root, 'text-tick-detail-jobs')[0]).includes('Last tick failed') && textOf(byTestId(root, 'text-tick-detail-jobs')[0]).includes('ledger unreachable')
      && textOf(byTestId(root, 'text-tick-last-notifications')[0]) === 'No external tick recorded');
}

console.log('\nsystem health: external trigger stale in development (timers still running)');
{
  externalTrigger = { staleAfterMs: 300_000, inProcessTimers: { jobs: true, notifications: true }, ticks: [tick('jobs', 45), tick('notifications', null)] };
  const { root } = await render('/admin/system-health', <SystemHealth />);
  check('the same gap with in-process timers is a note, not a warning',
    byTestId(root, 'text-external-trigger-warning').length === 0 && byTestId(root, 'text-external-trigger-note').length === 1 && textOf(byTestId(root, 'text-external-trigger-note')[0]).includes('runs its own timers'));
  check('chips use the amber style, not destructive', !String(byTestId(root, 'chip-tick-status-jobs')[0].props.className).includes('text-destructive'));
  externalTrigger = { staleAfterMs: 300_000, inProcessTimers: { jobs: false, notifications: false }, ticks: [tick('jobs', 1), tick('notifications', 2)] };
}

console.log('\nsystem health: ledger unavailable');
{
  healthStatus = 502;
  const { root } = await render('/admin/system-health', <SystemHealth />);
  check('a 502 renders the error notice and no job cards', byTestId(root, 'text-system-health-error').length === 1 && root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('job-')).length === 0);
  check('tiles show dashes rather than zeros', textOf(byTestId(root, 'metric-jobs-failing')[0]) === '—' && textOf(byTestId(root, 'metric-jobs-healthy')[0]) === '—' && textOf(byTestId(root, 'metric-outbox-due')[0]) === '—');
  check('the trigger card shows dashes and no chips or warning without data',
    byTestId(root, 'system-health-external-trigger').length === 1 && textOf(byTestId(root, 'text-tick-last-jobs')[0]) === '—' && byTestId(root, 'chip-tick-status-jobs').length === 0 && byTestId(root, 'text-external-trigger-warning').length === 0);
  healthStatus = 200;
}

console.log('\nsystem health: performance panels');
{
  const { root } = await render('/admin/system-health', <SystemHealth />);
  check('the threshold banner reports the crossed findings as an alert',
    byTestId(root, 'performance-thresholds')[0]?.props.role === 'alert' && textOf(byTestId(root, 'text-performance-level')[0]).startsWith('2 thresholds crossed')
      && byTestId(root, 'finding-p95_latency-office-roster').length === 1 && byTestId(root, 'finding-db_growth').length === 1);
  check('the banner prints every limit so the colours are explainable', textOf(byTestId(root, 'performance-thresholds')[0]).includes('p95 amber 1.50 s / red 4.00 s') && textOf(byTestId(root, 'performance-thresholds')[0]).includes('DB growth 250.0 MB / 1.00 GB per day'));
  const p95 = (name: string) => textOf(byTestId(root, `text-p95-${name}`)[0]);
  check('the last-hour latency table sorts by p95 and shows p50/p95 per family',
    byTestId(root, 'table-latency').length === 1 && p95('office-roster') === '1.84 s' && p95('health') === '12 ms' && p95('coach-chat') === '9.00 s'
      && byTestId(root, 'table-latency')[0].findAllByType('tbody')[0].findAllByType('tr').map((tr) => tr.props['data-testid']).join(',') === 'row-latency-coach-chat,row-latency-patient-diary,row-latency-office-roster,row-latency-health');
  check('an amber family is chipped amber; a thin family is "too few", a stream is tagged',
    textOf(byTestId(root, 'row-latency-office-roster')[0]).includes('Amber') && textOf(byTestId(root, 'row-latency-patient-diary')[0]).includes('too few') && textOf(byTestId(root, 'row-latency-coach-chat')[0]).includes('stream'));
  await act(async () => { byTestId(root, 'toggle-latency-window-lastDay')[0].props.onClick(); });
  check('switching to the day window swaps the rows and keeps the pressed state', byTestId(root, 'row-latency-coach-chat').length === 0 && textOf(byTestId(root, 'row-latency-office-roster')[0]).includes('1,500') && byTestId(root, 'toggle-latency-window-lastDay')[0].props['aria-pressed'] === true);
  check('slow statements list by total time first with calls, total, and mean',
    byTestId(root, 'table-slow-statements')[0].findAllByType('tbody')[0].findAllByType('tr')[0].props['data-testid'] === 'row-statement-101' && textOf(byTestId(root, 'row-statement-101')[0]).includes('12,000') && textOf(byTestId(root, 'row-statement-101')[0]).includes('1.5 m') === false && textOf(byTestId(root, 'row-statement-101')[0]).includes('90.0 s'));
  await act(async () => { byTestId(root, 'toggle-statement-order-byMean')[0].props.onClick(); });
  check('ordering by mean time puts the slow-every-time statement first', byTestId(root, 'table-slow-statements')[0].findAllByType('tbody')[0].findAllByType('tr')[0].props['data-testid'] === 'row-statement-102');
  check('growth tiles show size, delta, growth per day, and level',
    textOf(byTestId(root, 'metric-db-size')[0]) === '900.0 MB' && textOf(byTestId(root, 'metric-db-growth')[0]) === '+300.0 MB' && textOf(byTestId(root, 'metric-storage-size')[0]) === '5.00 GB' && textOf(byTestId(root, 'metric-storage-growth')[0]) === '+100.0 MB'
      && textOf(byTestId(root, 'chip-db-growth-level')[0]) === 'Amber' && textOf(byTestId(root, 'chip-storage-growth-level')[0]) === 'OK',
    `${textOf(byTestId(root, 'metric-db-size')[0])} / ${textOf(byTestId(root, 'metric-db-growth')[0])} / ${textOf(byTestId(root, 'metric-storage-size')[0])} / ${textOf(byTestId(root, 'metric-storage-growth')[0])}`);
  check('the table rows carry heap, index, row estimate, and the daily delta',
    textOf(byTestId(root, 'row-table-public-diary_entries')[0]).includes('1,250,000') && textOf(byTestId(root, 'row-table-public-diary_entries')[0]).includes('+250.0 MB') && textOf(byTestId(root, 'row-table-public-approved_foods')[0]).includes('no change')
      && textOf(byTestId(root, 'row-storage--objects-patient-media-')[0]).includes('18,400 objects'));
  check('a history of three snapshots draws both trend lines', byTestId(root, 'growth-history').length === 1 && byTestId(root, 'line-database').length === 1 && byTestId(root, 'line-storage').length === 1);
  check('formatters: bytes, deltas, and milliseconds',
    formatBytes(512) === '512 B' && formatBytes(1536) === '2 KB' && formatBytes(1.5 * MB) === '1.5 MB' && formatBytes(2.5 * 1024 * MB) === '2.50 GB' && formatBytes(null) === '—'
      && formatDelta(-4 * MB) === '−4.0 MB' && formatDelta(0) === 'no change' && formatDelta(null) === '—' && formatMs(999) === '999 ms' && formatMs(1234) === '1.23 s' && formatMs(45_000) === '45.0 s');

  performance = { ...healthyPerformance(), latency: null, slowStatements: null, growth: null, thresholds: { level: 'ok', config: thresholdConfig, findings: [] } };
  const bare = await render('/admin/system-health', <SystemHealth />);
  check('null sections say unavailable / no snapshot yet, never zeros',
    byTestId(bare.root, 'text-latency-unavailable').length === 1 && byTestId(bare.root, 'text-statements-unavailable').length === 1 && byTestId(bare.root, 'text-growth-unavailable').length === 1
      && byTestId(bare.root, 'table-latency').length === 0 && byTestId(bare.root, 'growth-summary').length === 0 && byTestId(bare.root, 'performance-thresholds')[0]?.props.role === 'status');

  performanceStatus = 502;
  const down = await render('/admin/system-health', <SystemHealth />);
  check('a 502 on the performance read shows its own notice while the jobs board still renders', byTestId(down.root, 'text-performance-error').length === 1 && byTestId(down.root, 'job-abandoned-uploads').length === 1 && byTestId(down.root, 'table-latency').length === 0);
  performanceStatus = 200;
  performance = healthyPerformance();
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
