/**
 * Read-only sessions + recent sign-ins for a teammate or patient, as seen by
 * a manager. Shared by Office Team, HQ Team, and the HQ patient record so all
 * three render the same shape from the same DTO. Never shows session tokens
 * or raw session ids; `ref` is the server's short, non-secret handle.
 */
import { PANEL_LABEL } from '@/components/patient/heritage';
import type { ManagedSecurity } from '@/lib/office-api';

function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ManagedSessionsState({
  data, loading, error, subject = 'This teammate',
}: { data: ManagedSecurity | undefined; loading: boolean; error: unknown; subject?: string }) {
  if (loading) return <p className="py-6 text-xs text-muted-foreground">Loading sessions…</p>;
  if (error) return <p className="py-6 text-xs text-destructive" role="alert">{error instanceof Error ? error.message : 'Sessions could not be loaded.'}</p>;
  if (!data?.linked) return <p className="py-6 text-xs text-muted-foreground">{subject} has not linked a sign-in account yet.</p>;
  return (
    <div className="max-h-[55vh] space-y-5 overflow-y-auto" data-testid="managed-sessions">
      <div>
        <p className={PANEL_LABEL}>Active sessions</p>
        <div className="mt-2 divide-y divide-border rounded-md border border-border">
          {data.sessions.length ? data.sessions.map((row) => (
            <div key={row.ref} className="p-3">
              <b className="text-xs text-navy">{row.device}</b>
              <p className="mt-1 text-[10px] text-muted-foreground">{row.region ?? 'Region unavailable'} · Last seen {formatDay(row.lastSeenAt)}</p>
            </div>
          )) : <p className="p-3 text-xs text-muted-foreground">No active sessions.</p>}
        </div>
      </div>
      <div>
        <p className={PANEL_LABEL}>Recent sign-ins</p>
        <div className="mt-2 divide-y divide-border rounded-md border border-border">
          {data.signIns.length ? data.signIns.map((row) => (
            <div key={row.id} className="p-3">
              <b className="text-xs text-navy">{row.device}</b>
              <p className="mt-1 text-[10px] text-muted-foreground">{formatDay(row.at)} · {row.region ?? 'Region unavailable'} · {row.methodLabel}</p>
            </div>
          )) : <p className="p-3 text-xs text-muted-foreground">No recent sign-ins.</p>}
        </div>
      </div>
    </div>
  );
}
