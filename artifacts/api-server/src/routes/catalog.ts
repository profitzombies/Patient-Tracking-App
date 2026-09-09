import { Router, type IRouter } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { CatalogSelectBody } from "@workspace/api-zod";
import { createLimiter, envLimit } from "../coach/limits";
import { resolvePatient } from "../lib/patient-auth";
import { normalizeBarcode, normalizeOffProduct, nutritionSnapshotFromOffProduct } from "../barcode/normalize";
import { fetchOffProduct, searchOffProducts } from "../barcode/off";
import { upsertBarcodeFactsRecord } from "../barcode/facts-store";
import {
  getCatalogItem,
  getCatalogFamily,
  recordSelection,
  searchCatalog,
  searchCatalogGrouped,
  upsertOffCatalogItem,
  type CatalogItem,
} from "../catalog/store";
import { catalogDisplay, patientFriendlyCatalogOrder } from "../catalog/presentation";

const router: IRouter = Router();
const acquireSlot = createLimiter({
  burst: envLimit("CATALOG_SEARCH_BURST", 30),
  refillPerMinute: 20,
  maxConcurrent: 6,
  dailyBudget: envLimit("CATALOG_SEARCH_DAILY_BUDGET", 3000),
  dailyMessage: "Food searches have reached their daily limit. Please try again tomorrow.",
  busyMessage: "Food search is busy right now. Please try again in a moment.",
  rapidMessage: "You are searching too quickly. Please wait a moment.",
});

const cache = new Map<string, { at: number; products: ExternalItem[]; rawCount: number }>();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 200;
const OFF_RAW_PAGE_SIZE = 20;
const MAX_OFF_PAGES_PER_REQUEST = 10;
const RANKING_VERSION = "food-families-v3";
interface ExternalItem {
  id: string;
  kind: "branded";
  name: string;
  brand: string | null;
  serving: string;
  servingGrams: null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  measures: never[];
  source: "openfoodfacts";
  sourceId: string;
  barcode: string;
  qualityStatus: "community";
  approvals: never[];
  nutritionSnapshot?: unknown;
}

function wire(item: CatalogItem) {
  const display = catalogDisplay(item);
  return {
    id: item.id,
    kind: item.kind,
    name: display.name,
    ...(display.canonicalName ? { canonicalName: display.canonicalName } : {}),
    brand: item.brand,
    serving: item.serving,
    servingGrams: item.serving_grams === null ? null : Number(item.serving_grams),
    calories: Number(item.calories),
    protein: Number(item.protein),
    carbs: Number(item.carbs),
    fat: Number(item.fat),
    measures: item.measures ?? [],
    source: item.source,
    sourceId: item.source_id,
    barcode: item.barcode,
    qualityStatus: item.quality_status,
    approvals: item.approvals ?? [],
    ...(item.resultKey ? { resultKey: item.resultKey } : {}),
    ...(item.familyKey ? { familyKey: item.familyKey } : {}),
    ...(item.variantSummary ? { variantSummary: item.variantSummary } : {}),
    ...(item.dimensions ? { dimensions: item.dimensions } : {}),
    ...(item.choiceRequired !== undefined ? { choiceRequired: item.choiceRequired } : {}),
    ...((item.nutritionSnapshot ?? item.nutrition_snapshot)
      ? { nutritionSnapshot: item.nutritionSnapshot ?? item.nutrition_snapshot }
      : {}),
    ...((item.catalogMetadata ?? item.catalog_metadata)
      ? { catalogMetadata: item.catalogMetadata ?? item.catalog_metadata }
      : {}),
  };
}

interface CatalogCursor {
  q: string;
  intent: "basic" | "packaged";
  approvedOnly: boolean;
  patient: string;
  localOffset: number;
  externalPage: number;
  externalIndex: number;
  externalSeen: string[];
  version: string;
}

function cursorSecret(): string {
  return process.env.CATALOG_CURSOR_SECRET
    ?? process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? "catalog-cursor-development-only";
}

