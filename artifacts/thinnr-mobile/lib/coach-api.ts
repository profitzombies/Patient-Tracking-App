/**
 * Streaming client for the THINNR coach endpoint (POST /api/coach/chat).
 *
 * The endpoint is stateless SSE: the client sends its in-session history plus
 * patient program context and receives `data: {"content": "..."}` chunks
 * followed by `data: {"done": true}` (or `data: {"error": "..."}`).
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

export interface CoachStreamCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

const FRIENDLY_ERROR = 'The coach is unavailable right now. Please try again.';

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
        callbacks.onError(payload.error);
      } else if (payload.done) {
        state.finished = true;
        callbacks.onDone();
      }
    }
  }
  return tail;
}

export async function streamCoachChat(
  body: { messages: CoachRequestMessage[] },
  callbacks: CoachStreamCallbacks,
): Promise<void> {
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
      callbacks.onDone();
    }
  } catch (error) {
    if (!state.finished) {
      state.finished = true;
      console.error('Coach chat request failed', error);
      callbacks.onError(FRIENDLY_ERROR);
    }
  }
}
