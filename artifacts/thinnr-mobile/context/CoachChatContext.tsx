/**
 * Session-only chat state for the THINNR coach.
 *
 * History lives in React state on purpose: no database, no AsyncStorage. A
 * fresh app launch always starts a fresh conversation. Message shape carries
 * an optional `card` slot so later work can attach rich cards (recipes,
 * products) to assistant replies without changing this contract.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { streamCoachChat, type CoachRequestMessage } from '@/lib/coach-api';
import { parseRecipeCardPayload, type AiRecipeSuggestion } from '@/lib/ai-recipe';

/** Rich-card slot rendered under an assistant message (see CoachCardSlot). */
export interface CoachCard {
  kind: string;
  payload: unknown;
}

export interface CoachMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'streaming' | 'done' | 'error';
  /**
   * True when the patient stopped this reply mid-stream: the kept text is an
   * incomplete fragment. Carried into later requests so the server can tell
   * the model the reply was interrupted (and used for the bubble's label).
   */
  stopped?: boolean;
  card?: CoachCard;
}

interface CoachChatContextValue {
  messages: CoachMessage[];
  isStreaming: boolean;
  send: (text: string) => void;
  /**
   * Aborts the in-flight reply: keeps whatever text already streamed as a
   * finished message flagged `stopped` (drops a still-empty bubble) and
   * unlocks the input. No-op when nothing is streaming.
   */
  stop: () => void;
  /** Looks up an AI recipe suggestion received this session (by card id). */
  getRecipeSuggestion: (id: string) => AiRecipeSuggestion | undefined;
  /** Caches a generated photo on a suggestion so re-opens don't regenerate. */
  setSuggestionPhoto: (id: string, photoUri: string) => void;
}

const CoachChatContext = createContext<CoachChatContextValue | null>(null);

/**
 * Client keeps its request in step with the server-side history cap. Patient
 * program context (name, day, phase) is derived server-side from the same
 * demo seed — the request carries only the messages.
 */
const MAX_REQUEST_MESSAGES = 12;

export function CoachChatProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const idRef = useRef(0);
  // Session registry of AI recipe suggestions keyed by suggestion id — the
  // preview screen reads full details from here (route params carry only the
  // id). Session-only by design, like the chat itself.
  const suggestionsRef = useRef(new Map<string, AiRecipeSuggestion>());
  // Mirror of `messages` so `send` can snapshot history without re-memoizing;
  // safe because sends are single-flight (inFlightRef) while it lags.
  const messagesRef = useRef<CoachMessage[]>([]);
  // Single-flight guard: refs update synchronously, so rapid double-taps
  // cannot race ahead of the isStreaming re-render.
  const inFlightRef = useRef(false);
  // Controller for the in-flight request; doubles as the stream generation
  // token — callbacks from a stopped stream see a different controller here
  // and drop themselves, so they can never touch a later exchange's state.
  const abortRef = useRef<AbortController | null>(null);
  const nextId = () => `coach-${++idRef.current}`;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const send = useCallback((rawText: string) => {
    const text = rawText.trim();
    if (!text || inFlightRef.current) return;
    inFlightRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    const userMessage: CoachMessage = { id: nextId(), role: 'user', text, status: 'done' };
    const assistantId = nextId();

    // Build the request from a stable snapshot BEFORE touching state, so the
    // network call never runs inside a state updater (updaters must stay pure
    // and may be replayed by React).
    const request: CoachRequestMessage[] = [...messagesRef.current, userMessage]
      .filter(m => m.status === 'done' && m.text.length > 0)
      .slice(-MAX_REQUEST_MESSAGES)
      // Stopped replies stay in the history (the patient saw their text) but
      // carry the flag through, so the server marks them as interrupted
      // instead of letting the model continue a cut-off sentence.
      .map(m =>
        m.role === 'assistant' && m.stopped
          ? { role: m.role, content: m.text, stopped: true }
          : { role: m.role, content: m.text },
      );

    setIsStreaming(true);
    setMessages(prev => [
      ...prev,
      userMessage,
      { id: assistantId, role: 'assistant', text: '', status: 'streaming' },
    ]);

    // Callbacks from a stream the user already stopped must not run: stop()
    // finalized the UI and may even have let a new exchange begin.
    const isStale = () => abortRef.current !== controller;

    void streamCoachChat(
      { messages: request },
      {
        onDelta: delta => {
          if (isStale()) return;
          setMessages(current =>
            current.map(m => (m.id === assistantId ? { ...m, text: m.text + delta } : m)),
          );
        },
        onCard: card => {
          if (isStale()) return;
          if (card.kind === 'recipe') {
            // Defensive re-parse; a malformed payload drops the card rather
            // than crashing the preview screen later.
            const suggestion = parseRecipeCardPayload(card.payload);
            if (!suggestion) return;
            suggestionsRef.current.set(suggestion.id, suggestion);
          }
          // First card wins; the server sends at most one per reply anyway.
          setMessages(current =>
            current.map(m => (m.id === assistantId && !m.card ? { ...m, card } : m)),
          );
        },
        onDone: () => {
          if (isStale()) return;
          abortRef.current = null;
          // Trim trailing whitespace left when a control marker was stripped
          // from the end of the streamed text.
          setMessages(current =>
            current.map(m =>
              m.id === assistantId ? { ...m, status: 'done', text: m.text.trimEnd() } : m,
            ),
          );
          inFlightRef.current = false;
          setIsStreaming(false);
        },
        onError: message => {
          if (isStale()) return;
          abortRef.current = null;
          setMessages(current =>
            current.map(m =>
              m.id === assistantId ? { ...m, status: 'error', text: message } : m,
            ),
          );
          inFlightRef.current = false;
          setIsStreaming(false);
        },
      },
      { signal: controller.signal },
    );
  }, []);

  const stop = useCallback(() => {
    if (!inFlightRef.current) return;
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    // Finalize locally — the aborted stream stays silent (no onDone/onError).
    // Single-flight means at most one message is mid-stream: keep its partial
    // text as a finished reply flagged `stopped` (so the next request marks
    // it interrupted), or drop the bubble if nothing arrived yet.
    setMessages(current =>
      current.flatMap(m => {
        if (m.status !== 'streaming') return [m];
        const text = m.text.trimEnd();
        if (text.length === 0 && !m.card) return [];
        return [{ ...m, status: 'done' as const, text, stopped: true }];
      }),
    );
    inFlightRef.current = false;
    setIsStreaming(false);
  }, []);

  const getRecipeSuggestion = useCallback(
    (id: string) => suggestionsRef.current.get(id),
    [],
  );

  const setSuggestionPhoto = useCallback((id: string, photoUri: string) => {
    const suggestion = suggestionsRef.current.get(id);
    if (suggestion) suggestionsRef.current.set(id, { ...suggestion, photoUri });
  }, []);

  const value = useMemo(
    () => ({ messages, isStreaming, send, stop, getRecipeSuggestion, setSuggestionPhoto }),
    [messages, isStreaming, send, stop, getRecipeSuggestion, setSuggestionPhoto],
  );

  return <CoachChatContext.Provider value={value}>{children}</CoachChatContext.Provider>;
}

export function useCoachChat(): CoachChatContextValue {
  const context = useContext(CoachChatContext);
  if (!context) throw new Error('useCoachChat must be used within CoachChatProvider');
  return context;
}
