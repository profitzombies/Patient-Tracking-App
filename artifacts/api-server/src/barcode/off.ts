/**
 * Open Food Facts client — the ONLY place the third-party database is
 * touched, so a later provider swap changes this module and nothing else.
 *
 * Read-only v2 product lookup with a descriptive User-Agent (Open Food
 * Facts API etiquette) and a hard timeout so a slow upstream can never hold
 * the route open. The three outcomes are explicit: found (raw product
 * record, normalized by the caller), not_found (the database does not know
 * the code), and error (network/upstream trouble — the route answers 502,
 * never a made-up "not found").
 *
 * Tests mock this module boundary; nothing here stubs global fetch.
 */

export type OffLookup =
  | { kind: "found"; product: unknown }
  | { kind: "not_found" }
  | { kind: "error" };

export type OffSearch =
  | { kind: "found"; products: unknown[] }
  | { kind: "error" };

/** Minimal logger surface (pino req.log satisfies it). */
interface WarnLogger {
  warn(obj: unknown, msg?: string): void;
}

const OFF_BASE = "https://world.openfoodfacts.org/api/v2/product";
// Only the fields the normalizer reads — keeps responses small.
// nutrition_data_per and serving_quantity_unit exist so per-100 scaling can
// verify UNITS (per 100 g vs per 100 ml; serving in g vs ml) instead of
// assuming milliliters weigh a gram.
const OFF_FIELDS =
  "product_name,brands,serving_size,serving_quantity,serving_quantity_unit,nutrition_data_per,nutriments";
const OFF_TIMEOUT_MS = 8000;
// Open Food Facts asks API users to identify their app and a contact.
const OFF_USER_AGENT = "THINNR-MedSpa-Demo/1.0 (Replit demo; contact via replit.com)";

/** Guarded text search. Callers enforce specificity before reaching here. */
export async function searchOffProducts(
  query: string,
  limit: number,
  log?: WarnLogger,
  page: number = 1,
): Promise<OffSearch> {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: String(Math.min(Math.max(limit, 1), 20)),
    page: String(Math.max(Math.floor(page), 1)),
    fields: `code,${OFF_FIELDS}`,
  });
  let response: Response;
  try {
    response = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?${params}`, {
      headers: { "User-Agent": OFF_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
    });
  } catch (error) {
    log?.warn({ err: error }, "open food facts search failed");
    return { kind: "error" };
  }
  if (!response.ok) {
    log?.warn({ status: response.status }, "open food facts search answered non-ok");
    return { kind: "error" };
  }
  try {
    const json = await response.json() as { products?: unknown };
    return { kind: "found", products: Array.isArray(json.products) ? json.products : [] };
  } catch (error) {
    log?.warn({ err: error }, "open food facts search response was not json");
    return { kind: "error" };
  }
}

/** Looks up one normalized barcode in Open Food Facts. Never throws. */
export async function fetchOffProduct(code: string, log?: WarnLogger): Promise<OffLookup> {
  const url = `${OFF_BASE}/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": OFF_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
    });
  } catch (error) {
    log?.warn({ err: error, code }, "open food facts request failed");
    return { kind: "error" };
  }

  // v2 answers unknown codes with HTTP 404 (body: status 0).
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) {
    log?.warn({ status: response.status, code }, "open food facts answered non-ok");
    return { kind: "error" };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    log?.warn({ err: error, code }, "open food facts response was not json");
    return { kind: "error" };
  }
  const record =
    typeof json === "object" && json !== null
      ? (json as { status?: unknown; product?: unknown })
      : {};
  if (record.status === 0) return { kind: "not_found" };
  if (typeof record.product !== "object" || record.product === null) {
    return { kind: "not_found" };
  }
  return { kind: "found", product: record.product };
}
