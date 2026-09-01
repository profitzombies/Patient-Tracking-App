/**
 * Live per-patient diary check (real-account mode).
 *
 * Renders the REAL PatientAccountProvider + PatientProvider under Node via
 * react-test-renderer (tsconfig.live-diary.json remaps native-only modules
 * to the shared onboarding-gate stubs and @/lib/supabase to a session
 * emitter) and drives them against a scripted patient-data API with a
 * per-patient in-memory server store:
 *
 *   1. The demo persona is untouched: without the account provider the diary
 *      hydrates the seeded history from the original storage key and never
 *      makes a network call. A signed-in STAFF session browses that same
 *      demo persona (whoami kind != patient) with zero patient-data calls.
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
 *   4. Accounts never bleed: sign-out returns the seeded demo layer, a
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

import { PatientProvider, usePatient, usePatientSyncNotice, type PatientSyncNoticeValue } from '../context/PatientContext';
import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { usePatientAccount, type PatientAccountState } from '../context/PatientAccountContext';
import { TODAY_KEY, shiftDateKey, type DailyTargets, type MealLogEntry } from '../data/patient-data';
import { localTodayKey } from '../lib/live-patient-entry';
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

const YESTERDAY_KEY = shiftDateKey(TODAY_KEY, -1);
const STORAGE_KEY = 'thinnr_patient_state_v1';

// ─── Scripted patient-data API + per-patient server store ───────────────────

interface ServerStore {
  entries: MealLogEntry[];
  water: Record<string, number>;
  targets: Partial<DailyTargets>;
  favorites: string[];
  recents: string[];
}

interface ApiCall {
  method: string;
  path: string; // e.g. "patient-data/entries", "claim/whoami"
  query: URLSearchParams;
  token: string | null;
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
    store = { entries: [], water: {}, targets: {}, favorites: [], recents: [] };
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
        entry: {
          firstName: role.patientId === 'p-1' ? 'Invited' : 'Signup',
          programStartDate: role.patientId === 'p-1' ? '2026-08-20' : todayKey,
          todayKey,
          programDay: role.patientId === 'p-1' ? 12 : 1,
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
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
  };
  apiCalls.push(call);
  const result = routeCall(call);
  return {
    ok: result.status < 300,
    status: result.status,
    json: async () => result.body,
  } as Response;
}) as typeof fetch;

// ─── Sessions ────────────────────────────────────────────────────────────────

const P1: StubSession = { access_token: 'tok-p1', user: { id: 'user-p1' } };
const P2: StubSession = { access_token: 'tok-p2', user: { id: 'user-p2' } };
const STAFF: StubSession = { access_token: 'tok-staff', user: { id: 'user-staff' } };

tokenRoles.set('tok-p1', { kind: 'patient', patientId: 'p-1' });
tokenRoles.set('tok-p2', { kind: 'patient', patientId: 'p-2' });
tokenRoles.set('tok-staff', { kind: 'provider' });

// ─── Probe + render helpers ──────────────────────────────────────────────────

type Ctx = ReturnType<typeof usePatient>;

let ctx!: Ctx;
let notice: PatientSyncNoticeValue | null = null;
let account!: PatientAccountState;

function Probe() {
  ctx = usePatient();
  notice = usePatientSyncNotice();
  account = usePatientAccount();
  return null;
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
async function mountDemo(): Promise<ReactTestRenderer> {
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
  // ── 1 · Demo persona untouched ─────────────────────────────────────────────
  section('demo persona: seeded, local, zero network');
  let tree = await mountDemo();
  assert('demo hydrates', ctx.hydrated);
  const seedCount = ctx.allEntries.length;
  const demoTargets = { ...ctx.targets };
  assert('demo diary is seeded', seedCount > 0);
  assert('demo account is the context default', account.account.kind === 'demo' && !account.resolving);
  await act(async () => {
    await ctx.addEntry(entryInput('Demo Marker', { meal: 'snacks', kind: 'quick' }));
  });
  assert('demo add lands locally', entryNames().includes('Demo Marker'));
  assert(
    'demo layer persists under the original key',
    (localStorageBacking.get(STORAGE_KEY) ?? '').includes('Demo Marker'),
  );
  assert('demo mode makes zero API calls', apiCalls.length === 0);
  await unmount(tree);

  // ── 2 · Staff session browses the demo persona ─────────────────────────────
  section('staff session: whoami says not-a-patient → demo persona');
  await act(async () => {
    setStubSession(STAFF);
  });
  tree = await mountLive();
  assert('staff resolves to the demo account', account.account.kind === 'demo' && !account.resolving);
  assert('staff sees the seeded demo diary', ctx.allEntries.length === seedCount + 1);
  assert('staff sees the device demo layer', entryNames().includes('Demo Marker'));
  assert('whoami consulted once', callsTo('claim/whoami').length === 1);
  assert('no patient-data calls for staff', patientDataCalls().length === 0);
  await unmount(tree);
  setStubSession(null);
  apiCalls.length = 0;

  // ── 3 · Fresh real patient: seedless, empty, full-window hydration ─────────
  section('fresh real patient: empty diary, not the demo history');
  setStubSession(P1);
  tree = await mountLive();
  assert('account resolves to real p-1', account.account.kind === 'real');
  assert('real hydration completes', ctx.hydrated);
  assert('fresh account starts empty', ctx.allEntries.length === 0);
  assert('no demo layer bleed', !entryNames().includes('Demo Marker'));
  assert('no seeded check-ins', ctx.checkIns.length === 0);
  assert('no seeded photos', ctx.photos.length === 0);
  assert('no seeded weight series', ctx.weightSeries.length === 0);
  assert('water starts at zero', ctx.waterFor(TODAY_KEY) === 0);
  assert('favorites start empty', ctx.favorites.length === 0);
  assert('recents start empty', ctx.recents.length === 0);
  assert('targets are the app defaults', JSON.stringify(ctx.targets) === JSON.stringify(demoTargets));
  const stateCall = lastCallTo('patient-data/state');
  const localDay = localTodayKey();
  assert('hydration fetches the full live diary history without demo date bounds',
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

  // ── 5 · Failed writes roll back with the server's words ────────────────────
  section('write failures: rollback + visible notice');
  const beforeCount = ctx.allEntries.length;
  failNext.set('POST patient-data/entries', {
    status: 502,
    body: { error: 'Couldn’t save to your diary right now. Please try again.' },
  });
  await act(async () => {
    await ctx.addEntry(entryInput('Ghost Entry'));
  });
  assert('failed add rolls back', ctx.allEntries.length === beforeCount && !entryNames().includes('Ghost Entry'));
  assert('failed add never reaches the store', !storeFor('p-1').entries.some(e => e.name === 'Ghost Entry'));
  assert('notice carries the server’s words', notice?.message === 'Couldn’t save to your diary right now. Please try again.'
    && notice?.actionLabel === 'OK');
  await act(async () => {
    notice!.onAction();
  });
  assert('dismiss clears the notice', notice === null);

  failNext.set('PUT patient-data/water', 'network');
  await act(async () => {
    await ctx.setWater(TODAY_KEY, 64);
  });
  assert('failed water rolls back to the last saved value', ctx.waterFor(TODAY_KEY) === 40);
  assert('network failure gets plain words', notice?.message === 'Couldn’t reach the server. Check your connection and try again.');
  await act(async () => {
    notice!.onAction();
  });

  failNext.set('POST patient-data/entries', { status: 502, body: { error: 'Nope.' } });
  let failedClones: MealLogEntry[] = ['sentinel' as unknown as MealLogEntry];
  await act(async () => {
    failedClones = await ctx.copyEntries([ctx.allEntries[0]], { dateKey: TODAY_KEY });
  });
  assert('failed copy returns no clones (no Undo to arm)', failedClones.length === 0);
  await act(async () => {
    notice?.onAction();
  });
  await unmount(tree);

  // ── 6 · Failed hydration: seedless + RETRY, never demo data ────────────────
  section('hydration failure: seedless behind RETRY');
  failNext.set('GET patient-data/state', {
    status: 502,
    body: { error: 'Couldn’t load your diary right now. Please try again.' },
  });
  tree = await mountLive();
  assert('failed hydration still settles', ctx.hydrated);
  assert('failed hydration shows an empty diary, not the demo seed', ctx.allEntries.length === 0);
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
  assert('retry hydrates the real diary', JSON.stringify(idsOf(ctx.allEntries)) === JSON.stringify(p1Ids));
  assert('retry clears the notice', notice === null);
  await unmount(tree);

  // ── 7 · Unresolved account: blocked writes behind retry ────────────────────
  section('unresolved account: seedless, write-blocked, recoverable');
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
    && JSON.stringify(idsOf(ctx.allEntries)) === JSON.stringify(p1Ids));
  await act(async () => {
    await ctx.addEntry(entryInput('P1 After Retry'));
  });
  assert('writes flow again after the retry', storeFor('p-1').entries.some(e => e.name === 'P1 After Retry'));
  const p1IdsFinal = idsOf(storeFor('p-1').entries);

  // ── 8 · Sign-out and account switching never bleed ─────────────────────────
  section('sign-out / switch: demo returns, accounts stay walled off');
  await signIn(null);
  assert('sign-out returns to the demo account', account.account.kind === 'demo');
  assert('sign-out restores the seeded demo diary', ctx.allEntries.length === seedCount + 1
    && entryNames().includes('Demo Marker'));
  assert('no real-account rows leak into the demo diary', !entryNames().some(name => name.startsWith('P1 ')));

  await signIn(P2);
  assert('second account resolves', account.account.kind === 'real');
  assert('second account starts empty — nothing from p-1 or the demo', ctx.allEntries.length === 0);
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
  assert('the demo layer never absorbed account rows',
    !(localStorageBacking.get(STORAGE_KEY) ?? '').includes('P1 ')
    && !(localStorageBacking.get(STORAGE_KEY) ?? '').includes('P2 '));

  await signIn(null);
  await unmount(tree);
  setStubSession(null);

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
