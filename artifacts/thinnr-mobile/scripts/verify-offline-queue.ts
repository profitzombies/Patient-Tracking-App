/**
 * Offline write queue check (real-account mode).
 *
 * Renders the REAL PatientAccountProvider + PatientProvider (plus the real
 * SyncStatusChip) under Node via react-test-renderer against a scripted
 * patient-data API whose per-patient store honors Idempotency-Key receipts
 * and can lose responses on purpose. Proves the offline contract:
 *
 *   1. Engine rules: exponential backoff with a ceiling, retry vs permanent
 *      failure classes, the retry cap, status precedence, projection order,
 *      reconciliation against server truth, and the persisted shape.
 *   2. Offline: every write is accepted locally, shown with a pending
 *      marker, queued in order, persisted per account, and sent nowhere.
 *   3. Reconnect and foreground replay the queue in order; the store then
 *      mirrors the phone and the chip flashes "Up to date".
 *   4. Backoff and the retry cap: repeated failures wait longer each time,
 *      then park the item as failed (needs attention) with retry / discard;
 *      a 4xx parks immediately and never blocks later writes.
 *   5. Idempotent replay: a write whose response was lost is replayed with
 *      the same key and the server answers from its receipt — one row.
 *   6. Conflict: a queued edit of a row the server has since deleted is
 *      dropped on hydration; queued creates survive a relaunch and land.
 *   7. Account boundaries: switching accounts never shows or sends the
 *      other account's queue; sign-out returns the untouched demo persona;
 *      each account resumes its own queue on its next sign-in.
 *   8. The chip and detail sheet reflect offline / syncing / attention /
 *      up-to-date, list items in order, and expose retry / discard.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:offline-queue
 */
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const localStorageBacking = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => localStorageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => void localStorageBacking.set(key, String(value)),
  removeItem: (key: string) => void localStorageBacking.delete(key),
};

import { createHash, randomUUID } from 'node:crypto';
import React, { act } from 'react';
import { create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';

import {
  PatientProvider,
  usePatient,
  usePatientSync,
  usePatientSyncNotice,
  type PatientSyncNoticeValue,
  type PatientSyncValue,
} from '../context/PatientContext';
import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { usePatientAccount, type PatientAccountState } from '../context/PatientAccountContext';
import { SyncStatusChip, syncChipLabel, syncChipVisible } from '../components/patient/SyncStatusChip';
import { PatientDataError } from '../lib/patient-data-error';
import {
  WRITE_QUEUE_TUNING,
  backoffDelay,
  classifyWriteFailure,
  deriveSyncStatus,
  markAttemptFailed,
  markRetryRequested,
  parseQueue,
  pendingEntityKeys,
  projectQueue,
  reconcileQueue,
  serializeQueue,
  type QueuedWrite,
  type WriteProjectionState,
} from '../lib/patient-write-queue';
import { setConnectivityOverride } from '../lib/connectivity';
import { TODAY_KEY, type DailyTargets, type MealLogEntry } from '../data/patient-data';
import { localTodayKey } from '../lib/live-patient-entry';
import { setStubSession, setStubSessionLoadingTicks, type StubSession } from './live-diary-stubs/supabase';
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

const STORAGE_KEY = 'thinnr_patient_state_v1';

// ─── Scripted patient-data API with idempotency receipts ────────────────────

interface ServerStore {
  entries: MealLogEntry[];
  water: Record<string, number>;
  targets: Partial<DailyTargets>;
  favorites: string[];
  recents: string[];
  checkIns: Array<Record<string, unknown>>;
  /** Grid rows (patient_progress_photos), keyed by photo id. */
  photos: Array<Record<string, unknown>>;
  /** Media ledger (patient_media): object paths finalize registered. */
  ledger: Set<string>;
  /** Objects the presigned PUT actually stored, path → byte length. */
  objects: Map<string, number>;
  /** upload-url mints in order (path per request), to prove pinning. */
  minted: string[];
  /** idempotency key → stored answer (the server's patient_write_receipts). */
  receipts: Map<string, Scripted>;
}

interface ApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | null;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
  at: number;
  /** Set when the server answered from a receipt instead of re-applying. */
  replayed: boolean;
}

type Scripted = { status: number; body: unknown };

const serverStores = new Map<string, ServerStore>();
const tokenRoles = new Map<string, { kind: string; patientId?: string }>();
const apiCalls: ApiCall[] = [];
/** Scripted failures keyed `${method} ${path}`: `times` consecutive answers. */
const failNext = new Map<string, { times: number; result: Scripted | 'network' }>();
/** Routes whose NEXT write is applied server-side but whose response is lost. */
const loseResponseNext = new Set<string>();
/** When true every request fails like a dead radio (offline relaunch). */
let networkDead = false;

function storeFor(patientId: string): ServerStore {
  let store = serverStores.get(patientId);
  if (!store) {
    store = {
      entries: [],
      water: {},
      targets: {},
      favorites: [],
      recents: [],
      checkIns: [],
      photos: [],
      ledger: new Set(),
      objects: new Map(),
      minted: [],
      receipts: new Map(),
    };
    serverStores.set(patientId, store);
  }
  return store;
}

function callsTo(path: string): ApiCall[] {
  return apiCalls.filter(call => call.path === path);
}

/** Presence heartbeats are account-layer pings, not diary writes; the queue never carries them. */
const isPresencePing = (call: ApiCall) => call.path === 'patient-data/presence';

function writeCalls(): ApiCall[] {
  return apiCalls.filter(call => call.path.startsWith('patient-data/') && call.method !== 'GET' && !isPresencePing(call));
}

