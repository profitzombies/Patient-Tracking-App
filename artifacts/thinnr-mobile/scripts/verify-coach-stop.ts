/**
 * Coach chat stop-control and paced-reveal regression check.
 *
 * Drives the real streaming pipeline — CoachChatProvider rendered with
 * react-test-renderer calling the real lib/coach-api.ts client — against a
 * scripted fetch that plays SSE events on cue (tsconfig.coach-stop.json maps
 * react-native and expo/fetch to Node stubs so the client runs under tsx).
 *
 * Pins the guarantees behind the Stop control and the typed-out reveal so a
 * refactor of CoachChatContext (e.g. persistence work) cannot silently
 * reintroduce a locked chat, a stray error bubble, or a card that outruns
 * its text:
 *   1. an aborted stream invokes no callbacks (CoachStreamOptions.signal
 *      contract — section 1 tests streamCoachChat directly),
 *   2. stop() finalizes the UI and unlocks the input synchronously — stop
 *      while the reply is still empty removes the bubble, stop mid-stream
 *      keeps exactly the text revealed on screen, and a follow-up send in
 *      the very same tick starts a new exchange,
 *   3. late events from a stopped stream never touch the chat again — no
 *      error bubble, no text appended to a finished reply, no cross-talk
 *      into a newer exchange (section 2 uses a "leaky" transport that keeps
 *      emitting after abort, modeling chunks already in flight at stop time),
 *   4. deltas land in a hidden buffer and type out on a real timer (section
 *      3): a single burst chunk still reveals progressively, the reply only
 *      finalizes — and the held card / quick replies only attach — after the
 *      reveal drains, stop mid-reveal keeps exactly what was on screen (an
 *      already-arrived card survives), and an error clears the buffer.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:coach-stop
 */
import React, { act } from 'react';

import { streamCoachChat } from '../lib/coach-api';
import {
  CoachChatProvider,
  REVEAL_TICK_MS,
  useCoachChat,
  type CoachMessage,
} from '../context/CoachChatContext';

let checks = 0;
let failures = 0;

function fail(message: string) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) fail(label);
}

