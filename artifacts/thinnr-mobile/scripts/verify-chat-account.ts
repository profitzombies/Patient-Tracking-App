/**
 * Per-account coach + support chat persistence check (real-account mode).
 *
 * Renders the REAL PatientAccountProvider + PatientProvider +
 * CoachChatProvider (and the real support-chat screen) under Node via
 * react-test-renderer, against a scripted API with a per-patient in-memory
 * chat store and hand-fed SSE streams:
 *
 *   1. The demo persona is byte-identical to today: without the account
 *      provider the greeting seeds synchronously, ids stay in the classic
 *      `coach-<n>` space, the chat request carries no Authorization header
 *      and no localDate, and NOTHING calls the persistence API.
 *   2. A signed-in patient's first-ever open hydrates an empty transcript
 *      and greets from the account's own name and program day (never the
 *      demo seed); the greeting persists so later opens replay it instead
 *      of rebuilding it. Chat requests carry the bearer token and the
 *      app's local date.
 *   3. Finalized messages persist with exactly the revealed text — cards,
 *      quick replies, reply linkage, and stopped fragments included; a
 *      remount ("reinstall") rebuilds the conversation from the server
 *      alone and replays restored history (stopped flags intact) into the
 *      next request.
 *   4. Chat photos upload once to the account's media rail; the stored
 *      message carries the object path, the rebuilt bubble displays via the
 *      signed-URL route, and replayed history stays text-only.
 *   5. Accounts never bleed: sign-out returns the demo seed with zero
 *      further persistence calls, and a second account starts fresh.
 *   6. Hydration failures retry rather than silently forking the thread.
 *   7. The support screen persists its thread per account with the same
 *      hydrate/append pattern, and stays session-only for the demo persona.
 *   8. HQ's coach-availability policy: a signed-in patient whose care team
 *      paused the coach sees the paused state up front (availability probe
 *      on open), a paused 503 on send withdraws the waiting bubble instead
 *      of an error, send/sendPhoto stay no-ops while paused, the coach
 *      screen closes its composer with the notice, and the demo persona
 *      never probes or pauses.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:chat-account
 */
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const localStorageBacking = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => localStorageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => void localStorageBacking.set(key, String(value)),
  removeItem: (key: string) => void localStorageBacking.delete(key),
};

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { PatientProvider } from '../context/PatientContext';
import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { usePatientAccount, type PatientAccountState } from '../context/PatientAccountContext';
import {
  CoachChatProvider,
  useCoachChat,
  GREETING_MESSAGE_ID,
  MEAL_PHOTO_MESSAGE_TEXT,
  OUTREACH_MESSAGE_ID,
  type CoachChatContextValue,
} from '../context/CoachChatContext';
import { AppModeProvider } from '../context/AppModeContext';
import SupportChatScreen from '../app/support-chat';
import CoachChatScreen from '../app/coach-chat';
import { TODAY_KEY } from '../data/patient-data';
import { localTodayKey } from '../lib/live-patient-entry';
import { patientMediaDisplayUrl } from '../lib/patient-data-api';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';
import { emitChatSync } from '../lib/chat-sync-events';
import { resolveNotificationRoute } from '../lib/push-notification-core';

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

