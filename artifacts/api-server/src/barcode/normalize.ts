/**
 * Barcode and Open Food Facts normalization — pure functions, no I/O.
 *
 * normalizeBarcode maps every way a patient (or a camera) writes a product
 * code onto ONE canonical key so the shared nutrition-facts table never
 * stores the same product twice: digits only, EAN-8 stays 8 digits, UPC-A
 * (12 digits) is zero-padded to its GTIN-13 form, and a 14-digit GTIN with a
 * leading zero drops it. Anything else is rejected — the route answers 400
 * before touching the table or the upstream.
 *
 * normalizeOffProduct turns one raw Open Food Facts product record into the
 * app's per-serving nutrition shape, or null when the record has no usable
 * panel. Published data only: the labeled per-serving basis is preferred;
 * the per-100g basis is scaled to the labeled serving when the product
 * prints one; plain "100 g" is the honest fallback. A product missing its
 * name, its calories, or any macro is unusable — values are never invented.
 */
import { createHash } from "node:crypto";
import type { FoodNutritionSnapshot } from "@workspace/api-zod";

/** Per-serving nutrition facts in the app's shape (grams for macros). */
export interface BarcodeProductFacts {
  name: string;
  brand?: string;
  /** The serving the values describe, e.g. "30 g" or "2 cookies (28g)". */
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

const MAX_NAME = 120;
const MAX_BRAND = 80;
const MAX_SERVING = 80;

// Junk guards: community-sourced rows occasionally carry absurd values
// (per-serving calories in the tens of thousands). Such a row is worse than
// a miss — the patient is pointed to the label scanner instead.
const MAX_CALORIES = 5000;
const MAX_MACRO_GRAMS = 500;

/**
 * Canonicalizes a typed or scanned barcode. Returns the storage key (8 or 13
 * digits) or null when the input is not a UPC/EAN style code.
 */
export function normalizeBarcode(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s-]/g, "");
  if (!/^[0-9]+$/.test(cleaned)) return null;
  let code = cleaned;
  // GTIN-14 with a leading zero is the same article as its GTIN-13 form.
  if (code.length === 14 && code.startsWith("0")) code = code.slice(1);
  // UPC-A is the 13-digit form with the leading zero left off.
  if (code.length === 12) code = `0${code}`;
  if (code.length !== 8 && code.length !== 13) return null;
  if (/^0+$/.test(code)) return null;
  return code;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Trimmed, whitespace-collapsed text capped at max; null when empty. */
