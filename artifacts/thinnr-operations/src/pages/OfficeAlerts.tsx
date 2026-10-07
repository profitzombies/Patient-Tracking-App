import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, MessageSquareWarning } from 'lucide-react';
import { Link, useLocation, useSearch } from 'wouter';
import { PageHeader } from '@/components/admin/primitives';
import { BTN_PRIMARY, BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';
import { ATTENTION_DEMO_DATES, buildDemoChatFlags, buildDemoDigest } from '@/data/attention-demo';
import { useScopedPatients } from '@/data/scoped-data';
import { useMarkChatFlagReviewed, useOfficeAlertDigests, useOfficeChatFlags } from '@/hooks/use-office-alerts';
import type { AttentionDigest, OfficeChatFlag } from '@/lib/office-alerts-api';
import { useProviderScope } from '@/contexts/provider-scope';
import { useDemoAttentionSeen } from '@/hooks/use-demo-attention-seen';

const dayLabel = (date: string) => new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
}).format(new Date(`${date}T12:00:00Z`));

const daysText = (days: number | null) => days === null ? 'Never logged' : `${days} day${days === 1 ? '' : 's'}`;
const whenText = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
/** Where "Open chat" lands: the patient record with the flagged transcript already open. */
export const chatFlagHref = (flag: Pick<OfficeChatFlag, 'patientId' | 'conversationId'>) =>
  `/patients/${flag.patientId}${flag.conversationId ? `?coach=${encodeURIComponent(flag.conversationId)}` : ''}`;

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
  const flagsQuery = useOfficeChatFlags();
  const review = useMarkChatFlagReviewed();
  const [demoReviewed, setDemoReviewed] = useState<string[]>([]);
  const demoFlags = useMemo(() => buildDemoChatFlags(patients).map((flag) => demoReviewed.includes(flag.id) ? { ...flag, status: 'reviewed' as const, reviewedAt: new Date().toISOString(), reviewedByName: 'You' } : flag), [patients, demoReviewed]);
  const flags = flagsQuery.isDemo ? demoFlags : flagsQuery.data?.items ?? [];
  const openFlags = flags.filter((flag) => flag.status === 'open');
  const reviewedFlags = flags.filter((flag) => flag.status === 'reviewed').slice(0, 5);
  const canReview = !flagsQuery.liveOffice;

  // An alert email links here with ?chat=<flagId>. Once the list is in, jump
  // straight to that patient's record with the transcript open.
  const search = useSearch();
  const [, setLocation] = useLocation();
  const linkedFlagId = new URLSearchParams(search).get('chat');
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedFlagId || followed.current === linkedFlagId) return;
    if (!flagsQuery.isDemo && !flagsQuery.data) return;
    followed.current = linkedFlagId;
    const flag = flags.find((candidate) => candidate.id === linkedFlagId);
    if (flag) setLocation(chatFlagHref(flag), { replace: true });
  }, [linkedFlagId, flags, flagsQuery.data, flagsQuery.isDemo, setLocation]);
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

      <SectionCard
        title="Chat flagged"
        sub={flagsQuery.liveEnabled && flagsQuery.isPending ? 'Checking coach chats…' : openFlags.length ? `${openFlags.length} open · a patient said something in their AI coach chat that needs a clinician's eyes` : 'Nothing open. You are emailed and pushed the moment a chat is flagged.'}
      >
        {flagsQuery.liveEnabled && flagsQuery.isError && <p role="alert" className="px-5 py-4 text-sm text-destructive" data-testid="chat-flags-error">Flagged chats could not be loaded. Refresh to try again.</p>}
        {flagsQuery.isDemo && <p className="border-b border-border px-5 py-2 text-[11px] text-muted-foreground">Sample flag — the guided demo invents one so you can see the flow.</p>}
        <ul data-testid="chat-flags-open">
          {openFlags.map((flag) => (
            <li key={flag.id} className="flex flex-col gap-3 border-b border-border px-5 py-4 last:border-0 md:flex-row md:items-start md:justify-between" data-testid={`chat-flag-${flag.id}`}>
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <MessageSquareWarning size={14} className="text-destructive" aria-hidden />
                  <p className="font-serif text-sm font-bold text-navy">{flag.patientName}</p>
                  <span className="rounded-sm border border-[#d5a7a7] bg-[#fff0f0] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[.06em] text-destructive" data-testid={`chat-flag-category-${flag.id}`}>{flag.categoryLabel}</span>
                  <span className="text-[11px] text-muted-foreground">{whenText(flag.createdAt)}</span>
                </div>
                <p className="text-sm text-foreground">{flag.reason}</p>
                <blockquote className="border-l-2 border-border pl-3 text-xs italic text-muted-foreground">“{flag.messageExcerpt}”</blockquote>
              </div>
              <div className="flex shrink-0 gap-2">
                <Link href={chatFlagHref(flag)} className={`${BTN_PRIMARY} h-8 px-3`} data-testid={`button-open-chat-${flag.id}`}>Open chat</Link>
                {canReview && (
                  <button
                    type="button"
                    className={`${BTN_SECONDARY} h-8 px-3`}
                    disabled={review.isPending}
                    onClick={() => flagsQuery.isDemo ? setDemoReviewed((ids) => [...ids, flag.id]) : review.mutate(flag.id)}
                    data-testid={`button-review-chat-${flag.id}`}
                  >Mark reviewed</button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {review.isError && <p role="alert" className="px-5 pb-3 text-xs text-destructive">Could not mark that flag reviewed. Try again.</p>}
        {reviewedFlags.length > 0 && (
          <details className="border-t border-border px-5 py-3" data-testid="chat-flags-reviewed">
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">Recently reviewed ({reviewedFlags.length})</summary>
            <ul className="mt-2 space-y-1">
              {reviewedFlags.map((flag) => (
                <li key={flag.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground" data-testid={`chat-flag-${flag.id}`}>
                  <span><span className="font-semibold text-foreground">{flag.patientName}</span> · {flag.categoryLabel} · {whenText(flag.createdAt)}</span>
                  <span>Reviewed{flag.reviewedByName ? ` by ${flag.reviewedByName}` : ''}{flag.reviewedAt ? ` · ${whenText(flag.reviewedAt)}` : ''}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </SectionCard>

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