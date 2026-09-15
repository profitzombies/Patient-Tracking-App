/**
 * Streaming client for AI Support (POST /api/support/chat) — the staff-side
 * sibling of lib/coach-api.ts, answering provider questions from the HQ
 * knowledge library.
 *
 * Stateless SSE with the same reliability contract as the coach client:
 * `data: {"content": "..."}` chunks, then `data: {"done": true}` (or
 * `data: {"error": "..."}`). Keepalive comment lines are skipped; unknown
 * payload fields are ignored so server-side additions (e.g. progress stages)
 * never break older clients. A stream that ends WITHOUT a done/error event is
 * a dropped connection, not a finished reply — it surfaces the retryable
 * error instead of presenting a truncated answer as complete.
 *
 * Pre-stream failures (rate limits, an unreachable knowledge library) answer
 * as JSON with a user-facing message and an optional `retryable: false` for
 * final denials (daily budget spent) — mirrored to the callbacks unchanged.
 */
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { apiBase } from '@/lib/coach-api';
import { supabase } from '@/lib/supabase';

export interface SupportRequestMessage {
  role: 'user' | 'assistant' | 'staff';
  content: string;
  /**
   * Marks an assistant reply the provider stopped mid-stream. The server
   * annotates flagged replies as interrupted before replaying them to the
   * model, so the next answer never continues the cut-off text.
   */
  stopped?: boolean;
}

export interface SupportStreamCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  /**
   * `retryable` is false only when the server declared the failure final —
   * retrying now cannot help (e.g. the daily demo budget is spent until
   * tomorrow). Callers should hide their retry affordances then.
   */
  onError: (message: string, retryable: boolean) => void;
}

export interface SupportStreamOptions {
  /**
   * Aborts the request. Once the signal fires, no further callbacks are
   * invoked — the caller owns the UI transition for a user-initiated stop.
   */
  signal?: AbortSignal;
}

/** Matches the server's own outage wording so retries read consistently. */
const FRIENDLY_ERROR = 'AI Support is unavailable right now. Please try again.';

/** The server slices to its own window; this keeps request bodies small. */
export const SUPPORT_HISTORY_WINDOW = 12;
/** Composer cap for provider questions (mirrors the operations web page). */
export const MAX_SUPPORT_QUESTION_LENGTH = 4000;
/**
 * Replayed assistant answers may exceed the request schema's per-message cap
 * (8000 chars) — comprehensive markdown replies get long. Truncated replays
 * are fine: the model only needs the gist for conversational continuity.
 */
const HISTORY_CONTENT_CAP = 8000;

export function toSupportHistoryContent(text: string): string {
  return text.length <= HISTORY_CONTENT_CAP ? text : text.slice(0, HISTORY_CONTENT_CAP);
}

/** Parses complete SSE events out of `buffer`; returns the unparsed tail. */
function drainSseBuffer(
  buffer: string,
  callbacks: SupportStreamCallbacks,
  state: { finished: boolean },
  signal?: AbortSignal,
): string {
  // An abort can land between a read resolving and its buffer draining;
  // finishing here guarantees no callback ever fires after a stop.
  if (signal?.aborted) state.finished = true;
  const events = buffer.split('\n\n');
  const tail = events.pop() ?? '';
  for (const event of events) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let payload: { content?: string; done?: boolean; error?: string };
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
      }
      // Anything else (future event kinds) is deliberately ignored.
    }
  }
  return tail;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function streamSupportChat(
  messages: SupportRequestMessage[],
  callbacks: SupportStreamCallbacks,
  options: SupportStreamOptions = {},
): Promise<void> {
  const { signal } = options;
  const state = { finished: false };
  try {
    const token = (await supabase?.auth.getSession())?.data.session?.access_token ?? null;
    if (signal?.aborted) return;
    const doFetch =
      Platform.OS === 'web'
        ? globalThis.fetch.bind(globalThis)
        : (expoFetch as unknown as typeof globalThis.fetch);
    const response = await doFetch(`${apiBase()}/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages }),
      signal,
    });
    if (!response.ok) {
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
        if (done || signal?.aborted) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = drainSseBuffer(buffer, callbacks, state, signal);
      }
      buffer += decoder.decode();
      drainSseBuffer(`${buffer}\n\n`, callbacks, state, signal);
    } else {
      // No streaming support: parse the whole SSE payload in one pass.
      drainSseBuffer(`${await response.text()}\n\n`, callbacks, state, signal);
    }

    if (!state.finished) {
      state.finished = true;
      if (signal?.aborted) return;
      console.error('Support chat stream ended without a done event');
      callbacks.onError(FRIENDLY_ERROR, true);
    }
  } catch (error) {
    if (!state.finished) {
      state.finished = true;
      if (signal?.aborted || isAbortError(error)) return;
      console.error('Support chat request failed', error);
      callbacks.onError(FRIENDLY_ERROR, true);
    }
  }
}
