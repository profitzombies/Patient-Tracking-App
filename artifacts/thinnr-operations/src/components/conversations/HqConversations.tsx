import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft, MessagesSquare, Search, Lock } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CHIP_WARM, BTN_SECONDARY } from '@/components/patient/heritage';
import { useSession } from '@/contexts/session';
import { useHqData } from '@/contexts/hq-data';
import { InitialsAvatar, formatRelativeTime, LiveMessageRow } from '@/components/conversations/shared';
import {
  useGetHqConversations,
  useGetHqConversationEvents,
  useGetHqConversationNotes,
  useReadHqConversation,
  getGetHqConversationsQueryKey,
  getGetHqConversationEventsQueryKey,
  getGetHqConversationNotesQueryKey,
  type GetHqConversationsThread,
  type GetHqConversationsStatus,
  type GetHqConversationsSort,
  type GetHqConversationsParams,
  type GetHqConversationEventsParams,
  type ConversationEvent,
} from '@workspace/api-client-react';
import type { HqRole } from '@/data/hq/team';

const CHANNELS = ['all', 'care_team', 'ai'] as const;
const THREADS = ['coach', 'support', 'care_team'] as const;
const STATUSES = ['open', 'waiting_patient', 'closed'] as const;
const SORTS = ['newest', 'oldest', 'waiting_longest', 'unread_first'] as const;
const valid = <T extends string>(value: string | null, values: readonly T[], fallback: T): T =>
  value !== null && values.some(candidate => candidate === value) ? value as T : fallback;