function encodeCursor(value: CatalogCursor): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", cursorSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(raw: string): CatalogCursor | null {
  const [payload, signature, extra] = raw.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", cursorSecret()).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<CatalogCursor>;
    if (
      typeof value.q !== "string"
      || (value.intent !== "basic" && value.intent !== "packaged")
      || typeof value.approvedOnly !== "boolean"
      || typeof value.patient !== "string"
      || !Number.isSafeInteger(value.localOffset) || Number(value.localOffset) < 0
      || !Number.isSafeInteger(value.externalPage) || Number(value.externalPage) < 1
      || !Number.isSafeInteger(value.externalIndex) || Number(value.externalIndex) < 0
      || !Array.isArray(value.externalSeen) || value.externalSeen.length > 120
      || value.externalSeen.some(code => typeof code !== "string" || !/^\d{8,14}$/.test(code))
      || value.version !== RANKING_VERSION
    ) return null;
    return value as CatalogCursor;
  } catch { return null; }
}

export function shouldSearchOff(query: string, explicit: boolean): boolean {
  const clean = query.trim().replace(/\s+/g, " ");
  if (!/[\p{L}\p{N}]{3}/u.test(clean)) return false;
  if (explicit) return clean.length >= 3;
  return clean.length >= 5 && clean.split(" ").filter(Boolean).length >= 2;
}

