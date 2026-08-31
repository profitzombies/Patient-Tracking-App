/**
 * Patient-data routes — the live per-patient diary rail.
 *
 * A signed-in patient's food diary entries, water, daily-target overrides,
 * and the recents/favorites lists live in service-role-only Supabase tables
 * (see supabase/migrations/20260912000000_patient_diary.sql). The mobile app
 * never touches those tables directly: every read and write comes through
 * here with the patient's bearer session token, which resolves to a
 * patients row exactly like the claim flow's whoami does.
 *
 * Contract with the app (context/PatientContext.tsx real-account mode):
 *  - GET  /patient-data/state       → the full server-backed slice for a
 *    date range: entries (client shape), water by date, target overrides,
 *    favorites, recents. The app hydrates from this on sign-in.
 *  - POST /patient-data/entries     → one gesture's entry writes, batched:
 *    upserts (add / copy / edit / restore-undo carry client-generated ids so
 *    optimistic rows and server rows are the same rows), deletes, and the
 *    recents bump that rides an add. Upserts merge on (patient_id, entry_id).
 *  - PUT  /patient-data/water       → one day's ounces.
 *  - PUT  /patient-data/targets     → partial daily-target override merge.
 *  - PUT  /patient-data/prefs       → favorites and/or recents lists.
 *  - POST /patient-data/library     → one gesture's foods-library writes,
 *    batched: custom-food / saved-recipe upserts (client-generated ids, full
 *    nutrition snapshots, optional patient-media photo paths), deletes, and
 *    the favorites/recents lists that ride a delete. The state read returns
 *    customFoods + savedRecipes alongside the diary slice, so one hydration
 *    fills the whole account-backed store.
 *
 * Failures are explicit: bad payloads 400, missing/expired sessions 401,
 * non-patient accounts 403, upstream trouble 502/503. The app rolls back its
 * optimistic write and shows the error — never a silent local-only save.
 */
import { Router, type IRouter } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolvePatient } from "../lib/patient-auth";
import { createLimiter, envLimit } from "../coach/limits";
import { clientIp } from "../auth/ledger";
import { isOwnPatientMediaPath } from "./patient-media";

const router: IRouter = Router();
const enc = encodeURIComponent;

// ── Per-IP limits (demo posture: open route, bounded abuse) ─────────────────

const WAIT_MESSAGE = "Too many requests from this connection. Please wait a moment and try again.";
const DAILY_MESSAGE = "Too many requests today. Please try again tomorrow.";
const BUSY_MESSAGE = "We're a little busy right now. Please try again in a moment.";

const acquireReadSlot = createLimiter({
  burst: envLimit("PATIENT_DATA_READ_BURST", 30),
  refillPerMinute: 12,
  maxConcurrent: 8,
  dailyBudget: envLimit("PATIENT_DATA_READ_DAILY_BUDGET", 5000),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

const acquireWriteSlot = createLimiter({
  burst: envLimit("PATIENT_DATA_WRITE_BURST", 40),
  refillPerMinute: 20,
  maxConcurrent: 8,
  dailyBudget: envLimit("PATIENT_DATA_WRITE_DAILY_BUDGET", 8000),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

// ── Validation ───────────────────────────────────────────────────────────────
// (Auth — bearer session → patient row — lives in ../lib/patient-auth, shared
// with the patient-media rail.)

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MEALS = new Set(["breakfast", "lunch", "dinner", "snacks"]);
const KINDS = new Set(["food", "recipe", "quick"]);

/** Real calendar date in a sane window, formatted exactly YYYY-MM-DD. */
function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return false;
  if (new Date(time).toISOString().slice(0, 10) !== value) return false;
  return value >= "2020-01-01" && value <= "2035-12-31";
}

function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Array of opaque catalog/custom ids (favorites, recents, deleteIds). */
function parseIdList(value: unknown, maxItems: number, maxLength = 80): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.length < 1 || id.length > maxLength) return null;
    out.push(id);
  }
  return out;
}

interface EntryRow {
  patient_id: string;
  entry_id: string;
  date_key: string;
  meal: string;
  kind: string;
  ref_id: string | null;
  name: string;
  detail: string;
  quantity: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  adjustments: Array<{ index: number; amount: number; unit: string }> | null;
  updated_at: string;
}

