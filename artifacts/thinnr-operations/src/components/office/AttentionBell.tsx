import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Link } from 'wouter';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useScopedPatients } from '@/data/scoped-data';
import { buildDemoAttentionItems } from '@/data/attention-demo';
import { useOfficeAlerts, useOfficeDietAlerts } from '@/hooks/use-office-alerts';
import { dietAlertHref, markOfficeAlertSeen, officeAlertsQueryKey, type OfficeAlerts } from '@/lib/office-alerts-api';
import { useToast } from '@/hooks/use-toast';
import { useProviderScope } from '@/contexts/provider-scope';
import { useDemoAttentionSeen } from '@/hooks/use-demo-attention-seen';

const reasonText = (days: number | null) => days === null ? 'never logged' : `${days} day${days === 1 ? '' : 's'}`;
const dietWhen = (iso: string | null) => iso ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso)) : '';

export function AttentionBell() {
  const patients = useScopedPatients();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const query = useOfficeAlerts();
  const providerScope = useProviderScope();
  const demoItems = useMemo(() => buildDemoAttentionItems(patients), [patients]);
  const [demoSeen, markDemoSeen] = useDemoAttentionSeen(providerScope?.providerId ?? 'all', query.isDemo);
  const items = query.isDemo
    ? demoItems.map((item) => ({ ...item, seen: demoSeen.includes(`${item.patientId}:${item.signature}`) }))
    : query.data?.items ?? [];
  // Diet care-team alerts share the bell: pending safety blocks are the
  // actionable count; recent diet events list below the attention items.
  const dietQuery = useOfficeDietAlerts();
  const pendingBlocks = dietQuery.isDemo ? [] : dietQuery.data?.pendingBlocks ?? [];
  const dietItems = dietQuery.isDemo ? [] : (dietQuery.data?.items ?? []).slice(0, 8);
  const attentionCount = query.isDemo ? items.filter((item) => !item.seen).length : query.data?.count ?? 0;
  const count = attentionCount + pendingBlocks.length;

  const seen = useMutation({
    mutationFn: ({ patientId, signature }: { patientId: string; signature: string }) =>
      markOfficeAlertSeen(patientId, signature, query.liveOffice),
    onMutate: async ({ patientId, signature }) => {
      const key = officeAlertsQueryKey(query.liveOffice);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<OfficeAlerts>(key);
      queryClient.setQueriesData<OfficeAlerts>({ queryKey: key }, (current) => current ? {
        ...current,
        count: Math.max(0, current.count - (current.items.some((item) => item.patientId === patientId && item.signature === signature && !item.seen) ? 1 : 0)),
        items: current.items.map((item) => item.patientId === patientId && item.signature === signature ? { ...item, seen: true } : item),
      } : current);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(officeAlertsQueryKey(query.liveOffice), context.previous);
      toast({ variant: 'destructive', title: 'Alert not marked seen', description: 'Please check your connection and try again.' });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: officeAlertsQueryKey(query.liveOffice) }),
  });

  const markSeen = (patientId: string, signature: string) => {
    if (query.isDemo) markDemoSeen(patientId, signature);
    else seen.mutate({ patientId, signature });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count ? `Patient alerts, ${count} unseen` : 'Patient alerts, none unseen'}
          className="relative grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-card text-primary shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="button-attention-bell"
        >
          <Bell size={16} />
          {count > 0 && (
            <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-sm bg-destructive px-1 text-center text-[10px] font-bold leading-5 text-destructive-foreground" data-testid="badge-attention-count">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,380px)] p-0" data-testid="popover-attention-alerts">
        <div className="flex items-center justify-between border-b border-border bg-paper-alt px-4 py-3">
          <div>
            <h2 className="font-serif text-base font-bold text-navy">Needs attention</h2>
            <p className="text-[11px] text-muted-foreground">{attentionCount} unseen · {items.length} flagged{pendingBlocks.length ? ` · ${pendingBlocks.length} diet block${pendingBlocks.length === 1 ? '' : 's'}` : ''}</p>
          </div>
          <Link href="/alerts" className="text-xs font-semibold text-primary underline-offset-2 hover:underline">View digest</Link>
        </div>
        <div className="max-h-[430px] overflow-y-auto">
          {query.liveEnabled && query.isPending && <p className="px-4 py-8 text-center text-xs text-muted-foreground">Loading patient alerts…</p>}
          {query.liveEnabled && query.isError && <p role="alert" aria-live="polite" className="px-4 py-6 text-xs text-destructive">Patient alerts could not be loaded.</p>}
          {!query.isResolving && !query.isError && items.length === 0 && pendingBlocks.length === 0 && dietItems.length === 0 && <p className="px-4 py-8 text-center text-xs text-muted-foreground">No patients need attention right now.</p>}
          {(pendingBlocks.length > 0 || dietItems.length > 0 || (dietQuery.liveEnabled && dietQuery.isError)) && (
            <section aria-label="Diet and food preference alerts" className="border-b border-border bg-paper-alt/40" data-testid="bell-diet-alerts">
              <h3 className="px-4 pt-3 text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">Diet &amp; food preferences</h3>
              {dietQuery.isError && <p role="alert" className="px-4 py-3 text-xs text-destructive" data-testid="bell-diet-error">Diet alerts could not be loaded.</p>}
              {pendingBlocks.map((block) => (
                <article key={block.blockId} className="px-4 py-3" data-testid={`bell-diet-block-${block.patientId}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="truncate font-serif text-sm font-bold text-navy">{block.patientName}</h4>
                      <p className="mt-0.5 text-[11px] text-destructive">Safety block awaiting your review{block.createdAt ? ` · since ${dietWhen(block.createdAt)}` : ''}</p>
                    </div>
                  </div>
                  <Link href={dietAlertHref(block.patientId)} className="mt-2 inline-block text-[11px] font-semibold text-primary underline-offset-2 hover:underline">Review block</Link>
                </article>
              ))}
              {dietItems.map((item) => (
                <article key={item.id} className="px-4 py-3" data-testid={`bell-diet-alert-${item.id}`}>
                  <h4 className="truncate font-serif text-sm font-bold text-navy">{item.patientName}</h4>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{item.kindLabel} · {dietWhen(item.createdAt)}</p>
                  <Link href={dietAlertHref(item.patientId)} className="mt-2 inline-block text-[11px] font-semibold text-primary underline-offset-2 hover:underline">Open record</Link>
                </article>
              ))}
            </section>
          )}
          {items.map((item) => (
            <article key={`${item.patientId}:${item.signature}`} className="border-b border-border px-4 py-3 last:border-0" data-testid={`attention-item-${item.patientId}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-serif text-sm font-bold text-navy">{item.name}</h3>
                  <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                    {item.reasons.map((reason) => <li key={reason.code}>{reason.label} · {reasonText(reason.days)}</li>)}
                  </ul>
                </div>
                {item.seen && <span className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted-foreground">Seen</span>}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Link href={`/patients/${item.patientId}`} className="text-[11px] font-semibold text-primary underline-offset-2 hover:underline">Open record</Link>
                {!query.liveOffice && !item.seen && (
                  <button type="button" className="text-[11px] font-semibold text-primary underline-offset-2 hover:underline disabled:opacity-50" onClick={() => markSeen(item.patientId, item.signature)} disabled={seen.isPending} data-testid={`button-mark-seen-${item.patientId}`}>
                    Mark seen
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}