/**
 * Patient diet experience (task check): onboarding diet writes, the diet
 * picker + screening + block notice, the Food preferences lists (online and
 * queued), the Today cards (eating-window timer, Whole30 counter, one-time
 * existing-account prompt) and the targets override editor.
 *
 * Renders the REAL PatientAccountProvider + PatientProvider (+ the real
 * OnboardingProvider and the shared diet components) under Node via
 * react-test-renderer against a scripted patient-data API with a
 * per-patient in-memory diet store. No network, no live database.
 *
 *   1. Finishing onboarding with diet answers: completion is confirmed
 *      FIRST; the diet selection and list writes ride the offline queue, so
 *      a dead link on PUT /patient-data/diet never blocks completion and the
 *      queue replays it (with the preferences) on its own.
 *   2. The diet picker: cards, keto's medication question, the required
 *      activity level, one confirmation only when the diet changes, 200 →
 *      active, 202 → "care team asked to review" + pending block, protocol
 *      lock → locked view with activity-only save.
 *   3. Food preferences: online adds land server ids; a dead link keeps the
 *      item on the list under a local id, removing it drops the queued add
 *      without a DELETE, replay mints the server id; severity edits.
 *   4. Today: eating-window state follows the clock; Whole30 counts days,
 *      day 31 prompts and "Just track" selects just_tracking; the one-time
 *      prompt marks itself seen through the flags route.
 *   5. Targets: calculated numbers display, +50 kcal edit writes ONLY the
 *      changed override, reset clears it.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:diet-patient
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
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { PatientProvider, usePatient, usePatientSync, type PatientSyncValue } from '../context/PatientContext';
import { WRITE_QUEUE_TUNING } from '../lib/patient-write-queue';
import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { usePatientAccount, type PatientAccountState } from '../context/PatientAccountContext';
import { OnboardingProvider, useOnboarding } from '../context/OnboardingContext';
import { DietPicker } from '../components/diet/DietPicker';
import { FoodPreferencesSections } from '../components/diet/FoodPreferencesSections';
import {
  DIET_PROMPT_SEEN_KEY,
  EatingWindowCard,
  ExistingAccountDietPrompt,
  Whole30Card,
} from '../components/diet/TodayDietCards';
import { TargetsEditor } from '../components/diet/TargetsEditor';
import { LOCAL_PREFERENCE_PREFIX, isLocalPreferenceId, type DietState } from '../lib/diet-state';
import { setConnectivityOverride } from '../lib/connectivity';
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

// ─── Scripted patient-data API + per-patient diet store ─────────────────────

interface StoreFlags {
  nudgeOptOut: boolean;
  nudgeEngaged: boolean;
  nudgeLastSentKey: string | null;
  nudgeLastCrossingKey: string | null;
  onboardingComplete: boolean;
  onboardingAnswers?: Record<string, unknown>;
  notificationPrefs?: Record<string, unknown>;
}

interface PreferenceRow {
  id: string;
  list: string;
  key: string;
  label: string;
  isCustom: boolean;
  severity: 'mild' | 'severe' | null;
  enteredByRole: string;
  enteredByName: string | null;
  createdAt: string;
}

interface SelectionRow {
  id: string;
  dietSlug: string;
  status: string;
  selectedByRole: string;
  settings: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
}

interface ServerStore {
  flags: StoreFlags;
  /** Gender as the profile/setup write recorded it (drives the pregnancy question). */
  gender: 'male' | 'female' | null;
  /** Protocol in progress → the picker is locked. */
  locked: boolean;
  currentDiet: SelectionRow | null;
  pendingBlock: Record<string, unknown> | null;
  preferences: PreferenceRow[];
  /** Rows deleted through the API, in order (lets tests see rows that landed and left within one tick). */
  removedPreferences: PreferenceRow[];
  screening: Record<string, string>;
  activity: { level: string; source: string; recordedOn: string } | null;
  overrides: Record<string, number | null>;
}

interface ApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | null;
  body: Record<string, unknown> | null;
}

type Scripted = { status: number; body: unknown };

const SERVER_DAY = '2026-10-10';
const CALCULATED = { calories: 1650, protein: 130, carbs: 140, fat: 55, waterOz: 80 };

const serverStores = new Map<string, ServerStore>();
const tokenRoles = new Map<string, { kind: string; patientId?: string }>();
const apiCalls: ApiCall[] = [];
/** one-shot failures keyed `${method} ${path}`; 'network' throws like a dead link */
const failNext = new Map<string, Scripted | 'network'>();
/** Requests held in flight (server untouched) until the test releases them. */
const holdNext = new Map<string, Promise<void>>();
function holdNextCall(key: string): () => void {
  let release!: () => void;
  holdNext.set(key, new Promise<void>(resolve => { release = resolve; }));
  return release;
}
let idSeq = 0;

function storeFor(patientId: string): ServerStore {
  let store = serverStores.get(patientId);
  if (!store) {
    store = {
      flags: { nudgeOptOut: false, nudgeEngaged: false, nudgeLastSentKey: null, nudgeLastCrossingKey: null, onboardingComplete: false },
      gender: null,
      locked: false,
      currentDiet: null,
      pendingBlock: null,
      preferences: [],
      removedPreferences: [],
      screening: {},
      activity: null,
      overrides: {},
    };
    serverStores.set(patientId, store);
  }
  return store;
}

function callsTo(path: string, method?: string): ApiCall[] {
  return apiCalls.filter(call => call.path === path && (!method || call.method === method));
}

