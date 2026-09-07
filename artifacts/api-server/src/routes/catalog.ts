import { Router, type IRouter } from "express";
import { CatalogSelectBody } from "@workspace/api-zod";
import { createLimiter, envLimit } from "../coach/limits";
import { resolvePatient } from "../lib/patient-auth";
import { normalizeBarcode, normalizeOffProduct } from "../barcode/normalize";
import { fetchOffProduct, searchOffProducts } from "../barcode/off";
import { upsertBarcodeFactsRecord } from "../barcode/facts-store";
import {
  getCatalogItem,
  recordSelection,
  searchCatalog,
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

const cache = new Map<string, { at: number; products: ExternalItem[] }>();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 200;
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
  };
}

export function shouldSearchOff(query: string, explicit: boolean): boolean {
  const clean = query.trim().replace(/\s+/g, " ");
  if (!/[\p{L}\p{N}]{3}/u.test(clean)) return false;
  if (explicit) return clean.length >= 3;
  return clean.length >= 5 && clean.split(" ").filter(Boolean).length >= 2;
}

async function external(query: string, limit: number, log: Parameters<typeof searchOffProducts>[2]) {
  const key = query.toLocaleLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.products.slice(0, limit);
  const response = await searchOffProducts(query, limit, log);
  if (response.kind === "error") return null;
  const seen = new Set<string>();
  const products: ExternalItem[] = [];
  for (const raw of response.products) {
    const record = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
    const code = normalizeBarcode(String(record.code ?? ""));
    const facts = normalizeOffProduct(raw);
    if (!code || !facts || seen.has(code)) continue;
    seen.add(code);
    products.push({
      id: `off:${code}`, kind: "branded", name: facts.name, brand: facts.brand ?? null,
      serving: facts.serving, servingGrams: null, calories: facts.calories,
      protein: facts.protein, carbs: facts.carbs, fat: facts.fat, measures: [],
      source: "openfoodfacts", sourceId: code, barcode: code,
      qualityStatus: "community", approvals: [],
    });
  }
  cache.delete(key);
  cache.set(key, { at: Date.now(), products });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return products;
}

router.get("/catalog/search", async (req, res) => {
  const slot = acquireSlot(req.ip ?? "unknown");
  if (!slot.ok) { res.status(slot.status).json({ error: slot.message }); return; }
  try {
    const query = typeof req.query.q === "string" ? req.query.q.trim().replace(/\s+/g, " ") : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const branded = req.query.branded === "true";
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
    const local = await searchCatalog(patientId, query, limit);
    let brandedResults: ExternalItem[] = [];
    let externalUnavailable = false;
    if (!anonymous && shouldSearchOff(query, branded) && local.length < limit) {
      const found = await external(query, Math.min(limit - local.length, 10), req.log);
      if (found === null) externalUnavailable = true;
      else brandedResults = found;
    }
    const localCodes = new Set(local.map(row => row.barcode).filter(Boolean));
    brandedResults = brandedResults.filter(row => !localCodes.has(row.barcode));
    res.json({
      results: [...patientFriendlyCatalogOrder(local, query).map(wire), ...brandedResults].slice(0, limit),
      externalUnavailable,
    });
  } catch (error) {
    req.log?.error({ err: error }, "catalog search failed");
    res.status(502).json({ error: "Food search is unavailable right now." });
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
      item = await upsertOffCatalogItem(code, facts);
      await upsertBarcodeFactsRecord({
        code, name: facts.name, brand: facts.brand ?? null, serving: facts.serving,
        calories: facts.calories, protein: facts.protein, carbs: facts.carbs,
        fat: facts.fat, source: "openfoodfacts",
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