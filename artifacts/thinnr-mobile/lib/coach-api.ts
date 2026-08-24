/**
 * Streaming client for the THINNR coach endpoint (POST /api/coach/chat).
 *
 * The endpoint is stateless SSE: the client sends its in-session history plus
 * patient program context and receives `data: {"content": "..."}` chunks,
 * optionally one `data: {"card": {...}}` event (e.g. a product suggestion),
 * optionally one `data: {"quickReplies": [...]}` event (server-curated
 * one-tap answers fitting the reply's closing question), then
 * `data: {"done": true}` (or `data: {"error": "..."}`).
 *
 * Web uses the browser's streaming fetch; native uses expo/fetch, which
 * supports ReadableStream bodies on device. If a body stream is unavailable,
 * the full response text is parsed at once as a graceful fallback.
 *
 * During long silent model calls the server interleaves SSE comment lines
 * (`: keepalive`) so proxies never see an idle connection; only `data:`
 * lines carry events, so the parser skips everything else. A stream that
 * ends WITHOUT a done/error event is a dropped connection, not a finished
 * reply — it surfaces the generic retryable error rather than presenting a
 * truncated answer as complete.
 */
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';

export interface CoachRequestMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Marks an assistant reply the patient stopped mid-stream. The server
   * annotates flagged replies as interrupted before replaying them to the
   * model, so the next answer never continues the cut-off sentence.
   */
  stopped?: boolean;
  /**
   * Menu photo attached to this message as a JPEG data URI. Sent only on the
   * final message of a request — the turn being answered. History replays
   * stay text-only (the server ignores images anywhere else), so a photo is
   * never uploaded twice. The server analyzes it in memory and never stores
   * it.
   */
  image?: string;
}

export interface CoachCardEvent {
  kind: string;
  payload: unknown;
}

export interface CoachStreamCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  /**
   * `retryable` is false only when the server declared the failure final —
   * retrying now cannot help (e.g. the daily demo budget is spent until
   * tomorrow). Callers should hide their retry affordances then. Transient
   * failures (busy, rapid-fire, outages) always pass true.
   */
  onError: (message: string, retryable: boolean) => void;
  /** Rich card attached to this reply (sent by the server before done). */
  onCard?: (card: CoachCardEvent) => void;
  /**
   * Server-curated one-tap answer labels tailored to this reply's closing
   * question (sent before done). Labels come from the server's allow-list,
   * never from free-form model text.
   */
  onQuickReplies?: (labels: string[]) => void;
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

/** Chips are tiny buttons; anything longer than this cannot be a real label. */
const MAX_QUICK_REPLY_LENGTH = 40;
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
      let payload: {
        content?: string;
        card?: unknown;
        quickReplies?: unknown;
        done?: boolean;
        error?: string;
      };
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
      } else if (payload.quickReplies !== undefined) {
        const labels = parseQuickReplies(payload.quickReplies);
        if (labels.length > 0) callbacks.onQuickReplies?.(labels);
      } else if (payload.error) {
        state.finished = true;
        // Mid-stream errors are outages, not budget denials — retrying helps.
        callbacks.onError(payload.error, true);
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
      // Pre-stream failures (rate limits, an oversized photo) answer as JSON
      // with a user-facing message; surface that wording instead of the
      // generic fallback so e.g. a too-large photo explains itself. The body
      // may also carry `retryable: false` when the failure is final (daily
      // budget spent) — only that explicit signal downgrades retryability.
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
      // The connection ended without a done (or error) event: the server
      // never finished this reply — most likely a proxy dropped the stream
      // mid-turn. Finalizing would present a silently truncated (or empty)
      // answer as complete, so surface the standard retryable error instead;
      // the chat replaces any partial text with the error bubble, and RETRY
      // replays the question.
      console.error('Coach chat stream ended without a done event');
      callbacks.onError(FRIENDLY_ERROR, true);
    }
  } catch (error) {
    if (!state.finished) {
      state.finished = true;
      if (signal?.aborted || isAbortError(error)) return;
      console.error('Coach chat request failed', error);
      callbacks.onError(FRIENDLY_ERROR, true);
    }
  }
}

/**
 * Generates a dish image for an AI recipe suggestion (illustrated to match
 * the seeded Library set). Returns a JPEG data URI small enough to persist
 * with a saved recipe. Throws on any failure — callers handle it silently;
 * the preview screen never shows generation states.
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

const MAX_QUICK_REPLIES = 2;

/**
 * Defensive parse of a quick-replies event: keep at most two short,
 * non-empty string labels; anything malformed yields [] and is ignored.
 */
