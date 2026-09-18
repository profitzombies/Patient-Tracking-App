/**
 * SSE client for the staff inbox streams
 * (GET /api/office/conversations/stream, GET /api/hq/conversations/stream).
 *
 * One long-lived connection per open inbox tab replaces the old 5-second
 * list + events polling. Frames arrive as `data: ` lines separated by blank
 * lines (`: keepalive` comments in between) and are one of:
 *   {type:"ready", conversationId, cursor}       subscribed
 *   {type:"list", conversations:[...]}            threads in scope changed
 *   {type:"events", conversationId, events, nextAfter}
 *                                                 new messages of the open thread
 *   {type:"end", reason}                          explicit close
 *
 * Reliability contract (mirrors the coach and support streams):
 * - An explicit `end` is a clean close: reconnect right away, no backoff.
 * - A connection that closes without `end`, a non-OK response, or a network
 *   error is a drop: reconnect with exponential backoff and jitter, and tell
 *   the owner so it can catch up with one fetch. Every `ready` also reports
 *   whether it follows a drop.
 * - A hidden tab parks the stream after a grace period and reconnects the
 *   moment the tab is visible again (which is a catch-up too).
 * - Once closed, no callback ever fires again; every async step re-checks
 *   the connection generation before touching the owner.
 *
 * Framework-free so the regression scripts can drive it under Node with a
 * stubbed fetch and document.
 */

export interface InboxStreamEventPayload {
  seq: number;
  clientId: string | null;
  role: string;
  text: string;
  stopped: boolean;
  senderUserId: string | null;
  senderLabel: string | null;
  createdAt: string;
  card?: unknown;
}

export interface InboxListHint { id: string; thread: string; updatedAt: string }

export type InboxStreamFrame =
  | { type: 'ready'; conversationId: string | null; cursor: number }
  | { type: 'list'; conversations: InboxListHint[] }
  | { type: 'events'; conversationId: string; events: InboxStreamEventPayload[]; nextAfter: number }
  | { type: 'end'; reason: string };

export interface InboxStreamHandlers {
  /** Subscribed. `afterDrop` is true when this connection follows a drop or
   * a parked (hidden-tab) stretch, i.e. when the owner should catch up. */
  onReady: (frame: Extract<InboxStreamFrame, { type: 'ready' }>, info: { afterDrop: boolean }) => void;
  onList: (hints: InboxListHint[]) => void;
  onEvents: (frame: Extract<InboxStreamFrame, { type: 'events' }>) => void;
  /** The stream dropped (network, non-OK response, or end-without-end);
   * a reconnect is scheduled in `retryInMs`. */
  onDrop?: (info: { reason: string; status?: number; retryInMs: number }) => void;
}

export interface InboxStreamOptions {
  /** Built at every (re)connect so the `after` cursor is always current. */
  url: () => string;
  getToken: () => Promise<string | null>;
  handlers: InboxStreamHandlers;
  fetchImpl?: typeof fetch;
  /** Backoff after a drop: first delay, ceiling, and jitter fraction. */
  backoff?: { initialMs?: number; maxMs?: number; jitter?: number };
  /** How long a hidden tab keeps its stream before parking it (default 30 s). */
  hiddenGraceMs?: number;
  /** Test seam for the visibility document; defaults to the global one. */
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
  random?: () => number;
}

export interface InboxStreamHandle {
  close: () => void;
  /** Connection state, for tests and status chips. */
  readonly state: 'connecting' | 'open' | 'waiting' | 'parked' | 'closed';
}

const DEFAULT_BACKOFF = { initialMs: 1_000, maxMs: 30_000, jitter: 0.25 };
const DEFAULT_HIDDEN_GRACE_MS = 30_000;

/** Parses complete frames out of `buffer` and returns the unparsed tail. */
export function drainInboxSse(buffer: string, onFrame: (frame: InboxStreamFrame) => void): string {
  const blocks = buffer.split('\n\n');
  const tail = blocks.pop() ?? '';
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      let frame: InboxStreamFrame;
      try {
        frame = JSON.parse(line.slice(5).trim()) as InboxStreamFrame;
      } catch {
        continue;
      }
      if (frame && typeof frame === 'object' && typeof frame.type === 'string') onFrame(frame);
    }
  }
  return tail;
}