function dietStateBody(store: ServerStore) {
  const phase = store.locked
    ? { programDay: 10, phase: 'protocol', phaseName: 'Protocol', maintenanceDay: 0, dietPickerLocked: true, episodeId: 'ep-1', episodeNumber: 1, episodeStartedOn: '2026-10-01' }
    : { programDay: 0, phase: 'maintenance', phaseName: 'Maintenance', maintenanceDay: 5, dietPickerLocked: false, episodeId: null, episodeNumber: null, episodeStartedOn: null };
  return {
    dateKey: SERVER_DAY,
    programId: 'glp1',
    phase,
    currentDiet: store.currentDiet,
    effectiveDietSlug: store.locked ? null : store.currentDiet?.dietSlug ?? null,
    pendingSelection: null,
    pendingBlock: store.pendingBlock,
    suggestedDefaultSlug: 'glp1_companion',
    screening: { answers: store.screening, pregnancyConflict: false },
    preferences: store.preferences,
    activityLevel: store.activity,
  };
}

function targetsBody(store: ServerStore) {
  const effective = { ...CALCULATED };
  const overridden: string[] = [];
  for (const [key, value] of Object.entries(store.overrides)) {
    if (typeof value === 'number') {
      (effective as Record<string, number>)[key] = value;
      overridden.push(key);
    }
  }
  return { dateKey: SERVER_DAY, calculated: CALCULATED, effective, overrides: store.overrides, overridden, missing: [], activityLevel: store.activity?.level ?? null };
}

