/**
 * Client for the live per-patient diary rail (/api/patient-data/* on the API
 * server) plus the whoami lookup that decides real-account mode. Real
 * accounts only — the demo persona never touches these endpoints.
 *
 * Every call sends the patient's current Supabase access token as a bearer
 * header; the server resolves it to a patients row and scopes every read and
 * write to that patient. Failures are explicit: callers receive a
 * PatientDataError carrying plain words fit for the sync snackbar, never a
 * silent fallback.
 */
import { fetch as expoFetch } from 'expo/fetch';
import { Platform } from 'react-native';
import type {
  CheckIn,
  DailyTargets,
  FoodItem,
  IngredientAdjustment,
  IngredientNutrition,
  MealLogEntry,
  MealSlot,
  RecipeIngredient,
  SavedRecipe,
} from '@/data/patient-data';
import type {
  ChatThread,
  ChatThreadSnapshot,
  ChatWireMessage,
  ChatWirePhoto,
  LibraryWrite,
  PatientDataApi,
  PatientFlags,
  PatientFlagsWrite,
  PatientEntryFacts,
  PatientProfile,
  PatientProfileWrite,
  PatientSetupWrite,
  PatientServerState,
  ProgressPhotoWire,
  WriteOptions,
} from '@/context/PatientAccountContext';
import { parsePatientProfile } from '@/lib/patient-profile';
import { apiBase } from '@/lib/coach-api';
import { decodeBase64 } from '@/lib/base64';
import {
  appendMediaToken,
  setPatientMediaToken as setMediaTokenDirect,
} from '@/lib/media-token-holder';
import { supabase } from '@/lib/supabase';
import type { HealthMeasurement } from '@/lib/device-feature-core';
import {
  parseConsent,
  parseDeletion,
  parseExport,
  parsePrivacyState,
  PrivacyParseError,
  type ConsentWrite,
  type PrivacyState,
} from '@/lib/patient-privacy';

import { PatientDataError, patientDataErrorCode } from '@/lib/patient-data-error';

export { PatientDataError, patientDataErrorCode, type PatientDataErrorCode } from '@/lib/patient-data-error';

const NETWORK_MESSAGE = 'Couldn’t reach the server. Check your connection and try again.';
const MALFORMED_MESSAGE = 'The server sent something unexpected. Please try again.';
const SIGNED_OUT_MESSAGE = 'You’re signed out. Sign in again to sync your diary.';

const REQUEST_TIMEOUT_MS = 15_000;

