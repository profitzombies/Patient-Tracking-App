/**
 * The staff inbox stream client and the polite-polling helper, driven under
 * Node with a stubbed fetch and a fake document:
 * - frames parse across chunk boundaries; keepalive comments are ignored
 * - a non-OK response, a network error, and an end-without-end all
 *   reconnect with exponential backoff and report the drop once
 * - an explicit end reconnects immediately; the next ready is a catch-up
 * - a hidden tab parks the stream after the grace period and reconnects
 *   (as a catch-up) the moment it is visible again
 * - after close, nothing fires again
 * - politeInterval: false while hidden, base while active, ×2 after three
 *   idle minutes, ×4 after fifteen, and callers' own false/undefined pass
 */
import assert from 'node:assert/strict';
import { drainInboxSse, openInboxStream, type InboxStreamFrame } from '../src/lib/inbox-stream';
import {
  DEEP_IDLE_AFTER_MS, IDLE_AFTER_MS, __setLastActivityForTests, politeInterval, politeRefetchInterval,
} from '../src/lib/polite-refetch';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Frame parsing ───────────────────────────────────────────────────────────
{
  const frames: InboxStreamFrame[] = [];
  let tail = drainInboxSse(': keepalive\n\ndata: {"type":"ready","conversationId":null,"cursor":4}\n\ndata: {"type":"li', f => frames.push(f));
  assert.equal(frames.length, 1);
  tail = drainInboxSse(`${tail}st","conversations":[]}\n\nnot-json\n\ndata: nope\n\n`, f => frames.push(f));
  assert.equal(tail, '');
  assert.deepEqual(frames.map(f => f.type), ['ready', 'list']);
}

// ── Stub transport ──────────────────────────────────────────────────────────
type Stub = { url: string; headers: Record<string, string>; push: (frame: unknown) => void; raw: (text: string) => void; end: () => void; aborted: boolean };
const opened: Stub[] = [];
let nextResponse: { status: number } | 'throw' | null = null;
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (nextResponse === 'throw') { nextResponse = null; throw new TypeError('network down'); }
  if (nextResponse) { const status = nextResponse.status; nextResponse = null; return new Response('{"error":"no"}', { status }); }
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stub: Stub = {
    url,
    headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    push: frame => stub.raw(`data: ${JSON.stringify(frame)}\n\n`),
    raw: text => { if (!stub.aborted) controller.enqueue(encoder.encode(text)); },
    end: () => { if (!stub.aborted) { stub.aborted = true; controller.close(); } },
    aborted: false,
  };
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { stub.aborted = true; } });
  init?.signal?.addEventListener('abort', () => { stub.aborted = true; });
  opened.push(stub);
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}) as typeof fetch;

class FakeDocument {
  visibilityState: 'visible' | 'hidden' = 'visible';
  private listeners = new Set<() => void>();
  addEventListener(_type: string, listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: () => void) { this.listeners.delete(listener); }
  set(state: 'visible' | 'hidden') { this.visibilityState = state; this.listeners.forEach(fn => fn()); }
  get listenerCount() { return this.listeners.size; }
}

type Log = string[];
function harness(doc: FakeDocument, after: () => number | undefined) {
  const log: Log = [];
  const handle = openInboxStream({
    url: () => `/api/office/conversations/stream?conversation=c1${after() === undefined ? '' : `&after=${after()}`}`,
    getToken: async () => 'tok',
    fetchImpl,
    doc,
    random: () => 0.5,
    backoff: { initialMs: 40, maxMs: 200, jitter: 0 },
    hiddenGraceMs: 50,
    handlers: {
      onReady: (frame, info) => log.push(`ready:${frame.cursor}:${info.afterDrop ? 'catchup' : 'fresh'}`),
      onList: hints => log.push(`list:${hints.map(h => h.id).join(',')}`),
      onEvents: frame => log.push(`events:${frame.events.map(e => e.seq).join(',')}`),
      onDrop: info => log.push(`drop:${info.reason}${info.status ? `:${info.status}` : ''}:${info.retryInMs}`),
    },
  });
  return { log, handle };
}

