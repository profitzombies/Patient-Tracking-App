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
 * The "External trigger" card shows when the production scheduler (a
 * Scheduled Deployment that POSTs the internal tick routes every minute) last
 * reached the server. On autoscale the server's own timers are off, so a
 * trigger that has been quiet for more than five minutes means reminders,
 * exports, and clean-up have stopped — that reads as a red warning. When the
 * server still runs its own timers (development) the same gap is only a note.
 *
 * Below the jobs board sit the performance panels (SystemPerformance.tsx):
 * request speed per route family, the heaviest database statements, and
 * table/storage growth, coloured by the same thresholds that email HQ.
 *
 * Live-only: the guided demo has no job ledger, so signed-out visitors see a
 * note rather than a fabricated healthy board.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { Link } from 'wouter';
import { AlertTriangle, CheckCircle2, Clock3, Loader2, PauseCircle, Play, Radio, RotateCcw, ShieldAlert } from 'lucide-react';
import {
  getGetHqSystemHealthQueryKey,
  useGetHqSystemHealth,
  useRunHqSystemJob,
  type ExternalTickHealth,
  type ExternalTickHealthStatus,
  type ExternalTriggerHealth,
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
import { SystemPerformancePanels } from './SystemPerformance';
import { LaunchReadinessCard } from '@/components/admin/LaunchReadinessCard';
import { formatBytes } from '@/components/admin/files/utils';

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

/**
 * Last 24 h of WarehouseCraft submissions. `undefined` = not loaded yet,
 * `null` = the API could not read the queue (shown as unavailable, never as zero).
 */
function WarehouseSubmissionsSection({ warehouse, loaded }: { warehouse: SystemHealthResult['warehouse'] | undefined; loaded: boolean }) {
  const unreadable = loaded && warehouse === null;
  const detailWhenMissing = unreadable ? 'Queue unreadable' : 'Waiting for first read';
  return (
    <section className="mt-6" aria-labelledby="warehouse-heading" data-testid="system-health-warehouse">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="warehouse-heading" className="font-serif text-base font-bold text-navy">Warehouse submissions</h2>
        <p className="text-[11px] text-muted-foreground">Paid orders sent to WarehouseCraft in the last 24 hours. Rejections wait in Fulfillment as Needs attention until HQ fixes the product or address and retries.</p>
      </div>
      {unreadable && (
        <p role="alert" className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]" data-testid="text-warehouse-unreadable">
          The submission queue could not be read, so these figures are unavailable rather than zero.
        </p>
      )}
      {warehouse && !warehouse.auto_submit && (
        <p role="status" className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]" data-testid="text-warehouse-paused">
          Automatic submission is switched off in Payments settings. {warehouse.pending.toLocaleString()} paid {warehouse.pending === 1 ? 'order is' : 'orders are'} queued and will go out once it is switched back on.
        </p>
      )}
      {warehouse && warehouse.tenant_mode !== undefined && (
        <p
          role="status"
          className={warehouse.tenant_mode === 'live'
            ? 'mt-3 rounded-md border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground'
            : 'mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]'}
          data-testid="text-warehouse-tenant-mode"
        >
          {warehouse.tenant_mode === 'live'
            ? 'Warehouse connection: LIVE tenant. Real orders are sent; Stripe test-mode orders are skipped.'
            : `Warehouse connection: TEST tenant. Stripe test-mode orders are sent to the test warehouse; real (live-mode) orders are held until the live credentials and WAREHOUSECRAFT_TENANT_MODE=live are set.${(warehouse.held ?? 0) > 0 ? ` ${(warehouse.held ?? 0).toLocaleString()} real ${warehouse.held === 1 ? 'order is' : 'orders are'} held right now.` : ''}`}
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <MetricTile label="Sent" value={warehouse ? warehouse.sent24h.toLocaleString() : '—'} detail={warehouse ? 'Last 24 hours' : detailWhenMissing} testId="metric-warehouse-sent" />
        <MetricTile label="Failed attempts" value={warehouse ? warehouse.failed24h.toLocaleString() : '—'} detail={warehouse ? (warehouse.failed24h === 0 ? 'None' : 'Transient and definite') : detailWhenMissing} testId="metric-warehouse-failed" />
        <MetricTile label="Retried" value={warehouse ? warehouse.retries24h.toLocaleString() : '—'} detail={warehouse ? 'Needed more than one attempt' : detailWhenMissing} testId="metric-warehouse-retries" />
        <MetricTile label="Waiting" value={warehouse ? warehouse.pending.toLocaleString() : '—'} detail={warehouse ? (warehouse.due === 0 ? 'Nothing due' : `${warehouse.due.toLocaleString()} due now`) : detailWhenMissing} testId="metric-warehouse-pending" />
        <MetricTile label="Needs attention" value={warehouse ? warehouse.needs_attention.toLocaleString() : '—'} detail={warehouse ? (warehouse.needs_attention === 0 ? 'Queue is clean' : 'Fix and retry in Fulfillment') : detailWhenMissing} testId="metric-warehouse-attention" />
      </div>
      {warehouse && <WarehouseSyncTiles sync={warehouse.sync} />}
      {warehouse && warehouse.recent_failures.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card text-xs" data-testid="list-warehouse-failures">
          {warehouse.recent_failures.map((failure) => (
            <li key={failure.order_id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5" data-testid={`warehouse-failure-${failure.order_id}`}>
              <span>
                <Link href="/admin/payments/fulfillment" className="font-semibold text-primary hover:underline">{failure.order_number ?? failure.order_id}</Link>
                <span className="ml-2 text-destructive">{failure.error ?? 'Rejected by the warehouse'}</span>
              </span>
              <span className="text-muted-foreground">{when(failure.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The status feed poll (shipped, tracking, delivered). `undefined` = the API predates
 * the sync (older payloads), `null` = the poll ledger could not be read. A stalled
 * feed is called out in words because the tiles alone would still look calm.
 */
/** "Sep 18, 2026" for a YYYY-MM-DD archive day (UTC days; no timezone shift). */
function archiveDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return format(new Date(y, m - 1, d), 'MMM d, yyyy');
}

/**
 * Nightly cold archive backlog. `undefined` = not loaded yet, `null` = the
 * archive ledger could not be read (unavailable, never a caught-up zero).
 * Off by default: the section then says so instead of showing a backlog as
 * if it were a problem.
 */
function ColdArchiveSection({ archive, loaded }: { archive: SystemHealthResult['coldArchive'] | undefined; loaded: boolean }) {
  const unreadable = loaded && archive === null;
  const missing = unreadable ? 'Archive ledger unreadable' : 'Waiting for first read';
  const on = archive?.enabled === true;
  return (
    <section className="mt-6" aria-labelledby="cold-archive-heading" data-testid="system-health-cold-archive">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="cold-archive-heading" className="font-serif text-base font-bold text-navy">Cold storage archive</h2>
        <p className="text-[11px] text-muted-foreground">Nightly gzip copies of raw app events, audit events, and billing rows, one closed UTC day at a time, under the cold storage prefix. Never deletes anything.</p>
      </div>
      {unreadable && (
        <p role="alert" className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]" data-testid="text-cold-archive-unreadable">
          The archive ledger could not be read, so these figures are unavailable rather than zero.
        </p>
      )}
      {archive && !archive.enabled && (
        <p role="status" className="mt-3 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground" data-testid="text-cold-archive-off">
          The archive is switched off in Organization settings, so the nightly job does nothing.
          {archive.storageConfigured ? '' : ' Cold storage is not configured on the server (COLD_ARCHIVE_OBJECT_DIR), which is needed before it can be turned on.'}
          {archive.daysPending > 0 ? ` ${archive.daysPending.toLocaleString()} closed ${archive.daysPending === 1 ? 'day' : 'days'} would be archived once it is on.` : ''}
        </p>
      )}
      {archive && archive.enabled && !archive.storageConfigured && (
        <p role="alert" className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]" data-testid="text-cold-archive-unconfigured">
          The archive is on but COLD_ARCHIVE_OBJECT_DIR is not set on the server, so every nightly run fails until it is.
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricTile
          label="Days pending"
          value={archive ? archive.daysPending.toLocaleString() : '—'}
          detail={archive ? (archive.daysPending === 0 ? (archive.earliestDay ? 'Caught up' : 'No data to archive yet') : on ? 'Up to 30 archived per night' : 'Archive is off') : missing}
          testId="metric-cold-archive-pending"
        />
        <MetricTile
          label="Last archived day"
          value={archive ? (archive.lastArchivedDay ? archiveDay(archive.lastArchivedDay) : 'None yet') : '—'}
          detail={archive ? (archive.lastArchivedAt ? `Written ${when(archive.lastArchivedAt)}` : on ? 'Waiting for the first nightly run' : 'Nothing archived') : missing}
          testId="metric-cold-archive-last-day"
        />
        <MetricTile
          label="Days archived"
          value={archive ? archive.daysArchived.toLocaleString() : '—'}
          detail={archive ? (archive.earliestDay ? `Data starts ${archiveDay(archive.earliestDay)}` : 'No archivable rows yet') : missing}
          testId="metric-cold-archive-days"
        />
        <MetricTile
          label="Bytes written"
          value={archive ? formatBytes(archive.bytesWritten) : '—'}
          detail={archive ? `${archive.rowsArchived.toLocaleString()} rows, compressed` : missing}
          testId="metric-cold-archive-bytes"
        />
      </div>
    </section>
  );
}

const EVENT_LABELS: Record<string, string> = {
  sent: 'Sent', delivered: 'Delivered', delivery_delayed: 'Delivery delayed', bounced: 'Bounced', complained: 'Marked as spam', opened: 'Opened', clicked: 'Clicked',
};

/**
 * Email delivery tracking: the vendor's delivery-event webhook (delivered,
 * opened, clicked, bounced). Says "Tracking not enabled" while the signing
 * secret is missing or no event has ever arrived, and never shows zeros as
 * a healthy stream. Points at the outbox, which reads the same events.
 */
function EmailWebhookSection({ hook, loaded }: { hook: SystemHealthResult['emailWebhook'] | undefined; loaded: boolean }) {
  const unreadable = loaded && hook === null;
  const missing = unreadable ? 'Webhook health unreadable' : 'Waiting for first read';
  const enabled = Boolean(hook?.configured && hook?.last_event_at);
  const stalled = Boolean(hook?.configured && hook?.last_email_sent_at && (!hook?.last_event_at || hook.last_event_at < hook.last_email_sent_at));
  return (
    <section className="mt-6" aria-labelledby="email-webhook-heading" data-testid="system-health-email-webhook">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="email-webhook-heading" className="font-serif text-base font-bold text-navy">Email delivery tracking</h2>
        <p className="text-[11px] text-muted-foreground">
          Delivered, opened, clicked, and bounced events posted by the email vendor for customer emails. Opens are pixel-based and indicative. Feeds the{' '}
          <Link href="/admin/payments/emails" className="underline underline-offset-2">Email outbox</Link>.
        </p>
      </div>
      {unreadable && (
        <p role="alert" className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]" data-testid="text-email-webhook-unreadable">
          The webhook health row could not be read, so these figures are unavailable rather than zero.
        </p>
      )}
      {hook && !hook.configured && (
        <p role="status" className="mt-3 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground" data-testid="text-email-webhook-not-enabled">
          Tracking not enabled. Add the RESEND_WEBHOOK_SECRET secret from the vendor's webhook (endpoint /api/email/webhooks/resend) and switch on open and click tracking for the sending domain in the vendor dashboard.
        </p>
      )}
      {hook && hook.configured && !hook.last_event_at && (
        <p role="status" className="mt-3 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground" data-testid="text-email-webhook-waiting">
          Tracking not enabled yet: the secret is set but no delivery event has arrived. Check the webhook is pointed at /api/email/webhooks/resend and subscribed to the email events.
          {hook.rejected_today > 0 ? ` ${hook.rejected_today.toLocaleString()} ${hook.rejected_today === 1 ? 'delivery was' : 'deliveries were'} refused today for a bad signature, which usually means the secret does not match.` : ''}
        </p>
      )}
      {hook && enabled && stalled && (
        <p role="alert" className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]" data-testid="text-email-webhook-stalled">
          No delivery event has arrived since the last customer email was sent {when(hook.last_email_sent_at)}. If this persists, the vendor webhook or its secret needs attention.
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricTile
          label="Last event"
          value={hook ? (hook.last_event_at ? when(hook.last_event_at) : enabled ? '—' : 'Tracking not enabled') : '—'}
          detail={hook ? (hook.last_event_type ? EVENT_LABELS[hook.last_event_type] ?? hook.last_event_type : hook.configured ? 'No event yet' : 'Secret not configured') : missing}
          testId="metric-email-webhook-last-event"
        />
        <MetricTile
          label="Events, 24 h"
          value={hook ? (enabled ? hook.events_24h.toLocaleString() : 'Tracking not enabled') : '—'}
          detail={hook ? (hook.last_email_sent_at ? `Last email sent ${when(hook.last_email_sent_at)}` : 'No customer email sent yet') : missing}
          testId="metric-email-webhook-events"
        />
        <MetricTile
          label="Unmatched events"
          value={hook ? (enabled ? hook.unmatched_count.toLocaleString() : 'Tracking not enabled') : '—'}
          detail={hook ? (hook.unmatched_count > 0 ? `Oldest ${when(hook.oldest_unmatched_at)}; re-matched every minute` : 'Every event found its email') : missing}
          testId="metric-email-webhook-unmatched"
        />
        <MetricTile
          label="Refused deliveries"
          value={hook ? hook.rejected_today.toLocaleString() : '—'}
          detail={hook ? (hook.last_rejected_at ? `Today (UTC); ${hook.rejected_total.toLocaleString()} ever, last ${when(hook.last_rejected_at)}` : 'Bad or missing signatures; none so far') : missing}
          testId="metric-email-webhook-rejected"
        />
      </div>
    </section>
  );
}

function WarehouseSyncTiles({ sync }: { sync: NonNullable<SystemHealthResult['warehouse']>['sync'] }) {
  if (sync === undefined) return null;
  const missing = 'Poll ledger unreadable';
  const lastPoll = sync?.last_poll_at ? when(sync.last_poll_at) : sync ? 'Never polled' : '—';
  const lastSuccess = sync?.last_success_at ? when(sync.last_success_at) : sync ? 'No success yet' : '—';
  return (
    <div className="mt-4" data-testid="system-health-warehouse-sync">
      <h3 className="text-xs font-semibold text-navy">Status feed</h3>
      <p className="text-[11px] text-muted-foreground">Shipped, tracking and delivered updates polled from WarehouseCraft every 5 minutes.</p>
      {sync === null && (
        <p role="alert" className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]" data-testid="text-warehouse-sync-unreadable">
          The status feed poll ledger could not be read, so these figures are unavailable rather than zero.
        </p>
      )}
      {sync?.stalled && (
        <p role="alert" className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-4 py-2.5 text-xs text-[#b65c22]" data-testid="text-warehouse-sync-stalled">
          No successful poll for over {sync.stalled_after_minutes} minutes. Shipped and delivered updates are not reaching patients until the feed recovers.
          {sync.last_error ? ` Last error: ${sync.last_error}` : ''}
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <MetricTile label="Last poll" value={lastPoll} detail={sync ? (sync.last_error ? sync.last_error : `${sync.polls_24h.toLocaleString()} in 24 h`) : missing} testId="metric-warehouse-sync-last-poll" />
        <MetricTile label="Last success" value={lastSuccess} detail={sync ? (sync.stalled ? 'Feed stalled' : sync.failed_polls_24h === 0 ? 'No failed polls' : `${sync.failed_polls_24h.toLocaleString()} failed in 24 h`) : missing} testId="metric-warehouse-sync-last-success" />
        <MetricTile label="Rows seen" value={sync ? sync.rows_seen_24h.toLocaleString() : '—'} detail={sync ? 'Last 24 hours' : missing} testId="metric-warehouse-sync-rows" />
        <MetricTile label="Transitions" value={sync ? sync.transitions_24h.toLocaleString() : '—'} detail={sync ? 'Shipment states changed' : missing} testId="metric-warehouse-sync-transitions" />
        <MetricTile label="Row errors" value={sync ? sync.errors_24h.toLocaleString() : '—'} detail={sync ? (sync.errors_24h === 0 ? 'None' : 'Rows the sync could not apply') : missing} testId="metric-warehouse-sync-errors" />
      </div>
      {sync && (sync.back_ordered > 0 || sync.awaiting_tracking > 0) && (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-warehouse-sync-flags">
          {sync.back_ordered > 0 ? `${sync.back_ordered.toLocaleString()} back-ordered at the warehouse` : ''}
          {sync.back_ordered > 0 && sync.awaiting_tracking > 0 ? ' · ' : ''}
          {sync.awaiting_tracking > 0 ? `${sync.awaiting_tracking.toLocaleString()} shipped without a tracking number yet` : ''}
        </p>
      )}
    </div>
  );
}

export function outboxAgeDetail(outbox: SystemHealthResult['outbox'] | undefined): string {
  if (outbox === undefined) return 'Waiting for first read';
  if (outbox === null) return 'Outbox unreadable';
  if (outbox.oldestDueAgeMs === null) return 'Nothing waiting';
  if (outbox.oldestDueAgeMs >= OUTBOX_AGE_ALERT_MS) return 'Drain is behind';
  if (outbox.oldestDueAgeMs >= OUTBOX_AGE_WARN_MS) return 'Older than one tick';
  return 'Within one tick';
}

export const TICK_KIND_LABEL: Record<ExternalTickHealth['kind'], string> = {
  jobs: 'Jobs, exports, and purges',
  notifications: 'Reminders and staff alerts',
};

export const TICK_STATUS_LABEL: Record<ExternalTickHealthStatus, string> = {
  ok: 'Ticking',
  stale: 'Stale',
  never: 'Never reached',
};

/**
 * How loudly a quiet trigger should read. Red only when this server has no
 * timers of its own for that tick kind (production autoscale): then a stale
 * trigger means the work has stopped. With timers still running (development)
 * the gap is informational.
 */
export function externalTriggerSeverity(health: ExternalTriggerHealth | null | undefined): 'ok' | 'note' | 'warning' {
  if (!health) return 'ok';
  const quiet = health.ticks.filter((t) => t.status !== 'ok');
  if (quiet.length === 0) return 'ok';
  const timers = health.inProcessTimers;
  return quiet.some((t) => (t.kind === 'jobs' ? !timers.jobs : !timers.notifications)) ? 'warning' : 'note';
}

export function tickStatusClass(status: ExternalTickHealthStatus, severity: 'ok' | 'note' | 'warning'): string {
  if (status === 'ok') return 'border-accent-border bg-accent text-primary';
  if (severity === 'warning') return 'border-[#d5a7a7] bg-[#fff0f0] text-destructive';
  return 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]';
}

function ExternalTriggerCard({ health, loaded }: { health: ExternalTriggerHealth | null | undefined; loaded: boolean }) {
  const severity = externalTriggerSeverity(health);
  const staleMinutes = Math.round((health?.staleAfterMs ?? 300_000) / 60_000);
  return (
    <section
      className={`mt-6 rounded-lg border bg-card shadow-soft ${severity === 'warning' ? 'border-[#d5a7a7]' : 'border-border'}`}
      aria-label="External trigger"
      data-testid="system-health-external-trigger"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-serif text-base font-bold text-navy">External trigger</h2>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[.08em] text-muted-foreground">
              <Radio size={11} aria-hidden="true" />Every minute
            </span>
          </div>
          <p className="mt-1 max-w-[80ch] text-xs leading-relaxed text-muted-foreground">
            In production the server sleeps between requests, so a scheduled trigger calls it every minute to send reminders, finish exports and purges, and run clean-up. Stale after {staleMinutes} minutes without a tick.
          </p>
          {health && severity === 'warning' && (
            <div role="alert" className="mt-3 rounded-md border border-[#d5a7a7] bg-[#fff0f0] px-3 py-2 text-xs text-destructive" data-testid="text-external-trigger-warning">
              The external trigger has not reached this server for more than {staleMinutes} minutes and this server runs no timers of its own. Reminders, exports, purges, and clean-up are not running until the scheduled trigger is restored.
            </div>
          )}
          {health && severity === 'note' && (
            <p className="mt-3 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-3 py-2 text-xs text-[#b65c22]" data-testid="text-external-trigger-note">
              No recent external tick, but this server runs its own timers, so background work continues. Expected in development.
            </p>
          )}
          <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-xs sm:grid-cols-2">
            {(health?.ticks ?? (['jobs', 'notifications'] as const).map((kind) => ({ kind, status: 'never' as const, lastAt: null, owner: null, lastResult: null, summary: null, error: null }))).map((tick) => (
              <div key={tick.kind} data-testid={`tick-${tick.kind}`}>
                <dt className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">
                  {TICK_KIND_LABEL[tick.kind]}
                  {loaded && (
                    <span
                      className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.05em] ${tickStatusClass(tick.status, severity)}`}
                      data-testid={`chip-tick-status-${tick.kind}`}
                    >
                      {TICK_STATUS_LABEL[tick.status]}
                    </span>
                  )}
                </dt>
                <dd className="mt-0.5 text-foreground" data-testid={`text-tick-last-${tick.kind}`}>
                  {!loaded ? '—' : tick.lastAt ? `Last tick ${when(tick.lastAt)} (${ago(tick.lastAt)})` : 'No external tick recorded'}
                </dd>
                {loaded && tick.lastAt && (
                  <dd className="text-[11px] text-muted-foreground" data-testid={`text-tick-detail-${tick.kind}`}>
                    {tick.lastResult === 'failed' ? `Last tick failed${tick.error ? ` — ${tick.error}` : ''}` : formatCounts(tick.summary)}
                    {tick.owner ? ` · ${tick.owner}` : ''}
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
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

          <LaunchReadinessCard enabled={canLoad} />

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

          <WarehouseSubmissionsSection warehouse={data?.warehouse} loaded={Boolean(data)} />

          <ColdArchiveSection archive={data?.coldArchive} loaded={Boolean(data)} />

          <EmailWebhookSection hook={data?.emailWebhook} loaded={Boolean(data)} />

          {isError && (
            <div role="alert" className="mt-6 rounded-md border border-[#d5a7a7] bg-[#fff0f0] px-4 py-3 text-xs text-destructive" data-testid="text-system-health-error">
              {(error as { data?: { error?: string } })?.data?.error ?? 'System health could not be loaded. The job ledger may be unreachable.'}
            </div>
          )}

          <ExternalTriggerCard health={data?.externalTrigger} loaded={Boolean(data)} />

          <VerificationCostPanel months={data?.patientSignIns} loaded={!!data} />

          <SystemPerformancePanels enabled={canLoad} keySuffix={[authUser?.id, hqRole]} />

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
