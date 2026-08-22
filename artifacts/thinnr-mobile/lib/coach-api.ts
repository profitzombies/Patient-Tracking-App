/**
 * Streaming client for the THINNR coach endpoint (POST /api/coach/chat).
 *
 * The endpoint is stateless SSE: the client sends its in-session history plus
 * patient program context and receives `data: {"content": "..."}` chunks,
 * optionally one `data: {"card": {...}}` event (e.g. a product suggestion),
 * then `data: {"done": true}` (or `data: {"error": "..."}`).
 *
 * Web uses the browser's streaming fetch; native uses expo/fetch, which
 * supports ReadableStream bodies on device. If a body stream is unavailable,
 * the full response text is parsed at once as a graceful fallback.
 */
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';

export interface CoachRequestMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CoachCardEvent {
  kind: string;
  payload: unknown;
}

export interface CoachStreamCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  /** Rich card attached to this reply (sent by the server before done). */
  onCard?: (card: CoachCardEvent) => void;
}

export interface CoachStreamOptions {
  /**
   * Aborts the request. Once the signal fires, no further callbacks are
   * invoked — the caller owns the UI transition for a user-initiated stop.
   */
  signal?: AbortSignal;
}

const FRIENDLY_ERROR = 'The coach is unavailable right now. Please try again.';

function isCardEvent(card: unknown): card is CoachCardEvent {
  return (
    typeof card === 'object' &&
    card !== null &&
    typeof (card as { kind?: unknown }).kind === 'string'
  );
}

function apiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) {
    throw new Error('EXPO_PUBLIC_DOMAIN is not set; cannot reach the API server');
  }
  return `https://${domain}/api`;
}

/** Parses complete SSE events out of `buffer`; returns the unparsed tail. */
function drainSseBuffer(
  buffer: string,
  callbacks: CoachStreamCallbacks,
  state: { finished: boolean },
): string {
  const events = buffer.split('\n\n');
  const tail = events.pop() ?? '';
  for (const event of events) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let payload: { content?: string; card?: unknown; done?: boolean; error?: string };
      try {
        payload = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (state.finished) continue;
      if (typeof payload.content === 'string' && payload.content.length > 0) {
        callbacks.onDelta(payload.content);
      } else if (isCardEvent(payload.card)) {
        callbacks.onCard?.(payload.card);
      } else if (payload.error) {
        state.finished = true;
        callbacks.onError(payload.error);
      } else if (payload.done) {
        state.finished = true;
        callbacks.onDone();
      }
    }
  }
  return tail;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function streamCoachChat(
  body: { messages: CoachRequestMessage[] },
  callbacks: CoachStreamCallbacks,
  options: CoachStreamOptions = {},
): Promise<void> {
  const { signal } = options;
  const state = { finished: false };
  try {
    const doFetch =
      Platform.OS === 'web'
        ? globalThis.fetch.bind(globalThis)
        : (expoFetch as unknown as typeof globalThis.fetch);
    const response = await doFetch(`${apiBase()}/coach/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Coach request failed with status ${response.status}`);
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
      if (!signal?.aborted) callbacks.onDone();
    }
  } catch (error) {
    if (!state.finished) {
      state.finished = true;
      if (signal?.aborted || isAbortError(error)) return;
      console.error('Coach chat request failed', error);
      callbacks.onError(FRIENDLY_ERROR);
    }
  }
}

/**
 * Generates a dish photo for an AI recipe suggestion. Returns a JPEG data
 * URI small enough to persist with a saved recipe. Throws on any failure —
 * the preview screen owns the loading/failed presentation.
 */
export async function fetchRecipeImage(name: string, description: string): Promise<string> {
  const doFetch =
    Platform.OS === 'web'
      ? globalThis.fetch.bind(globalThis)
      : (expoFetch as unknown as typeof globalThis.fetch);
  const response = await doFetch(`${apiBase()}/coach/recipe-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
  if (!response.ok) {
    throw new Error(`Recipe image request failed with status ${response.status}`);
  }
  const json = (await response.json()) as { image?: string };
  if (typeof json.image !== 'string' || !json.image.startsWith('data:image/')) {
    throw new Error('Recipe image response missing image data');
  }
  return json.image;
}
