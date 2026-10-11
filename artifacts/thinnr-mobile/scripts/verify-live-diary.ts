/**
 * Live per-patient diary check (real-account mode).
 *
 * Renders the REAL PatientAccountProvider + PatientProvider under Node via
 * react-test-renderer (tsconfig.live-diary.json remaps native-only modules
 * to the shared onboarding-gate stubs and @/lib/supabase to a session
 * emitter) and drives them against a scripted patient-data API with a
 * per-patient in-memory server store:
 *
 *   1. The signed-out session stays local: without the account provider the diary
 *      hydrates the seeded history from the original storage key and never
 *      makes a network call. A signed-in STAFF session browses that same
 *      signed-out state (whoami kind != patient) with zero patient-data calls.
 *   2. A fresh real patient hydrates seedless and empty over the app's full
 *      diary window, and every logging path writes through the API server:
 *      add (with the recents bump riding the same request), quick add, edit,
 *      delete, undo (single and batch), copy, copy-with-extras, water,
 *      targets, favorites. The server store mirrors the on-screen diary, and
 *      a remount ("second device / reinstall") rebuilds the diary from the
 *      server alone.
 *   3. Failures are loud and safe: a failed write rolls the optimistic
 *      update back and surfaces the server's words in the sync notice; a
 *      failed hydration stays seedless behind RETRY; an unresolved account
 *      blocks writes rather than saving somewhere a future sign-in can't
 *      see; copy returns no clones (no Undo) when the server declined.
 *   4. Accounts never bleed: sign-out returns the device-local layer, a
 *      second account starts empty, each account's local layer lives under
 *      its own storage key, and server-backed slices are never persisted
 *      locally for real accounts.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:live-diary
 */
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// PatientContext persists through globalThis.localStorage when Platform.OS
// is 'web' — which the shared react-native stub pins — so Node needs a shim.
const localStorageBacking = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => localStorageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => void localStorageBacking.set(key, String(value)),
  removeItem: (key: string) => void localStorageBacking.delete(key),
};

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import {
  PatientProvider,
  usePatient,
  usePatientSync,
  usePatientSyncNotice,
  type PatientSyncNoticeValue,
  type PatientSyncValue,
} from '../context/PatientContext';
import { WRITE_QUEUE_TUNING } from '../lib/patient-write-queue';
import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { usePatientAccount, type PatientAccountState } from '../context/PatientAccountContext';
import { TODAY_KEY, shiftDateKey, type DailyTargets, type MealLogEntry } from '../data/patient-data';
import { localTodayKey } from '../lib/live-patient-entry';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';
import { emitAppStateChange } from './onboarding-gate-stubs/react-native';

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

const YESTERDAY_KEY = shiftDateKey(TODAY_KEY, -1);
const STORAGE_KEY = 'thinnr_patient_state_v1';

// ─── Scripted patient-data API + per-patient server store ───────────────────

interface ServerStore {
  entries: MealLogEntry[];
  water: Record<string, number>;
  targets: Partial<DailyTargets>;
  favorites: string[];
  recents: string[];
  checkIns: Array<Record<string, unknown>>;
}

interface ApiCall {
  method: string;
  path: string; // e.g. "patient-data/entries", "claim/whoami"
  query: URLSearchParams;
  token: string | null;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
}

type Scripted = { status: number; body: unknown };

const serverStores = new Map<string, ServerStore>();
/** access token → whoami answer */
const tokenRoles = new Map<string, { kind: string; patientId?: string }>();
const apiCalls: ApiCall[] = [];
/** one-shot failures keyed `${method} ${path}`; 'network' throws like a dead link */
const failNext = new Map<string, Scripted | 'network'>();

function storeFor(patientId: string): ServerStore {
  let store = serverStores.get(patientId);
  if (!store) {
    store = { entries: [], water: {}, targets: {}, favorites: [], recents: [], checkIns: [] };
    serverStores.set(patientId, store);
  }
  return store;
}

function callsTo(path: string): ApiCall[] {
  return apiCalls.filter(call => call.path === path);
}

function lastCallTo(path: string): ApiCall | undefined {
  return callsTo(path)[callsTo(path).length - 1];
}

function patientDataCalls(): ApiCall[] {
  return apiCalls.filter(call => call.path.startsWith('patient-data/'));
}

