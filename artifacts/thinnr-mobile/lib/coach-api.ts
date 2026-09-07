/**
 * Streaming client for the THINNR coach endpoint (POST /api/coach/chat).
 *
 * The endpoint is stateless SSE: the client sends its in-session history plus
 * patient program context and receives `data: {"content": "..."}` chunks,
 * optionally one `data: {"card": {...}}` event (e.g. a product suggestion),
 * optionally one `data: {"quickReplies": [...]}` event (server-curated
 * one-tap answers fitting the reply's closing question), then
 * `data: {"done": true}` (or `data: {"error": "..."}`). A photo turn sent
 * without a kind is triaged server-side; the resolved route arrives early as
 * one `data: {"photoKind": "menu"|"meal"|"label"}` event so the client can
 * stamp the photo turn and a retry names the same route explicitly. A
 * nutrition-label turn additionally carries one `data: {"labelDraft": {...}}`
 * event — the validated transcription the chat context holds through the
 * follow-up name conversation (see lib/label-food.ts). Photo turns also
 * narrate staged progress before any reply text: `data: {"stage":
 * "received"}` the moment the stream opens, then one reading stage once the
 * pipeline is known — so the waiting bubble can say what is happening
 * instead of sitting silent. Stages are cosmetic; unknown values from newer
 * servers are dropped here.
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
import type { MealSlot } from '@/data/patient-data';
import { parseLabelDraft, type LabelDraft } from '@/lib/label-food';

export interface CoachRequestMessage {
  role: 'user' | 'assistant' | 'staff';
  content: string;
  /**
   * Marks an assistant reply the patient stopped mid-stream. The server
   * annotates flagged replies as interrupted before replaying them to the
   * model, so the next answer never continues the cut-off sentence.
   */
  stopped?: boolean;
  /**
   * Photo attached to this message as a JPEG data URI. Sent only on the
   * final message of a request — the turn being answered. History replays
   * stay text-only (the server ignores images anywhere else), so a photo is
   * never uploaded twice. The server analyzes it in memory and never stores
   * it.
   */
  image?: string;
  /**
   * What the attached photo shows: "menu" (default when absent) runs the
   * restaurant menu scan, "meal" the plate-logging analysis that answers
   * with an editable meal card, "label" the Nutrition Facts reader that
   * answers with a transcription plus a labelDraft event. Sent only
   * alongside `image` on the final message; meaningless without one.
   */
  photoKind?: 'menu' | 'meal' | 'label';
}

export interface CoachChatRequestBody {
  messages: CoachRequestMessage[];
  /**
   * The patient's device-local wall clock at send time, 24-hour "HH:MM".
   * Sent on every app call: when a turn produces a recipe or meal card and
   * the patient named no meal, the server preselects the card's diary slot
   * from this reading (a 2 pm photo files under lunch). Optional so older
   * payloads stay valid — the server then keeps its legacy defaults.
   */
  localTime?: string;
  /**
   * Explicit diary slot for any card this turn produces, sent by entry
   * points that already know which meal they are logging (groundwork for
   * the diary's per-meal camera). Wins over both a meal the patient names
   * and the clock, and lands on the card payload untouched.
   */
  mealSlot?: MealSlot;
  /**
   * The app's own calendar date, "YYYY-MM-DD". Sent only on authenticated
   * turns so the server grounds the coach's live today context on the same
   * diary day the app is showing. Demo requests omit it — their bodies stay
   * byte-identical to before accounts existed.
   */
  localDate?: string;
}

export interface CoachCardEvent {
  kind: string;
  payload: unknown;
}

/** Server-narrated photo-turn progress stages, in arrival order. */
export type CoachStage = 'received' | 'reading_meal' | 'reading_menu' | 'reading_label';

/**
 * Extra machine-readable context on a pre-stream failure. `coachPaused`
 * means the care team switched the coach off for every patient (an HQ
 * policy, not a fault) — the screen shows the paused state and closes the
 * composer instead of offering a retry.
 */
export interface CoachErrorDetails {
  coachPaused?: boolean;
}

/** Server-declared coach availability for the signed-in patient. */
export interface CoachAvailability {
  available: boolean;
  /** Patient-facing explanation when unavailable; null when available. */
  message: string | null;
}

/**
 * Asks the server whether the care team currently has the coach switched on
 * for this account. Resolves `null` when the answer cannot be obtained (no
 * token, offline, non-2xx): callers keep their current state — the chat
 * request itself is the authority and reports a pause on send.
 */