/**
 * One diary entry from the app, checked field by field into a DB row.
 * Snapshots are stored verbatim (no trimming/rewriting) so the row the app
 * wrote optimistically and the row it hydrates later are identical.
 */
function parseEntry(
  raw: unknown,
  patientId: string,
  stamp: string,
): { row: EntryRow } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Each entry must be an object." };
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !ENTRY_ID_RE.test(e.id)) {
    return { error: "Entry id is invalid." };
  }
  if (!isDateKey(e.dateKey)) return { error: "Entry date is invalid." };
  if (typeof e.meal !== "string" || !MEALS.has(e.meal)) {
    return { error: "Entry meal slot is invalid." };
  }
  if (typeof e.kind !== "string" || !KINDS.has(e.kind)) {
    return { error: "Entry kind is invalid." };
  }
  const refId = e.refId === undefined || e.refId === null ? null : e.refId;
  if (refId !== null && (typeof refId !== "string" || refId.length < 1 || refId.length > 80)) {
    return { error: "Entry refId is invalid." };
  }
  if (typeof e.name !== "string" || e.name.trim().length < 1 || e.name.length > 200) {
    return { error: "Entry name must be 1-200 characters." };
  }
  const detail = e.detail === undefined ? "" : e.detail;
  if (typeof detail !== "string" || detail.length > 300) {
    return { error: "Entry detail is too long." };
  }
  if (!numberIn(e.quantity, 0, 999) || (e.quantity as number) <= 0) {
    return { error: "Entry quantity is invalid." };
  }
  if (!numberIn(e.calories, 0, 50000)) return { error: "Entry calories are invalid." };
  if (!numberIn(e.protein, 0, 5000)) return { error: "Entry protein is invalid." };
  if (!numberIn(e.carbs, 0, 5000)) return { error: "Entry carbs are invalid." };
  if (!numberIn(e.fat, 0, 5000)) return { error: "Entry fat is invalid." };
  let adjustments: EntryRow["adjustments"] = null;
  if (e.adjustments !== undefined && e.adjustments !== null) {
    if (!Array.isArray(e.adjustments) || e.adjustments.length > 60) {
      return { error: "Entry adjustments are invalid." };
    }
    const cleaned: Array<{ index: number; amount: number; unit: string }> = [];
    for (const item of e.adjustments) {
      if (typeof item !== "object" || item === null) {
        return { error: "Entry adjustments are invalid." };
      }
      const adj = item as Record<string, unknown>;
      if (!numberIn(adj.index, 0, 500) || !Number.isInteger(adj.index)) {
        return { error: "Entry adjustments are invalid." };
      }
      if (!numberIn(adj.amount, 0, 100000)) return { error: "Entry adjustments are invalid." };
      if (typeof adj.unit !== "string" || adj.unit.length > 40) {
        return { error: "Entry adjustments are invalid." };
      }
      cleaned.push({ index: adj.index, amount: adj.amount, unit: adj.unit });
    }
    if (cleaned.length > 0) adjustments = cleaned;
  }
  return {
    row: {
      patient_id: patientId,
      entry_id: e.id,
      date_key: e.dateKey,
      meal: e.meal,
      kind: e.kind,
      ref_id: refId,
      name: e.name,
      detail,
      quantity: e.quantity,
      calories: e.calories,
      protein: e.protein,
      carbs: e.carbs,
      fat: e.fat,
      adjustments,
      updated_at: stamp,
    },
  };
}

// ── Library validation (custom foods + saved recipes) ───────────────────────

const RECIPE_MODES = new Set(["recipe", "cravings", "meal"]);

/** Optional photo reference: must be a media path under THIS patient's prefix. */
function parsePhotoPath(
  value: unknown,
  patientId: string,
): { path: string | null } | { error: string } {
  if (value === undefined || value === null) return { path: null };
  if (typeof value !== "string" || !isOwnPatientMediaPath(value, patientId)) {
    return { error: "Photo reference is invalid." };
  }
  return { path: value };
}

interface FoodRow {
  food_id: string;
  name: string;
  brand: string | null;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  photo_path: string | null;
}

/**
 * One custom food from the app, checked field by field into a DB row.
 * Snapshots are stored verbatim so the item the app wrote optimistically and
 * the item it hydrates later are identical. The category is a client
 * constant ("My Foods") and never stored.
 */
