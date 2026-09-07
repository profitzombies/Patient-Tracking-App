import { useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { AlertTriangle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useGetHqEscalations, useResolveHqEscalation, type GetHqEscalationsDepartment, type GetHqEscalationsStatus } from '@workspace/api-client-react';
import { AdminPage, PageHeader } from '@/components/admin/primitives';
import { BTN_SECONDARY } from '@/components/patient/heritage';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

export default function Escalations() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const department = params.get('department') as GetHqEscalationsDepartment | null;
  const status = (params.get('status') ?? 'open') as GetHqEscalationsStatus;
  const query = useGetHqEscalations({ department: department ?? undefined, status, limit: 100, offset: 0 });
  const resolve = useResolveHqEscalation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if ((key === 'department' && value === 'all') || (key === 'status' && value === 'open')) next.delete(key); else next.set(key, value);
    navigate(`/admin/escalations${next.toString() ? `?${next}` : ''}`, { replace: true });
  };
  const submitResolve = async () => {
    if (!resolveId) return;
    try {
      await resolve.mutateAsync({ escalationId: resolveId, data: { note: note.trim() || null } });
      await queryClient.invalidateQueries({ queryKey: ['/api/hq/escalations'] });
      setResolveId(null); setNote('');
      toast({ variant: 'success', title: 'Escalation resolved' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Escalation not resolved', description: (error as { status?: number }).status === 403 ? 'You do not have permission to resolve this escalation.' : error instanceof Error ? error.message : 'Try again.' });
    }
  };

  return (
    <AdminPage>
      <PageHeader kicker="Staff inbox" title="HQ escalations" sub="Conversations sent to HQ for clinical or support review." />
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-card-border bg-card p-3 shadow-soft">
        <Select value={department ?? 'all'} onValueChange={value => setFilter('department', value)}>
          <SelectTrigger aria-label="Department filter" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All departments</SelectItem>{query.data?.departments.map(item => <SelectItem key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={status} onValueChange={value => setFilter('status', value)}>
          <SelectTrigger aria-label="Status filter" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="open">Open</SelectItem><SelectItem value="resolved">Resolved</SelectItem></SelectContent>
        </Select>
        {query.data && <p className="text-xs text-muted-foreground">You handle {query.data.departments.join(' and ')} escalation{query.data.departments.length === 1 ? '' : 's'}.</p>}
      </div>
      {query.isPending ? <p role="status" className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">Loading escalations…</p> :
       query.isError ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">Escalations could not be loaded. Access may be denied. <button className="underline" onClick={() => query.refetch()}>Try again</button></div> :
       query.data.escalations.length === 0 ? <div className="rounded-lg border bg-card p-8 text-center"><AlertTriangle className="mx-auto text-muted-foreground" /><p className="mt-2 font-serif font-bold text-navy">No {status} escalations</p><p className="text-xs text-muted-foreground">Nothing in your permitted department queue.</p></div> :
       <ul className="space-y-3">{query.data.escalations.map(item => (
         <li key={item.id} className="rounded-lg border border-card-border bg-card p-4 shadow-soft">
           <div className="flex flex-wrap items-start justify-between gap-3">
             <div><p className="text-[10px] font-bold uppercase tracking-wider text-primary">{item.department} · {item.thread}</p><h2 className="font-serif text-base font-bold text-navy">{item.patientName} <span className="font-sans text-xs font-normal text-muted-foreground">at {item.officeName}</span></h2><p className="mt-2 max-w-3xl text-sm">{item.reason}</p><p className="mt-2 text-[11px] text-muted-foreground">Escalated by {item.createdByLabel} · {new Date(item.createdAt).toLocaleString()}</p>{item.resolutionNote && <p className="mt-2 rounded-md bg-secondary p-2 text-xs">Resolution: {item.resolutionNote}</p>}</div>
             <div className="flex gap-2"><Link className={BTN_SECONDARY} href={`/admin/conversations?office=${encodeURIComponent(item.providerId)}&thread=${item.thread}&conversation=${encodeURIComponent(item.conversationId)}`}>Open conversation</Link>{item.status === 'open' && <button className="rounded-md bg-primary px-3 py-2 text-xs font-bold text-primary-foreground" onClick={() => setResolveId(item.id)}>Resolve</button>}</div>
           </div>
         </li>
       ))}</ul>}
      <Dialog open={!!resolveId} onOpenChange={open => !open && setResolveId(null)}>
        <DialogContent><DialogHeader><DialogTitle>Resolve escalation</DialogTitle><DialogDescription>Add an optional internal resolution note.</DialogDescription></DialogHeader><textarea aria-label="Resolution note" value={note} onChange={e => setNote(e.target.value)} maxLength={2000} rows={4} className="rounded-md border border-input p-3 text-sm" /><DialogFooter><button className={BTN_SECONDARY} onClick={() => setResolveId(null)}>Cancel</button><button className="rounded-md bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50" disabled={resolve.isPending} onClick={submitResolve}>{resolve.isPending ? 'Resolving…' : 'Resolve'}</button></DialogFooter></DialogContent>
      </Dialog>
    </AdminPage>
  );
}