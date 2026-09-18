/**
 * App-presence heartbeat (task check).
 *
 * Renders the REAL PatientAccountProvider under Node (tsconfig.presence-
 * heartbeat.json remaps native modules to the shared stubs and @/lib/supabase
 * to a session emitter) and proves the heartbeat contract:
 *
 *   1. Demo (signed out), staff browsing the persona ('other' role) and
 *      unresolved accounts never POST /patient-data/presence.
 *   2. A real patient pings exactly once when the account resolves, with the
 *      platform hint header and that session's bearer.
 *   3. Returning to the foreground pings again, debounced: rapid
 *      background/foreground bounces inside the window send nothing more.
 *   4. Switching accounts drops the old heartbeat and starts a fresh one
 *      under the new bearer; signing out stops it entirely.
 *   5. A failing heartbeat never surfaces (no throw, account stays real),
 *      and a ping whose account was torn down mid-lookup is dropped.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:presence-heartbeat
 */
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { usePatientAccount, type PatientAccountState } from '../context/PatientAccountContext';
import { createHeartbeat, HEARTBEAT_DEBOUNCE_MS } from '../lib/patient-presence-heartbeat';
import { emitAppStateChange } from './onboarding-gate-stubs/react-native';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';

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

// ─── Scripted API ────────────────────────────────────────────────────────────

interface ApiCall {
  method: string;
  path: string;
  token: string | null;
  headers: Record<string, string>;
}
const apiCalls: ApiCall[] = [];
const tokenRoles = new Map<string, { kind: 'patient'; patientId: string } | { kind: 'other' }>();
let whoamiFails = false;
let presenceStatus = 200;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers.Authorization ?? null;
  const call: ApiCall = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: url.pathname.slice('/api/'.length),
    token: auth?.startsWith('Bearer ') ? auth.slice(7) : null,
    headers,
  };
  apiCalls.push(call);
  const respond = (status: number, body: unknown) =>
    ({ ok: status < 300, status, json: async () => body }) as Response;
  if (call.path === 'claim/whoami') {
    if (whoamiFails) throw new Error('offline');
    const role = call.token ? tokenRoles.get(call.token) : undefined;
    if (!role) return respond(401, { error: 'Sign in required.' });
    return respond(200, role);
  }
  if (call.path === 'patient-data/presence' && call.method === 'POST') {
    return respond(presenceStatus, presenceStatus < 300 ? { ok: true } : { error: 'nope' });
  }
  throw new Error(`unscripted route: ${call.method} ${call.path}`);
}) as typeof fetch;

const presenceCalls = () => apiCalls.filter(call => call.path === 'patient-data/presence');

const P1: StubSession = { access_token: 'tok-p1', user: { id: 'user-p1' } };
const P2: StubSession = { access_token: 'tok-p2', user: { id: 'user-p2' } };
const STAFF: StubSession = { access_token: 'tok-staff', user: { id: 'user-staff' } };
tokenRoles.set('tok-p1', { kind: 'patient', patientId: 'p-1' });
tokenRoles.set('tok-p2', { kind: 'patient', patientId: 'p-2' });
tokenRoles.set('tok-staff', { kind: 'other' });

// ─── Harness ─────────────────────────────────────────────────────────────────

let account!: PatientAccountState;
function Probe() {
  account = usePatientAccount();
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
    });
  }
}

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(PatientAccountProvider, null, React.createElement(Probe)));
  });
  await settle();
  return tree;
}

async function signIn(session: StubSession | null) {
  await act(async () => {
    setStubSession(session);
  });
  await settle();
}

async function foreground() {
  await act(async () => {
    emitAppStateChange('background');
    emitAppStateChange('active');
  });
  await settle();
}

// ─── Suite ───────────────────────────────────────────────────────────────────

