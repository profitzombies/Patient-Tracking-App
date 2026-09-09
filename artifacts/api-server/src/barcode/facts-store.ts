/**
 * Service-role access to the shared barcode nutrition-facts rows.
 *
 * The table is the app-wide cache of packaged-food lookups: the first
 * successful scan of a product by ANY user writes its normalized facts
 * here, and every later scan of that code is answered from this table
 * without calling the third-party database at all. Rows are product facts
 * only — no user identity — and RLS is enabled with no policies, so only
 * this service-role client can read or write them.
 *
 * Same raw PostgREST pattern as the knowledge library's docs-store: plain
 * fetch, 15s timeout, explicit RestError on non-2xx. Tests mock this module
 * boundary with an in-memory map.
 */

/** One row of public.barcode_nutrition_facts (fetched_at is server-set). */
export interface BarcodeFactsRow {
  /** Canonical barcode: 8-digit EAN-8 or 13-digit GTIN. */
  code: string;
  name: string;
  brand: string | null;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Upstream that produced the row, e.g. "openfoodfacts". */
  source: string;
  nutrition_snapshot?: unknown;
}

const COLUMNS = "code,name,brand,serving,calories,protein,carbs,fat,source,nutrition_snapshot";

function base(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url.replace(/\/$/, "");
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export class RestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RestError";
    Object.setPrototypeOf(this, RestError.prototype);
  }
}

async function rest(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(`${base()}/rest/v1${path}`, {
    method,
    headers: headers(extraHeaders),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new RestError(
      `Supabase ${method} ${path.split("?")[0]} failed (${response.status}): ${text.slice(0, 200)}`,
      response.status,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reads the cached facts for one canonical code; null when never scanned. */
export async function getBarcodeFactsRecord(code: string): Promise<BarcodeFactsRow | null> {
  const rows = (await rest(
    "GET",
    `/barcode_nutrition_facts?code=eq.${encodeURIComponent(code)}&select=${COLUMNS}`,
  )) as BarcodeFactsRow[] | null;
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Saves (or refreshes) one product's facts under its canonical code.
 * Idempotent: concurrent first scans of the same product merge on the key.
 */
export async function upsertBarcodeFactsRecord(row: BarcodeFactsRow): Promise<void> {
  await rest("POST", "/barcode_nutrition_facts?on_conflict=code", [row], {
    Prefer: "resolution=merge-duplicates,return=minimal",
  });
}
