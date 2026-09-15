import { useState, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft, MessagesSquare, Search, AlertTriangle, Send } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BTN_SECONDARY, CHIP_WARM } from '@/components/patient/heritage';
import { useSession } from '@/contexts/session';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import { useToast } from '@/hooks/use-toast';
import { InitialsAvatar, formatRelativeTime, LiveMessageRow, ThreadNotesPanel, ThreadNotesToggle, useThreadNotesPanel, scrollThreadToNewest, planThreadFollow, refreshThreadFollowBaseline, type ThreadFollowState } from '@/components/conversations/shared';
import {
  useGetOfficeConversations,
  useGetOfficeConversationEvents,
  useGetOfficeConversationSummary,
  useGetOfficeConversationStaff,
  useGetOfficeConversationNotes,
  useAssignOfficeConversation,
  useSetOfficeConversationStatus,
  useReplyOfficeConversation,
  useAddOfficeConversationNote,
  useEscalateOfficeConversation,
  useStartOfficeConversation,
  useReadOfficeConversation,
  getGetOfficeConversationsQueryKey,
  getGetOfficeConversationEventsQueryKey,
  getGetOfficeConversationNotesQueryKey,
  getGetOfficeConversationSummaryQueryKey,
  getGetOfficeConversationStaffQueryKey,
  type GetOfficeConversationsThread,
  type GetOfficeConversationsStatus,
  type GetOfficeConversationsSort,
  type GetOfficeConversationsParams,
  type GetOfficeConversationEventsParams,
  type ConversationEvent,
} from '@workspace/api-client-react';
import { useLiveRoster } from '@/hooks/use-live-roster';

const CHANNELS = ['all', 'care_team', 'ai'] as const;
const THREADS = ['coach', 'support', 'care_team'] as const;
const STATUSES = ['open', 'waiting_patient', 'closed'] as const;
const SORTS = ['newest', 'oldest', 'waiting_longest', 'unread_first'] as const;
const oneOf = <T extends string>(value: string | null, values: readonly T[], fallback: T): T =>
  value !== null && values.some(candidate => candidate === value) ? value as T : fallback;

interface PendingReply {
  conversationId: string;
  clientId: string;
  text: string;
  error: string | null;
  epoch: number;
}