async function main() {
  section('demo, staff and unresolved accounts never ping');
  setStubSession(null);
  let tree = await mount();
  assert('signed out → demo', account.account.kind === 'demo');
  await foreground();
  assert('demo: zero presence calls', presenceCalls().length === 0);
  await signIn(STAFF);
  assert('staff browses the demo persona', account.account.kind === 'demo');
  await foreground();
  assert('staff: zero presence calls', presenceCalls().length === 0);
  whoamiFails = true;
  await signIn(P2);
  assert('lookup failure → unresolved', account.account.kind === 'unresolved');
  await foreground();
  assert('unresolved: zero presence calls', presenceCalls().length === 0);
  whoamiFails = false;
  await signIn(null);
  tree.unmount();
  apiCalls.length = 0;

  section('a real patient pings once on resolve, with bearer and platform hint');
  setStubSession(P1);
  tree = await mount();
  assert('real account resolved', account.account.kind === 'real');
  const first = presenceCalls();
  assert('exactly one heartbeat after resolve', first.length === 1);
  assert('heartbeat carries the session bearer', first[0]?.token === 'tok-p1');
  assert('heartbeat declares its platform', first[0]?.headers['x-thinnr-platform'] === 'web');
  assert('heartbeat has no body', first[0]?.headers['Content-Type'] === undefined);
  await settle();
  assert('no duplicate ping while settled', presenceCalls().length === 1);

  section('foreground pings are debounced');
  await foreground();
  assert('a bounce inside the debounce window sends nothing', presenceCalls().length === 1);
  const realNow = Date.now;
  Date.now = () => realNow() + HEARTBEAT_DEBOUNCE_MS + 1;
  try {
    await foreground();
    assert('a foreground after the window pings again', presenceCalls().length === 2);
    await foreground();
    assert('the next bounce inside the new window is skipped', presenceCalls().length === 2);
  } finally {
    Date.now = realNow;
  }

  section('account switch restarts under the new bearer; sign-out stops it');
  await signIn(P2);
  assert('switched to the second patient', account.account.kind === 'real' && account.account.patientId === 'p-2');
  const afterSwitch = presenceCalls();
  assert('one fresh ping for the new account', afterSwitch.length === 3);
  assert('new ping rides the new bearer', afterSwitch[2]?.token === 'tok-p2');
  await signIn(null);
  assert('signed out → demo', account.account.kind === 'demo');
  Date.now = () => realNow() + 10 * HEARTBEAT_DEBOUNCE_MS;
  try {
    await foreground();
    assert('no ping after sign-out', presenceCalls().length === 3);
  } finally {
    Date.now = realNow;
  }

  section('failures are silent');
  presenceStatus = 502;
  await signIn(P1);
  assert('account stays real when the heartbeat fails', account.account.kind === 'real');
  assert('failed heartbeat was attempted once', presenceCalls().length === 4);
  presenceStatus = 200;
  await signIn(null);
  tree.unmount();

  section('a ping torn down mid-lookup is dropped (epoch fence)');
  let releaseToken!: (token: string | null) => void;
  const held = new Promise<string | null>(resolve => {
    releaseToken = resolve;
  });
  const sent: string[] = [];
  const heartbeat = createHeartbeat({ getAccessToken: () => held, send: async token => void sent.push(token) });
  const pending = heartbeat.ping(true);
  heartbeat.cancel();
  releaseToken('tok-stale');
  await pending;
  assert('cancelled heartbeat never sends', sent.length === 0);
  const live = createHeartbeat({ getAccessToken: async () => 'tok-live', send: async token => void sent.push(token) });
  await live.ping(true);
  await live.ping(false);
  assert('live heartbeat sends once and debounces', sent.length === 1 && sent[0] === 'tok-live');
  const noSession = createHeartbeat({ getAccessToken: async () => null, send: async token => void sent.push(token) });
  await noSession.ping(true);
  assert('no bearer → nothing sent', sent.length === 1);
  const failing = createHeartbeat({ getAccessToken: async () => 'tok', send: async () => { throw new Error('down'); } });
  let threw = false;
  try {
    await failing.ping(true);
  } catch {
    threw = true;
  }
  assert('a rejected send never throws out of ping', !threw);

  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
