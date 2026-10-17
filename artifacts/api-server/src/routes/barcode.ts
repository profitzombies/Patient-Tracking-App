/**
 * GET /barcode/:code — packaged-food lookup for the mobile diary's barcode
 * scanner.
 *
 * The app never talks to a nutrition database directly: this route owns the
 * lookup order, so the provider behind it can be swapped without touching
 * the app.
 *
 *   1. In-process hot cache (found results only, small and time-bounded).
 *   2. The shared Supabase nutrition-facts table — the first successful
 *      scan of a product by ANY user saved it there, so repeat scans of
 *      known products never call the third party at all.
 *   3. Open Food Facts v2, normalized to the app's per-serving shape and
 *      upserted into the table under the canonical code.
 *
 * Outcomes are explicit: found (with source: cache | table | openfoodfacts),
 * not_found (honest message steering to the label scanner — nutrition
 * numbers are never invented), 400 for non-barcode input, 429 from the
 * per-IP limiter, and 502 when the upstream fails (distinct from "the
 * database knows it is not there").
 */
import { Router, type IRouter } from "express";
import { requireAppAccess } from "../billing/app-access/gate";
import { bearerToken, resolvePatient } from "../lib/patient-auth";
import { createLimiter, envLimit } from "../coach/limits";
import { normalizeBarcode, normalizeOffProduct, nutritionSnapshotFromOffProduct } from "../barcode/normalize";
import type { FoodNutritionSnapshot } from "@workspace/api-zod";
import { fetchOffProduct } from "../barcode/off";
import {
  getBarcodeFactsRecord,
  upsertBarcodeFactsRecord,
} from "../barcode/facts-store";
import type { BarcodeFactsRow } from "../barcode/facts-store";

const router: IRouter = Router();

/** Wire shape of one found product (brand omitted when the source has none). */
export interface BarcodeFood {
  code: string;
  name: string;
  brand?: string;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  nutritionSnapshot?: FoodNutritionSnapshot;
}

// Open route posture like the other demo endpoints: per-IP budget, generous
// enough for real diary use. BARCODE_LOOKUP_BURST / BARCODE_LOOKUP_DAILY_BUDGET
// override for tests and break/heal staging (read at server start).
const acquireBarcodeSlot = createLimiter({
  burst: envLimit("BARCODE_LOOKUP_BURST", 15),
  refillPerMinute: 15,
  maxConcurrent: 4,
  dailyBudget: envLimit("BARCODE_LOOKUP_DAILY_BUDGET", 1500),
  dailyMessage: "Barcode lookups have reached their daily limit. Please try again tomorrow.",
  busyMessage: "The barcode lookup is busy right now. Please try again in a moment.",
  rapidMessage: "You are scanning barcodes too quickly. Please wait a moment.",
});

const INVALID_CODE_MESSAGE =
  "That does not look like a product barcode. Enter the 8, 12, or 13 digit number printed under the bars.";
const NOT_FOUND_MESSAGE =
  "We could not find that barcode in the nutrition database. Check the number, or scan the Nutrition Facts label instead and the values will come straight off the package.";
const NO_NUTRITION_MESSAGE =
  "We found the product but not a complete nutrition panel for it. Scan the Nutrition Facts label instead and the values will come straight off the package.";
const LOOKUP_FAILED_MESSAGE =
  "The barcode lookup is unavailable right now. Please try again.";

// Hot cache: found results only. The table is the durable shared cache;
// this layer just absorbs repeat scans of the same handful of products in
// one process without a database round trip. Capped and time-bounded so it
// can never grow into a second source of truth.
const HOT_CACHE_MAX = 500;
const HOT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface HotEntry {
  food: BarcodeFood;
  at: number;
}

const hotCache = new Map<string, HotEntry>();

function hotCacheGet(code: string): BarcodeFood | null {
  const entry = hotCache.get(code);
  if (!entry) return null;
  if (Date.now() - entry.at > HOT_CACHE_TTL_MS) {
    hotCache.delete(code);
    return null;
  }
  return entry.food;
}

function hotCachePut(code: string, food: BarcodeFood): void {
  hotCache.delete(code);
  hotCache.set(code, { food, at: Date.now() });
  if (hotCache.size > HOT_CACHE_MAX) {
    const oldest = hotCache.keys().next().value;
    if (oldest !== undefined) hotCache.delete(oldest);
  }
}

/** Test hook: table-served answers must be provable, not hot-cache luck. */
export function clearBarcodeHotCache(): void {
  hotCache.clear();
}