/** A tiny valid-looking JPEG data URI (the fake rail never sniffs bytes). */
const JPEG_DATA_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2Q==';

function failTimes(key: string, times: number, result: Scripted | 'network') {
  failNext.set(key, { times, result });
}

/** Mirrors the API's patient-media-ids: an uploadId pins the object path. */
function mintedPath(patientId: string, kind: string, uploadId: unknown): string {
  const objectId = typeof uploadId === 'string' && uploadId.length > 0
    ? `${kind}-${createHash('sha256').update(`${patientId}\n${kind}\n${uploadId}`).digest('hex').slice(0, 32)}`
    : `${kind}-${randomUUID()}`;
  return `/objects/patient-media/${patientId}/${objectId}`;
}

function applyWrite(key: string, call: ApiCall, store: ServerStore, patientId: string): Scripted {
  if (key === 'POST patient-media/upload-url') {
    const body = call.body ?? {};
    const objectPath = mintedPath(patientId, String(body.kind), body.uploadId);
    store.minted.push(objectPath);
    return { status: 200, body: { uploadUrl: `https://storage.test/put?path=${encodeURIComponent(objectPath)}`, objectPath } };
  }
  if (key === 'POST patient-media/finalize') {
    const objectPath = String(call.body?.objectPath ?? '');
    if (!store.objects.has(objectPath)) return { status: 404, body: { error: 'The uploaded photo never arrived.' } };
    store.ledger.add(objectPath); // upsert by object_path, like the real route
    return { status: 200, body: { objectPath, sizeBytes: store.objects.get(objectPath), contentType: 'image/jpeg' } };
  }
  if (key === 'POST patient-data/photos') {
    const body = call.body ?? {};
    const upsert = (body.upsert as Array<Record<string, unknown>> | undefined) ?? [];
    for (const photo of upsert) {
      if (!store.ledger.has(String(photo.objectPath))) {
        return { status: 400, body: { error: 'That photo was never finalized.' } };
      }
      const index = store.photos.findIndex(p => p.id === photo.id);
      if (index >= 0) store.photos[index] = photo;
      else store.photos.push(photo);
    }
    const deleteIds = (body.deleteIds as string[] | undefined) ?? [];
    if (deleteIds.length > 0) store.photos = store.photos.filter(p => !deleteIds.includes(String(p.id)));
    return { status: 200, body: { ok: true } };
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
    if (deleteIds.length > 0) store.entries = store.entries.filter(e => !deleteIds.includes(e.id));
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
    return { status: 200, body: { ok: true } };
  }
  throw new Error(`unscripted route: ${key}`);
}

function routeCall(call: ApiCall): Scripted {
  const key = `${call.method} ${call.path}`;
  const scripted = failNext.get(key);
  if (scripted) {
    scripted.times -= 1;
    if (scripted.times <= 0) failNext.delete(key);
    if (scripted.result === 'network') throw new TypeError('network request failed');
    return scripted.result;
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
          firstName: 'Queue',
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
    return {
      status: 200,
      body: {
        entries: store.entries.filter(e => (!from || e.dateKey >= from) && (!to || e.dateKey <= to)),
        water: store.water,
        targets: store.targets,
        favorites: store.favorites,
        recents: store.recents,
        checkIns: store.checkIns,
        photos: store.photos,
        entry: { firstName: 'Queue', programStartDate: '2026-08-20', todayKey, programDay: 12 },
      },
    };
  }

  // Writes: the idempotency contract mirrors the API server — a key that
  // already has a receipt answers from the receipt without re-applying.
  const receiptKey = call.idempotencyKey;
  if (receiptKey && store.receipts.has(receiptKey)) {
    call.replayed = true;
    return store.receipts.get(receiptKey)!;
  }
  const result = applyWrite(key, call, store, role.patientId);
  if (receiptKey && result.status < 300) store.receipts.set(receiptKey, result);
  if (loseResponseNext.has(key)) {
    loseResponseNext.delete(key);
    throw new TypeError('network request failed'); // applied, answer lost
  }
  return result;
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin === 'https://storage.test' && (init?.method ?? 'GET').toUpperCase() === 'PUT') {
    // The presigned PUT: bytes land on the object named by the minted URL.
    if (networkDead) throw new TypeError('network request failed');
    const objectPath = url.searchParams.get('path') ?? '';
    const patientId = objectPath.split('/')[3] ?? '';
    const size = (init?.body as ArrayBuffer | undefined)?.byteLength ?? 0;
    storeFor(patientId).objects.set(objectPath, size);
    return { ok: true, status: 200 } as Response;
  }
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
    at: Date.now(),
    replayed: false,
  };
  apiCalls.push(call);
  if (networkDead) throw new TypeError('network request failed');
  const result = routeCall(call);
  return { ok: result.status < 300, status: result.status, json: async () => result.body } as Response;
}) as typeof fetch;

const P1: StubSession = { access_token: 'tok-p1', user: { id: 'user-p1' } };
const P2: StubSession = { access_token: 'tok-p2', user: { id: 'user-p2' } };
tokenRoles.set('tok-p1', { kind: 'patient', patientId: 'p-1' });
tokenRoles.set('tok-p2', { kind: 'patient', patientId: 'p-2' });

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

async function tick(ms = 5): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick(1);
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await tick(5);
  assert(label, condition());
}

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
          React.createElement(Probe),
          React.createElement(SyncStatusChip),
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

async function goOffline(): Promise<void> {
  await act(async () => {
    setConnectivityOverride(false);
  });
  await settle();
}

async function goOnline(): Promise<void> {
  await act(async () => {
    setConnectivityOverride(true);
  });
  await settle();
}

