/**
 * Progress photos, check-ins, and preferences on the account (task check).
 *
 * Renders the REAL PatientAccountProvider + PatientProvider under Node via
 * react-test-renderer (tsconfig.account-progress.json remaps native-only
 * modules to the shared stubs and @/lib/supabase to a session emitter) and
 * drives the six formerly device-local slices against a scripted
 * patient-data API with a per-patient in-memory server store + byte bucket:
 *
 *   1. The demo persona is untouched: seeded photos/check-ins hydrate from
 *      the original storage key, and check-in / photo / nudge writes stay
 *      local with zero network.
 *   2. A real patient's check-ins write through POST /patient-data/check-ins
 *      (same-day re-submit replaces the row on both sides) and drive the
 *      weight series; photos upload through the patient media rail
 *      (upload-url → PUT → finalize) and land on the account grid via
 *      POST /patient-data/photos; a remount rebuilds both from the server.
 *   3. Removal is two-phase: removePhoto is local-only (undo window), and
 *      only commitPhotoRemoval sends deleteIds — after which the server row
 *      AND the stored bytes are gone. Undo before the window closes means
 *      no delete is ever sent; a failed commit resurfaces the photo.
 *   4. Stall-nudge state (opt-out, engaged) rides PUT /patient-data/flags
 *      and hydrates back; onboarding answers/completion and notification
 *      prefs persist through the same flags route from OnboardingContext.
 *   5. Failures roll back with the server's words; writes before server
 *      truth are blocked; accounts never bleed into each other or the demo.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:account-progress
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
  usePatientSyncNotice,
  type PatientSyncNoticeValue,
} from '../context/PatientContext';
import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { usePatientAccount, type PatientAccountState } from '../context/PatientAccountContext';
import { OnboardingProvider, useOnboarding } from '../context/OnboardingContext';
import { DEFAULT_ANSWERS } from '../data/onboarding-data';
import { TODAY_KEY } from '../data/patient-data';
import { liveEntryDecision, localTodayKey } from '../lib/live-patient-entry';
import { patientMediaDisplayUrl } from '../lib/patient-data-api';
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

const STORAGE_KEY = 'thinnr_patient_state_v1';

// ─── Scripted patient-data API + per-patient server store ───────────────────

interface PhotoRow {
  id: string;
  dateKey: string;
  label: string;
  angle?: 'front' | 'side' | 'back';
  objectPath: string;
}

interface CheckInRow {
  id: string;
  dateKey: string;
  mood: number;
  sideEffects: string[];
  weight?: number;
  notes?: string;
}

interface StoreFlags {
  nudgeOptOut: boolean;
  nudgeEngaged: boolean;
  nudgeLastSentKey: string | null;
  nudgeLastCrossingKey: string | null;
  onboardingComplete: boolean;
  onboardingAnswers?: Record<string, unknown>;
  notificationPrefs?: Record<string, unknown>;
}

interface ServerStore {
  photos: PhotoRow[];
  checkIns: CheckInRow[];
  flags: StoreFlags;
}

interface ApiCall {
  method: string;
  path: string; // e.g. "patient-data/photos", "patient-media/upload-url"
  query: URLSearchParams;
  token: string | null;
  body: Record<string, unknown> | null;
  bodyBytes: number;
}

type Scripted = { status: number; body: unknown };

const serverStores = new Map<string, ServerStore>();
/** access token → whoami answer */
const tokenRoles = new Map<string, { kind: string; patientId?: string }>();
const apiCalls: ApiCall[] = [];
/** one-shot failures keyed `${method} ${path}`; 'network' throws like a dead link */
const failNext = new Map<string, Scripted | 'network'>();

/** The "bucket": objectPath → stored byte count. */
const storedBytes = new Map<string, number>();
/** presign id → the object path it was minted for */
const pendingUploads = new Map<string, { objectPath: string }>();
let mintSeq = 0;

