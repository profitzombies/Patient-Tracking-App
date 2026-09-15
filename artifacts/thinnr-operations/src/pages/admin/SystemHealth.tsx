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

const TRIGGER_LABEL: Record<SystemJobRun['trigger'], string> = {
  schedule: 'Scheduled',
  manual: 'Run now',
  internal: 'External trigger',
  user: 'User action',
};

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

          {isError && (
            <div role="alert" className="mt-6 rounded-md border border-[#d5a7a7] bg-[#fff0f0] px-4 py-3 text-xs text-destructive" data-testid="text-system-health-error">
              {(error as { data?: { error?: string } })?.data?.error ?? 'System health could not be loaded. The job ledger may be unreachable.'}
            </div>
          )}

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