function routeCall(call: ApiCall): Scripted {
  const key = `${call.method} ${call.path}`;
  const fail = failNext.get(key);
  if (fail) {
    failNext.delete(key);
    if (fail === 'network') throw new TypeError('network request failed');
    return fail;
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
  const store = storeFor(role.patientId);

  if (key === 'GET patient-data/profile') {
    return {
      status: 200,
      body: {
        profile: {
          firstName: role.patientId === 'p-1' ? 'Invited' : 'Signup',
          lastName: 'Patient',
          email: 'patient@example.com',
          phone: '+15551234567',
          dateOfBirth: '1990-01-15',
          heightInches: 66,
          startingWeight: 190,
          currentWeight: 185,
          goalWeight: 150,
          timezone: 'America/New_York',
          programId: 'thinnr',
          programStartDate: '2026-08-20',
          setupComplete: true,
        },
      },
    };
  }

  if (key === 'GET patient-data/state') {
    const from = call.query.get('from');
    const to = call.query.get('to');
    const todayKey = call.query.get('today') ?? localTodayKey();
    const entries = store.entries.filter(
      e => (!from || e.dateKey >= from) && (!to || e.dateKey <= to),
    );
    return {
      status: 200,
      body: {
        entries,
        water: store.water,
        targets: store.targets,
        favorites: store.favorites,
        recents: store.recents,
        checkIns: store.checkIns,
        entry: {
          firstName: role.patientId === 'p-1' ? 'Invited' : 'Signup',
          // p-3 (the evening-in-New-York case) started a week earlier so a
          // midnight rollover moves its program day by a visible +1.
          programStartDate:
            role.patientId === 'p-1' ? '2026-08-20'
            : role.patientId === 'p-3' ? '2026-08-26'
            : todayKey,
          todayKey,
          programDay:
            role.patientId === 'p-1' ? 12
            : role.patientId === 'p-3'
              ? Math.max(1, Math.round(
                  (Date.parse(`${todayKey}T00:00:00Z`) - Date.parse('2026-08-26T00:00:00Z')) / 86_400_000,
                ))
              : 1,
        },
      },
    };
  }
  if (key === 'POST patient-data/entries') {
    const body = call.body ?? {};
    const upsert = (body.upsert as MealLogEntry[] | undefined) ?? [];
    for (const entry of upsert) {
      const index = store.entries.findIndex(e => e.id === entry.id);
      if (index >= 0) store.entries[index] = entry;
      else store.entries.push(entry);
    }
    const deleteIds = (body.deleteIds as string[] | undefined) ?? [];
    if (deleteIds.length > 0) {
      store.entries = store.entries.filter(e => !deleteIds.includes(e.id));
    }
    if (body.recents !== undefined) store.recents = body.recents as string[];
    return { status: 200, body: { ok: true } };
  }
  if (key === 'POST patient-data/check-ins') {
    const body = call.body ?? {};
    const index = store.checkIns.findIndex(c => c.dateKey === body.dateKey);
    if (index >= 0) store.checkIns[index] = body;
    else store.checkIns.push(body);
    return { status: 200, body: { ok: true } };
  }
  if (key === 'PUT patient-data/water') {
    const body = call.body ?? {};
    store.water[String(body.dateKey)] = Number(body.oz);
    return { status: 200, body: { ok: true } };
  }
  if (key === 'PUT patient-data/targets') {
    Object.assign(store.targets, call.body ?? {});
    return { status: 200, body: { ok: true } };
  }
  if (key === 'PUT patient-data/prefs') {
    const body = call.body ?? {};
    if (body.favorites !== undefined) store.favorites = body.favorites as string[];
    if (body.recents !== undefined) store.recents = body.recents as string[];
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
  if (url.origin !== 'https://thinnr.test' || !url.pathname.startsWith('/api/')) {
    throw new Error(`unexpected fetch: ${url.href}`);
  }
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers.Authorization ?? null;
  const call: ApiCall = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: url.pathname.slice('/api/'.length),
    query: url.searchParams,
    token: auth?.startsWith('Bearer ') ? auth.slice(7) : null,
    idempotencyKey: headers['Idempotency-Key'] ?? null,
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
  };
  apiCalls.push(call);
  const result = routeCall(call);
  return {
    ok: result.status < 300,
    status: result.status,
    headers: new Headers(),
    json: async () => result.body,
  } as Response;
}) as typeof fetch;

// ─── Sessions ────────────────────────────────────────────────────────────────

const P1: StubSession = { access_token: 'tok-p1', user: { id: 'user-p1' } };
const P2: StubSession = { access_token: 'tok-p2', user: { id: 'user-p2' } };
const P3: StubSession = { access_token: 'tok-p3', user: { id: 'user-p3' } };
const STAFF: StubSession = { access_token: 'tok-staff', user: { id: 'user-staff' } };

tokenRoles.set('tok-p1', { kind: 'patient', patientId: 'p-1' });
tokenRoles.set('tok-p2', { kind: 'patient', patientId: 'p-2' });
tokenRoles.set('tok-p3', { kind: 'patient', patientId: 'p-3' });
tokenRoles.set('tok-staff', { kind: 'provider' });

// ─── Probe + render helpers ──────────────────────────────────────────────────

type Ctx = ReturnType<typeof usePatient>;