function parseCustomFood(raw: unknown, patientId: string): { row: FoodRow } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Each food must be an object." };
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== "string" || !ENTRY_ID_RE.test(f.id)) {
    return { error: "Food id is invalid." };
  }
  if (typeof f.name !== "string" || f.name.trim().length < 1 || f.name.length > 200) {
    return { error: "Food name must be 1-200 characters." };
  }
  const brand = f.brand === undefined || f.brand === null ? null : f.brand;
  if (brand !== null && (typeof brand !== "string" || brand.length < 1 || brand.length > 120)) {
    return { error: "Food brand is invalid." };
  }
  if (typeof f.serving !== "string" || f.serving.length < 1 || f.serving.length > 160) {
    return { error: "Food serving is invalid." };
  }
  if (!numberIn(f.calories, 0, 50000)) return { error: "Food calories are invalid." };
  if (!numberIn(f.protein, 0, 5000)) return { error: "Food protein is invalid." };
  if (!numberIn(f.carbs, 0, 5000)) return { error: "Food carbs are invalid." };
  if (!numberIn(f.fat, 0, 5000)) return { error: "Food fat is invalid." };
  const photo = parsePhotoPath(f.photoPath, patientId);
  if ("error" in photo) return photo;
  return {
    row: {
      food_id: f.id,
      name: f.name,
      brand,
      serving: f.serving,
      calories: f.calories,
      protein: f.protein,
      carbs: f.carbs,
      fat: f.fat,
      photo_path: photo.path,
    },
  };
}

interface RecipeRow {
  recipe_id: string;
  name: string;
  meal: string;
  mode: string;
  tags: string[];
  minutes: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  description: string;
  ingredients: Array<Record<string, unknown>>;
  steps: string[];
  grocery_list: string[] | null;
  saved_at: string;
  photo_path: string | null;
}

/** Array of short strings (tags, steps, grocery list). */
function parseStringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > maxLength) return null;
    out.push(item);
  }
  return out;
}

/**
 * One saved AI recipe from the app, checked field by field into a DB row.
 * The recipe is a full self-contained snapshot (per-serving totals plus the
 * coach's original ingredient amounts and per-ingredient nutrition); the
 * source is a client constant ("coach") and never stored.
 */