const KNOWN_SLUGS = new Set([
  'just_tracking', 'glp1_companion', 'intermittent_fasting', 'keto', 'whole30', 'carnivore', 'aip', 'guided_elimination', 'fertility_pregnancy', 'mediterranean',
]);

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
  const store = storeFor(role.patientId);
  const canonicalProfile = {
    firstName: 'Diet',
    lastName: 'Patient',
    email: `${role.patientId}@example.com`,
    phone: '+15550001010',
    dateOfBirth: '1985-04-03',
    gender: store.gender,
    heightInches: 66,
    startingWeight: 205,
    currentWeight: 191,
    goalWeight: 165,
    timezone: 'America/New_York',
    programId: 'glp1',
    programStartDate: '2026-08-20',
    setupComplete: store.flags.onboardingComplete,
  };

  if (key === 'GET patient-data/profile') return { status: 200, body: { profile: canonicalProfile } };
  if (key === 'PUT patient-data/setup' || key === 'POST patient-data/profile/setup') {
    const input = call.body ?? {};
    store.flags.onboardingAnswers = input.onboardingAnswers as Record<string, unknown>;
    if (input.notificationPrefs && typeof input.notificationPrefs === 'object') {
      store.flags.notificationPrefs = input.notificationPrefs as Record<string, unknown>;
    }
    if (key === 'POST patient-data/profile/setup') store.flags.onboardingComplete = true;
    const profileGender = (input.profile as Record<string, unknown> | undefined)?.gender;
    if (profileGender === 'male' || profileGender === 'female' || profileGender === null) store.gender = profileGender;
    return {
      status: 200,
      body: { profile: { ...canonicalProfile, ...(input.profile as Record<string, unknown> | undefined), setupComplete: store.flags.onboardingComplete } },
    };
  }
  if (key === 'GET patient-data/state') {
    const todayKey = call.query.get('today') ?? SERVER_DAY;
    return {
      status: 200,
      body: {
        entries: [], water: {}, targets: {}, favorites: [], recents: [], customFoods: [], savedRecipes: [], photos: [], checkIns: [],
        flags: store.flags,
        entry: { firstName: 'Diet', programStartDate: '2026-08-20', todayKey, programDay: 12 },
        mediaToken: `mt-${role.patientId}`,
      },
    };
  }
  if (key === 'PUT patient-data/flags') {
    Object.assign(store.flags, call.body ?? {});
    return { status: 200, body: { ok: true } };
  }
  if (key === 'POST patient-data/presence') return { status: 200, body: { ok: true } };

  // ── Diet rail ──
  if (key === 'GET patient-data/diet') return { status: 200, body: dietStateBody(store) };
  if (key === 'GET patient-data/diet/targets') return { status: 200, body: targetsBody(store) };
  if (key === 'GET patient-data/diet/library') return { status: 200, body: { diets: [] } };
  if (key === 'GET patient-data/diet/history') return { status: 200, body: { selections: [], episodes: [] } };
  if (key === 'PUT patient-data/diet') {
    const body = call.body ?? {};
    const slug = String(body.dietSlug ?? '');
    if (store.locked) return { status: 409, body: { error: 'The protocol decides your plan for now.' } };
    if (!KNOWN_SLUGS.has(slug)) return { status: 400, body: { error: 'Unknown diet.' } };
    const answers = (body.answers ?? {}) as Record<string, string>;
    Object.assign(store.screening, answers);
    if (typeof body.activityLevel === 'string') store.activity = { level: body.activityLevel, source: 'diet_selection', recordedOn: SERVER_DAY };
    if ((slug === 'keto' || slug === 'intermittent_fasting') && answers.medication === 'yes') {
      idSeq += 1;
      store.pendingBlock = {
        id: `block-${idSeq}`, selectionId: `sel-${idSeq}`, dietSlug: slug, questions: ['medication'], status: 'pending',
        reviewedByName: null, reviewedAt: null, reviewNote: null, createdAt: `${SERVER_DAY}T12:00:00Z`,
      };
      return { status: 202, body: { status: 'pending_review', questions: ['medication'], suggestedSlug: 'glp1_companion', message: 'Keto needs a care-team look because of your medication.' } };
    }
    const previous = store.currentDiet?.dietSlug ?? null;
    idSeq += 1;
    store.currentDiet = {
      id: `sel-${idSeq}`, dietSlug: slug, status: 'active', selectedByRole: 'patient',
      settings: (body.settings as Record<string, unknown> | undefined) ?? {}, startedAt: `${SERVER_DAY}T12:00:00Z`, endedAt: null,
    };
    return { status: 200, body: { status: 'active', previousDietSlug: previous, oversightRecommended: slug === 'keto' } };
  }
  if (key === 'PATCH patient-data/diet/settings') {
    if (store.currentDiet) store.currentDiet.settings = { ...store.currentDiet.settings, ...(call.body ?? {}) };
    return { status: 200, body: { ok: true } };
  }
  if (key === 'POST patient-data/diet/screening') {
    Object.assign(store.screening, (call.body?.answers ?? {}) as Record<string, string>);
    return { status: 200, body: { ok: true } };
  }
  if (key === 'POST patient-data/diet/activity') {
    store.activity = { level: String(call.body?.level), source: String(call.body?.source ?? 'settings'), recordedOn: SERVER_DAY };
    return { status: 200, body: { ok: true } };
  }
  if (key === 'POST patient-data/diet/preferences') {
    const body = call.body ?? {};
    const list = String(body.list);
    const providedKey = typeof body.key === 'string' ? body.key : null;
    const label = typeof body.label === 'string' ? body.label : providedKey ?? '';
    const prefKey = providedKey ?? `custom:${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    if (store.preferences.some(p => p.list === list && p.key === prefKey)) return { status: 409, body: { error: 'Already on the list.' } };
    idSeq += 1;
    const row: PreferenceRow = {
      id: `pref-${idSeq}`, list, key: prefKey, label: providedKey ? (providedKey.charAt(0).toUpperCase() + providedKey.slice(1)) : label,
      isCustom: !providedKey, severity: list === 'allergy' ? ((body.severity as 'mild' | 'severe' | undefined) ?? 'mild') : null,
      enteredByRole: 'patient', enteredByName: null, createdAt: `${SERVER_DAY}T12:00:00Z`,
    };
    store.preferences.push(row);
    return { status: 201, body: { item: row } };
  }
  if (call.path.startsWith('patient-data/diet/preferences/')) {
    const id = decodeURIComponent(call.path.slice('patient-data/diet/preferences/'.length));
    const row = store.preferences.find(p => p.id === id);
    if (call.method === 'PATCH') {
      if (!row) return { status: 404, body: { error: 'Not found.' } };
      row.severity = (call.body?.severity as 'mild' | 'severe') ?? row.severity;
      return { status: 200, body: { ok: true } };
    }
    if (call.method === 'DELETE') {
      if (!row) return { status: 404, body: { error: 'Not found.' } };
      store.preferences = store.preferences.filter(p => p.id !== id);
      store.removedPreferences.push(row);
      return { status: 200, body: { ok: true } };
    }
  }
  if (key === 'PUT patient-data/diet/targets') {
    for (const [k, v] of Object.entries(call.body ?? {})) {
      if (v === null) delete store.overrides[k];
      else if (typeof v === 'number') store.overrides[k] = v;
    }
    return { status: 200, body: targetsBody(store) };
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
  const rawBody = init?.body as unknown;
  const call: ApiCall = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: url.pathname.slice('/api/'.length),
    query: url.searchParams,
    token: auth?.startsWith('Bearer ') ? auth.slice(7) : null,
    body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
  };
  apiCalls.push(call);
  const held = holdNext.get(`${call.method} ${call.path}`);
  if (held) {
    holdNext.delete(`${call.method} ${call.path}`);
    await held;
  }
  const result = routeCall(call);
  return {
    ok: result.status < 300,
    status: result.status,
    headers: { get: () => null },
    json: async () => result.body,
  } as unknown as Response;
}) as typeof fetch;

// ─── Sessions ────────────────────────────────────────────────────────────────

const P1: StubSession = { access_token: 'tok-p1', user: { id: 'user-p1' } };
const P2: StubSession = { access_token: 'tok-p2', user: { id: 'user-p2' } };
const P3: StubSession = { access_token: 'tok-p3', user: { id: 'user-p3' } };
tokenRoles.set('tok-p1', { kind: 'patient', patientId: 'p-1' });
tokenRoles.set('tok-p2', { kind: 'patient', patientId: 'p-2' });
tokenRoles.set('tok-p3', { kind: 'patient', patientId: 'p-3' });

// ─── Probe + render helpers ──────────────────────────────────────────────────

type Ctx = ReturnType<typeof usePatient>;
type Onb = ReturnType<typeof useOnboarding>;

let ctx!: Ctx;
let sync!: PatientSyncValue;
let account!: PatientAccountState;
let onb!: Onb;

function Probe() {
  ctx = usePatient();
  sync = usePatientSync();
  account = usePatientAccount();
  return null;
}

function OnbProbe() {
  onb = useOnboarding();
  return null;
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 3000): Promise<void> {
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

/** Full app wiring plus any screen component under test. */
async function mountLive(children?: React.ReactNode): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <PatientAccountProvider>
        <PatientProvider>
          <Probe />
          {children}
        </PatientProvider>
      </PatientAccountProvider>,
    );
  });
  await settle();
  return tree;
}

async function mountOnboarding(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <PatientAccountProvider>
        <PatientProvider>
          <OnboardingProvider>
            <OnbProbe />
            <Probe />
          </OnboardingProvider>
        </PatientProvider>
      </PatientAccountProvider>,
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

function hostByTestID(root: ReactTestInstance, testID: string, prop: 'onPress' | 'onChangeText'): ReactTestInstance | null {
  const hosts = root.findAllByProps({ testID }).filter(i => typeof i.type === 'string' && typeof i.props[prop] === 'function');
  return hosts[hosts.length - 1] ?? null;
}

function has(root: ReactTestInstance, testID: string): boolean {
  return root.findAllByProps({ testID }).some(i => typeof i.type === 'string');
}

function textOf(root: ReactTestInstance, testID: string): string {
  const nodes = root.findAllByProps({ testID }).filter(i => typeof i.type === 'string');
  const node = nodes[nodes.length - 1];
  if (!node) return '';
  const walk = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(walk).join(''));
  return walk(node);
}

/** Simulates a native tap; RN swallows presses on `disabled` pressables. */
async function tap(root: ReactTestInstance, testID: string): Promise<boolean> {
  const el = hostByTestID(root, testID, 'onPress');
  if (!el) {
    fail(`pressable "${testID}" not found`);
    return false;
  }
  if (el.props.disabled === true) return false;
  await act(async () => {
    (el.props.onPress as () => void)();
  });
  await settle();
  return true;
}

async function typeText(root: ReactTestInstance, testID: string, value: string): Promise<void> {
  const el = hostByTestID(root, testID, 'onChangeText');
  if (!el) {
    fail(`input "${testID}" not found`);
    return;
  }
  await act(async () => {
    (el.props.onChangeText as (v: string) => void)(value);
  });
}

// ─── The walk ────────────────────────────────────────────────────────────────

async function main() {
  WRITE_QUEUE_TUNING.baseDelayMs = 5;
  WRITE_QUEUE_TUNING.maxDelayMs = 20;
  // Backoff is min(max, base·2^n): BOTH knobs must rise or the cap still replays within a tap's settle.
  const holdReplay = () => { WRITE_QUEUE_TUNING.baseDelayMs = 500; WRITE_QUEUE_TUNING.maxDelayMs = 500; };
  const releaseReplay = () => { WRITE_QUEUE_TUNING.baseDelayMs = 5; WRITE_QUEUE_TUNING.maxDelayMs = 20; };

  // ── 1 · Onboarding: completion first, diet writes ride the queue ─────────
  section('onboarding: diet answers never block completion; the queue replays them');
  setStubSession(P1);
  let tree = await mountOnboarding();
  assert('account resolves to real', account.account.kind === 'real');
  assert('real hydration completes', ctx.hydrated);
  await waitFor('diet slice goes live before the run', () => ctx.dietStatus === 'live' && ctx.diet !== null);
  assert('fresh account has no diet and no lists', ctx.diet?.currentDiet === null && ctx.diet?.preferences.length === 0);
  assert('no diet writes before the run', callsTo('patient-data/diet', 'PUT').length === 0);

  await act(async () => {
    onb.patch({
      gender: 'female',
      dietSlug: 'keto',
      dietAnswers: { medication: 'no' },
      activityLevel: 'moderate',
      allergiesNone: false,
      allergies: [{ key: 'peanut', label: 'Peanut', severity: 'severe' }],
      dislikes: [{ key: null, label: 'Cilantro' }],
    });
  });
  failNext.set('PUT patient-data/diet', 'network');
  let completed = false;
  await act(async () => {
    completed = await onb.endRun();
  });
  await settle();
  assert('completion succeeds although the diet write died', completed === true
    && ctx.hydratedFlags?.onboardingComplete === true
    && storeFor('p-1').flags.onboardingComplete === true);
  const completionIndex = apiCalls.findIndex(c => c.method === 'POST' && c.path === 'patient-data/profile/setup');
  const firstDietIndex = apiCalls.findIndex(c => c.method === 'PUT' && c.path === 'patient-data/diet');
  assert('diet writes start only after completion is confirmed', completionIndex >= 0 && firstDietIndex > completionIndex);
  const completionProfile = apiCalls[completionIndex]?.body?.profile as Record<string, unknown> | undefined;
  assert('completion persists the onboarding gender on the profile', completionProfile?.gender === 'female' && storeFor('p-1').gender === 'female');
  assert('the saved answers record the allergies step', (storeFor('p-1').flags.onboardingAnswers as Record<string, unknown>)?.allergiesNone === false);
  assert('the failed selection still shows locally as the chosen diet', ctx.diet?.currentDiet?.dietSlug === 'keto');
  await waitFor('queue replays the diet selection', () => storeFor('p-1').currentDiet?.dietSlug === 'keto');
  await waitFor('allergy + custom dislike land on the server', () => {
    const prefs = storeFor('p-1').preferences;
    return prefs.some(p => p.list === 'allergy' && p.key === 'peanut' && p.severity === 'severe')
      && prefs.some(p => p.list === 'dislike' && p.isCustom && p.label === 'Cilantro');
  });
  const selectionCall = callsTo('patient-data/diet', 'PUT').find(c => c.body?.dietSlug === 'keto');
  assert('selection carries answers + activity level', selectionCall?.body !== null
    && (selectionCall?.body?.answers as Record<string, string>)?.medication === 'no'
    && selectionCall?.body?.activityLevel === 'moderate');
  await waitFor('queue drains', () => sync.status === 'idle');
  await waitFor('local state reads back server ids', () => ctx.diet?.preferences.length === 2 && ctx.diet.preferences.every(p => !isLocalPreferenceId(p.id)));
  assert('activity level came back from the server', ctx.diet?.activityLevel?.level === 'moderate');
  await unmount(tree);

  // The gender onboarding saved now reaches the picker: a female patient gets
  // the optional pregnancy question on a pregnancy-sensitive diet.
  tree = await mountLive(<DietPicker onDone={() => undefined} testIDPrefix="p1picker" />);
  await waitFor('picker renders for the freshly onboarded account', () => has(tree.root, 'p1picker-save'));
  await waitFor('profile with gender is loaded', () => ctx.profile?.gender === 'female');
  await tap(tree.root, 'p1picker-diet-intermittent_fasting');
  assert('female patient from onboarding is asked the pregnancy question', has(tree.root, 'p1picker-screen-pregnancy'));
  await unmount(tree);

  // ── 2 · Diet picker: cards, screening, confirmation, verdicts ────────────
  section('diet picker: screening gate, one confirmation, active / pending review / locked');
  setStubSession(P2);
  storeFor('p-2').flags.onboardingComplete = true;
  let done = 0;
  tree = await mountLive(<DietPicker onDone={() => { done += 1; }} testIDPrefix="picker" />);
  const root = () => tree.root;
  await waitFor('picker renders once the diet slice is live', () => has(root(), 'picker-save'));
  assert('GLP-1 companion is suggested for a GLP-1 patient', has(root(), 'picker-diet-glp1_companion-suggested'));
  assert('save is blocked until a diet is picked', hostByTestID(root(), 'picker-save', 'onPress')?.props.accessibilityState?.disabled === true);
  await tap(root(), 'picker-save');
  assert('tapping the blocked save explains why', has(root(), 'picker-notice-error'));

  await tap(root(), 'picker-diet-keto');
  assert('keto shows its oversight note', has(root(), 'picker-diet-keto-oversight'));
  assert('keto asks the medication question', has(root(), 'picker-screen-medication'));
  assert('no pregnancy question when the profile has no gender', !has(root(), 'picker-screen-pregnancy'));
  await tap(root(), 'picker-save');
  assert('save stays blocked until the question is answered', callsTo('patient-data/diet', 'PUT').filter(c => c.token === 'tok-p2').length === 0);
  await tap(root(), 'picker-screen-medication-no');
  await tap(root(), 'picker-activity-moderate');
  await tap(root(), 'picker-save');
  assert('first pick confirms once before writing', has(root(), 'picker-confirm')
    && callsTo('patient-data/diet', 'PUT').filter(c => c.token === 'tok-p2').length === 0);
  await tap(root(), 'picker-confirm-no');
  assert('keep current dismisses the confirmation', !has(root(), 'picker-confirm'));
  await tap(root(), 'picker-save');
  await tap(root(), 'picker-confirm-yes');
  await waitFor('active verdict settles the picker', () => done === 1);
  const p2Select = callsTo('patient-data/diet', 'PUT').filter(c => c.token === 'tok-p2');
  assert('the selection carried answers, activity and no settings', p2Select.length === 1
    && p2Select[0].body?.dietSlug === 'keto'
    && (p2Select[0].body?.answers as Record<string, string>)?.medication === 'no'
    && p2Select[0].body?.activityLevel === 'moderate'
    && !('settings' in (p2Select[0].body ?? {})));
  await waitFor('diet state refreshes to keto', () => ctx.diet?.currentDiet?.dietSlug === 'keto' && ctx.diet.effectiveDietSlug === 'keto');
  await unmount(tree);

  // Changing to a diet whose answer triggers a block: 202 → care-team notice.
  tree = await mountLive(<DietPicker onDone={() => { done += 1; }} testIDPrefix="picker" />);
  await waitFor('picker renders the current diet', () => has(root(), 'picker-save'));
  await tap(root(), 'picker-diet-intermittent_fasting');
  assert('fasting shows presets', has(root(), 'picker-fasting-preset-16-8') && has(root(), 'picker-fasting-preset-20-4'));
  await tap(root(), 'picker-fasting-preset-18-6');
  await tap(root(), 'picker-screen-medication-yes');
  assert('activity level carries over from the current state', hostByTestID(root(), 'picker-save', 'onPress')?.props.accessibilityState?.disabled === false);
  await tap(root(), 'picker-save');
  assert('changing diets asks for one confirmation', has(root(), 'picker-confirm'));
  await tap(root(), 'picker-confirm-yes');
  await waitFor('202 shows the care-team review notice', () => has(root(), 'picker-notice-pending_review'));
  assert('the notice says the care team has been asked to review', textOf(root(), 'picker-notice-pending_review').includes('care team has been asked to review'));
  assert('a blocked pick does not settle the picker', done === 1);
  const fastingCall = callsTo('patient-data/diet', 'PUT').filter(c => c.token === 'tok-p2')[1];
  const window = (fastingCall?.body?.settings as { fastingWindow?: { eatingStart: string; eatingEnd: string } } | undefined)?.fastingWindow;
  assert('fasting preset 18:6 from noon writes a 12:00–18:00 window', window?.eatingStart === '12:00' && window?.eatingEnd === '18:00');
  await waitFor('pending block shows and the diet stays keto', () => has(root(), 'picker-pending-block') && ctx.diet?.currentDiet?.dietSlug === 'keto');
  assert('patient can still pick something else meanwhile', has(root(), 'picker-diet-just_tracking') && has(root(), 'picker-save'));
  await unmount(tree);

  // Protocol lock: the picker shows the protocol as the plan; only activity saves.
  storeFor('p-2').locked = true;
  tree = await mountLive(<DietPicker onDone={() => { done += 1; }} testIDPrefix="picker" />);
  await waitFor('locked view renders during the protocol', () => has(root(), 'picker-locked'));
  assert('locked view has no diet cards', !has(root(), 'picker-diet-keto') && !has(root(), 'picker-save'));
  assert('locked state hides the effective diet from badges', ctx.diet?.effectiveDietSlug === null);
  await tap(root(), 'picker-activity-active');
  await tap(root(), 'picker-save-activity');
  await waitFor('locked view saves activity only', () => storeFor('p-2').activity?.level === 'active' && done === 2);
  assert('no selection attempted while locked', callsTo('patient-data/diet', 'PUT').filter(c => c.token === 'tok-p2').length === 2);
  await unmount(tree);
  storeFor('p-2').locked = false;

  // ── 3 · Food preferences: instant edits, online and queued ───────────────
  section('food preferences: online adds, queued adds under local ids, replay');
  function PrefsHost() {
    const { diet } = usePatient();
    return diet ? <FoodPreferencesSections diet={diet} /> : null;
  }
  tree = await mountLive(<PrefsHost />);
  await waitFor('preference sections render', () => has(root(), 'prefs-section-dislike') && has(root(), 'prefs-section-screening'));
  assert('keto answer shows in the screening section', textOf(root(), 'prefs-answer-medication') === 'Yes');
  assert('empty allergies read as none on file', has(root(), 'prefs-allergy-none'));

  await typeText(root(), 'prefs-dislike-custom-input', '  Blue   Cheese ');
  await tap(root(), 'prefs-dislike-custom-add');
  await waitFor('online custom dislike lands with a server id', () => {
    const row = ctx.diet?.preferences.find(p => p.list === 'dislike' && p.label === 'Blue Cheese');
    return !!row && !isLocalPreferenceId(row.id) && row.isCustom;
  });
  const blueCheese = storeFor('p-2').preferences.find(p => p.label === 'Blue Cheese');
  assert('server stored the custom item without a catalog key', blueCheese?.isCustom === true && blueCheese.key.startsWith('custom:'));
  assert('custom items are tagged on the list', has(root(), `prefs-dislike-item-${blueCheese?.id}-custom`));

  await tap(root(), 'prefs-allergy-opt-milk');
  await waitFor('catalog allergy lands mild by default', () => storeFor('p-2').preferences.some(p => p.key === 'milk' && p.severity === 'mild'));
  const milk = storeFor('p-2').preferences.find(p => p.key === 'milk')!;
  await tap(root(), `prefs-allergy-item-${milk.id}-severe`);
  await waitFor('severity toggles through PATCH', () => storeFor('p-2').preferences.find(p => p.key === 'milk')?.severity === 'severe');

  // Offline: the add is projected under a local id, removal drops the queued add.
  failNext.set('POST patient-data/diet/preferences', 'network');
  const postsBefore = callsTo('patient-data/diet/preferences', 'POST').length;
  holdReplay(); // hold the replay long enough to observe the local id
  await typeText(root(), 'prefs-dislike-custom-input', 'Mushrooms');
  await tap(root(), 'prefs-dislike-custom-add');
  const queued = ctx.diet?.preferences.find(p => p.label === 'Mushrooms');
  assert('offline add shows immediately under a local id', !!queued && isLocalPreferenceId(queued.id) && has(root(), `prefs-dislike-item-${queued?.id}`));
  releaseReplay();
  await waitFor('queued add replays after backoff', () => storeFor('p-2').preferences.some(p => p.label === 'Mushrooms'));
  await waitFor('replayed add swaps to the server id', () => {
    const row = ctx.diet?.preferences.find(p => p.label === 'Mushrooms');
    return !!row && !isLocalPreferenceId(row.id);
  });
  assert('replay sent exactly one more POST', callsTo('patient-data/diet/preferences', 'POST').length === postsBefore + 2);
  await waitFor('queue settles after the replay', () => sync.status === 'idle');

  failNext.set('POST patient-data/diet/preferences', 'network');
  holdReplay(); // hold the replay so the removal happens while queued
  await typeText(root(), 'prefs-dislike-custom-input', 'Olives');
  await tap(root(), 'prefs-dislike-custom-add');
  const olives = ctx.diet?.preferences.find(p => p.label === 'Olives');
  assert('second offline add is queued', !!olives && isLocalPreferenceId(olives.id));
  const deletesBefore = apiCalls.filter(c => c.method === 'DELETE').length;
  await tap(root(), `prefs-dislike-item-${olives?.id}-remove`);
  assert('removing a queued add drops it locally', !ctx.diet?.preferences.some(p => p.label === 'Olives'));
  assert('no DELETE is sent for an item that never reached the server', apiCalls.filter(c => c.method === 'DELETE').length === deletesBefore);
  releaseReplay();
  await waitFor('queue drains without replaying the dropped add', () => sync.status === 'idle');
  assert('dropped add never lands', !storeFor('p-2').preferences.some(p => p.label === 'Olives'));

  // In flight: the POST has left the device but not acked. Edits made now
  // must follow the add to the server row instead of being lost.
  const releaseEgg = holdNextCall('POST patient-data/diet/preferences');
  await tap(root(), 'prefs-allergy-opt-egg');
  const egg = ctx.diet?.preferences.find(p => p.key === 'egg');
  assert('held add still shows under a local id', !!egg && isLocalPreferenceId(egg.id));
  assert('held add has not reached the server', !storeFor('p-2').preferences.some(p => p.key === 'egg'));
  await tap(root(), `prefs-allergy-item-${egg?.id}-severe`);
  assert('severity edit projects immediately while the add is in flight', ctx.diet?.preferences.find(p => p.key === 'egg')?.severity === 'severe');
  const patchesBefore = apiCalls.filter(c => c.method === 'PATCH').length;
  releaseEgg();
  await waitFor('in-flight add lands mild (the POST already left)', () => storeFor('p-2').preferences.some(p => p.key === 'egg'));
  await waitFor('severity follow-up reaches the server row', () => storeFor('p-2').preferences.find(p => p.key === 'egg')?.severity === 'severe');
  const serverEgg = storeFor('p-2').preferences.find(p => p.key === 'egg')!;
  assert('follow-up PATCH targeted the server id, not the local one', apiCalls.slice(patchesBefore).some(c => c.method === 'PATCH' && c.path === `patient-data/diet/preferences/${serverEgg.id}`) && !apiCalls.some(c => c.method === 'PATCH' && c.path.includes(encodeURIComponent(LOCAL_PREFERENCE_PREFIX))));
  await waitFor('queue settles after the in-flight edit', () => sync.status === 'idle');
  await waitFor('list shows the egg row under its server id', () => has(root(), `prefs-allergy-item-${serverEgg.id}-remove`));

  const releaseCapers = holdNextCall('POST patient-data/diet/preferences');
  await typeText(root(), 'prefs-dislike-custom-input', 'Capers');
  await tap(root(), 'prefs-dislike-custom-add');
  const capers = ctx.diet?.preferences.find(p => p.label === 'Capers');
  assert('held custom add shows under a local id', !!capers && isLocalPreferenceId(capers.id));
  await tap(root(), `prefs-dislike-item-${capers?.id}-remove`);
  assert('removal while in flight hides the row at once', !ctx.diet?.preferences.some(p => p.label === 'Capers'));
  releaseCapers();
  // The add lands (its POST already left), then the queued removal deletes
  // that server row — both can complete inside one poll tick, so read the
  // server's own removal log rather than racing the live list.
  await waitFor('in-flight add lands and the queued removal deletes the server row', () =>
    storeFor('p-2').removedPreferences.some(p => p.label === 'Capers') && !storeFor('p-2').preferences.some(p => p.label === 'Capers'));
  const serverCapers = storeFor('p-2').removedPreferences.find(p => p.label === 'Capers')!;
  assert('the server row was created by the held POST', serverCapers.isCustom && serverCapers.key === 'custom:capers' && !isLocalPreferenceId(serverCapers.id));
  assert('removal DELETE used the server id', apiCalls.some(c => c.method === 'DELETE' && c.path === `patient-data/diet/preferences/${serverCapers.id}`));
  await waitFor('queue settles after the in-flight removal', () => sync.status === 'idle');
  assert('removed item stays gone after settle', !ctx.diet?.preferences.some(p => p.label === 'Capers') && !has(root(), `prefs-dislike-item-${capers?.id}`));

  // Restart with a re-pointed edit still queued: the in-flight add acks
  // while the device is offline, so its severity follow-up now names the
  // server id and waits for connectivity. Hydration passes the stored queue
  // through reconcileQueue (diary / library truth) — the diet edit must
  // survive that and replay once the device is back online.
  const releasePeanut = holdNextCall('POST patient-data/diet/preferences');
  await tap(root(), 'prefs-allergy-opt-peanut');
  const peanut = ctx.diet?.preferences.find(p => p.key === 'peanut');
  assert('held peanut add shows under a local id', !!peanut && isLocalPreferenceId(peanut.id));
  await tap(root(), `prefs-allergy-item-${peanut?.id}-severe`);
  await act(async () => { setConnectivityOverride(false); });
  await settle();
  assert('device reads offline', sync.online === false);
  releasePeanut();
  await waitFor('in-flight add lands mild while offline', () => storeFor('p-2').preferences.some(p => p.key === 'peanut' && p.severity === 'mild'));
  const serverPeanut = storeFor('p-2').preferences.find(p => p.key === 'peanut')!;
  await waitFor('severity follow-up is re-pointed at the server id and waits offline', () =>
    sync.items.some(q => q.payload.kind === 'dietPreferenceSeverity' && q.payload.id === serverPeanut.id && q.status === 'pending'));
  assert('offline: the server row is still mild', storeFor('p-2').preferences.find(p => p.key === 'peanut')?.severity === 'mild');
  assert('the list keeps showing severe from the queued edit', ctx.diet?.preferences.find(p => p.key === 'peanut')?.severity === 'severe');
  await unmount(tree);

  tree = await mountLive(<PrefsHost />);
  await waitFor('restart restores the queued severity edit', () =>
    sync.items.some(q => q.payload.kind === 'dietPreferenceSeverity' && q.payload.id === serverPeanut.id));
  await waitFor('restart still shows severe (projection over fresh truth)', () => ctx.diet?.preferences.find(p => p.key === 'peanut')?.severity === 'severe');
  assert('still offline: nothing replayed yet', storeFor('p-2').preferences.find(p => p.key === 'peanut')?.severity === 'mild');
  await act(async () => { setConnectivityOverride(true); });
  await waitFor('reconnect replays the severity edit to the server row', () => storeFor('p-2').preferences.find(p => p.key === 'peanut')?.severity === 'severe');
  await waitFor('queue settles after the restart replay', () => sync.status === 'idle');
  assert('restart replay used the server id', apiCalls.some(c => c.method === 'PATCH' && c.path === `patient-data/diet/preferences/${serverPeanut.id}`));
  await act(async () => { setConnectivityOverride(null); });
  await waitFor('preference sections render again', () => has(root(), `prefs-allergy-item-${milk.id}-remove`));

  await tap(root(), `prefs-allergy-item-${milk.id}-remove`);
  await waitFor('server-side removal goes through DELETE', () => !storeFor('p-2').preferences.some(p => p.key === 'milk'));
  assert('removed allergy leaves the list', !has(root(), `prefs-allergy-item-${milk.id}`));
  await unmount(tree);

  // ── 4 · Today cards ──────────────────────────────────────────────────────
  section('today: eating-window clock, Whole30 counter + day-31 prompt, one-time prompt');
  const base = ctx.diet!;
  const fastingDiet: DietState = {
    ...base,
    currentDiet: { id: 'sel-f', dietSlug: 'intermittent_fasting', status: 'active', selectedByRole: 'patient', settings: { fastingWindow: { eatingStart: '12:00', eatingEnd: '20:00' } }, startedAt: '', endedAt: null },
    effectiveDietSlug: 'intermittent_fasting',
  };
  tree = await mountLive(
    <>
      <EatingWindowCard diet={fastingDiet} now={() => 13 * 60} />
      <EatingWindowCard diet={{ ...fastingDiet, currentDiet: { ...fastingDiet.currentDiet!, id: 'sel-f2' } }} now={() => 22 * 60} />
    </>,
  );
  const states = root().findAllByProps({ testID: 'today-eating-window-state' }).filter(i => typeof i.type === 'string');
  const walk = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(walk).join(''));
  assert('1 pm inside a 12–8 window reads open; 10 pm reads fasting',
    states.length === 2 && walk(states[0]) === 'Window open' && walk(states[1]) === 'Fasting');
  const remaining = root().findAllByProps({ testID: 'today-eating-window-remaining' }).filter(i => typeof i.type === 'string').map(walk);
  assert('remaining time counts to the next change', remaining[0]?.startsWith('7 hr') === true && remaining[0]?.includes('closes 8 PM') === true && remaining[1]?.includes('until it opens') === true);
  await unmount(tree);

  const whole30At = (startDate: string): DietState => ({
    ...base,
    currentDiet: { id: 'sel-w', dietSlug: 'whole30', status: 'active', selectedByRole: 'patient', settings: { whole30StartDate: startDate }, startedAt: '', endedAt: null },
    effectiveDietSlug: 'whole30',
  });
  tree = await mountLive(<Whole30Card diet={whole30At('2026-10-01')} onPickDiet={() => undefined} />);
  await waitFor('Whole30 counter renders', () => has(root(), 'today-whole30-day'));
  assert('day counter reads day 10 of 30 on 2026-10-10 from a 10-01 start', textOf(root(), 'today-whole30-day') === 'Day 10 of 30');
  assert('no end prompt mid-program', !has(root(), 'today-whole30-finished'));
  await unmount(tree);

  let pickRequested = 0;
  tree = await mountLive(<Whole30Card diet={whole30At('2026-09-10')} onPickDiet={() => { pickRequested += 1; }} />);
  await waitFor('day 31 shows the end prompt', () => has(root(), 'today-whole30-finished'));
  await tap(root(), 'today-whole30-pick');
  assert('"Pick a new diet" opens the picker', pickRequested === 1);
  await tap(root(), 'today-whole30-just-track');
  await waitFor('"Just track" selects just_tracking', () => storeFor('p-2').currentDiet?.dietSlug === 'just_tracking');
  await unmount(tree);

  // One-time prompt for an account that finished onboarding before the diet steps.
  setStubSession(P3);
  storeFor('p-3').flags.onboardingComplete = true;
  storeFor('p-3').flags.onboardingAnswers = { notifications: 'enabled' };
  let opened = 0;
  tree = await mountLive(<ExistingAccountDietPrompt onOpenPreferences={() => { opened += 1; }} />);
  await waitFor('legacy account sees the one-time prompt', () => has(root(), 'today-diet-prompt'));
  await tap(root(), 'today-diet-prompt-skip');
  assert('skipping hides the prompt', !has(root(), 'today-diet-prompt') && opened === 0);
  await waitFor('skip is remembered on the account', () => (storeFor('p-3').flags.onboardingAnswers as Record<string, unknown>)?.[DIET_PROMPT_SEEN_KEY] === true);
  await unmount(tree);
  tree = await mountLive(<ExistingAccountDietPrompt onOpenPreferences={() => { opened += 1; }} />);
  await waitFor('diet slice live on remount', () => ctx.dietStatus === 'live');
  assert('the prompt does not come back after skipping', !has(root(), 'today-diet-prompt'));
  await unmount(tree);
  // An account that answered the allergies step never sees the prompt.
  setStubSession(P1);
  tree = await mountLive(<ExistingAccountDietPrompt onOpenPreferences={() => { opened += 1; }} />);
  await waitFor('p-1 diet slice live', () => ctx.dietStatus === 'live' && account.account.kind === 'real');
  assert('an account that went through the diet steps gets no prompt', !has(root(), 'today-diet-prompt'));
  await unmount(tree);

  // ── 5 · Targets override editor ──────────────────────────────────────────
  section('targets: calculated numbers, +50 kcal override, reset');
  function TargetsHost() {
    const { dietTargets } = usePatient();
    return dietTargets ? <TargetsEditor targets={dietTargets} /> : null;
  }
  tree = await mountLive(<TargetsHost />);
  await waitFor('targets editor renders', () => has(root(), 'targets-editor'));
  assert('calories show the calculated value', textOf(root(), 'target-calories-value').includes('1,650'));
  await tap(root(), 'targets-edit');
  await tap(root(), 'target-calories-plus');
  await tap(root(), 'targets-save');
  await waitFor('override write lands', () => storeFor('p-1').overrides.calories === 1700);
  const targetsPut = callsTo('patient-data/diet/targets', 'PUT');
  assert('only the changed field is written', targetsPut.length === 1 && JSON.stringify(targetsPut[0].body) === JSON.stringify({ calories: 1700 }));
  await waitFor('effective calories follow the override', () => ctx.dietTargets?.effective.calories === 1700 && ctx.dietTargets.overridden.includes('calories'));
  assert('value shows the override', textOf(root(), 'target-calories-value').includes('1,700'));
  assert('reset is offered once something is overridden', has(root(), 'targets-reset'));
  await tap(root(), 'targets-reset');
  await waitFor('reset clears the override on the server', () => storeFor('p-1').overrides.calories === undefined);
  const resetPut = callsTo('patient-data/diet/targets', 'PUT')[1];
  assert('reset writes null for the overridden field', resetPut?.body?.calories === null);
  await waitFor('calculated value returns', () => ctx.dietTargets?.effective.calories === 1650);
  await unmount(tree);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