function entryInput(name: string, overrides: Partial<Omit<MealLogEntry, 'id'>> = {}): Omit<MealLogEntry, 'id'> {
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

function entryNamed(name: string): MealLogEntry | undefined {
  return ctx.allEntries.find(e => e.name === name);
}

function byTestID(tree: ReactTestRenderer, testID: string): ReactTestInstance | null {
  const found = tree.root.findAll(node => node.props?.testID === testID && typeof node.type === 'string');
  return found[0] ?? null;
}

function textOf(node: ReactTestInstance | null): string {
  if (!node) return '';
  return node
    .findAll(n => typeof n.type === 'string' && n.type === 'Text')
    .flatMap(n => React.Children.toArray(n.props.children as React.ReactNode))
    .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('');
}

async function press(tree: ReactTestRenderer, testID: string): Promise<boolean> {
  const node = byTestID(tree, testID);
  if (!node || typeof node.props.onPress !== 'function') return false;
  await act(async () => {
    await node.props.onPress();
  });
  await settle();
  return true;
}

function queueOnDisk(patientId: string): QueuedWrite[] {
  return parseQueue(localStorageBacking.get(`${STORAGE_KEY}:queue_${patientId}`) ?? null);
}

function makeItem(id: string, payload: QueuedWrite['payload'], extra: Partial<QueuedWrite> = {}): QueuedWrite {
  return {
    id,
    payload,
    summary: id,
    createdAt: 0,
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pending',
    lastError: null,
    ...extra,
  };
}

const EMPTY_PROJECTION: WriteProjectionState = {
  addedEntries: [],
  waterOverrides: {},
  addedCheckIns: [],
  photos: [],
  favorites: [],
  customFoods: [],
  savedRecipes: [],
  recents: [],
  targetOverrides: {},
  nudgeOptOut: false,
  nudgeEngaged: false,
  nudgeLastSentKey: null,
  nudgeLastCrossingKey: null,
};

// ─── The walk ────────────────────────────────────────────────────────────────

async function main() {
  // ── 1 · Engine rules ───────────────────────────────────────────────────────
  section('engine: backoff, failure classes, retry cap, status, projection, reconcile, persistence');
  {
    WRITE_QUEUE_TUNING.baseDelayMs = 2_000;
    WRITE_QUEUE_TUNING.maxDelayMs = 300_000;
    WRITE_QUEUE_TUNING.maxAttempts = 10;
    assert('backoff doubles from the base', backoffDelay(1) === 2_000 && backoffDelay(2) === 4_000 && backoffDelay(4) === 16_000);
    assert('backoff is capped', backoffDelay(12) === 300_000 && backoffDelay(40) === 300_000);

    const http = (status: number) => new PatientDataError('x', null, { kind: 'http', status });
    assert('network / non-http failures retry', classifyWriteFailure(new TypeError('offline')) === 'retry'
      && classifyWriteFailure(new PatientDataError('x', null, { kind: 'network', status: null })) === 'retry');
    assert('5xx retries', classifyWriteFailure(http(500)) === 'retry' && classifyWriteFailure(http(503)) === 'retry');
    assert('transient 4xx retries', [401, 408, 425, 429].every(s => classifyWriteFailure(http(s)) === 'retry'));
    assert('other 4xx are permanent', [400, 403, 404, 409, 422].every(s => classifyWriteFailure(http(s)) === 'permanent'));

    WRITE_QUEUE_TUNING.maxAttempts = 3;
    let item = makeItem('w1', { kind: 'water', dateKey: TODAY_KEY, oz: 8 });
    item = markAttemptFailed(item, new TypeError('offline'), 1_000);
    assert('first failure re-arms with the base delay', item.status === 'pending' && item.attempts === 1 && item.nextAttemptAt === 3_000);
    item = markAttemptFailed(item, new TypeError('offline'), 3_000);
    assert('second failure doubles the wait', item.status === 'pending' && item.nextAttemptAt === 7_000);
    item = markAttemptFailed(item, new TypeError('offline'), 7_000);
    assert('the retry cap parks the item as failed', item.status === 'failed' && item.attempts === 3 && item.lastError === 'offline');
    const retried = markRetryRequested(item, 9_000);
    assert('manual retry resets attempts and is due now', retried.status === 'pending' && retried.attempts === 0 && retried.nextAttemptAt === 9_000 && retried.lastError === null);
    const rejected = markAttemptFailed(makeItem('w2', { kind: 'water', dateKey: TODAY_KEY, oz: 8 }), http(422), 1_000);
    assert('a permanent failure parks on the first attempt', rejected.status === 'failed' && rejected.attempts === 1);
    WRITE_QUEUE_TUNING.maxAttempts = 10;

    const pending = makeItem('a', { kind: 'water', dateKey: TODAY_KEY, oz: 8 });
    const failed = { ...makeItem('b', { kind: 'targets', partial: { calories: 1200 } }), status: 'failed' as const };
    assert('status precedence: offline beats everything', deriveSyncStatus([failed], false) === 'offline');
    assert('status precedence: attention beats syncing', deriveSyncStatus([pending, failed], true) === 'attention');
    assert('status: pending only is syncing', deriveSyncStatus([pending], true) === 'syncing');
    assert('status: empty online is idle', deriveSyncStatus([], true) === 'idle');

    const e1: MealLogEntry = { id: 'e1', ...entryInput('One') };
    const projected = projectQueue(EMPTY_PROJECTION, [
      makeItem('q1', { kind: 'entries', upsert: [e1] }),
      makeItem('q2', { kind: 'water', dateKey: TODAY_KEY, oz: 16 }),
      makeItem('q3', { kind: 'water', dateKey: TODAY_KEY, oz: 24 }),
      makeItem('q4', { kind: 'entries', upsert: [{ ...e1, quantity: 2 }] }, { editIds: ['e1'] }),
      makeItem('q5', { kind: 'targets', partial: { calories: 1300 } }),
    ]);
    assert('projection applies writes in order (last water wins, edit lands on the create)',
      projected.waterOverrides[TODAY_KEY] === 24
      && projected.addedEntries.length === 1 && projected.addedEntries[0].quantity === 2
      && projected.targetOverrides.calories === 1300);
    const deleted = projectQueue(projected, [makeItem('q6', { kind: 'entries', deleteIds: ['e1'] })]);
    assert('projection removes deleted rows', deleted.addedEntries.length === 0);

    const keys = pendingEntityKeys([
      makeItem('k1', { kind: 'entries', upsert: [e1], recents: ['fd_x'] }),
      makeItem('k2', { kind: 'water', dateKey: TODAY_KEY, oz: 8 }),
      makeItem('k3', { kind: 'checkIn', checkIn: { id: 'c1', dateKey: TODAY_KEY, mood: 3, sideEffects: [] } }),
      makeItem('k4', { kind: 'flags', flags: { nudgeOptOut: true } }),
    ]);
    assert('pending keys index every touched entity',
      keys.has('entry:e1') && keys.has('prefs') && keys.has(`water:${TODAY_KEY}`) && keys.has(`checkIn:${TODAY_KEY}`) && keys.has('flags') && keys.size === 5);

    const reconciled = reconcileQueue(
      [
        makeItem('r1', { kind: 'entries', upsert: [{ ...e1, quantity: 3 }] }, { editIds: ['e1'] }),
        makeItem('r2', { kind: 'entries', upsert: [{ id: 'e2', ...entryInput('Two') }] }),
        makeItem('r3', { kind: 'entries', upsert: [{ ...e1, quantity: 3 }, { id: 'e3', ...entryInput('Three') }] }, { editIds: ['e1'] }),
        makeItem('r4', { kind: 'water', dateKey: TODAY_KEY, oz: 8 }),
      ],
      { addedEntries: [], customFoods: [], savedRecipes: [], photos: [] },
    );
    assert('reconcile drops an edit of a row the server no longer has',
      !reconciled.some(i => i.id === 'r1'));
    assert('reconcile keeps creates and whole-value writes',
      reconciled.some(i => i.id === 'r2') && reconciled.some(i => i.id === 'r4'));
    const r3 = reconciled.find(i => i.id === 'r3');
    assert('reconcile prunes only the vanished row from a mixed write',
      r3 !== undefined && r3.payload.kind === 'entries' && r3.payload.upsert?.length === 1 && r3.payload.upsert[0].id === 'e3' && (r3.editIds ?? []).length === 0);

    const upload = makeItem('u1', {
      kind: 'photoUpload',
      photo: { id: 'ph1', dateKey: TODAY_KEY, label: 'Front', source: 'user', uri: 'data:image/jpeg;base64,AAAA' },
    });
    const raw = serializeQueue([upload, pending]);
    assert('photo bytes never ride the queue file', !raw.includes('base64,AAAA') && raw.includes('"ph1"'));
    const parsed = parseQueue(raw);
    assert('the queue round-trips', parsed.length === 2 && parsed[0].id === 'u1' && parsed[1].id === 'a' && parsed[1].payload.kind === 'water');
    assert('garbage is tolerated', parseQueue('{not json').length === 0 && parseQueue('[1,{"id":"x"},{"id":"y","payload":{"kind":"water"}}]').length === 1);
  }

  // Shrink the clock for the live sections.
  WRITE_QUEUE_TUNING.baseDelayMs = 10;
  WRITE_QUEUE_TUNING.maxDelayMs = 80;
  WRITE_QUEUE_TUNING.maxAttempts = 10;

  // ── 2 · Offline writes are accepted locally, in order ──────────────────────
  section('offline: writes accepted locally, pending markers, ordered per-account queue, nothing sent');
  await signIn(P1);
  let tree = await mountLive();
  assert('p-1 resolves as a real account with the queue enabled', account.account.kind === 'real' && sync.enabled && sync.status === 'idle');
  assert('no chip while idle', !syncChipVisible(sync) && byTestID(tree, 'patient-sync-chip') === null);

  await goOffline();
  assert('offline status without pending writes', sync.status === 'offline' && !sync.online);
  assert('chip shows Offline', textOf(byTestID(tree, 'patient-sync-chip-label')) === 'Offline');

  const writesBefore = writeCalls().length;
  await act(async () => {
    await ctx.addEntry(entryInput('Offline Oats', { refId: 'fd_oats' }));
  });
  await act(async () => {
    await ctx.setWater(TODAY_KEY, 16);
  });
  await act(async () => {
    await ctx.setWater(TODAY_KEY, 32);
  });
  await act(async () => {
    await ctx.setTargets({ calories: 1350 });
  });
  await act(async () => {
    await ctx.toggleFavorite('fd_chicken');
  });
  await act(async () => {
    await ctx.addCheckIn({ dateKey: TODAY_KEY, mood: 4, sideEffects: ['Nausea'], weight: 181 });
  });
  await settle();
  const oats = entryNamed('Offline Oats');
  assert('the entry shows immediately', oats !== undefined);
  assert('water shows the latest value', ctx.waterFor(TODAY_KEY) === 32);
  assert('targets, favorites, and the check-in show immediately',
    ctx.targets.calories === 1350 && ctx.favorites.includes('fd_chicken') && ctx.checkIns.some(c => c.dateKey === TODAY_KEY && c.mood === 4));
  assert('every touched entity is marked pending',
    sync.isPending(`entry:${oats!.id}`) && sync.isPending(`water:${TODAY_KEY}`) && sync.isPending('targets')
    && sync.isPending('prefs') && sync.isPending(`checkIn:${TODAY_KEY}`));
  assert('untouched entities are not pending', !sync.isPending('entry:nope') && !sync.isPending('flags'));
  assert('nothing was sent while offline', writeCalls().length === writesBefore);
  assert('no blocking notice for offline writes', notice === null);
  const kinds = sync.items.map(i => i.payload.kind);
  assert('the queue keeps creation order', kinds.join(',') === 'entries,water,water,targets,prefs,checkIn');
  assert('queue items carry plain-words summaries', sync.items.every(i => i.summary.length > 0) && sync.items[0].summary === 'Logged Offline Oats');
  assert('status reads offline with the count', sync.status === 'offline' && sync.pendingCount === 6
    && syncChipLabel(sync) === 'Offline · 6 changes waiting'
    && textOf(byTestID(tree, 'patient-sync-chip-label')) === 'Offline · 6 changes waiting');
  const disk = queueOnDisk('p-1');
  assert('the queue is persisted under the account key', disk.length === 6 && disk.map(i => i.id).join() === sync.items.map(i => i.id).join());
  assert('the demo storage key is untouched', !(localStorageBacking.get(STORAGE_KEY) ?? '').includes('Offline Oats'));

  // ── 3 · Reconnect replays in order ─────────────────────────────────────────
  section('reconnect: ordered replay, server mirrors the phone, chip flashes Up to date');
  const queuedIds = sync.items.map(i => i.id);
  await goOnline();
  await waitFor('the queue drains after reconnect', () => sync.items.length === 0);
  const replayed = writeCalls().slice(writesBefore);
  assert('every write reached the server exactly once, in queue order',
    replayed.length === 6 && replayed.map(c => c.idempotencyKey).join() === queuedIds.join());
  assert('each request carries its queue id as the idempotency key', replayed.every(c => c.idempotencyKey !== null));
  const store1 = storeFor('p-1');
  assert('server store mirrors the phone', store1.entries.some(e => e.name === 'Offline Oats')
    && store1.water[TODAY_KEY] === 32 && store1.targets.calories === 1350 && store1.favorites.includes('fd_chicken')
    && store1.checkIns.some(c => c.dateKey === TODAY_KEY && c.mood === 4) && store1.recents[0] === 'fd_oats');
  assert('pending markers clear once acknowledged',
    !sync.isPending(`entry:${oats!.id}`) && !sync.isPending(`water:${TODAY_KEY}`) && !sync.isPending('targets') && !sync.isPending('prefs'));
  assert('the chip flashes Up to date', sync.status === 'idle' && sync.justSynced && syncChipVisible(sync)
    && textOf(byTestID(tree, 'patient-sync-chip-label')) === 'Up to date');
  assert('the persisted queue is empty', queueOnDisk('p-1').length === 0);
  assert('local state still shows everything', entryNamed('Offline Oats') !== undefined && ctx.waterFor(TODAY_KEY) === 32);

  // ── 4 · Foregrounding replays too ──────────────────────────────────────────
  section('foreground: a queue stranded by a silent reconnect drains when the app becomes active');
  await goOffline();
  await act(async () => {
    await ctx.addEntry(entryInput('Foreground Fig'));
  });
  await settle();
  assert('the write queues offline', sync.items.length === 1 && sync.status === 'offline');
  // Connectivity comes back while no listener hears it (events dropped in
  // the background): the queue must not stay stranded until the next write.
  setConnectivityOverride(true, { silent: true });
  await tick(30);
  assert('nothing drains without a trigger', sync.items.length === 1);
  await act(async () => {
    emitAppStateChange('active');
  });
  await waitFor('foregrounding drains the queue', () => sync.items.length === 0);
  assert('the foreground replay landed', storeFor('p-1').entries.some(e => e.name === 'Foreground Fig') && sync.online);

  // ── 5 · Backoff, retry cap, permanent failures ─────────────────────────────
  section('failures: exponential backoff, retry cap → needs attention, 4xx parks without blocking');
  // A retrying write holds the line: later writes wait behind it.
  failTimes('PUT patient-data/water', 2, 'network');
  const orderedBefore = writeCalls().length;
  await act(async () => {
    await ctx.setWater(TODAY_KEY, 36);
  });
  await act(async () => {
    await ctx.setTargets({ waterOz: 80 });
  });
  await waitFor('both eventually land', () => storeFor('p-1').targets.waterOz === 80 && storeFor('p-1').water[TODAY_KEY] === 36);
  assert('a later write never overtakes a retrying one',
    writeCalls().slice(orderedBefore).map(c => c.path).join() === 'patient-data/water,patient-data/water,patient-data/water,patient-data/targets');
  await waitFor('queue empty after the ordered replay', () => sync.items.length === 0);

  WRITE_QUEUE_TUNING.maxAttempts = 3;
  failTimes('PUT patient-data/water', 3, 'network');
  const waterCallsBefore = callsTo('patient-data/water').length;
  await act(async () => {
    await ctx.setWater(TODAY_KEY, 40);
  });
  await waitFor('three attempts are made', () => callsTo('patient-data/water').length === waterCallsBefore + 3);
  await settle();
  const attempts = callsTo('patient-data/water').slice(waterCallsBefore);
  const gap1 = attempts[1].at - attempts[0].at;
  const gap2 = attempts[2].at - attempts[1].at;
  assert('each retry waits longer than the last (exponential backoff)', gap1 >= 10 && gap2 >= 20 && gap2 > gap1);
  assert('all attempts reuse the same idempotency key', new Set(attempts.map(a => a.idempotencyKey)).size === 1);
  const parked = sync.items[0];
  assert('the retry cap parks the item as failed', parked !== undefined && parked.status === 'failed' && parked.attempts === 3);
  assert('status needs attention', sync.status === 'attention' && sync.failedCount === 1 && sync.pendingCount === 0
    && textOf(byTestID(tree, 'patient-sync-chip-label')) === '1 change needs attention');
  assert('the value stays on the phone while parked', ctx.waterFor(TODAY_KEY) === 40 && sync.isPending(`water:${TODAY_KEY}`));
  await tick(120);
  assert('a parked item is not retried on its own', callsTo('patient-data/water').length === waterCallsBefore + 3);

  // A later write is not stuck behind the parked one.
  await act(async () => {
    await ctx.setTargets({ protein: 130 });
  });
  await waitFor('a later write lands past the parked item', () => storeFor('p-1').targets.protein === 130);
  assert('the parked item is still waiting', sync.items.length === 1 && sync.items[0].status === 'failed');

  // Manual retry from the sheet.
  assert('the sheet opens from the chip', await press(tree, 'patient-sync-chip') && byTestID(tree, 'patient-sync-sheet') !== null);
  assert('the sheet lists the failed item with its error',
    byTestID(tree, `patient-sync-item-${parked.id}`) !== null
    && /couldn.t reach|didn.t save|network|try again/i.test(textOf(byTestID(tree, `patient-sync-item-${parked.id}`))));
  assert('retry is offered', await press(tree, `patient-sync-retry-${parked.id}`));
  await waitFor('retry sends the write and it lands', () => storeFor('p-1').water[TODAY_KEY] === 40 && sync.items.length === 0);
  assert('the sheet shows nothing waiting after the retry', byTestID(tree, 'patient-sync-sheet') !== null
    && /everything is saved/i.test(textOf(byTestID(tree, 'patient-sync-sheet-headline')))
    && /nothing waiting to sync/i.test(textOf(byTestID(tree, 'patient-sync-sheet'))));
  await press(tree, 'patient-sync-sheet-close');
  assert('the sheet closes', byTestID(tree, 'patient-sync-sheet') === null);

  // A 4xx parks immediately; discard drops it and the local state reverts to server truth.
  failTimes('POST patient-data/entries', 1, { status: 422, body: { error: 'That entry is not valid.' } });
  await act(async () => {
    await ctx.addEntry(entryInput('Rejected Rice'));
  });
  await waitFor('a 4xx parks on the first attempt', () => sync.items.length === 1 && sync.items[0].status === 'failed');
  const rejectedItem = sync.items[0];
  assert('the row is still on the phone while parked', entryNamed('Rejected Rice') !== undefined && rejectedItem.attempts === 1
    && rejectedItem.lastError === 'That entry is not valid.');
  await press(tree, 'patient-sync-chip');
  assert('discard is offered for the failed item', await press(tree, `patient-sync-discard-${rejectedItem.id}`));
  await settle();
  assert('discard drops the item and the row (server truth wins)', sync.items.length === 0
    && entryNamed('Rejected Rice') === undefined && !storeFor('p-1').entries.some(e => e.name === 'Rejected Rice'));
  assert('earlier synced rows survive the discard recompute', entryNamed('Offline Oats') !== undefined && ctx.waterFor(TODAY_KEY) === 40);
  await press(tree, 'patient-sync-sheet-close');

  // Food submissions expose their immutable basket after a later rejection,
  // and retry the SAME queue/idempotency key and entry ids.
  failTimes('POST patient-data/entries', 1, { status: 422, body: { error: 'Nutrition facts were rejected.' } });
  let foodReceipt: Awaited<ReturnType<typeof ctx.submitFoodEntries>> | undefined;
  await act(async () => {
    foodReceipt = await ctx.submitFoodEntries([
      entryInput('Recoverable Eggs'),
      entryInput('Recoverable Oats'),
    ]);
  });
  assert('food submission is honestly accepted as queued',
    foodReceipt?.outcome === 'queued' && typeof foodReceipt.queueId === 'string');
  await waitFor('the later food rejection remains recoverable',
    () => sync.foodSubmissions.length === 1 && sync.foodSubmissions[0].status === 'rejected');
  const recoverable = sync.foodSubmissions[0];
  const originalEntryIds = recoverable.entries.map(entry => entry.id).join();
  assert('recoverable submission exposes the original basket and error',
    recoverable.queueId === (foodReceipt?.outcome === 'queued' ? foodReceipt.queueId : '')
    && recoverable.entries.map(entry => entry.name).join() === 'Recoverable Eggs,Recoverable Oats'
    && recoverable.message === 'Nutrition facts were rejected.');
  const submissionCallsBefore = callsTo('patient-data/entries').length;
  await act(async () => {
    assert('narrow retry accepts a recoverable food queue id', sync.retryFoodSubmission(recoverable.queueId));
  });
  await waitFor('food retry lands and clears recovery state',
    () => sync.foodSubmissions.length === 0
      && storeFor('p-1').entries.some(entry => entry.name === 'Recoverable Eggs'));
  const retriedCall = callsTo('patient-data/entries')[submissionCallsBefore];
  assert('food retry reuses the queue id and exact entry ids',
    retriedCall.idempotencyKey === recoverable.queueId
    && (retriedCall.body as any).upsert.map((entry: any) => entry.id).join() === originalEntryIds);
  assert('narrow retry refuses a queue id that is no longer pending',
    !sync.retryFoodSubmission(recoverable.queueId));

  // Retry all with two failed items.
  failTimes('PUT patient-data/targets', 1, { status: 409, body: { error: 'Conflict.' } });
  await act(async () => {
    await ctx.setTargets({ carbs: 90 });
  });
  await waitFor('first item parks', () => sync.failedCount === 1);
  failTimes('PUT patient-data/water', 1, { status: 400, body: { error: 'Bad water.' } });
  await act(async () => {
    await ctx.setWater(TODAY_KEY, 48);
  });
  await waitFor('second item parks', () => sync.failedCount === 2);
  assert('the chip counts both', textOf(byTestID(tree, 'patient-sync-chip-label')) === '2 changes need attention');
  await press(tree, 'patient-sync-chip');
  assert('retry all is offered when more than one item failed', await press(tree, 'patient-sync-retry-all'));
  await waitFor('retry all lands both', () => sync.items.length === 0 && storeFor('p-1').targets.carbs === 90 && storeFor('p-1').water[TODAY_KEY] === 48);
  await press(tree, 'patient-sync-sheet-close');
  WRITE_QUEUE_TUNING.maxAttempts = 10;

  // ── 6 · Idempotent replay after a lost response ────────────────────────────
  section('idempotency: a lost response replays with the same key and the server answers from its receipt');
  loseResponseNext.add('POST patient-data/entries');
  const entryCallsBefore = callsTo('patient-data/entries').length;
  await act(async () => {
    await ctx.addEntry(entryInput('Lost Lentils'));
  });
  await waitFor('the client replays after the lost response', () => callsTo('patient-data/entries').length === entryCallsBefore + 2 && sync.items.length === 0);
  const lost = callsTo('patient-data/entries').slice(entryCallsBefore);
  assert('both requests carry the same key', lost[0].idempotencyKey === lost[1].idempotencyKey && lost[0].idempotencyKey !== null);
  assert('the server answered the replay from its receipt', !lost[0].replayed && lost[1].replayed);
  assert('exactly one row exists on the server', storeFor('p-1').entries.filter(e => e.name === 'Lost Lentils').length === 1);
  assert('the phone shows exactly one row', ctx.allEntries.filter(e => e.name === 'Lost Lentils').length === 1);

  // ── 7 · Conflict: server deletions win; creates survive relaunch ───────────
  section('conflict: a queued edit of a server-deleted row is dropped; queued creates survive a relaunch');
  const lentils = entryNamed('Lost Lentils')!;
  await goOffline();
  await act(async () => {
    await ctx.updateEntry(lentils.id, { quantity: 3 });
  });
  await act(async () => {
    await ctx.addEntry(entryInput('Survivor Salad'));
  });
  await settle();
  assert('edit and create are queued offline', sync.items.length === 2 && ctx.allEntries.find(e => e.id === lentils.id)?.quantity === 3);
  // The app is killed while offline; meanwhile staff delete the lentils row.
  await unmount(tree);
  storeFor('p-1').entries = storeFor('p-1').entries.filter(e => e.id !== lentils.id);
  assert('the queue survived the relaunch on disk', queueOnDisk('p-1').length === 2);
  // A genuinely dead network on relaunch: the account lookup and the diary
  // GET both fail. The last-known role and the cached snapshot carry it —
  // including through the session-loading phase every cold start has.
  networkDead = true;
  setStubSessionLoadingTicks(1);
  const readsBefore = apiCalls.length;
  tree = await mountLive();
  assert('the remembered role survives the session-loading phase', localStorageBacking.has('thinnr_account_role_v1'));
  assert('the relaunch really had no network', apiCalls.slice(readsBefore).length > 0 && apiCalls.slice(readsBefore).every(c => c.method === 'GET' || isPresencePing(c)));
  assert('offline relaunch still resolves the same real account from its last-known role',
    account.account.kind === 'real' && account.account.patientId === 'p-1' && account.accountNotice === null);
  assert('offline relaunch opens on the last synced diary with the queue applied',
    ctx.hydrated && entryNamed('Survivor Salad') !== undefined && entryNamed('Offline Oats') !== undefined
    && ctx.allEntries.find(e => e.id === lentils.id)?.quantity === 3 && sync.items.length === 2 && sync.status === 'offline');
  await act(async () => {
    await ctx.setWater(TODAY_KEY, 56);
  });
  await settle();
  assert('writes are still accepted on an offline relaunch', ctx.waterFor(TODAY_KEY) === 56 && sync.items.length === 3);
  networkDead = false;
  await goOnline();
  await waitFor('the queue drains after the relaunch reconnects', () => sync.items.length === 0);
  await waitFor('reconnecting re-hydrates from the server', () => ctx.allEntries.every(e => e.id !== lentils.id));
  assert('the relaunch water landed', storeFor('p-1').water[TODAY_KEY] === 56);
  assert('the deleted row is not resurrected by the queued edit',
    !storeFor('p-1').entries.some(e => e.id === lentils.id) && ctx.allEntries.every(e => e.id !== lentils.id));
  assert('no upsert of the deleted row was ever sent',
    !callsTo('patient-data/entries').some(c => ((c.body?.upsert as MealLogEntry[] | undefined) ?? []).some(e => e.id === lentils.id && e.quantity === 3)));
  assert('the queued create landed', storeFor('p-1').entries.some(e => e.name === 'Survivor Salad') && entryNamed('Survivor Salad') !== undefined);

  // ── 8 · Account boundaries ─────────────────────────────────────────────────
  section('photos: a queued upload pins one server object — a lost finalize response re-uses it, never leaks a second');
  {
    const store = storeFor('p-1');
    const mintsBefore = store.minted.length;
    // Finalize APPLIES (ledger row registered) but its answer is lost: the
    // classic "did it land?" ambiguity for a multi-step upload.
    loseResponseNext.add('POST patient-media/finalize');
    await act(async () => {
      await ctx.addPhoto({ dateKey: TODAY_KEY, label: 'Week 2 Front', uri: JPEG_DATA_URI });
    });
    await waitFor('the photo upload drains after the retry', () => sync.items.length === 0 && store.photos.length === 1);
    const mints = store.minted.slice(mintsBefore);
    const uploadCalls = callsTo('patient-media/upload-url').slice(-mints.length);
    const gridPhoto = store.photos[0];
    assert('the upload was minted twice (first finalize answer lost, then the retry)', mints.length === 2);
    assert('both mints pinned the same upload id — the photo id', uploadCalls.length === 2
      && uploadCalls.every(c => c.body?.uploadId === gridPhoto.id));
    assert('both mints named the SAME object path', mints[0] === mints[1]);
    assert('exactly one object and one ledger row exist for the photo', store.objects.size === 1 && store.ledger.size === 1 && store.ledger.has(mints[0]));
    assert('the grid row references that object', gridPhoto.objectPath === mints[0]);
    assert('the phone shows the photo with its stored path (no local bytes left)',
      ctx.photos.some(p => p.id === gridPhoto.id && p.objectPath === mints[0] && !p.uri));
    // A stale in-session upload id (guided session) flows through addPhotos
    // to the queued upload unchanged, so a shot whose in-session upload was
    // cut off re-uses that object too.
    await act(async () => {
      await ctx.addPhotos([{ dateKey: TODAY_KEY, label: 'Week 2 Side', angle: 'side', uri: JPEG_DATA_URI, uploadId: 'gp_session1.side' }]);
    });
    await waitFor('the guided shot drains', () => sync.items.length === 0 && store.photos.length === 2);
    const sideMint = callsTo('patient-media/upload-url').slice(-1)[0];
    assert('a guided shot keeps its session upload id', sideMint?.body?.uploadId === 'gp_session1.side'
      && store.minted.slice(-1)[0] === mintedPath('p-1', 'progress', 'gp_session1.side'));
  }

  section('accounts: switching never shows or sends the other queue; demo untouched; each resumes its own');
  await goOffline();
  await act(async () => {
    await ctx.addEntry(entryInput('P1 Pending Pear'));
  });
  await settle();
  const p1Pending = sync.items.map(i => i.id);
  assert('p-1 has one pending write', p1Pending.length === 1);

  await signIn(P2);
  assert('p-2 resolves', account.account.kind === 'real' && account.account.patientId === 'p-2');
  assert('p-2 never sees p-1’s queue or rows', sync.items.length === 0 && entryNamed('P1 Pending Pear') === undefined && entryNamed('Offline Oats') === undefined);
  await act(async () => {
    await ctx.setWater(TODAY_KEY, 8);
  });
  await settle();
  assert('p-2 queues its own write offline', sync.items.length === 1 && sync.items[0].payload.kind === 'water');
  assert('each account’s queue lives under its own key', queueOnDisk('p-1').length === 1 && queueOnDisk('p-2').length === 1);

  await signIn(null);
  assert('sign-out returns the demo persona with the queue disabled', account.account.kind === 'demo' && !sync.enabled && sync.items.length === 0);
  assert('sign-out forgets the remembered role', !localStorageBacking.has('thinnr_account_role_v1'));
  assert('demo diary has no account rows', entryNamed('P1 Pending Pear') === undefined && entryNamed('Offline Oats') === undefined && ctx.allEntries.length > 0);
  assert('no chip for the demo persona', byTestID(tree, 'patient-sync-chip') === null);
  await act(async () => {
    await ctx.addEntry(entryInput('Demo Marker'));
  });
  await settle();
  assert('demo writes stay local and never queue', entryNamed('Demo Marker') !== undefined && sync.items.length === 0
    && (localStorageBacking.get(STORAGE_KEY) ?? '').includes('Demo Marker'));
  const p1WritesBeforeReturn = writeCalls().filter(c => c.token === 'tok-p1').length;
  const p2WritesBeforeReturn = writeCalls().filter(c => c.token === 'tok-p2').length;

  await signIn(P1);
  assert('p-1 resumes its own queue on return', sync.enabled && sync.items.length === 1 && sync.items[0].id === p1Pending[0]
    && entryNamed('P1 Pending Pear') !== undefined && entryNamed('Demo Marker') === undefined);
  await goOnline();
  await waitFor('p-1’s queue drains', () => sync.items.length === 0);
  assert('p-1’s write went to p-1 only', storeFor('p-1').entries.some(e => e.name === 'P1 Pending Pear')
    && !storeFor('p-2').entries.some(e => e.name === 'P1 Pending Pear')
    && writeCalls().filter(c => c.token === 'tok-p1').length === p1WritesBeforeReturn + 1);
  assert('p-2’s queue was neither sent nor dropped', writeCalls().filter(c => c.token === 'tok-p2').length === p2WritesBeforeReturn
    && queueOnDisk('p-2').length === 1 && storeFor('p-2').water[TODAY_KEY] === undefined);

  await signIn(P2);
  await waitFor('p-2’s queue drains on its own sign-in', () => sync.items.length === 0 && storeFor('p-2').water[TODAY_KEY] === 8);
  assert('p-2’s write carried p-2’s token', writeCalls().filter(c => c.token === 'tok-p2').slice(-1)[0]?.path === 'patient-data/water');

  await signIn(null);
  await unmount(tree);
  setConnectivityOverride(null);

  // ── Verdict ─────────────────────────────────────────────────────────────────
  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) {
    process.exitCode = 1;
  } else {
    console.log('offline-queue: all good');
  }
}

main().catch(error => {
  console.error('suite crashed:', error);
  process.exitCode = 1;
});
