/**
 * Account-backed foods library check (real-account mode).
 *
 * Renders the REAL PatientAccountProvider + PatientProvider under Node via
 * react-test-renderer (tsconfig.library-sync.json remaps native-only modules
 * to the shared onboarding-gate stubs and @/lib/supabase to a session
 * emitter) and drives the custom-food / saved-recipe slices against a
 * scripted patient-data + patient-media API with a per-patient in-memory
 * server store:
 *
 *   1. The demo persona is untouched: library items save locally under the
 *      original storage key, photos stay inline data URIs, zero network.
 *   2. A real patient's library lives on the account: creates, edits,
 *      deletes and undo write through POST /patient-data/library; photo
 *      data URIs ride the patient-media rail (upload-url → PUT → finalize)
 *      and rows carry photoPath — never base64 — on the wire.
 *   3. A remount ("new phone / reinstall") rebuilds the whole library from
 *      the server alone: items, photos as display URLs, client constants
 *      (category, source) re-injected.
 *   4. Failures behave: a failed library write stays on the phone as a
 *      pending item and replays with backoff; a failed photo upload saves
 *      the item photo-less, quietly.
 *   5. Accounts never bleed: a second account starts empty, and real
 *      accounts never persist library slices into device storage.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:library-sync
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
import { TODAY_KEY, type FoodItem, type MealLogEntry, type SavedRecipe } from '../data/patient-data';
import { parseNutritionSnapshot } from '../data/food-nutrition';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';
import { holdNextImpact, releaseImpact } from './onboarding-gate-stubs/expo-haptics';

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
const API_ORIGIN = 'https://thinnr.test';

// Tiny but real base64 payloads — decodeBase64 must round-trip them.
const FOOD_PHOTO_URI = `data:image/jpeg;base64,${Buffer.from('fake-food-jpeg-bytes').toString('base64')}`;
const RECIPE_PHOTO_URI = `data:image/png;base64,${Buffer.from('fake-recipe-png-bytes-longer').toString('base64')}`;

// ─── Scripted patient-data + patient-media API, per-patient store ────────────

interface ServerStore {
  entries: MealLogEntry[];
  favorites: string[];
  recents: string[];
  /** Library rows exactly as the wire delivered them (validated shapes). */
  customFoods: Array<Record<string, unknown>>;
  catalogFoods: Array<Record<string, unknown>>;
  savedRecipes: Array<Record<string, unknown>>;
}

interface StoredObject {
  patientId: string;
  kind: string;
  contentType: string;
  putBytes: number;
  finalized: boolean;
}

interface ApiCall {
  method: string;
  path: string; // e.g. "patient-data/library", "patient-media/upload-url"
  query: URLSearchParams;
  token: string | null;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
}

type Scripted = { status: number; body: unknown };

const serverStores = new Map<string, ServerStore>();
/** object path → stored object (the fake App Storage + patient_media ledger). */
const storedObjects = new Map<string, StoredObject>();
/** access token → whoami answer */
const tokenRoles = new Map<string, { kind: string; patientId?: string }>();
const apiCalls: ApiCall[] = [];
/** one-shot failures keyed `${method} ${path}`; 'network' throws like a dead link */
const failNext = new Map<string, Scripted | 'network'>();
let mintSeq = 0;

