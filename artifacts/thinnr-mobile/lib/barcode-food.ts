/**
 * Client contract for the diary's barcode scanner (GET /api/barcode/:code).
 *
 * The app never talks to a nutrition database directly: the API server
 * checks the shared nutrition-facts table first and only queries Open Food
 * Facts on a miss, saving the normalized result so the first successful
 * scan of a product (by anyone) answers every later scan from our own
 * table. The client's only jobs are canonicalizing what was typed or
 * scanned, calling the lookup, and validating what comes back — an
 * unusable payload fails loudly instead of logging invented numbers.
 *
 * Adding a found product runs the SAME two steps as the label-scan flow:
 * save a per-serving custom food to "My Foods" (buildCustomFoodFromBarcode),
 * then log `quantity` servings of it to the originating meal via the shared
 * entry builder (re-exported below as buildBarcodeDiaryEntry — identical
 * math on purpose). Quantity multiplies the DIARY ENTRY only; the reusable
 * food always stays per-serving.
 */
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import type { FoodItem } from '@/data/patient-data';
import { parseNutritionSnapshot, type FoodNutritionSnapshot } from '@/data/food-nutrition';
import { apiBase, type ScanErrorDetails } from '@/lib/coach-api';
import { readUpgradeRequired, type AppAccessEntitlement } from '@/lib/app-access';
import { toTitleCase } from '@/lib/title-case';

// The label flow's entry builder is food-generic (quantity × per-serving
// macros, same detail format as Add Food); the barcode flow reuses it
// verbatim so both scanners log byte-identical entry shapes.
export { buildLabelDiaryEntry as buildBarcodeDiaryEntry } from '@/lib/label-food';

/** Per-serving nutrition facts for one packaged product, as the server returns them. */
export interface BarcodeFood {
  /** Canonical barcode (EAN-8 as 8 digits, everything else GTIN-13). */
  code: string;
  name: string;
  brand?: string;
  /** The serving the values describe, e.g. "30 g" or "2 cookies (28g)". */
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Present only when the upstream/server actually supplied a validated panel. */
  nutritionSnapshot?: FoodNutritionSnapshot;
}

/** Where a found result was served from ("cache"/"table" = no third-party call). */
export type BarcodeLookupSource = 'cache' | 'table' | 'openfoodfacts';

export type BarcodeLookupOutcome =
  | { result: 'found'; source: BarcodeLookupSource; food: BarcodeFood }
  | { result: 'not_found'; message: string };

/** Lookup failure whose message is safe to show the patient. */
export class BarcodeLookupError extends Error {
  /** The app-access gate's terminal 402: premium features locked, no retry. */
  readonly upgradeRequired: boolean;
  readonly entitlement: AppAccessEntitlement | null;
  constructor(message: string, details: ScanErrorDetails = {}) {
    super(message);
    this.name = 'BarcodeLookupError';
    this.upgradeRequired = details.upgradeRequired === true;
    this.entitlement = details.entitlement ?? null;
  }
}

const LOOKUP_FALLBACK_ERROR = 'The barcode lookup is unavailable right now. Please try again.';

/**
 * Canonicalizes a typed barcode — the client-side mirror of the server's
 * normalizeBarcode, used to validate before making a request. Digits only
 * (spaces/hyphens tolerated); EAN-8 stays 8 digits, UPC-A gains its GTIN-13
 * leading zero, a zero-led GTIN-14 drops it. Null for anything else.
 */
export function normalizeBarcodeInput(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s-]/g, '');
  if (!/^[0-9]+$/.test(cleaned)) return null;
  let code = cleaned;
  if (code.length === 14 && code.startsWith('0')) code = code.slice(1);
  if (code.length === 12) code = `0${code}`;
  if (code.length !== 8 && code.length !== 13) return null;
  if (/^0+$/.test(code)) return null;
  return code;
}

