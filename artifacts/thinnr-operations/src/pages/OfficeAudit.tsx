/**
 * Office Audit — who did what in THIS office.
 *
 * Owners and admins see their own office's events only (the server scopes by
 * the caller's office and resolves every id to a name before responding),
 * with a date window, an action filter, and offset pagination. Raw provider
 * and user ids never reach this page.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Filter, ShieldCheck } from 'lucide-react';
import { format } from 'date-fns';
import { PageHeader } from '@/components/admin/primitives';
import { BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import { auditActionLabel, auditDetails } from '@/lib/audit-labels';
import { OfficeAuditError, fetchOfficeAudit, officeAuditQueryKey, type OfficeAuditFilters } from '@/lib/office-audit';

const PAGE_SIZE = 50;
const ALL_ACTIONS = '__all__';

const DEFAULT_ACTIONS = [
  'patient_invitation_created', 'patient_invitation_resent', 'patient_profile_updated', 'patient_status_changed',
  'patient_note_added', 'patient_note_deleted', 'patient_weight_recorded', 'patient_weight_updated', 'patient_weight_removed',
  'patient_follow_up_open', 'patient_follow_up_resolved', 'office_team_invited', 'office_team_role_changed',
  'office_team_deactivated', 'office_team_reactivated', 'office_team_signed_out', 'conversation_transcript_read',
  'conversation_replied', 'conversation_assigned', 'conversation_status_changed', 'conversation_note_added',
  'conversation_escalated', 'conversation_escalation_resolved',
  'data_export_requested', 'data_export_downloaded', 'access_denied',
];

export default function OfficeAudit() {
  const { liveEnabled, liveOffice, isDemo, isResolving, authUserId } = useLiveOfficeScope();
  const [page, setPage] = useState(0);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const filters: OfficeAuditFilters = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(action ? { action } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };

  // A backwards window is refused here, before any request: the server
  // would 400 it, and a half-typed date range should not fire queries.
  const invalidWindow = Boolean(from && to && from > to);

  const query = useQuery({
    queryKey: [...officeAuditQueryKey(liveOffice, filters), authUserId],
    queryFn: () => fetchOfficeAudit(filters, liveOffice),
    enabled: liveEnabled && !invalidWindow,
    placeholderData: (previous) => previous,
    retry: (count, error) => !(error instanceof OfficeAuditError && (error.status === 403 || error.status === 401)) && count < 2,
  });

  const data = query.data;
  const permissionError = query.error instanceof OfficeAuditError && query.error.isForbidden ? query.error : null;
  const actions = data?.actions?.length ? data.actions : DEFAULT_ACTIONS;
  const first = data?.events.length ? page * PAGE_SIZE + 1 : 0;
  const last = page * PAGE_SIZE + (data?.events.length ?? 0);
  const hasNext = data?.total !== undefined ? (page + 1) * PAGE_SIZE < data.total : Boolean(data?.hasMore);

  return (
    <div className="mx-auto max-w-[1320px] space-y-6 px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <PageHeader
        kicker="Office"
        title="Audit trail"
        sub="A record of who did what in this office — patient record changes, team changes, exports, and refused attempts. Message bodies and clinical notes are never stored here."
      />

      <SectionCard title="Recent activity" sub={data ? data.office.name : 'This office only'}>
        {liveEnabled && !permissionError && (
          <div className="flex flex-col gap-3 border-b border-border bg-paper-alt p-4 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="flex items-center text-xs font-semibold text-muted-foreground">
              <Filter size={14} className="mr-1.5" aria-hidden="true" /> Filters:
            </div>
            <Select value={action || ALL_ACTIONS} onValueChange={(value) => { setAction(value === ALL_ACTIONS ? '' : value); setPage(0); }}>
              <SelectTrigger className="h-9 w-full text-xs sm:w-64" aria-label="Filter by action" data-testid="select-audit-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ACTIONS} className="text-xs">All actions</SelectItem>
                {actions.map((value) => (
                  <SelectItem key={value} value={value} className="text-xs">{auditActionLabel(value)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <input
                type="date"
                aria-label="Filter events from date"
                data-testid="input-audit-from"
                value={from}
                onChange={(event) => { setFrom(event.target.value); setPage(0); }}
                className="h-9 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-xs text-muted-foreground/50">to</span>
              <input
                type="date"
                aria-label="Filter events to date"
                data-testid="input-audit-to"
                value={to}
                onChange={(event) => { setTo(event.target.value); setPage(0); }}
                className="h-9 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {(action || from || to) && (
              <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} onClick={() => { setAction(''); setFrom(''); setTo(''); setPage(0); }}>
                Clear
              </button>
            )}
          </div>
        )}

        {isResolving && <p className="px-5 py-8 text-xs text-muted-foreground" data-testid="status-audit-loading">Checking your sign-in…</p>}
        {isDemo && (
          <p className="px-5 py-8 text-xs text-muted-foreground" data-testid="status-audit-demo">
            The audit trail records real office activity. The guided demo has none — sign in with your office login to see who did what.
          </p>
        )}
        {!isDemo && !isResolving && !liveEnabled && (
          <p className="px-5 py-8 text-xs text-muted-foreground" role="alert" data-testid="status-audit-unauthorized">Open a provider account to see its audit trail.</p>
        )}
        {liveEnabled && invalidWindow && (
          <p className="px-5 py-3 text-xs text-destructive" role="alert" data-testid="status-audit-invalid-window">The “from” date must be on or before the “to” date.</p>
        )}
        {liveEnabled && !invalidWindow && query.isPending && <p className="px-5 py-8 text-xs text-muted-foreground" data-testid="status-audit-loading">Loading the audit trail…</p>}
        {liveEnabled && permissionError && (
          <div className="flex items-start gap-3 px-5 py-8" role="alert" data-testid="status-audit-unauthorized">
            <ShieldCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{permissionError.message}</p>
          </div>
        )}
        {liveEnabled && query.isError && !permissionError && (
          <div className="flex flex-wrap items-center gap-3 px-5 py-8" role="alert" data-testid="status-audit-error">
            <p className="text-xs text-destructive">{query.error instanceof Error ? query.error.message : 'The audit trail could not be loaded.'}</p>
            <button type="button" className={`${BTN_SECONDARY} h-8 px-2.5 text-[11px]`} onClick={() => void query.refetch()}>Try again</button>
          </div>
        )}
        {liveEnabled && data && !query.isError && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs" data-testid="table-office-audit">
                <thead>
                  <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                    <th className="px-5 py-3 font-bold">When</th>
                    <th className="px-3 py-3 font-bold">Who</th>
                    <th className="px-3 py-3 font-bold">What</th>
                    <th className="px-3 py-3 font-bold">Record</th>
                    <th className="px-5 py-3 font-bold">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-muted-foreground" data-testid="status-audit-empty">
                        {action || from || to ? 'No events match these filters.' : 'Nothing recorded yet. Patient record changes, team changes, and exports will appear here.'}
                      </td>
                    </tr>
                  )}
                  {data.events.map((event) => {
                    const details = auditDetails(event.metadata);
                    return (
                      <tr key={event.id} className="border-b border-border last:border-b-0" data-testid={`row-audit-${event.id}`}>
                        <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">
                          <time dateTime={event.occurredAt}>{format(new Date(event.occurredAt), 'MMM d, yyyy h:mm a')}</time>
                        </td>
                        <td className="px-3 py-3 font-semibold text-navy">{event.actorName}</td>
                        <td className="px-3 py-3 text-foreground">
                          {event.action === 'access_denied' ? <span className="font-semibold text-destructive">{auditActionLabel(event.action)}</span> : auditActionLabel(event.action)}
                        </td>
                        <td className="px-3 py-3 text-foreground">{event.targetName ?? <span className="text-muted-foreground/50">—</span>}</td>
                        <td className="px-5 py-3">
                          {details.length === 0 ? (
                            <span className="text-muted-foreground/50">—</span>
                          ) : (
                            <dl className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                              {details.map((detail) => (
                                <div key={detail.label} className="flex gap-1">
                                  <dt className="text-muted-foreground">{detail.label}:</dt>
                                  <dd className="text-foreground">{detail.value}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-border bg-paper-alt px-4 py-3 text-xs text-muted-foreground">
              <span data-testid="text-audit-range">
                {data.total !== undefined ? `Showing ${first}–${last} of ${data.total}` : `Page ${page + 1}`}
                {query.isFetching ? ' · refreshing…' : ''}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Previous audit page"
                  data-testid="button-audit-prev"
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                  disabled={page === 0}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Next audit page"
                  data-testid="button-audit-next"
                  onClick={() => setPage((current) => current + 1)}
                  disabled={!hasNext}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}