function parseSavedRecipe(raw: unknown, patientId: string): { row: RecipeRow } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Each recipe must be an object." };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ENTRY_ID_RE.test(r.id)) {
    return { error: "Recipe id is invalid." };
  }
  if (typeof r.name !== "string" || r.name.trim().length < 1 || r.name.length > 200) {
    return { error: "Recipe name must be 1-200 characters." };
  }
  if (typeof r.meal !== "string" || !MEALS.has(r.meal)) {
    return { error: "Recipe meal slot is invalid." };
  }
  if (typeof r.mode !== "string" || !RECIPE_MODES.has(r.mode)) {
    return { error: "Recipe mode is invalid." };
  }
  const tags = parseStringList(r.tags ?? [], 12, 40);
  if (tags === null) return { error: "Recipe tags are invalid." };
  if (!numberIn(r.minutes, 0, 2000)) return { error: "Recipe minutes are invalid." };
  if (!numberIn(r.servings, 0, 1000)) return { error: "Recipe servings are invalid." };
  if (!numberIn(r.calories, 0, 50000)) return { error: "Recipe calories are invalid." };
  if (!numberIn(r.protein, 0, 5000)) return { error: "Recipe protein is invalid." };
  if (!numberIn(r.carbs, 0, 5000)) return { error: "Recipe carbs are invalid." };
  if (!numberIn(r.fat, 0, 5000)) return { error: "Recipe fat is invalid." };
  const description = r.description === undefined ? "" : r.description;
  if (typeof description !== "string" || description.length > 2000) {
    return { error: "Recipe description is too long." };
  }
  if (!Array.isArray(r.ingredients) || r.ingredients.length > 60) {
    return { error: "Recipe ingredients are invalid." };
  }
  const ingredients: Array<Record<string, unknown>> = [];
  for (const item of r.ingredients) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: "Recipe ingredients are invalid." };
    }
    const ing = item as Record<string, unknown>;
    if (!numberIn(ing.amount, 0, 100000)) return { error: "Recipe ingredients are invalid." };
    if (typeof ing.unit !== "string" || ing.unit.length > 40) {
      return { error: "Recipe ingredients are invalid." };
    }
    if (typeof ing.name !== "string" || ing.name.length < 1 || ing.name.length > 200) {
      return { error: "Recipe ingredients are invalid." };
    }
    const cleaned: Record<string, unknown> = { amount: ing.amount, unit: ing.unit, name: ing.name };
    if (ing.nutrition !== undefined && ing.nutrition !== null) {
      if (typeof ing.nutrition !== "object" || Array.isArray(ing.nutrition)) {
        return { error: "Recipe ingredients are invalid." };
      }
      const n = ing.nutrition as Record<string, unknown>;
      if (
        !numberIn(n.calories, 0, 50000) ||
        !numberIn(n.protein, 0, 5000) ||
        !numberIn(n.carbs, 0, 5000) ||
        !numberIn(n.fat, 0, 5000)
      ) {
        return { error: "Recipe ingredients are invalid." };
      }
      cleaned.nutrition = { calories: n.calories, protein: n.protein, carbs: n.carbs, fat: n.fat };
    }
    ingredients.push(cleaned);
  }
  const steps = parseStringList(r.steps ?? [], 40, 600);
  if (steps === null) return { error: "Recipe steps are invalid." };
  let groceryList: string[] | null = null;
  if (r.groceryList !== undefined && r.groceryList !== null) {
    groceryList = parseStringList(r.groceryList, 80, 200);
    if (groceryList === null) return { error: "Recipe grocery list is invalid." };
  }
  if (typeof r.savedAt !== "string" || r.savedAt.length < 1 || r.savedAt.length > 40) {
    return { error: "Recipe save time is invalid." };
  }
  const photo = parsePhotoPath(r.photoPath, patientId);
  if ("error" in photo) return photo;
  return {
    row: {
      recipe_id: r.id,
      name: r.name,
      meal: r.meal,
      mode: r.mode,
      tags,
      minutes: r.minutes,
      servings: r.servings,
      calories: r.calories,
      protein: r.protein,
      carbs: r.carbs,
      fat: r.fat,
      description,
      ingredients,
      steps,
      grocery_list: groceryList,
      saved_at: r.savedAt,
      photo_path: photo.path,
    },
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

const MAX_ENTRIES_RETURNED = 5000;
const MAX_FOODS_RETURNED = 2000;
const MAX_RECIPES_RETURNED = 1000;

router.get("/patient-data/state", async (req, res) => {
  const slot = acquireReadSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    if ((from !== null && !isDateKey(from)) || (to !== null && !isDateKey(to))) {
      res.status(400).json({ error: "Invalid date range." });
      return;
    }
    const pid = enc(auth.patientId);
    const rangeFilters = (prefix: string[]) => {
      const filters = [...prefix];
      if (from) filters.push(`date_key=gte.${from}`);
      if (to) filters.push(`date_key=lte.${to}`);
      return filters.join("&");
    };
    const [entries, water, targets, prefs, foods, recipes] = await Promise.all([
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_diary_entries?${rangeFilters([`patient_id=eq.${pid}`])}` +
          `&select=entry_id,date_key,meal,kind,ref_id,name,detail,quantity,calories,protein,carbs,fat,adjustments` +
          `&order=created_at.asc,entry_id.asc&limit=${MAX_ENTRIES_RETURNED}`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_water_days?${rangeFilters([`patient_id=eq.${pid}`])}&select=date_key,oz&limit=400`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_target_overrides?patient_id=eq.${pid}&select=calories,protein,carbs,fat,water_oz`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_food_prefs?patient_id=eq.${pid}&select=favorites,recents`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_custom_foods?patient_id=eq.${pid}` +
          `&select=food_id,name,brand,serving,calories,protein,carbs,fat,photo_path` +
          `&order=created_at.asc,food_id.asc&limit=${MAX_FOODS_RETURNED}`,
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_saved_recipes?patient_id=eq.${pid}` +
          `&select=recipe_id,name,meal,mode,tags,minutes,servings,calories,protein,carbs,fat,description,ingredients,steps,grocery_list,saved_at,photo_path` +
          `&order=created_at.asc,recipe_id.asc&limit=${MAX_RECIPES_RETURNED}`,
      ),
    ]);
    for (const r of [entries, water, targets, prefs, foods, recipes]) {
      if (r.status >= 300 || !Array.isArray(r.json)) throw new Error(`state fetch failed (${r.status})`);
    }

    const entryList = (entries.json as Array<Record<string, unknown>>).map(row => {
      const entry: Record<string, unknown> = {
        id: row.entry_id,
        dateKey: String(row.date_key),
        meal: row.meal,
        kind: row.kind,
        name: row.name,
        detail: typeof row.detail === "string" ? row.detail : "",
        quantity: Number(row.quantity),
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbs: Number(row.carbs),
        fat: Number(row.fat),
      };
      if (typeof row.ref_id === "string" && row.ref_id.length > 0) entry.refId = row.ref_id;
      if (Array.isArray(row.adjustments) && row.adjustments.length > 0) {
        entry.adjustments = row.adjustments;
      }
      return entry;
    });

    const waterMap: Record<string, number> = {};
    for (const row of water.json as Array<Record<string, unknown>>) {
      waterMap[String(row.date_key)] = Number(row.oz);
    }

    const targetRow = (targets.json as Array<Record<string, unknown>>)[0];
    const targetOverrides: Record<string, number> = {};
    if (targetRow) {
      if (typeof targetRow.calories === "number") targetOverrides.calories = targetRow.calories;
      if (typeof targetRow.protein === "number") targetOverrides.protein = targetRow.protein;
      if (typeof targetRow.carbs === "number") targetOverrides.carbs = targetRow.carbs;
      if (typeof targetRow.fat === "number") targetOverrides.fat = targetRow.fat;
      if (typeof targetRow.water_oz === "number") targetOverrides.waterOz = targetRow.water_oz;
    }

    const prefRow = (prefs.json as Array<Record<string, unknown>>)[0];
    const favorites = Array.isArray(prefRow?.favorites)
      ? (prefRow.favorites as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const recents = Array.isArray(prefRow?.recents)
      ? (prefRow.recents as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

    // Library rows come back in the app's own shapes. Constants the client
    // owns (custom-food category, recipe source) are injected here, not
    // stored; photo paths ride as photoPath and the app builds display URLs.
    const customFoods = (foods.json as Array<Record<string, unknown>>).map(row => {
      const item: Record<string, unknown> = {
        id: row.food_id,
        name: row.name,
        serving: row.serving,
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbs: Number(row.carbs),
        fat: Number(row.fat),
        category: "My Foods",
      };
      if (typeof row.brand === "string" && row.brand.length > 0) item.brand = row.brand;
      if (typeof row.photo_path === "string" && row.photo_path.length > 0) {
        item.photoPath = row.photo_path;
      }
      return item;
    });

    const savedRecipes = (recipes.json as Array<Record<string, unknown>>).map(row => {
      const item: Record<string, unknown> = {
        id: row.recipe_id,
        name: row.name,
        meal: row.meal,
        tags: Array.isArray(row.tags) ? row.tags : [],
        minutes: Number(row.minutes),
        servings: Number(row.servings),
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbs: Number(row.carbs),
        fat: Number(row.fat),
        description: typeof row.description === "string" ? row.description : "",
        ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
        steps: Array.isArray(row.steps) ? row.steps : [],
        source: "coach",
        mode: row.mode,
        savedAt: row.saved_at,
      };
      if (Array.isArray(row.grocery_list) && row.grocery_list.length > 0) {
        item.groceryList = row.grocery_list;
      }
      if (typeof row.photo_path === "string" && row.photo_path.length > 0) {
        item.photoPath = row.photo_path;
      }
      return item;
    });

    res.json({
      entries: entryList,
      water: waterMap,
      targets: targetOverrides,
      favorites,
      recents,
      customFoods,
      savedRecipes,
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data state fetch failed");
    res.status(502).json({ error: "Couldn't load your diary right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.post("/patient-data/entries", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    let upsertRaw: unknown[] = [];
    if (body.upsert !== undefined) {
      if (!Array.isArray(body.upsert) || body.upsert.length > 80) {
        res.status(400).json({ error: "Entry batch is invalid (at most 80 entries)." });
        return;
      }
      upsertRaw = body.upsert;
    }
    let deleteIds: string[] = [];
    if (body.deleteIds !== undefined) {
      const parsed = parseIdList(body.deleteIds, 200, 64);
      if (parsed === null || parsed.some(id => !ENTRY_ID_RE.test(id))) {
        res.status(400).json({ error: "Delete list is invalid." });
        return;
      }
      deleteIds = parsed;
    }
    let recents: string[] | undefined;
    if (body.recents !== undefined) {
      const parsed = parseIdList(body.recents, 50);
      if (parsed === null) {
        res.status(400).json({ error: "Recents list is invalid." });
        return;
      }
      recents = parsed;
    }
    if (upsertRaw.length === 0 && deleteIds.length === 0 && recents === undefined) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }

    const stamp = new Date().toISOString();
    const rows: EntryRow[] = [];
    for (const raw of upsertRaw) {
      const parsed = parseEntry(raw, auth.patientId, stamp);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      rows.push(parsed.row);
    }

    // The whole mutation — upserts, deletes, and the recents bump — lands in
    // ONE transaction via the patient_diary_apply function, so a mid-write
    // failure can never strand part of it on the server while the app rolls
    // back its optimistic state. The function takes patient identity from
    // p_patient_id alone and assigns created_at itself (preserved on merge).
    const applied = await supabaseAdmin("POST", "/rest/v1/rpc/patient_diary_apply", {
      p_patient_id: auth.patientId,
      p_upsert: rows,
      p_delete_ids: deleteIds,
      p_recents: recents ?? null,
    });
    if (applied.status >= 300) throw new Error(`diary apply failed (${applied.status})`);

    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data entries write failed");
    res.status(502).json({ error: "Couldn't save to your diary right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.put("/patient-data/water", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isDateKey(body.dateKey)) {
      res.status(400).json({ error: "Water date is invalid." });
      return;
    }
    if (!numberIn(body.oz, 0, 200) || !Number.isInteger(body.oz)) {
      res.status(400).json({ error: "Water ounces are invalid." });
      return;
    }
    const upsert = await supabaseAdmin(
      "POST",
      "/rest/v1/patient_water_days?on_conflict=patient_id,date_key",
      [
        {
          patient_id: auth.patientId,
          date_key: body.dateKey,
          oz: body.oz,
          updated_at: new Date().toISOString(),
        },
      ],
      "resolution=merge-duplicates,return=minimal",
    );
    if (upsert.status >= 300) throw new Error(`water upsert failed (${upsert.status})`);
    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data water write failed");
    res.status(502).json({ error: "Couldn't save your water right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.put("/patient-data/targets", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row: Record<string, unknown> = { patient_id: auth.patientId };
    if (body.calories !== undefined) {
      if (!numberIn(body.calories, 0, 20000)) {
        res.status(400).json({ error: "Calorie target is invalid." });
        return;
      }
      row.calories = body.calories;
    }
    if (body.protein !== undefined) {
      if (!numberIn(body.protein, 0, 2000)) {
        res.status(400).json({ error: "Protein target is invalid." });
        return;
      }
      row.protein = body.protein;
    }
    if (body.carbs !== undefined) {
      if (!numberIn(body.carbs, 0, 2000)) {
        res.status(400).json({ error: "Carb target is invalid." });
        return;
      }
      row.carbs = body.carbs;
    }
    if (body.fat !== undefined) {
      if (!numberIn(body.fat, 0, 2000)) {
        res.status(400).json({ error: "Fat target is invalid." });
        return;
      }
      row.fat = body.fat;
    }
    if (body.waterOz !== undefined) {
      if (!numberIn(body.waterOz, 0, 200)) {
        res.status(400).json({ error: "Water target is invalid." });
        return;
      }
      row.water_oz = body.waterOz;
    }
    if (Object.keys(row).length === 1) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }
    row.updated_at = new Date().toISOString();
    const upsert = await supabaseAdmin(
      "POST",
      "/rest/v1/patient_target_overrides?on_conflict=patient_id",
      [row],
      "resolution=merge-duplicates,return=minimal",
    );
    if (upsert.status >= 300) throw new Error(`target upsert failed (${upsert.status})`);
    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data targets write failed");
    res.status(502).json({ error: "Couldn't save your targets right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.put("/patient-data/prefs", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row: Record<string, unknown> = { patient_id: auth.patientId };
    if (body.favorites !== undefined) {
      const favorites = parseIdList(body.favorites, 500);
      if (favorites === null) {
        res.status(400).json({ error: "Favorites list is invalid." });
        return;
      }
      row.favorites = favorites;
    }
    if (body.recents !== undefined) {
      const recents = parseIdList(body.recents, 50);
      if (recents === null) {
        res.status(400).json({ error: "Recents list is invalid." });
        return;
      }
      row.recents = recents;
    }
    if (Object.keys(row).length === 1) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }
    row.updated_at = new Date().toISOString();
    const upsert = await supabaseAdmin(
      "POST",
      "/rest/v1/patient_food_prefs?on_conflict=patient_id",
      [row],
      "resolution=merge-duplicates,return=minimal",
    );
    if (upsert.status >= 300) throw new Error(`prefs upsert failed (${upsert.status})`);
    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data prefs write failed");
    res.status(502).json({ error: "Couldn't save your preferences right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

router.post("/patient-data/library", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const foodRows: FoodRow[] = [];
    if (body.foodUpsert !== undefined) {
      if (!Array.isArray(body.foodUpsert) || body.foodUpsert.length > 40) {
        res.status(400).json({ error: "Food batch is invalid (at most 40 foods)." });
        return;
      }
      for (const raw of body.foodUpsert) {
        const parsed = parseCustomFood(raw, auth.patientId);
        if ("error" in parsed) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        foodRows.push(parsed.row);
      }
    }

    const recipeRows: RecipeRow[] = [];
    if (body.recipeUpsert !== undefined) {
      if (!Array.isArray(body.recipeUpsert) || body.recipeUpsert.length > 20) {
        res.status(400).json({ error: "Recipe batch is invalid (at most 20 recipes)." });
        return;
      }
      for (const raw of body.recipeUpsert) {
        const parsed = parseSavedRecipe(raw, auth.patientId);
        if ("error" in parsed) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        recipeRows.push(parsed.row);
      }
    }

    let foodDeleteIds: string[] = [];
    if (body.foodDeleteIds !== undefined) {
      const parsed = parseIdList(body.foodDeleteIds, 200, 64);
      if (parsed === null || parsed.some(id => !ENTRY_ID_RE.test(id))) {
        res.status(400).json({ error: "Food delete list is invalid." });
        return;
      }
      foodDeleteIds = parsed;
    }
    let recipeDeleteIds: string[] = [];
    if (body.recipeDeleteIds !== undefined) {
      const parsed = parseIdList(body.recipeDeleteIds, 200, 64);
      if (parsed === null || parsed.some(id => !ENTRY_ID_RE.test(id))) {
        res.status(400).json({ error: "Recipe delete list is invalid." });
        return;
      }
      recipeDeleteIds = parsed;
    }

    let favorites: string[] | null = null;
    if (body.favorites !== undefined) {
      favorites = parseIdList(body.favorites, 500);
      if (favorites === null) {
        res.status(400).json({ error: "Favorites list is invalid." });
        return;
      }
    }
    let recents: string[] | null = null;
    if (body.recents !== undefined) {
      recents = parseIdList(body.recents, 50);
      if (recents === null) {
        res.status(400).json({ error: "Recents list is invalid." });
        return;
      }
    }

    if (
      foodRows.length === 0 &&
      recipeRows.length === 0 &&
      foodDeleteIds.length === 0 &&
      recipeDeleteIds.length === 0 &&
      favorites === null &&
      recents === null
    ) {
      res.status(400).json({ error: "Nothing to save." });
      return;
    }

    // The whole mutation — item upserts, deletes, the photo-ledger
    // bookkeeping, and the favorites/recents lists that ride a delete —
    // lands in ONE transaction via the patient_library_apply function, so a
    // mid-write failure can never strand the account between an item and
    // its prefs, or leave a deleted item's photo still referenced. The
    // function takes patient identity from p_patient_id alone, preserves
    // created_at on merge, and keeps the patient_media ledger in lockstep
    // (replaced photos de-referenced, upserted paths re-registered, deleted
    // items' photos dropped).
    const applied = await supabaseAdmin("POST", "/rest/v1/rpc/patient_library_apply", {
      p_patient_id: auth.patientId,
      p_food_upsert: foodRows,
      p_food_delete_ids: foodDeleteIds,
      p_recipe_upsert: recipeRows,
      p_recipe_delete_ids: recipeDeleteIds,
      p_favorites: favorites,
      p_recents: recents,
    });
    if (applied.status >= 300) throw new Error(`library apply failed (${applied.status})`);

    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-data library write failed");
    res.status(502).json({ error: "Couldn't save your library right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;
