/**
 * SSE client for the office AI Support chat (POST /api/support/chat).
 *
 * Mirrors the mobile coach stream contract: events arrive as `data: ` lines
 * separated by blank lines, and are one of {content}, {error}, {done} or
 * {stage} — the last narrating real server progress (searching the knowledge
 * documents, thinking, formulating a response) for the thinking indicator.
 * A connection that ends without a done or error event is a dropped stream —
 * surfaced as a retryable error, never as a silently truncated answer. Once
 * the caller's abort signal fires, no further callbacks are invoked; the
 * caller owns the UI transition for a user-initiated stop.
 *
 * The route requires a live Supabase session. The client forwards the
 * current access token when present; missing or expired sessions are refused
 * by the API before any knowledge documents or model credits are used.
 */
import { supabase } from './supabase';

/** The real app session's bearer when one exists. */
async function getSupportAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export interface SupportChatMessagePayload {
  role: 'user' | 'assistant';
  content: string;
  /** True when the provider stopped this reply mid-stream. */
  stopped?: boolean;
}

/**
 * The API accepts at most 8000 characters per replayed message.
 * Comprehensive answers can run longer; the model only needs the gist of its
 * own earlier replies for continuity, so history entries are truncated to
 * fit instead of failing validation (or bloating the request body).
 */
const MAX_HISTORY_CONTENT = 7800;
const TRUNCATION_NOTE = '\n\n[Earlier reply truncated for history]';

export function toHistoryContent(text: string): string {
  if (text.length <= MAX_HISTORY_CONTENT) return text;
  return text.slice(0, MAX_HISTORY_CONTENT) + TRUNCATION_NOTE;
}

/** Server progress narration, in the order the work actually happens. */
export type SupportChatStage = 'searching' | 'thinking' | 'formulating';

const SUPPORT_STAGES: readonly SupportChatStage[] = ['searching', 'thinking', 'formulating'];

export interface SupportStreamCallbacks {
  onDelta: (text: string) => void;
  /** retryable=false only when the server says so (daily budget spent). */
  onError: (message: string, retryable: boolean) => void;
  onDone: () => void;
  /** Optional: stage narration events (older servers simply never send any). */
  onStage?: (stage: SupportChatStage) => void;
}

const FRIENDLY_ERROR = 'AI Support is unavailable right now. Please try again.';

/** Parses complete SSE events out of `buffer`; returns the unparsed tail. */
function drainSseBuffer(
  buffer: string,
  callbacks: SupportStreamCallbacks,
  state: { finished: boolean },
): string {
  const events = buffer.split('\n\n');
  const tail = events.pop() ?? '';
  for (const event of events) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let payload: { content?: string; done?: boolean; error?: string; stage?: string };
      try {
        payload = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (state.finished) continue;
      if (typeof payload.content === 'string' && payload.content.length > 0) {
        callbacks.onDelta(payload.content);
      } else if (payload.error) {
        state.finished = true;
        // Mid-stream errors are outages, not budget denials — retrying helps.
        callbacks.onError(payload.error, true);
      } else if (payload.done) {
        state.finished = true;
        callbacks.onDone();
      } else if ((SUPPORT_STAGES as readonly string[]).includes(payload.stage ?? '')) {
        callbacks.onStage?.(payload.stage as SupportChatStage);
      }
    }
  }
  return tail;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function streamSupportChat(
  messages: SupportChatMessagePayload[],
  callbacks: SupportStreamCallbacks,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = options;
  const state = { finished: false };
  try {
    const token = await getSupportAccessToken();
    if (signal?.aborted) return;
    // The operations web is the root artifact, so API paths are root-relative.
    const response = await fetch('/api/support/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages }),
      signal,
    });
    if (!response.ok) {
      // Pre-stream failures (rate limits, library outages) answer as JSON
      // with a user-facing message; surface that wording instead of the
      // generic fallback. Only an explicit `retryable: false` downgrades
      // retryability (the daily budget denial is final).
      let message = FRIENDLY_ERROR;
      let retryable = true;
      try {
        const body = (await response.json()) as { error?: unknown; retryable?: unknown };
        if (typeof body.error === 'string' && body.error.trim()) message = body.error.trim();
        if (body.retryable === false) retryable = false;
      } catch {
        // keep the generic message
      }
      state.finished = true;
      if (!signal?.aborted) callbacks.onError(message, retryable);
      return;
    }

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = drainSseBuffer(buffer, callbacks, state);
      }
      buffer += decoder.decode();
      drainSseBuffer(`${buffer}\n\n`, callbacks, state);
    } else {
      // No streaming support: parse the whole SSE payload in one pass.
      drainSseBuffer(`${await response.text()}\n\n`, callbacks, state);
    }

    if (!state.finished) {
      state.finished = true;
      // A stop that lands between the last read and here still stays silent.
      if (signal?.aborted) return;
      // Ended without done/error: the server never finished this reply (a
      // proxy likely dropped the stream). Finalizing would present a
      // truncated answer as complete, so surface the retryable error instead.
      console.error('AI Support stream ended without a done event');
      callbacks.onError(FRIENDLY_ERROR, true);
    }
  } catch (error) {
    if (!state.finished) {
      state.finished = true;
      if (signal?.aborted || isAbortError(error)) return;
      console.error('AI Support request failed', error);
      callbacks.onError(FRIENDLY_ERROR, true);
    }
  }
}
