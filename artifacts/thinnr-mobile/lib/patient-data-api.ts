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
  DailyTargets,
  FoodItem,
  IngredientAdjustment,
  IngredientNutrition,
  MealLogEntry,
  RecipeIngredient,
  SavedRecipe,
} from '@/data/patient-data';
import type {
  LibraryWrite,
  PatientDataApi,
  PatientServerState,
} from '@/context/PatientAccountContext';
import { apiBase } from '@/lib/coach-api';
import { decodeBase64 } from '@/lib/base64';
import { supabase } from '@/lib/supabase';

export class PatientDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatientDataError';
  }
}

const NETWORK_MESSAGE = 'Couldn’t reach the server. Check your connection and try again.';
const MALFORMED_MESSAGE = 'The server sent something unexpected. Please try again.';
const SIGNED_OUT_MESSAGE = 'You’re signed out. Sign in again to sync your diary.';

const REQUEST_TIMEOUT_MS = 15_000;

async function authedRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  let base: string;
  try {
    base = apiBase();
  } catch {
    throw new PatientDataError('This build isn’t configured to reach the server.');
  }
  if (!supabase) {
    throw new PatientDataError('Sign-in isn’t configured in this build.');
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new PatientDataError(SIGNED_OUT_MESSAGE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new PatientDataError(NETWORK_MESSAGE);
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
    const message = (json as { error?: unknown } | null)?.error;
    throw new PatientDataError(
      typeof message === 'string' && message.length > 0
        ? message
        : 'The server couldn’t handle that. Please try again.',
    );
  }
  return json;
}

// ── Account resolution ───────────────────────────────────────────────────────

export type AccountRole = { kind: 'patient'; patientId: string } | { kind: 'other' };

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

/** Display URL for a stored library photo — an open 302 to a signed URL. */
export function patientMediaDisplayUrl(objectPath: string): string {
  return `${apiBase()}/patient-media/file?path=${encodeURIComponent(objectPath)}`;
}

async function uploadLibraryPhoto(
  kind: 'food' | 'recipe',
  dataUri: string,
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

  return { entries, water, targets, favorites, recents, customFoods, savedRecipes };
}

export const patientDataApi: PatientDataApi = {
  async fetchState(fromKey: string, toKey: string): Promise<PatientServerState> {
    const json = await authedRequest(
      'GET',
      `/patient-data/state?from=${encodeURIComponent(fromKey)}&to=${encodeURIComponent(toKey)}`,
    );
    return parseServerState(json);
  },

  async writeEntries(input: {
    upsert?: MealLogEntry[];
    deleteIds?: string[];
    recents?: string[];
  }): Promise<void> {
    await authedRequest('POST', '/patient-data/entries', input);
  },

  async writeWater(dateKey: string, oz: number): Promise<void> {
    await authedRequest('PUT', '/patient-data/water', { dateKey, oz });
  },

  async writeTargets(partial: Partial<DailyTargets>): Promise<void> {
    await authedRequest('PUT', '/patient-data/targets', partial);
  },

  async writePrefs(prefs: { favorites?: string[]; recents?: string[] }): Promise<void> {
    await authedRequest('PUT', '/patient-data/prefs', prefs);
  },

  async writeLibrary(input: LibraryWrite): Promise<void> {
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
    await authedRequest('POST', '/patient-data/library', body);
  },

  uploadLibraryPhoto,
};