function storeFor(patientId: string): ServerStore {
  let store = serverStores.get(patientId);
  if (!store) {
    store = {
      photos: [],
      checkIns: [],
      flags: {
        nudgeOptOut: false,
        nudgeEngaged: false,
        nudgeLastSentKey: null,
        nudgeLastCrossingKey: null,
        onboardingComplete: false,
      },
    };
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

function routeCall(call: ApiCall): Scripted {
  const key = `${call.method} ${call.path}`;
  const scripted = failNext.get(key);
  if (scripted) {
    failNext.delete(key);
    if (scripted === 'network') throw new TypeError('network request failed');
    return scripted;
  }

  // Presigned storage PUT: the signature is the auth — no bearer token.
  if (call.method === 'PUT' && call.path.startsWith('media-put/')) {
    const pending = pendingUploads.get(call.path.slice('media-put/'.length));
    if (!pending) return { status: 404, body: { error: 'Unknown upload.' } };
    storedBytes.set(pending.objectPath, call.bodyBytes);
    return { status: 200, body: { ok: true } };
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

  if (key === 'GET patient-data/state') {
    const todayKey = call.query.get('today') ?? '2026-09-01';
    const isInvitedAccount = role.patientId === 'p-1';
    return {
      status: 200,
      body: {
        entries: [],
        water: {},
        targets: {},
        favorites: [],
        recents: [],
        customFoods: [],
        savedRecipes: [],
        photos: store.photos,
        checkIns: store.checkIns,
        flags: store.flags,
        entry: {
          firstName: isInvitedAccount ? 'Invited' : 'Signup',
          programStartDate: isInvitedAccount ? '2026-08-20' : todayKey,
          todayKey,
          programDay: isInvitedAccount ? 12 : 1,
        },
        // Patient-scoped media read capability, as the real server mints it.
        mediaToken: `mt-${role.patientId}`,
      },
    };
  }
  if (key === 'POST patient-media/upload-url') {
    const body = call.body ?? {};
    if (body.kind !== 'progress') {
      return { status: 400, body: { error: `Unexpected media kind ${String(body.kind)}` } };
    }
    mintSeq += 1;
    const putId = `put-${mintSeq}`;
    const objectPath = `/objects/patient-media/${role.patientId}/progress-${mintSeq}`;
    pendingUploads.set(putId, { objectPath });
    return {
      status: 200,
      body: { uploadUrl: `https://thinnr.test/api/media-put/${putId}`, objectPath },
    };
  }
  if (key === 'POST patient-media/finalize') {
    const objectPath = String(call.body?.objectPath ?? '');
    if (!storedBytes.has(objectPath)) {
      return { status: 404, body: { error: 'No object at that path.' } };
    }
    return { status: 200, body: { objectPath, sizeBytes: storedBytes.get(objectPath) } };
  }
  if (key === 'POST patient-media/cleanup') {
    const paths = (call.body?.paths ?? []) as string[];
    return { status: 200, body: { removed: paths } };
  }
  if (key === 'POST patient-data/photos') {
    const body = call.body ?? {};
    const upsert = (body.upsert as PhotoRow[] | undefined) ?? [];
    for (const row of upsert) {
      const index = store.photos.findIndex(p => p.id === row.id);
      if (index >= 0) store.photos[index] = row;
      else store.photos.push(row);
    }
    const deleteIds = (body.deleteIds as string[] | undefined) ?? [];
    for (const id of deleteIds) {
      const row = store.photos.find(p => p.id === id);
      if (row) storedBytes.delete(row.objectPath); // RPC + deleteObjectStrict
      store.photos = store.photos.filter(p => p.id !== id);
    }
    return { status: 200, body: { ok: true } };
  }
  if (key === 'POST patient-data/check-ins') {
    const row = (call.body ?? {}) as unknown as CheckInRow;
    store.checkIns = [...store.checkIns.filter(c => c.dateKey !== row.dateKey), row];
    return { status: 200, body: { ok: true } };
  }
  if (key === 'PUT patient-data/flags') {
    Object.assign(store.flags, call.body ?? {});
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
  const rawBody = init?.body as unknown;
  let parsedBody: Record<string, unknown> | null = null;
  let bodyBytes = 0;
  if (typeof rawBody === 'string') {
    parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
  } else if (rawBody instanceof ArrayBuffer) {
    bodyBytes = rawBody.byteLength;
  } else if (ArrayBuffer.isView(rawBody as ArrayBufferView)) {
    bodyBytes = (rawBody as ArrayBufferView).byteLength;
  }
  const call: ApiCall = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: url.pathname.slice('/api/'.length),
    query: url.searchParams,
    token: auth?.startsWith('Bearer ') ? auth.slice(7) : null,
    body: parsedBody,
    bodyBytes,
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

tokenRoles.set('tok-p1', { kind: 'patient', patientId: 'p-1' });
tokenRoles.set('tok-p2', { kind: 'patient', patientId: 'p-2' });

// ─── Probe + render helpers ──────────────────────────────────────────────────

type Ctx = ReturnType<typeof usePatient>;
type Onb = ReturnType<typeof useOnboarding>;

let ctx!: Ctx;
let notice: PatientSyncNoticeValue | null = null;
let account!: PatientAccountState;
let onb!: Onb;

function Probe() {
  ctx = usePatient();
  notice = usePatientSyncNotice();
  account = usePatientAccount();
  return null;
}

function OnbProbe() {
  onb = useOnboarding();
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

/** Onboarding as the app nests it: account → patient store → onboarding. */
async function mountOnboarding(): Promise<ReactTestRenderer> {
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
            OnboardingProvider,
            null,
            React.createElement(OnbProbe),
            React.createElement(Probe),
          ),
        ),
      ),
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

function realApi() {
  if (account.account.kind !== 'real') throw new Error('no real account resolved');
  return account.account.api;
}

function jpegDataUri(marker: string): string {
  return `data:image/jpeg;base64,${Buffer.from(marker).toString('base64')}`;
}

// ─── The walk ────────────────────────────────────────────────────────────────

async function main() {
  // ── 1 · Demo persona untouched ─────────────────────────────────────────────
  section('demo persona: seeded photos/check-ins, local writes, zero network');
  let tree = await mountDemo();
  assert('demo hydrates', ctx.hydrated);
  assert('demo photos are seeded', ctx.photos.length > 0);
  assert('demo check-ins are seeded', ctx.checkIns.length > 0);
  assert('demo weight series is seeded', ctx.weightSeries.length > 0);
  const demoPhotoCount = ctx.photos.length;
  await act(async () => {
    await ctx.addCheckIn({ dateKey: TODAY_KEY, weight: 168, mood: 4, sideEffects: [], notes: 'Demo CheckIn Marker' });
  });
  await act(async () => {
    await ctx.addPhoto({ dateKey: TODAY_KEY, label: 'Demo Photo Marker', uri: jpegDataUri('DEMO') });
  });
  await act(async () => {
    await ctx.setNudgeOptOut(true);
  });
  await act(async () => {
    await ctx.markNudgeEngaged();
  });
  assert('demo check-in lands locally', ctx.checkIns.some(c => c.notes === 'Demo CheckIn Marker'));
  assert('demo photo lands locally with its uri', ctx.photos.some(p => p.label === 'Demo Photo Marker' && typeof p.uri === 'string'));
  assert('demo nudge state lands locally', ctx.nudgeOptOut && ctx.nudgeEngaged);
  const demoBlob = localStorageBacking.get(STORAGE_KEY) ?? '';
  assert('demo layer persists under the original key', demoBlob.includes('Demo Photo Marker') && demoBlob.includes('Demo CheckIn Marker'));
  assert('demo mode makes zero API calls', apiCalls.length === 0);
  await unmount(tree);

  // ── 2 · Fresh real patient: no seeds, defaults everywhere ─────────────────
  section('fresh real patient: empty grid/check-ins, default flags');
  setStubSession(P1);
  tree = await mountLive();
  assert('account resolves to real', account.account.kind === 'real');
  assert('real hydration completes', ctx.hydrated);
  assert('invited account hydrates its live entry identity', ctx.entryFacts?.firstName === 'Invited');
  assert('invited account hydrates elapsed program state', ctx.entryFacts?.programDay === 12);
  const entryStateCall = lastCallTo('patient-data/state');
  assert('state request sends the device-local calendar day',
    entryStateCall?.query.get('today') === localTodayKey());
  assert('uncompleted invited account is forced from Today into onboarding',
    liveEntryDecision({
      modeHydrated: true,
      mode: 'patient',
      accountResolving: false,
      accountKind: 'real',
      patientHydrated: true,
      onboardingComplete: ctx.hydratedFlags?.onboardingComplete ?? null,
      pathname: '/today',
    }).kind === 'redirect');
  assert('the onboarding route itself is allowed for an incomplete account',
    liveEntryDecision({
      modeHydrated: true,
      mode: 'patient',
      accountResolving: false,
      accountKind: 'real',
      patientHydrated: true,
      onboardingComplete: false,
      pathname: '/onboarding/welcome',
    }).kind === 'allow');
  assert('no seeded photos', ctx.photos.length === 0);
  assert('no seeded check-ins', ctx.checkIns.length === 0);
  assert('no seeded weight series', ctx.weightSeries.length === 0);
  assert('nudge flags default off', !ctx.nudgeOptOut && !ctx.nudgeEngaged);
  assert('no notice on clean hydration', notice === null);

  // ── 3 · Check-ins write through and drive the weight chart ────────────────
  section('check-ins: write-through, same-day replace, weight series');
  await act(async () => {
    await ctx.addCheckIn({ dateKey: TODAY_KEY, weight: 182.5, mood: 4, sideEffects: ['Nausea'], notes: 'P1 first' });
  });
  const firstCheckIn = ctx.checkIns.find(c => c.dateKey === TODAY_KEY);
  const checkInCall = lastCallTo('patient-data/check-ins');
  assert('check-in lands optimistically', firstCheckIn !== undefined && firstCheckIn.mood === 4);
  assert('check-in posts the same row it shows', checkInCall !== undefined
    && checkInCall.body?.id === firstCheckIn?.id
    && checkInCall.body?.dateKey === TODAY_KEY
    && checkInCall.body?.weight === 182.5
    && checkInCall.body?.mood === 4
    && JSON.stringify(checkInCall.body?.sideEffects) === JSON.stringify(['Nausea'])
    && checkInCall.body?.notes === 'P1 first');
  assert('server store has the check-in row', storeFor('p-1').checkIns.length === 1
    && storeFor('p-1').checkIns[0].id === firstCheckIn?.id);
  assert('weight series picks up the check-in weight',
    ctx.weightSeries.some(p => p.dateKey === TODAY_KEY && p.weight === 182.5));

  await act(async () => {
    await ctx.addCheckIn({ dateKey: TODAY_KEY, mood: 2, sideEffects: [] });
  });
  const replaced = ctx.checkIns.filter(c => c.dateKey === TODAY_KEY);
  const replaceCall = lastCallTo('patient-data/check-ins');
  assert('same-day re-submit replaces locally', replaced.length === 1 && replaced[0].mood === 2);
  assert('weight-less re-submit omits weight/notes from the wire', replaceCall !== undefined
    && !('weight' in (replaceCall.body ?? {})) && !('notes' in (replaceCall.body ?? {})));
  assert('same-day re-submit replaces the server row', storeFor('p-1').checkIns.length === 1
    && storeFor('p-1').checkIns[0].mood === 2);
  assert('weight series drops the replaced weight', !ctx.weightSeries.some(p => p.dateKey === TODAY_KEY));

  failNext.set('POST patient-data/check-ins', {
    status: 502,
    body: { error: 'Couldn’t save your check-in right now. Please try again.' },
  });
  await act(async () => {
    await ctx.addCheckIn({ dateKey: TODAY_KEY, mood: 5, sideEffects: [] });
  });
  assert('failed check-in rolls back', ctx.checkIns.find(c => c.dateKey === TODAY_KEY)?.mood === 2);
  assert('failed check-in never reaches the store', storeFor('p-1').checkIns[0].mood === 2);
  assert('check-in notice carries the server’s words',
    notice?.message === 'Couldn’t save your check-in right now. Please try again.' && notice?.actionLabel === 'OK');
  await act(async () => {
    notice!.onAction();
  });

  // ── 4 · Photos: authenticated rail upload + account grid write ────────────
  section('photos: media-rail upload, grid write, rollback on failure');
  const uploaded = await realApi().uploadProgressPhoto(jpegDataUri('P1-FRONT'));
  const mintCall = lastCallTo('patient-media/upload-url');
  const putCall = apiCalls.find(c => c.path.startsWith('media-put/'));
  const finalizeCall = lastCallTo('patient-media/finalize');
  assert('mint asks for an authenticated progress upload', mintCall !== undefined
    && mintCall.token === 'tok-p1'
    && mintCall.body?.kind === 'progress'
    && mintCall.body?.contentType === 'image/jpeg'
    && mintCall.body?.sizeBytes === 8);
  assert('bytes go to the presigned URL', putCall !== undefined && putCall.bodyBytes === 8);
  assert('finalize records the minted path', finalizeCall?.body?.objectPath === uploaded.photoPath);
  assert('upload lands in the account bucket', uploaded.photoPath === '/objects/patient-media/p-1/progress-1'
    && storedBytes.get(uploaded.photoPath) === 8);

  let frontSaved = false;
  await act(async () => {
    frontSaved = await ctx.addPhoto({ dateKey: TODAY_KEY, label: 'Week 1 Front', objectPath: uploaded.photoPath });
  });
  assert('a landed grid write resolves true', frontSaved === true);
  const gridPhoto = ctx.photos.find(p => p.label === 'Week 1 Front');
  const photoCall = lastCallTo('patient-data/photos');
  assert('grid write posts the same row it shows', gridPhoto !== undefined
    && JSON.stringify(photoCall?.body) === JSON.stringify({
      upsert: [{ id: gridPhoto?.id, dateKey: TODAY_KEY, label: 'Week 1 Front', objectPath: uploaded.photoPath }],
    }));
  assert('grid photo is a user photo with an object path', gridPhoto?.source === 'user'
    && gridPhoto?.objectPath === uploaded.photoPath && gridPhoto?.uri === undefined);
  assert('server store has the grid row', storeFor('p-1').photos.some(p => p.id === gridPhoto?.id));

  const sideUpload = await realApi().uploadProgressPhoto(jpegDataUri('P1-SIDE!'));
  const backUpload = await realApi().uploadProgressPhoto(jpegDataUri('P1-BACK!'));
  await act(async () => {
    await ctx.addPhotos([
      { dateKey: TODAY_KEY, label: 'Week 1 Side', angle: 'side', objectPath: sideUpload.photoPath },
      { dateKey: TODAY_KEY, label: 'Week 1 Back', angle: 'back', objectPath: backUpload.photoPath },
    ]);
  });
  const batchCall = lastCallTo('patient-data/photos');
  assert('guided batch posts both rows with angles', Array.isArray(batchCall?.body?.upsert)
    && (batchCall!.body!.upsert as PhotoRow[]).length === 2
    && (batchCall!.body!.upsert as PhotoRow[]).every(row => row.angle === 'side' || row.angle === 'back'));
  assert('server grid mirrors the three photos', storeFor('p-1').photos.length === 3);

  const photosBeforeFail = ctx.photos.length;
  failNext.set('POST patient-data/photos', {
    status: 502,
    body: { error: 'Couldn’t save your photos right now. Please try again.' },
  });
  let ghostSaved = true;
  await act(async () => {
    ghostSaved = await ctx.addPhoto({ dateKey: TODAY_KEY, label: 'Ghost Photo', objectPath: uploaded.photoPath });
  });
  assert('failed grid write resolves false so screens can gate success UI', ghostSaved === false);
  assert('failed grid write rolls back', ctx.photos.length === photosBeforeFail
    && !ctx.photos.some(p => p.label === 'Ghost Photo'));
  assert('photo notice carries the server’s words',
    notice?.message === 'Couldn’t save your photos right now. Please try again.' && notice?.actionLabel === 'OK');
  await act(async () => {
    notice!.onAction();
  });
  // Abandoned uploads (a failed grid write the patient walks away from)
  // are discarded through the authenticated cleanup endpoint.
  await act(async () => {
    await realApi().cleanupProgressUploads(['/objects/patient-media/p-1/progress-ghost']);
  });
  const cleanupCall = lastCallTo('patient-media/cleanup');
  assert('abandoned uploads post their paths for server-side discard',
    cleanupCall?.token === 'tok-p1'
    && JSON.stringify(cleanupCall?.body) === JSON.stringify({
      paths: ['/objects/patient-media/p-1/progress-ghost'],
    }));

  // ── 5 · Reinstall: the account grid comes back from the server ────────────
  section('remount: photos, check-ins, and flags rehydrate from the account');
  await unmount(tree);
  tree = await mountLive();
  assert('remount rehydrates the grid', ctx.photos.length === 3
    && ctx.photos.every(p => p.source === 'user' && typeof p.objectPath === 'string'));
  assert('remount keeps angles', ctx.photos.filter(p => p.angle === 'side' || p.angle === 'back').length === 2);
  assert('remount rehydrates check-ins', ctx.checkIns.length === 1 && ctx.checkIns[0].mood === 2);
  // Reads are token-authorized: render-time display URLs must carry the
  // media token the hydrate delivered — a bare object path opens nothing.
  assert('display URLs carry the account media token',
    ctx.photos.every(p => patientMediaDisplayUrl(p.objectPath!).includes('mt=mt-p-1')));

  // ── 6 · Two-phase removal: undo window, then server delete ────────────────
  section('removal: local undo window first, server delete only on commit');
  const frontPhoto = ctx.photos.find(p => p.label === 'Week 1 Front')!;
  const photoCallsBeforeRemove = callsTo('patient-data/photos').length;
  let removedFront: Awaited<ReturnType<Ctx['removePhoto']>> = null;
  await act(async () => {
    removedFront = await ctx.removePhoto(frontPhoto.id);
  });
  assert('removePhoto captures the removal', removedFront !== null);
  assert('removal is local while the undo window is open',
    !ctx.photos.some(p => p.id === frontPhoto.id)
    && callsTo('patient-data/photos').length === photoCallsBeforeRemove
    && storeFor('p-1').photos.some(p => p.id === frontPhoto.id)
    && storedBytes.has(frontPhoto.objectPath!));

  await act(async () => {
    await ctx.commitPhotoRemoval(removedFront!);
  });
  const deleteCall = lastCallTo('patient-data/photos');
  assert('commit posts exactly the delete', JSON.stringify(deleteCall?.body) === JSON.stringify({ deleteIds: [frontPhoto.id] }));
  assert('commit deletes the server row', !storeFor('p-1').photos.some(p => p.id === frontPhoto.id));
  assert('commit deletes the stored bytes', !storedBytes.has(frontPhoto.objectPath!));

  // Undo inside the window: restore, then the (late) commit must no-op.
  const sidePhoto = ctx.photos.find(p => p.angle === 'side')!;
  let removedSide: Awaited<ReturnType<Ctx['removePhoto']>> = null;
  await act(async () => {
    removedSide = await ctx.removePhoto(sidePhoto.id);
  });
  await act(async () => {
    await ctx.restorePhoto(removedSide!);
  });
  const photoCallsBeforeLateCommit = callsTo('patient-data/photos').length;
  await act(async () => {
    await ctx.commitPhotoRemoval(removedSide!);
  });
  assert('undone removal never sends a delete',
    callsTo('patient-data/photos').length === photoCallsBeforeLateCommit
    && ctx.photos.some(p => p.id === sidePhoto.id)
    && storeFor('p-1').photos.some(p => p.id === sidePhoto.id)
    && storedBytes.has(sidePhoto.objectPath!));

  // A failed commit rolls the photo back into the grid — better a
  // resurfaced photo than a half-deleted object.
  let removedAgain: Awaited<ReturnType<Ctx['removePhoto']>> = null;
  await act(async () => {
    removedAgain = await ctx.removePhoto(sidePhoto.id);
  });
  failNext.set('POST patient-data/photos', {
    status: 502,
    body: { error: 'Couldn’t save your photos right now. Please try again.' },
  });
  await act(async () => {
    await ctx.commitPhotoRemoval(removedAgain!);
  });
  assert('failed commit resurfaces the photo', ctx.photos.some(p => p.id === sidePhoto.id));
  assert('failed commit leaves row and bytes in place',
    storeFor('p-1').photos.some(p => p.id === sidePhoto.id) && storedBytes.has(sidePhoto.objectPath!));
  assert('failed commit explains itself',
    notice?.message === 'Couldn’t save your photos right now. Please try again.');
  await act(async () => {
    notice!.onAction();
  });

  // The screen owns the undo clock, but the PROVIDER owns making sure a
  // lapsed window really commits: if the screen unmounts mid-window (its
  // timer dies with it), a store-owned backstop fires just after the window
  // and pushes the delete anyway. An undo cancels the backstop with it.
  const backPhoto = ctx.photos.find(p => p.angle === 'back')!;
  let removedBack: Awaited<ReturnType<Ctx['removePhoto']>> = null;
  await act(async () => {
    removedBack = await ctx.removePhoto(backPhoto.id);
  });
  assert('backstop scenario captured a removal', removedBack !== null);
  // Nobody ever calls commitPhotoRemoval for backPhoto — "the screen died".
  let removedSideAgain: Awaited<ReturnType<Ctx['removePhoto']>> = null;
  await act(async () => {
    removedSideAgain = await ctx.removePhoto(sidePhoto.id);
  });
  await act(async () => {
    await ctx.restorePhoto(removedSideAgain!);
  });
  assert('backstop holds fire while the undo window is open',
    storeFor('p-1').photos.some(p => p.id === backPhoto.id) && storedBytes.has(backPhoto.objectPath!));
  await act(async () => {
    // Undo window (5000ms) + backstop grace (750ms) + scheduling slack.
    await new Promise(resolve => setTimeout(resolve, 6200));
  });
  assert('backstop commits an orphaned removal once no undo can exist',
    !storeFor('p-1').photos.some(p => p.id === backPhoto.id)
    && !storedBytes.has(backPhoto.objectPath!)
    && !ctx.photos.some(p => p.id === backPhoto.id));
  assert('undo cancels the backstop for good',
    ctx.photos.some(p => p.id === sidePhoto.id)
    && storeFor('p-1').photos.some(p => p.id === sidePhoto.id)
    && storedBytes.has(sidePhoto.objectPath!));

  // ── 7 · Stall-nudge flags follow the account ──────────────────────────────
  section('stall-nudge: opt-out and engagement write through and hydrate back');
  await act(async () => {
    await ctx.setNudgeOptOut(true);
  });
  assert('opt-out posts exactly the flag', JSON.stringify(lastCallTo('patient-data/flags')?.body) === JSON.stringify({ nudgeOptOut: true })
    && ctx.nudgeOptOut && storeFor('p-1').flags.nudgeOptOut);

  await act(async () => {
    await ctx.markNudgeEngaged();
  });
  assert('engagement posts exactly the flag', JSON.stringify(lastCallTo('patient-data/flags')?.body) === JSON.stringify({ nudgeEngaged: true })
    && ctx.nudgeEngaged && storeFor('p-1').flags.nudgeEngaged);

  const flagCallsBeforeRepeat = callsTo('patient-data/flags').length;
  await act(async () => {
    await ctx.markNudgeEngaged();
  });
  assert('already-engaged is a no-op', callsTo('patient-data/flags').length === flagCallsBeforeRepeat);

  failNext.set('PUT patient-data/flags', {
    status: 502,
    body: { error: 'Couldn’t save your settings right now. Please try again.' },
  });
  await act(async () => {
    await ctx.setNudgeOptOut(false);
  });
  assert('failed flag write rolls back', ctx.nudgeOptOut && storeFor('p-1').flags.nudgeOptOut);
  assert('flag notice carries the server’s words',
    notice?.message === 'Couldn’t save your settings right now. Please try again.');
  await act(async () => {
    notice!.onAction();
  });

  await unmount(tree);
  tree = await mountLive();
  assert('nudge flags hydrate back from the account', ctx.nudgeOptOut && ctx.nudgeEngaged);

  // ── 8 · No server truth → no writes ────────────────────────────────────────
  section('hydration failure: check-in and photo writes are blocked');
  await unmount(tree);
  failNext.set('GET patient-data/state', {
    status: 502,
    body: { error: 'Couldn’t load your diary right now. Please try again.' },
  });
  tree = await mountLive();
  assert('failed hydration shows empty progress data, not the demo seed',
    ctx.photos.length === 0 && ctx.checkIns.length === 0);
  const checkInCallsBlocked = callsTo('patient-data/check-ins').length;
  const photoCallsBlocked = callsTo('patient-data/photos').length;
  await act(async () => {
    await ctx.addCheckIn({ dateKey: TODAY_KEY, mood: 3, sideEffects: [] });
  });
  await act(async () => {
    await ctx.addPhoto({ dateKey: TODAY_KEY, label: 'Blocked Photo', objectPath: '/objects/patient-media/p-1/progress-1' });
  });
  assert('blocked writes never reach the server',
    callsTo('patient-data/check-ins').length === checkInCallsBlocked
    && callsTo('patient-data/photos').length === photoCallsBlocked
    && ctx.checkIns.length === 0 && ctx.photos.length === 0);
  assert('blocked write explains itself with RETRY',
    notice?.message === 'Your diary isn’t loaded yet. Retry loading before saving.' && notice?.actionLabel === 'RETRY');
  // Onboarding flag saves are gentler than diary writes: they queue behind
  // the hydration retry instead of bouncing, and flush once truth arrives.
  const flagCallsWhileBlocked = callsTo('patient-data/flags').length;
  await act(async () => {
    ctx.saveOnboardingFlags({ onboardingComplete: true });
  });
  await settle();
  assert('queued onboarding flags wait for server truth (no blind PUT)',
    callsTo('patient-data/flags').length === flagCallsWhileBlocked);
  await act(async () => {
    notice!.onAction();
  });
  await settle();
  assert('retry hydrates the account data', ctx.photos.length === 1 && ctx.checkIns.length === 1);
  assert('queued flags flush once truth arrives',
    callsTo('patient-data/flags').length === flagCallsWhileBlocked + 1
    && lastCallTo('patient-data/flags')?.body?.onboardingComplete === true
    && storeFor('p-1').flags.onboardingComplete === true);
  await unmount(tree);

  // ── 9 · Onboarding answers + notification prefs ride the account ──────────
  section('onboarding: answers, completion, and notification prefs persist');
  storeFor('p-1').flags.onboardingComplete = false;
  tree = await mountOnboarding();
  assert('onboarding sees the real account', account.account.kind === 'real');
  const flagCallsBeforeOnb = callsTo('patient-data/flags').length;
  await act(async () => {
    onb.patch({ notifications: 'enabled', reminderMorning: '9:00 AM' });
  });
  await act(async () => {
    onb.advance('contact');
  });
  await settle();
  const advanceCall = lastCallTo('patient-data/flags');
  const advanceAnswers = advanceCall?.body?.onboardingAnswers as Record<string, unknown> | undefined;
  assert('advance pushes the running answers', callsTo('patient-data/flags').length === flagCallsBeforeOnb + 1
    && advanceAnswers?.notifications === 'enabled'
    && advanceAnswers?.reminderMorning === '9:00 AM'
    && !('onboardingComplete' in (advanceCall?.body ?? {})));
  assert('server stores the running answers',
    (storeFor('p-1').flags.onboardingAnswers as Record<string, unknown> | undefined)?.notifications === 'enabled');

  failNext.set('PUT patient-data/flags', {
    status: 502,
    body: { error: 'Couldn’t save your settings right now. Please try again.' },
  });
  let failedCompletion = true;
  await act(async () => {
    failedCompletion = await onb.endRun();
  });
  await settle();
  assert('failed completion cannot unlock Today',
    failedCompletion === false
    && ctx.hydratedFlags?.onboardingComplete === false
    && storeFor('p-1').flags.onboardingComplete === false
    && liveEntryDecision({
      modeHydrated: true,
      mode: 'patient',
      accountResolving: false,
      accountKind: 'real',
      patientHydrated: true,
      onboardingComplete: ctx.hydratedFlags?.onboardingComplete ?? null,
      pathname: '/today',
    }).kind === 'redirect');

  let completionSaved = false;
  await act(async () => {
    completionSaved = await onb.endRun();
  });
  await settle();
  const endCall = lastCallTo('patient-data/flags');
  const prefs = endCall?.body?.notificationPrefs as Record<string, unknown> | undefined;
  assert('finishing marks the account complete with prefs', completionSaved
    && endCall?.body?.onboardingComplete === true
    && prefs?.notifications === 'enabled'
    && prefs?.reminderMorning === '9:00 AM'
    && typeof prefs?.reminderAfternoon === 'string'
    && typeof prefs?.reminderEvening === 'string');
  assert('server stores completion + prefs', storeFor('p-1').flags.onboardingComplete === true
    && (storeFor('p-1').flags.notificationPrefs as Record<string, unknown> | undefined)?.reminderMorning === '9:00 AM');
  assert('completion immediately opens patient destinations',
    liveEntryDecision({
      modeHydrated: true,
      mode: 'patient',
      accountResolving: false,
      accountKind: 'real',
      patientHydrated: true,
      onboardingComplete: ctx.hydratedFlags?.onboardingComplete ?? null,
      pathname: '/today',
    }).kind === 'allow');

  // A failed push keeps the answers queued behind a RETRY notice — the
  // account never silently loses what the patient already answered.
  failNext.set('PUT patient-data/flags', {
    status: 502,
    body: { error: 'Couldn’t save your settings right now. Please try again.' },
  });
  const flagCallsBeforeRetryCase = callsTo('patient-data/flags').length;
  await act(async () => {
    onb.patch({ notifications: 'later' });
    onb.advance('contact');
  });
  await settle();
  assert('failed flags push surfaces a retryable notice',
    callsTo('patient-data/flags').length === flagCallsBeforeRetryCase + 1
    && notice?.message === 'Couldn’t save your settings right now. Please try again.'
    && notice?.actionLabel === 'RETRY');
  await act(async () => {
    notice!.onAction();
  });
  await settle();
  const retriedCall = lastCallTo('patient-data/flags');
  assert('RETRY re-sends the queued answers',
    callsTo('patient-data/flags').length === flagCallsBeforeRetryCase + 2
    && (retriedCall?.body?.onboardingAnswers as Record<string, unknown> | undefined)?.notifications === 'later'
    && (storeFor('p-1').flags.onboardingAnswers as Record<string, unknown> | undefined)?.notifications === 'later');

  // Reload: the account's saved answers hydrate back into the onboarding
  // state — reinstall-safe — and stored notification prefs override their
  // answer keys (raw answers say 'later'; the finished run's prefs say
  // 'enabled' and win).
  (storeFor('p-1').flags.notificationPrefs as Record<string, unknown>).reminderMorning = '7:15 AM';
  await unmount(tree);
  tree = await mountOnboarding();
  assert('reload restores saved onboarding answers from the account',
    account.account.kind === 'real'
    && onb.answers.reminderMorning === '7:15 AM'
    && onb.answers.notifications === 'enabled'
    && Array.isArray(onb.answers.diets));
  assert('a restored account is not dropped into a live run', onb.begun === false);
  assert('reload preserves onboarding completion for returning login',
    ctx.hydratedFlags?.onboardingComplete === true);

  await signIn(null);
  const flagCallsSignedOut = callsTo('patient-data/flags').length;
  await act(async () => {
    onb.patch({ notifications: 'later' });
  });
  await act(async () => {
    onb.advance('contact');
  });
  await act(async () => {
    onb.endRun();
  });
  await settle();
  assert('demo onboarding never touches the account',
    callsTo('patient-data/flags').length === flagCallsSignedOut);
  await unmount(tree);

  // ── 10 · Accounts never bleed ──────────────────────────────────────────────
  section('sign-out / switch: demo returns, second account starts clean');
  tree = await mountLive();
  assert('sign-out returns the demo layer', account.account.kind === 'demo'
    && ctx.photos.some(p => p.label === 'Demo Photo Marker')
    && ctx.photos.length === demoPhotoCount + 1
    && ctx.checkIns.some(c => c.notes === 'Demo CheckIn Marker')
    && ctx.nudgeOptOut);
  assert('no account object paths leak into the demo grid',
    !ctx.photos.some(p => (p.objectPath ?? '').includes('/patient-media/')));
  assert('the demo persona holds no media token',
    !patientMediaDisplayUrl('/objects/patient-media/p-1/progress-x').includes('mt='));

  await signIn(P2);
  assert('second account starts clean', ctx.photos.length === 0 && ctx.checkIns.length === 0
    && !ctx.nudgeOptOut && !ctx.nudgeEngaged);
  assert('self-signup account hydrates its own live identity and starts on day one',
    ctx.entryFacts?.firstName === 'Signup' && ctx.entryFacts?.programDay === 1);
  assert('the second account gets its OWN media token',
    patientMediaDisplayUrl('/objects/patient-media/p-2/progress-x').includes('mt=mt-p-2'));
  await act(async () => {
    await ctx.addCheckIn({ dateKey: TODAY_KEY, mood: 5, sideEffects: [], notes: 'P2 note' });
  });
  assert('p-2 check-in lands in the p-2 store only',
    storeFor('p-2').checkIns.length === 1
    && !storeFor('p-1').checkIns.some(c => c.notes === 'P2 note'));

  // Onboarding state never leaks between accounts: p-2 has no saved
  // answers, so a remounted onboarding layer starts from the defaults.
  await unmount(tree);
  tree = await mountOnboarding();
  assert('second account starts onboarding fresh — nothing from p-1',
    onb.answers.notifications === DEFAULT_ANSWERS.notifications
    && onb.answers.reminderMorning === DEFAULT_ANSWERS.reminderMorning);

  const acct1Raw = localStorageBacking.get(`${STORAGE_KEY}:acct_p-1`);
  assert('server-backed progress slices are never persisted locally for real accounts',
    acct1Raw !== undefined && (() => {
      const parsed = JSON.parse(acct1Raw!) as {
        photos?: unknown[];
        addedCheckIns?: unknown[];
        nudgeOptOut?: boolean;
      };
      return (parsed.photos ?? []).length === 0
        && (parsed.addedCheckIns ?? []).length === 0
        && parsed.nudgeOptOut === false;
    })());
  assert('the demo layer never absorbed account rows',
    !(localStorageBacking.get(STORAGE_KEY) ?? '').includes('patient-media'));

  await signIn(null);
  await unmount(tree);
  setStubSession(null);

  // ── Verdict ─────────────────────────────────────────────────────────────────
  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) {
    process.exitCode = 1;
  } else {
    console.log('account-progress: all good');
  }
}

main().catch(error => {
  console.error('suite crashed:', error);
  process.exitCode = 1;
});