function storeFor(patientId: string): ServerStore {
  let store = serverStores.get(patientId);
  if (!store) {
    store = { entries: [], favorites: [], recents: [], customFoods: [], catalogFoods: [], savedRecipes: [] };
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

function upsertRows(target: Array<Record<string, unknown>>, rows: Array<Record<string, unknown>>) {
  for (const row of rows) {
    const index = target.findIndex(r => r.id === row.id);
    if (index >= 0) target[index] = row; // edits keep insertion order, like created_at
    else target.push(row);
  }
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
  const store = storeFor(patientId);

  if (key === 'GET patient-data/profile') {
    return {
      status: 200,
      body: {
        profile: {
          firstName: 'Library',
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
    const todayKey = call.query.get('today') ?? '2026-09-01';
    return {
      status: 200,
      body: {
        entries: store.entries,
        water: {},
        targets: {},
        favorites: store.favorites,
        recents: store.recents,
        // As the server responds: stored wire rows plus injected constants.
        customFoods: store.customFoods.map(row => ({ ...row, category: 'My Foods' })),
        catalogFoods: store.catalogFoods.map(row => ({ ...row, category: 'Catalog' })),
        savedRecipes: store.savedRecipes.map(row => ({ ...row, source: 'coach' })),
        entry: {
          firstName: patientId === 'p-1' ? 'Invited' : 'Signup',
          programStartDate: patientId === 'p-1' ? '2026-08-20' : todayKey,
          todayKey,
          programDay: patientId === 'p-1' ? 12 : 1,
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
    if (body.recents !== undefined) store.recents = body.recents as string[];
    return { status: 200, body: { ok: true } };
  }
  if (key === 'PUT patient-data/prefs') {
    const body = call.body ?? {};
    if (body.favorites !== undefined) store.favorites = body.favorites as string[];
    if (body.recents !== undefined) store.recents = body.recents as string[];
    return { status: 200, body: { ok: true } };
  }
  if (key === 'POST patient-data/library') {
    const body = call.body ?? {};
    // Atomic like the RPC: validate photo ownership across the whole batch
    // before touching anything.
    for (const row of [
      ...((body.foodUpsert as Array<Record<string, unknown>> | undefined) ?? []),
      ...((body.recipeUpsert as Array<Record<string, unknown>> | undefined) ?? []),
    ]) {
      const photoPath = row.photoPath;
      if (
        photoPath !== undefined &&
        (typeof photoPath !== 'string' ||
          !photoPath.startsWith(`/objects/patient-media/${patientId}/`))
      ) {
        return { status: 400, body: { error: 'Photo reference is invalid.' } };
      }
    }
    const foodUpserts = (body.foodUpsert as Array<Record<string, unknown>> | undefined) ?? [];
    upsertRows(store.customFoods, foodUpserts.filter(row => row.catalogShared !== true));
    upsertRows(store.catalogFoods, foodUpserts.filter(row => row.catalogShared === true));
    upsertRows(store.savedRecipes, (body.recipeUpsert as Array<Record<string, unknown>> | undefined) ?? []);
    const foodDeleteIds = (body.foodDeleteIds as string[] | undefined) ?? [];
    if (foodDeleteIds.length > 0) {
      store.customFoods = store.customFoods.filter(r => !foodDeleteIds.includes(String(r.id)));
      store.catalogFoods = store.catalogFoods.filter(r => !foodDeleteIds.includes(String(r.id)));
    }
    const recipeDeleteIds = (body.recipeDeleteIds as string[] | undefined) ?? [];
    if (recipeDeleteIds.length > 0) {
      store.savedRecipes = store.savedRecipes.filter(r => !recipeDeleteIds.includes(String(r.id)));
    }
    if (body.favorites !== undefined) store.favorites = body.favorites as string[];
    if (body.recents !== undefined) store.recents = body.recents as string[];
    return { status: 200, body: { ok: true } };
  }
  if (key === 'POST patient-media/upload-url') {
    const body = call.body ?? {};
    const kind = String(body.kind);
    if (kind !== 'food' && kind !== 'recipe') {
      return { status: 400, body: { error: 'Invalid media kind.' } };
    }
    mintSeq += 1;
    const objectPath = `/objects/patient-media/${patientId}/${kind}-00000000-mint-${mintSeq}`;
    storedObjects.set(objectPath, {
      patientId,
      kind,
      contentType: String(body.contentType),
      putBytes: 0,
      finalized: false,
    });
    return {
      status: 200,
      body: {
        uploadUrl: `${API_ORIGIN}/api/storage-put${objectPath}`,
        objectPath,
      },
    };
  }
  if (key === 'POST patient-media/finalize') {
    const objectPath = String((call.body ?? {}).objectPath ?? '');
    const object = storedObjects.get(objectPath);
    if (!object || object.patientId !== patientId) {
      return { status: 400, body: { error: "That upload isn't yours to finalize." } };
    }
    if (object.putBytes === 0) {
      return { status: 404, body: { error: 'That upload never arrived.' } };
    }
    object.finalized = true;
    return {
      status: 200,
      body: { objectPath, sizeBytes: object.putBytes, contentType: object.contentType },
    };
  }
  throw new Error(`unscripted route: ${key}`);
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/api/')) {
    throw new Error(`unexpected fetch: ${url.href}`);
  }

  // The presigned storage PUT: raw bytes, no JSON body, no auth header.
  if (url.pathname.startsWith('/api/storage-put/')) {
    const objectPath = url.pathname.slice('/api/storage-put'.length);
    const object = storedObjects.get(objectPath);
    if (!object || (init?.method ?? '').toUpperCase() !== 'PUT') {
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }
    const body = init?.body;
    object.putBytes =
      body instanceof ArrayBuffer
        ? body.byteLength
        : ArrayBuffer.isView(body as ArrayBufferView)
          ? (body as ArrayBufferView).byteLength
          : String(body ?? '').length;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
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

function foodInput(name: string, overrides: Partial<Omit<FoodItem, 'id' | 'category'>> = {}): Omit<FoodItem, 'id' | 'category'> {
  return {
    name,
    serving: '1 bar (40g)',
    calories: 180,
    protein: 12,
    carbs: 14,
    fat: 7,
    ...overrides,
  };
}

function recipeInput(name: string, overrides: Partial<Omit<SavedRecipe, 'id'>> = {}): Omit<SavedRecipe, 'id'> {
  return {
    name,
    meal: 'dinner',
    tags: ['High protein'],
    minutes: 25,
    servings: 2,
    calories: 430,
    protein: 38,
    carbs: 31,
    fat: 15,
    description: 'A coach suggestion worth keeping.',
    ingredients: [
      { amount: 6, unit: 'oz', name: 'chicken breast', nutrition: { calories: 187, protein: 39, carbs: 0, fat: 2 } },
      { amount: 0, unit: '', name: 'salt' },
    ],
    steps: ['Season the chicken.', 'Sear and rest.'],
    source: 'coach',
    mode: 'recipe',
    savedAt: '2026-08-30T18:04:00.000Z',
    groceryList: ['chicken breast', 'salt'],
    ...overrides,
  };
}

const displayUrlFor = (photoPath: string) =>
  `${API_ORIGIN}/api/patient-media/file?path=${encodeURIComponent(photoPath)}`;

// ─── The walk ────────────────────────────────────────────────────────────────

async function main() {
  // ── 1 · Demo persona untouched ─────────────────────────────────────────────
  section('demo persona: library saves locally, photos stay data URIs, zero network');
  let tree = await mountDemo();
  assert('demo hydrates', ctx.hydrated);
  assert('demo account is the context default', account.account.kind === 'demo' && !account.resolving);
  let demoFood!: FoodItem;
  await act(async () => {
    demoFood = await ctx.addCustomFood(foodInput('Demo Jerky', { brand: 'Trailhead' }));
  });
  await act(async () => {
    await ctx.setCustomFoodPhoto(demoFood.id, FOOD_PHOTO_URI);
  });
  let demoRecipe!: SavedRecipe;
  await act(async () => {
    demoRecipe = await ctx.addSavedRecipe(recipeInput('Demo Chicken', { photoUri: RECIPE_PHOTO_URI }));
  });
  const demoFoodNow = ctx.customFoods.find(f => f.id === demoFood.id);
  const demoRecipeNow = ctx.savedRecipes.find(r => r.id === demoRecipe.id);
  assert('demo food saved with its data-URI photo inline', demoFoodNow?.photoUri === FOOD_PHOTO_URI && demoFoodNow?.photoPath === undefined);
  assert('demo recipe saved with its data-URI photo inline', demoRecipeNow?.photoUri === RECIPE_PHOTO_URI && demoRecipeNow?.photoPath === undefined);
  assert(
    'demo library persists under the original key',
    (localStorageBacking.get(STORAGE_KEY) ?? '').includes('Demo Jerky') &&
      (localStorageBacking.get(STORAGE_KEY) ?? '').includes('Demo Chicken'),
  );
  assert('demo mode makes zero API calls', apiCalls.length === 0);
  assert('demo mode stores no objects', storedObjects.size === 0);
  await unmount(tree);

  // ── 2 · Fresh real patient: empty library, no demo bleed ──────────────────
  section('fresh real patient: empty library');
  setStubSession(P1);
  tree = await mountLive();
  assert('account resolves to real p-1', account.account.kind === 'real');
  assert('real hydration completes', ctx.hydrated);
  assert('fresh library is empty — no demo bleed', ctx.customFoods.length === 0 && ctx.savedRecipes.length === 0);
  assert('no notice on clean hydration', notice === null);

  // ── 3 · Custom food CRUD writes through the account ───────────────────────
  section('custom food: create / photo attach / edit / delete / undo');

  let food!: FoodItem;
  await act(async () => {
    food = await ctx.addCustomFood(foodInput('P1 Protein Bar', { brand: 'Thinnr Kitchen' }));
  });
  const createCall = lastCallTo('patient-data/library');
  const createdWire = (createCall?.body?.foodUpsert as Array<Record<string, unknown>> | undefined)?.[0];
  assert('create posts one library call with the wire row', callsTo('patient-data/library').length === 1 && createdWire?.id === food.id);
  assert('wire row carries data fields, not display baggage', createdWire !== undefined
    && createdWire.name === 'P1 Protein Bar'
    && createdWire.brand === 'Thinnr Kitchen'
    && createdWire.calories === 180
    && !('category' in createdWire)
    && !('photoUri' in createdWire));
  assert('create is authenticated', createCall?.token === 'tok-p1');
  assert('server store holds the food', storeFor('p-1').customFoods.some(r => r.id === food.id));
  assert('the food shows in the library', ctx.customFoods.some(f => f.id === food.id && f.category === 'My Foods'));

  // Photo attach (the AI dish-photo backfill path): data URI → account rail.
  await act(async () => {
    await ctx.setCustomFoodPhoto(food.id, FOOD_PHOTO_URI);
  });
  const uploadCall = lastCallTo('patient-media/upload-url');
  assert('photo upload mints under kind food with real byte count', uploadCall !== undefined
    && uploadCall.body?.kind === 'food'
    && uploadCall.body?.contentType === 'image/jpeg'
    && uploadCall.body?.sizeBytes === Buffer.from('fake-food-jpeg-bytes').length
    && uploadCall.token === 'tok-p1');
  const foodAfterPhoto = ctx.customFoods.find(f => f.id === food.id);
  const foodPhotoPath = foodAfterPhoto?.photoPath;
  assert('the stored object was PUT and finalized', typeof foodPhotoPath === 'string'
    && storedObjects.get(foodPhotoPath!)?.finalized === true
    && (storedObjects.get(foodPhotoPath!)?.putBytes ?? 0) > 0);
  assert('the item now shows the account display URL, not base64',
    foodAfterPhoto?.photoUri === displayUrlFor(foodPhotoPath ?? ''));
  const photoWire = (lastCallTo('patient-data/library')?.body?.foodUpsert as Array<Record<string, unknown>> | undefined)?.[0];
  assert('the library row carries photoPath on the wire (never base64)',
    photoWire?.photoPath === foodPhotoPath && !('photoUri' in (photoWire ?? {})));
  assert('server row references the photo', storeFor('p-1').customFoods.find(r => r.id === food.id)?.photoPath === foodPhotoPath);

  // Edit with the photo untouched: the account reference rides along.
  await act(async () => {
    await ctx.updateCustomFood(food.id, {
      ...foodInput('P1 Protein Bar XL', { brand: 'Thinnr Kitchen' }),
      calories: 210,
      photoUri: foodAfterPhoto!.photoUri,
    });
  });
  const editWire = (lastCallTo('patient-data/library')?.body?.foodUpsert as Array<Record<string, unknown>> | undefined)?.[0];
  const editedFood = ctx.customFoods.find(f => f.id === food.id);
  assert('edit rebuilds the row and keeps the photo reference', editWire?.name === 'P1 Protein Bar XL'
    && editWire?.calories === 210
    && editWire?.photoPath === foodPhotoPath
    && editedFood?.photoUri === displayUrlFor(foodPhotoPath ?? '')
    && storeFor('p-1').customFoods.find(r => r.id === food.id)?.photoPath === foodPhotoPath);
  assert('edit keeps insertion order and count', storeFor('p-1').customFoods.length === 1);

  // Make the food favorited + recent so the delete strips references too.
  await act(async () => {
    await ctx.toggleFavorite(food.id);
  });
  await act(async () => {
    await ctx.addEntry({
      dateKey: TODAY_KEY,
      meal: 'snacks',
      kind: 'food',
      refId: food.id,
      name: editedFood!.name,
      detail: editedFood!.serving,
      quantity: 1,
      calories: editedFood!.calories,
      protein: editedFood!.protein,
      carbs: editedFood!.carbs,
      fat: editedFood!.fat,
    });
  });
  assert('food is favorited and recent on the server',
    storeFor('p-1').favorites.includes(food.id) && storeFor('p-1').recents[0] === food.id);

  const libraryCallsBeforeDelete = callsTo('patient-data/library').length;
  let removed: Awaited<ReturnType<Ctx['removeCustomFood']>> = null;
  await act(async () => {
    removed = await ctx.removeCustomFood(food.id);
  });
  const deleteCall = lastCallTo('patient-data/library');
  assert('delete returns the undo snapshot', removed !== null && removed!.food.id === food.id);
  assert('the snapshot keeps the photo reference for undo', removed!.food.photoPath === foodPhotoPath);
  assert('delete is ONE compound library call', callsTo('patient-data/library').length === libraryCallsBeforeDelete + 1
    && JSON.stringify(deleteCall?.body?.foodDeleteIds) === JSON.stringify([food.id])
    && JSON.stringify(deleteCall?.body?.favorites) === JSON.stringify([])
    && JSON.stringify(deleteCall?.body?.recents) === JSON.stringify([])
    && deleteCall?.body?.foodUpsert === undefined);
  assert('server row and references are gone', !storeFor('p-1').customFoods.some(r => r.id === food.id)
    && !storeFor('p-1').favorites.includes(food.id)
    && !storeFor('p-1').recents.includes(food.id));
  assert('deleted photo is no longer referenced by any account row',
    !storeFor('p-1').customFoods.some(r => r.photoPath === foodPhotoPath));

  await act(async () => {
    await ctx.restoreCustomFood(removed!);
  });
  const undoCall = lastCallTo('patient-data/library');
  const undoWire = (undoCall?.body?.foodUpsert as Array<Record<string, unknown>> | undefined)?.[0];
  assert('undo re-upserts the exact row with its photo reference', undoWire?.id === food.id
    && undoWire?.photoPath === foodPhotoPath
    && JSON.stringify(undoCall?.body?.favorites) === JSON.stringify([food.id])
    && JSON.stringify(undoCall?.body?.recents) === JSON.stringify([food.id]));
  assert('undo restores the server row, references, and photo',
    storeFor('p-1').customFoods.find(r => r.id === food.id)?.photoPath === foodPhotoPath
    && storeFor('p-1').favorites.includes(food.id)
    && storeFor('p-1').recents[0] === food.id);
  assert('undo restores the on-screen item with its display URL',
    ctx.customFoods.find(f => f.id === food.id)?.photoUri === displayUrlFor(foodPhotoPath ?? ''));

  // ── 4 · Saved recipe rides the same rail ───────────────────────────────────
  section('saved recipe: photo uploads first, row carries photoPath');
  let recipe!: SavedRecipe;
  await act(async () => {
    recipe = await ctx.addSavedRecipe(recipeInput('P1 Seared Chicken', { photoUri: RECIPE_PHOTO_URI }));
  });
  const recipeUpload = lastCallTo('patient-media/upload-url');
  const recipeWireRow = (lastCallTo('patient-data/library')?.body?.recipeUpsert as Array<Record<string, unknown>> | undefined)?.[0];
  const recipeNow = ctx.savedRecipes.find(r => r.id === recipe.id);
  const recipePhotoPath = recipeNow?.photoPath;
  assert('recipe photo minted under kind recipe as png', recipeUpload?.body?.kind === 'recipe'
    && recipeUpload?.body?.contentType === 'image/png');
  assert('recipe object stored and finalized', typeof recipePhotoPath === 'string'
    && storedObjects.get(recipePhotoPath!)?.finalized === true);
  assert('recipe wire row carries photoPath and full nutrition payload', recipeWireRow !== undefined
    && recipeWireRow.photoPath === recipePhotoPath
    && !('photoUri' in recipeWireRow)
    && !('source' in recipeWireRow)
    && recipeWireRow.savedAt === '2026-08-30T18:04:00.000Z'
    && Array.isArray(recipeWireRow.ingredients)
    && (recipeWireRow.ingredients as Array<Record<string, unknown>>).length === 2
    && ((recipeWireRow.ingredients as Array<Record<string, unknown>>)[0].nutrition as Record<string, unknown>).protein === 39
    && JSON.stringify(recipeWireRow.groceryList) === JSON.stringify(['chicken breast', 'salt']));
  assert('the saved recipe shows the display URL', recipeNow?.photoUri === displayUrlFor(recipePhotoPath ?? ''));

  // ── 5 · Reinstall: the library follows the account ─────────────────────────
  section('remount (new phone): library rebuilt from the server alone');
  await unmount(tree);
  tree = await mountLive();
  const rehydratedFood = ctx.customFoods.find(f => f.id === food.id);
  const rehydratedRecipe = ctx.savedRecipes.find(r => r.id === recipe.id);
  assert('custom food survives reinstall', rehydratedFood !== undefined
    && rehydratedFood.name === 'P1 Protein Bar XL'
    && rehydratedFood.brand === 'Thinnr Kitchen'
    && rehydratedFood.calories === 210
    && rehydratedFood.category === 'My Foods');
  assert('custom food photo survives as the display URL', rehydratedFood?.photoPath === foodPhotoPath
    && rehydratedFood?.photoUri === displayUrlFor(foodPhotoPath ?? ''));
  assert('saved recipe survives reinstall with client constants re-injected', rehydratedRecipe !== undefined
    && rehydratedRecipe.source === 'coach'
    && rehydratedRecipe.mode === 'recipe'
    && rehydratedRecipe.savedAt === '2026-08-30T18:04:00.000Z'
    && rehydratedRecipe.description === 'A coach suggestion worth keeping.'
    && rehydratedRecipe.ingredients.length === 2
    && rehydratedRecipe.ingredients[0].nutrition?.calories === 187
    && rehydratedRecipe.ingredients[1].nutrition === undefined
    && JSON.stringify(rehydratedRecipe.groceryList) === JSON.stringify(['chicken breast', 'salt']));
  assert('saved recipe photo survives as the display URL',
    rehydratedRecipe?.photoUri === displayUrlFor(recipePhotoPath ?? ''));
  assert('favorites and recents still reference the food', ctx.favorites.includes(food.id) && ctx.recents[0] === food.id);

  // Account-owned exact configurations must survive a cached launch when the
  // state endpoint is unavailable. The snapshot key is scoped by p-1 and must
  // not bleed through the demo/global local state.
  const exactSnapshot = parseNutritionSnapshot({
    version: 1,
    source: { provider: 'usda', recordId: '171077', revision: 'exact' },
    basis: { amount: 100, unit: 'g', label: '100 g' },
    nutrients: [
      { id: '1008', name: 'Energy', unit: 'kcal', amount: 155.123456 },
      { id: '1003', name: 'Protein', unit: 'g', amount: 12.58 },
      { id: '1005', name: 'Carbohydrate', unit: 'g', amount: 1.12 },
      { id: '1004', name: 'Fat', unit: 'g', amount: 10.61 },
    ],
    portions: [{
      id: 'egg', label: '1 egg', unit: 'egg', dimension: 'count',
      basisMultiplier: 0.5, grams: 50, evidence: 'USDA portion',
    }],
    selected: { amount: 2, unitId: 'egg', scale: 1 },
    provenance: 'generic_source',
  });
  assert('exact cached-launch fixture parses', Boolean(exactSnapshot));
  let exactFood: FoodItem | null = null;
  await act(async () => {
    exactFood = await ctx.saveFoodConfiguration({
      id: 'usda:171077',
      name: 'Exact Eggs',
      serving: '2 eggs',
      calories: 155.123456,
      protein: 12.58,
      carbs: 1.12,
      fat: 10.61,
      category: 'Catalog',
      nutritionSnapshot: exactSnapshot!,
    }, { favorite: true });
  });
  await waitFor('exact configuration is server-confirmed before restart',
    () => exactFood !== null
      && storeFor('p-1').catalogFoods.some(row => row.id === exactFood!.id)
      && sync.items.length === 0);
  await unmount(tree);
  failNext.set('GET patient-data/state', 'network');
  tree = await mountLive();
  assert('cached real-account restart keeps exact configuration and favorite',
    exactFood !== null
      && ctx.allFoods.some(item => item.id === exactFood!.id && item.nutritionSnapshot?.source.recordId === '171077')
      && ctx.favorites.includes(exactFood.id));
  assert('cached exact configuration remains scoped to its account key',
    !((localStorageBacking.get(STORAGE_KEY) ?? '').includes(exactFood?.id ?? 'cfg_missing')));

  // ── 6 · Failures: loud rollback for data, quiet photo-less save for photos ─
  section('failures: library write queues and replays, photo upload fails quietly');
  WRITE_QUEUE_TUNING.baseDelayMs = 5;
  WRITE_QUEUE_TUNING.maxDelayMs = 20;
  const foodsBefore = ctx.customFoods.length;
  failNext.set('POST patient-data/library', {
    status: 502,
    body: { error: 'Couldn’t save your library right now. Please try again.' },
  });
  await act(async () => {
    await ctx.addCustomFood(foodInput('Ghost Food'));
  });
  const ghostFood = ctx.customFoods.find(f => f.name === 'Ghost Food');
  assert('failed create stays on the phone, pending', ctx.customFoods.length === foodsBefore + 1
    && ghostFood !== undefined && sync.isPending(`food:${ghostFood.id}`)
    && !storeFor('p-1').customFoods.some(r => r.name === 'Ghost Food'));
  assert('a queued library write raises no blocking notice', notice === null && sync.status === 'syncing');
  await waitFor('the library write replays after backoff',
    () => storeFor('p-1').customFoods.some(r => r.name === 'Ghost Food'));
  await settle();
  assert('the replayed row clears its pending marker', !sync.isPending(`food:${ghostFood!.id}`) && sync.status === 'idle');
  const ghostCalls = callsTo('patient-data/library').slice(-2);
  assert('the replay reuses the original idempotency key', ghostCalls.length === 2
    && ghostCalls[0].idempotencyKey !== null && ghostCalls[0].idempotencyKey === ghostCalls[1].idempotencyKey);

  // Photo upload failure: quiet, item saves photo-less.
  const uploadsBefore = callsTo('patient-media/upload-url').length;
  failNext.set('POST patient-media/upload-url', { status: 502, body: { error: 'Storage is down.' } });
  let photolessRecipe!: SavedRecipe;
  await act(async () => {
    photolessRecipe = await ctx.addSavedRecipe(recipeInput('P1 Backup Bowl', { photoUri: RECIPE_PHOTO_URI }));
  });
  const photolessWire = (lastCallTo('patient-data/library')?.body?.recipeUpsert as Array<Record<string, unknown>> | undefined)?.[0];
  const photolessNow = ctx.savedRecipes.find(r => r.id === photolessRecipe.id);
  assert('failed upload still saves the recipe — photo-less', photolessNow !== undefined
    && photolessNow.photoUri === undefined
    && photolessNow.photoPath === undefined
    && photolessWire?.id === photolessRecipe.id
    && !('photoPath' in (photolessWire ?? {})));
  assert('failed upload is quiet (no snackbar)', notice === null);
  assert('exactly one upload attempt was made', callsTo('patient-media/upload-url').length === uploadsBefore + 1);

  // Photo backfill failure (setCustomFoodPhoto): item keeps its last photo state.
  failNext.set('POST patient-media/upload-url', { status: 502, body: { error: 'Storage is down.' } });
  await act(async () => {
    await ctx.setCustomFoodPhoto(food.id, RECIPE_PHOTO_URI);
  });
  assert('failed photo patch leaves the item untouched and quiet',
    ctx.customFoods.find(f => f.id === food.id)?.photoUri === displayUrlFor(foodPhotoPath ?? '')
    && notice === null);

  // ── 7 · Accounts never bleed ───────────────────────────────────────────────
  section('account isolation: second account, local persistence, demo return');
  holdNextImpact();
  let staleAdd!: Promise<FoodItem>;
  await act(async () => {
    staleAdd = ctx.addCustomFood(foodInput('Must Not Change Owner'));
    await Promise.resolve();
  });
  await signIn(P2);
  await act(async () => {
    releaseImpact();
    await staleAdd;
  });
  assert('second account resolves', account.account.kind === 'real');
  assert('account switch during held haptic cannot change a custom food owner',
    !storeFor('p-1').customFoods.some(row => row.name === 'Must Not Change Owner')
      && !storeFor('p-2').customFoods.some(row => row.name === 'Must Not Change Owner')
      && !ctx.customFoods.some(item => item.name === 'Must Not Change Owner'));
  assert('second account starts with an empty library', ctx.customFoods.length === 0 && ctx.savedRecipes.length === 0);
  assert('p-1 cached exact configuration and favorite never bleed to p-2',
    exactFood !== null
      && !ctx.allFoods.some(item => item.id === exactFood!.id)
      && !ctx.favorites.includes(exactFood.id));
  await act(async () => {
    await ctx.addCustomFood(foodInput('P2 Yogurt'));
  });
  assert('p-2 write lands in the p-2 store only',
    storeFor('p-2').customFoods.some(r => r.name === 'P2 Yogurt')
    && !storeFor('p-1').customFoods.some(r => r.name === 'P2 Yogurt'));
  assert('p-1 library is untouched by the switch',
    storeFor('p-1').customFoods.some(r => r.id === food.id));

  const acct1Raw = localStorageBacking.get(`${STORAGE_KEY}:acct_p-1`) ?? '';
  const acct2Raw = localStorageBacking.get(`${STORAGE_KEY}:acct_p-2`) ?? '';
  assert('real accounts never persist library slices locally',
    [acct1Raw, acct2Raw].every(raw => {
      if (!raw) return true; // no local writes at all is fine too
      const parsed = JSON.parse(raw) as { customFoods?: unknown[]; savedRecipes?: unknown[] };
      return (parsed.customFoods ?? []).length === 0 && (parsed.savedRecipes ?? []).length === 0;
    }) && acct1Raw !== '');

  await signIn(null);
  assert('sign-out returns the demo library intact', account.account.kind === 'demo'
    && ctx.customFoods.some(f => f.name === 'Demo Jerky' && f.photoUri === FOOD_PHOTO_URI)
    && ctx.savedRecipes.some(r => r.name === 'Demo Chicken' && r.photoUri === RECIPE_PHOTO_URI));
  assert('no account rows leak into the demo library',
    !ctx.customFoods.some(f => f.name.startsWith('P1 ') || f.name.startsWith('P2 '))
    && !ctx.savedRecipes.some(r => r.name.startsWith('P1 '))
    && (exactFood === null || !ctx.allFoods.some(item => item.id === exactFood!.id)));

  await unmount(tree);
  setStubSession(null);

  // ── Verdict ─────────────────────────────────────────────────────────────────
  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) {
    process.exitCode = 1;
  } else {
    console.log('library-sync: all good');
  }
}

main().catch(error => {
  console.error('suite crashed:', error);
  process.exitCode = 1;
});
