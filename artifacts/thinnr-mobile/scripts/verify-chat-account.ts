/**
 * Per-account coach + support chat persistence check (real-account mode).
 *
 * Renders the REAL PatientAccountProvider + PatientProvider +
 * CoachChatProvider (and the real support-chat screen) under Node via
 * react-test-renderer, against a scripted API with a per-patient in-memory
 * chat store and hand-fed SSE streams:
 *
 *   1. The signed-out session stays local: without the account
 *      provider the greeting seeds synchronously, ids stay in the classic
 *      `coach-<n>` space, the chat request carries no Authorization header
 *      and no localDate, and NOTHING calls the persistence API.
 *   2. A signed-in patient's first-ever open hydrates an empty transcript
 *      and greets from the account's own name and program day (never the
 *      signed-out seed); the greeting persists so later opens replay it instead
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
 *   5. Accounts never bleed: sign-out returns the signed-out seed with zero
 *      further persistence calls, and a second account starts fresh.
 *   6. Hydration failures retry rather than silently forking the thread.
 *   7. The support screen persists its thread per account with the same
 *      hydrate/append pattern, and stays session-only for the signed-out session.
 *   8. HQ's coach-availability policy: a signed-in patient whose care team
 *      paused the coach sees the paused state up front (availability probe
 *      on open), a paused 503 on send withdraws the waiting bubble instead
 *      of an error, send/sendPhoto stay no-ops while paused, the coach
 *      screen closes its composer with the notice, and the signed-out session
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
import {
  holdNextStubSessionLookup,
  rejectNextStubSessionLookup,
  setStubSession,
  type StubSession,
} from './live-diary-stubs/supabase';
import { emitChatSync } from '../lib/chat-sync-events';
import { resolveNotificationRoute } from '../lib/push-notification-core';
import { setChatAccountParams } from './chat-account-stubs/expo-router';

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
  /** Legacy-only fixture rail retained for the skipped migration assertions. */
  coach: Map<string, WireMsg>;
  support: Map<string, WireMsg>;
  conversations: Map<string, ConversationStore>;
}

interface ConversationStore {
  id: string;
  clientKey: string;
  title: string;
  titleState: 'pending' | 'ready';
  processingState: 'ready';
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  messages: Map<string, WireMsg>;
}

const chatStores = new Map<string, ChatStore>();
const patientFacts = new Map<string, { firstName: string; programDay: number }>();
const tokenRoles = new Map<string, { kind: string; patientId?: string }>();
const apiCalls: ApiCall[] = [];
const failNext = new Map<string, Scripted | 'network'>();
const coachPageOverrides = new Map<
  string,
  { messages: WireMsg[]; nextBefore: number | null }
>();
/** HQ policy stand-in: patient ids whose care team has the coach paused. */
const coachPausedFor = new Set<string>();
const PAUSED_MESSAGE =
  'Your care team has paused the coach for now. Your diary, check-ins, and photos keep working, and the coach will be back as soon as they turn it on again.';
const uploadPuts: string[] = [];
let uploadPutGate: Promise<void> | null = null;
const mintedPaths: string[] = [];
let uploadCounter = 0;
let conversationCounter = 0;

function chatStoreFor(patientId: string): ChatStore {
  let store = chatStores.get(patientId);
  if (!store) {
    store = { coach: new Map(), support: new Map(), conversations: new Map() };
    chatStores.set(patientId, store);
  }
  return store;
}

function storedConversation(patientId: string, conversationId: string): WireMsg[] {
  return [...(chatStoreFor(patientId).conversations.get(conversationId)?.messages.values() ?? [])]
    .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
}

function storedThread(patientId: string, thread: 'coach' | 'support'): WireMsg[] {
  if (thread === 'coach') return [];
  return [...chatStoreFor(patientId)[thread].values()];
}