export default function OfficeConversations() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { authStatus, authUser, providerAccountCode, claimedWorkspace } = useSession();
  // HQ drill-ins must name the office on every inbox request; office staff
  // are scoped server-side and send nothing.
  const { liveOffice } = useLiveOfficeScope();
  const officeParams = useMemo(() => (liveOffice ? { office: liveOffice } : undefined), [liveOffice]);
  // The server refuses every HQ write on a care-team thread (and HQ can never
  // start one), so the drill-in shows those surfaces as read-only.
  const hqDrillIn = Boolean(liveOffice);
  const notesPanel = useThreadNotesPanel();
  const live = authStatus === 'signed-in';
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const params = new URLSearchParams(search);
  const openId = params.get('conversation') ?? params.get('c');
  const channelFilter = oneOf(params.get('channel'), CHANNELS, 'all');
  const rawThread = params.get('thread');
  const threadFilter: GetOfficeConversationsThread | null =
    rawThread && THREADS.some(value => value === rawThread) ? rawThread as GetOfficeConversationsThread : null;
  const rawStatus = params.get('status');
  const statusFilter: GetOfficeConversationsStatus | null =
    rawStatus && STATUSES.some(value => value === rawStatus) ? rawStatus as GetOfficeConversationsStatus : null;
  const assigneeFilter = params.get('assignee') ?? 'anyone';
  const unreadOnly = params.get('unread') === 'true';
  const sortFilter = oneOf(params.get('sort'), SORTS, 'newest') as GetOfficeConversationsSort;
  const queryFilter = params.get('q') ?? '';
  const startPatientId = params.get('startPatient');
  const requestedOffset = Number(params.get('offset'));
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;

  const [searchText, setSearchText] = useState(queryFilter);
  const limit = 20;
  const setOffset = (next: number | ((current: number) => number)) => {
    const value = typeof next === 'function' ? next(offset) : next;
    updateUrl({ offset: value > 0 ? String(value) : null, conversation: null });
  };
  const accountKey = `${authUser?.id ?? 'anonymous'}:${liveOffice ?? providerAccountCode ?? claimedWorkspace?.providerId ?? 'office'}`;
  const epochRef = useRef(0);
  const accountKeyRef = useRef(accountKey);
  const openIdRef = useRef(openId);
  accountKeyRef.current = accountKey;
  openIdRef.current = openId;

  const updateUrl = (changes: Record<string, string | null>, replace = true) => {
    const next = new URLSearchParams(search);
    next.delete('c');
    if (Object.keys(changes).some(key => ['channel', 'thread', 'status', 'assignee', 'unread', 'q', 'sort'].includes(key))) {
      next.delete('offset');
    }
    Object.entries(changes).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    navigate(`/conversations${next.toString() ? `?${next}` : ''}`, { replace });
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
    epochRef.current += 1;
    setAllEvents([]);
    setBeforeCursor(undefined);
    setFetchedThrough(undefined);
    setTranscriptLoadedFor('');
    setPendingReply(null);
    setReplyText('');
    setNoteText('');
    startedPatientRef.current = null;
  }, [accountKey]);

  useEffect(() => {
    if (searchText === queryFilter) return;
    const timer = window.setTimeout(() => { setOffset(0); updateUrl({ q: searchText.trim() || null, conversation: null }); }, 300);
    return () => window.clearTimeout(timer);
  }, [searchText, queryFilter]);

  const listParams = useMemo<GetOfficeConversationsParams>(() => ({
    ...officeParams,
    channel: channelFilter,
    thread: threadFilter ?? undefined,
    status: statusFilter ?? undefined,
    assignee: assigneeFilter === 'anyone' ? undefined : assigneeFilter,
    unread: unreadOnly || undefined, 
    q: queryFilter || undefined,
    sort: sortFilter, limit, offset,
  }), [officeParams, channelFilter, threadFilter, statusFilter, assigneeFilter, unreadOnly, queryFilter, sortFilter, offset]);

  const { data: convData, isFetching: isConvFetching, error: convError, refetch: refetchConversations } = useGetOfficeConversations(
    listParams,
    {
      query: {
        queryKey: [accountKey, ...getGetOfficeConversationsQueryKey(listParams)],
        enabled: live,
        refetchInterval: 5_000,
        refetchOnWindowFocus: true,
      }
    }
  );
  
  const summary = useGetOfficeConversationSummary(officeParams, {
    query: { enabled: live, queryKey: [accountKey, ...getGetOfficeConversationSummaryQueryKey(officeParams)], refetchInterval: 5_000, refetchOnWindowFocus: true },
  });
  const staff = useGetOfficeConversationStaff(officeParams, {
    query: { enabled: live, queryKey: [accountKey, ...getGetOfficeConversationStaffQueryKey(officeParams)] },
  });

  const conversations = convData?.conversations ?? [];
  const total = convData?.total ?? 0;
  const autoCloseDays = convData?.autoCloseDays;
  const hasMore = offset + limit < total;
  const hasPrev = offset > 0;

  const [beforeCursor, setBeforeCursor] = useState<number | undefined>();
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
  }, [openId, channelFilter, threadFilter, statusFilter]);

  const newestParams = useMemo<GetOfficeConversationEventsParams>(
    () => fetchedThrough ? { ...officeParams, after: fetchedThrough, limit: 30 } : { ...officeParams, limit: 30 },
    [officeParams, fetchedThrough],
  );
  const { data: eventsData, isFetching: isEventsFetching, error: eventsError } = useGetOfficeConversationEvents(
    openId ?? '',
    newestParams,
    {
      query: {
        enabled: live && !!openId,
        queryKey: [accountKey, ...getGetOfficeConversationEventsQueryKey(openId ?? '', newestParams)],
        refetchInterval: 5_000,
        refetchOnWindowFocus: true,
      }
    }
  );
  const olderParams = useMemo<GetOfficeConversationEventsParams>(
    () => ({ ...officeParams, before: beforeCursor, limit: 30 }),
    [officeParams, beforeCursor],
  );
  const older = useGetOfficeConversationEvents(openId ?? '', olderParams, {
    query: {
      enabled: live && !!openId && beforeCursor !== undefined,
      queryKey: [accountKey, 'older', ...getGetOfficeConversationEventsQueryKey(openId ?? '', olderParams)],
    },
  });

  useEffect(() => {
    if (eventsData?.events && accountKeyRef.current === accountKey && openIdRef.current === openId) {
      const loadedScope = `${accountKey}:${openId}`;
      setAllEvents(prev => {
        const newEvents = eventsData.events.filter(e => !prev.some(p => p.seq === e.seq));
        return [...prev, ...newEvents].sort((a, b) => a.seq - b.seq);
      });
      setTranscriptLoadedFor(loadedScope);
      if (fetchedThrough === undefined) setNextBefore(eventsData.nextBefore);
      if (eventsData.events.length > 0) {
        setFetchedThrough(current => Math.max(current ?? 0, ...eventsData.events.map(event => event.seq)));
      }
    }
  }, [eventsData, accountKey, openId]);

  useEffect(() => {
    if (!older.data?.events || accountKeyRef.current !== accountKey || openIdRef.current !== openId) return;
    setAllEvents(previous => {
      const bySeq = new Map(previous.map(event => [event.seq, event]));
      older.data.events.forEach(event => bySeq.set(event.seq, event));
      return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
    });
    setNextBefore(older.data.nextBefore);
  }, [older.data, accountKey, openId]);

  // Bring the newest message into view when a thread opens and when its
  // newest end grows (poll or sent reply). Keyed on the newest seq so paging
  // older messages in at the top never moves the reader.
  const threadPaneRef = useRef<HTMLDivElement>(null);
  const newestAnchorRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<ThreadFollowState | null>(null);
  const newestSeq = allEvents.length > 0 ? allEvents[allEvents.length - 1].seq : undefined;
  useEffect(() => {
    const threadKey = `${accountKey}:${openId}`;
    // Only act once THIS thread's transcript has landed: right after switching
    // threads, allEvents still holds the previous thread for a render, and a
    // decision taken then would be recorded against the new thread.
    if (newestSeq === undefined || transcriptLoadedFor !== threadKey) return;
    const plan = planThreadFollow(followRef.current, threadKey, threadPaneRef.current);
    followRef.current = plan.next;
    if (plan.follow) scrollThreadToNewest(threadPaneRef.current, newestAnchorRef.current);
  }, [accountKey, openId, newestSeq, transcriptLoadedFor]);
  // Older history prepended at the top changes the oldest seq, not the newest:
  // refresh the height baseline so that growth is never mistaken for new
  // messages by the next follow decision.
  const oldestSeq = allEvents.length > 0 ? allEvents[0].seq : undefined;
  useEffect(() => {
    followRef.current = refreshThreadFollowBaseline(followRef.current, threadPaneRef.current);
  }, [oldestSeq]);

  const explicit = openId;
  const selectedSummary = eventsData?.conversation ?? conversations.find(c => c.id === openId);
  const notes = useGetOfficeConversationNotes(openId ?? '', officeParams, { query: { enabled: live && !!openId, queryKey: [accountKey, ...getGetOfficeConversationNotesQueryKey(openId ?? '', officeParams)] } });
  const assign = useAssignOfficeConversation();
  const setStatus = useSetOfficeConversationStatus();
  const reply = useReplyOfficeConversation();
  const addNote = useAddOfficeConversationNote();
  const escalate = useEscalateOfficeConversation();
  const read = useReadOfficeConversation();
  const start = useStartOfficeConversation();
  const { data: roster, liveEnabled } = useLiveRoster();
  
  const [replyText, setReplyText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [escalationOpen, setEscalationOpen] = useState(false);
  const [department, setDepartment] = useState<'clinical' | 'support'>('clinical');
  const [reason, setReason] = useState('');
  const [escalationError, setEscalationError] = useState<string | null>(null);
  const [pendingReply, setPendingReply] = useState<PendingReply | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [patientSearch, setPatientSearch] = useState('');
  const readThroughByThreadRef = useRef(new Map<string, number>());
  useEffect(() => {
    setReplyText('');
    setNoteText('');
    setPendingReply(null);
  }, [accountKey, openId]);
  const startPatients = (liveEnabled ? roster?.patients ?? [] : []).filter(patient =>
    `${patient.name} ${patient.email ?? ''} ${patient.phone ?? ''}`.toLowerCase().includes(patientSearch.trim().toLowerCase()),
  ).slice(0, 10);

  const refresh = async (includeEvents = false) => {
    await Promise.all([
      refetchConversations(),
      summary.refetch(),
      ...(includeEvents && openId ? [queryClient.invalidateQueries({
        predicate: query => query.queryKey.includes(`/api/office/conversations/${openId}/events`),
      })] : []),
    ]);
  };

  useEffect(() => {
    const highestSeq = fetchedThrough;
    const readKey = `${accountKey}:${openId}`;
    if (!openId || !highestSeq || transcriptLoadedFor !== readKey) return;
    if (highestSeq <= (readThroughByThreadRef.current.get(readKey) ?? 0)) return;
    const epoch = epochRef.current;
    const conversationId = openId;
    readThroughByThreadRef.current.set(readKey, highestSeq);
    read.mutate(
      { conversationId, data: { throughSeq: highestSeq }, params: officeParams },
      {
        onSuccess: () => {
          if (epochRef.current === epoch && openIdRef.current === conversationId) void refresh();
        },
        onError: () => {
          if (epochRef.current === epoch && openIdRef.current === conversationId) readThroughByThreadRef.current.delete(readKey);
        },
      },
    );
  }, [openId, fetchedThrough, transcriptLoadedFor, accountKey]);

  const mutationError = (title: string, error: unknown) => {
    const status = (error as { status?: number })?.status;
    toast({ variant: 'destructive', title, description: status === 403 ? 'You do not have permission to perform this action.' : error instanceof Error ? error.message : 'Try again.' });
  };

  const changeAssignment = async (assigneeUserId: string | null) => {
    if (!openId) return;
    const operationScope = `${accountKey}:${openId}`;
    try {
      await assign.mutateAsync({ conversationId: openId, data: { assigneeUserId }, params: officeParams });
      if (`${accountKeyRef.current}:${openIdRef.current}` !== operationScope) return;
      await refresh();
      if (`${accountKeyRef.current}:${openIdRef.current}` === operationScope) toast({ variant: 'success', title: assigneeUserId === 'me' ? 'Conversation claimed' : 'Assignment updated' });
    } catch (e) {
      if (`${accountKeyRef.current}:${openIdRef.current}` === operationScope) mutationError('Assignment not updated', e);
    }
  };

  const changeStatus = async (status: 'open' | 'waiting_patient' | 'closed') => {
    if (!openId) return;
    const operationScope = `${accountKey}:${openId}`;
    try {
      await setStatus.mutateAsync({ conversationId: openId, data: { status }, params: officeParams });
      if (`${accountKeyRef.current}:${openIdRef.current}` !== operationScope) return;
      await refresh();
      if (`${accountKeyRef.current}:${openIdRef.current}` === operationScope) toast({ variant: 'success', title: status === 'open' ? 'Conversation reopened' : 'Status updated' });
    } catch (e) {
      if (`${accountKeyRef.current}:${openIdRef.current}` === operationScope) mutationError('Status not updated', e);
    }
  };

  const sendReply = async (retryPending?: PendingReply) => {
    if (!openId) return;
    const text = retryPending?.text ?? replyText.trim();
    if (!text) return;
    const epoch = epochRef.current;
    const attempted: PendingReply = retryPending?.conversationId === openId
      ? { ...retryPending, error: null }
      : { conversationId: openId, clientId: crypto.randomUUID(), text, error: null, epoch };
    setPendingReply(attempted);
    try {
      const result = await reply.mutateAsync({
        conversationId: attempted.conversationId,
        data: { text: attempted.text, clientId: attempted.clientId },
        params: officeParams,
      });
      if (
        epochRef.current !== attempted.epoch ||
        accountKeyRef.current !== accountKey ||
        openIdRef.current !== attempted.conversationId
      ) return;
      setAllEvents(prev => [...prev.filter(e => e.seq !== result.event.seq), result.event].sort((a, b) => a.seq - b.seq));
      setPendingReply(null);
      setReplyText('');
      await refresh(true);
      if (
        epochRef.current !== attempted.epoch ||
        accountKeyRef.current !== accountKey ||
        openIdRef.current !== attempted.conversationId
      ) return;
      toast({ variant: 'success', title: 'Reply sent' });
      if (result.conversation.id !== openId) {
        openConversation(result.conversation.id);
      }
    } catch (e) {
      if (epochRef.current !== attempted.epoch || accountKeyRef.current !== accountKey) return;
      const error = e instanceof Error ? e.message : 'Delivery could not be confirmed.';
      setPendingReply({ ...attempted, error });
      mutationError('Reply not sent', e);
    }
  };

  const startConversation = async (patientId: string) => {
    const epoch = epochRef.current;
    try {
      const result = await start.mutateAsync({ data: { patientId } });
      if (epochRef.current !== epoch || accountKeyRef.current !== accountKey) return;
      setStartOpen(false);
      setPatientSearch('');
      updateUrl({ channel: 'care_team', thread: null, conversation: result.conversation.id, startPatient: null }, false);
      await refresh();
    } catch (error) {
      if (epochRef.current === epoch) mutationError('Conversation not started', error);
    }
  };

  const saveNote = async () => {
    if (!openId || !noteText.trim()) return;
    const conversationId = openId;
    const body = noteText.trim();
    const operationScope = `${accountKey}:${conversationId}`;
    try {
      await addNote.mutateAsync({ conversationId, data: { body }, params: officeParams });
      if (`${accountKeyRef.current}:${openIdRef.current}` !== operationScope) return;
      setNoteText(current => current.trim() === body ? '' : current);
      await queryClient.invalidateQueries({ queryKey: [accountKey, ...getGetOfficeConversationNotesQueryKey(conversationId)] });
      await refresh();
      if (`${accountKeyRef.current}:${openIdRef.current}` === operationScope) toast({ variant: 'success', title: 'Internal note added' });
    } catch (e) {
      if (`${accountKeyRef.current}:${openIdRef.current}` === operationScope) mutationError('Note not added', e);
    }
  };

  const submitEscalation = async () => {
    if (!openId || !reason.trim()) return;
    const operationScope = `${accountKey}:${openId}`;
    setEscalationError(null);
    try {
      await escalate.mutateAsync({ conversationId: openId, data: { department, reason: reason.trim() }, params: officeParams });
      if (`${accountKeyRef.current}:${openIdRef.current}` !== operationScope) return;
      setEscalationOpen(false);
      setReason('');
      await refresh();
      if (`${accountKeyRef.current}:${openIdRef.current}` === operationScope) toast({ variant: 'success', title: 'Conversation escalated' });
    } catch (e) {
      if (`${accountKeyRef.current}:${openIdRef.current}` !== operationScope) return;
      if (e instanceof Error && 'status' in e && e.status === 409) setEscalationError('This conversation is already escalated.');
      else mutationError('Conversation not escalated', e);
    }
  };

  const avgLabel = (minutes: number | null | undefined) => minutes == null ? '—' : minutes < 60 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`;
  const startedPatientRef = useRef<string | null>(null);
  useEffect(() => {
    if (!live || hqDrillIn || !startPatientId || startedPatientRef.current === startPatientId) return;
    startedPatientRef.current = startPatientId;
    void startConversation(startPatientId);
  }, [live, hqDrillIn, startPatientId, accountKey]);

  if (!live) {
    return (
      <div className="grid min-h-[70vh] place-items-center bg-background px-6">
        <section className="max-w-lg rounded-lg border border-card-border bg-card p-6 text-center shadow-soft" data-testid="demo-conversations-local">
          <MessagesSquare className="mx-auto text-primary" aria-hidden="true" />
          <h1 className="mt-3 font-serif text-xl font-bold text-navy">Care Team conversations</h1>
          <p className="mt-2 text-sm text-muted-foreground">This guided-demo screen is local and makes no live messaging writes. Sign in to an office to search the roster, start a conversation, and use the shared inbox.</p>
        </section>
      </div>
    );
  }

  const listPane = (
    <aside
      className={`${explicit ? 'hidden lg:flex' : 'flex'} w-full min-w-0 flex-col border-r border-border bg-paper-alt lg:w-[410px] lg:shrink-0`}
    >
      <div className="shrink-0 space-y-2.5 border-b border-border px-4 pb-3.5 pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Inbox</p>
            <h1 className="font-serif text-lg font-bold leading-tight tracking-[-.01em] text-navy">Conversations</h1>
          </div>
          {total > 0 && (
            <span aria-live="polite" className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {offset + 1}-{Math.min(offset + limit, total)} of {total}
            </span>
          )}
          {!hqDrillIn && (
            <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[10px]`} onClick={() => setStartOpen(true)}>
              Start conversation
            </button>
          )}
        </div>

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

        {channelFilter === 'ai' && (
           <div className="flex gap-2 mb-2">
             <button
               onClick={() => updateUrl({ thread: null, conversation: null })}
               className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${!threadFilter ? 'bg-navy text-white' : 'bg-card text-muted-foreground border border-border'}`}
             >
               Any AI
             </button>
             <button
               onClick={() => updateUrl({ thread: 'coach', conversation: null })}
               className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${threadFilter === 'coach' ? 'bg-navy text-white' : 'bg-card text-muted-foreground border border-border'}`}
             >
               Coach
             </button>
             <button
               onClick={() => updateUrl({ thread: 'support', conversation: null })}
               className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${threadFilter === 'support' ? 'bg-navy text-white' : 'bg-card text-muted-foreground border border-border'}`}
             >
               Support
             </button>
           </div>
        )}

        {summary.isPending ? <p className="text-[11px] text-muted-foreground">Loading inbox metrics…</p> :
         summary.isError ? <p role="alert" className="text-[11px] text-destructive">Inbox metrics could not be loaded.</p> :
         <div className="grid grid-cols-5 gap-1" aria-label="Inbox metrics">
           {[
             ['Open', summary.data?.metrics.openThreads],
             ['Waiting', summary.data?.metrics.waitingOnPatient],
             ['Unanswered', summary.data?.metrics.unanswered],
             ['Avg response', avgLabel(summary.data?.metrics.avgResponseMinutes)],
             ['Escalated', summary.data?.metrics.openEscalations],
           ].map(([label, value]) => <div key={label} className="rounded-md border border-card-border bg-card p-1.5 text-center"><b className="block font-serif text-sm text-navy">{value}</b><span className="text-[8px] uppercase text-muted-foreground">{label}</span></div>)}
         </div>}
         
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-muted-foreground" />
          <input aria-label="Search conversations" value={searchText} onChange={e => setSearchText(e.target.value)} placeholder="Search patient or messages" className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Select value={statusFilter ?? 'all'} onValueChange={value => { setOffset(0); updateUrl({ status: value === 'all' ? null : value, conversation: null }); }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">Any status</SelectItem><SelectItem value="open">Open</SelectItem><SelectItem value="waiting_patient">Waiting on patient</SelectItem><SelectItem value="closed">Closed</SelectItem></SelectContent>
          </Select>
          <Select value={assigneeFilter} onValueChange={value => { setOffset(0); updateUrl({ assignee: value === 'anyone' ? null : value, conversation: null }); }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="anyone">Anyone</SelectItem><SelectItem value="me">Mine</SelectItem><SelectItem value="unassigned">Unassigned</SelectItem>{staff.data?.staff.map(person => <SelectItem key={person.userId} value={person.userId}>{person.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={sortFilter} onValueChange={value => { setOffset(0); updateUrl({ sort: value === 'newest' ? null : value, conversation: null }); }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="newest">Newest</SelectItem><SelectItem value="oldest">Oldest</SelectItem><SelectItem value="waiting_longest">Waiting longest</SelectItem><SelectItem value="unread_first">Unread first</SelectItem></SelectContent>
          </Select>
          <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 text-xs"><input type="checkbox" checked={unreadOnly} onChange={e => { setOffset(0); updateUrl({ unread: e.target.checked ? 'true' : null, conversation: null }); }} /> Unread only</label>
        </div>
        {autoCloseDays !== undefined && (
          <p className="text-[10px] text-muted-foreground" data-testid="text-auto-close-window">
            Closes after {autoCloseDays}d quiet · set in HQ organization policies
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isConvFetching && conversations.length === 0 ? (
          <div className="px-5 py-10 text-center text-xs text-muted-foreground">Loading...</div>
        ) : convError ? (
          <div className="px-5 py-10 text-center text-xs text-destructive">Failed to load conversations.</div>
        ) : conversations.length > 0 ? (
          <div className="flex flex-col h-full">
            <ul className="divide-y divide-border/60 flex-1">
              {conversations.map((conv) => {
                const isActive = openId === conv.id;
                const channel = conv.channel;
                
                return (
                  <li key={conv.id}>
                     <Link
                       href={`/conversations?${new URLSearchParams({ channel: channelFilter, conversation: conv.id }).toString()}`}
                       onClick={(event) => { event.preventDefault(); openConversation(conv.id); }}
                      className={`flex w-full items-start gap-3 border-l-2 px-3.5 py-3 text-left transition ${isActive ? 'border-primary bg-card shadow-soft' : 'border-transparent hover:bg-card/70'}`}
                    >
                       {conv.unread && <span className="mt-4 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread conversation" />}
                      <InitialsAvatar name={conv.patientName} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                           <b className={`truncate text-xs text-navy ${conv.unread ? 'font-bold' : 'font-semibold'}`}>
                             {conv.patientName}
                             {conv.thread === 'coach' && <span className="font-normal text-muted-foreground"> · {conv.title || 'New conversation'}</span>}
                           </b>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {conv.lastMessageAt ? formatRelativeTime(conv.lastMessageAt) : ''}
                          </span>
                        </span>
                         <span className="mt-1 flex flex-wrap gap-1 text-[9px] font-semibold uppercase">
                           <span className={CHIP_WARM}>{channel === 'ai' ? conv.thread : 'Care Team'}</span>
                           {conv.archivedAt && <span className="rounded bg-secondary px-1.5 py-0.5 text-muted-foreground border border-border">Archived</span>}
                           <span className="rounded bg-secondary px-1.5 py-0.5" data-testid={conv.autoClosed ? `chip-conversation-auto-closed-${conv.id}` : undefined}>{conv.autoClosed ? 'closed · quiet' : conv.status.replace('_', ' ')}</span>
                           {conv.openEscalation && <span className="rounded bg-warn-bg px-1.5 py-0.5 text-warn">Escalated · {conv.openEscalation.department}</span>}
                         </span>
                         <span className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{conv.preview || `${conv.messageCount} messages`}</span>
                         <span className="mt-1 flex gap-2 text-[10px] text-muted-foreground"><span>{conv.assignee?.label ?? 'Unassigned'}</span>{conv.noteCount > 0 && <span>{conv.noteCount} note{conv.noteCount === 1 ? '' : 's'}</span>}</span>
                      </span>
                     </Link>
                  </li>
                );
              })}
            </ul>
            {(hasPrev || hasMore) && (
              <div className="flex justify-between items-center px-4 py-3 border-t border-border">
                <button
                  disabled={!hasPrev || isConvFetching}
                  onClick={() => setOffset(o => Math.max(0, o - limit))}
                  className={`${BTN_SECONDARY} h-7 px-3 text-[10px]`}
                >
                  Newer
                </button>
                <button
                  disabled={!hasMore || isConvFetching}
                  onClick={() => setOffset(o => o + limit)}
                  className={`${BTN_SECONDARY} h-7 px-3 text-[10px]`}
                >
                  Older
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="px-5 py-10 text-center">
            <MessagesSquare size={18} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs font-semibold text-navy">No conversations</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {statusFilter === 'open'
                ? `No open conversations match. Threads quiet for ${autoCloseDays ?? 'the auto-close'} days are filed under Closed.`
                : statusFilter === 'closed'
                  ? `No closed conversations match yet.`
                  : `No live conversations match yet.`}
            </p>
          </div>
        )}
      </div>
    </aside>
  );

  const viewerPane = (
    <section className={`${explicit ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-card`}>
      {openId ? (
        <>
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 md:px-6">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {explicit && (
                <button
                  type="button"
                  className="mr-2 rounded-sm text-xs font-semibold text-primary hover:underline lg:hidden"
                  aria-label="Back to all conversations"
                  onClick={closeThread}
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                </button>
              )}
              <InitialsAvatar name={selectedSummary?.patientName ?? 'Patient'} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 className="truncate font-serif text-base font-bold tracking-[.01em] text-navy">
                    <Link href={`/patients/${selectedSummary?.patientId}`} className="hover:underline">
                      {selectedSummary?.patientName ?? 'Patient'}
                    </Link>
                  </h2>
                  <span className={CHIP_WARM}>
                    {selectedSummary?.channel === 'ai' ? selectedSummary.thread : 'Care Team'}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ThreadNotesToggle ref={notesPanel.toggleRef} open={notesPanel.open} count={notes.data?.notes.length ?? selectedSummary?.noteCount} onClick={notesPanel.toggle} />
              <Link href={`/patients/${selectedSummary?.patientId}`} className={`${BTN_SECONDARY} h-8 px-3 py-1.5 text-xs max-sm:hidden`}>
                View Profile
              </Link>
            </div>
          </header>
           {selectedSummary && hqDrillIn && selectedSummary.thread === 'care_team' && (
             <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground md:px-6" data-testid="text-hq-care-team-status">
               <span>{selectedSummary.assignee?.label ?? 'Unassigned'}</span>
               <span aria-hidden="true">·</span>
               <span>{selectedSummary.status === 'closed' ? (selectedSummary.autoClosed ? `Closed after ${autoCloseDays ?? '—'}d quiet` : 'Closed') : selectedSummary.status === 'waiting_patient' ? 'Waiting on patient' : 'Open'}</span>
             </div>
           )}
           {selectedSummary && !(hqDrillIn && selectedSummary.thread === 'care_team') && (
             <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2 md:px-6">
               <button className={`${BTN_SECONDARY} h-8 px-3 text-xs`} disabled={assign.isPending} onClick={() => changeAssignment('me')}>Claim</button>
               <Select value={selectedSummary.assignee?.userId ?? 'unassigned'} onValueChange={value => changeAssignment(value === 'unassigned' ? null : value)}>
                 <SelectTrigger aria-label="Assign conversation" className="h-8 w-[170px] text-xs"><SelectValue /></SelectTrigger>
                 <SelectContent><SelectItem value="unassigned">Unassign</SelectItem>{staff.data?.staff.map(person => <SelectItem key={person.userId} value={person.userId}>{person.label}</SelectItem>)}</SelectContent>
               </Select>
               <div className="flex rounded-md bg-muted p-1" aria-label="Conversation status">
                 {selectedSummary.status === 'closed' ? (
                   <>
                     {selectedSummary.autoClosed && <span className="self-center px-2 text-[10px] text-muted-foreground">Closed after {autoCloseDays ?? '—'}d quiet</span>}
                     <button className="rounded-sm bg-card px-3 py-1 text-xs font-semibold" disabled={setStatus.isPending} onClick={() => changeStatus('open')}>Reopen</button>
                   </>
                 ) : <>
                   {([['open', 'Open'], ['waiting_patient', 'Waiting on patient'], ['closed', 'Closed']] as const).map(([value, label]) => (
                     <button key={value} disabled={setStatus.isPending} onClick={() => changeStatus(value)} className={`rounded-sm px-2 py-1 text-[10px] font-semibold ${selectedSummary.status === value ? 'bg-card text-navy shadow-xs' : 'text-muted-foreground'}`}>{label}</button>
                   ))}
                 </>}
               </div>
               {selectedSummary.thread !== 'care_team' && (
                 <button className={`${BTN_SECONDARY} ml-auto h-8 px-3 text-xs`} disabled={!!selectedSummary.openEscalation} onClick={() => setEscalationOpen(true)}><AlertTriangle size={12} /> {selectedSummary.openEscalation ? 'Escalated' : 'Escalate'}</button>
               )}
             </div>
           )}

           <div className="relative flex min-h-0 flex-1">
           <div className="flex min-w-0 flex-1 flex-col">
           <div ref={threadPaneRef} data-testid="conversation-thread-pane" className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
             <div className="mx-auto w-full max-w-[820px] space-y-4" data-testid="conversation-thread">
               {nextBefore && (
                <div className="text-center pb-4">
                  <button
                    onClick={() => setBeforeCursor(nextBefore)}
                    disabled={older.isFetching}
                    className={`${BTN_SECONDARY} h-8 px-4 text-xs`}
                  >
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
                  <div ref={newestAnchorRef} aria-hidden="true" className="h-px" />
                </>
              )}
            </div>
          </div>

           <footer className="shrink-0 border-t border-border bg-card px-4 py-3 md:px-6">
             {hqDrillIn ? (
               <p className="mx-auto max-w-[820px] text-xs text-muted-foreground" data-testid="text-hq-read-only">
                 HQ view is read-only. Care-team replies are sent by the office’s own staff.
               </p>
             ) : selectedSummary?.channel === 'ai' ? (
               <div className="mx-auto max-w-[820px]">
                 <p className="mb-2 text-xs text-muted-foreground">Human replies belong in the patient’s separate Care Team conversation.</p>
                 <button className="rounded-md bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50" disabled={start.isPending} onClick={() => startConversation(selectedSummary.patientId)}>
                   {start.isPending ? 'Opening…' : 'Open Care Team conversation'}
                 </button>
               </div>
             ) : (
               <div className="mx-auto max-w-[820px]">
                 {pendingReply?.conversationId === openId && pendingReply.error && (
                   <div role="alert" className="mb-2 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                     <span>Reply not sent: {pendingReply.error} Your exact message is preserved.</span>
                     <button type="button" className={BTN_SECONDARY} disabled={reply.isPending} onClick={() => void sendReply(pendingReply)}>Retry</button>
                   </div>
                 )}
                 <div className="flex gap-2">
                   <textarea aria-label="Reply to patient" value={replyText} onChange={e => setReplyText(e.target.value)} maxLength={4000} rows={2} placeholder="Write a care-team reply…" className="min-w-0 flex-1 rounded-md border border-input bg-background p-2 text-xs focus:ring-2 focus:ring-ring outline-none" />
                   <button className="rounded-md bg-primary px-4 flex items-center justify-center gap-2 text-xs font-bold text-primary-foreground disabled:opacity-50 transition-transform active:scale-[0.98]" disabled={reply.isPending || !replyText.trim()} onClick={() => void sendReply()}>
                     <Send size={14} />
                     {reply.isPending ? 'Sending…' : 'Send'}
                   </button>
                 </div>
               </div>
             )}
           </footer>
           </div>
           <ThreadNotesPanel
             open={notesPanel.open}
             onClose={notesPanel.close}
             caption="Internal — patients never see notes"
             notes={notes.data?.notes}
             isError={notes.isError}
             composer={!hqDrillIn ? (
               <>
                 <textarea aria-label="New internal note" value={noteText} onChange={e => setNoteText(e.target.value)} maxLength={4000} rows={3} placeholder="Add an internal note…" className="w-full rounded-md border border-input bg-background p-2 text-xs outline-none focus:ring-2 focus:ring-ring" />
                 <div className="mt-2 flex justify-end">
                   <button className={`${BTN_SECONDARY} h-8 px-3 text-xs`} disabled={addNote.isPending || !noteText.trim()} onClick={saveNote}>{addNote.isPending ? 'Adding…' : 'Add note'}</button>
                 </div>
               </>
             ) : undefined}
           />
           </div>
        </>
      ) : (
        <div className="grid flex-1 place-items-center px-6 py-10">
          <div className="text-center">
            <MessagesSquare size={20} className="mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs text-muted-foreground">
              Select a conversation to read it.
            </p>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <div className="flex h-full w-full bg-background">
      {listPane}
      {viewerPane}
       <Dialog open={escalationOpen} onOpenChange={setEscalationOpen}>
         <DialogContent>
           <DialogHeader><DialogTitle>Escalate to HQ</DialogTitle><DialogDescription>Send this conversation to the appropriate HQ queue.</DialogDescription></DialogHeader>
           <fieldset className="flex gap-4 text-sm"><legend className="sr-only">Department</legend><label><input type="radio" checked={department === 'clinical'} onChange={() => setDepartment('clinical')} /> Clinical</label><label><input type="radio" checked={department === 'support'} onChange={() => setDepartment('support')} /> Support</label></fieldset>
           <textarea aria-label="Escalation reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} rows={5} className="w-full rounded-md border border-input p-3 text-sm focus:ring-2 focus:ring-ring outline-none" placeholder="Reason for escalation" />
           {escalationError && <p role="alert" className="text-sm text-destructive">{escalationError}</p>}
           <DialogFooter><button className={BTN_SECONDARY} onClick={() => setEscalationOpen(false)}>Cancel</button><button className="rounded-md bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50" disabled={escalate.isPending || !reason.trim()} onClick={submitEscalation}>{escalate.isPending ? 'Escalating…' : 'Escalate'}</button></DialogFooter>
         </DialogContent>
       </Dialog>
       <Dialog open={startOpen} onOpenChange={setStartOpen}>
         <DialogContent>
           <DialogHeader>
             <DialogTitle>Start a Care Team conversation</DialogTitle>
             <DialogDescription>Search the office roster, including patients who have no conversation history.</DialogDescription>
           </DialogHeader>
           <input aria-label="Search office patients" value={patientSearch} onChange={event => setPatientSearch(event.target.value)} placeholder="Patient name, email, or phone" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
           {!liveEnabled ? (
             <p role="status" className="text-xs text-muted-foreground">Starting conversations is available after signing in to an office.</p>
           ) : startPatients.length === 0 ? (
             <p className="text-xs text-muted-foreground">No office patients match this search.</p>
           ) : (
             <ul className="max-h-72 divide-y divide-border overflow-y-auto">
               {startPatients.map(patient => (
                 <li key={patient.id} className="flex items-center justify-between gap-3 py-2">
                   <span className="min-w-0"><b className="block truncate text-xs">{patient.name}</b><span className="block truncate text-[10px] text-muted-foreground">{patient.email ?? patient.phoneDisplay ?? 'No contact details'}</span></span>
                   <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-xs`} disabled={start.isPending} onClick={() => void startConversation(patient.id)}>Start</button>
                 </li>
               ))}
             </ul>
           )}
         </DialogContent>
       </Dialog>
    </div>
  );
}