function assertEqual(label: string, actual: string | number, expected: string | number) {
  checks += 1;
  if (actual !== expected) {
    fail(`${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

function finish(): never {
  if (failures > 0) {
    console.error(`\n✗ coach stop-control check: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ coach stop-control check: ${checks} checks passed`);
  process.exit(0);
}

// ── Scripted SSE transport ────────────────────────────────────────────────────
// globalThis.fetch is replaced with a fake that returns a ReadableStream the
// test feeds by hand. Two abort behaviors:
//   'faithful' — like real fetch: aborting the signal rejects the pending
//                read with AbortError (the transport goes dead).
//   'leaky'    — ignores the abort and keeps delivering, so events keep
//                reaching the client callbacks after the user hit stop; this
//                is how we prove the UI-side staleness guards hold even when
//                a chunk was already in flight.

type AbortBehavior = 'faithful' | 'leaky';
let abortBehavior: AbortBehavior = 'faithful';

interface ScriptedSse {
  /** Parsed JSON body the client sent (request sanity checks only). */
  requestBody: { messages?: Array<{ role: string; content: string }> };
  emit(payload: Record<string, unknown>): void;
  close(): void;
}

const opened: ScriptedSse[] = [];
const everOpened: ScriptedSse[] = [];
const encoder = new TextEncoder();

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function scriptedFetch(
  _input: unknown,
  init?: { body?: unknown; signal?: AbortSignal | null },
): Promise<Response> {
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(abortError());

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let dead = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const scripted: ScriptedSse = {
    requestBody: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    emit(payload) {
      if (dead) return;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    },
    close() {
      if (dead) return;
      dead = true;
      controller.close();
    },
  };

  if (abortBehavior === 'faithful' && signal) {
    signal.addEventListener('abort', () => {
      if (dead) return;
      dead = true;
      controller.error(abortError());
    });
  }

  opened.push(scripted);
  everOpened.push(scripted);
  return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
}

function takeStream(label: string): ScriptedSse {
  const stream = opened.shift();
  if (!stream) {
    fail(`${label}: expected the client to have opened a coach stream`);
    finish();
  }
  return stream;
}

/** Lets the client's read-loop microtasks drain (two macrotask turns). */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function settle() {
  await tick();
  await tick();
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function recorder() {
  const events: string[] = [];
  return {
    events,
    callbacks: {
      onDelta: (text: string) => {
        events.push(`delta:${text}`);
      },
      onCard: (card: { kind: string }) => {
        events.push(`card:${card.kind}`);
      },
      onDone: () => {
        events.push('done');
      },
      onError: (message: string) => {
        events.push(`error:${message}`);
      },
    },
  };
}

// ── Section 2/3 harness: render the real provider, probe the context value ──
type Chat = ReturnType<typeof useCoachChat>;
let chat!: Chat;

function Probe(): null {
  chat = useCoachChat();
  return null;
}

const shape = (m: CoachMessage) => `${m.role}/${m.status}:${m.text}`;
const shapes = () => chat.messages.map(shape).join('|');
const tailShapes = (n: number) => chat.messages.slice(-n).map(shape).join('|');
const tailMessage = () => chat.messages[chat.messages.length - 1];

async function actSettle(mutate?: () => void): Promise<void> {
  await act(async () => {
    mutate?.();
    await settle();
  });
}

/**
 * Polls (real timers — the reveal runs on a genuine interval) until the
 * predicate holds. Each wait slice runs inside act() so reveal ticks fired
 * during it are flushed before the next predicate read; the predicate itself
 * therefore always observes committed state, and can double as a frame
 * recorder for the pacing assertions. Timing out is fatal: later assertions
 * would only cascade misleadingly.
 */
async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  checks += 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      fail(`${label}: condition not met within ${timeoutMs}ms`);
      finish();
    }
    await act(async () => {
      await sleep(8);
    });
  }
}

async function main() {
  process.env.EXPO_PUBLIC_DOMAIN = 'coach-stop.internal';
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = scriptedFetch as unknown as typeof fetch;

  // react-test-renderer 19 prints a one-line deprecation notice; keep the
  // output readable but let every other console.error through untouched.
  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    realConsoleError(...args);
  };
  const rendererModule = (await import('react-test-renderer')) as unknown as {
    default?: { create: (el: React.ReactElement) => { unmount(): void } };
    create?: (el: React.ReactElement) => { unmount(): void };
  };
  const TestRenderer = rendererModule.default ?? rendererModule;
  if (!TestRenderer.create) throw new Error('react-test-renderer did not expose create()');

  // ── 1. streamCoachChat signal contract: aborted streams stay silent ───────
  {
    // 1a. Baseline: deltas arrive in order, then exactly one done.
    const rec = recorder();
    const run = streamCoachChat(
      { messages: [{ role: 'user', content: 'baseline' }] },
      rec.callbacks,
    );
    const stream = takeStream('baseline');
    assert(
      'the request carries the caller message',
      stream.requestBody.messages?.[0]?.content === 'baseline',
    );
    stream.emit({ content: 'Lean protein' });
    stream.emit({ content: ' every meal.' });
    stream.emit({ done: true });
    stream.close();
    await run;
    assertEqual(
      'baseline stream replays deltas then done',
      rec.events.join('|'),
      'delta:Lean protein|delta: every meal.|done',
    );
  }
  {
    // 1b. Abort mid-stream (faithful transport): the pending read rejects
    // with AbortError and NOTHING is invoked after the abort — no onDone,
    // no onError. This is the silence stop() relies on.
    abortBehavior = 'faithful';
    const controller = new AbortController();
    const rec = recorder();
    const run = streamCoachChat(
      { messages: [{ role: 'user', content: 'abort mid-stream' }] },
      rec.callbacks,
      { signal: controller.signal },
    );
    const stream = takeStream('abort mid-stream');
    stream.emit({ content: 'Half a rep' });
    await settle();
    controller.abort();
    await run;
    assertEqual(
      'aborted stream keeps pre-abort deltas only (no done, no error)',
      rec.events.join('|'),
      'delta:Half a rep',
    );
  }
  {
    // 1c. Abort landing between the last read and finalization: the stream
    // ends cleanly with no done event while the signal is already aborted —
    // the client must NOT synthesize onDone.
    abortBehavior = 'leaky';
    const controller = new AbortController();
    const rec = recorder();
    const run = streamCoachChat(
      { messages: [{ role: 'user', content: 'abort at stream end' }] },
      rec.callbacks,
      { signal: controller.signal },
    );
    const stream = takeStream('abort at stream end');
    stream.emit({ content: 'Water first' });
    await settle();
    controller.abort();
    stream.close();
    await run;
    assertEqual(
      'aborted-at-end stream never synthesizes done',
      rec.events.join('|'),
      'delta:Water first',
    );
  }
  {
    // 1d. Un-aborted close without a done event DOES finalize — proving 1c
    // was guarded by the abort, not by luck.
    const rec = recorder();
    const run = streamCoachChat(
      { messages: [{ role: 'user', content: 'close without done' }] },
      rec.callbacks,
    );
    const stream = takeStream('close without done');
    stream.emit({ content: 'Sleep 8 hours.' });
    stream.close();
    await run;
    assertEqual(
      'unaborted close-without-done synthesizes exactly one done',
      rec.events.join('|'),
      'delta:Sleep 8 hours.|done',
    );
  }
  {
    // 1e. A server error event surfaces exactly once, then the stream is dead
    // to further events.
    const rec = recorder();
    const run = streamCoachChat(
      { messages: [{ role: 'user', content: 'server error' }] },
      rec.callbacks,
    );
    const stream = takeStream('server error');
    stream.emit({ error: 'model unavailable' });
    stream.emit({ content: 'stray' });
    stream.emit({ done: true });
    stream.close();
    await run;
    assertEqual(
      'error event surfaces once and ends the stream',
      rec.events.join('|'),
      'error:model unavailable',
    );
  }

  // ── 2. CoachChatContext stop flows (leaky transport throughout, so every
  //       late event genuinely reaches the client callbacks and only the
  //       context's own staleness guards stand between it and the UI) ───────
  abortBehavior = 'leaky';
  let renderer: { unmount(): void } | undefined;
  await act(() => {
    renderer = TestRenderer.create!(
      React.createElement(CoachChatProvider, null, React.createElement(Probe)),
    );
  });

  // 2a. Stop while the reply is still empty: bubble removed, chat unlocked,
  //     late events ignored.
  await act(() => {
    chat.send('Protein target?');
  });
  assert('send locks the chat while streaming', chat.isStreaming === true);
  assertEqual(
    'send shows the user turn plus an empty streaming bubble',
    shapes(),
    'user/done:Protein target?|assistant/streaming:',
  );
  const s1 = takeStream('stop-while-empty');
  await act(() => {
    chat.stop();
  });
  assert('stop on an empty reply unlocks the chat', chat.isStreaming === false);
  assertEqual('stop on an empty reply removes the bubble', shapes(), 'user/done:Protein target?');
  await actSettle(() => {
    s1.emit({ content: 'late delta' });
    s1.emit({ error: 'late error' });
    s1.emit({ done: true });
  });
  assertEqual(
    'late events from the stopped stream change nothing (no error bubble)',
    shapes(),
    'user/done:Protein target?',
  );
  assert('late events never relock the chat', chat.isStreaming === false);

  // 2b. Stop after the reveal caught up: everything shown is kept as a done
  //     message (trailing whitespace trimmed), the chat unlocks, late events
  //     cannot reopen it.
  await act(() => {
    chat.send('Hydration tips?');
  });
  const s2 = takeStream('stop-mid-stream');
  await actSettle(() => {
    s2.emit({ content: 'Water supports' });
    s2.emit({ content: ' recovery. ' });
  });
  await waitUntil(
    'deltas type out into the streaming bubble',
    () => tailShapes(1) === 'assistant/streaming:Water supports recovery. ',
  );
  assert('chat stays locked while streaming', chat.isStreaming === true);
  const messagesWhileLocked = chat.messages.length;
  await act(() => {
    chat.send('Should be swallowed');
  });
  assertEqual('send while locked is ignored', chat.messages.length, messagesWhileLocked);
  assertEqual('send while locked opens no new stream', opened.length, 0);
  await act(() => {
    chat.stop();
  });
  assertEqual(
    'stop mid-stream keeps the revealed text as a done message (trimmed)',
    tailShapes(1),
    'assistant/done:Water supports recovery.',
  );
  assert('stop mid-stream unlocks the chat', chat.isStreaming === false);
  await actSettle(() => {
    s2.emit({ content: ' MORE' });
    s2.emit({ error: 'late failure' });
  });
  assertEqual(
    'late delta/error cannot grow or reopen the finished reply',
    tailShapes(1),
    'assistant/done:Water supports recovery.',
  );
  assert('late events after a mid-stream stop never relock the chat', chat.isStreaming === false);

  // 2c. Follow-up send in the SAME tick as stop(): the unlock is synchronous,
  //     and the old stream's remaining events cannot touch the new exchange.
  await act(() => {
    chat.send('Approved snacks?');
  });
  const s3 = takeStream('follow-up base');
  await actSettle(() => {
    s3.emit({ content: 'Celery' });
  });
  await waitUntil(
    'the first reply reveals fully before the stop',
    () => tailShapes(1) === 'assistant/streaming:Celery',
  );
  await act(() => {
    chat.stop();
    chat.send('And dinner?'); // same tick — must not be swallowed
  });
  assert('follow-up send right after stop() starts streaming', chat.isStreaming === true);
  assertEqual(
    'stop finalizes the old reply and the follow-up opens a fresh bubble',
    tailShapes(3),
    'assistant/done:Celery|user/done:And dinner?|assistant/streaming:',
  );
  const s4 = takeStream('follow-up stream');
  await actSettle(() => {
    s3.emit({ content: ' sticks' });
    s3.emit({ error: 'late failure' });
    s3.emit({ done: true });
  });
  assertEqual(
    'late events from the old stream never touch the new exchange',
    tailShapes(3),
    'assistant/done:Celery|user/done:And dinner?|assistant/streaming:',
  );
  assert('a late done from the old stream does not unlock the new one', chat.isStreaming === true);
  await actSettle(() => {
    s4.emit({ content: 'Grilled chicken.' });
    s4.emit({ done: true });
  });
  await waitUntil(
    'the follow-up exchange types out and completes normally',
    () => tailShapes(2) === 'user/done:And dinner?|assistant/done:Grilled chicken.',
  );
  assert('completion unlocks the chat', chat.isStreaming === false);

  // 2d. Whole-session sweep so far: exact transcript, no error bubble.
  assertEqual(
    'full transcript matches the expected session',
    shapes(),
    [
      'user/done:Protein target?',
      'user/done:Hydration tips?',
      'assistant/done:Water supports recovery.',
      'user/done:Approved snacks?',
      'assistant/done:Celery',
      'user/done:And dinner?',
      'assistant/done:Grilled chicken.',
    ].join('|'),
  );
  assert(
    'no message in the whole session ever carries an error status',
    chat.messages.every(m => m.status !== 'error'),
  );
  assertEqual('every opened stream was accounted for', opened.length, 0);

  // ── 3. Paced reveal: buffered deltas type out on a timer; the reply (and
  //       its held card / quick replies) finalizes only after the drain ─────

  // Recipe-shaped reply: the whole text arrives as ONE chunk, like the
  // structured recipe/cravings pipeline sends it.
  const LONG_REPLY =
    'Approved plate: lean protein, steamed vegetables, plenty of water. '.repeat(7).trimEnd();

  // 3a. A single burst chunk still reveals progressively — never all at once.
  await act(() => {
    chat.send('Give me a dinner idea');
  });
  const r1 = takeStream('paced reveal');
  await actSettle(() => {
    r1.emit({ content: LONG_REPLY });
    r1.emit({ done: true });
    r1.close();
  });
  const revealedLengths: number[] = [];
  let prefixViolated = false;
  let unlockedMidReveal = false;
  await waitUntil('single-chunk reply finishes typing out', () => {
    const m = tailMessage();
    if (m.role === 'assistant' && m.status === 'streaming') {
      if (!LONG_REPLY.startsWith(m.text)) prefixViolated = true;
      const last = revealedLengths[revealedLengths.length - 1];
      if (m.text.length > 0 && m.text.length !== last) revealedLengths.push(m.text.length);
      if (!chat.isStreaming) unlockedMidReveal = true;
    }
    return m.status !== 'streaming';
  });
  assertEqual('the fully revealed reply matches the chunk exactly', tailMessage().text, LONG_REPLY);
  assertEqual('the revealed reply finalizes as done', tailMessage().status, 'done');
  assert(
    `the reply typed out across multiple frames (saw ${revealedLengths.length} partial frames)`,
    revealedLengths.filter(length => length < LONG_REPLY.length).length >= 3,
  );
  assert(
    'every observed frame was a strict prefix of the full reply (no scrambling)',
    !prefixViolated,
  );
  assert(
    'revealed text only ever grew',
    revealedLengths.every((length, i) => i === 0 || length > revealedLengths[i - 1]),
  );
  assert('the chat stayed locked for the whole reveal', !unlockedMidReveal);
  assert('the drain unlocks the chat', chat.isStreaming === false);

  // 3b. A card and quick replies that arrive DURING the reveal attach only
  //     when the text finishes typing out — never before.
  const CARD_REPLY =
    'This swap fits your phase nicely, and the full details are on the card below. Want me to save it to your Library?';
  await act(() => {
    chat.send('Anything for a sweet craving?');
  });
  const r2 = takeStream('card/chips hold');
  await actSettle(() => {
    r2.emit({ content: CARD_REPLY });
    r2.emit({ card: { kind: 'product', payload: { sku: 'demo-product' } } });
    r2.emit({ quickReplies: ['Yes, please', 'No thanks'] });
    r2.emit({ done: true });
    r2.close();
  });
  let attachedEarly = false;
  let observedMidReveal = false;
  await waitUntil('reply with card and chips finalizes after the reveal', () => {
    const m = tailMessage();
    if (m.status === 'streaming') {
      if (m.card !== undefined || m.quickReplies !== undefined) attachedEarly = true;
      if (m.text.length > 0 && m.text.length < CARD_REPLY.length) observedMidReveal = true;
    }
    return m.status !== 'streaming';
  });
  assert('the hold was genuinely observed mid-reveal', observedMidReveal);
  assert('card/quick replies never attached while text was still revealing', !attachedEarly);
  assertEqual('the card reply reveals its full text', tailMessage().text, CARD_REPLY);
  assert('the card attaches once the reveal finishes', tailMessage().card?.kind === 'product');
  assertEqual(
    'the quick replies attach once the reveal finishes',
    (tailMessage().quickReplies ?? []).join('|'),
    'Yes, please|No thanks',
  );
  assert('the finished card reply unlocks the chat', chat.isStreaming === false);

  // 3c. Stop mid-reveal: the patient keeps EXACTLY what was on screen; the
  //     unrevealed remainder is discarded, and a card that already arrived
  //     survives the stop.
  await act(() => {
    chat.send('Long answer I will stop');
  });
  const r3 = takeStream('stop mid-reveal');
  await actSettle(() => {
    r3.emit({ content: LONG_REPLY });
    r3.emit({ card: { kind: 'product', payload: { sku: 'kept-product' } } });
    r3.emit({ done: true }); // network is done; the patient still sees typing
    r3.close();
  });
  await waitUntil('some but not all of the text has revealed', () => {
    const m = tailMessage();
    return m.status === 'streaming' && m.text.length >= 20;
  });
  let seenAtStop = '';
  await act(() => {
    seenAtStop = tailMessage().text; // same tick as stop(): nothing interleaves
    chat.stop();
  });
  assertEqual(
    'stop keeps exactly the revealed prefix (trimmed)',
    tailMessage().text,
    seenAtStop.trimEnd(),
  );
  assert('the unrevealed remainder is discarded', tailMessage().text.length < LONG_REPLY.length);
  assert('the kept reply is flagged stopped', tailMessage().stopped === true);
  assert('a card that already arrived survives the stop', tailMessage().card?.kind === 'product');
  assert('stop mid-reveal unlocks the chat synchronously', chat.isStreaming === false);
  await act(async () => {
    await sleep(REVEAL_TICK_MS * 4);
  });
  assertEqual(
    'no zombie reveal tick grows the stopped reply',
    tailMessage().text,
    seenAtStop.trimEnd(),
  );

  // 3d. An error arriving mid-reveal replaces the reply wholesale and clears
  //     the buffer — nothing resurrects afterwards.
  await act(() => {
    chat.send('Error mid-reveal');
  });
  const r4 = takeStream('error mid-reveal');
  await actSettle(() => {
    r4.emit({ content: LONG_REPLY });
  });
  await waitUntil('the reveal is underway before the error lands', () => {
    const m = tailMessage();
    return m.status === 'streaming' && m.text.length > 0;
  });
  await actSettle(() => {
    r4.emit({ error: 'model unavailable' });
    r4.close();
  });
  assertEqual(
    'the error replaces the partially revealed text',
    tailShapes(1),
    'assistant/error:model unavailable',
  );
  assert('an error unlocks the chat', chat.isStreaming === false);
  await act(async () => {
    await sleep(REVEAL_TICK_MS * 4);
  });
  assertEqual(
    'no buffered text resurrects after an error',
    tailMessage().text,
    'model unavailable',
  );
  assertEqual('every stream in the pacing section was accounted for', opened.length, 0);

  // Cleanup: end every scripted stream (aborted ones must finalize silently —
  // any stray update here would warn and corrupt the transcripts above).
  for (const stream of everOpened) stream.close();
  await actSettle();
  await act(() => {
    renderer?.unmount();
  });

  finish();
}

main().catch(error => {
  console.error('coach stop-control check crashed:', error);
  process.exit(1);
});