// ── Connect, frames, clean end, drop with backoff ───────────────────────────
{
  const doc = new FakeDocument();
  let after: number | undefined;
  const { log, handle } = harness(doc, () => after);
  await sleep(10);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].headers.Authorization, 'Bearer tok', 'the stream must carry the staff bearer');
  assert.match(opened[0].url, /conversation=c1$/);
  assert.equal(handle.state, 'connecting');
  opened[0].raw(': keepalive\n\n');
  opened[0].push({ type: 'ready', conversationId: 'c1', cursor: 2 });
  await sleep(5);
  assert.equal(handle.state, 'open');
  opened[0].push({ type: 'list', conversations: [{ id: 'c1', thread: 'care_team', updatedAt: 'x' }] });
  opened[0].push({ type: 'events', conversationId: 'c1', events: [{ seq: 3 }, { seq: 4 }], nextAfter: 4 });
  await sleep(5);
  assert.deepEqual(log, ['ready:2:fresh', 'list:c1', 'events:3,4']);
  after = 4;

  // Explicit end: reconnect right away, resuming after the newest known seq,
  // and the next ready is flagged as a catch-up point.
  opened[0].push({ type: 'end', reason: 'expired' });
  opened[0].end();
  await sleep(10);
  assert.equal(opened.length, 2, 'an explicit end reconnects immediately');
  assert.match(opened[1].url, /after=4$/);
  assert.ok(!log.some(entry => entry.startsWith('drop')), 'a clean end is not a drop');
  opened[1].push({ type: 'ready', conversationId: 'c1', cursor: 4 });
  await sleep(5);
  assert.equal(log.at(-1), 'ready:4:catchup');

  // Frames after an end frame on the same connection are ignored.
  opened[1].push({ type: 'end', reason: 'expired' });
  opened[1].push({ type: 'events', conversationId: 'c1', events: [{ seq: 99 }], nextAfter: 99 });
  opened[1].end();
  await sleep(10);
  assert.ok(!log.includes('events:99'), 'nothing after an end frame may reach the owner');
  assert.equal(opened.length, 3);
  opened[2].push({ type: 'ready', conversationId: 'c1', cursor: 4 });
  await sleep(5);

  // Silent close (no end frame): a drop → backoff → reconnect; the owner hears
  // about it once, with the delay.
  opened[2].end();
  await sleep(10);
  assert.equal(log.at(-1), 'drop:closed:40');
  assert.equal(handle.state, 'waiting');
  assert.equal(opened.length, 3, 'no reconnect before the backoff elapses');
  await sleep(50);
  assert.equal(opened.length, 4, 'reconnect after the first backoff');
  // Rejected response: the next delay doubles.
  nextResponse = { status: 502 };
  opened[3].end();
  await sleep(10);
  assert.equal(log.at(-1), 'drop:closed:80');
  await sleep(90);
  // That reconnect hit the 502 and scheduled again with a doubled delay.
  assert.equal(log.at(-1), 'drop:rejected:502:160');
  nextResponse = 'throw';
  await sleep(170);
  assert.equal(log.at(-1), 'drop:TypeError:200', 'delays cap at the ceiling');
  await sleep(210);
  assert.equal(opened.length, 5);
  opened[4].push({ type: 'ready', conversationId: 'c1', cursor: 4 });
  await sleep(5);
  assert.equal(log.at(-1), 'ready:4:catchup');
  assert.equal(handle.state, 'open');
  // A ready resets the backoff.
  opened[4].end();
  await sleep(10);
  assert.equal(log.at(-1), 'drop:closed:40');

  handle.close();
  assert.equal(handle.state, 'closed');
  const entries = log.length;
  await sleep(120);
  assert.equal(opened.length, 5, 'closing cancels the pending reconnect');
  assert.equal(log.length, entries, 'nothing fires after close');
  assert.equal(doc.listenerCount, 0, 'close removes the visibility listener');
}

