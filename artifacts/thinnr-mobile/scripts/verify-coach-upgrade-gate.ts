/**
 * Coach composer app-access gate (no network, no AI credits).
 *
 * Renders the REAL CoachChatProvider (inside the real PatientProvider, as a
 * local session) under a scripted app-access seam and a scripted transport,
 * and pins how the chat honors the office's app-access lock:
 *
 *   1. Locked: send() and sendPhoto() open the upgrade sheet and add no
 *      message, open no request, and leave the chat idle.
 *   2. Unlocked: the same calls open a turn exactly as before.
 *   3. Stale state (the app thinks it is unlocked, the server answers 402
 *      `upgradeRequired`): the waiting bubble is withdrawn — no error
 *      bubble, no retry — the lock is reported to the seam with the
 *      entitlement, and the chat is idle again (not stuck streaming).
 *   4. HQ pause keeps precedence: once the server has paused the coach, a
 *      locked send does nothing at all (the pause notice is the reply),
 *      never the upgrade sheet.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:coach-upgrade-gate
 */
import React, { act } from 'react';

import { PatientProvider } from '@/context/PatientContext';
import { CoachChatProvider, useCoachChat } from '@/context/CoachChatContext';
import { AppAccessContext, type AppAccessState } from '@/context/AppAccessContext';
import { premiumLocked, type AppAccessEntitlement, type PatientAppAccess } from '@/lib/app-access';

let checks = 0;
let failures = 0;
let finished = false;

function fail(message: string): void {
  failures += 1;
  console.error(`FAIL - ${message}`);
}
function assert(label: string, condition: boolean): void {
  checks += 1;
  if (condition) console.log(`ok - ${label}`);
  else fail(label);
}
function assertEqual(label: string, actual: string | number | boolean, expected: string | number | boolean): void {
  checks += 1;
  if (Object.is(actual, expected)) console.log(`ok - ${label}`);
  else fail(`${label}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`);
}
function finish(): never {
  finished = true;
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}
process.on('beforeExit', () => {
  if (!finished) {
    console.error('✗ coach upgrade gate: exited before finishing (dangling await?)');
    process.exit(1);
  }
});
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function actSettle(mutate?: () => void): Promise<void> {
  await act(async () => {
    mutate?.();
    await sleep(0);
    await sleep(0);
    await sleep(0);
  });
}
async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  checks += 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      console.log(`ok - ${label}`);
      return;
    }
    if (Date.now() > deadline) {
      fail(`${label}: condition not met within ${timeoutMs}ms`);
      return;
    }
    await act(async () => {
      await sleep(8);
    });
  }
}

// ── Scripted transport: each /coach/chat answers from the queue ────────────
interface Scripted {
  status: number;
  body: unknown;
}
const answers: Scripted[] = [];
const requests: string[] = [];
const encoder = new TextEncoder();

