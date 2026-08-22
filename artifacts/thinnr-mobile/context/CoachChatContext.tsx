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
  card?: CoachCard;
}

interface CoachChatContextValue {
  messages: CoachMessage[];
  isStreaming: boolean;
  send: (text: string) => void;
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
  const nextId = () => `coach-${++idRef.current}`;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const send = useCallback((rawText: string) => {
    const text = rawText.trim();
    if (!text || inFlightRef.current) return;
    inFlightRef.current = true;

    const userMessage: CoachMessage = { id: nextId(), role: 'user', text, status: 'done' };
    const assistantId = nextId();

    // Build the request from a stable snapshot BEFORE touching state, so the
    // network call never runs inside a state updater (updaters must stay pure
    // and may be replayed by React).
    const request: CoachRequestMessage[] = [...messagesRef.current, userMessage]
      .filter(m => m.status === 'done' && m.text.length > 0)
      .slice(-MAX_REQUEST_MESSAGES)
      .map(m => ({ role: m.role, content: m.text }));

    setIsStreaming(true);
    setMessages(prev => [
      ...prev,
      userMessage,
      { id: assistantId, role: 'assistant', text: '', status: 'streaming' },
    ]);

    void streamCoachChat(
      { messages: request },
      {
        onDelta: delta => {
          setMessages(current =>
            current.map(m => (m.id === assistantId ? { ...m, text: m.text + delta } : m)),
          );
        },
        onCard: card => {
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
          setMessages(current =>
            current.map(m =>
              m.id === assistantId ? { ...m, status: 'error', text: message } : m,
            ),
          );
          inFlightRef.current = false;
          setIsStreaming(false);
        },
      },
    );
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
    () => ({ messages, isStreaming, send, getRecipeSuggestion, setSuggestionPhoto }),
    [messages, isStreaming, send, getRecipeSuggestion, setSuggestionPhoto],
  );

  return <CoachChatContext.Provider value={value}>{children}</CoachChatContext.Provider>;
}

export function useCoachChat(): CoachChatContextValue {
  const context = useContext(CoachChatContext);
  if (!context) throw new Error('useCoachChat must be used within CoachChatProvider');
  return context;
}