// ── Hidden tab parks the stream; visible reconnects as a catch-up ───────────
{
  const doc = new FakeDocument();
  const { log, handle } = harness(doc, () => 7);
  await sleep(10);
  const first = opened.length;
  opened[first - 1].push({ type: 'ready', conversationId: 'c1', cursor: 7 });
  await sleep(5);
  doc.set('hidden');
  await sleep(20);
  assert.equal(handle.state, 'open', 'a brief hide keeps the stream (grace period)');
  doc.set('visible');
  await sleep(70);
  assert.equal(opened.length, first, 'returning within the grace period must not reconnect');
  doc.set('hidden');
  await sleep(70);
  assert.equal(handle.state, 'parked');
  assert.ok(opened[first - 1].aborted, 'parking closes the connection');
  assert.equal(opened.length, first, 'a parked stream does not reconnect while hidden');
  assert.ok(!log.some(entry => entry.startsWith('drop')), 'parking is deliberate, not a drop');
  doc.set('visible');
  await sleep(10);
  assert.equal(opened.length, first + 1, 'visible again reconnects immediately');
  opened[first].push({ type: 'ready', conversationId: 'c1', cursor: 7 });
  await sleep(5);
  assert.equal(log.at(-1), 'ready:7:catchup', 'the reconnect after parking is a catch-up point');
  // A drop that lands while hidden waits parked instead of retrying.
  doc.set('hidden');
  await sleep(70);
  assert.equal(handle.state, 'parked');
  handle.close();
  await sleep(20);
  assert.equal(opened.length, first + 1);
}

// ── Starting hidden waits for visibility ────────────────────────────────────
{
  const doc = new FakeDocument();
  doc.visibilityState = 'hidden';
  const before = opened.length;
  const { handle } = harness(doc, () => undefined);
  await sleep(20);
  assert.equal(opened.length, before, 'a hidden tab opens no stream');
  assert.equal(handle.state, 'parked');
  doc.set('visible');
  await sleep(10);
  assert.equal(opened.length, before + 1);
  handle.close();
}

// ── Polite polling ──────────────────────────────────────────────────────────
{
  const fakeDocument = { visibilityState: 'visible' as 'visible' | 'hidden', addEventListener() {}, removeEventListener() {} };
  const fakeWindow = { addEventListener() {} };
  (globalThis as { document?: unknown }).document = fakeDocument;
  (globalThis as { window?: unknown }).window = fakeWindow;
  const now = Date.now();
  __setLastActivityForTests(now);
  assert.equal(politeInterval(3_000, now), 3_000, 'active + visible polls at the base cadence');
  assert.equal(politeInterval(false, now), false, 'a caller\'s own stop decision passes through');
  assert.equal(politeInterval(undefined, now), undefined);
  assert.equal(politeInterval(3_000, now + IDLE_AFTER_MS - 1), 3_000);
  assert.equal(politeInterval(3_000, now + IDLE_AFTER_MS), 6_000, 'three idle minutes double the cadence');
  assert.equal(politeInterval(3_000, now + DEEP_IDLE_AFTER_MS), 12_000, 'fifteen idle minutes quadruple it');
  fakeDocument.visibilityState = 'hidden';
  assert.equal(politeInterval(3_000, now), false, 'a hidden tab polls nothing at all');
  assert.equal(politeRefetchInterval(30_000)(), false);
  fakeDocument.visibilityState = 'visible';
  assert.equal(politeRefetchInterval(30_000)(), 30_000);
  __setLastActivityForTests(now - DEEP_IDLE_AFTER_MS);
  assert.equal(politeRefetchInterval(30_000)(), 120_000);
}

console.log('inbox stream verification passed');