function parseQuickReplies(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((label): label is string => typeof label === 'string')
    .map(label => label.trim())
    .filter(label => label.length > 0 && label.length <= MAX_QUICK_REPLY_LENGTH)
    .slice(0, MAX_QUICK_REPLIES);
}

// ─── Menu scan (POST /api/coach/menu-scan) ───────────────────────────────────

export type MenuScanOutcome = 'ok' | 'not_menu' | 'unreadable';

export interface MenuScanOrderItem {
  /** Dish name as printed on the menu. */
  name: string;
  /** Plain sentence to say when ordering, covering every needed change. */
  howToOrder: string;
  /** Optional caution or tip (portion to eat, what to double-check). */
  note?: string;
}

export interface MenuScanAvoidItem {
  name: string;
  reason: string;
}

/** Structured AI guidance for one scanned menu photo. */
export interface MenuScanResult {
  result: MenuScanOutcome;
  /** Short coach-voice summary ("ok") or explanation (other outcomes). */
  message: string;
  /** Restaurant/menu name when printed on the photo. */
  menuTitle?: string;
  order: MenuScanOrderItem[];
  avoid: MenuScanAvoidItem[];
}

/** Menu scan failure whose message is safe to show the patient. */
export class MenuScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MenuScanError';
  }
}

const SCAN_FALLBACK_ERROR = 'The menu scan is unavailable right now. Please try again.';

function scanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const MAX_SCAN_ITEMS = 10;

function parseOrderItems(value: unknown): MenuScanOrderItem[] {
  if (!Array.isArray(value)) return [];
  const items: MenuScanOrderItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { name?: unknown; howToOrder?: unknown; note?: unknown };
    const name = scanText(record.name, 120);
    const howToOrder = scanText(record.howToOrder, 400);
    if (!name || !howToOrder) continue;
    const note = scanText(record.note, 300);
    items.push({ name, howToOrder, ...(note ? { note } : {}) });
    if (items.length >= MAX_SCAN_ITEMS) break;
  }
  return items;
}

function parseAvoidItems(value: unknown): MenuScanAvoidItem[] {
  if (!Array.isArray(value)) return [];
  const items: MenuScanAvoidItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { name?: unknown; reason?: unknown };
    const name = scanText(record.name, 120);
    const reason = scanText(record.reason, 300);
    if (!name || !reason) continue;
    items.push({ name, reason });
    if (items.length >= MAX_SCAN_ITEMS) break;
  }
  return items;
}

/**
 * Sends one menu photo (JPEG/PNG data URI, already downscaled client-side)
 * for analysis and returns the structured scan result. The server analyzes
 * the photo in memory only — it is never stored.
 *
 * Throws MenuScanError with a user-facing message on any failure, except a
 * caller-initiated abort, which rethrows the AbortError untouched so cancel
 * paths can stay silent.
 */
export async function scanMenuPhoto(
  image: string,
  options: { signal?: AbortSignal } = {},
): Promise<MenuScanResult> {
  const doFetch =
    Platform.OS === 'web'
      ? globalThis.fetch.bind(globalThis)
      : (expoFetch as unknown as typeof globalThis.fetch);

  let response: Response;
  try {
    response = await doFetch(`${apiBase()}/coach/menu-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('Menu scan request failed', error);
    throw new MenuScanError(
      'Could not reach the menu scanner. Check your connection and try again.',
    );
  }

  if (!response.ok) {
    // The API answers failures with { error: <user-facing message> }; the
    // proxy can also answer 413 with a non-JSON body for oversized uploads.
    let message = response.status === 413 ? 'That photo is too large to upload. Please try a different one.' : SCAN_FALLBACK_ERROR;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error.trim()) message = body.error.trim();
    } catch {
      // keep the status-derived message
    }
    throw new MenuScanError(message);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new MenuScanError(SCAN_FALLBACK_ERROR);
  }
  const record = (typeof json === 'object' && json !== null ? json : {}) as {
    result?: unknown;
    message?: unknown;
    menuTitle?: unknown;
    order?: unknown;
    avoid?: unknown;
  };
  const outcome = record.result;
  if (outcome !== 'ok' && outcome !== 'not_menu' && outcome !== 'unreadable') {
    throw new MenuScanError(SCAN_FALLBACK_ERROR);
  }
  const message = scanText(record.message, 600);
  if (!message) throw new MenuScanError(SCAN_FALLBACK_ERROR);
  const menuTitle = scanText(record.menuTitle, 120);
  return {
    result: outcome,
    message,
    ...(menuTitle ? { menuTitle } : {}),
    order: outcome === 'ok' ? parseOrderItems(record.order) : [],
    avoid: outcome === 'ok' ? parseAvoidItems(record.avoid) : [],
  };
}