/** Per-call options for the write rail (see WriteOptions on PatientDataApi). */
interface RequestOptions {
  accessToken?: string;
  /**
   * Client-generated idempotency key: the server replays the original
   * result for a repeated key instead of applying the write twice, which
   * is what lets the offline queue re-send a request whose response was
   * lost without duplicating data.
   */
  idempotencyKey?: string;
}
async function authedRequest(
  method: string,
  path: string,
  body?: unknown,
  options?: string | RequestOptions,
): Promise<unknown> {
  const opts: RequestOptions = typeof options === 'string' ? { accessToken: options } : options ?? {};
  let base: string;
  try {
    base = apiBase();
  } catch {
    throw new PatientDataError('This build isn’t configured to reach the server.', null, {
      kind: 'config',
    });
  }
  if (!supabase) {
    throw new PatientDataError('Sign-in isn’t configured in this build.', null, { kind: 'config' });
  }
  const token = opts.accessToken ?? (await supabase.auth.getSession()).data.session?.access_token;
  if (!token) throw new PatientDataError(SIGNED_OUT_MESSAGE, null, { kind: 'signedOut' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new PatientDataError(NETWORK_MESSAGE, null, { kind: 'network' });
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const failure = json as { error?: unknown; code?: unknown } | null;
    const message = failure?.error;
    throw new PatientDataError(
      typeof message === 'string' && message.length > 0
        ? message
        : 'The server couldn’t handle that. Please try again.',
      patientDataErrorCode(failure?.code),
      { kind: 'http', status: response.status },
    );
  }
  return json;
}

// ── Account resolution ───────────────────────────────────────────────────────

export type AccountRole = { kind: 'patient'; patientId: string } | { kind: 'other' };

/**
 * Current session bearer for streaming calls that authenticate per turn
 * (coach chat SSE). Null when signed out or sign-in isn't configured.
 */
export async function getSessionAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Resolves the signed-in session to an account kind via the claim flow's
 * whoami. Staff and demo-profile sessions come back 'other' (they browse the
 * seeded demo persona); only a linked patient row unlocks the live diary.
 */
export async function fetchAccountRole(): Promise<AccountRole> {
  const json = await authedRequest('GET', '/claim/whoami');
  const record = (json ?? {}) as Record<string, unknown>;
  if (record.kind === 'patient') {
    const patientId = record.patientId;
    if (typeof patientId === 'string' && patientId.length > 0) {
      return { kind: 'patient', patientId };
    }
    // A patient without an id is a contract break — treat it as an outage
    // rather than quietly dropping into demo data.
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  return { kind: 'other' };
}

// ── Live diary rail ──────────────────────────────────────────────────────────

const MEALS = new Set(['breakfast', 'lunch', 'dinner', 'snacks']);
const KINDS = new Set(['food', 'recipe', 'quick']);

function parseEntry(raw: unknown): MealLogEntry {
  if (typeof raw !== 'object' || raw === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const e = raw as Record<string, unknown>;
  if (
    typeof e.id !== 'string' ||
    typeof e.dateKey !== 'string' ||
    typeof e.meal !== 'string' ||
    !MEALS.has(e.meal) ||
    typeof e.kind !== 'string' ||
    !KINDS.has(e.kind) ||
    typeof e.name !== 'string' ||
    typeof e.quantity !== 'number' ||
    typeof e.calories !== 'number' ||
    typeof e.protein !== 'number' ||
    typeof e.carbs !== 'number' ||
    typeof e.fat !== 'number'
  ) {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  const entry: MealLogEntry = {
    id: e.id,
    dateKey: e.dateKey,
    meal: e.meal as MealLogEntry['meal'],
    kind: e.kind as MealLogEntry['kind'],
    name: e.name,
    detail: typeof e.detail === 'string' ? e.detail : '',
    quantity: e.quantity,
    calories: e.calories,
    protein: e.protein,
    carbs: e.carbs,
    fat: e.fat,
  };
  if (typeof e.refId === 'string' && e.refId.length > 0) entry.refId = e.refId;
  if (Array.isArray(e.adjustments)) {
    const adjustments: IngredientAdjustment[] = [];
    let valid = true;
    for (const item of e.adjustments) {
      const adj = item as Record<string, unknown> | null;
      if (
        adj === null ||
        typeof adj !== 'object' ||
        typeof adj.index !== 'number' ||
        typeof adj.amount !== 'number' ||
        typeof adj.unit !== 'string'
      ) {
        valid = false;
        break;
      }
      adjustments.push({ index: adj.index, amount: adj.amount, unit: adj.unit });
    }
    if (valid && adjustments.length > 0) entry.adjustments = adjustments;
  }
  return entry;
}

// ── Account photo rail ───────────────────────────────────────────────────────

export { setPatientMediaToken } from './media-token-holder';

/** Display URL for a stored photo — a token-authorized 302 to a signed URL. */
export function patientMediaDisplayUrl(objectPath: string): string {
  return appendMediaToken(
    `${apiBase()}/patient-media/file?path=${encodeURIComponent(objectPath)}`,
  );
}

/**
 * `uploadId` (optional) pins the object the server mints: the offline queue
 * sends one per queued photo so re-minting after a lost response lands on
 * the SAME object path and re-finalizes the same ledger row, never a second
 * unreferenced object.
 */
async function uploadPatientPhoto(
  kind: 'food' | 'recipe' | 'chat' | 'progress',
  dataUri: string,
  uploadId?: string,
): Promise<{ photoPath: string; photoUri: string }> {
  const commaAt = dataUri.indexOf(',');
  const header = commaAt > 0 ? dataUri.slice(0, commaAt) : '';
  const match = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(header);
  if (!match) throw new PatientDataError('That photo can’t be uploaded.');
  const contentType = match[1].toLowerCase();
  const bytes = decodeBase64(dataUri.slice(commaAt + 1));
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  const minted = (await authedRequest('POST', '/patient-media/upload-url', {
    kind,
    contentType,
    sizeBytes: bytes.byteLength,
    ...(uploadId ? { uploadId } : {}),
  })) as { uploadUrl?: unknown; objectPath?: unknown } | null;
  if (typeof minted?.uploadUrl !== 'string' || typeof minted.objectPath !== 'string') {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }

  // Raw bytes to the presigned URL. Native builds need expo/fetch (ArrayBuffer
  // bodies); on web the platform fetch works and keeps Node suites stub-free.
  let put: { ok: boolean; status: number };
  try {
    put =
      Platform.OS === 'web'
        ? await fetch(minted.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': contentType },
            body,
          })
        : await expoFetch(minted.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': contentType },
            body,
          });
  } catch {
    throw new PatientDataError(NETWORK_MESSAGE);
  }
  if (!put.ok) throw new PatientDataError(`Photo upload failed (${put.status}).`);

  await authedRequest('POST', '/patient-media/finalize', { objectPath: minted.objectPath });
  return {
    photoPath: minted.objectPath,
    photoUri: patientMediaDisplayUrl(minted.objectPath),
  };
}

// ── Library parsing (account → client shapes) ────────────────────────────────

const RECIPE_MODES = new Set(['recipe', 'cravings', 'meal']);

function parseCustomFood(raw: unknown): FoodItem {
  if (typeof raw !== 'object' || raw === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const f = raw as Record<string, unknown>;
  if (
    typeof f.id !== 'string' ||
    typeof f.name !== 'string' ||
    typeof f.serving !== 'string' ||
    typeof f.calories !== 'number' ||
    typeof f.protein !== 'number' ||
    typeof f.carbs !== 'number' ||
    typeof f.fat !== 'number'
  ) {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  const item: FoodItem = {
    id: f.id,
    name: f.name,
    serving: f.serving,
    calories: f.calories,
    protein: f.protein,
    carbs: f.carbs,
    fat: f.fat,
    // Client constant, same as at creation time — never stored server-side.
    category: 'My Foods',
  };
  if (typeof f.brand === 'string' && f.brand.length > 0) item.brand = f.brand;
  if (typeof f.photoPath === 'string' && f.photoPath.length > 0) {
    item.photoPath = f.photoPath;
    item.photoUri = patientMediaDisplayUrl(f.photoPath);
  }
  return item;
}

function parseIngredient(raw: unknown): RecipeIngredient {
  if (typeof raw !== 'object' || raw === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const i = raw as Record<string, unknown>;
  if (typeof i.amount !== 'number' || typeof i.unit !== 'string' || typeof i.name !== 'string') {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  const ingredient: RecipeIngredient = { amount: i.amount, unit: i.unit, name: i.name };
  const n = i.nutrition as Record<string, unknown> | null | undefined;
  if (
    n &&
    typeof n === 'object' &&
    typeof n.calories === 'number' &&
    typeof n.protein === 'number' &&
    typeof n.carbs === 'number' &&
    typeof n.fat === 'number'
  ) {
    const nutrition: IngredientNutrition = {
      calories: n.calories,
      protein: n.protein,
      carbs: n.carbs,
      fat: n.fat,
    };
    ingredient.nutrition = nutrition;
  }
  return ingredient;
}

function parseSavedRecipe(raw: unknown): SavedRecipe {
  if (typeof raw !== 'object' || raw === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.meal !== 'string' ||
    !MEALS.has(r.meal) ||
    !Array.isArray(r.tags) ||
    typeof r.minutes !== 'number' ||
    typeof r.servings !== 'number' ||
    typeof r.calories !== 'number' ||
    typeof r.protein !== 'number' ||
    typeof r.carbs !== 'number' ||
    typeof r.fat !== 'number' ||
    !Array.isArray(r.ingredients) ||
    !Array.isArray(r.steps) ||
    typeof r.mode !== 'string' ||
    !RECIPE_MODES.has(r.mode) ||
    typeof r.savedAt !== 'string'
  ) {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  const recipe: SavedRecipe = {
    id: r.id,
    name: r.name,
    meal: r.meal as SavedRecipe['meal'],
    tags: r.tags.filter((t): t is string => typeof t === 'string'),
    minutes: r.minutes,
    servings: r.servings,
    calories: r.calories,
    protein: r.protein,
    carbs: r.carbs,
    fat: r.fat,
    description: typeof r.description === 'string' ? r.description : '',
    ingredients: r.ingredients.map(parseIngredient),
    steps: r.steps.filter((s): s is string => typeof s === 'string'),
    // Client constant — every saved recipe is a kept coach suggestion.
    source: 'coach',
    mode: r.mode as SavedRecipe['mode'],
    savedAt: r.savedAt,
  };
  if (Array.isArray(r.groceryList)) {
    const groceryList = r.groceryList.filter((g): g is string => typeof g === 'string');
    if (groceryList.length > 0) recipe.groceryList = groceryList;
  }
  if (typeof r.photoPath === 'string' && r.photoPath.length > 0) {
    recipe.photoPath = r.photoPath;
    recipe.photoUri = patientMediaDisplayUrl(r.photoPath);
  }
  return recipe;
}

// ── Library wire shapes (client → account) ───────────────────────────────────
// Built field-by-field so display-only baggage (photoUri, category, source)
// never rides the wire — a data URI here could be megabytes of base64.

function foodWire(food: FoodItem): Record<string, unknown> {
  return {
    id: food.id,
    name: food.name,
    ...(food.brand ? { brand: food.brand } : {}),
    serving: food.serving,
    calories: food.calories,
    protein: food.protein,
    carbs: food.carbs,
    fat: food.fat,
    ...(food.photoPath ? { photoPath: food.photoPath } : {}),
  };
}

function recipeWire(recipe: SavedRecipe): Record<string, unknown> {
  return {
    id: recipe.id,
    name: recipe.name,
    meal: recipe.meal,
    tags: recipe.tags,
    minutes: recipe.minutes,
    servings: recipe.servings,
    calories: recipe.calories,
    protein: recipe.protein,
    carbs: recipe.carbs,
    fat: recipe.fat,
    description: recipe.description,
    ingredients: recipe.ingredients.map(i => ({
      amount: i.amount,
      unit: i.unit,
      name: i.name,
      ...(i.nutrition
        ? {
            nutrition: {
              calories: i.nutrition.calories,
              protein: i.nutrition.protein,
              carbs: i.nutrition.carbs,
              fat: i.nutrition.fat,
            },
          }
        : {}),
    })),
    steps: recipe.steps,
    mode: recipe.mode,
    savedAt: recipe.savedAt,
    ...(recipe.groceryList && recipe.groceryList.length > 0
      ? { groceryList: recipe.groceryList }
      : {}),
    ...(recipe.photoPath ? { photoPath: recipe.photoPath } : {}),
  };
}

// ── Chat transcript parsing (account → client wire shapes) ──────────────────

const CHAT_ROLES = new Set(['user', 'assistant', 'staff']);
const CHAT_PHOTO_KINDS = new Set(['menu', 'meal', 'label']);

function parseChatMessage(raw: unknown): ChatWireMessage {
  if (typeof raw !== 'object' || raw === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const m = raw as Record<string, unknown>;
  if (
    typeof m.id !== 'string' ||
    typeof m.role !== 'string' ||
    !CHAT_ROLES.has(m.role) ||
    typeof m.text !== 'string'
  ) {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  const message: ChatWireMessage = {
    id: m.id,
    role: m.role as ChatWireMessage['role'],
    text: m.text,
  };
  if (m.role === 'staff' && typeof m.senderLabel === 'string' && m.senderLabel.length > 0) {
    message.senderLabel = m.senderLabel;
  }
  if (m.stopped === true) message.stopped = true;
  if (m.hidden === true) message.hidden = true;
  if (
    typeof m.card === 'object' &&
    m.card !== null &&
    typeof (m.card as { kind?: unknown }).kind === 'string'
  ) {
    message.card = m.card as { kind: string; payload: unknown };
  }
  if (Array.isArray(m.quickReplies)) {
    const labels = m.quickReplies.filter((l): l is string => typeof l === 'string' && l.length > 0);
    if (labels.length > 0) message.quickReplies = labels;
  }
  if (typeof m.replyToId === 'string' && m.replyToId.length > 0) message.replyToId = m.replyToId;
  const p = m.photo as Record<string, unknown> | null | undefined;
  if (
    p &&
    typeof p === 'object' &&
    typeof p.path === 'string' &&
    p.path.length > 0 &&
    typeof p.width === 'number' &&
    typeof p.height === 'number'
  ) {
    const photo: ChatWirePhoto = {
      path: p.path,
      width: p.width,
      height: p.height,
      // Display URL derived here, at the API seam, so the chat layer never
      // builds media URLs itself.
      uri: patientMediaDisplayUrl(p.path),
    };
    if (typeof p.kind === 'string' && CHAT_PHOTO_KINDS.has(p.kind)) {
      photo.kind = p.kind as ChatWirePhoto['kind'];
    }
    if (typeof p.mealSlot === 'string' && MEALS.has(p.mealSlot)) {
      photo.mealSlot = p.mealSlot as MealSlot;
    }
    if (p.reused === true) photo.reused = true;
    message.photo = photo;
  }
  return message;
}

// ── Progress slice parsing (account → client shapes) ────────────────────────

const PHOTO_ANGLES = new Set(['front', 'side', 'back']);

function parseProgressPhoto(raw: unknown): ProgressPhotoWire {
  if (typeof raw !== 'object' || raw === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const p = raw as Record<string, unknown>;
  if (
    typeof p.id !== 'string' ||
    typeof p.dateKey !== 'string' ||
    typeof p.label !== 'string' ||
    typeof p.objectPath !== 'string' ||
    p.objectPath.length === 0
  ) {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  const photo: ProgressPhotoWire = {
    id: p.id,
    dateKey: p.dateKey,
    label: p.label,
    objectPath: p.objectPath,
  };
  if (typeof p.angle === 'string' && PHOTO_ANGLES.has(p.angle)) {
    photo.angle = p.angle as ProgressPhotoWire['angle'];
  }
  return photo;
}

function parseCheckInWire(raw: unknown): CheckIn {
  if (typeof raw !== 'object' || raw === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const c = raw as Record<string, unknown>;
  if (
    typeof c.id !== 'string' ||
    typeof c.dateKey !== 'string' ||
    typeof c.mood !== 'number' ||
    !Number.isInteger(c.mood) ||
    c.mood < 1 ||
    c.mood > 5 ||
    !Array.isArray(c.sideEffects)
  ) {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  const checkIn: CheckIn = {
    id: c.id,
    dateKey: c.dateKey,
    mood: c.mood as CheckIn['mood'],
    sideEffects: c.sideEffects.filter((s): s is string => typeof s === 'string'),
  };
  if (typeof c.weight === 'number' && Number.isFinite(c.weight)) checkIn.weight = c.weight;
  if (typeof c.notes === 'string' && c.notes.length > 0) checkIn.notes = c.notes;
  return checkIn;
}

/**
 * Tolerant by design: an absent or partial flags object yields defaults, so
 * this client keeps working against older in-memory test servers that don't
 * know the progress slice yet.
 */
function parseFlags(raw: unknown): PatientFlags {
  const f = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const flags: PatientFlags = {
    nudgeOptOut: f.nudgeOptOut === true,
    nudgeEngaged: f.nudgeEngaged === true,
    nudgeLastSentKey: typeof f.nudgeLastSentKey === 'string' ? f.nudgeLastSentKey : null,
    nudgeLastCrossingKey:
      typeof f.nudgeLastCrossingKey === 'string' ? f.nudgeLastCrossingKey : null,
    onboardingComplete: f.onboardingComplete === true,
  };
  if (
    typeof f.onboardingAnswers === 'object' &&
    f.onboardingAnswers !== null &&
    !Array.isArray(f.onboardingAnswers)
  ) {
    flags.onboardingAnswers = f.onboardingAnswers as Record<string, unknown>;
  }
  if (
    typeof f.notificationPrefs === 'object' &&
    f.notificationPrefs !== null &&
    !Array.isArray(f.notificationPrefs)
  ) {
    flags.notificationPrefs = f.notificationPrefs as Record<string, unknown>;
  }
  return flags;
}

function parseEntryFacts(raw: unknown): PatientEntryFacts {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  const entry = raw as Record<string, unknown>;
  if (
    typeof entry.firstName !== 'string' ||
    entry.firstName.length < 1 ||
    typeof entry.programStartDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.programStartDate) ||
    typeof entry.todayKey !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.todayKey) ||
    typeof entry.programDay !== 'number' ||
    !Number.isInteger(entry.programDay) ||
    entry.programDay < 1
  ) {
    throw new PatientDataError(MALFORMED_MESSAGE);
  }
  return {
    firstName: entry.firstName,
    programStartDate: entry.programStartDate,
    todayKey: entry.todayKey,
    programDay: entry.programDay,
  };
}

function parseProfileResult(raw: unknown): { profile: PatientProfile } {
  const record = raw as Record<string, unknown> | null;
  return { profile: parsePatientProfile(record?.profile ?? raw) };
}

function parseServerState(json: unknown): PatientServerState {
  if (typeof json !== 'object' || json === null) throw new PatientDataError(MALFORMED_MESSAGE);
  const data = json as Record<string, unknown>;
  if (!Array.isArray(data.entries)) throw new PatientDataError(MALFORMED_MESSAGE);
  const entries = data.entries.map(parseEntry);

  const water: Record<string, number> = {};
  if (data.water !== undefined) {
    if (typeof data.water !== 'object' || data.water === null || Array.isArray(data.water)) {
      throw new PatientDataError(MALFORMED_MESSAGE);
    }
    for (const [key, value] of Object.entries(data.water as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) water[key] = value;
    }
  }

  const targets: Partial<DailyTargets> = {};
  if (data.targets !== undefined) {
    if (typeof data.targets !== 'object' || data.targets === null || Array.isArray(data.targets)) {
      throw new PatientDataError(MALFORMED_MESSAGE);
    }
    const t = data.targets as Record<string, unknown>;
    for (const key of ['calories', 'protein', 'carbs', 'fat', 'waterOz'] as const) {
      const value = t[key];
      if (typeof value === 'number' && Number.isFinite(value)) targets[key] = value;
    }
  }

  const favorites = Array.isArray(data.favorites)
    ? data.favorites.filter((v): v is string => typeof v === 'string')
    : [];
  const recents = Array.isArray(data.recents)
    ? data.recents.filter((v): v is string => typeof v === 'string')
    : [];

  const customFoods = Array.isArray(data.customFoods) ? data.customFoods.map(parseCustomFood) : [];
  const savedRecipes = Array.isArray(data.savedRecipes)
    ? data.savedRecipes.map(parseSavedRecipe)
    : [];

  // Progress slices tolerate absence (older in-memory test servers).
  const photos = Array.isArray(data.photos) ? data.photos.map(parseProgressPhoto) : [];
  const checkIns = Array.isArray(data.checkIns) ? data.checkIns.map(parseCheckInWire) : [];
  const flags = parseFlags(data.flags);
  const entry = parseEntryFacts(data.entry);
  const profile = data.profile === undefined ? undefined : parsePatientProfile(data.profile);
  let privacy: PrivacyState | undefined;
  if (data.privacy !== undefined) {
    try {
      privacy = parsePrivacyState(data.privacy);
    } catch (error) {
      if (error instanceof PrivacyParseError) throw new PatientDataError(MALFORMED_MESSAGE);
      throw error;
    }
  }

  return {
    entries,
    water,
    targets,
    favorites,
    recents,
    customFoods,
    savedRecipes,
    photos,
    checkIns,
    flags,
    entry,
    ...(profile ? { profile } : {}),
    ...(privacy ? { privacy } : {}),
  };
}

/** Re-throws privacy parse failures in the sync snackbar's plain words. */
function privacyParsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PrivacyParseError) throw new PatientDataError(MALFORMED_MESSAGE);
    throw error;
  }
}

export const patientDataApi: PatientDataApi = {
  async fetchProfile(): Promise<PatientProfile> {
    return parseProfileResult(await authedRequest('GET', '/patient-data/profile')).profile;
  },

  async writeProfile(input: PatientProfileWrite): Promise<{ profile: PatientProfile }> {
    return parseProfileResult(await authedRequest('PUT', '/patient-data/profile', input));
  },

  async saveSetup(input: {
    profile: PatientProfileWrite;
    onboardingAnswers: object;
  }): Promise<{ profile: PatientProfile }> {
    return parseProfileResult(await authedRequest('PUT', '/patient-data/setup', input));
  },

  async fetchState(fromKey?: string, toKey?: string, todayKey?: string): Promise<PatientServerState> {
    const query = new URLSearchParams();
    if (fromKey) query.set('from', fromKey);
    if (toKey) query.set('to', toKey);
    if (todayKey) query.set('today', todayKey);
    const json = await authedRequest(
      'GET',
      `/patient-data/state${query.size > 0 ? `?${query.toString()}` : ''}`,
    );
    // The media token must land BEFORE row parsing: library and chat
    // parses build display URLs, and those URLs must carry it.
    const record = (json ?? {}) as Record<string, unknown>;
    setMediaTokenDirect(
      typeof record.mediaToken === 'string' && record.mediaToken.length > 0
        ? record.mediaToken
        : null,
    );
    return parseServerState(json);
  },

  async writeEntries(
    input: {
      upsert?: MealLogEntry[];
      deleteIds?: string[];
      recents?: string[];
    },
    options?: WriteOptions,
  ): Promise<void> {
    await authedRequest('POST', '/patient-data/entries', input, options);
  },

  async writeWater(dateKey: string, oz: number, options?: WriteOptions): Promise<void> {
    await authedRequest('PUT', '/patient-data/water', { dateKey, oz }, options);
  },

  async writeTargets(partial: Partial<DailyTargets>, options?: WriteOptions): Promise<void> {
    await authedRequest('PUT', '/patient-data/targets', partial, options);
  },

  async writePrefs(
    prefs: { favorites?: string[]; recents?: string[] },
    options?: WriteOptions,
  ): Promise<void> {
    await authedRequest('PUT', '/patient-data/prefs', prefs, options);
  },

  async writeLibrary(input: LibraryWrite, options?: WriteOptions): Promise<void> {
    const body: Record<string, unknown> = {};
    if (input.foodUpsert && input.foodUpsert.length > 0) {
      body.foodUpsert = input.foodUpsert.map(foodWire);
    }
    if (input.recipeUpsert && input.recipeUpsert.length > 0) {
      body.recipeUpsert = input.recipeUpsert.map(recipeWire);
    }
    if (input.foodDeleteIds && input.foodDeleteIds.length > 0) {
      body.foodDeleteIds = input.foodDeleteIds;
    }
    if (input.recipeDeleteIds && input.recipeDeleteIds.length > 0) {
      body.recipeDeleteIds = input.recipeDeleteIds;
    }
    if (input.favorites) body.favorites = input.favorites;
    if (input.recents) body.recents = input.recents;
    await authedRequest('POST', '/patient-data/library', body, options);
  },

  uploadLibraryPhoto: uploadPatientPhoto,

  async fetchChatThread(thread: ChatThread, todayKey: string): Promise<ChatThreadSnapshot> {
    const json = await authedRequest(
      'GET',
      `/patient-chat/${thread}?today=${encodeURIComponent(todayKey)}`,
    );
    const record = (json ?? {}) as Record<string, unknown>;
    if (!Array.isArray(record.messages)) throw new PatientDataError(MALFORMED_MESSAGE);
    const patient = (record.patient ?? {}) as Record<string, unknown>;
    return {
      messages: record.messages.map(parseChatMessage),
      patient: {
        firstName:
          typeof patient.firstName === 'string' && patient.firstName.length > 0
            ? patient.firstName
            : 'there',
        programDay:
          typeof patient.programDay === 'number' && Number.isFinite(patient.programDay)
            ? patient.programDay
            : 1,
      },
    };
  },

  async appendChatMessages(thread: ChatThread, messages: ChatWireMessage[]): Promise<void> {
    if (messages.some(message => message.role === 'staff')) {
      throw new PatientDataError('Care team messages cannot be appended by the patient app.');
    }
    await authedRequest('POST', `/patient-chat/${thread}/messages`, { messages });
  },

  async uploadChatPhoto(dataUri: string): Promise<{ photoPath: string; photoUri: string }> {
    return uploadPatientPhoto('chat', dataUri);
  },

  async uploadProgressPhoto(
    dataUri: string,
    options?: { uploadId?: string },
  ): Promise<{ photoPath: string; photoUri: string }> {
    return uploadPatientPhoto('progress', dataUri, options?.uploadId);
  },

  async writeProgressPhotos(photos: ProgressPhotoWire[], options?: WriteOptions): Promise<void> {
    await authedRequest('POST', '/patient-data/photos', {
      // Built field-by-field so display-only baggage never rides the wire.
      upsert: photos.map(photo => ({
        id: photo.id,
        dateKey: photo.dateKey,
        label: photo.label,
        ...(photo.angle ? { angle: photo.angle } : {}),
        objectPath: photo.objectPath,
      })),
    }, options);
  },

  async removeProgressPhoto(photoId: string, options?: WriteOptions): Promise<void> {
    await authedRequest('POST', '/patient-data/photos', { deleteIds: [photoId] }, options);
  },

  async cleanupProgressUploads(paths: string[]): Promise<void> {
    await authedRequest('POST', '/patient-media/cleanup', { paths });
  },

  async writeCheckIn(checkIn: CheckIn, options?: WriteOptions): Promise<void> {
    await authedRequest('POST', '/patient-data/check-ins', {
      id: checkIn.id,
      dateKey: checkIn.dateKey,
      ...(typeof checkIn.weight === 'number' ? { weight: checkIn.weight } : {}),
      mood: checkIn.mood,
      sideEffects: checkIn.sideEffects,
      ...(checkIn.notes ? { notes: checkIn.notes } : {}),
    }, options);
  },

  async importHealthMeasurements(measurements: HealthMeasurement[], accessToken?: string): Promise<{ imported: number }> {
    const json = await authedRequest('POST', '/patient-data/health-measurements', { measurements }, accessToken);
    const imported = (json as { imported?: unknown } | null)?.imported;
    if (typeof imported !== 'number') throw new PatientDataError(MALFORMED_MESSAGE);
    return { imported };
  },

  async writeFlags(flags: Partial<PatientFlagsWrite>, options?: WriteOptions): Promise<void> {
    await authedRequest('PUT', '/patient-data/flags', flags, options);
  },

  async completeSetup(input: {
    profile: PatientSetupWrite;
    onboardingAnswers: object;
    notificationPrefs: object;
  }): Promise<{ profile: PatientProfile }> {
    return parseProfileResult(await authedRequest('POST', '/patient-data/profile/setup', input));
  },

  async requestProfileVerification(input: {
    kind: 'email' | 'phone';
    value: string;
  }): Promise<{ requestId: string; message: string; devCode?: string }> {
    const json = (await authedRequest(
      'POST',
      '/patient-data/profile/contact/start',
      input,
    )) as Record<string, unknown>;
    if (typeof json.requestId !== 'string' || typeof json.message !== 'string') {
      throw new PatientDataError(MALFORMED_MESSAGE);
    }
    return {
      requestId: json.requestId,
      message: json.message,
      ...(typeof json.devCode === 'string' ? { devCode: json.devCode } : {}),
    };
  },

  async verifyProfileContact(input: {
    requestId: string;
    code: string;
  }): Promise<{ profile: PatientProfile }> {
    return parseProfileResult(
      await authedRequest('POST', '/patient-data/profile/contact/verify', input),
    );
  },

  privacy: {
    async fetchPrivacy() {
      const json = await authedRequest('GET', '/patient-data/privacy');
      return privacyParsed(() => parsePrivacyState(json));
    },
    async recordConsent(input: ConsentWrite) {
      const json = (await authedRequest('PUT', '/patient-data/consent', input)) as Record<string, unknown> | null;
      return privacyParsed(() => ({ consent: parseConsent(json?.consent) }));
    },
    async requestExport() {
      const json = (await authedRequest('POST', '/patient-data/export')) as Record<string, unknown> | null;
      const job = privacyParsed(() => parseExport(json?.export));
      if (!job) throw new PatientDataError(MALFORMED_MESSAGE);
      return { export: job };
    },
    async fetchExport() {
      const json = (await authedRequest('GET', '/patient-data/export')) as Record<string, unknown> | null;
      return privacyParsed(() => ({ export: parseExport(json?.export) }));
    },
    async exportDownloadUrl(id: string) {
      const json = (await authedRequest(
        'GET',
        `/patient-data/export/${encodeURIComponent(id)}/download-url`,
      )) as Record<string, unknown> | null;
      if (typeof json?.url !== 'string' || !/^https?:\/\//.test(json.url)) {
        throw new PatientDataError(MALFORMED_MESSAGE);
      }
      return {
        url: json.url,
        expiresInSeconds: typeof json.expiresInSeconds === 'number' ? json.expiresInSeconds : 300,
        fileName: typeof json.fileName === 'string' ? json.fileName : 'thinnr-export.zip',
      };
    },
    async requestDeletion() {
      const json = (await authedRequest('POST', '/patient-data/deletion', { confirm: 'DELETE' })) as Record<string, unknown> | null;
      const deletion = privacyParsed(() => parseDeletion(json?.deletion));
      if (!deletion) throw new PatientDataError(MALFORMED_MESSAGE);
      return { deletion };
    },
    async cancelDeletion() {
      const json = (await authedRequest('DELETE', '/patient-data/deletion')) as Record<string, unknown> | null;
      return { cancelled: json?.cancelled === true };
    },
  },
};