async function externalPage(query: string, log: Parameters<typeof searchOffProducts>[2], page: number) {
  const key = `${query.toLocaleLowerCase()}:${page}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit;
  const response = await searchOffProducts(query, OFF_RAW_PAGE_SIZE, log, page);
  if (response.kind === "error") return null;
  const seen = new Set<string>();
  const products: ExternalItem[] = [];
  for (const raw of response.products) {
    const record = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
    const code = normalizeBarcode(String(record.code ?? ""));
    const facts = normalizeOffProduct(raw);
    if (!code || !facts || seen.has(code)) continue;
    seen.add(code);
    const nutritionSnapshot = nutritionSnapshotFromOffProduct(code, raw, facts);
    products.push({
      id: `off:${code}`, kind: "branded", name: facts.name, brand: facts.brand ?? null,
      serving: facts.serving, servingGrams: null, calories: facts.calories,
      protein: facts.protein, carbs: facts.carbs, fat: facts.fat, measures: [],
      source: "openfoodfacts", sourceId: code, barcode: code,
      qualityStatus: "community", approvals: [],
      ...(nutritionSnapshot ? { nutritionSnapshot } : {}),
    });
  }
  cache.delete(key);
  const value = { at: Date.now(), products, rawCount: response.products.length };
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return value;
}

interface ExternalPosition {
  page: number;
  index: number;
}

async function collectExternal(
  query: string,
  count: number,
  start: ExternalPosition,
  previouslySeen: string[],
  excludedCodes: Set<string>,
  log: Parameters<typeof searchOffProducts>[2],
) {
  const seen = new Set(previouslySeen);
  const entries: Array<{ item: ExternalItem; after: ExternalPosition }> = [];
  let page = start.page;
  let index = start.index;
  let pagesScanned = 0;
  let couldHaveMore = true;
  while (entries.length < count && pagesScanned < MAX_OFF_PAGES_PER_REQUEST) {
    const loaded = await externalPage(query, log, page);
    if (!loaded) return null;
    pagesScanned += 1;
    for (let current = index; current < loaded.products.length && entries.length < count; current += 1) {
      const item = loaded.products[current];
      if (seen.has(item.barcode) || excludedCodes.has(item.barcode)) continue;
      seen.add(item.barcode);
      entries.push({
        item,
        after: current + 1 < loaded.products.length
          ? { page, index: current + 1 }
          : { page: page + 1, index: 0 },
      });
    }
    if (entries.length >= count) {
      const after = entries.at(-1)!.after;
      couldHaveMore = after.page === page || loaded.rawCount === OFF_RAW_PAGE_SIZE;
      break;
    }
    if (loaded.rawCount < OFF_RAW_PAGE_SIZE) {
      couldHaveMore = false;
      break;
    }
    page += 1;
    index = 0;
  }
  const terminal = entries.at(-1)?.after ?? { page, index };
  if (pagesScanned >= MAX_OFF_PAGES_PER_REQUEST && entries.length < count) couldHaveMore = true;
  return { entries, terminal, couldHaveMore };
}

router.get("/catalog/search", async (req, res) => {
  const slot = acquireSlot(req.ip ?? "unknown");
  if (!slot.ok) { res.status(slot.status).json({ error: slot.message }); return; }
  try {
    const query = typeof req.query.q === "string" ? req.query.q.trim().replace(/\s+/g, " ") : "";
    const grouped = req.query.grouped === "true";
    const limit = grouped
      ? Math.min(Math.max(Number(req.query.limit) || 6, 1), 6)
      : Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const branded = req.query.branded === "true";
    const intent = req.query.intent === "packaged" ? "packaged" : "basic";
    const approvedOnly = req.query.approvedOnly === "true";
    if (query.length < 2 || query.length > 100) {
      res.status(400).json({ error: "Search must be 2-100 characters." }); return;
    }
    // Shared catalog reads are safe for the signed-out guided demo. Passing a
    // null patient id keeps the RPC's private-food and usage joins empty.
    const auth = await resolvePatient(req);
    let patientId: string | null;
    const anonymous = !auth.ok && auth.status === 401;
    if (auth.ok) patientId = auth.patientId;
    else if (anonymous) patientId = null;
    else { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    let localOffset = 0;
    let externalPosition: ExternalPosition = { page: 1, index: 0 };
    let externalSeen: string[] = [];
    if (grouped && typeof req.query.cursor === "string") {
      const decoded = decodeCursor(req.query.cursor);
      const patientContext = patientId ?? "anonymous";
      if (
        !decoded || decoded.q !== query.toLocaleLowerCase()
        || decoded.intent !== intent || decoded.approvedOnly !== approvedOnly
        || decoded.patient !== patientContext
      ) {
        res.status(400).json({ error: "Search changed. Please restart this food search." });
        return;
      }
      localOffset = decoded.localOffset;
      externalPosition = { page: decoded.externalPage, index: decoded.externalIndex };
      externalSeen = decoded.externalSeen;
    }
    const groupedRows = grouped && intent === "basic"
      ? await searchCatalogGrouped(patientId, query, approvedOnly, limit + 1, localOffset)
      : null;
    const local = groupedRows ?? (intent === "basic" ? await searchCatalog(patientId, query, limit) : []);
    let brandedResults: ExternalItem[] = [];
    let nextExternalPosition = externalPosition;
    let externalCouldHaveMore = false;
    let externalUnavailable = false;
    if (
      !anonymous
      && (intent === "packaged" || (shouldSearchOff(query, branded) && (branded || local.length === 0)))
      && (intent === "packaged" || local.length <= limit)
    ) {
      const localForPage = grouped ? local.slice(0, limit) : local;
      const needed = grouped ? Math.max(limit - localForPage.length, 0) : Math.max(limit - local.length, 0);
      const localCodes = new Set(local.map(row => row.barcode).filter((code): code is string => Boolean(code)));
      const found = grouped
        ? await collectExternal(query, needed + 1, externalPosition, externalSeen, localCodes, req.log)
        : await collectExternal(query, Math.min(needed, 10), externalPosition, externalSeen, localCodes, req.log);
      if (found === null) externalUnavailable = true;
      else {
        brandedResults = found.entries.map(entry => entry.item);
        externalCouldHaveMore = found.couldHaveMore;
        if (needed > 0 && found.entries.length > 0) {
          nextExternalPosition = found.entries[Math.min(needed, found.entries.length) - 1].after;
        } else if (needed > 0 && found.entries.length === 0) {
          nextExternalPosition = found.terminal;
        }
      }
    }
    const localCodes = new Set(local.map(row => row.barcode).filter(Boolean));
    brandedResults = brandedResults.filter(row => !localCodes.has(row.barcode));
    const localPage = groupedRows ? local.slice(0, limit) : local;
    const ordered = groupedRows
      ? [...localPage.map(wire), ...brandedResults]
      : [...patientFriendlyCatalogOrder(local, query).map(wire), ...brandedResults];
    const hasMore = grouped
      ? (local.length > limit || ordered.length > limit || externalCouldHaveMore)
      : false;
    res.json({
      results: ordered.slice(0, limit),
      externalUnavailable,
      hasMore,
      nextCursor: hasMore ? encodeCursor({
        q: query.toLocaleLowerCase(), intent, approvedOnly,
        patient: patientId ?? "anonymous",
        localOffset: localOffset + localPage.length,
        externalPage: nextExternalPosition.page,
        externalIndex: nextExternalPosition.index,
        externalSeen: [...externalSeen, ...brandedResults.slice(0, Math.max(limit - localPage.length, 0)).map(row => row.barcode)],
        version: RANKING_VERSION,
      }) : null,
      rankingVersion: RANKING_VERSION,
    });
  } catch (error) {
    req.log?.error({ err: error }, "catalog search failed");
    res.status(502).json({ error: "Food search is unavailable right now." });
  } finally { slot.release(); }
});

router.get("/catalog/families/:familyKey", async (req, res) => {
  const slot = acquireSlot(req.ip ?? "unknown");
  if (!slot.ok) { res.status(slot.status).json({ error: slot.message }); return; }
  try {
    const familyKey = String(req.params.familyKey ?? "");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(familyKey) || familyKey.length > 100) {
      res.status(400).json({ error: "Family key is invalid." }); return;
    }
    const auth = await resolvePatient(req);
    if (!auth.ok && auth.status !== 401) {
      res.status(auth.status).json({ error: auth.error, ...auth.details }); return;
    }
    const variants = await getCatalogFamily(familyKey, req.query.approvedOnly === "true");
    if (variants.length === 0) { res.status(404).json({ error: "Food family not found." }); return; }
    res.json({ variants: variants.map(wire) });
  } catch (error) {
    req.log?.error({ err: error }, "catalog family lookup failed");
    res.status(502).json({ error: "Food family is unavailable right now." });
  } finally { slot.release(); }
});

router.post("/catalog/selections", async (req, res) => {
  const slot = acquireSlot(req.ip ?? "unknown");
  if (!slot.ok) { res.status(slot.status).json({ error: slot.message }); return; }
  try {
    const parsed = CatalogSelectBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Selection id is invalid." }); return; }
    const id = parsed.data.id;
    const auth = await resolvePatient(req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    // Raw custom-food ids are canonical in the mobile library/diary. They are
    // never looked up or promoted here, which keeps them owner-private.
    if (id.startsWith("custom_")) {
      res.json({ selectedId: id, persisted: false }); return;
    }
    let item: CatalogItem | null;
    if (id.startsWith("off:")) {
      const code = normalizeBarcode(id.slice(4));
      if (!code) { res.status(400).json({ error: "Selection id is invalid." }); return; }
      const upstream = await fetchOffProduct(code, req.log);
      if (upstream.kind !== "found") {
        res.status(upstream.kind === "error" ? 502 : 404).json({ error: "That product is no longer available." }); return;
      }
      const facts = normalizeOffProduct(upstream.product);
      if (!facts) { res.status(422).json({ error: "That product has no complete nutrition panel." }); return; }
      const nutritionSnapshot = nutritionSnapshotFromOffProduct(code, upstream.product, facts);
      item = await upsertOffCatalogItem(code, facts, nutritionSnapshot);
      await upsertBarcodeFactsRecord({
        code, name: facts.name, brand: facts.brand ?? null, serving: facts.serving,
        calories: facts.calories, protein: facts.protein, carbs: facts.carbs,
       fat: facts.fat, source: "openfoodfacts",
       ...(nutritionSnapshot ? { nutrition_snapshot: nutritionSnapshot } : {}),
      });
    } else {
      item = await getCatalogItem(id);
      if (!item) { res.status(404).json({ error: "Food not found." }); return; }
    }
    await recordSelection(auth.patientId, item.id);
    res.json({ selectedId: item.id, persisted: true, food: wire(item) });
  } catch (error) {
    req.log?.error({ err: error }, "catalog selection failed");
    res.status(502).json({ error: "That food could not be selected right now." });
  } finally { slot.release(); }
});

export function clearCatalogSearchCache(): void { cache.clear(); }
export default router;