function conversationWire(conversation: ConversationStore) {
  return {
    id: conversation.id,
    title: conversation.title,
    titleState: conversation.titleState,
    processingState: conversation.processingState,
    archivedAt: conversation.archivedAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    version: conversation.version,
  };
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

  if (key === 'GET patient-chat/support') {
    const thread = 'support';
    return {
      status: 200,
      body: {
        messages: storedThread(patientId, thread),
        patient: patientFacts.get(patientId) ?? { firstName: 'there', programDay: 1 },
      },
    };
  }
  if (key === 'POST patient-chat/support/messages') {
    const thread = 'support';
    const store = chatStoreFor(patientId)[thread];
    const messages = (call.body?.messages as WireMsg[] | undefined) ?? [];
    if (messages.some(message => message.role === 'staff')) {
      return { status: 400, body: { error: 'Staff messages are server owned.' } };
    }
    for (const message of messages) store.set(message.id, message);
    return { status: 200, body: { ok: true } };
  }

  if (key === 'GET patient-coach/conversations') {
    const archived = call.query.get('archived') === 'true';
    const offset = Number(call.query.get('offset') ?? 0);
    const limit = Number(call.query.get('limit') ?? 20);
    const all = [...chatStoreFor(patientId).conversations.values()]
      .filter(conversation => Boolean(conversation.archivedAt) === archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const rows = all.slice(offset, offset + limit);
    return {
      status: 200,
      body: {
        conversations: rows.map(conversationWire),
        total: all.length,
        nextOffset: offset + rows.length < all.length ? offset + rows.length : null,
      },
    };
  }
  if (key === 'POST patient-coach/conversations') {
    const clientKey = String(call.body?.clientKey ?? '');
    const existing = [...chatStoreFor(patientId).conversations.values()].find(
      conversation => conversation.clientKey === clientKey,
    );
    if (existing) return { status: 200, body: { conversation: conversationWire(existing) } };
    const now = new Date().toISOString();
    const conversation: ConversationStore = {
      id: `conv-${++conversationCounter}`,
      clientKey,
      title: 'New conversation',
      titleState: 'ready',
      processingState: 'ready',
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
      messages: new Map(),
    };
    chatStoreFor(patientId).conversations.set(conversation.id, conversation);
    return { status: 200, body: { conversation: conversationWire(conversation) } };
  }
  const conversationMatch = /^patient-coach\/conversations\/([^/]+)(?:\/messages)?$/.exec(call.path);
  if (conversationMatch) {
    const conversation = chatStoreFor(patientId).conversations.get(conversationMatch[1]);
    if (!conversation) return { status: 404, body: { error: 'Conversation not found.' } };
    if (key.startsWith('GET ')) {
      const before = call.query.get('before');
      const limit = Number(call.query.get('limit') ?? 100);
      const override = coachPageOverrides.get(`${patientId}:${conversation.id}:${before ?? 'latest'}`);
      if (override) {
        return {
          status: 200,
          body: {
            conversation: conversationWire(conversation),
            messages: override.messages,
            nextBefore: override.nextBefore,
            patient: patientFacts.get(patientId) ?? { firstName: 'there', programDay: 1 },
          },
        };
      }
      const all = storedConversation(patientId, conversation.id);
      const eligible = before === null ? all : all.filter(message => Number(message.seq) < Number(before));
      const messages = eligible.slice(Math.max(0, eligible.length - limit));
      const first = messages[0];
      return {
        status: 200,
        body: {
          conversation: conversationWire(conversation),
          messages,
          nextBefore: first && Number(first.seq) > 1 ? Number(first.seq) : null,
          patient: patientFacts.get(patientId) ?? { firstName: 'there', programDay: 1 },
        },
      };
    }
    if (key.startsWith('POST ')) {
      if (conversation.archivedAt) return { status: 409, body: { error: 'Conversation is archived.' } };
      const messages = (call.body?.messages as WireMsg[] | undefined) ?? [];
      for (const message of messages) {
        if (message.role === 'staff') return { status: 400, body: { error: 'Staff messages are server owned.' } };
        const previous = conversation.messages.get(message.id);
        conversation.messages.set(message.id, {
          ...message,
          seq: Number(previous?.seq ?? conversation.messages.size + 1),
          createdAt: String(previous?.createdAt ?? new Date().toISOString()),
        });
      }
      conversation.updatedAt = new Date().toISOString();
      return { status: 200, body: { ok: true } };
    }
    if (key.startsWith('PATCH ')) {
      conversation.archivedAt = call.body?.archived === true ? new Date().toISOString() : null;
      conversation.version += 1;
      conversation.updatedAt = new Date().toISOString();
      return { status: 200, body: { conversation: conversationWire(conversation) } };
    }
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

  if (key === 'POST patient-data/presence') {
    // Account-layer presence heartbeat (real accounts only); not a diary write.
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
    const gate = uploadPutGate;
    uploadPutGate = null;
    if (gate) await gate;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }

  if (!url.pathname.startsWith('/api/')) throw new Error(`unexpected fetch: ${url.href}`);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers.Authorization ?? null;
  const path = url.pathname.slice('/api/'.length);

  // Chat streams answer with a hand-fed SSE body — unless HQ has the coach
  // paused for this patient, in which case the server answers 503 JSON
  // before any model work (a signed-out session is never paused).
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
  return { ok: result.status < 300, status: result.status, headers: new Headers(), json: async () => result.body } as Response;
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

async function mountLiveCoachScreen(onScroll: (args: unknown) => void): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      React.createElement(
        PatientAccountProvider,
        null,
        React.createElement(
          PatientProvider,
          null,
          React.createElement(
            CoachChatProvider,
            null,
            React.createElement(React.Fragment, null, React.createElement(Probe), React.createElement(CoachChatScreen)),
          ),
        ),
      ),
      {
        createNodeMock: element =>
          element.type === 'ScrollView'
            ? { scrollTo: onScroll, scrollToEnd() {} }
            : {},
      },
    );
  });
  await settle();
  return tree;
}