/** UPC-A check digit for an 11-digit payload (odd positions ×3). */
function upcCheckDigit(eleven: string): string {
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    const digit = eleven.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Expands a compressed UPC-E scan (6-digit body, optionally with number
 * system and/or check digit) to its 12-digit UPC-A form so the server sees
 * only the standard code families. Null when the input is not a valid
 * zero/one-system UPC-E body.
 */
export function expandUpcE(raw: string): string | null {
  const digits = raw.trim().replace(/\D/g, '');
  let numberSystem = '0';
  let body: string;
  if (digits.length === 6) {
    body = digits;
  } else if (digits.length === 7) {
    numberSystem = digits[0];
    body = digits.slice(1);
  } else if (digits.length === 8) {
    numberSystem = digits[0];
    body = digits.slice(1, 7);
  } else {
    return null;
  }
  if (numberSystem !== '0' && numberSystem !== '1') return null;

  const d = body.split('');
  const last = d[5];
  let core: string; // manufacturer + product (10 digits, without number system)
  if (last === '0' || last === '1' || last === '2') {
    core = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  } else if (last === '3') {
    core = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  } else if (last === '4') {
    core = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  } else {
    core = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  }
  const eleven = `${numberSystem}${core}`;
  return `${eleven}${upcCheckDigit(eleven)}`;
}

/**
 * Canonicalizes what a patient TYPED. Beyond the strict families, a 6- or
 * 7-digit entry can only be a compressed UPC-E (the short code printed on
 * small packages), so it expands to UPC-A before normalizing. 8 digits
 * stays EAN-8 on purpose — the two families share that length, and EAN-8
 * is what the number under an 8-digit barcode means.
 */
export function normalizeTypedBarcode(raw: string): string | null {
  const direct = normalizeBarcodeInput(raw);
  if (direct) return direct;
  const digits = raw.trim().replace(/[\s-]/g, '');
  if (/^[0-9]{6,7}$/.test(digits)) {
    const expanded = expandUpcE(digits);
    return expanded ? normalizeBarcodeInput(expanded) : null;
  }
  return null;
}

/**
 * Canonicalizes a live camera detection. UPC-E arrives in its compressed
 * form on some platforms and pre-expanded on others; everything else goes
 * straight through the typed-input normalizer.
 */
export function normalizeScannedBarcode(data: string, type?: string): string | null {
  const digits = data.trim().replace(/[\s-]/g, '');
  if (type === 'upc_e' && digits.length <= 8) {
    const expanded = expandUpcE(digits);
    return expanded ? normalizeBarcodeInput(expanded) : null;
  }
  return normalizeBarcodeInput(digits);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Defensive parse of the server's food payload. Null on anything malformed
 * so a bad response surfaces as a retryable error, never a broken card.
 *
 * The product NAME takes the app-wide Title Case here — the one point a
 * successful lookup enters the app — so the scan list, the added/duplicate
 * notices, and the serving-stepper voice-over labels all inherit it and
 * match what the save path stores. Brand-style inner caps ("PB&J",
 * "McCann's") pass through untouched. The BRAND line stays exactly as the
 * source spells it, and the shared facts store is never re-cased — this is
 * presentation-side normalization only.
 */
export function parseBarcodeFood(value: unknown): BarcodeFood | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.code !== 'string' || r.code.length === 0) return null;
  if (typeof r.name !== 'string' || r.name.trim().length === 0) return null;
  if (typeof r.serving !== 'string' || r.serving.trim().length === 0) return null;
  if (!finiteNonNegative(r.calories) || !finiteNonNegative(r.protein)) return null;
  if (!finiteNonNegative(r.carbs) || !finiteNonNegative(r.fat)) return null;
  const food: BarcodeFood = {
    code: r.code,
    name: toTitleCase(r.name.trim().slice(0, 120)),
    serving: r.serving.trim().slice(0, 80),
    calories: r.calories,
    protein: r.protein,
    carbs: r.carbs,
    fat: r.fat,
  };
  if (typeof r.brand === 'string' && r.brand.trim()) {
    food.brand = r.brand.trim().slice(0, 80);
  }
  if (r.nutritionSnapshot !== undefined) {
    const nutritionSnapshot = parseNutritionSnapshot(r.nutritionSnapshot);
    if (!nutritionSnapshot) return null;
    food.nutritionSnapshot = nutritionSnapshot;
  }
  return food;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const LOOKUP_SIGNED_OUT_MESSAGE = 'You’re signed out. Sign in again to look up barcodes.';

export interface BarcodeLookupOptions {
  signal?: AbortSignal;
  /**
   * Supplies the signed-in patient's bearer token. When set, the lookup
   * authenticates as the patient so the server applies the office's
   * app-access rule (a locked patient gets the 402 upgrade answer, never a
   * silent free lookup). A missing or failed token surfaces the signed-out
   * error instead of falling back to the anonymous path. Unauthenticated
   * (signed-out / staff) callers never set this and keep the open lookup.
   */
  getAuthToken?: () => Promise<string | null>;
}

/**
 * Looks one canonical barcode up through the API server. Resolves with an
 * explicit found / not_found outcome; throws BarcodeLookupError with a
 * user-facing message on any failure except a caller-initiated abort,
 * which rethrows untouched so cancel paths stay silent.
 */
export async function lookupBarcode(
  code: string,
  options: BarcodeLookupOptions = {},
): Promise<BarcodeLookupOutcome> {
  const doFetch =
    Platform.OS === 'web'
      ? globalThis.fetch.bind(globalThis)
      : (expoFetch as unknown as typeof globalThis.fetch);

  const headers: Record<string, string> = {};
  if (options.getAuthToken) {
    let token: string | null;
    try {
      token = await options.getAuthToken();
    } catch {
      token = null;
    }
    if (!token) throw new BarcodeLookupError(LOOKUP_SIGNED_OUT_MESSAGE);
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await doFetch(`${apiBase()}/barcode/${encodeURIComponent(code)}`, {
      headers,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('Barcode lookup request failed', error);
    throw new BarcodeLookupError(
      'Could not reach the barcode lookup. Check your connection and try again.',
    );
  }

  if (!response.ok) {
    // The API answers failures with { error: <user-facing message> }.
    let message = LOOKUP_FALLBACK_ERROR;
    let details: ScanErrorDetails = {};
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error.trim()) message = body.error.trim();
      const upgrade = readUpgradeRequired(body);
      if (upgrade) details = { upgradeRequired: true, entitlement: upgrade.entitlement };
    } catch {
      // keep the fallback message
    }
    throw new BarcodeLookupError(message, details);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new BarcodeLookupError(LOOKUP_FALLBACK_ERROR);
  }
  const record = (typeof json === 'object' && json !== null ? json : {}) as {
    result?: unknown;
    source?: unknown;
    food?: unknown;
    message?: unknown;
  };
  if (record.result === 'found') {
    const food = parseBarcodeFood(record.food);
    if (!food) throw new BarcodeLookupError(LOOKUP_FALLBACK_ERROR);
    const source: BarcodeLookupSource =
      record.source === 'cache' || record.source === 'table' || record.source === 'openfoodfacts'
        ? record.source
        : 'openfoodfacts';
    return { result: 'found', source, food };
  }
  if (record.result === 'not_found') {
    const message =
      typeof record.message === 'string' && record.message.trim()
        ? record.message.trim().slice(0, 400)
        : 'We could not find that barcode. Check the number, or scan the Nutrition Facts label instead.';
    return { result: 'not_found', message };
  }
  throw new BarcodeLookupError(LOOKUP_FALLBACK_ERROR);
}

/**
 * The custom food Add saves — the same shape the create-food screen builds,
 * so the result is an ordinary "My Foods" entry (editable, undoable).
 * Values round to whole numbers to match every other food in the library;
 * names take the app-wide Title Case (brand spellings with inner caps pass
 * through untouched). Always per-serving: the quantity stepper never
 * touches this shape.
 */
export function buildCustomFoodFromBarcode(food: BarcodeFood): Omit<FoodItem, 'id' | 'category'> {
  return {
    name: toTitleCase(food.name),
    ...(food.brand ? { brand: food.brand } : {}),
    serving: food.serving,
    calories: Math.round(food.calories),
    protein: Math.round(food.protein),
    carbs: Math.round(food.carbs),
    fat: Math.round(food.fat),
    ...(food.nutritionSnapshot ? { nutritionSnapshot: food.nutritionSnapshot } : {}),
  };
}