const scriptedFetch = (async (input: unknown, init?: { signal?: AbortSignal | null }) => {
  const url = String(
    typeof input === 'object' && input !== null && 'url' in (input as object)
      ? (input as { url: unknown }).url
      : input,
  );
  requests.push(url);
  if (init?.signal?.aborted) {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  const next = answers.shift();
  if (!next) throw new Error(`no scripted answer for ${url}`);
  if (next.status !== 200) {
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // A one-shot finished stream.
  const text = String(next.body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: text })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}) as unknown as typeof fetch;

// ── Fixtures ────────────────────────────────────────────────────────────────
const LOCKED_ENTITLEMENT: AppAccessEntitlement = {
  available: false,
  reason: 'locked',
  free_window: { kind: 'protocol', ends_on: '2026-10-01' },
  office_charges: true,
  price_cents: 999,
  cadence: 'monthly',
  subscription: null,
};
const LOCKED: PatientAppAccess = { ...LOCKED_ENTITLEMENT, subscription_id: null, checkout_url: 'https://billing.example.test/checkout' };
const OPEN: PatientAppAccess = {
  ...LOCKED_ENTITLEMENT,
  available: true,
  reason: 'protocol_window',
  free_window: { kind: 'protocol', ends_on: '2099-01-01' },
  subscription_id: null,
  checkout_url: null,
};
const UPGRADE_402 = { error: 'Subscribe to keep using the AI coach.', upgradeRequired: true, entitlement: LOCKED_ENTITLEMENT };
const PAUSED_503 = { error: 'Your care team has paused the coach for now.', retryable: false, coachPaused: true };
const PHOTO = { uri: 'data:image/jpeg;base64,PHOTODATA', width: 1200, height: 1600 };

const seamCalls = { sheet: 0, reports: [] as Array<AppAccessEntitlement | null> };
function seamValue(access: PatientAppAccess | null): AppAccessState {
  return {
    access,
    locked: premiumLocked(access),
    refresh: async () => {},
    openUpgradeSheet: () => {
      seamCalls.sheet += 1;
    },
    reportUpgradeRequired: entitlement => {
      seamCalls.reports.push(entitlement);
    },
  };
}

type Chat = ReturnType<typeof useCoachChat>;
let chat!: Chat;
function Probe(): null {
  chat = useCoachChat();
  return null;
}
const errorBubbles = () => chat.messages.filter(m => m.status === 'error').length;

async function main() {
  process.env.EXPO_PUBLIC_DOMAIN = 'coach-upgrade-gate.internal';
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = scriptedFetch;
  const localStore = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => (localStore.has(key) ? (localStore.get(key) as string) : null),
    setItem: (key: string, value: string) => void localStore.set(key, String(value)),
    removeItem: (key: string) => void localStore.delete(key),
  };
  localStore.set('thinnr_patient_state_v1', JSON.stringify({ nudgeOptOut: true }));
  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
    realConsoleError(...args);
  };
  const rendererModule = (await import('react-test-renderer')) as unknown as {
    default?: { create: (el: React.ReactElement) => { update(el: React.ReactElement): void; unmount(): void } };
    create?: (el: React.ReactElement) => { update(el: React.ReactElement): void; unmount(): void };
  };
  const TestRenderer = rendererModule.default ?? rendererModule;
  if (!TestRenderer.create) throw new Error('react-test-renderer did not expose create()');

  const h = React.createElement;
  const tree = (access: PatientAppAccess | null) =>
    h(
      AppAccessContext.Provider,
      { value: seamValue(access) },
      h(PatientProvider, null, h(CoachChatProvider, null, h(Probe))),
    );
  let renderer!: { update(el: React.ReactElement): void; unmount(): void };
  await act(async () => {
    renderer = TestRenderer.create!(tree(LOCKED));
    await sleep(0);
  });
  await actSettle();
  const baseline = chat.messages.length;

  // ── 1. Locked: the sheet is the reply ─────────────────────────────────────
  await actSettle(() => chat.send('Protein target?'));
  assertEqual('locked send: opens the upgrade sheet', seamCalls.sheet, 1);
  assertEqual('locked send: adds no message', chat.messages.length, baseline);
  assertEqual('locked send: opens no request', requests.length, 0);
  assertEqual('locked send: the chat stays idle', chat.isStreaming, false);
  await actSettle(() => chat.sendPhoto(PHOTO));
  assertEqual('locked photo: opens the upgrade sheet', seamCalls.sheet, 2);
  assertEqual('locked photo: adds no message', chat.messages.length, baseline);
  assertEqual('locked photo: opens no request', requests.length, 0);
  await actSettle(() => chat.send('Again?'));
  assertEqual('locked send is not single-flight blocked: every tap re-opens the sheet', seamCalls.sheet, 3);

  // ── 2. Unlocked: a turn opens as before ───────────────────────────────────
  answers.push({ status: 200, body: 'Aim for about 100 g.' });
  await actSettle(() => renderer.update(tree(OPEN)));
  await actSettle(() => chat.send('Protein target?'));
  await waitUntil('unlocked send: the turn completes', () => requests.length === 1 && !chat.isStreaming && chat.messages.length === baseline + 2);
  assertEqual('unlocked send: no sheet', seamCalls.sheet, 3);
  assert('unlocked send: the reply landed', chat.messages[chat.messages.length - 1]?.text === 'Aim for about 100 g.');

  // ── 3. Stale state: the server's 402 is terminal and reports the lock ─────
  answers.push({ status: 402, body: UPGRADE_402 });
  const before402 = chat.messages.length;
  await actSettle(() => chat.send('Dinner idea?'));
  await waitUntil('stale 402: the request reached the server', () => requests.length === 2);
  await waitUntil('stale 402: the lock is reported to the seam with its entitlement', () => seamCalls.reports.length === 1 && seamCalls.reports[0]?.reason === 'locked');
  await waitUntil('stale 402: the chat is idle again', () => !chat.isStreaming);
  assertEqual('stale 402: the waiting bubble is withdrawn (only the patient turn remains)', chat.messages.length, before402 + 1);
  assertEqual('stale 402: no error bubble, so nothing to retry', errorBubbles(), 0);
  assertEqual('stale 402: no sheet from the context itself (the seam opens it on report)', seamCalls.sheet, 3);

  // ── 4. The HQ pause keeps precedence over the lock ───────────────────────
  answers.push({ status: 503, body: PAUSED_503 });
  await actSettle(() => chat.send('Snack?'));
  await waitUntil('pause: the server pauses the coach', () => chat.coachPaused !== null && !chat.isStreaming);
  assertEqual('pause: the pause notice carries the server wording', chat.coachPaused?.message ?? '', PAUSED_503.error);
  await actSettle(() => renderer.update(tree(LOCKED)));
  const requestsBeforePause = requests.length;
  await actSettle(() => chat.send('Locked and paused'));
  assertEqual('paused + locked send: no upgrade sheet (the pause notice is the reply)', seamCalls.sheet, 3);
  assertEqual('paused + locked send: no request', requests.length, requestsBeforePause);
  await actSettle(() => chat.sendPhoto(PHOTO));
  assertEqual('paused + locked photo: no upgrade sheet', seamCalls.sheet, 3);

  renderer.unmount();
  assertEqual('every scripted answer was consumed', answers.length, 0);
  finish();
}

main().catch(error => {
  fail(`suite crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  finish();
});