function readText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Finite non-negative number from a number or numeric string, else null. */
function readNumber(value: unknown): number | null {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(num) && num >= 0 ? num : null;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

interface MacroBasis {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/**
 * Reads one complete calories+macros basis from OFF nutriments. Partial
 * panels return null — a missing macro must fail the lookup, not become 0.
 */
function basisFrom(
  nutriments: Record<string, unknown>,
  suffix: "_serving" | "_100g",
): MacroBasis | null {
  const calories = readNumber(nutriments[`energy-kcal${suffix}`]);
  const protein = readNumber(nutriments[`proteins${suffix}`]);
  const carbs = readNumber(nutriments[`carbohydrates${suffix}`]);
  const fat = readNumber(nutriments[`fat${suffix}`]);
  if (calories === null || protein === null || carbs === null || fat === null) {
    return null;
  }
  return { calories, protein, carbs, fat };
}

function finishFacts(
  name: string,
  brand: string | null,
  serving: string,
  basis: MacroBasis,
): BarcodeProductFacts | null {
  const calories = Math.round(basis.calories);
  const protein = round1(basis.protein);
  const carbs = round1(basis.carbs);
  const fat = round1(basis.fat);
  if (
    calories > MAX_CALORIES ||
    protein > MAX_MACRO_GRAMS ||
    carbs > MAX_MACRO_GRAMS ||
    fat > MAX_MACRO_GRAMS
  ) {
    return null;
  }
  return {
    name,
    ...(brand ? { brand } : {}),
    serving,
    calories,
    protein,
    carbs,
    fat,
  };
}

/**
 * Normalizes one raw Open Food Facts v2 product record (already unwrapped
 * from the response envelope) to per-serving facts, or null when the record
 * lacks a usable name or complete nutrition basis.
 */
export function normalizeOffProduct(value: unknown): BarcodeProductFacts | null {
  const product = readRecord(value);
  if (!product) return null;

  const name = readText(product.product_name, MAX_NAME);
  if (!name) return null;

  // "brands" is a comma-separated list; the first entry is the label brand.
  const brand =
    typeof product.brands === "string"
      ? readText(product.brands.split(",")[0], MAX_BRAND)
      : null;

  const nutriments = readRecord(product.nutriments);
  if (!nutriments) return null;

  const servingLabel = readText(product.serving_size, MAX_SERVING);
  const servingQty = readNumber(product.serving_quantity);

  // 1) The labeled per-serving basis, exactly as published.
  const perServing = basisFrom(nutriments, "_serving");
  if (perServing) {
    return finishFacts(name, brand, servingLabel ?? "1 serving", perServing);
  }

  // 2) Per-100 values scaled to the labeled serving — ONLY when the serving's
  //    unit verifiably matches the basis unit (grams with per-100g, milliliters
  //    with per-100ml). A "330 ml" serving against per-100g values would need a
  //    density conversion we do not have; inventing one (ml ≈ g) is exactly the
  //    kind of made-up number this feature bans, so those fall through to the
  //    honest per-100 fallback instead.
  const per100 = basisFrom(nutriments, "_100g");
  if (!per100) return null;
  const basisUnit = per100BasisUnit(product);
  if (servingLabel && servingQty !== null && servingQty > 0 && servingQty <= 1500) {
    const unit = verifiedServingUnit(product, servingLabel, servingQty);
    if (unit === basisUnit) {
      const scale = servingQty / 100;
      return finishFacts(name, brand, servingLabel, {
        calories: per100.calories * scale,
        protein: per100.protein * scale,
        carbs: per100.carbs * scale,
        fat: per100.fat * scale,
      });
    }
  }

  // 3) Honest per-100 fallback, labeled in the basis's own unit.
  return finishFacts(name, brand, basisUnit === "ml" ? "100 ml" : "100 g", per100);
}

const OFF_NUTRIENTS = [
  ["energy-kcal", "Energy", "kcal"],
  ["fat", "Total lipid (fat)", "g"],
  ["saturated-fat", "Fatty acids, total saturated", "g"],
  ["trans-fat", "Fatty acids, total trans", "g"],
  ["cholesterol", "Cholesterol", "mg"],
  ["sodium", "Sodium, Na", "mg"],
  ["carbohydrates", "Carbohydrate, by difference", "g"],
  ["fiber", "Fiber, total dietary", "g"],
  ["sugars", "Sugars, total including NLEA", "g"],
  ["added-sugars", "Sugars, added", "g"],
  ["proteins", "Protein", "g"],
  ["calcium", "Calcium, Ca", "mg"],
  ["iron", "Iron, Fe", "mg"],
  ["potassium", "Potassium, K", "mg"],
  ["vitamin-d", "Vitamin D", "mcg"],
] as const;

/**
 * Builds a versioned snapshot from the same exact OFF basis selected for the
 * compatible macro DTO. Only numeric fields actually published are included.
 */
export function nutritionSnapshotFromOffProduct(
  code: string,
  value: unknown,
  facts: BarcodeProductFacts,
): FoodNutritionSnapshot | undefined {
  const product = readRecord(value);
  const nutriments = product ? readRecord(product.nutriments) : null;
  if (!product || !nutriments) return undefined;
  const servingBasis = basisFrom(nutriments, "_serving");
  const per100Basis = basisFrom(nutriments, "_100g");
  const servingLabel = readText(product.serving_size, MAX_SERVING);
  const servingQty = readNumber(product.serving_quantity);
  const basisUnit = per100BasisUnit(product);
  const suffix = servingBasis ? "_serving" : per100Basis ? "_100g" : null;
  if (!suffix) return undefined;

  let selectedScale = 1;
  let basisAmount = suffix === "_serving" ? 1 : 100;
  let unit = suffix === "_serving" ? "serving" : basisUnit;
  let grams: number | undefined = suffix === "_100g" && basisUnit === "g" ? 100 : undefined;
  if (suffix === "_serving" && servingQty && verifiedServingUnit(product, servingLabel ?? "", servingQty) === "g") {
    grams = servingQty;
  } else if (suffix === "_100g" && servingLabel && servingQty && verifiedServingUnit(product, servingLabel, servingQty) === basisUnit) {
    selectedScale = servingQty / 100;
  }

  const nutrients = OFF_NUTRIENTS.flatMap(([id, name, defaultUnit]) => {
    const amount = readNumber(nutriments[`${id}${suffix}`]);
    if (amount === null) return [];
    const publishedUnit = readText(nutriments[`${id}_unit`], 16)?.toLowerCase();
    let nutrientUnit = publishedUnit ?? defaultUnit;
    let normalizedAmount = amount;
    // OFF commonly standardizes sodium/minerals to grams. Preserve meaning in
    // the wire contract's familiar units without rounding.
    if (defaultUnit === "mg" && nutrientUnit === "g") {
      normalizedAmount *= 1000;
      nutrientUnit = "mg";
    }
    if (defaultUnit === "mcg" && nutrientUnit === "g") {
      normalizedAmount *= 1_000_000;
      nutrientUnit = "mcg";
    }
    return [{ id: `off:${id}`, name, unit: nutrientUnit, amount: normalizedAmount }];
  });
  const revision = `sha256:${createHash("sha256").update(JSON.stringify(product)).digest("hex")}`;
  const selectedAmount = suffix === "_100g" && selectedScale !== 1 && servingQty
    ? servingQty
    : basisAmount;
  return {
    version: 1,
    source: {
      provider: "Open Food Facts",
      recordId: code,
      revision,
      canonicalName: facts.name,
    },
    basis: {
      amount: basisAmount,
      unit,
      label: suffix === "_serving" ? (servingLabel ?? "1 serving") : `100 ${basisUnit}`,
      ...(grams !== undefined ? { grams } : {}),
    },
    nutrients,
    portions: [{
      id: suffix === "_serving" ? "serving" : basisUnit,
      label: suffix === "_serving"
        ? (servingLabel ?? "1 serving")
        : (basisUnit === "g" ? "grams" : "milliliters"),
      unit,
      dimension: suffix === "_serving" ? "serving" : (basisUnit === "g" ? "weight" : "volume"),
      basisMultiplier: suffix === "_serving" ? 1 : 0.01,
      ...(suffix === "_serving"
        ? (grams !== undefined ? { grams } : {})
        : (basisUnit === "g" ? { grams: 1 } : {})),
      evidence: "Open Food Facts published nutrition basis",
    }],
    selected: {
      amount: selectedAmount,
      unitId: suffix === "_serving" ? "serving" : basisUnit,
      scale: selectedScale,
    },
    provenance: "identified_product",
  };
}

type Per100Unit = "g" | "ml";

/**
 * The unit OFF's `_100g`-suffixed nutriment fields actually describe. For
 * beverages the panel (and OFF's storage) is per 100 ml even though the
 * field suffix says 100g; `nutrition_data_per` is the flag that says so.
 */
function per100BasisUnit(product: Record<string, unknown>): Per100Unit {
  const per =
    typeof product.nutrition_data_per === "string"
      ? product.nutrition_data_per.replace(/\s+/g, "").toLowerCase()
      : "";
  return per === "100ml" ? "ml" : "g";
}

/**
 * The labeled serving's unit, only when it can be VERIFIED: OFF's explicit
 * `serving_quantity_unit` when present, else a g/ml amount read straight off
 * the printed serving label that matches `serving_quantity`. Count-style
 * servings ("2 cookies"), foreign units (oz, cl), and label/quantity
 * disagreements all return null — unverifiable means no scaling.
 */
function verifiedServingUnit(
  product: Record<string, unknown>,
  servingLabel: string,
  servingQty: number,
): Per100Unit | null {
  const explicit =
    typeof product.serving_quantity_unit === "string"
      ? product.serving_quantity_unit.trim().toLowerCase()
      : "";
  if (explicit === "g") return "g";
  if (explicit === "ml") return "ml";
  if (explicit) return null;
  // e.g. "30 g", "330ml", "2 cookies (28g)" — take the first g/ml amount.
  const match = /(\d+(?:[.,]\d+)?)\s*(g|ml)\b/i.exec(servingLabel);
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // The amount on the label must BE the parsed quantity — otherwise the
  // label says nothing about what serving_quantity counts.
  if (Math.abs(amount - servingQty) > Math.max(0.5, amount * 0.01)) return null;
  return match[2].toLowerCase() as Per100Unit;
}
