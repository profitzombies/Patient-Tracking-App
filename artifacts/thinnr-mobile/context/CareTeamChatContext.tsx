import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  getPatientCareTeam,
  getPatientCareTeamMessages,
  readPatientCareTeam,
  sendPatientCareTeamMessage,
  startPatientCareTeam,
} from '@workspace/api-client-react';
import type {
  PatientCareTeamConversation as GeneratedCareTeamConversation,
  PatientCareTeamMessage as GeneratedCareTeamMessage,
} from '@workspace/api-client-react';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { CareTeamUnreadContext } from '@/context/CareTeamUnreadContext';
import { subscribeChatSync } from '@/lib/chat-sync-events';
import { supabase } from '@/lib/supabase';

export type CareTeamConversation = GeneratedCareTeamConversation;
export type PatientCareTeamMessage = GeneratedCareTeamMessage;

interface PendingMessage {
  text: string;
  status: 'sending' | 'failed';
  error?: string;
  threadId?: string;
}

export interface CareTeamState {
  currentConversation: CareTeamConversation | null;
  retainedConversations: CareTeamConversation[];
  selectedConversation: CareTeamConversation | null;
  messages: PatientCareTeamMessage[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  error: string | null;
  draft: string;
  setDraft: (text: string) => void;
  sendMessage: (text: string) => void;
  retryMessage: (clientId: string) => void;
  markRead: (seq: number) => void;
  refresh: () => Promise<void>;
  loadOlder: () => Promise<void>;
  selectConversation: (conversation: CareTeamConversation) => void;
  setScreenFocused: (focused: boolean) => void;
  pendingMessages: Record<string, PendingMessage>;
}

const CareTeamContext = createContext<CareTeamState | null>(null);
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const PAGE_SIZE = 100;

function generateClientId(): string {
  return `patient-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`.slice(0, 64);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === 'object') {
    const value = error as { error?: unknown; detail?: unknown };
    if (typeof value.detail === 'string' && value.detail.trim()) return value.detail.trim();
    if (typeof value.error === 'string' && value.error.trim()) return value.error.trim();
  }
  return fallback;
}

function validConversation(value: unknown): value is CareTeamConversation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CareTeamConversation>;
  return typeof item.id === 'string' && item.id.length > 0 &&
    typeof item.businessName === 'string' &&
    typeof item.canSend === 'boolean' &&
    typeof item.lastMessageSeq === 'number' &&
    typeof item.lastReadSeq === 'number';
}

function validMessage(value: unknown): value is PatientCareTeamMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PatientCareTeamMessage>;
  return Number.isInteger(item.seq) && (item.seq ?? 0) > 0 &&
    typeof item.clientId === 'string' && CLIENT_ID.test(item.clientId) &&
    (item.sender === 'patient' || item.sender === 'care_team') &&
    typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 4000 &&
    typeof item.createdAt === 'string' && !Number.isNaN(Date.parse(item.createdAt));
}

function mergeMessages(
  previous: PatientCareTeamMessage[],
  incoming: PatientCareTeamMessage[],
): PatientCareTeamMessage[] {
  const bySeq = new Map<number, PatientCareTeamMessage>();
  for (const message of previous) bySeq.set(message.seq, message);
  for (const message of incoming) {
    const existing = bySeq.get(message.seq);
    if (existing && existing.clientId !== message.clientId) {
      throw new Error('The care team returned conflicting message history.');
    }
    bySeq.set(message.seq, message);
  }
  const clientIds = new Map<string, number>();
  const result: PatientCareTeamMessage[] = [];
  for (const message of [...bySeq.values()].sort((a, b) => a.seq - b.seq)) {
    const priorSeq = clientIds.get(message.clientId);
    if (priorSeq !== undefined && priorSeq !== message.seq) {
      throw new Error('The care team returned a duplicate message identifier.');
    }
    clientIds.set(message.clientId, message.seq);
    result.push(message);
  }
  return result;
}

type Operation = { epoch: number; accountKey: string };