function section(name: string) {
  console.log(`\n· ${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await sleep(1);
    });
  }
}

/** Polls (driving React timers through act) until cond holds or times out. */
async function waitUntil(label: string, cond: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) {
      checks += 1;
      return true;
    }
    await act(async () => {
      await sleep(8);
    });
  }
  fail(`timed out: ${label}`);
  return false;
}

// ─── Scripted SSE streams (coach + support chat) ─────────────────────────────

const encoder = new TextEncoder();

interface ScriptedSse {
  path: string; // 'coach/chat' | 'support/chat'
  auth: string | null;
  body: Record<string, unknown>;
  emit(payload: Record<string, unknown>): void;
  close(): void;
}

const openedStreams: ScriptedSse[] = [];

function scriptedSse(
  path: string,
  auth: string | null,
  init?: { body?: unknown; signal?: AbortSignal | null },
): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let dead = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const scripted: ScriptedSse = {
    path,
    auth,
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
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
  const signal = init?.signal ?? undefined;
  if (signal) {
    signal.addEventListener('abort', () => {
      if (dead) return;
      dead = true;
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      controller.error(error);
    });
  }
  openedStreams.push(scripted);
  return { ok: true, status: 200, body } as unknown as Response;
}

async function takeStream(label: string): Promise<ScriptedSse | null> {
  const ok = await waitUntil(`${label}: stream opened`, () => openedStreams.length > 0);
  if (!ok) return null;
  return openedStreams.shift() ?? null;
}

// ─── JSON API + per-patient chat store ───────────────────────────────────────

type WireMsg = Record<string, unknown> & { id: string };

interface ApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | null;
  body: Record<string, unknown> | null;
}

type Scripted = { status: number; body: unknown };

interface ChatStore {
  coach: Map<string, WireMsg>;
  support: Map<string, WireMsg>;
}

const chatStores = new Map<string, ChatStore>();
const patientFacts = new Map<string, { firstName: string; programDay: number }>();
const tokenRoles = new Map<string, { kind: string; patientId?: string }>();
const apiCalls: ApiCall[] = [];
const failNext = new Map<string, Scripted | 'network'>();
/** HQ policy stand-in: patient ids whose care team has the coach paused. */
const coachPausedFor = new Set<string>();
const PAUSED_MESSAGE =
  'Your care team has paused the coach for now. Your diary, check-ins, and photos keep working, and the coach will be back as soon as they turn it on again.';
const uploadPuts: string[] = [];
const mintedPaths: string[] = [];
let uploadCounter = 0;

function chatStoreFor(patientId: string): ChatStore {
  let store = chatStores.get(patientId);
  if (!store) {
    store = { coach: new Map(), support: new Map() };
    chatStores.set(patientId, store);
  }
  return store;
}

function storedThread(patientId: string, thread: 'coach' | 'support'): WireMsg[] {
  return [...chatStoreFor(patientId)[thread].values()];
}

function callsTo(path: string): ApiCall[] {
  return apiCalls.filter(call => call.path === path);
}

function routeCall(call: ApiCall): Scripted {
  const key = `${call.method} ${call.path}`;
  const scripted = failNext.get(key);
  if (scripted) {
    failNext.delete(key);
    if (scripted === 'network') throw new TypeError('network request failed');
    return scripted;
  }

  if (key === 'GET claim/whoami') {
    if (!call.token) return { status: 401, body: { error: 'Sign in required.' } };
    const role = tokenRoles.get(call.token);
    if (!role) return { status: 401, body: { error: 'Sign in required.' } };
    return { status: 200, body: role };
  }

  const role = call.token ? tokenRoles.get(call.token) : undefined;
  if (!role || role.kind !== 'patient' || !role.patientId) {
    return { status: role ? 403 : 401, body: { error: 'Sign in required.' } };
  }
  const patientId = role.patientId;

  if (key === 'GET coach/availability') {
    const paused = coachPausedFor.has(patientId);
    return { status: 200, body: { available: !paused, message: paused ? PAUSED_MESSAGE : null } };
  }

  if (key === 'GET patient-data/state') {
    return {
      status: 200,
      body: { entries: [], water: {}, targets: {}, favorites: [], recents: [] },
    };
  }
  if (
    key === 'POST patient-data/entries' ||
    key === 'PUT patient-data/water' ||
    key === 'PUT patient-data/targets' ||
    key === 'PUT patient-data/prefs' ||
    key === 'POST patient-data/library'
  ) {
    return { status: 200, body: { ok: true } };
  }

  if (key === 'GET patient-chat/coach' || key === 'GET patient-chat/support') {
    const thread = call.path.endsWith('support') ? 'support' : 'coach';
    return {
      status: 200,
      body: {
        messages: storedThread(patientId, thread),
        patient: patientFacts.get(patientId) ?? { firstName: 'there', programDay: 1 },
      },
    };
  }
  if (key === 'POST patient-chat/coach/messages' || key === 'POST patient-chat/support/messages') {
    const thread = call.path.includes('/support/') ? 'support' : 'coach';
    const store = chatStoreFor(patientId)[thread];
    const messages = (call.body?.messages as WireMsg[] | undefined) ?? [];
    if (messages.some(message => message.role === 'staff')) {
      return { status: 400, body: { error: 'Staff messages are server owned.' } };
    }
    for (const message of messages) store.set(message.id, message);
    return { status: 200, body: { ok: true } };
  }

  if (key === 'POST patient-media/upload-url') {
    uploadCounter += 1;
    const objectPath = `/objects/patient-media/${patientId}/chat-fixture-${uploadCounter}00000`;
    mintedPaths.push(objectPath);
    return {
      status: 200,
      body: { uploadUrl: `https://thinnr.test/upload/u${uploadCounter}`, objectPath },
    };
  }
  if (key === 'POST patient-media/finalize') {
    return { status: 200, body: { ok: true } };
  }

  throw new Error(`unscripted route: ${key}`);
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://thinnr.test') throw new Error(`unexpected fetch: ${url.href}`);
  const method = (init?.method ?? 'GET').toUpperCase();

  // Presigned photo upload PUT — raw bytes, no /api prefix.
  if (url.pathname.startsWith('/upload/')) {
    if (method !== 'PUT') throw new Error(`unexpected ${method} to ${url.pathname}`);
    uploadPuts.push(url.pathname);
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }

  if (!url.pathname.startsWith('/api/')) throw new Error(`unexpected fetch: ${url.href}`);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers.Authorization ?? null;
  const path = url.pathname.slice('/api/'.length);

  // Chat streams answer with a hand-fed SSE body — unless HQ has the coach
  // paused for this patient, in which case the server answers 503 JSON
  // before any model work (the demo persona is never paused).
  if (path === 'coach/chat' || path === 'support/chat') {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const patientId = token ? tokenRoles.get(token)?.patientId : undefined;
    if (path === 'coach/chat' && patientId && coachPausedFor.has(patientId)) {
      apiCalls.push({ method, path: 'coach/chat[paused]', query: url.searchParams, token, body: null });
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: PAUSED_MESSAGE, retryable: false, coachPaused: true }),
      } as Response;
    }
    return scriptedSse(path, auth, init as { body?: unknown; signal?: AbortSignal | null });
  }

  const call: ApiCall = {
    method,
    path,
    query: url.searchParams,
    token: auth?.startsWith('Bearer ') ? auth.slice(7) : null,
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
  };
  apiCalls.push(call);
  const result = routeCall(call);
  return { ok: result.status < 300, status: result.status, json: async () => result.body } as Response;
}) as typeof fetch;