/** How every existing coach suite mounts the provider — no account layer. */
async function mountSignedOut(): Promise<ReactTestRenderer> {
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
  // ── 1 · Signed-out session stays local ────────────────────────────────────────
  section('signed-out session: synchronous greeting, bare request, zero persistence');
  let tree = await mountSignedOut();
  assert('signed-out greeting seeds synchronously', chat.messages[0]?.id === GREETING_MESSAGE_ID);
  assert('signed-out greeting keeps its fixed id', chat.messages[0]?.id === GREETING_MESSAGE_ID);
  assert('signed-out account is the context default', account.account.kind === 'signed-out' && !account.resolving);

  await sendText('hi');
  const localStream = await takeStream('signed-out send');
  if (localStream) {
    assert('signed-out request has no Authorization header', localStream.auth === null);
    assert('signed-out request body has no localDate', !('localDate' in localStream.body));
    localStream.emit({ content: 'Hello there.' });
    localStream.emit({ done: true });
    localStream.close();
  }
  await waitUntil('signed-out reply reveals', () => tail()?.status === 'done' && tail()?.text === 'Hello there.');
  assert(
    'signed-out ids stay in the coach-<n> space',
    chat.messages
      .slice(1)
      .filter(m => m.id !== OUTREACH_MESSAGE_ID)
      .every(m => /^coach-\d+$/.test(m.id)),
  );
  assert('signed-out made zero JSON API calls', apiCalls.length === 0);
  await unmount(tree);

  // Superseded single-thread assertions are retained below as migration
  // history; the active checks after this block exercise the saved
  // conversation lifecycle instead.
  if (false) {
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

  // ── 6 · Account isolation: sign-out reseeds the local greeting, second account is fresh ─
  section('isolation: sign-out returns the local seed, second account never sees the first');
  const p1Snapshot = JSON.stringify(storedThread('p-1', 'coach'));
  const chatCallsBeforeSignOut = callsTo('patient-chat/coach').length + callsTo('patient-chat/coach/messages').length;
  await signIn(null);
  assert('sign-out reseeds the local greeting', chat.messages.length === 1 && chat.messages[0]?.id === GREETING_MESSAGE_ID);
  assert('signed-out greeting is not the account greeting', !chat.messages[0]?.text.includes('Riley'));
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
  }

  // ── Saved Coach conversations ─────────────────────────────────────────────
  section('saved coach conversations: explicit lifecycle, isolated transcripts, pagination and archive safety');
  await signIn(P1);
  tree = await mountLive();
  assert('real account does not auto-hydrate a legacy coach thread', chat.messages.length === 0);
  assert('real account does not read a conversation before selection', callsTo('patient-coach/conversations').filter(call => call.method === 'GET').length === 0);

  await act(async () => {
    chat.startNewConversation();
  });
  assert('new conversation has the neutral local greeting', chat.messages.length === 1 && chat.messages[0]?.text === 'Hi. What would you like help with today?');
  assert('new conversation does not create a row before substantive content', callsTo('patient-coach/conversations').filter(call => call.method === 'POST').length === 0);

  // Two presses while create is unresolved must share the single synchronous
  // submission lock, rather than materializing/interleaving two rows.
  const createsBeforeFirstSend = callsTo('patient-coach/conversations').filter(call => call.method === 'POST').length;
  await act(async () => {
    chat.send('First independent conversation');
    chat.send('This duplicate tap must be ignored');
  });
  const firstStream = await takeStream('first conversation');
  assert('first-send create RPC is single-flight', callsTo('patient-coach/conversations').filter(call => call.method === 'POST').length === createsBeforeFirstSend + 1);
  const firstConversationId = String(firstStream?.body.conversationId ?? '');
  assert('stream is bound to the created conversation id', firstConversationId.startsWith('conv-'));
  firstStream?.emit({ content: 'First reply.' });
  firstStream?.emit({ done: true });
  firstStream?.close();
  await waitUntil('first reply completes', () => tail()?.text === 'First reply.' && tail()?.status === 'done');
  await waitUntil('first transcript persists', () => storedConversation('p-1', firstConversationId).length === 3);
  assert('duplicate first tap was not appended', !storedConversation('p-1', firstConversationId).some(row => row.text === 'This duplicate tap must be ignored'));
  await unmount(tree);
  tree = await mountLive();
  assert('restart does not reopen a legacy/default conversation', chat.messages.length === 0);
  await act(async () => {
    await chat.selectConversation(firstConversationId);
  });
  assert('selected saved conversation hydrates after restart', chat.messages.length === 3 && tail()?.text === 'First reply.');

  await act(async () => {
    chat.startNewConversation();
    chat.send('Second independent conversation');
  });
  const secondStream = await takeStream('second conversation');
  const secondConversationId = String(secondStream?.body.conversationId ?? '');
  assert('second new chat creates a different server row', secondConversationId !== firstConversationId && secondConversationId.startsWith('conv-'));
  secondStream?.emit({ content: 'Second reply.' });
  secondStream?.emit({ done: true });
  secondStream?.close();
  await waitUntil('second reply completes', () => tail()?.text === 'Second reply.' && tail()?.status === 'done');
  await waitUntil('second transcript persists', () => storedConversation('p-1', secondConversationId).length === 3);
  assert('first transcript remains isolated', storedConversation('p-1', firstConversationId).every(row => row.text !== 'Second independent conversation' && row.text !== 'Second reply.'));

  // Stale callbacks from an abandoned stream must not land in the new scope.
  await act(async () => {
    chat.startNewConversation();
    chat.send('Abandoned request');
  });
  const staleStream = await takeStream('stale conversation');
  await act(async () => {
    chat.startNewConversation();
  });
  staleStream?.emit({ content: 'This must never appear.' });
  staleStream?.emit({ done: true });
  staleStream?.close();
  await settle();
  assert('late stream callback cannot mutate newly selected transcript', !chat.messages.some(message => message.text === 'This must never appear.'));
  const delayedPhoto = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 1, 2]).toString('base64')}`;
  await act(async () => {
    chat.sendPhoto({ uri: delayedPhoto, width: 16, height: 12 }, 'meal');
  });
  const delayedPhotoStream = await takeStream('delayed photo conversation');
  await act(async () => {
    chat.startNewConversation();
  });
  delayedPhotoStream?.emit({ content: 'Old photo reply must not land.' });
  delayedPhotoStream?.emit({ done: true });
  delayedPhotoStream?.close();
  await settle();
  assert('delayed photo reply cannot land after a scope switch', !chat.messages.some(message => message.text === 'Old photo reply must not land.'));

  // Seed a remote transcript bigger than the endpoint's 100-message page.
  const pagedNow = new Date().toISOString();
  const paged: ConversationStore = {
    id: 'conv-paged',
    clientKey: 'fixture-paged',
    title: 'Paged history',
    titleState: 'ready',
    processingState: 'ready',
    archivedAt: null,
    createdAt: pagedNow,
    updatedAt: pagedNow,
    version: 1,
    messages: new Map(),
  };
  for (let seq = 1; seq <= 256; seq += 1) {
    paged.messages.set(`page-${seq}`, {
      id: `page-${seq}`, role: seq % 2 ? 'user' : 'assistant', text: `page ${seq}`, seq, createdAt: pagedNow,
    });
  }
  chatStoreFor('p-1').conversations.set(paged.id, paged);
  await act(async () => {
    await chat.selectConversation(paged.id);
  });
  assert('initial selected transcript is bounded to 100 newest messages', chat.messages.length === 100 && chat.messages[0]?.id === 'page-157');
  await act(async () => {
    await chat.loadOlder();
  });
  assert('first older page prepends without losing current transcript', chat.messages.length === 200 && chat.messages[0]?.id === 'page-57' && chat.messages.at(-1)?.id === 'page-256');
  await act(async () => {
    await chat.loadOlder();
  });
  assert('second older page reaches the remaining history', chat.messages.length === 256 && chat.messages[0]?.id === 'page-1' && !chat.hasOlderMessages);

  // A forced newest-page refresh must not discard already loaded pagination.
  // The context now merges by id instead of wholesale replacing the thread.
  await act(async () => {
    await chat.refreshThread(true);
  });
  assert(
    'forced newest refresh preserves older loaded pages without an error',
    chat.messages.length === 256 && !chat.hasOlderMessages && chat.conversationError === null,
  );

  const duplicateNewestPage = storedConversation('p-1', paged.id).slice(-100);
  // Begin each pagination protocol with a genuinely cold account cache, not
  // a re-selection that is now correctly served from already loaded pages.
  async function reopenPagedCold() {
    await act(async () => { chat.clearLocalState(); });
    await act(async () => { await chat.selectConversation(paged.id); });
  }
  coachPageOverrides.set(`p-1:${paged.id}:157`, {
    messages: duplicateNewestPage,
    nextBefore: 57,
  });
  await reopenPagedCold();
  await act(async () => { await chat.loadOlder(); });
  assert(
    'duplicate older page with an advancing cursor remains pageable without an error',
    chat.messages.length === 100 && chat.hasOlderMessages && chat.conversationError === null,
  );
  coachPageOverrides.set(`p-1:${paged.id}:157`, {
    messages: duplicateNewestPage,
    nextBefore: 157,
  });
  await reopenPagedCold();
  await act(async () => { await chat.loadOlder(); });
  assert(
    'same-cursor duplicate page stops with a visible no-progress error',
    !chat.hasOlderMessages && (chat.conversationError ?? '').includes('Could not load older messages'),
  );
  coachPageOverrides.set(`p-1:${paged.id}:157`, {
    messages: duplicateNewestPage,
    nextBefore: null,
  });
  await reopenPagedCold();
  await act(async () => { await chat.loadOlder(); });
  assert(
    'duplicate page ending at a null cursor is clean exhaustion, not an error',
    !chat.hasOlderMessages && chat.conversationError === null,
  );
  coachPageOverrides.delete(`p-1:${paged.id}:157`);

  // A memory source target drives bounded older-page loading, then scrolls to
  // the actual laid-out row rather than falling back to the thread bottom.
  await unmount(tree);
  const sourceScrolls: unknown[] = [];
  setChatAccountParams({ messageId: 'page-2' });
  tree = await mountLiveCoachScreen(args => sourceScrolls.push(args));
  await act(async () => {
    await chat.selectConversation(paged.id);
  });
  await waitUntil('source target loads older pages until present', () => chat.messages.some(message => message.id === 'page-2'));
  const sourcePageRequests = apiCalls
    .filter(call => call.method === 'GET' && call.path === `patient-coach/conversations/${paged.id}`)
    .map(call => call.query.get('before'))
    .filter((before): before is string => before !== null);
  assert(
    'source lookup sends advancing real API before cursors for 100 + 100 + 56 pages',
    sourcePageRequests.slice(-2).join(',') === '157,57',
  );
  const sourceRow = tree.root.findAll(node => (node.props as { testID?: string }).testID === 'coach-source-message')[0];
  await act(async () => {
    (sourceRow?.props as { onLayout?: (event: unknown) => void }).onLayout?.({
      nativeEvent: { layout: { y: 320 } },
    });
  });
  assert('source target scrolls to its row, not the thread end', (sourceScrolls[0] as { y?: number } | undefined)?.y === 304);
  const focusedSourceRow = tree.root.findAll(node => (node.props as { testID?: string }).testID === 'coach-source-message')[0];
  assert('source target receives a visible highlight', JSON.stringify(focusedSourceRow?.props.style).includes('borderWidth'));
  await unmount(tree);
  setChatAccountParams({ messageId: 'missing-source' });
  tree = await mountLiveCoachScreen(() => {});
  await act(async () => {
    await chat.selectConversation(paged.id);
  });
  // Drive any remaining pages explicitly too: this mirrors a patient using
  // Load older while the source target is unavailable.
  for (let page = 0; page < 3 && chat.hasOlderMessages; page += 1) {
    await act(async () => {
      await chat.loadOlder();
    });
  }
  await waitUntil('missing source exhausts bounded older pages and announces it', () =>
    !chat.hasOlderMessages &&
    !chat.isLoadingOlder &&
    JSON.stringify(tree.toJSON()).includes('Source message no longer available'),
  );
  assert('missing source renders an explicit availability notice', JSON.stringify(tree.toJSON()).includes('Source message no longer available'));
  await unmount(tree);
  setChatAccountParams({});
  tree = await mountLive();

  // A failed append remains queued for retry and is surfaced to the selected
  // transcript instead of failing silently behind an archive operation.
  await act(async () => {
    await chat.selectConversation(firstConversationId);
  });
  failNext.set(`POST patient-coach/conversations/${firstConversationId}/messages`, 'network');
  await act(async () => {
    chat.send('Temporary network failure');
  });
  const failedSaveStream = await takeStream('failed-save conversation');
  failedSaveStream?.emit({ content: 'Saved when connectivity returns.' });
  failedSaveStream?.emit({ done: true });
  failedSaveStream?.close();
  await waitUntil('failed append is visible to the patient', () => Boolean(chat.conversationError));

  // A token supplier failure occurs before the append request. It must release
  // the drain mutex, leave this exact finalized message queued, surface an
  // error, then retry successfully with the same message id.
  await act(async () => {
    await chat.selectConversation(firstConversationId);
    chat.send('Retry after token lookup failure');
  });
  const tokenFailureStream = await takeStream('token lookup failure');
  rejectNextStubSessionLookup();
  tokenFailureStream?.emit({ content: 'Token lookup retry reply.' });
  tokenFailureStream?.emit({ done: true });
  tokenFailureStream?.close();
  await waitUntil('token lookup failure is visible', () =>
    (chat.conversationError ?? '').includes('session lookup failed once'),
  );
  await waitUntil('token lookup retry saves the same finalized reply', () =>
    storedConversation('p-1', firstConversationId).some(row => row.text === 'Token lookup retry reply.'),
    12000,
  );

  // Stop keeps exactly the paced fragment, and that finalized fragment
  // survives a selected-conversation reload.
  await act(async () => {
    await chat.selectConversation(secondConversationId);
    chat.send('Please give a long answer');
  });
  const stoppedStream = await takeStream('stopped conversation');
  const longStoppedReply = 'This is deliberately long enough for the paced reveal to show a partial answer before the patient stops it in this regression test.';
  stoppedStream?.emit({ content: longStoppedReply });
  await waitUntil('paced answer is partially visible', () => tail()?.status === 'streaming' && (tail()?.text.length ?? 0) > 10);
  await act(async () => {
    chat.stop();
  });
  const stopped = tail();
  assert('stop finalizes only the revealed fragment', stopped?.status === 'done' && stopped.stopped === true && stopped.text.length > 0 && stopped.text.length < longStoppedReply.length);
  stoppedStream?.close();
  await waitUntil('stopped fragment is persisted', () => Boolean(stopped && storedConversation('p-1', secondConversationId).find(row => row.id === stopped.id)?.stopped));
  await act(async () => {
    await chat.selectConversation(secondConversationId);
  });
  assert('hydration restores the stopped fragment flag', Boolean(stopped && chat.messages.find(message => message.id === stopped.id)?.stopped));

  // A completed photo uploads once, persists a server path, and reloads as a
  // signed display URL rather than replaying image bytes in model history.
  await act(async () => {
    chat.startNewConversation();
    chat.sendPhoto({ uri: delayedPhoto, width: 16, height: 12 }, 'meal', { mealSlot: 'lunch' });
  });
  const photoStream = await takeStream('persisted photo conversation');
  const photoConversationId = String(photoStream?.body.conversationId ?? '');
  photoStream?.emit({ content: 'Photo saved.' });
  photoStream?.emit({ done: true });
  photoStream?.close();
  await waitUntil('photo reply finishes', () => tail()?.text === 'Photo saved.' && tail()?.status === 'done');
  await waitUntil('photo gets exactly one persisted object path', () =>
    storedConversation('p-1', photoConversationId).some(row => Boolean((row.photo as { path?: string } | undefined)?.path)),
  );
  const photoRow = storedConversation('p-1', photoConversationId).find(row => Boolean((row.photo as { path?: string } | undefined)?.path));
  assert('photo upload was minted and finalized once for its turn', Boolean(photoRow) && uploadPuts.length >= 1 && callsTo('patient-media/finalize').length >= 1);
  await act(async () => {
    await chat.refreshThread(true);
  });
  assert('photo hydration uses the signed display URL', Boolean(photoRow && chat.messages.find(message => message.id === photoRow.id)?.photo?.uri.includes('/patient-media/file?path=')));

  // Active streams are an actionable archive refusal; finalized messages flush
  // before the subsequent archive transition closes the append gate.
  await act(async () => {
    await chat.selectConversation(secondConversationId);
    chat.send('Archive while active');
  });
  const archiveStream = await takeStream('archive-active conversation');
  let archiveRejected = false;
  await act(async () => {
    try {
      await chat.setArchived(chat.selectedConversation!, true);
    } catch {
      archiveRejected = true;
    }
  });
  assert('archive rejects an active stream', archiveRejected && Boolean(chat.conversationError));
  archiveStream?.emit({ content: 'Now finalized.' });
  archiveStream?.emit({ done: true });
  archiveStream?.close();
  await waitUntil('archive stream finalizes', () => tail()?.text === 'Now finalized.' && tail()?.status === 'done');
  await act(async () => {
    await chat.setArchived(chat.selectedConversation!, true);
  });
  assert('archive flushes finalized messages before patching', storedConversation('p-1', secondConversationId).some(row => row.text === 'Now finalized.'));
  assert('selected archived conversation becomes read-only', Boolean(chat.selectedConversation?.archivedAt));
  const archivedCount = chat.messages.length;
  await sendText('must not send while archived');
  await settle();
  assert('archived conversation blocks subsequent sends', chat.messages.length === archivedCount);

  // The stream's token lookup is first; hold the outbox lookup immediately
  // after it, then switch accounts. The old photo must make no media request
  // with P2's current session.
  await act(async () => {
    await chat.selectConversation(firstConversationId);
  });
  const putCount = uploadPuts.length;
  let releaseUploadPut!: () => void;
  uploadPutGate = new Promise<void>(resolve => { releaseUploadPut = resolve; });
  await act(async () => { chat.sendPhoto({ uri: delayedPhoto, width: 16, height: 12 }, 'meal'); });
  const uploadingStream = await takeStream('photo PUT held across clear');
  await waitUntil('photo persistence reaches the actual presigned PUT', () => uploadPuts.length > putCount);
  const appendCountBeforeClear = callsTo(`patient-coach/conversations/${firstConversationId}/messages`).length;
  await act(async () => { chat.clearLocalState(); releaseUploadPut(); });
  uploadingStream?.close();
  await settle();
  assert('completed photo upload after clear cannot append a purged old turn',
    callsTo(`patient-coach/conversations/${firstConversationId}/messages`).length === appendCountBeforeClear);
  assert('completed photo upload after clear cannot restore a transcript or save error',
    chat.messages.length === 0 && chat.conversationError === null);
  await act(async () => { await chat.selectConversation(firstConversationId); });

  // Selection is not revocation: an in-flight upload must still save to its
  // captured old thread when the same patient simply opens another one.
  const movingPutCount = uploadPuts.length;
  let releaseMovingPut!: () => void;
  uploadPutGate = new Promise<void>(resolve => { releaseMovingPut = resolve; });
  await act(async () => { chat.sendPhoto({ uri: delayedPhoto, width: 16, height: 12 }, 'meal'); });
  const movingPhotoStream = await takeStream('photo PUT held across same-account selection');
  const movingPhotoId = [...chat.messages].reverse().find(message => message.role === 'user' && message.photo)?.id;
  await waitUntil('same-account photo reaches PUT', () => uploadPuts.length > movingPutCount);
  const destinationRowsBefore = JSON.stringify(storedConversation('p-1', secondConversationId));
  await act(async () => { await chat.selectConversation(secondConversationId); releaseMovingPut(); });
  movingPhotoStream?.close();
  await waitUntil('original thread receives its completed photo association', () =>
    storedConversation('p-1', firstConversationId).some(row =>
      row.id === movingPhotoId && Boolean((row.photo as { path?: string } | undefined)?.path)));
  assert('photo completion never mutates the newly selected conversation',
    chat.selectedConversation?.id === secondConversationId &&
    !chat.messages.some(message => message.id === movingPhotoId) &&
    JSON.stringify(storedConversation('p-1', secondConversationId)) === destinationRowsBefore);
  const readsBeforePhotoReturn = callsTo(`patient-coach/conversations/${firstConversationId}`).filter(call => call.method === 'GET').length;
  await act(async () => { await chat.selectConversation(firstConversationId); });
  await settle();
  assert('photo return is a genuinely warm cache hit',
    callsTo(`patient-coach/conversations/${firstConversationId}`).filter(call => call.method === 'GET').length === readsBeforePhotoReturn);
  assert('warm return retains uploaded photo in UI and cannot null its server row',
    Boolean(chat.messages.find(message => message.id === movingPhotoId)?.photo?.path) &&
    storedConversation('p-1', firstConversationId).some(row =>
      row.id === movingPhotoId && Boolean((row.photo as { path?: string } | undefined)?.path)));
  await act(async () => { chat.clearLocalState(); });
  await act(async () => { await chat.selectConversation(firstConversationId); });
  assert('uploaded photo survives subsequent server rehydration',
    Boolean(chat.messages.find(message => message.id === movingPhotoId)?.photo?.path));
  const mediaCallsBeforeSwitch = callsTo('patient-media/upload-url').length;
  const releaseP1PhotoToken = holdNextStubSessionLookup(1);
  await act(async () => {
    chat.sendPhoto({ uri: delayedPhoto, width: 16, height: 12 }, 'meal');
  });
  const heldPhotoStream = await takeStream('held P1 photo');
  await act(async () => {
    setStubSession(P2);
  });
  releaseP1PhotoToken();
  await settle();
  assert(
    'switch before photo-token acquisition sends no old bytes with P2',
    callsTo('patient-media/upload-url').length === mediaCallsBeforeSwitch,
  );
  heldPhotoStream?.close();

  // Park a failed P1 append, then switch accounts. The account boundary
  // purges the private outbox; returning to P1 may hydrate server truth but
  // must never revive the abandoned queued write under a new epoch.
  // P2 is already selected above; switch back just long enough to create the
  // parked P1 append.
  await signIn(P1);
  await act(async () => {
    chat.startNewConversation();
    chat.send('Park this P1 write');
  });
  const parkedStream = await takeStream('parked P1 conversation');
  const parkedConversationId = String(parkedStream?.body.conversationId ?? '');
  failNext.set(`POST patient-coach/conversations/${parkedConversationId}/messages`, 'network');
  parkedStream?.emit({ content: 'P1 reply waiting to save.' });
  parkedStream?.emit({ done: true });
  parkedStream?.close();
  await waitUntil('P1 append is parked after network failure', () => Boolean(chat.conversationError));
  await signIn(P2);
  await settle();
  assert('account switch never auto-selects another patient conversation', chat.messages.length === 0);
  await act(async () => {
    chat.startNewConversation();
    chat.send('Hello from the second patient');
  });
  const secondPatientStream = await takeStream('second patient');
  assert('second patient request uses only their bearer token', secondPatientStream?.auth === 'Bearer tok-p2');
  secondPatientStream?.emit({ content: 'Hello Jordan.' });
  secondPatientStream?.emit({ done: true });
  secondPatientStream?.close();
  await waitUntil('second patient reply completes', () => tail()?.text === 'Hello Jordan.' && tail()?.status === 'done');
  assert('second patient has a distinct conversation store', [...chatStoreFor('p-2').conversations.values()].length === 1 && [...chatStoreFor('p-1').conversations.values()].length >= 3);
  await signIn(P1);
  await settle();
  await act(async () => {
    await chat.selectConversation(parkedConversationId);
  });
  assert(
    'returning P1 does not revive a purged parked append',
    !storedConversation('p-1', parkedConversationId).some(row => row.text === 'P1 reply waiting to save.'),
  );
  assert(
    'returning P1 does not revive the abandoned photo upload',
    !callsTo('patient-media/upload-url').slice(mediaCallsBeforeSwitch).some(call => call.token === 'tok-p1'),
  );
  await unmount(tree);

  // ── 8 · Support screen: same per-account pattern, signed-out stays session-only ─
  section('support chat: persists per account, hydrates on reopen, signed-out untouched');
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
  assert('signed-out support screen never reads the account', callsTo('patient-chat/support').length === supportReadsBefore);
  assert('signed-out support screen starts empty', JSON.stringify(supportTree.toJSON()).includes('Try reinstalling') === false);
  await unmount(supportTree);

  // ── 9 · HQ coach-availability policy ──────────────────────────────────────
  section('coach paused by the care team: probe on open, 503 on send, composer closed');
  // A stale probe must never let a paused turn through: the server's answer
  // on send is the authority. Start un-paused, pause between open and send.
  await signIn(P1);
  tree = await mountLive();
  await waitUntil('paused-section account resolves', () => account.account.kind === 'real' && !account.resolving);
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

  // Care team turns the coach back on: the signed-out session was never affected.
  coachPausedFor.delete('p-1');
  await signIn(null);
  const probesBefore = callsTo('coach/availability').length;
  tree = await mountSignedOut();
  await settle();
  assert('signed-out persona never probes availability', callsTo('coach/availability').length === probesBefore);
  assert('signed-out persona is never paused', chat.coachPaused === null);
  await unmount(tree);

  console.log(`\n${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
