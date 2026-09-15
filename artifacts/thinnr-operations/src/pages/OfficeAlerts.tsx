import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Link } from 'wouter';
import { PageHeader } from '@/components/admin/primitives';
import { SectionCard } from '@/components/patient/heritage';
import { ATTENTION_DEMO_DATES, buildDemoDigest } from '@/data/attention-demo';
import { useScopedPatients } from '@/data/scoped-data';
import { useOfficeAlertDigests } from '@/hooks/use-office-alerts';
import type { AttentionDigest } from '@/lib/office-alerts-api';
import { useProviderScope } from '@/contexts/provider-scope';
import { useDemoAttentionSeen } from '@/hooks/use-demo-attention-seen';

const dayLabel = (date: string) => new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
}).format(new Date(`${date}T12:00:00Z`));

const daysText = (days: number | null) => days === null ? 'Never logged' : `${days} day${days === 1 ? '' : 's'}`;

export default function OfficeAlerts() {
  const patients = useScopedPatients();
  const providerScope = useProviderScope();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const query = useOfficeAlertDigests(selectedDate);
  const [demoSeen] = useDemoAttentionSeen(providerScope?.providerId ?? 'all', query.isDemo);
  const dates = query.isDemo ? ATTENTION_DEMO_DATES : query.data?.dates ?? [];
  const effectiveDate = selectedDate ?? (query.isDemo ? ATTENTION_DEMO_DATES[0] : query.data?.latestDate ?? null);
  const digest = query.isDemo && effectiveDate ? buildDemoDigest(patients, effectiveDate) : query.data?.digest ?? null;
  const index = effectiveDate ? dates.indexOf(effectiveDate) : -1;
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; items: Array<{ item: AttentionDigest['items'][number]; days: number | null }> }>();
    for (const item of digest?.items ?? []) {
      for (const reason of item.reasons) {
        const group = map.get(reason.code) ?? { label: reason.label, items: [] };
        group.items.push({ item, days: reason.days });
        map.set(reason.code, group);
      }
    }
    return [...map.entries()];
  }, [digest]);

  return (
    <div className="mx-auto max-w-[1320px] space-y-6 px-5 py-7 md:px-8">
      <PageHeader
        kicker="Office"
        title="Needs attention"
        sub="A daily snapshot of patients whose recent progress signals call for staff follow-up. Alerts are informational and do not replace clinical judgment."
        action={query.liveOffice ? <span className="rounded-sm border border-border bg-secondary px-2 py-1 text-[10px] font-bold uppercase tracking-[.06em] text-muted-foreground">HQ read-only</span> : undefined}
      />

      <SectionCard title="Digest day" sub={effectiveDate ? `${dayLabel(effectiveDate)} · ${digest?.flaggedCount ?? 0} flagged${query.isDemo && effectiveDate === ATTENTION_DEMO_DATES[0] ? ` · ${demoSeen.length} seen in bell` : ''}` : 'No digest has been generated yet.'}>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <button type="button" aria-label="Newer digest" className="grid h-9 w-9 place-items-center rounded-md border border-border bg-card text-primary disabled:opacity-40" disabled={index <= 0} onClick={() => setSelectedDate(dates[index - 1])} data-testid="button-digest-newer"><ChevronLeft size={15} /></button>
          <select
            aria-label="Digest date"
            className="h-9 rounded-md border border-border bg-card px-3 text-xs text-foreground"
            value={effectiveDate ?? ''}
            onChange={(event) => setSelectedDate(event.target.value)}
            data-testid="select-digest-date"
          >
            {dates.map((date) => <option key={date} value={date}>{dayLabel(date)}</option>)}
          </select>
          <button type="button" aria-label="Older digest" className="grid h-9 w-9 place-items-center rounded-md border border-border bg-card text-primary disabled:opacity-40" disabled={index < 0 || index >= dates.length - 1} onClick={() => setSelectedDate(dates[index + 1])} data-testid="button-digest-older"><ChevronRight size={15} /></button>
        </div>
      </SectionCard>

      {query.liveEnabled && query.isPending && <div role="status" className="grid place-items-center rounded-lg border border-border bg-card py-12"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading digest" /></div>}
      {query.liveEnabled && query.isError && <div role="alert" aria-live="polite" className="rounded-lg border border-[#d5a7a7] bg-[#fff0f0] px-5 py-6 text-sm text-destructive">The attention digest could not be loaded. Refresh to try again.</div>}
      {!query.isPending && !query.isError && digest && digest.items.length === 0 && <div className="rounded-lg border border-border bg-card px-5 py-10 text-center text-sm text-muted-foreground">No patients were flagged in this digest.</div>}

      <div className="grid gap-4 lg:grid-cols-2" data-testid="attention-digest-groups">
        {groups.map(([code, group]) => (
          <SectionCard key={code} title={group.label} sub={`${group.items.length} patient${group.items.length === 1 ? '' : 's'}`}>
            <ul>
              {group.items.map(({ item, days }) => (
                <li key={item.patientId} className="flex items-center justify-between gap-4 border-b border-border px-5 py-3 last:border-0" data-testid={`digest-${code}-${item.patientId}`}>
                  <div>
                    <p className="font-serif text-sm font-bold text-navy">{item.name}</p>
                    <p className="text-[11px] text-muted-foreground">{daysText(days)}</p>
                  </div>
                  <Link href={`/patients/${item.patientId}`} className="shrink-0 text-xs font-semibold text-primary underline-offset-2 hover:underline" aria-label={`Open ${item.name}'s record`}>Open record</Link>
                </li>
              ))}
            </ul>
          </SectionCard>
        ))}
      </div>
    </div>
  );
}