// ─── Sessions ────────────────────────────────────────────────────────────────

const P1: StubSession = { access_token: 'tok-p1', user: { id: 'user-p1' } };
const P2: StubSession = { access_token: 'tok-p2', user: { id: 'user-p2' } };

tokenRoles.set('tok-p1', { kind: 'patient', patientId: 'p-1' });
tokenRoles.set('tok-p2', { kind: 'patient', patientId: 'p-2' });
patientFacts.set('p-1', { firstName: 'Riley', programDay: 12 });
patientFacts.set('p-2', { firstName: 'Jordan', programDay: 1 });

// ─── Probe + render helpers ──────────────────────────────────────────────────

let chat!: CoachChatContextValue;
let account!: PatientAccountState;

function Probe() {
  chat = useCoachChat();
  account = usePatientAccount();
  return null;
}

/** Full app wiring: account resolver above the store, chat above the probe. */
async function mountLive(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      React.createElement(
        PatientAccountProvider,
        null,
        React.createElement(
          PatientProvider,
          null,
          React.createElement(CoachChatProvider, null, React.createElement(Probe)),
        ),
      ),
    );
  });
  await settle();
  return tree;
}

/** How every existing coach suite mounts the provider — no account layer. */
async function mountDemo(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      React.createElement(
        PatientProvider,
        null,
        React.createElement(CoachChatProvider, null, React.createElement(Probe)),
      ),
    );
  });
  await settle();
  return tree;
}

async function mountSupport(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      React.createElement(
        AppModeProvider,
        null,
        React.createElement(
          PatientAccountProvider,
          null,
          React.createElement(SupportChatScreen),
        ),
      ),
      { createNodeMock: () => ({ scrollToEnd() {}, focus() {}, blur() {} }) },
    );
  });
  await settle();
  return tree;
}

async function unmount(tree: ReactTestRenderer): Promise<void> {
  await act(async () => {
    tree.unmount();
  });
}

async function signIn(session: StubSession | null): Promise<void> {
  await act(async () => {
    setStubSession(session);
  });
  await settle();
}

function tail() {
  return chat.messages[chat.messages.length - 1];
}

function wireOf(patientId: string, thread: 'coach' | 'support', clientId: string): WireMsg | undefined {
  return chatStoreFor(patientId)[thread].get(clientId);
}

// Reveal pacing means replies land over real time; sends are synchronous.
async function sendText(text: string): Promise<void> {
  await act(async () => {
    chat.send(text);
  });
}

// ─── The walk ────────────────────────────────────────────────────────────────

const RILEY_GREETING_PREFIX = 'Hey Riley, good to see you. 12 days in.';