let ctx!: Ctx;
let notice: PatientSyncNoticeValue | null = null;
let sync!: PatientSyncValue;
let account!: PatientAccountState;

function Probe() {
  ctx = usePatient();
  notice = usePatientSyncNotice();
  sync = usePatientSync();
  account = usePatientAccount();
  return null;
}

/** Polls (inside act) until the condition holds — queue replays ride real timers. */
async function waitFor(label: string, condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
  }
  assert(label, condition());
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
    });
  }
}

/** Full app wiring: account resolver above the patient store. */
async function mountLive(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      React.createElement(
        PatientAccountProvider,
        null,
        React.createElement(PatientProvider, null, React.createElement(Probe)),
      ),
    );
  });
  await settle();
  return tree;
}

/** How every existing suite mounts the store — no account provider at all. */
async function mountSignedOut(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(PatientProvider, null, React.createElement(Probe)));
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

function entryInput(
  name: string,
  overrides: Partial<Omit<MealLogEntry, 'id'>> = {},
): Omit<MealLogEntry, 'id'> {
  return {
    dateKey: TODAY_KEY,
    meal: 'lunch',
    kind: 'food',
    name,
    detail: '1 serving',
    quantity: 1,
    calories: 200,
    protein: 20,
    carbs: 10,
    fat: 8,
    ...overrides,
  };
}

function entryNames(): string[] {
  return ctx.allEntries.map(e => e.name);
}

function idsOf(entries: MealLogEntry[]): string[] {
  return entries.map(e => e.id).sort();
}

// ─── The walk ────────────────────────────────────────────────────────────────

