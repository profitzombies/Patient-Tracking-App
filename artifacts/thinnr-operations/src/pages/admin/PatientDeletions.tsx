/**
 * HQ view of patient-requested account deletions.
 *
 * Every request the network has seen, newest first, with the purge status
 * the worker recorded: pending (grace period), purging, purged, cancelled
 * (the patient signed back in), and failed. Failed purges are the reason
 * this page exists: they are surfaced here with the last error and each
 * step's outcome instead of being left half-done, and an Admin can re-queue
 * them. The purge is idempotent, so a retry only redoes what is missing.
 *
 * No PII: rows carry patient and provider ids only, and after a purge the
 * patient id resolves to nothing but a tombstone.
 */
import { Fragment, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ChevronLeft, Eye, RotateCcw, ShieldAlert } from 'lucide-react';
import {
  getGetHqPatientDeletionsQueryKey,
  getGetHqPatientDeletionRecordAccessQueryKey,
  useGetHqPatientDeletions,
  useGetHqPatientDeletionRecordAccess,
  useRetryHqPatientDeletion,
  type HqPatientDeletion,
  type HqPatientDeletionStatus,
} from '@workspace/api-client-react';
import { useSession } from '@/contexts/session';
import { useHqData } from '@/contexts/hq-data';
import { MetricTile, PageHeader } from '@/components/admin/primitives';
import { useToast } from '@/hooks/use-toast';

const STATUS_OPTIONS: { value: HqPatientDeletionStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending (grace period)' },
  { value: 'held', label: 'Held (legal hold)' },
  { value: 'purging', label: 'Purging' },
  { value: 'purged', label: 'Purged' },
  { value: 'cancelled', label: 'Cancelled' },
];

const STATUS_LABEL: Record<HqPatientDeletionStatus, string> = {
  pending: 'Pending',
  held: 'Held',
  purging: 'Purging',
  purged: 'Purged',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

function statusClass(status: HqPatientDeletionStatus): string {
  if (status === 'failed') return 'border-[#d5a7a7] bg-[#fff0f0] text-destructive';
  if (status === 'held') return 'border-[#b9c4dc] bg-[#eef2fb] text-navy';
  if (status === 'pending' || status === 'purging') return 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]';
  if (status === 'purged') return 'border-accent-border bg-accent text-primary';
  return 'border-border bg-secondary text-muted-foreground';
}

function StatusChip({ status }: { status: HqPatientDeletionStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${statusClass(status)}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {STATUS_LABEL[status]}
    </span>
  );
}

const when = (value: string | null | undefined) => (value ? format(new Date(value), 'MMM d, yyyy HH:mm') : '—');

function stepSummary(steps: HqPatientDeletion['steps']): string {
  const entries = Object.entries(steps ?? {});
  if (entries.length === 0) return 'Not started';
  return entries
    .map(([name, value]) => {
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      const ok = record.ok === true || record.status === 'ok' || record.done === true;
      return `${name}: ${ok ? 'done' : typeof record.error === 'string' ? 'failed' : 'pending'}`;
    })
    .join(' · ');
}

/**
 * "Who viewed this record" — the record-access audit rows for the patient
 * behind a deletion request. Loaded on demand (one request per opened row)
 * because audit history is only wanted during an investigation.
 */