async function main() {
  // ── 1 · Demo persona byte-identical ────────────────────────────────────────
  section('demo persona: synchronous greeting, bare request, zero persistence');
  let tree = await mountDemo();
  // The demo seed's stall trigger is live, so the outreach bubble may join
  // the greeting — exactly as in production today.
  assert('demo greeting seeds synchronously', chat.messages[0]?.id === GREETING_MESSAGE_ID);
  assert('demo greeting keeps its fixed id', chat.messages[0]?.id === GREETING_MESSAGE_ID);
  assert('demo account is the context default', account.account.kind === 'demo' && !account.resolving);

  await sendText('hi');
  const demoStream = await takeStream('demo send');
  if (demoStream) {
    assert('demo request has no Authorization header', demoStream.auth === null);
    assert('demo request body has no localDate', !('localDate' in demoStream.body));
    demoStream.emit({ content: 'Hello there.' });
    demoStream.emit({ done: true });
    demoStream.close();
  }
  await waitUntil('demo reply reveals', () => tail()?.status === 'done' && tail()?.text === 'Hello there.');
  assert(
    'demo ids stay in the coach-<n> space',
    chat.messages
      .slice(1)
      .filter(m => m.id !== OUTREACH_MESSAGE_ID)
      .every(m => /^coach-\d+$/.test(m.id)),
  );
  assert('demo made zero JSON API calls', apiCalls.length === 0);
  await unmount(tree);

  // ── 2 · Real account: fresh thread, personalized greeting, authed stream ──
  section('real account: hydrates empty, greets from account facts, sends authed');
  await signIn(P1);
  tree = await mountLive();
  await waitUntil('account resolves + greeting appears', () => chat.messages.length === 1);
  const greeting = chat.messages[0];
  assert('real greeting keeps the fixed id', greeting?.id === GREETING_MESSAGE_ID);
  assert(
    `real greeting speaks to Riley/day 12 (got: ${JSON.stringify(greeting?.text?.slice(0, 48))})`,
    typeof greeting?.text === 'string' && greeting.text.startsWith(RILEY_GREETING_PREFIX),
  );
  assert('real greeting never ends with a question', !greeting?.text?.trimEnd().endsWith('?'));
  await waitUntil('greeting persists to the account', () => {
    const wire = wireOf('p-1', 'coach', GREETING_MESSAGE_ID);
    return wire !== undefined && wire.text === greeting?.text && wire.role === 'assistant';
  });

  await sendText('What should I eat today?');
  const askStream = await takeStream('real send');
  const fullReply =
    'Grilled chicken with roasted vegetables would land well tonight, plenty of protein left in your day.';
  if (askStream) {
    assert('real request carries the bearer token', askStream.auth === 'Bearer tok-p1');
    assert('real request carries the app local date', askStream.body.localDate === localTodayKey());
    askStream.emit({ content: fullReply });
    askStream.emit({ card: { kind: 'product', payload: { sku: 'kept-product' } } });
    askStream.emit({ quickReplies: ['Yes, please', 'No thanks'] });
    askStream.emit({ done: true });
    askStream.close();
  }
  await waitUntil('reply reveals fully', () => tail()?.status === 'done' && tail()?.text === fullReply);
  const userTurn = chat.messages[1];
  const replyTurn = chat.messages[2];
  assert('reply links back to the user turn', replyTurn?.replyToId === userTurn?.id);

  await waitUntil('finalized turns persist', () => storedThread('p-1', 'coach').length === 3);
  const storedRows = storedThread('p-1', 'coach');
  const storedUser = storedRows[1];
  const storedReply = storedRows[2];
  assert('stored user turn is verbatim', storedUser?.text === 'What should I eat today?' && storedUser?.role === 'user');
  assert('stored reply text is exactly the revealed text', storedReply?.text === fullReply);
  assert(
    'stored reply keeps the card payload',
    JSON.stringify(storedReply?.card) === JSON.stringify({ kind: 'product', payload: { sku: 'kept-product' } }),
  );
  assert(
    'stored reply keeps the quick replies',
    JSON.stringify(storedReply?.quickReplies) === JSON.stringify(['Yes, please', 'No thanks']),
  );
  assert('stored reply keeps the reply linkage', storedReply?.replyToId === storedUser?.id);
  assert('stored reply is not marked stopped', !storedReply?.stopped);

  // ── 3 · Restart-resume: remount rebuilds from the server alone ────────────
  section('restart: transcript, cards, chips, linkage all come back');
  await unmount(tree);
  tree = await mountLive();
  await waitUntil('stored transcript hydrates', () => chat.messages.length === 3);
  assert('exactly one greeting after restart', chat.messages.filter(m => m.id === GREETING_MESSAGE_ID).length === 1);
  assert('restored order is greeting → user → reply', chat.messages[0]?.id === GREETING_MESSAGE_ID && chat.messages[1]?.role === 'user');
  assert('restored reply text matches', chat.messages[2]?.text === fullReply);
  assert('restored reply card survives', chat.messages[2]?.card?.kind === 'product');
  assert(
    'restored quick replies survive',
    JSON.stringify(chat.messages[2]?.quickReplies) === JSON.stringify(['Yes, please', 'No thanks']),
  );
  assert('restored linkage survives', chat.messages[2]?.replyToId === chat.messages[1]?.id);
  assert('restored bubbles are all finalized', chat.messages.every(m => m.status === 'done'));

  await sendText('Thanks!');
  const followStream = await takeStream('post-restart send');
  if (followStream) {
    const replayed = (followStream.body.messages as { content?: string }[] | undefined) ?? [];
    assert(
      'restored history replays into the request',
      replayed.some(m => m.content === fullReply) && replayed.some(m => m.content?.startsWith('Hey Riley')),
    );
    followStream.emit({ content: 'Any time.' });
    followStream.emit({ done: true });
    followStream.close();
  }
  await waitUntil('follow-up reveals', () => tail()?.status === 'done' && tail()?.text === 'Any time.');
  await waitUntil('follow-up persists', () => storedThread('p-1', 'coach').length === 5);

  // ── 4 · Stopped replies: kept fragment persists and replays flagged ───────
  section('stopped reply: fragment stores stopped:true and rides replay flagged');
  await sendText('Tell me about phase 2.');
  const stopStream = await takeStream('stoppable send');
  const longText =
    'Phase two is where the routine settles in and the scale starts matching the effort you have been putting in every single day of this program.';
  stopStream?.emit({ content: longText });
  await waitUntil('reveal is mid-flight', () => {
    const t = tail();
    return t?.role === 'assistant' && t.status === 'streaming' && t.text.length >= 12;
  });
  await act(async () => {
    chat.stop();
  });
  const kept = tail();
  const keptText = kept?.text ?? '';
  assert('stop finalizes the bubble', kept?.status === 'done' && kept?.stopped === true);
  assert('stop kept a partial fragment', keptText.length > 0 && keptText.length < longText.length);
  stopStream?.close();

  await waitUntil('stopped fragment persists verbatim', () => {
    const wire = kept ? wireOf('p-1', 'coach', kept.id) : undefined;
    return wire !== undefined && wire.text === keptText && wire.stopped === true;
  });

  await unmount(tree);
  tree = await mountLive();
  await waitUntil('restart restores the stopped bubble', () =>
    chat.messages.some(m => m.text === keptText && m.stopped === true && m.status === 'done'),
  );
  await sendText('And?');
  const afterStop = await takeStream('post-stop send');
  if (afterStop) {
    const replayed = (afterStop.body.messages as { content?: string; stopped?: boolean }[] | undefined) ?? [];
    const fragment = replayed.find(m => m.content === keptText);
    assert('replayed stopped turn keeps its flag', fragment?.stopped === true);
    afterStop.emit({ content: 'Then we keep going.' });
    afterStop.emit({ done: true });
    afterStop.close();
  }
  await waitUntil('post-stop reply reveals', () => tail()?.status === 'done' && tail()?.text === 'Then we keep going.');
  await waitUntil('post-stop turns persist', () => storedThread('p-1', 'coach').length === 9);

  // ── 5 · Chat photos: stored copy, display URL, text-only replay ───────────
  section('chat photo: uploads once, bubble survives restart, replay is text-only');
  const dataUri = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`;
  await act(async () => {
    chat.sendPhoto({ uri: dataUri, width: 640, height: 480 }, 'meal', { mealSlot: 'lunch' });
  });
  const photoStream = await takeStream('photo send');
  if (photoStream) {
    const messages = (photoStream.body.messages as { image?: string }[] | undefined) ?? [];
    assert('photo rides only the request tail', messages[messages.length - 1]?.image === dataUri);
    photoStream.emit({ content: 'Logged that lunch for you.' });
    photoStream.emit({ done: true });
    photoStream.close();
  }
  await waitUntil('photo reply reveals', () => tail()?.status === 'done' && tail()?.text === 'Logged that lunch for you.');
  await waitUntil('photo turn persists with a stored path', () => {
    const rows = storedThread('p-1', 'coach');
    const photoRow = rows.find(r => (r.photo as { path?: string } | undefined)?.path);
    return photoRow !== undefined;
  });
  assert('exactly one upload was minted', callsTo('patient-media/upload-url').length === 1);
  assert('the photo bytes were PUT once', uploadPuts.length === 1);
  assert('the upload was finalized', callsTo('patient-media/finalize').length === 1);
  const storedPhotoRow = storedThread('p-1', 'coach').find(
    r => (r.photo as { path?: string } | undefined)?.path,
  );
  const storedPhoto = storedPhotoRow?.photo as
    | { path?: string; width?: number; height?: number; kind?: string; mealSlot?: string }
    | undefined;
  assert('stored photo path is the minted object path', storedPhoto?.path === mintedPaths[0]);
  assert('stored photo keeps its dimensions', storedPhoto?.width === 640 && storedPhoto?.height === 480);
  assert('stored photo keeps kind + pinned slot', storedPhoto?.kind === 'meal' && storedPhoto?.mealSlot === 'lunch');
  assert('stored photo turn keeps its fixed text', storedPhotoRow?.text === MEAL_PHOTO_MESSAGE_TEXT);

  await unmount(tree);
  tree = await mountLive();
  await waitUntil('restart restores the photo bubble', () =>
    chat.messages.some(m => m.photo?.uri === patientMediaDisplayUrl(mintedPaths[0] ?? '')),
  );
  assert('restart re-mints nothing', callsTo('patient-media/upload-url').length === 1);
  const restoredPhotoBubble = chat.messages.find(m => m.photo !== undefined);
  assert('restored photo keeps its dimensions', restoredPhotoBubble?.photo?.width === 640);

  await sendText('What was in it?');
  const afterPhoto = await takeStream('post-photo send');
  if (afterPhoto) {
    const replayed = (afterPhoto.body.messages as { image?: string }[] | undefined) ?? [];
    assert('replayed history omits old photos', replayed.every(m => m.image === undefined));
    afterPhoto.emit({ content: 'Chicken, mostly.' });
    afterPhoto.emit({ done: true });
    afterPhoto.close();
  }
  await waitUntil('post-photo reply reveals', () => tail()?.status === 'done' && tail()?.text === 'Chicken, mostly.');
  await waitUntil('post-photo turns persist', () => storedThread('p-1', 'coach').length === 13);

  // ── 6 · Account isolation: sign-out reseeds demo, second account is fresh ─
  section('isolation: sign-out returns demo, second account never sees the first');
  const p1Snapshot = JSON.stringify(storedThread('p-1', 'coach'));
  const chatCallsBeforeSignOut = callsTo('patient-chat/coach').length + callsTo('patient-chat/coach/messages').length;
  await signIn(null);
  assert('sign-out reseeds the demo greeting', chat.messages.length === 1 && chat.messages[0]?.id === GREETING_MESSAGE_ID);
  assert('demo greeting is not the account greeting', !chat.messages[0]?.text.includes('Riley'));
  assert(
    'sign-out makes no persistence calls',
    callsTo('patient-chat/coach').length + callsTo('patient-chat/coach/messages').length === chatCallsBeforeSignOut,
  );

  await signIn(P2);
  await waitUntil('second account greets fresh', () => chat.messages.length === 1 && chat.messages[0]?.text.includes('Jordan') === true);
  assert('day-1 greeting drops the commitment line', !chat.messages[0]?.text.includes('days in'));
  await sendText('hello');
  const p2Stream = await takeStream('second-account send');
  if (p2Stream) {
    assert('second account sends its own token', p2Stream.auth === 'Bearer tok-p2');
    p2Stream.emit({ content: 'Hi Jordan.' });
    p2Stream.emit({ done: true });
    p2Stream.close();
  }
  await waitUntil('second-account turns persist to p-2', () => storedThread('p-2', 'coach').length === 3);
  assert('first account store is untouched', JSON.stringify(storedThread('p-1', 'coach')) === p1Snapshot);
  assert(
    'no first-account text bleeds into the second',
    storedThread('p-2', 'coach').every(r => !(r.text as string).includes('Riley') && (r.text as string) !== fullReply),
  );

  // ── 7 · Hydration failure retries instead of forking ──────────────────────
  section('hydration failure: retries and recovers the stored transcript');
  await signIn(null);
  const readsBefore = callsTo('patient-chat/coach').length;
  failNext.set('GET patient-chat/coach', 'network');
  await signIn(P1);
  await waitUntil('transcript recovers after a failed load', () => chat.messages.length >= 13, 12000);
  assert('the failed read was retried', callsTo('patient-chat/coach').length >= readsBefore + 2);

  section('care-team replies: merge, context, sync targeting, and no client persistence');
  const streamsBeforeStaff = openedStreams.length;
  chatStoreFor('p-1').coach.set('staff-coach-1', {
    id: 'staff-coach-1',
    role: 'staff',
    text: 'Please keep an eye on hydration today.',
    senderLabel: 'Dr. Ellis',
  });
  await act(async () => {
    await chat.refreshThread();
  });
  assert('coach refresh renders the staff row', chat.messages.some(message =>
    message.id === 'staff-coach-1' &&
    message.role === 'staff' &&
    message.senderLabel === 'Dr. Ellis'
  ));
  await act(async () => {
    await chat.refreshThread();
  });
  assert('coach refresh does not duplicate a staff id',
    chat.messages.filter(message => message.id === 'staff-coach-1').length === 1);
  assert('a staff row never starts a coach request', openedStreams.length === streamsBeforeStaff);

  const coachReadsBeforeWrongEvent = callsTo('patient-chat/coach').length;
  emitChatSync('support');
  await settle();
  assert('support sync events do not refresh coach',
    callsTo('patient-chat/coach').length === coachReadsBeforeWrongEvent);
  chatStoreFor('p-1').coach.set('staff-coach-2', {
    id: 'staff-coach-2',
    role: 'staff',
    text: 'Reply here if anything changes.',
    senderLabel: 'Riverside Care Team',
  });
  emitChatSync('coach');
  await waitUntil('coach care-team event refetches the thread', () =>
    chat.messages.some(message => message.id === 'staff-coach-2'));

  await sendText('I will, thank you.');
  const careContextStream = await takeStream('staff context send');
  if (careContextStream) {
    const history = careContextStream.body.messages as Array<Record<string, unknown>>;
    assert('coach request includes staff context',
      history.some(message => message.role === 'staff' &&
        message.content === 'Reply here if anything changes.'));
    assert('coach request still ends with the patient turn',
      history[history.length - 1]?.role === 'user');
    careContextStream.emit({ content: 'You are welcome.' });
    careContextStream.emit({ done: true });
    careContextStream.close();
  }
  await waitUntil('care-team follow-up finalizes', () =>
    chat.messages.some(message => message.text === 'You are welcome.' && message.status === 'done'));
  assert('coach persistence never posts staff rows', callsTo('patient-chat/coach/messages').every(call =>
    !((call.body?.messages as WireMsg[] | undefined) ?? []).some(message => message.role === 'staff')
  ));
  assert('support notification route is accepted',
    resolveNotificationRoute({
      route: '/support-chat',
      kind: 'care_team_reply',
      thread: 'support',
    }) === '/support-chat');
  await unmount(tree);

  // ── 8 · Support screen: same per-account pattern, demo stays session-only ─
  section('support chat: persists per account, hydrates on reopen, demo untouched');
  chatStoreFor('p-1').support.set('staff-support-1', {
    id: 'staff-support-1',
    role: 'staff',
    text: 'We received your support request.',
    senderLabel: 'Riverside Care Team',
  });
  let supportTree = await mountSupport();
  await waitUntil('support thread hydrates staff reply', () =>
    JSON.stringify(supportTree.toJSON()).includes('We received your support request.'));
  const input = supportTree.root.findAll(node => node.type === 'TextInput')[0];
  assert('support input renders', input !== undefined);
  await act(async () => {
    (input?.props as { onChangeText?: (t: string) => void }).onChangeText?.('My app crashed.');
  });
  const sendButton = supportTree.root.findAll(
    node => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Send message',
  )[0];
  assert('support send button renders', sendButton !== undefined);
  await act(async () => {
    (sendButton?.props as { onPress?: () => void }).onPress?.();
  });
  const supportStream = await takeStream('support send');
  if (supportStream) {
    assert('support stream is the support route', supportStream.path === 'support/chat');
    const history = supportStream.body.messages as Array<Record<string, unknown>>;
    assert('support request includes staff context',
      history.some(message => message.role === 'staff' &&
        message.content === 'We received your support request.'));
    assert('support request still ends with the patient turn',
      history[history.length - 1]?.role === 'user');
    supportStream.emit({ content: 'Try reinstalling from the store.' });
    supportStream.emit({ done: true });
    supportStream.close();
  }
  await waitUntil('support turns persist', () => storedThread('p-1', 'support').length === 3);
  const supportRows = storedThread('p-1', 'support');
  assert('support user turn stored verbatim', supportRows[1]?.text === 'My app crashed.' && supportRows[1]?.role === 'user');
  assert('support reply stored verbatim', supportRows[2]?.text === 'Try reinstalling from the store.');
  assert('support persistence never posts staff rows', callsTo('patient-chat/support/messages').every(call =>
    !((call.body?.messages as WireMsg[] | undefined) ?? []).some(message => message.role === 'staff')
  ));

  await unmount(supportTree);
  supportTree = await mountSupport();
  await waitUntil('support restart shows the stored thread', () =>
    JSON.stringify(supportTree.toJSON()).includes('Try reinstalling from the store.'),
  );
  const supportReadsBeforeWrongEvent = callsTo('patient-chat/support').length;
  emitChatSync('coach');
  await settle();
  assert('coach sync events do not refresh support',
    callsTo('patient-chat/support').length === supportReadsBeforeWrongEvent);
  chatStoreFor('p-1').support.set('staff-support-2', {
    id: 'staff-support-2',
    role: 'staff',
    text: 'Your support specialist is reviewing this.',
    senderLabel: 'Riverside Care Team',
  });
  emitChatSync('support');
  await waitUntil('support care-team event refetches the thread', () =>
    JSON.stringify(supportTree.toJSON()).includes('Your support specialist is reviewing this.'));

  await unmount(supportTree);
  await signIn(null);
  const supportReadsBefore = callsTo('patient-chat/support').length;
  supportTree = await mountSupport();
  await settle();
  assert('demo support screen never reads the account', callsTo('patient-chat/support').length === supportReadsBefore);
  assert('demo support screen starts empty', JSON.stringify(supportTree.toJSON()).includes('Try reinstalling') === false);
  await unmount(supportTree);

  // ── 9 · HQ coach-availability policy ──────────────────────────────────────
  section('coach paused by the care team: probe on open, 503 on send, composer closed');
  // A stale probe must never let a paused turn through: the server's answer
  // on send is the authority. Start un-paused, pause between open and send.
  await signIn(P1);
  tree = await mountLive();
  await waitUntil('paused-section account resolves', () => chat.messages.length >= 1);
  await waitUntil('availability probed on open', () => callsTo('coach/availability').length >= 1);
  assert('probe carries the bearer token', callsTo('coach/availability').at(-1)?.token === 'tok-p1');
  assert('coach available: no paused state', chat.coachPaused === null);
  coachPausedFor.add('p-1');
  const countBefore = chat.messages.length;
  await sendText('are you there?');
  await waitUntil('paused answer lands', () => chat.coachPaused !== null);
  assert('paused state carries the server wording', chat.coachPaused?.message === PAUSED_MESSAGE);
  assert('no coach stream opened for the paused turn', openedStreams.length === 0);
  assert('paused turn hit the chat route (server is the authority)', callsTo('coach/chat[paused]').length === 1);
  assert(
    'the waiting bubble is withdrawn, not shown as an error',
    chat.messages.length === countBefore + 1 &&
      chat.messages.at(-1)?.role === 'user' &&
      chat.messages.every(m => m.status !== 'error'),
  );
  assert('chat is unlocked after the pause', chat.isStreaming === false);
  const pausedCalls = callsTo('coach/chat[paused]').length;
  await sendText('hello?');
  await settle();
  assert('send is a no-op while paused', callsTo('coach/chat[paused]').length === pausedCalls && chat.messages.length === countBefore + 1);
  await act(async () => {
    chat.sendPhoto({ uri: 'data:image/jpeg;base64,/9j/4AAQ', width: 10, height: 10 });
  });
  await settle();
  assert('sendPhoto is a no-op while paused', chat.messages.length === countBefore + 1 && openedStreams.length === 0);
  await unmount(tree);

  // Reopen while still paused: the probe shows the state before any send.
  tree = await mountLive();
  await waitUntil('reopen probe reports paused', () => chat.coachPaused !== null);
  assert('reopen state carries the server wording', chat.coachPaused?.message === PAUSED_MESSAGE);
  await unmount(tree);

  // The coach screen: notice rendered, composer closed.
  let screenTree!: ReactTestRenderer;
  await act(async () => {
    screenTree = create(
      React.createElement(
        AppModeProvider,
        null,
        React.createElement(
          PatientAccountProvider,
          null,
          React.createElement(
            PatientProvider,
            null,
            React.createElement(CoachChatProvider, null, React.createElement(CoachChatScreen)),
          ),
        ),
      ),
    );
  });
  await settle();
  await waitUntil('coach screen shows the paused notice', () =>
    screenTree.root.findAll(n => (n.props as { testID?: string }).testID === 'coach-paused-notice').length > 0,
  );
  const screenJson = JSON.stringify(screenTree.toJSON());
  assert('notice names the care team', screenJson.includes('Coach paused by your care team'));
  assert('notice carries the server wording', screenJson.includes(PAUSED_MESSAGE));
  const byTestId = (id: string) =>
    screenTree.root.findAll(n => (n.props as { testID?: string }).testID === id)[0]?.props as
      | Record<string, unknown>
      | undefined;
  assert('input is not editable', byTestId('coach-input')?.editable === false);
  assert('send button is disabled', byTestId('coach-send')?.disabled === true);
  assert('photo button is disabled', byTestId('coach-photo')?.disabled === true);
  await act(async () => {
    screenTree.unmount();
  });

  // Care team turns the coach back on: the demo persona was never affected.
  coachPausedFor.delete('p-1');
  await signIn(null);
  const probesBefore = callsTo('coach/availability').length;
  tree = await mountDemo();
  await settle();
  assert('demo persona never probes availability', callsTo('coach/availability').length === probesBefore);
  assert('demo persona is never paused', chat.coachPaused === null);
  await unmount(tree);

  console.log(`\n${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