export async function fetchCoachAvailability(
  getAuthToken: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<CoachAvailability | null> {
  let token: string | null = null;
  try {
    token = await getAuthToken();
  } catch {
    token = null;
  }
  if (!token) return null;
  try {
    const response = await fetch(`${apiBase()}/coach/availability`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { available?: unknown; message?: unknown };
    if (typeof body.available !== 'boolean') return null;
    return {
      available: body.available,
      message: typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null,
    };
  } catch {
    return null;
  }
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
  onError: (message: string, retryable: boolean, details?: CoachErrorDetails) => void;
  /** Rich card attached to this reply (sent by the server before done). */
  onCard?: (card: CoachCardEvent) => void;
  /**
   * Server-curated one-tap answer labels tailored to this reply's closing
   * question (sent before done). Labels come from the server's allow-list,
   * never from free-form model text.
   */
  onQuickReplies?: (labels: string[]) => void;
  /**
   * Server-resolved pipeline for a photo sent without a kind. Arrives before
   * the reply text; lets the client pin the route for retries.
   */
  onPhotoKind?: (kind: 'menu' | 'meal' | 'label') => void;
  /**
   * Validated Nutrition Facts read for a label photo turn (sent before
   * done). Passed through unparsed — the chat context validates the shape
   * (lib/label-food.ts) and holds it for the name conversation, so a
   * malformed draft drops the flow there instead of half-opening it.
   */
  onLabelDraft?: (draft: unknown) => void;
  /**
   * Staged progress narration for a photo turn, arriving before any reply
   * text. Purely cosmetic — it relabels the waiting bubble; dropping every
   * stage event changes nothing but the wording of the wait.
   */
  onStage?: (stage: CoachStage) => void;
}

export interface CoachStreamOptions {
  /**
   * Aborts the request. Once the signal fires, no further callbacks are
   * invoked — the caller owns the UI transition for a user-initiated stop.
   */
  signal?: AbortSignal;
  /**
   * Supplies the signed-in patient's bearer token for this turn. When set,
   * the request authenticates and the server grounds the coach on the REAL
   * account (name, program day, live diary totals). A missing or failed
   * token surfaces the signed-out error instead of sending — a real
   * patient must never be silently answered with demo grounding. Demo
   * requests never set this, keeping their wire bytes identical.
   */
  getAuthToken?: () => Promise<string | null>;
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
/** Shared by every mobile API client (see lib/support-api.ts). */
export function apiBase(): string {
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
      let payload: {
        content?: string;
        card?: unknown;
        quickReplies?: unknown;
        photoKind?: unknown;
        labelDraft?: unknown;
        stage?: unknown;
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
      } else if (
        payload.photoKind === 'menu' ||
        payload.photoKind === 'meal' ||
        payload.photoKind === 'label'
      ) {
        callbacks.onPhotoKind?.(payload.photoKind);
      } else if (
        // Allow-list the known stages so a future server vocabulary can grow
        // without old clients showing raw identifiers.
        payload.stage === 'received' ||
        payload.stage === 'reading_meal' ||
        payload.stage === 'reading_menu' ||
        payload.stage === 'reading_label'
      ) {
        callbacks.onStage?.(payload.stage);
      } else if (payload.labelDraft !== undefined) {
        callbacks.onLabelDraft?.(payload.labelDraft);
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
  body: CoachChatRequestBody,
  callbacks: CoachStreamCallbacks,
  options: CoachStreamOptions = {},
): Promise<void> {
  const { signal } = options;
  const state = { finished: false };
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.getAuthToken) {
      let token: string | null = null;
      try {
        token = await options.getAuthToken();
      } catch {
        token = null;
      }
      if (!token) {
        state.finished = true;
        if (!signal?.aborted) {
          callbacks.onError('You’re signed out. Sign in again to chat with your coach.', true);
        }
        return;
      }
      headers.Authorization = `Bearer ${token}`;
    }
    const doFetch =
      Platform.OS === 'web'
        ? globalThis.fetch.bind(globalThis)
        : (expoFetch as unknown as typeof globalThis.fetch);
    const response = await doFetch(`${apiBase()}/coach/chat`, {
      method: 'POST',
      headers,
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
      const details: CoachErrorDetails = {};
      try {
        const body = (await response.json()) as { error?: unknown; retryable?: unknown; coachPaused?: unknown };
        if (typeof body.error === 'string' && body.error.trim()) message = body.error.trim();
        if (body.retryable === false) retryable = false;
        if (body.coachPaused === true) details.coachPaused = true;
      } catch {
        // keep the generic message
      }
      state.finished = true;
      if (!signal?.aborted) callbacks.onError(message, retryable, details);
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
 * Options shared by the photo scan calls. `getAuthToken` mirrors the coach
 * stream: a signed-in patient authenticates so the server can enforce the
 * account's consent and photo-analysis choice; the demo persona never sets
 * it and stays tokenless. A supplier that yields no token throws the given
 * error class with the signed-out message — a real patient is never
 * silently served as the demo.
 */
export interface PhotoScanOptions {
  signal?: AbortSignal;
  getAuthToken?: () => Promise<string | null>;
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
  options: PhotoScanOptions = {},
): Promise<MenuScanResult> {
  const doFetch =
    Platform.OS === 'web'
      ? globalThis.fetch.bind(globalThis)
      : (expoFetch as unknown as typeof globalThis.fetch);
  const headers = await scanHeaders(options, message => new MenuScanError(message));

  let response: Response;
  try {
    response = await doFetch(`${apiBase()}/coach/menu-scan`, {
      method: 'POST',
      headers,
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

// ─── Label scan (POST /api/coach/label-scan) ─────────────────────────────────

export type LabelScanOutcome = 'ok' | 'not_label' | 'unreadable';

/** Structured result of one Nutrition Facts photo scan. */
export interface LabelScanResult {
  result: LabelScanOutcome;
  /**
   * Coach-voice reaction ("ok") or warm retake nudge (other outcomes; may
   * contain blank-line paragraph breaks — render with line breaks intact).
   */
  message: string;
  /** Validated per-serving read — present only when result is "ok". */
  label: LabelDraft | null;
}

/** Label scan failure whose message is safe to show the patient. */
export class LabelScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelScanError';
  }
}

const LABEL_SCAN_FALLBACK_ERROR = 'The label scan is unavailable right now. Please try again.';

/**
 * Sends one Nutrition Facts photo (JPEG/PNG data URI, already downscaled
 * client-side) to the label reader and returns the transcribed per-serving
 * values. Same server pipeline as the chat's label photo turns: printed
 * values only, nothing estimated — an unreadable panel comes back as a
 * structured outcome with a warm retake message, never guessed numbers.
 * The server analyzes the photo in memory only; it is never stored.
 *
 * Throws LabelScanError with a user-facing message on any failure, except a
 * caller-initiated abort, which rethrows the AbortError untouched so cancel
 * paths can stay silent.
 */
export async function scanLabelPhoto(
  image: string,
  options: PhotoScanOptions = {},
): Promise<LabelScanResult> {
  const doFetch =
    Platform.OS === 'web'
      ? globalThis.fetch.bind(globalThis)
      : (expoFetch as unknown as typeof globalThis.fetch);
  const headers = await scanHeaders(options, message => new LabelScanError(message));

  let response: Response;
  try {
    response = await doFetch(`${apiBase()}/coach/label-scan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ image }),
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('Label scan request failed', error);
    throw new LabelScanError(
      'Could not reach the label scanner. Check your connection and try again.',
    );
  }

  if (!response.ok) {
    // The API answers failures with { error: <user-facing message> }; the
    // proxy can also answer 413 with a non-JSON body for oversized uploads.
    let message =
      response.status === 413
        ? 'That photo is too large to upload. Please try a different one.'
        : LABEL_SCAN_FALLBACK_ERROR;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error.trim()) message = body.error.trim();
    } catch {
      // keep the status-derived message
    }
    throw new LabelScanError(message);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new LabelScanError(LABEL_SCAN_FALLBACK_ERROR);
  }
  const record = (typeof json === 'object' && json !== null ? json : {}) as {
    result?: unknown;
    message?: unknown;
    label?: unknown;
  };
  const outcome = record.result;
  if (outcome !== 'ok' && outcome !== 'not_label' && outcome !== 'unreadable') {
    throw new LabelScanError(LABEL_SCAN_FALLBACK_ERROR);
  }
  // 800, not 600: the non-ok message carries the model's nudge PLUS the
  // canned retake ask, which together can pass 600 characters.
  const message = scanText(record.message, 800);
  if (!message) throw new LabelScanError(LABEL_SCAN_FALLBACK_ERROR);
  if (outcome !== 'ok') return { result: outcome, message, label: null };
  const label = parseLabelDraft(record.label);
  // "ok" without a usable read is a malformed response, not a prefill.
  if (!label) throw new LabelScanError(LABEL_SCAN_FALLBACK_ERROR);
  return { result: 'ok', message, label };
}

async function scanHeaders(
  options: PhotoScanOptions,
  fail: (message: string) => Error,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!options.getAuthToken) return headers;
  let token: string | null;
  try {
    token = await options.getAuthToken();
  } catch {
    token = null;
  }
  if (!token) throw fail(SCAN_SIGNED_OUT_MESSAGE);
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

const SCAN_SIGNED_OUT_MESSAGE = 'You’re signed out. Sign in again to scan photos.';