function RecordAccessPanel({ deletionId, sessionKey }: { deletionId: string; sessionKey: string }) {
  const { data, isLoading, isError, error } = useGetHqPatientDeletionRecordAccess(deletionId, {
    query: { queryKey: [...getGetHqPatientDeletionRecordAccessQueryKey(deletionId), sessionKey] },
  });
  return (
    <div className="border-t border-border bg-secondary/40 px-4 py-3" data-testid={`panel-record-access-${deletionId}`}>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[.11em] text-muted-foreground">Who viewed this record</p>
      {isLoading && <p className="text-muted-foreground">Loading record access…</p>}
      {isError && (
        <p className="text-destructive" role="alert">{(error as { data?: { error?: string } })?.data?.error ?? 'Record access could not be loaded.'}</p>
      )}
      {data && data.entries.length === 0 && (
        <p className="text-muted-foreground" data-testid={`text-record-access-empty-${deletionId}`}>No staff or HQ views of this record are on file.</p>
      )}
      {data && data.entries.length > 0 && (
        <table className="w-full text-left text-xs">
          <thead className="text-[10px] uppercase tracking-[.11em] text-muted-foreground">
            <tr>
              <th className="py-1 pr-4 font-semibold">When</th>
              <th className="py-1 pr-4 font-semibold">What</th>
              <th className="py-1 pr-4 font-semibold">Who</th>
              <th className="py-1 pr-4 font-semibold">Office</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry, index) => (
              <tr key={`${entry.occurredAt}-${index}`} className="border-t border-border/60" data-testid={`row-record-access-${deletionId}-${index}`}>
                <td className="whitespace-nowrap py-1.5 pr-4 text-muted-foreground">{when(entry.occurredAt)}</td>
                <td className="py-1.5 pr-4 text-foreground">
                  {entry.label}
                  {entry.thread ? <span className="text-muted-foreground"> · {entry.thread.replace(/_/g, ' ')}</span> : null}
                  {entry.reportId ? <span className="block font-mono text-[10px] text-muted-foreground">{entry.reportId}</span> : null}
                </td>
                <td className="py-1.5 pr-4">
                  <span className="block text-foreground">{entry.actorName}</span>
                  <span className="block text-[10px] text-muted-foreground">{entry.role}</span>
                </td>
                <td className="py-1.5 pr-4 text-muted-foreground">{entry.office ?? (entry.providerId ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.total > 0 && (
        <p className="mt-2 text-[10px] text-muted-foreground">{data.total} view{data.total === 1 ? '' : 's'} on file. Repeated views by the same person within 15 minutes are recorded once.</p>
      )}
    </div>
  );
}
export default function PatientDeletions() {
  const { authStatus, authUser, hqRole } = useSession();
  const { findAccount } = useHqData();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<HqPatientDeletionStatus | ''>('');
  const [openAccess, setOpenAccess] = useState<string | null>(null);
  const params = { limit: 200, ...(statusFilter ? { status: statusFilter } : {}) };
  const canLoad = authStatus === 'signed-in' && (hqRole === 'Super Admin' || hqRole === 'Admin');
  const canRetry = canLoad;

  const { data, isLoading, isError, error } = useGetHqPatientDeletions(params, {
    query: {
      enabled: canLoad,
      queryKey: [...getGetHqPatientDeletionsQueryKey(params), authUser?.id, hqRole],
      refetchInterval: 30_000,
    },
  });
  const retry = useRetryHqPatientDeletion({
    mutation: {
      onSuccess: async (result) => {
        toast({ title: 'Purge re-queued', description: `Attempt ${result.deletion.attempts + 1} starts shortly.` });
        await queryClient.invalidateQueries({ queryKey: getGetHqPatientDeletionsQueryKey() });
      },
      onError: (err) => {
        const message = (err as { data?: { error?: string } })?.data?.error ?? 'The purge could not be re-queued.';
        toast({ title: 'Retry failed', description: message, variant: 'destructive' });
      },
    },
  });

  const summary = data?.summary;

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <Link href="/admin/audit" data-testid="link-back-to-audit" className="mb-4 inline-flex items-center rounded-sm text-xs font-semibold text-muted-foreground hover:text-navy">
        <ChevronLeft size={14} className="mr-1" aria-hidden="true" />Audit log
      </Link>
      <PageHeader
        kicker="System Log"
        title="Account deletions"
        sub="Patients who asked to delete their accounts. Purges run automatically after the grace period; anything that failed is listed here with its last error so it can be re-queued rather than left half-done."
      />

      {!canLoad ? (
        <p className="mt-6 rounded-md border border-border bg-secondary px-4 py-3 text-xs text-muted-foreground" data-testid="text-deletions-demo-note">
          {authStatus !== 'signed-in'
            ? 'The guided demo has no account deletions. Sign in with an HQ Admin account to review real requests.'
            : 'Your HQ role cannot review account deletions.'}
        </p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-6" data-testid="deletions-summary">
            <MetricTile label="Failed purges" value={summary ? String(summary.failed) : '—'} detail={summary && summary.failed > 0 ? 'Needs attention' : 'Nothing stuck'} testId="metric-deletions-failed" />
            <MetricTile label="Pending" value={summary ? String(summary.pending) : '—'} detail="In the grace period" />
            <MetricTile label="Held" value={summary ? String(summary.held) : '—'} detail="Parked by a legal hold" testId="metric-deletions-held" />
            <MetricTile label="Purging" value={summary ? String(summary.purging) : '—'} detail="Running now" />
            <MetricTile label="Purged" value={summary ? String(summary.purged) : '—'} detail="Complete" />
            <MetricTile label="Cancelled" value={summary ? String(summary.cancelled) : '—'} detail="Patient signed back in" />
          </div>

          <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
            <div className="flex items-center justify-between gap-4 border-b border-border bg-paper-alt p-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                Status
                <select
                  data-testid="select-deletion-status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as HqPatientDeletionStatus | '')}
                  className="h-9 rounded-md border border-border bg-card px-3 text-xs font-normal text-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-muted-foreground">Rows carry ids only; purged patients leave no personal data behind.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-xs">
                <thead className="border-b border-border bg-secondary text-[10px] uppercase tracking-[.11em] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Requested</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Office</th>
                    <th className="px-4 py-3 font-semibold">Patient</th>
                    <th className="px-4 py-3 font-semibold">Purge due</th>
                    <th className="px-4 py-3 font-semibold">Progress</th>
                    <th className="px-4 py-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">Loading account deletions…</td></tr>
                  )}
                  {isError && (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-destructive" role="alert">{(error as { data?: { error?: string } })?.data?.error ?? 'Account deletions could not be loaded.'}</td></tr>
                  )}
                  {!isLoading && !isError && data?.deletions.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground" data-testid="text-deletions-empty">No account deletions{statusFilter ? ` with status “${STATUS_LABEL[statusFilter]}”` : ''}.</td></tr>
                  )}
                  {!isLoading && !isError && data?.deletions.map((row) => {
                    const account = row.providerId ? findAccount(row.providerId) : undefined;
                    const accessOpen = openAccess === row.id;
                    return (
                      <Fragment key={row.id}>
                      <tr data-testid={`row-deletion-${row.id}`} className={`border-b border-border last:border-0 ${row.status === 'failed' ? 'bg-[#fff0f0]/40' : ''}`}>
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{when(row.requestedAt)}</td>
                        <td className="px-4 py-3"><StatusChip status={row.status} /></td>
                        <td className="px-4 py-3">
                          <span className="block text-foreground">{account?.officeName ?? (row.providerId ? 'Provider' : 'No office')}</span>
                          {row.providerId && <span className="block font-mono text-[10px] text-muted-foreground">{row.providerId}</span>}
                        </td>
                        <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground">{row.patientId}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {row.status === 'purged' ? `Purged ${when(row.purgedAt)}` : row.status === 'cancelled' ? `Cancelled ${when(row.cancelledAt)}` : row.status === 'held' ? `On hold since ${when(row.heldAt)} · resumes when lifted` : when(row.purgeAfter)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="block text-foreground">{stepSummary(row.steps)}</span>
                          <span className="block text-[10px] text-muted-foreground">
                            {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
                            {row.status === 'failed' && row.nextAttemptAt ? ` · next ${when(row.nextAttemptAt)}` : ''}
                            {row.status === 'failed' && !row.nextAttemptAt ? ' · automatic retries exhausted' : ''}
                          </span>
                          {row.lastError && (
                            <span className="mt-1 flex items-start gap-1 text-[11px] text-destructive" data-testid={`text-deletion-error-${row.id}`}>
                              <ShieldAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0" />{row.lastError}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            data-testid={`button-record-access-${row.id}`}
                            aria-expanded={accessOpen}
                            aria-controls={`record-access-${row.id}`}
                            onClick={() => setOpenAccess(accessOpen ? null : row.id)}
                            className="mr-2 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-3 font-medium text-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Eye size={12} aria-hidden="true" />{accessOpen ? 'Hide record access' : 'Record access'}
                          </button>
                          {row.status === 'failed' && canRetry && (
                            <button
                              type="button"
                              data-testid={`button-retry-deletion-${row.id}`}
                              disabled={retry.isPending}
                              onClick={() => retry.mutate({ id: row.id })}
                              className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-3 font-medium text-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                            >
                              <RotateCcw size={12} aria-hidden="true" />{retry.isPending ? 'Re-queuing…' : 'Retry purge'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {accessOpen && (
                        <tr id={`record-access-${row.id}`} className="border-b border-border last:border-0">
                          <td colSpan={7} className="p-0">
                            <RecordAccessPanel deletionId={row.id} sessionKey={`${authUser?.id ?? ''}:${hqRole ?? ''}`} />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
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