async function main() {
  // ── 1 · Signed-out session stays local ─────────────────────────────────────────────
  section('signed-out session: unseeded, local, zero network');
  let tree = await mountSignedOut();
  assert('signed-out hydrates', ctx.hydrated);
  const seedCount = ctx.allEntries.length;
  const defaultTargets = { ...ctx.targets };
  assert('signed-out diary has no seeded rows', seedCount === 0);
  assert('signed-out account is the context default', account.account.kind === 'signed-out' && !account.resolving);
  await act(async () => {
    await ctx.addEntry(entryInput('Demo Marker', { meal: 'snacks', kind: 'quick' }));
  });
  assert('signed-out add lands locally', entryNames().includes('Demo Marker'));
  assert(
    'signed-out layer persists under the original key',
    (localStorageBacking.get(STORAGE_KEY) ?? '').includes('Demo Marker'),
  );
  assert('signed-out mode makes zero API calls', apiCalls.length === 0);
  await unmount(tree);

  // ── 2 · Staff session is not a patient account ─────────────────────────────
  section('staff session: whoami says not-a-patient → signed-out patient state');
  await act(async () => {
    setStubSession(STAFF);
  });
  tree = await mountLive();
  assert('staff resolves to the signed-out patient state', account.account.kind === 'signed-out' && !account.resolving);
  assert('staff sees only the local layer', ctx.allEntries.length === seedCount + 1);
  assert('staff sees the device-local layer', entryNames().includes('Demo Marker'));
  assert('whoami consulted once', callsTo('claim/whoami').length === 1);
  assert('no patient-data calls for staff', patientDataCalls().length === 0);
  await unmount(tree);
  setStubSession(null);
  apiCalls.length = 0;

  // ── 3 · Fresh real patient: seedless, empty, full-window hydration ─────────
  section('fresh real patient: empty diary, not the local layer');
  setStubSession(P1);
  tree = await mountLive();
  assert('account resolves to real p-1', account.account.kind === 'real');
  assert('real hydration completes', ctx.hydrated);
  assert('fresh account starts empty', ctx.allEntries.length === 0);
  assert('no local layer bleed', !entryNames().includes('Demo Marker'));
  assert('no seeded check-ins', ctx.checkIns.length === 0);
  assert('no seeded photos', ctx.photos.length === 0);
  assert('no seeded weight series', ctx.weightSeries.length === 0);
  assert('water starts at zero', ctx.waterFor(TODAY_KEY) === 0);
  assert('favorites start empty', ctx.favorites.length === 0);
  assert('recents start empty', ctx.recents.length === 0);
  assert('targets are the app defaults', JSON.stringify(ctx.targets) === JSON.stringify(defaultTargets));
  const stateCall = lastCallTo('patient-data/state');
  const localDay = localTodayKey();
  assert('hydration fetches the full live diary history without fixed date bounds',
    stateCall !== undefined
    && stateCall.query.get('from') === null
    && stateCall.query.get('to') === null
    && stateCall.query.get('today') === localDay);
  assert('no notice on clean hydration', notice === null);

  // ── 4 · Every logging path writes through the server ───────────────────────
  section('writes: add / quick / edit / delete / undo / copy / water / targets / favorites');

  await act(async () => {
    await ctx.addEntry(entryInput('P1 Chicken', { refId: 'fd_chicken' }));
  });
  const addCall = lastCallTo('patient-data/entries');
  const added = ctx.allEntries.find(e => e.name === 'P1 Chicken');
  assert('add lands optimistically', added !== undefined);
  assert('add posts the same row it shows', addCall !== undefined
    && Array.isArray(addCall.body?.upsert)
    && (addCall.body!.upsert as MealLogEntry[]).length === 1
    && (addCall.body!.upsert as MealLogEntry[])[0].id === added?.id);
  assert('the recents bump rides the add', Array.isArray(addCall?.body?.recents)
    && (addCall!.body!.recents as string[])[0] === 'fd_chicken');
  assert('server store has the row', storeFor('p-1').entries.some(e => e.id === added?.id));

  await act(async () => {
    await ctx.addEntry(entryInput('P1 Quick Scan', { kind: 'quick', calories: 150, protein: 5, carbs: 20, fat: 4 }));
  });
  const quickCall = lastCallTo('patient-data/entries');
  const quick = ctx.allEntries.find(e => e.name === 'P1 Quick Scan');
  assert('quick add posts without a recents bump', quickCall?.body?.recents === undefined && quick !== undefined);

  await act(async () => {
    await ctx.updateEntry(quick!.id, { meal: 'lunch', quantity: 2 });
  });
  const editCall = lastCallTo('patient-data/entries');
  const edited = ctx.allEntries.find(e => e.id === quick!.id);
  assert('edit keeps the id and rescales in place', edited !== undefined && edited.quantity === 2 && edited.calories === 300);
  assert('edit posts exactly the edited row', editCall !== undefined
    && JSON.stringify((editCall.body?.upsert as MealLogEntry[] | undefined)?.[0]) === JSON.stringify(edited));

  await act(async () => {
    await ctx.setWater(TODAY_KEY, 40);
  });
  assert('water write-through', ctx.waterFor(TODAY_KEY) === 40
    && JSON.stringify(lastCallTo('patient-data/water')?.body) === JSON.stringify({ dateKey: TODAY_KEY, oz: 40 })
    && storeFor('p-1').water[TODAY_KEY] === 40);

  await act(async () => {
    await ctx.setTargets({ calories: 1400 });
  });
  assert('targets write-through', ctx.targets.calories === 1400
    && JSON.stringify(lastCallTo('patient-data/targets')?.body) === JSON.stringify({ calories: 1400 })
    && storeFor('p-1').targets.calories === 1400);

  await act(async () => {
    await ctx.toggleFavorite('fd_chicken');
  });
  assert('favorite write-through', ctx.favorites.includes('fd_chicken')
    && JSON.stringify(lastCallTo('patient-data/prefs')?.body?.favorites) === JSON.stringify(ctx.favorites)
    && storeFor('p-1').favorites.includes('fd_chicken'));

  let clones: MealLogEntry[] = [];
  await act(async () => {
    clones = await ctx.copyEntries([added!], { dateKey: YESTERDAY_KEY });
  });
  const copyCall = lastCallTo('patient-data/entries');
  assert('copy returns fresh clones on the target day', clones.length === 1
    && clones[0].dateKey === YESTERDAY_KEY && clones[0].id !== added!.id);
  assert('copy posts the clone batch', (copyCall?.body?.upsert as MealLogEntry[] | undefined)?.length === 1
    && (copyCall?.body?.upsert as MealLogEntry[])[0].id === clones[0]?.id);

  let comboClones: MealLogEntry[] = [];
  await act(async () => {
    comboClones = await ctx.copyEntriesWithExtras(
      [added!],
      [entryInput('P1 Side Salad', { dateKey: YESTERDAY_KEY, meal: 'dinner', kind: 'recipe' })],
      { dateKey: YESTERDAY_KEY, meal: 'dinner' },
    );
  });
  assert('copy-with-extras posts one atomic batch', comboClones.length === 2
    && (lastCallTo('patient-data/entries')?.body?.upsert as MealLogEntry[] | undefined)?.length === 2);

  await act(async () => {
    await ctx.removeEntry(clones[0].id);
  });
  assert('delete posts deleteIds', JSON.stringify(lastCallTo('patient-data/entries')?.body?.deleteIds) === JSON.stringify([clones[0].id])
    && !ctx.allEntries.some(e => e.id === clones[0].id)
    && !storeFor('p-1').entries.some(e => e.id === clones[0].id));

  await act(async () => {
    await ctx.restoreEntry(clones[0]);
  });
  assert('undo restores through the server', ctx.allEntries.some(e => e.id === clones[0].id)
    && (lastCallTo('patient-data/entries')?.body?.upsert as MealLogEntry[] | undefined)?.[0]?.id === clones[0].id
    && storeFor('p-1').entries.some(e => e.id === clones[0].id));

  const comboIds = comboClones.map(e => e.id);
  await act(async () => {
    await ctx.removeEntries(comboIds);
  });
  assert('batch delete posts both ids', JSON.stringify((lastCallTo('patient-data/entries')?.body?.deleteIds as string[] | undefined)?.slice().sort()) === JSON.stringify(comboIds.slice().sort()));
  await act(async () => {
    await ctx.restoreEntries(comboClones);
  });
  assert('batch undo restores both rows', comboIds.every(id => ctx.allEntries.some(e => e.id === id))
    && (lastCallTo('patient-data/entries')?.body?.upsert as MealLogEntry[] | undefined)?.length === 2);

  assert('server store mirrors the diary exactly',
    JSON.stringify(idsOf(storeFor('p-1').entries)) === JSON.stringify(idsOf(ctx.allEntries)));
  assert('no stray notice during clean writes', notice === null);

  // Reinstall / second device: a fresh mount rebuilds everything from the server.
  await unmount(tree);
  const p1Ids = idsOf(storeFor('p-1').entries);
  tree = await mountLive();
  assert('remount rehydrates the same diary from the server',
    JSON.stringify(idsOf(ctx.allEntries)) === JSON.stringify(p1Ids));
  assert('remount rehydrates water/targets/favorites', ctx.waterFor(TODAY_KEY) === 40
    && ctx.targets.calories === 1400 && ctx.favorites.includes('fd_chicken'));
  assert('remount recents follow the account', ctx.recents[0] === 'fd_chicken');

  // ── 5 · Failed writes queue locally and replay ─────────────────────────────
  // A dead link or a 5xx no longer rolls the row back: the write stays on
  // the phone with a pending marker and the queue retries it with backoff.
  // Only a permanent rejection (4xx) parks the item for the patient to
  // retry or discard — and a discard restores the server's truth.
  section('write failures: queued locally, replayed with backoff');
  WRITE_QUEUE_TUNING.baseDelayMs = 5;
  WRITE_QUEUE_TUNING.maxDelayMs = 20;
  const beforeCount = ctx.allEntries.length;
  const entryCallsBeforeFailure = callsTo('patient-data/entries').length;
  failNext.set('POST patient-data/entries', {
    status: 502,
    body: { error: 'Couldn’t save to your diary right now. Please try again.' },
  });
  await act(async () => {
    await ctx.addEntry(entryInput('Ghost Entry'));
  });
  const ghost = ctx.allEntries.find(e => e.name === 'Ghost Entry') ?? null;
  assert('a 5xx keeps the row on the phone', ctx.allEntries.length === beforeCount + 1 && ghost !== null);
  assert('the failed row is marked pending', ghost !== null && sync.isPending(`entry:${ghost!.id}`));
  assert('the queue reports syncing, not an error notice', sync.status === 'syncing' && sync.pendingCount === 1 && notice === null);
  assert('the store has not seen it yet', !storeFor('p-1').entries.some(e => e.name === 'Ghost Entry'));
  await waitFor('the retry lands after backoff', () => storeFor('p-1').entries.some(e => e.name === 'Ghost Entry'));
  await settle();
  assert('the replay used a second POST', callsTo('patient-data/entries').length === entryCallsBeforeFailure + 2);
  const replayKeys = callsTo('patient-data/entries').slice(-2).map(call => call.idempotencyKey);
  assert('both attempts carried the same idempotency key',
    replayKeys.every(key => typeof key === 'string' && key.length > 0) && replayKeys[0] === replayKeys[1]);
  assert('once acked the row is no longer pending', ghost !== null && !sync.isPending(`entry:${ghost!.id}`));
  assert('queue drains to up to date', sync.status === 'idle' && sync.pendingCount === 0);

  failNext.set('PUT patient-data/water', 'network');
  await act(async () => {
    await ctx.setWater(TODAY_KEY, 64);
  });
  assert('a dead link keeps the new water value locally', ctx.waterFor(TODAY_KEY) === 64 && sync.isPending(`water:${TODAY_KEY}`));
  assert('network failure raises no blocking notice', notice === null);
  await waitFor('water replays after backoff', () => storeFor('p-1').water[TODAY_KEY] === 64);
  await settle();
  assert('water pending marker clears on ack', !sync.isPending(`water:${TODAY_KEY}`));

  failNext.set('POST patient-data/entries', { status: 502, body: { error: 'Nope.' } });
  let failedClones: MealLogEntry[] = [];
  await act(async () => {
    failedClones = await ctx.copyEntries([ctx.allEntries[0]], { dateKey: TODAY_KEY });
  });
  assert('a queued copy still returns its clones (Undo can arm)', failedClones.length === 1);
  await waitFor('copy replays', () => storeFor('p-1').entries.some(e => e.id === failedClones[0].id));
  await settle();

  // Permanent rejection: parked, visible, discardable — and discard restores
  // the server's version of the diary.
  failNext.set('POST patient-data/entries', { status: 422, body: { error: 'That entry is not valid.' } });
  await act(async () => {
    await ctx.addEntry(entryInput('Rejected Entry'));
  });
  await settle();
  const rejected = ctx.allEntries.find(e => e.name === 'Rejected Entry') ?? null;
  assert('a 4xx parks the item as failed', sync.status === 'attention' && sync.failedCount === 1
    && sync.items[0]?.status === 'failed' && sync.items[0]?.lastError === 'That entry is not valid.');
  assert('the parked row stays visible and pending', entryNames().includes('Rejected Entry') && sync.isPending(`entry:${rejected!.id}`));
  const entryCallsBeforeDiscard = callsTo('patient-data/entries').length;
  await act(async () => {
    await sync.discard(sync.items[0].id);
  });
  await settle();
  assert('discard drops the row — server truth wins', !entryNames().includes('Rejected Entry') && sync.items.length === 0 && sync.status === 'idle');
  assert('discard sends nothing', callsTo('patient-data/entries').length === entryCallsBeforeDiscard);

  // Retry from the sheet: the parked item goes back to the front and lands.
  failNext.set('POST patient-data/entries', { status: 422, body: { error: 'Try later.' } });
  await act(async () => {
    await ctx.addEntry(entryInput('Retried Entry'));
  });
  await settle();
  const retried = ctx.allEntries.find(e => e.name === 'Retried Entry') ?? null;
  assert('second permanent failure parks too', sync.failedCount === 1);
  await act(async () => {
    sync.retry(sync.items[0].id);
  });
  await waitFor('retry lands the parked write', () => storeFor('p-1').entries.some(e => e.id === retried!.id));
  await settle();
  assert('retry clears the parked item', sync.items.length === 0 && !sync.isPending(`entry:${retried!.id}`));
  await unmount(tree);

  // ── 6 · Failed hydration ───────────────────────────────────────────────────
  // 6a · With a cached snapshot from the last good sync the diary still opens
  //      (read-only view of the last sync) and writes queue.
  section('hydration failure with a cached snapshot: last synced diary, writes queue');
  failNext.set('GET patient-data/state', { status: 502, body: { error: 'Couldn’t load your diary right now. Please try again.' } });
  tree = await mountLive();
  const cachedIds = idsOf(storeFor('p-1').entries);
  assert('cached hydration settles with the last synced diary', ctx.hydrated
    && JSON.stringify(idsOf(ctx.allEntries)) === JSON.stringify(cachedIds));
  assert('cached hydration explains itself with RETRY',
    notice?.message === 'Showing your last synced diary. Retry to refresh.' && notice?.actionLabel === 'RETRY');
  await act(async () => {
    notice!.onAction();
  });
  await settle();
  assert('retry refreshes from the server and clears the notice', notice === null
    && JSON.stringify(idsOf(ctx.allEntries)) === JSON.stringify(cachedIds));
  await unmount(tree);

  // A write while on the cached diary: the queue refreshes live truth
  // BEFORE replaying (so a stale snapshot can never resurrect a server
  // deletion), which also clears the cached-diary notice on its own.
  failNext.set('GET patient-data/state', { status: 502, body: { error: 'Couldn’t load your diary right now. Please try again.' } });
  tree = await mountLive();
  assert('cached diary again', notice?.message === 'Showing your last synced diary. Retry to refresh.');
  const stateCallsBeforeCachedWrite = callsTo('patient-data/state').length;
  await act(async () => {
    await ctx.addEntry(entryInput('Cached Write'));
  });
  await waitFor('a write during cached mode still syncs', () => storeFor('p-1').entries.some(e => e.name === 'Cached Write'));
  await settle();
  assert('the queue refreshed server truth before replaying', callsTo('patient-data/state').length > stateCallsBeforeCachedWrite);
  assert('the refresh clears the cached-diary notice and keeps the write', notice === null
    && entryNames().includes('Cached Write'));
  await unmount(tree);

  // 6b · Fresh install (no snapshot): seedless behind RETRY, every write blocked.
  section('hydration failure without a cache: seedless behind RETRY');
  localStorageBacking.delete(`${STORAGE_KEY}:snapshot_p-1`);
  const p1IdsAfterCached = idsOf(storeFor('p-1').entries);
  failNext.set('GET patient-data/state', {
    status: 502,
    body: { error: 'Couldn’t load your diary right now. Please try again.' },
  });
  tree = await mountLive();
  assert('failed hydration still settles', ctx.hydrated);
  assert('failed hydration shows an empty diary, not a seed', ctx.allEntries.length === 0);
  assert('hydration notice carries the server’s words with RETRY',
    notice?.message === 'Couldn’t load your diary right now. Please try again.' && notice?.actionLabel === 'RETRY');

  // Server truth never arrived: EVERY write must be blocked. A mutation run
  // now would be computed from empty local state — a favorites toggle would
  // replace the account's whole server list with a single id.
  const entryCallsWhileBlocked = callsTo('patient-data/entries').length;
  const prefCallsWhileBlocked = callsTo('patient-data/prefs').length;
  const favoritesOnServer = JSON.stringify(storeFor('p-1').favorites);
  await act(async () => {
    await ctx.addEntry(entryInput('Ghost Entry'));
  });
  assert('entry write after failed hydration is blocked, not sent',
    !entryNames().includes('Ghost Entry')
    && callsTo('patient-data/entries').length === entryCallsWhileBlocked);
  assert('blocked diary write explains itself with RETRY',
    notice?.message === 'Your diary isn’t loaded yet. Retry loading before saving.'
    && notice?.actionLabel === 'RETRY');
  await act(async () => {
    await ctx.toggleFavorite('fd_oats');
  });
  assert('prefs write after failed hydration cannot clobber the server list',
    JSON.stringify(storeFor('p-1').favorites) === favoritesOnServer
    && callsTo('patient-data/prefs').length === prefCallsWhileBlocked
    && ctx.favorites.length === 0);

  await act(async () => {
    notice!.onAction();
  });
  await settle();
  assert('retry hydrates the real diary', JSON.stringify(idsOf(ctx.allEntries)) === JSON.stringify(p1IdsAfterCached));
  assert('retry clears the notice', notice === null);
  await unmount(tree);

  // ── 7 · Unresolved account: blocked writes behind retry ────────────────────
  section('unresolved account: seedless, write-blocked, recoverable');
  // A dead lookup for a user this device has resolved before reuses the
  // last-known role (offline cold start keeps the real diary reachable)...
  failNext.set('GET claim/whoami', 'network');
  tree = await mountLive();
  assert('a dead lookup falls back to the last-known role for the same user',
    account.account.kind === 'real' && account.account.patientId === 'p-1' && notice === null
    && JSON.stringify(idsOf(ctx.allEntries)) === JSON.stringify(p1IdsAfterCached));
  await unmount(tree);
  // ...while a user with no remembered role stays unresolved and write-blocked.
  localStorageBacking.delete('thinnr_account_role_v1');
  failNext.set('GET claim/whoami', 'network');
  tree = await mountLive();
  assert('account is unresolved after a dead lookup', account.account.kind === 'unresolved');
  assert('unresolved shows the account notice with RETRY',
    notice?.message === 'Couldn’t load your account. Retry in a moment.' && notice?.actionLabel === 'RETRY');
  assert('unresolved diary is seedless', ctx.allEntries.length === 0);
  const writesBefore = callsTo('patient-data/entries').length;
  await act(async () => {
    await ctx.addEntry(entryInput('Blocked Entry'));
  });
  assert('unresolved write is blocked, not saved locally',
    !entryNames().includes('Blocked Entry') && callsTo('patient-data/entries').length === writesBefore);
  assert('blocked write explains itself', notice?.message === 'Your account isn’t loaded yet. Retry loading before saving.');
  await act(async () => {
    notice!.onAction(); // retry-account
  });
  await settle();
  assert('retry resolves the account and hydrates', account.account.kind === 'real'
    && JSON.stringify(idsOf(ctx.allEntries)) === JSON.stringify(p1IdsAfterCached));
  await act(async () => {
    await ctx.addEntry(entryInput('P1 After Retry'));
  });
  assert('writes flow again after the retry', storeFor('p-1').entries.some(e => e.name === 'P1 After Retry'));
  const p1IdsFinal = idsOf(storeFor('p-1').entries);

  // ── 8 · Sign-out and account switching never bleed ─────────────────────────
  section('sign-out / switch: signed-out returns, accounts stay walled off');
  await signIn(null);
  assert('sign-out returns to the signed-out account', account.account.kind === 'signed-out');
  assert('sign-out restores the device-local diary', ctx.allEntries.length === seedCount + 1
    && entryNames().includes('Demo Marker'));
  assert('no real-account rows leak into the local diary', !entryNames().some(name => name.startsWith('P1 ')));

  await signIn(P2);
  assert('second account resolves', account.account.kind === 'real');
  assert('second account starts empty — nothing from p-1 or the local layer', ctx.allEntries.length === 0);
  await act(async () => {
    await ctx.addEntry(entryInput('P2 Oats', { refId: 'fd_oats' }));
  });
  assert('p-2 write lands in the p-2 store only',
    storeFor('p-2').entries.some(e => e.name === 'P2 Oats')
    && !storeFor('p-1').entries.some(e => e.name === 'P2 Oats'));
  assert('p-1 server data is untouched by the switch',
    JSON.stringify(idsOf(storeFor('p-1').entries)) === JSON.stringify(p1IdsFinal));

  const acct1Raw = localStorageBacking.get(`${STORAGE_KEY}:acct_p-1`);
  const acct2Raw = localStorageBacking.get(`${STORAGE_KEY}:acct_p-2`);
  assert('each real account keeps its own storage key', acct1Raw !== undefined && acct2Raw !== undefined);
  assert('server-backed slices are never persisted locally for real accounts',
    [acct1Raw, acct2Raw].every(raw => {
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { addedEntries?: unknown[]; waterOverrides?: Record<string, number> };
      return (parsed.addedEntries ?? []).length === 0
        && Object.keys(parsed.waterOverrides ?? {}).length === 0;
    }));
  assert('the local layer never absorbed account rows',
    !(localStorageBacking.get(STORAGE_KEY) ?? '').includes('P1 ')
    && !(localStorageBacking.get(STORAGE_KEY) ?? '').includes('P2 '));

  await signIn(null);
  await unmount(tree);
  setStubSession(null);

  // ── 9 · Evening in New York: 9:33 PM Sept 1 is still Sept 1 ────────────────
  section('evening in New York: local day everywhere, rollover at local midnight');
  const RealDate = Date;
  const priorTZ = process.env.TZ;
  process.env.TZ = 'America/New_York';
  // 2026-09-02T01:33Z is 9:33 PM on Sept 1 in New York — past the 8 PM
  // boundary where a UTC-derived "today" already reads tomorrow.
  let frozenNow = RealDate.parse('2026-09-02T01:33:00Z');
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(frozenNow);
      else super(...(args as [string | number | Date]));
    }
    static now(): number {
      return frozenNow;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
  try {
    assert('device-local day is Sept 1 at 9:33 PM New York', localTodayKey() === '2026-09-01');
    setStubSession(P3);
    tree = await mountLive();
    assert('evening account resolves', account.account.kind === 'real' && ctx.hydrated);
    const eveningState = lastCallTo('patient-data/state');
    assert('hydration asks the server for the LOCAL day, not the UTC day',
      eveningState !== undefined && eveningState.query.get('today') === '2026-09-01');
    assert('the provider live day is Sept 1', ctx.todayKey === '2026-09-01');
    assert('entry facts ride the local day', ctx.entryFacts?.todayKey === '2026-09-01');

    await act(async () => {
      await ctx.addEntry(entryInput('Evening Snack', { dateKey: ctx.todayKey, meal: 'snacks' }));
    });
    assert('an evening food log lands on Sept 1 on the server',
      storeFor('p-3').entries.some(e => e.name === 'Evening Snack' && e.dateKey === '2026-09-01'));
    await act(async () => {
      await ctx.setWater(ctx.todayKey, 24);
    });
    assert('evening water lands on Sept 1 on the server', storeFor('p-3').water['2026-09-01'] === 24);
    assert('evening water reads back on Sept 1', ctx.waterFor('2026-09-01') === 24);
    await act(async () => {
      await ctx.addCheckIn({ dateKey: ctx.todayKey, mood: 4, sideEffects: [] });
    });
    assert('an evening check-in lands on Sept 1 on the server',
      storeFor('p-3').checkIns.some(c => c.dateKey === '2026-09-01'));
    assert('nothing was written to the UTC day or the fixed anchor',
      !storeFor('p-3').entries.some(e => e.dateKey !== '2026-09-01')
      && storeFor('p-3').water['2026-09-02'] === undefined
      && storeFor('p-3').water[TODAY_KEY] === undefined);

    // Left open past local midnight: foregrounding recomputes the day.
    const dayBeforeRollover = ctx.entryFacts?.programDay ?? 0;
    frozenNow = RealDate.parse('2026-09-02T04:05:00Z'); // 12:05 AM Sept 2 in NY
    await act(async () => {
      emitAppStateChange('active');
    });
    await settle();
    assert('after local midnight the live day rolls to Sept 2', ctx.todayKey === '2026-09-02');
    assert('entry facts follow the rollover', ctx.entryFacts?.todayKey === '2026-09-02');
    assert('the program day advances with the local day',
      (ctx.entryFacts?.programDay ?? 0) === dayBeforeRollover + 1);
    assert('rollover reads, never writes: Sept 2 has no invented rows',
      !storeFor('p-3').entries.some(e => e.dateKey === '2026-09-02')
      && storeFor('p-3').water['2026-09-02'] === undefined);

    await signIn(null);
    await unmount(tree);
    setStubSession(null);
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
    if (priorTZ === undefined) delete process.env.TZ;
    else process.env.TZ = priorTZ;
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) {
    process.exitCode = 1;
  } else {
    console.log('live-diary: all good');
  }
}

main().catch(error => {
  console.error('suite crashed:', error);
  process.exitCode = 1;
});