export function HqConversations({ role }: { role: HqRole }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { authUser } = useSession();
  const { accounts, findAccount } = useHqData();

  const params = new URLSearchParams(search);
  const rawOffice = params.get('office') ?? params.get('account');
  const accountFilter = rawOffice && findAccount(rawOffice) ? rawOffice : 'all';
  const openId = params.get('conversation') ?? params.get('c');
  
  const channelFilter = valid(params.get('channel'), CHANNELS, role === 'Support' ? 'ai' : 'all');
  const rawThread = params.get('thread');
  const threadFilter: GetHqConversationsThread | null = rawThread && THREADS.some(value => value === rawThread) ? rawThread as GetHqConversationsThread : null;
  const rawStatus = params.get('status');
  const statusFilter: GetHqConversationsStatus | null = rawStatus && STATUSES.some(value => value === rawStatus) ? rawStatus as GetHqConversationsStatus : null;
  const assigneeFilter = params.get('assignee') ?? 'anyone';
  const unreadOnly = params.get('unread') === 'true';
  const sortFilter = valid(params.get('sort'), SORTS, 'newest') as GetHqConversationsSort;
  const queryFilter = params.get('q') ?? '';
  const patientFilter = params.get('patientId') ?? undefined;
  const rawOffset = Number(params.get('offset'));
  const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const [searchText, setSearchText] = useState(queryFilter);
  const limit = 20;
  const setOffset = (next: number | ((current: number) => number)) => {
    const value = typeof next === 'function' ? next(offset) : next;
    updateUrl({ offset: value > 0 ? String(value) : null, conversation: null });
  };
  const scopeKey = `${authUser?.id ?? 'anonymous'}:${accountFilter}`;
  const scopeRef = useRef(scopeKey);
  const openRef = useRef(openId);
  scopeRef.current = scopeKey;
  openRef.current = openId;

  const updateUrl = (changes: Record<string, string | null>, replace = true) => {
    const next = new URLSearchParams(search);
    next.delete('c');
    next.delete('account');
    if (Object.keys(changes).some(key => ['office', 'patientId', 'channel', 'thread', 'status', 'assignee', 'unread', 'q', 'sort'].includes(key))) {
      next.delete('offset');
    }
    Object.entries(changes).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    navigate(`/admin/conversations${next.toString() ? `?${next}` : ''}`, { replace });
  };

  const handleChannelChange = (next: 'all' | 'care_team' | 'ai') => {
    setOffset(0);
    updateUrl({ channel: next, thread: null, conversation: null });
  };

  const openConversation = (id: string) => updateUrl({ conversation: id }, false);
  const closeThread = () => updateUrl({ conversation: null });

  useEffect(() => {
    setSearchText(queryFilter);
  }, [queryFilter]);

  useEffect(() => {
    if (searchText === queryFilter) return;
    const timer = window.setTimeout(() => { setOffset(0); updateUrl({ q: searchText.trim() || null, conversation: null }); }, 300);
    return () => window.clearTimeout(timer);
  }, [searchText, queryFilter]);

  const listParams = useMemo<GetHqConversationsParams>(() => ({
    office: accountFilter !== 'all' ? accountFilter : undefined,
    patientId: patientFilter,
    channel: channelFilter,
    thread: threadFilter ?? undefined,
    status: statusFilter ?? undefined,
    assignee: assigneeFilter === 'anyone' ? undefined : assigneeFilter,
    unread: unreadOnly || undefined, 
    q: queryFilter || undefined,
    sort: sortFilter, limit, offset,
  }), [accountFilter, patientFilter, channelFilter, threadFilter, statusFilter, assigneeFilter, unreadOnly, queryFilter, sortFilter, offset]);

  const { data: convData, isFetching: isConvFetching, error: convError } = useGetHqConversations(
    listParams,
    {
      query: {
        queryKey: [scopeKey, ...getGetHqConversationsQueryKey(listParams)],
        refetchInterval: 5_000,
        refetchOnWindowFocus: true,
      }
    }
  );

  const conversations = convData?.conversations ?? [];
  const total = convData?.total ?? 0;
  const hasMore = offset + limit < total;
  const hasPrev = offset > 0;

  const [beforeCursor, setBeforeCursor] = useState<number | undefined>(undefined);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [allEvents, setAllEvents] = useState<ConversationEvent[]>([]);
  const [fetchedThrough, setFetchedThrough] = useState<number | undefined>();
  const [transcriptLoadedFor, setTranscriptLoadedFor] = useState('');

  useEffect(() => {
    setBeforeCursor(undefined);
    setNextBefore(null);
    setAllEvents([]);
    setFetchedThrough(undefined);
    setTranscriptLoadedFor('');
  }, [openId, scopeKey, channelFilter, threadFilter, statusFilter]);

  const newestParams = useMemo<GetHqConversationEventsParams>(() => fetchedThrough ? { after: fetchedThrough, limit: 30 } : { limit: 30 }, [fetchedThrough]);
  const { data: eventsData, isFetching: isEventsFetching, error: eventsError } = useGetHqConversationEvents(
    openId ?? '',
    newestParams,
    {
      query: {
        enabled: !!openId,
        queryKey: [scopeKey, ...getGetHqConversationEventsQueryKey(openId ?? '', newestParams)],
        refetchInterval: 5_000,
        refetchOnWindowFocus: true,
      }
    }
  );
  const olderParams = useMemo<GetHqConversationEventsParams>(() => ({ before: beforeCursor, limit: 30 }), [beforeCursor]);
  const older = useGetHqConversationEvents(openId ?? '', olderParams, {
    query: {
      enabled: !!openId && beforeCursor !== undefined,
      queryKey: [scopeKey, 'older', ...getGetHqConversationEventsQueryKey(openId ?? '', olderParams)],
    },
  });

  useEffect(() => {
    if (eventsData?.events && scopeRef.current === scopeKey && openRef.current === openId) {
      setAllEvents(prev => {
        const newEvents = eventsData.events.filter(e => !prev.some(p => p.seq === e.seq));
        return [...prev, ...newEvents].sort((a, b) => a.seq - b.seq);
      });
      setTranscriptLoadedFor(`${scopeKey}:${openId}`);
      if (fetchedThrough === undefined) setNextBefore(eventsData.nextBefore);
      if (eventsData.events.length > 0) {
        setFetchedThrough(current => Math.max(current ?? 0, ...eventsData.events.map(event => event.seq)));
      }
    }
  }, [eventsData, scopeKey, openId]);

  useEffect(() => {
    if (!older.data?.events || scopeRef.current !== scopeKey || openRef.current !== openId) return;
    setAllEvents(previous => {
      const bySeq = new Map(previous.map(event => [event.seq, event]));
      older.data.events.forEach(event => bySeq.set(event.seq, event));
      return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
    });
    setNextBefore(older.data.nextBefore);
  }, [older.data, scopeKey, openId]);

  const explicit = openId;
  const selectedSummary = conversations.find(c => c.id === openId);
  const readHq = useReadHqConversation();
  const notes = useGetHqConversationNotes(openId ?? '', {
    query: {
      enabled: !!openId,
      queryKey: [scopeKey, ...getGetHqConversationNotesQueryKey(openId ?? '')],
      refetchOnWindowFocus: true,
    },
  });
  const readThroughByThreadRef = useRef(new Map<string, number>());

  // Handle read state - idempotent call on open
  useEffect(() => {
    const readKey = `${scopeKey}:${openId}`;
    if (openId && fetchedThrough && transcriptLoadedFor === readKey) {
      if (fetchedThrough <= (readThroughByThreadRef.current.get(readKey) ?? 0)) return;
      readThroughByThreadRef.current.set(readKey, fetchedThrough);
      readHq.mutate({ conversationId: openId, data: { throughSeq: fetchedThrough } }, {
        onError: () => {
          if (openRef.current === openId) readThroughByThreadRef.current.delete(readKey);
        },
      });
    }
  }, [openId, fetchedThrough, transcriptLoadedFor, scopeKey]);

  const listPane = (
    <aside
      className={`${explicit ? 'hidden lg:flex' : 'flex'} w-full min-w-0 flex-col border-r border-border bg-paper-alt lg:w-[410px] lg:shrink-0`}
    >
      <div className="shrink-0 space-y-2.5 border-b border-border px-4 pb-3.5 pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Fleet</p>
            <h1 className="font-serif text-lg font-bold leading-tight tracking-[-.01em] text-navy">Live Conversations</h1>
          </div>
          {total > 0 && (
            <span aria-live="polite" className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {offset + 1}-{Math.min(offset + limit, total)} of {total}
            </span>
          )}
        </div>

        {role !== 'Support' && (
          <div className="flex rounded-md bg-muted p-1">
            <button
              onClick={() => handleChannelChange('all')}
              className={`flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors ${channelFilter === 'all' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              All
            </button>
            <button
              onClick={() => handleChannelChange('care_team')}
              className={`flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors ${channelFilter === 'care_team' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Care Team
            </button>
            <button
              onClick={() => handleChannelChange('ai')}
              className={`flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors ${channelFilter === 'ai' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              AI
            </button>
          </div>
        )}

        {channelFilter === 'ai' && (
           <div className="flex gap-2 mb-2">
             <button
               onClick={() => updateUrl({ thread: null, conversation: null })}
               className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${!threadFilter ? 'bg-navy text-white' : 'bg-card text-muted-foreground border border-border'}`}
             >
               Any AI
             </button>
             {role !== 'Support' && (
               <button
                 onClick={() => updateUrl({ thread: 'coach', conversation: null })}
                 className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${threadFilter === 'coach' ? 'bg-navy text-white' : 'bg-card text-muted-foreground border border-border'}`}
               >
                 Coach
               </button>
             )}
             <button
               onClick={() => updateUrl({ thread: 'support', conversation: null })}
               className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${threadFilter === 'support' ? 'bg-navy text-white' : 'bg-card text-muted-foreground border border-border'}`}
             >
               Support
             </button>
           </div>
        )}

        <Select value={accountFilter} onValueChange={(val) => updateUrl({ office: val === 'all' ? null : val, conversation: null })}>
          <SelectTrigger className="h-9 w-full text-xs">
            <SelectValue>{accountFilter === 'all' ? 'All provider accounts' : findAccount(accountFilter)?.officeName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All provider accounts</SelectItem>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id} className="text-xs">
                <span className="block">{account.officeName}</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">{account.providerName} · Code {account.providerCode}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-muted-foreground" />
          <input aria-label="Search conversations" value={searchText} onChange={e => setSearchText(e.target.value)} placeholder="Search patient or messages" className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Select value={statusFilter ?? 'all'} onValueChange={value => { setOffset(0); updateUrl({ status: value === 'all' ? null : value, conversation: null }); }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">Any status</SelectItem><SelectItem value="open">Open</SelectItem><SelectItem value="waiting_patient">Waiting on patient</SelectItem><SelectItem value="closed">Closed</SelectItem></SelectContent>
          </Select>
          <Select value={sortFilter} onValueChange={value => { setOffset(0); updateUrl({ sort: value === 'newest' ? null : value, conversation: null }); }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="newest">Newest</SelectItem><SelectItem value="oldest">Oldest</SelectItem><SelectItem value="waiting_longest">Waiting longest</SelectItem><SelectItem value="unread_first">Unread first</SelectItem></SelectContent>
          </Select>
           <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 text-xs"><input type="checkbox" checked={unreadOnly} onChange={event => { setOffset(0); updateUrl({ unread: event.target.checked ? 'true' : null, conversation: null }); }} /> Unread only</label>
           <input aria-label="Filter by assignee" value={assigneeFilter === 'anyone' ? '' : assigneeFilter} onChange={event => { setOffset(0); updateUrl({ assignee: event.target.value.trim() || null, conversation: null }); }} placeholder="Assignee ID, me, unassigned" className="h-8 rounded-md border border-input bg-background px-2 text-xs" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isConvFetching && conversations.length === 0 ? (
          <div className="px-5 py-10 text-center text-xs text-muted-foreground">Loading...</div>
        ) : convError ? (
          <div className="px-5 py-10 text-center text-xs text-destructive">
            {(convError instanceof Error && 'status' in convError && convError.status === 403) ? "You do not have permission to view these conversations." : "Failed to load conversations."}
          </div>
        ) : conversations.length > 0 ? (
          <div className="flex flex-col h-full">
            <ul className="divide-y divide-border/60 flex-1">
              {conversations.map((conv) => {
                const isActive = openId === conv.id;
                
                return (
                  <li key={conv.id}>
                     <Link
                       href={`/admin/conversations?${new URLSearchParams({ ...(accountFilter !== 'all' ? { office: accountFilter } : {}), channel: channelFilter, conversation: conv.id }).toString()}`}
                       onClick={(event) => { event.preventDefault(); openConversation(conv.id); }}
                      className={`flex w-full items-start gap-3 border-l-2 px-3.5 py-3 text-left transition ${isActive ? 'border-primary bg-card shadow-soft' : 'border-transparent hover:bg-card/70'}`}
                    >
                      <InitialsAvatar name={conv.patientName} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                           <b className="truncate text-xs text-navy font-semibold">{conv.patientName}</b>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {formatRelativeTime(conv.updatedAt)}
                          </span>
                        </span>
                         <span className="mt-1 flex flex-wrap gap-1 text-[9px] font-semibold uppercase">
                           <span className={CHIP_WARM}>{conv.channel === 'ai' ? conv.thread : 'Care Team'}</span>
                           <span className="rounded bg-secondary px-1.5 py-0.5">{conv.status.replace('_', ' ')}</span>
                         </span>
                         <span className="mt-1 flex gap-2 text-[10px] text-muted-foreground">
                           <span className="truncate">{conv.officeName}</span>
                         </span>
                      </span>
                     </Link>
                  </li>
                );
              })}
            </ul>
            {(hasPrev || hasMore) && (
              <div className="flex justify-between items-center px-4 py-3 border-t border-border">
                <button disabled={!hasPrev || isConvFetching} onClick={() => setOffset(o => Math.max(0, o - limit))} className={`${BTN_SECONDARY} h-7 px-3 text-[10px]`}>Newer</button>
                <button disabled={!hasMore || isConvFetching} onClick={() => setOffset(o => o + limit)} className={`${BTN_SECONDARY} h-7 px-3 text-[10px]`}>Older</button>
              </div>
            )}
          </div>
        ) : (
          <div className="px-5 py-10 text-center">
            <MessagesSquare size={18} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs font-semibold text-navy">No conversations</p>
          </div>
        )}
      </div>
    </aside>
  );

  const viewerPane = (
    <section className={`${explicit ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-background`}>
      {openId ? (
        <>
          <header className="shrink-0 border-b border-border bg-card px-4 py-3 md:px-6">
            {explicit && (
              <button
                type="button"
                className="mb-2 inline-flex items-center gap-1.5 rounded-sm text-xs font-semibold text-primary hover:underline md:hidden"
                onClick={closeThread}
              >
                <ArrowLeft size={12} aria-hidden="true" />
                All conversations
              </button>
            )}
            <div className="flex items-center gap-3">
              <InitialsAvatar name={selectedSummary?.patientName ?? 'Patient'} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 className="truncate font-serif text-base font-bold tracking-[.01em] text-navy">
                    {selectedSummary?.patientId ? (
                      <Link href={`/admin/accounts/${selectedSummary.providerId ?? 'all'}/office?patient=${selectedSummary.patientId}`} className="hover:underline">
                        {selectedSummary.patientName}
                      </Link>
                    ) : selectedSummary?.patientName ?? 'Patient'}
                  </h2>
                  <span className={CHIP_WARM}>
                    {selectedSummary?.channel === 'ai' ? selectedSummary?.thread : 'Care Team'}
                  </span>
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-semibold uppercase">{selectedSummary?.status?.replace('_', ' ')}</span>
                </div>
                <p className="mt-0.5 truncate text-[10px] font-semibold uppercase tracking-[.08em] text-muted-foreground/80">
                  {selectedSummary?.officeName ?? findAccount(selectedSummary?.providerId ?? '')?.officeName ?? 'Unknown office'}
                </p>
              </div>
            </div>
          </header>
          
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-paper-alt px-4 py-2 md:px-6">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock size={12} /> HQ read-only view</span>
          </div>

           <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
              <div className="mx-auto grid w-full max-w-[1050px] gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
             <div className="space-y-4 flex flex-col justify-end min-h-[400px]">
               {nextBefore && (
                <div className="text-center pb-4">
                 <button onClick={() => setBeforeCursor(nextBefore)} disabled={older.isFetching} className={`${BTN_SECONDARY} h-8 px-4 text-xs`}>
                     {older.isFetching ? 'Loading...' : 'Load older messages'}
                  </button>
                </div>
              )}
              {isEventsFetching && allEvents.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-10">Loading messages...</div>
              ) : eventsError ? (
                <div className="text-center text-xs text-destructive py-10">Failed to load messages.</div>
              ) : allEvents.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-10">No messages in this conversation.</div>
              ) : (
                <>
                  <p className="text-center text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground/80 mb-2">
                    Started {selectedSummary?.createdAt ? formatRelativeTime(selectedSummary.createdAt) : ''}
                  </p>
                  {allEvents.map((message) => (
                    <LiveMessageRow key={message.seq} message={message} />
                  ))}
                </>
              )}
            </div>
             <aside className="h-fit rounded-lg border border-card-border bg-card p-4 shadow-soft">
               <h3 className="font-serif text-sm font-bold text-navy">Internal notes</h3>
               <p className="mt-1 text-[10px] text-muted-foreground">Read-only · never shown to patients</p>
               {notes.isError ? <p role="alert" className="mt-3 text-xs text-destructive">Notes could not be loaded.</p> : (
                 <ul className="mt-3 space-y-2">{notes.data?.notes.map(note => <li key={note.id} className="rounded-md bg-paper-alt p-2 text-xs"><p>{note.body}</p><p className="mt-1 text-[9px] text-muted-foreground">{note.authorLabel} · {formatRelativeTime(note.createdAt)}</p></li>)}</ul>
               )}
             </aside>
             </div>
          </div>
        </>
      ) : (
        <div className="grid flex-1 place-items-center px-6 py-10">
          <div className="text-center">
            <MessagesSquare size={20} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs text-muted-foreground">Select a conversation to read it.</p>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <div className="flex h-full w-full min-h-[100dvh] bg-background">
      {listPane}
      {viewerPane}
    </div>
  );
}
