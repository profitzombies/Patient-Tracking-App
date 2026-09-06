import { useState } from 'react';
import { useGetHqAuditEvents, getGetHqAuditEventsQueryKey } from '@workspace/api-client-react';
import { useSession } from '@/contexts/session';
import { useHqData } from '@/contexts/hq-data';
import { Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/admin/primitives';
import { format } from 'date-fns';

export default function Audit() {
  const { authStatus, authUser, hqRole } = useSession();
  const { findAccount } = useHqData();
  const [page, setPage] = useState(0);
  const limit = 50;

  // Filter state
  const [providerFilter, setProviderFilter] = useState<string>('');
  const [actionFilter, setActionFilter] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  const params = {
    limit,
    offset: page * limit,
    ...(providerFilter ? { provider: providerFilter } : {}),
    ...(actionFilter ? { action: actionFilter } : {}),
    ...(dateFrom ? { from: dateFrom } : {}),
    ...(dateTo ? { to: dateTo } : {}),
  };
  const canLoadAudit =
    authStatus === 'signed-in' && (hqRole === 'Super Admin' || hqRole === 'Admin');

  const { data, isLoading, isError, error } = useGetHqAuditEvents(params, {
    query: {
      enabled: canLoadAudit,
      queryKey: [...getGetHqAuditEventsQueryKey(params), authUser?.id, hqRole],
    },
  });
  const firstEvent = data?.events.length ? page * limit + 1 : 0;
  const lastEvent = page * limit + (data?.events.length ?? 0);
  const hasNext =
    data?.total !== undefined
      ? (page + 1) * limit < data.total
      : Boolean(data?.hasMore);

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <PageHeader
        kicker="System Log"
        title="Audit Log"
        sub="Review system actions and events across the THINNR network."
      />

      <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-b border-border p-4 bg-paper-alt">
          <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
            <div className="flex items-center text-xs font-semibold text-muted-foreground">
              <Filter size={14} className="mr-1.5" /> Filters:
            </div>
            <input
              type="text"
              placeholder="Filter by Action..."
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}
              className="h-9 rounded-md border border-border bg-card px-3 text-xs text-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="text"
              placeholder="Filter by Provider ID..."
              value={providerFilter}
              onChange={(e) => { setProviderFilter(e.target.value); setPage(0); }}
              className="h-9 rounded-md border border-border bg-card px-3 text-xs text-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex items-center gap-1">
              <input
                type="date"
                aria-label="Filter events from date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
                className="h-9 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-muted-foreground/50 text-xs">to</span>
              <input
                type="date"
                aria-label="Filter events to date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
                className="h-9 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground shadow-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[900px]">
            <thead className="border-b border-border bg-secondary text-[10px] uppercase tracking-[.11em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">Timestamp</th>
                <th className="px-4 py-3 font-semibold">Action</th>
                <th className="px-4 py-3 font-semibold">Actor</th>
                <th className="px-4 py-3 font-semibold">Provider</th>
                <th className="px-4 py-3 font-semibold">Target</th>
                <th className="px-4 py-3 font-semibold text-right">Details</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">Loading audit events...</td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-destructive">
                    {error instanceof Error ? error.message : 'Could not load audit log.'}
                  </td>
                </tr>
              )}
              {!isLoading && !isError && data?.events.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No events found.</td>
                </tr>
              )}
              {!isLoading && !isError && data?.events.map((event) => {
                const account = event.providerId ? findAccount(event.providerId) : undefined;
                return (
                <tr key={event.id} className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors">
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                    {format(new Date(event.occurredAt), 'MMM d, yyyy HH:mm:ss')}
                  </td>
                  <td className="px-4 py-3 font-mono font-medium text-navy">
                    {event.action}
                  </td>
                  <td className="px-4 py-3">
                    <span className="block text-foreground">{event.actorKind}</span>
                    <span className="block text-[10px] text-muted-foreground font-mono">{event.actorUserId ?? 'System'}</span>
                  </td>
                  <td className="px-4 py-3">
                    {event.providerId ? (
                      <>
                        <span className="block text-foreground">{account?.officeName ?? 'Provider'}</span>
                        <span className="block font-mono text-[10px] text-muted-foreground">{event.providerId}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {event.targetKind ? (
                      <>
                        <span className="block text-foreground">{event.targetKind}</span>
                        <span className="block text-[10px] text-muted-foreground font-mono">{event.targetId}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-col items-end gap-1">
                      {event.requestId && (
                        <span className="text-[9px] font-mono text-muted-foreground/70 uppercase">REQ: {event.requestId}</span>
                      )}
                      {Object.keys(event.metadata).length > 0 && (
                        <pre className="text-left text-[10px] text-muted-foreground bg-secondary px-2 py-1 rounded max-w-[250px] overflow-x-auto">
                          {JSON.stringify(event.metadata, null, 2)}
                        </pre>
                      )}
                    </div>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center justify-between text-xs text-muted-foreground bg-paper-alt">
          <span>
            {data?.total !== undefined
              ? `Showing ${firstEvent}–${lastEvent} of ${data.total}`
              : `Page ${page + 1}`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Previous audit events page"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="flex items-center justify-center w-8 h-8 rounded-md border border-border bg-card hover:bg-accent disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              aria-label="Next audit events page"
              onClick={() => setPage(p => p + 1)}
              disabled={!hasNext}
              className="flex items-center justify-center w-8 h-8 rounded-md border border-border bg-card hover:bg-accent disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