export function CareTeamChatProvider({ children }: { children: React.ReactNode }) {
  const { account, resolving } = usePatientAccount();
  const accountKey = account.kind === 'real' ? `real:${account.patientId}` : account.kind;
  const operationRef = useRef<Operation>({ epoch: 0, accountKey });
  if (operationRef.current.accountKey !== accountKey) {
    operationRef.current = { epoch: operationRef.current.epoch + 1, accountKey };
  }

  const [currentConversation, setCurrentConversation] = useState<CareTeamConversation | null>(null);
  const [retainedConversations, setRetainedConversations] = useState<CareTeamConversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<CareTeamConversation | null>(null);
  const [messages, setMessages] = useState<PatientCareTeamMessage[]>([]);
  const messagesRef = useRef<PatientCareTeamMessage[]>([]);
  messagesRef.current = messages;
  const [pendingMessages, setPendingMessages] = useState<Record<string, PendingMessage>>({});
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const focusedRef = useRef(false);
  const selectedRef = useRef<CareTeamConversation | null>(null);
  const currentRef = useRef<CareTeamConversation | null>(null);
  const fetchedTailRef = useRef(0);
  const loadGenerationRef = useRef(0);
  selectedRef.current = selectedConversation;
  currentRef.current = currentConversation;

  const demoMessages = useRef<PatientCareTeamMessage[]>([
    {
      seq: 1,
      clientId: 'demo-care-team-welcome',
      sender: 'care_team',
      text: 'Hello! I am your care coordinator. How can I help you today?',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ]);
  const demoNextSeq = useRef(2);

  const isCurrent = useCallback((operation: Operation) =>
    operationRef.current.epoch === operation.epoch &&
    operationRef.current.accountKey === operation.accountKey, []);

  type CapturedSession = { token: string; userId: string };
  const bearerFor = useCallback(async (operation: Operation): Promise<CapturedSession | null> => {
    const result = await supabase?.auth.getSession();
    if (!isCurrent(operation)) return null;
    const token = result?.data.session?.access_token ?? null;
    const userId = result?.data.session?.user?.id ?? null;
    if (!token) throw new Error('Your session has expired. Please sign in again.');
    if (!userId) throw new Error('Your authenticated patient session is invalid.');
    return { token, userId };
  }, [isCurrent]);

  const sessionCurrent = useCallback(async (
    operation: Operation,
    captured: CapturedSession,
  ): Promise<boolean> => {
    const result = await supabase?.auth.getSession();
    if (!isCurrent(operation)) return false;
    const session = result?.data.session;
    return session?.access_token === captured.token && session.user?.id === captured.userId;
  }, [isCurrent]);

  const requestOptions = (token: string) => ({
    headers: { Authorization: `Bearer ${token}` },
  });

  const applyPage = useCallback((
    operation: Operation,
    conversationId: string,
    response: unknown,
    replace: boolean,
    updateOlderCursor: boolean,
    updateFetchedTail: boolean,
  ) => {
    if (!isCurrent(operation) || selectedRef.current?.id !== conversationId) return;
    const page = response as {
      conversation?: unknown;
      messages?: unknown;
      nextBefore?: unknown;
    };
    if (!validConversation(page.conversation) || page.conversation.id !== conversationId ||
        !Array.isArray(page.messages) || !page.messages.every(validMessage)) {
      throw new Error('The care team returned an invalid conversation response.');
    }
    setSelectedConversation(page.conversation);
    if (page.conversation.current) setCurrentConversation(page.conversation);
    const merged = mergeMessages(replace ? [] : messagesRef.current, page.messages as PatientCareTeamMessage[]);
    messagesRef.current = merged;
    setMessages(merged);
    if (updateOlderCursor) setNextBefore(typeof page.nextBefore === 'number' ? page.nextBefore : null);
    if (updateFetchedTail && page.messages.length) {
      fetchedTailRef.current = Math.max(
        fetchedTailRef.current,
        ...(page.messages as PatientCareTeamMessage[]).map(message => message.seq),
      );
    }
    const incomingIds = new Set((page.messages as PatientCareTeamMessage[]).map(message => message.clientId));
    if (incomingIds.size) {
      setPendingMessages(previous => {
        const next = { ...previous };
        for (const id of incomingIds) delete next[id];
        return next;
      });
    }
  }, [isCurrent]);

  const loadConversation = useCallback(async (
    operation: Operation,
    conversation: CareTeamConversation,
    session: CapturedSession,
  ) => {
    const generation = ++loadGenerationRef.current;
    const hadMessages = messagesRef.current.length > 0;
    const response = await getPatientCareTeamMessages(
      conversation.id,
      { limit: PAGE_SIZE },
      requestOptions(session.token),
    );
    if (!await sessionCurrent(operation, session)) return;
    if (selectedRef.current?.id !== conversation.id || loadGenerationRef.current !== generation) return;
    const next = response as { nextBefore?: unknown };
    // A newest-page refresh is additive: it must not erase acknowledged or
    // incrementally fetched messages, already-loaded older history, or a
    // known older cursor merely because this page has no before boundary.
    applyPage(
      operation,
      conversation.id,
      response,
      false,
      !hadMessages || typeof next.nextBefore === 'number',
      true,
    );
  }, [applyPage, sessionCurrent]);

  const loadData = useCallback(async (background = false): Promise<void> => {
    if (resolving || account.kind === 'unresolved') return;
    const operation = { ...operationRef.current };
    if (account.kind === 'demo') {
      const conversation: CareTeamConversation = {
        id: 'demo-thread',
        providerId: 'demo-provider',
        businessName: 'MED SPA OPERATIONS DEMO',
        current: true,
        canSend: true,
        status: 'open',
        unreadCount: 0,
        lastMessageSeq: demoNextSeq.current - 1,
        lastReadSeq: demoNextSeq.current - 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!isCurrent(operation)) return;
      setCurrentConversation(conversation);
      setSelectedConversation(conversation);
      messagesRef.current = [...demoMessages.current];
      setMessages([...demoMessages.current]);
      setError(null);
      return;
    }

    if (!background) setLoading(true);
    try {
      const session = await bearerFor(operation);
      if (!session || !isCurrent(operation)) return;
      const rawStatus = await getPatientCareTeam(requestOptions(session.token));
      if (!await sessionCurrent(operation, session)) return;
      const status = rawStatus as { current?: unknown; retained?: unknown };
      if (status.current !== null && !validConversation(status.current)) {
        throw new Error('The care team returned an invalid account response.');
      }
      if (!Array.isArray(status.retained) || !status.retained.every(validConversation)) {
        throw new Error('The care team returned invalid retained conversations.');
      }
      const retained = status.retained as CareTeamConversation[];
      setRetainedConversations(retained);
      let current = status.current as CareTeamConversation | null;
      let startFailure: string | null = null;
      if (!current) {
        try {
          const started = await startPatientCareTeam({}, requestOptions(session.token));
          if (!await sessionCurrent(operation, session)) return;
          const candidate = (started as { conversation?: unknown }).conversation;
          if (!validConversation(candidate)) throw new Error('The care team could not create a conversation.');
          current = candidate;
        } catch (cause) {
          if (!await sessionCurrent(operation, session)) return;
          startFailure = errorMessage(cause, 'Your current office is unavailable for new messages.');
          if (retained.length === 0) throw cause;
        }
      }
      setCurrentConversation(current);

      const selected = selectedRef.current;
      const target = selected
        ? (selected.id === current?.id
          ? current
          : retained.find(item => item.id === selected.id) ?? current ?? retained[0])
        : (current ?? retained[0]);
      if (!target) throw new Error('No care team conversation is available.');
      setSelectedConversation(target);
      selectedRef.current = target;
      await loadConversation(operation, target, session);
      if (!isCurrent(operation)) return;
      setError(startFailure);
    } catch (cause) {
      if (isCurrent(operation)) setError(errorMessage(cause, 'Unable to load your care team conversation.'));
    } finally {
      if (!background && isCurrent(operation)) setLoading(false);
    }
  }, [account.kind, bearerFor, isCurrent, loadConversation, resolving, sessionCurrent]);

  useEffect(() => {
    selectedRef.current = null;
    setMessages([]);
    messagesRef.current = [];
    setPendingMessages({});
    setCurrentConversation(null);
    setRetainedConversations([]);
    setSelectedConversation(null);
    setNextBefore(null);
    fetchedTailRef.current = 0;
    loadGenerationRef.current += 1;
    setDraft('');
    setError(account.kind === 'unresolved' && !resolving
      ? 'Care team messaging is unavailable until your patient account is ready.'
      : null);
    setLoading(false);
    setLoadingOlder(false);
    if (!resolving && account.kind !== 'unresolved') void loadData();
  }, [accountKey, resolving]); // loadData intentionally omitted: this is an account admission boundary.

  const incrementalRefresh = useCallback(async (): Promise<void> => {
    if (account.kind !== 'real' || !focusedRef.current) return;
    const conversation = selectedRef.current;
    if (!conversation) return;
    const operation = { ...operationRef.current };
    try {
      const session = await bearerFor(operation);
      if (!session || !isCurrent(operation)) return;
      let after = fetchedTailRef.current;
      do {
        const response = await getPatientCareTeamMessages(
          conversation.id,
          after > 0 ? { after, limit: PAGE_SIZE } : { limit: PAGE_SIZE },
          requestOptions(session.token),
        );
        if (!await sessionCurrent(operation, session) || selectedRef.current?.id !== conversation.id) return;
        applyPage(operation, conversation.id, response, false, false, true);
        const nextAfter = (response as { nextAfter?: unknown }).nextAfter;
        if (typeof nextAfter !== 'number' || nextAfter <= after) break;
        after = nextAfter;
      } while (true);
      setError(null);
    } catch (cause) {
      if (isCurrent(operation)) setError(errorMessage(cause, 'Unable to refresh care team messages.'));
    }
  }, [account.kind, applyPage, bearerFor, isCurrent, sessionCurrent]);

  useEffect(() => {
    if (account.kind !== 'real') return;
    const timer = setInterval(() => {
      if (focusedRef.current && AppState.currentState === 'active') void incrementalRefresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [account.kind, incrementalRefresh]);

  useEffect(() => {
    if (account.kind !== 'real') return;
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active' && focusedRef.current) void incrementalRefresh();
    });
    return () => subscription.remove();
  }, [account.kind, incrementalRefresh]);

  useEffect(() => subscribeChatSync(thread => {
    if (thread === 'care_team' && account.kind === 'real' && focusedRef.current) {
      void incrementalRefresh();
    }
  }), [account.kind, incrementalRefresh]);

  const setScreenFocused = useCallback((focused: boolean) => {
    focusedRef.current = focused;
    if (focused) void loadData(false);
  }, [loadData]);

  const selectConversation = useCallback((conversation: CareTeamConversation) => {
    if (!validConversation(conversation)) return;
    selectedRef.current = conversation;
    setSelectedConversation(conversation);
    setMessages([]);
    messagesRef.current = [];
    setNextBefore(null);
    fetchedTailRef.current = 0;
    loadGenerationRef.current += 1;
    setError(null);
    if (account.kind === 'demo') return;
    const operation = { ...operationRef.current };
    void (async () => {
      setLoading(true);
      try {
        const session = await bearerFor(operation);
        if (!session || !isCurrent(operation)) return;
        await loadConversation(operation, conversation, session);
      } catch (cause) {
        if (isCurrent(operation) && selectedRef.current?.id === conversation.id) {
          setError(errorMessage(cause, 'Unable to open this retained conversation.'));
        }
      } finally {
        if (isCurrent(operation) && selectedRef.current?.id === conversation.id) setLoading(false);
      }
    })();
  }, [account.kind, bearerFor, isCurrent, loadConversation]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const conversation = selectedRef.current;
    if (account.kind !== 'real' || !conversation || nextBefore === null || loadingOlder) return;
    const operation = { ...operationRef.current };
    setLoadingOlder(true);
    try {
      const session = await bearerFor(operation);
      if (!session || !isCurrent(operation)) return;
      const response = await getPatientCareTeamMessages(
        conversation.id,
        { before: nextBefore, limit: PAGE_SIZE },
        requestOptions(session.token),
      );
      if (!await sessionCurrent(operation, session) || selectedRef.current?.id !== conversation.id) return;
      applyPage(operation, conversation.id, response, false, true, false);
      setError(null);
    } catch (cause) {
      if (isCurrent(operation)) setError(errorMessage(cause, 'Unable to load earlier messages.'));
    } finally {
      if (isCurrent(operation)) setLoadingOlder(false);
    }
  }, [account.kind, applyPage, bearerFor, isCurrent, loadingOlder, nextBefore, sessionCurrent]);

  const sendInternal = useCallback(async (clientId: string, text: string, intendedThreadId?: string) => {
    const normalized = text.trim();
    if (!CLIENT_ID.test(clientId) || !normalized || normalized.length > 4000) {
      setError('Messages must contain between 1 and 4,000 characters.');
      return;
    }
    const operation = { ...operationRef.current };
    let targetThreadId = intendedThreadId ?? currentRef.current?.id;
    setPendingMessages(previous => ({
      ...previous,
      [clientId]: { text: normalized, status: 'sending', threadId: targetThreadId },
    }));

    if (account.kind === 'demo') {
      const message: PatientCareTeamMessage = {
        seq: demoNextSeq.current++,
        clientId,
        sender: 'patient',
        text: normalized,
        createdAt: new Date().toISOString(),
      };
      if (!isCurrent(operation)) return;
      demoMessages.current = mergeMessages(demoMessages.current, [message]);
      messagesRef.current = [...demoMessages.current];
      setMessages([...demoMessages.current]);
      setPendingMessages(previous => {
        const next = { ...previous };
        delete next[clientId];
        return next;
      });
      return;
    }
    if (account.kind !== 'real') return;

    try {
      const session = await bearerFor(operation);
      if (!session || !isCurrent(operation)) return;
      let conversation = currentRef.current;
      if (targetThreadId && conversation?.id !== targetThreadId) {
        throw new Error('This message belongs to a different care team conversation and was not sent.');
      }
      if (!conversation) {
        const started = await startPatientCareTeam({}, requestOptions(session.token));
        if (!await sessionCurrent(operation, session)) return;
        const candidate = (started as { conversation?: unknown }).conversation;
        if (!validConversation(candidate)) throw new Error('The care team could not create a conversation.');
        conversation = candidate;
        targetThreadId = candidate.id;
        currentRef.current = candidate;
        setCurrentConversation(candidate);
        setSelectedConversation(candidate);
        selectedRef.current = candidate;
        setPendingMessages(previous => previous[clientId]
          ? { ...previous, [clientId]: { ...previous[clientId], threadId: candidate.id } }
          : previous);
      }
      if (!conversation.canSend) throw new Error('This conversation is read-only.');
      const response = await sendPatientCareTeamMessage(
        conversation.id,
        { clientId, text: normalized },
        requestOptions(session.token),
      );
      if (!await sessionCurrent(operation, session) || currentRef.current?.id !== conversation.id) return;
      const message = (response as { message?: unknown }).message;
      if (!validMessage(message) || message.clientId !== clientId || message.text !== normalized ||
          message.sender !== 'patient') {
        throw new Error('The care team returned an invalid delivery confirmation.');
      }
      if (selectedRef.current?.id === conversation.id) {
        const merged = mergeMessages(messagesRef.current, [message]);
        messagesRef.current = merged;
        setMessages(merged);
      }
      setPendingMessages(previous => {
        const next = { ...previous };
        delete next[clientId];
        return next;
      });
      setError(null);
    } catch (cause) {
      if (!isCurrent(operation)) return;
      const detail = errorMessage(cause, 'Message was not sent.');
      setPendingMessages(previous => ({
        ...previous,
        [clientId]: { text: normalized, status: 'failed', error: detail, threadId: targetThreadId },
      }));
      setError(detail);
    }
  }, [account.kind, bearerFor, isCurrent, sessionCurrent]);

  const sendMessage = useCallback((text: string) => {
    void sendInternal(generateClientId(), text);
  }, [sendInternal]);

  const retryMessage = useCallback((clientId: string) => {
    const pending = pendingMessages[clientId];
    if (pending?.status !== 'failed') return;
    const conversation = currentRef.current;
    const selected = selectedRef.current;
    if (!pending.threadId || conversation?.id !== pending.threadId ||
        selected?.id !== pending.threadId || !conversation.canSend || !selected.canSend) {
      setError('This message belongs to a read-only or previous care team conversation and was not sent.');
      return;
    }
    void sendInternal(clientId, pending.text, pending.threadId);
  }, [pendingMessages, sendInternal]);

  const markRead = useCallback(async (seq: number) => {
    const conversation = selectedRef.current;
    if (account.kind !== 'real' || !conversation?.current || !Number.isInteger(seq) || seq < 1) return;
    const operation = { ...operationRef.current };
    try {
      const session = await bearerFor(operation);
      if (!session || !isCurrent(operation)) return;
      const response = await readPatientCareTeam(
        conversation.id,
        { throughSeq: seq },
        requestOptions(session.token),
      );
      if (!await sessionCurrent(operation, session) || selectedRef.current?.id !== conversation.id) return;
      const lastReadSeq = (response as { lastReadSeq?: unknown }).lastReadSeq;
      if (!Number.isInteger(lastReadSeq) || (lastReadSeq as number) < 0) {
        throw new Error('The care team returned an invalid read confirmation.');
      }
      setCurrentConversation(previous => previous?.id === conversation.id
        ? { ...previous, lastReadSeq: Math.max(previous.lastReadSeq, lastReadSeq as number), unreadCount: 0 }
        : previous);
      setSelectedConversation(previous => previous?.id === conversation.id
        ? { ...previous, lastReadSeq: Math.max(previous.lastReadSeq, lastReadSeq as number), unreadCount: 0 }
        : previous);
    } catch (cause) {
      if (isCurrent(operation)) setError(errorMessage(cause, 'Unable to mark messages as read.'));
    }
  }, [account.kind, bearerFor, isCurrent, sessionCurrent]);

  const value = useMemo<CareTeamState>(() => ({
    currentConversation,
    retainedConversations,
    selectedConversation,
    messages,
    loading: loading || resolving,
    loadingOlder,
    hasOlder: nextBefore !== null,
    error,
    draft,
    setDraft,
    sendMessage,
    retryMessage,
    markRead,
    refresh: () => loadData(false),
    loadOlder,
    selectConversation,
    setScreenFocused,
    pendingMessages: Object.fromEntries(
      Object.entries(pendingMessages).filter(([, pending]) =>
        !pending.threadId || pending.threadId === selectedConversation?.id),
    ),
  }), [
    currentConversation, draft, error, loadData, loadOlder, loading, loadingOlder, markRead,
    messages, nextBefore, pendingMessages, retainedConversations, resolving, retryMessage,
    selectConversation, selectedConversation, sendMessage, setScreenFocused,
  ]);

  const unreadCount = currentConversation?.unreadCount ?? 0;

  return (
    <CareTeamUnreadContext.Provider value={unreadCount}>
      <CareTeamContext.Provider value={value}>{children}</CareTeamContext.Provider>
    </CareTeamUnreadContext.Provider>
  );
}

export function useCareTeamChat(): CareTeamState {
  const context = useContext(CareTeamContext);
  if (!context) throw new Error('useCareTeamChat must be used within CareTeamChatProvider');
  return context;
}