/**
 * HQ System health: the scheduled clean-up jobs (abandoned-upload sweeps,
 * storage reconciliation, policy-driven retention) with each job's last
 * successful run, last failure, counts, and recent per-item failures.
 *
 * The panel exists so a delete that failed is seen, not silently retried
 * forever: a job with consecutive failures shows as failing with its last
 * error; a job whose last success is older than three intervals shows as
 * stale. Admins can run any scheduled job now, as a dry run (counts only) or
 * for real. Runs that outlast the request keep going server-side and the
 * panel polls until they land.
 *
 * Live-only: the guided demo has no job ledger, so signed-out visitors see a
 * note rather than a fabricated healthy board.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { AlertTriangle, CheckCircle2, Clock3, Loader2, PauseCircle, Play, RotateCcw, ShieldAlert } from 'lucide-react';
import {
  getGetHqSystemHealthQueryKey,
  useGetHqSystemHealth,
  useRunHqSystemJob,
  type PatientSignInMonth,
  type SystemHealthResult,
  type SystemJobHealth,
  type SystemJobHealthStatus,
  type SystemJobRun,
} from '@workspace/api-client-react';
import { useSession } from '@/contexts/session';
import { MetricTile, PageHeader } from '@/components/admin/primitives';
import { useToast } from '@/hooks/use-toast';
import { fetchStaffAlertDeliveries } from '@/lib/office-alerts-api';

export const STATUS_LABEL: Record<SystemJobHealthStatus, string> = {
  ok: 'Healthy',
  failing: 'Failing',
  stale: 'Stale',
  never_ran: 'Never ran',
  running: 'Running',
  on_demand: 'On demand',
};

export function statusClass(status: SystemJobHealthStatus): string {
  if (status === 'failing') return 'border-[#d5a7a7] bg-[#fff0f0] text-destructive';
  if (status === 'stale' || status === 'never_ran') return 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]';
  if (status === 'ok') return 'border-accent-border bg-accent text-primary';
  return 'border-border bg-secondary text-muted-foreground';
}

function StatusIcon({ status }: { status: SystemJobHealthStatus }) {
  const cls = 'h-3 w-3';
  if (status === 'failing') return <ShieldAlert className={cls} aria-hidden="true" />;
  if (status === 'stale' || status === 'never_ran') return <AlertTriangle className={cls} aria-hidden="true" />;
  if (status === 'running') return <Loader2 className={`${cls} animate-spin`} aria-hidden="true" />;
  if (status === 'on_demand') return <PauseCircle className={cls} aria-hidden="true" />;
  return <CheckCircle2 className={cls} aria-hidden="true" />;
}

export function StatusChip({ status, testId }: { status: SystemJobHealthStatus; testId?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${statusClass(status)}`}
      data-testid={testId}
    >
      <StatusIcon status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

const when = (value: string | null | undefined) => (value ? format(new Date(value), 'MMM d, yyyy HH:mm') : '—');
const ago = (value: string | null | undefined) => (value ? `${formatDistanceToNowStrict(new Date(value))} ago` : 'never');

/** "deleted 4 · rows removed 1 · scanned 12" — compact, stable key order; camelCase and snake_case keys read as words. */
export function formatCounts(counts: Record<string, number> | null | undefined): string {
  if (!counts) return '—';
  const entries = Object.entries(counts).filter(([, v]) => typeof v === 'number');
  if (entries.length === 0) return 'nothing to do';
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()} ${v}`)
    .join(' · ');
}

/** "12s", "4m", "2h 05m", "3d 4h" — how long the oldest due reminder has waited. */
export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Backlog ages past one tick are worth a look; past ten minutes the drain is behind. */
export const OUTBOX_AGE_WARN_MS = 60_000;
export const OUTBOX_AGE_ALERT_MS = 10 * 60_000;

export function outboxAgeDetail(outbox: SystemHealthResult['outbox'] | undefined): string {
  if (outbox === undefined) return 'Waiting for first read';
  if (outbox === null) return 'Outbox unreadable';
  if (outbox.oldestDueAgeMs === null) return 'Nothing waiting';
  if (outbox.oldestDueAgeMs >= OUTBOX_AGE_ALERT_MS) return 'Drain is behind';
  if (outbox.oldestDueAgeMs >= OUTBOX_AGE_WARN_MS) return 'Older than one tick';
  return 'Within one tick';
}

const TRIGGER_LABEL: Record<SystemJobRun['trigger'], string> = {
  schedule: 'Scheduled',
  manual: 'Run now',
  internal: 'External trigger',
  user: 'User action',
};

/** "2026-09-01" → "Sep 2026" without a timezone shift (the month is a UTC calendar month). */
export function monthLabel(month: string): string {
  const [year, mm] = month.split('-').map(Number);
  return format(new Date(year, (mm ?? 1) - 1, 1), 'MMM yyyy');
}

/** Codes per active patient for the tile: "0.25", or "—" while nobody was active. */
export function ratioLabel(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

/**
 * Text-message login codes per active patient, per month. Each code is a
 * paid message, so the ratio is the number that says whether sessions really
 * persist: about one code per new device, not one per patient per month.
 */
function VerificationCostPanel({ months, loaded }: { months: PatientSignInMonth[] | null | undefined; loaded: boolean }) {
  const current = months?.[0] ?? null;
  return (
    <section className="mt-8 overflow-hidden rounded-lg border border-border bg-card shadow-soft" aria-labelledby="verification-cost-title" data-testid="section-verification-cost">
      <div className="border-b border-border bg-paper-alt px-4 py-3">
        <h2 id="verification-cost-title" className="font-serif text-base font-bold text-navy">Login codes per active patient</h2>
        <p className="text-[11px] text-muted-foreground">
          Each patient text-message code is a paid message. A patient who stays signed in on the same phone needs one only on a new device, so this should stay well under one per active patient per month.
        </p>
      </div>
      {loaded && months === null && (
        <p role="alert" className="px-4 py-5 text-xs text-destructive" data-testid="text-verification-cost-unavailable">
          Sign-in ledger unavailable — the login-code count could not be read.
        </p>
      )}
      {months && (
        <>
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4" data-testid="verification-cost-summary">
            <MetricTile label="Codes per active patient" value={current ? ratioLabel(current.smsPerActivePatient) : '—'} detail={current ? `${monthLabel(current.month)} so far` : 'No months yet'} testId="metric-sms-per-active-patient" />
            <MetricTile label="Text codes redeemed" value={current ? String(current.smsSignIns) : '—'} detail={current ? `${current.newDeviceSmsSignIns} on a new device` : ''} testId="metric-sms-sign-ins" />
            <MetricTile label="Patients who needed one" value={current ? String(current.patientsWithSmsSignIn) : '—'} detail="Distinct patients this month" testId="metric-patients-with-sms" />
            <MetricTile label="Active patients" value={current ? String(current.activePatients) : '—'} detail="Opened the app this month" testId="metric-active-patients" />
          </div>
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-xs" data-testid="table-verification-cost">
              <thead>
                <tr className="border-b border-border text-left text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">
                  <th className="px-4 py-2.5">Month</th>
                  <th className="px-4 py-2.5 text-right">Text codes</th>
                  <th className="px-4 py-2.5 text-right">New device</th>
                  <th className="px-4 py-2.5 text-right">Patients</th>
                  <th className="px-4 py-2.5 text-right">Sign-ups</th>
                  <th className="px-4 py-2.5 text-right">Active patients</th>
                  <th className="px-4 py-2.5 text-right">Codes per active</th>
                </tr>
              </thead>
              <tbody>
                {months.map((row) => (
                  <tr key={row.month} className="border-b border-border last:border-0" data-testid={`row-sign-ins-${row.month.slice(0, 7)}`}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-foreground">{monthLabel(row.month)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.smsSignIns}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{row.newDeviceSmsSignIns}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{row.patientsWithSmsSignIn}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{row.signups}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.activePatients}</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-navy" data-testid={`text-sms-ratio-${row.month.slice(0, 7)}`}>{ratioLabel(row.smsPerActivePatient)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export default function SystemHealth() {
  const { authStatus, authUser, hqRole } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pendingJob, setPendingJob] = useState<string | null>(null);
  const canLoad = authStatus === 'signed-in' && (hqRole === 'Super Admin' || hqRole === 'Admin');
  const deliveries = useQuery({
    queryKey: ['hq-staff-alert-deliveries', authUser?.id],
    queryFn: () => fetchStaffAlertDeliveries(50),
    enabled: canLoad,
  });

  const { data, isLoading, isError, error, dataUpdatedAt } = useGetHqSystemHealth({
    query: {
      enabled: canLoad,
      queryKey: [...getGetHqSystemHealthQueryKey(), authUser?.id, hqRole],
      // Poll faster while something is running so a 202'd manual run lands on screen.
      refetchInterval: (query) => (query.state.data?.jobs.some((j) => j.running) ? 5_000 : 60_000),
    },
  });

  const runNow = useRunHqSystemJob({
    mutation: {
      onSuccess: async (result, variables) => {
        if ('run' in result) {
          const run = result.run;
          toast({
            title: run.status === 'succeeded' ? (run.dryRun ? 'Dry run finished' : 'Job finished') : 'Job finished with failures',
            description: `${variables.name}: ${formatCounts(run.counts)}${run.error ? ` — ${run.error}` : ''}`,
            variant: run.status === 'succeeded' ? 'default' : 'destructive',
          });
        } else {
          toast({ title: 'Job started', description: `${variables.name} is still running; this page refreshes until it finishes.` });
        }
        await queryClient.invalidateQueries({ queryKey: getGetHqSystemHealthQueryKey() });
      },
      onError: (err, variables) => {
        const message = (err as { data?: { error?: string } })?.data?.error ?? 'The job could not be started.';
        toast({ title: `${variables.name} not started`, description: message, variant: 'destructive' });
      },
      onSettled: () => setPendingJob(null),
    },
  });

  const start = (job: SystemJobHealth, dryRun: boolean) => {
    setPendingJob(job.name);
    runNow.mutate({ name: job.name, data: { dryRun } });
  };

  const jobs = data?.jobs ?? [];
  const failing = jobs.filter((j) => j.status === 'failing').length;
  const stale = jobs.filter((j) => j.status === 'stale' || j.status === 'never_ran').length;
  const running = jobs.filter((j) => j.running).length;
  const healthy = jobs.filter((j) => j.status === 'ok').length;
  const outbox = data?.outbox ?? null;

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <PageHeader
        kicker="Manage"
        title="System health"
        sub="Background clean-up: abandoned uploads, storage reconciliation, and retention driven by organization policy. Each job shows its last successful run and any failure, so nothing is deleted or left behind silently."
      />

      {!canLoad ? (
        <p className="mt-6 rounded-md border border-border bg-secondary px-4 py-3 text-xs text-muted-foreground" data-testid="text-system-health-demo-note">
          {authStatus !== 'signed-in'
            ? 'The guided demo has no background jobs. Sign in with an HQ Admin account to see the live job ledger.'
            : 'Your HQ role cannot review system health.'}
        </p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="system-health-summary">
            <MetricTile label="Failing" value={data ? String(failing) : '—'} detail={failing > 0 ? 'Needs attention' : 'No repeated failures'} testId="metric-jobs-failing" />
            <MetricTile label="Stale or never ran" value={data ? String(stale) : '—'} detail="No success in 3 intervals" testId="metric-jobs-stale" />
            <MetricTile label="Running" value={data ? String(running) : '—'} detail="Holding a lease now" testId="metric-jobs-running" />
            <MetricTile label="Healthy" value={data ? String(healthy) : '—'} detail={dataUpdatedAt ? `Checked ${format(new Date(dataUpdatedAt), 'HH:mm:ss')}` : 'Waiting for first read'} testId="metric-jobs-healthy" />
          </div>

          <section className="mt-6" aria-labelledby="outbox-heading" data-testid="system-health-outbox">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="outbox-heading" className="font-serif text-base font-bold text-navy">Patient push outbox</h2>
              <p className="text-[11px] text-muted-foreground">Reminders waiting to leave. The sender drains in batches every tick; a growing backlog or an old oldest-due age means it is falling behind.</p>
            </div>
            {data && data.outbox === null && (
              <p role="alert" className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]" data-testid="text-outbox-unreadable">
                The outbox could not be read, so these figures are unavailable rather than zero.
              </p>
            )}
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <MetricTile
                label="Due now"
                value={outbox ? outbox.due.toLocaleString() : '—'}
                detail={outbox ? (outbox.due === 0 ? 'Queue is empty' : 'Rows ready to send') : outboxAgeDetail(data?.outbox)}
                testId="metric-outbox-due"
              />
              <MetricTile
                label="Oldest due age"
                value={outbox ? formatAge(outbox.oldestDueAgeMs) : '—'}
                detail={outboxAgeDetail(data?.outbox)}
                testId="metric-outbox-oldest-age"
              />
              <MetricTile
                label="In flight"
                value={outbox ? outbox.inFlight.toLocaleString() : '—'}
                detail={outbox ? 'Held by a sender right now' : outboxAgeDetail(data?.outbox)}
                testId="metric-outbox-in-flight"
              />
            </div>
          </section>

          {isError && (
            <div role="alert" className="mt-6 rounded-md border border-[#d5a7a7] bg-[#fff0f0] px-4 py-3 text-xs text-destructive" data-testid="text-system-health-error">
              {(error as { data?: { error?: string } })?.data?.error ?? 'System health could not be loaded. The job ledger may be unreachable.'}
            </div>
          )}

          <VerificationCostPanel months={data?.patientSignIns} loaded={!!data} />

          <section className="mt-6 space-y-3" aria-label="Background jobs" data-testid="system-health-jobs">
            {isLoading && !data && (
              <p className="rounded-lg border border-border bg-card px-4 py-10 text-center text-xs text-muted-foreground" data-testid="text-system-health-loading">Loading job ledger…</p>
            )}
            {jobs.map((job) => {
              const isPending = pendingJob === job.name && runNow.isPending;
              const canRun = job.name !== 'patient-media-cleanup';
              return (
                <article key={job.name} className={`rounded-lg border bg-card shadow-soft ${job.status === 'failing' ? 'border-[#d5a7a7]' : 'border-border'}`} data-testid={`job-${job.name}`}>
                  <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-serif text-base font-bold text-navy" data-testid={`text-job-title-${job.name}`}>{job.title}</h2>
                        <StatusChip status={job.status} testId={`chip-job-status-${job.name}`} />
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[.08em] text-muted-foreground">
                          <Clock3 size={11} aria-hidden="true" />{job.schedule}
                        </span>
                      </div>
                      <p className="mt-1 max-w-[80ch] text-xs leading-relaxed text-muted-foreground">{job.description}</p>
                      <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                        <div>
                          <dt className="text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">Last success</dt>
                          <dd className="mt-0.5 text-foreground" data-testid={`text-job-last-success-${job.name}`}>
                            {job.lastSuccessAt ? `${when(job.lastSuccessAt)} (${ago(job.lastSuccessAt)})` : 'Never'}
                          </dd>
                          <dd className="text-[11px] text-muted-foreground" data-testid={`text-job-last-counts-${job.name}`}>{formatCounts(job.lastSuccessCounts)}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">Last failure</dt>
                          <dd className={`mt-0.5 ${job.lastFailureAt ? 'text-destructive' : 'text-foreground'}`} data-testid={`text-job-last-failure-${job.name}`}>
                            {job.lastFailureAt ? when(job.lastFailureAt) : 'None recorded'}
                          </dd>
                          {job.lastError && job.lastStatus === 'failed' && (
                            <dd className="text-[11px] text-destructive" data-testid={`text-job-last-error-${job.name}`}>{job.lastError}</dd>
                          )}
                        </div>
                        <div>
                          <dt className="text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">Retries</dt>
                          <dd className="mt-0.5 text-foreground" data-testid={`text-job-retries-${job.name}`}>
                            {job.consecutiveFailures > 0
                              ? `${job.consecutiveFailures} consecutive failure${job.consecutiveFailures === 1 ? '' : 's'}${job.nextEligibleAt ? ` · next try ${when(job.nextEligibleAt)}` : ''}`
                              : 'No backoff'}
                          </dd>
                          {job.running && job.lastStartedAt && (
                            <dd className="text-[11px] text-muted-foreground">Started {when(job.lastStartedAt)}</dd>
                          )}
                        </div>
                      </dl>
                      {job.recentFailures.length > 0 && (
                        <div className="mt-3 rounded-md border border-[#d5a7a7]/60 bg-[#fff0f0]/50 p-3" data-testid={`list-job-failures-${job.name}`}>
                          <p className="text-[10px] font-bold uppercase tracking-[.1em] text-destructive">Recent item failures</p>
                          <ul className="mt-1.5 space-y-1 text-[11px]">
                            {job.recentFailures.map((f, i) => (
                              <li key={`${f.item}-${i}`} className="flex flex-wrap gap-x-2">
                                <span className="font-mono text-[10px] text-muted-foreground">{when(f.occurredAt)}</span>
                                <span className="break-all font-mono text-[10px] text-foreground">{f.item}</span>
                                <span className="text-destructive">{f.error}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {canRun ? (
                        <>
                          <button
                            type="button"
                            data-testid={`button-dry-run-${job.name}`}
                            disabled={runNow.isPending || job.running}
                            onClick={() => start(job, true)}
                            className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                          >
                            <RotateCcw size={12} aria-hidden="true" />{isPending ? 'Running…' : 'Dry run'}
                          </button>
                          <button
                            type="button"
                            data-testid={`button-run-now-${job.name}`}
                            disabled={runNow.isPending || job.running}
                            onClick={() => start(job, false)}
                            className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                          >
                            <Play size={12} aria-hidden="true" />{job.running ? 'Running' : isPending ? 'Starting…' : 'Run now'}
                          </button>
                        </>
                      ) : (
                        <span className="text-[11px] italic text-muted-foreground" data-testid={`text-job-user-only-${job.name}`}>Runs from the patient app</span>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </section>

          <div className="mt-8 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
            <div className="border-b border-border bg-paper-alt px-4 py-3">
              <h2 className="font-serif text-base font-bold text-navy">Recent runs</h2>
              <p className="text-[11px] text-muted-foreground">Every run, including dry runs and user-triggered clean-ups, newest first.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-recent-runs">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">
                    <th className="px-4 py-2.5">Started</th>
                    <th className="px-4 py-2.5">Job</th>
                    <th className="px-4 py-2.5">Trigger</th>
                    <th className="px-4 py-2.5">Result</th>
                    <th className="px-4 py-2.5">Counts</th>
                  </tr>
                </thead>
                <tbody>
                  {data && data.recentRuns.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground" data-testid="text-runs-empty">No runs recorded yet.</td></tr>
                  )}
                  {data?.recentRuns.map((run) => (
                    <tr key={run.id} className={`border-b border-border last:border-0 ${run.status === 'failed' ? 'bg-[#fff0f0]/40' : ''}`} data-testid={`row-run-${run.id}`}>
                      <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{when(run.startedAt)}</td>
                      <td className="px-4 py-2.5 font-medium text-foreground">{run.jobName}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{TRIGGER_LABEL[run.trigger]}{run.dryRun ? ' · dry run' : ''}</td>
                      <td className="px-4 py-2.5">
                        <span className={run.status === 'failed' ? 'font-semibold text-destructive' : run.status === 'running' ? 'text-muted-foreground' : 'text-foreground'}>
                          {run.status === 'running' ? 'Running' : run.status === 'failed' ? `Failed${run.error ? ` — ${run.error}` : ''}` : 'Succeeded'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{formatCounts(run.counts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="mt-8 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
            <div className="border-b border-border bg-paper-alt px-4 py-3">
              <h2 className="font-serif text-base font-bold text-navy">Staff alert deliveries</h2>
              <p className="text-[11px] text-muted-foreground">Daily patient-attention email and push outcomes, newest first.</p>
            </div>
            {deliveries.isError && <p role="alert" aria-live="polite" className="px-4 py-5 text-xs text-destructive">Staff alert deliveries could not be loaded.</p>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-xs" data-testid="table-staff-alert-deliveries">
                <thead><tr className="border-b border-border text-left text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground"><th className="px-4 py-2.5">Scheduled</th><th className="px-4 py-2.5">Office</th><th className="px-4 py-2.5">Channel</th><th className="px-4 py-2.5">Digest</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Detail</th></tr></thead>
                <tbody>
                  {deliveries.isPending && <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Loading staff alert deliveries…</td></tr>}
                  {deliveries.data?.items.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No staff alert deliveries recorded yet.</td></tr>}
                  {deliveries.data?.items.map((delivery) => {
                    const problem = delivery.status === 'failed';
                    const warm = delivery.status === 'suppressed' || delivery.status === 'opted_out';
                    return <tr key={delivery.id} className="border-b border-border last:border-0" data-testid={`row-staff-alert-${delivery.id}`}>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{when(delivery.scheduledAt)}</td>
                      <td className="px-4 py-3"><b className="block text-navy">{delivery.officeName}</b><span className="text-[10px] text-muted-foreground">{delivery.recipientEmail ?? 'Push recipient'}</span></td>
                      <td className="px-4 py-3 capitalize">{delivery.channel}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{delivery.digestDate} · {delivery.flaggedCount} flagged</td>
                      <td className="px-4 py-3"><span className={`inline-flex rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${problem ? 'border-[#d5a7a7] bg-[#fff0f0] text-destructive' : warm ? 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]' : 'border-accent-border bg-accent text-primary'}`}>{delivery.status.replace(/_/g, ' ')}</span></td>
                      <td className={problem ? 'px-4 py-3 text-destructive' : 'px-4 py-3 text-muted-foreground'}>{delivery.suppressionDetail ?? delivery.suppressionReason?.replace(/_/g, ' ') ?? delivery.lastError ?? (delivery.sentAt ? `Sent ${when(delivery.sentAt)}` : '—')}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