function foodFromRow(row: BarcodeFactsRow): BarcodeFood {
  return {
    code: row.code,
    name: row.name,
    ...(row.brand ? { brand: row.brand } : {}),
    serving: row.serving,
    calories: Number(row.calories),
    protein: Number(row.protein),
    carbs: Number(row.carbs),
    fat: Number(row.fat),
    ...(row.nutrition_snapshot ? { nutritionSnapshot: row.nutrition_snapshot as FoodNutritionSnapshot } : {}),
  };
}

router.get("/barcode/:code", async (req, res) => {
  const slot = acquireBarcodeSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  // A signed-in patient is subject to the office's app-access rule (402
  // upgrade payload); the patient app always sends its bearer for a signed-in
  // account (lib/barcode-food.ts), and the companion patient-app gate task
  // closes the client side. Anonymous and staff lookups are a deliberately
  // separate, open path (no patient to bill); a session that cannot be
  // resolved is answered like any other sign-in problem.
  if (bearerToken(req) !== null) {
    let auth: Awaited<ReturnType<typeof resolvePatient>>;
    try {
      auth = await resolvePatient(req, { consent: "skip" });
    } catch (error) {
      req.log?.error({ err: error }, "barcode lookup patient resolution failed");
      res.status(502).json({ error: LOOKUP_FAILED_MESSAGE });
      return;
    }
    if (auth.ok) {
      if (!(await requireAppAccess(req, res, auth.patientId))) return;
    } else if (auth.status !== 403 || auth.code !== undefined) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }
  }

  try {
    const code = normalizeBarcode(String(req.params.code ?? ""));
    if (!code) {
      res.status(400).json({ error: INVALID_CODE_MESSAGE });
      return;
    }

    const cached = hotCacheGet(code);
    if (cached) {
      req.log?.info({ code, source: "cache" }, "barcode lookup found");
      res.json({ result: "found", source: "cache", food: cached });
      return;
    }

    // Shared table first — a hit means no third-party call at all. A table
    // read failure is logged and treated as a miss so the lookup still works.
    let row: BarcodeFactsRow | null = null;
    try {
      row = await getBarcodeFactsRecord(code);
    } catch (error) {
      req.log?.warn({ err: error, code }, "barcode facts table read failed");
    }
    if (row) {
      const food = foodFromRow(row);
      hotCachePut(code, food);
      req.log?.info({ code, source: "table" }, "barcode lookup found");
      res.json({ result: "found", source: "table", food });
      return;
    }

    const upstream = await fetchOffProduct(code, req.log);
    if (upstream.kind === "error") {
      res.status(502).json({ error: LOOKUP_FAILED_MESSAGE });
      return;
    }
    if (upstream.kind === "not_found") {
      req.log?.info({ code }, "barcode lookup not found");
      res.json({ result: "not_found", message: NOT_FOUND_MESSAGE });
      return;
    }

    const facts = normalizeOffProduct(upstream.product);
    if (!facts) {
      // The database knows the product but not a complete panel — an honest
      // miss that names the better tool, never partial or invented numbers.
      req.log?.info({ code }, "barcode lookup found without usable nutrition");
      res.json({ result: "not_found", message: NO_NUTRITION_MESSAGE });
      return;
    }

    const nutritionSnapshot = nutritionSnapshotFromOffProduct(code, upstream.product, facts);
    const food: BarcodeFood = { code, ...facts, ...(nutritionSnapshot ? { nutritionSnapshot } : {}) };
    try {
      await upsertBarcodeFactsRecord({
        code,
        name: facts.name,
        brand: facts.brand ?? null,
        serving: facts.serving,
        calories: facts.calories,
        protein: facts.protein,
        carbs: facts.carbs,
        fat: facts.fat,
        source: "openfoodfacts",
        ...(nutritionSnapshot ? { nutrition_snapshot: nutritionSnapshot } : {}),
      });
    } catch (error) {
      // The patient still gets their food; the NEXT scan pays the upstream
      // call again. Loud in the logs because the shared cache is the point.
      req.log?.error({ err: error, code }, "barcode facts save failed");
    }
    hotCachePut(code, food);
    req.log?.info({ code, source: "openfoodfacts" }, "barcode lookup found");
    res.json({ result: "found", source: "openfoodfacts", food });
  } catch (error) {
    req.log?.error({ err: error }, "barcode lookup failed");
    if (!res.headersSent) {
      res.status(502).json({ error: LOOKUP_FAILED_MESSAGE });
    }
  } finally {
    slot.release();
  }
});

export default router;