export function openInboxStream(options: InboxStreamOptions): InboxStreamHandle {
  const fetchImpl = options.fetchImpl ?? fetch;
  const backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  const hiddenGraceMs = options.hiddenGraceMs ?? DEFAULT_HIDDEN_GRACE_MS;
  const doc = options.doc === undefined ? (typeof document === 'undefined' ? null : document) : options.doc;
  const random = options.random ?? Math.random;
  const { handlers } = options;

  let state: InboxStreamHandle['state'] = 'connecting';
  let generation = 0;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let parkTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let afterDrop = false;

  const clearTimers = () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (parkTimer) { clearTimeout(parkTimer); parkTimer = null; }
  };

  const retryDelay = () => {
    const base = Math.min(backoff.maxMs, backoff.initialMs * 2 ** attempt);
    const spread = base * backoff.jitter;
    return Math.round(base - spread + random() * spread * 2);
  };

  const scheduleReconnect = (reason: string, status?: number) => {
    if (state === 'closed' || state === 'parked') return;
    afterDrop = true;
    const delay = retryDelay();
    attempt += 1;
    state = 'waiting';
    handlers.onDrop?.({ reason, status, retryInMs: delay });
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, delay);
  };

  const hidden = () => doc?.visibilityState === 'hidden';

  async function connect(): Promise<void> {
    if (state === 'closed') return;
    if (hidden()) { park(); return; }
    const mine = ++generation;
    const live = () => mine === generation && state !== 'closed';
    state = 'connecting';
    controller = new AbortController();
    const { signal } = controller;
    let sawEnd = false;
    try {
      const token = await options.getToken();
      if (!live()) return;
      const response = await fetchImpl(options.url(), {
        headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal,
      });
      if (!live()) return;
      if (!response.ok || !response.body) {
        scheduleReconnect('rejected', response.status);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const handle = (frame: InboxStreamFrame) => {
        if (!live() || sawEnd) return;
        switch (frame.type) {
          case 'ready':
            state = 'open';
            attempt = 0;
            handlers.onReady(frame, { afterDrop });
            afterDrop = false;
            break;
          case 'list':
            handlers.onList(frame.conversations);
            break;
          case 'events':
            handlers.onEvents(frame);
            break;
          case 'end':
            sawEnd = true;
            break;
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (!live()) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = drainInboxSse(buffer, handle);
        if (sawEnd) break;
      }
      if (!sawEnd) drainInboxSse(`${buffer}${decoder.decode()}\n\n`, handle);
      if (!live()) return;
      if (sawEnd) {
        // A clean end (lifetime expired): reconnect right away. The next
        // ready is a catch-up point, since anything written meanwhile would
        // have ridden the connection that just closed.
        afterDrop = true;
        void connect();
      } else {
        scheduleReconnect('closed');
      }
    } catch (error) {
      if (!live()) return;
      scheduleReconnect(error instanceof Error ? error.name : 'error');
    }
  }

  function park(): void {
    if (state === 'closed') return;
    clearTimers();
    generation += 1;
    controller?.abort();
    controller = null;
    state = 'parked';
    afterDrop = true;
  }

  const onVisibility = () => {
    if (state === 'closed') return;
    if (hidden()) {
      if (!parkTimer && state !== 'parked') parkTimer = setTimeout(() => { parkTimer = null; park(); }, hiddenGraceMs);
      return;
    }
    if (parkTimer) { clearTimeout(parkTimer); parkTimer = null; }
    if (state === 'parked') void connect();
  };
  doc?.addEventListener('visibilitychange', onVisibility);

  void connect();

  return {
    get state() { return state; },
    close() {
      if (state === 'closed') return;
      state = 'closed';
      generation += 1;
      clearTimers();
      doc?.removeEventListener('visibilitychange', onVisibility);
      controller?.abort();
      controller = null;
    },
  };
}
