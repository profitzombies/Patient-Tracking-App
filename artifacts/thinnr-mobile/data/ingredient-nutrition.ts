/**
 * Pure math behind the ingredient breakdown: unit families, linear rescaling
 * of per-ingredient nutrition, and recipe-level adjusted totals.
 *
 * Scaling contract (pinned by scripts/verify-recipe-nutrition.ts):
 *  - Every scale factor derives from the ingredient's ORIGINAL amount/unit
 *    baseline, so re-editing a row never compounds rounding from earlier
 *    edits — setting 2.5 oz directly and reaching it through five taps
 *    produce identical numbers.
 *  - Conversions are linear within a unit family (oz↔lb, tsp↔tbsp↔cup);
 *    there are no volume↔weight density conversions. Units outside a family
 *    (pieces, cloves, cans, …) are amount-only.
 *  - Unrounded values flow through the math; rounding happens once at the
 *    display/log boundary (roundNutrition / totalsForQuantity).
 */
import type {
  IngredientAdjustment,
  IngredientNutrition,
  RecipeIngredient,
} from './patient-data';

// ── Unit families ──────────────────────────────────────────────────────────
// Factors are "how many base units is 1 of this unit" (base: oz / tsp).
const WEIGHT_FACTORS: Record<string, number> = { oz: 1, lb: 16 };
const VOLUME_FACTORS: Record<string, number> = { tsp: 1, tbsp: 3, cup: 48 };

/** 'cups' is a display spelling of 'cup'; factors are shared. */
function canonicalUnit(unit: string): string {
  const lc = unit.trim().toLowerCase();
  return lc === 'cups' ? 'cup' : lc;
}

function familyOf(unit: string): Record<string, number> | null {
  const cu = canonicalUnit(unit);
  if (cu in WEIGHT_FACTORS) return WEIGHT_FACTORS;
  if (cu in VOLUME_FACTORS) return VOLUME_FACTORS;
  return null;
}

/**
 * Units the picker offers for an ingredient, keyed off its original unit.
 * The slot matching the original keeps the original spelling ('cups' stays
 * 'cups'); everything else uses canonical labels. Single-entry result means
 * the unit is fixed and the picker is hidden.
 */
export function unitOptions(originalUnit: string): string[] {
  const family = familyOf(originalUnit);
  if (!family) return [originalUnit];
  const original = canonicalUnit(originalUnit);
  return Object.keys(family).map(u => (u === original ? originalUnit : u));
}

/**
 * Multiplier turning an amount in `fromUnit` into `toUnit`.
 * Returns 1 for identical (canonical) units, null when the units are not in
 * the same family — callers must treat null as "conversion impossible".
 */
export function conversionFactor(fromUnit: string, toUnit: string): number | null {
  const from = canonicalUnit(fromUnit);
  const to = canonicalUnit(toUnit);
  if (from === to) return 1;
  const family = familyOf(from);
  if (!family || !(to in family)) return null;
  return family[from] / family[to];
}

/**
 * How much of the original portion the current amount represents
 * (1 = unchanged). Null when the units are incompatible or the original
 * amount is 0 ("to taste" rows have no meaningful baseline).
 */
export function scaleFactorFromOriginal(
  original: { amount: number; unit: string },
  current: { amount: number; unit: string },
): number | null {
  if (!(original.amount > 0) || !Number.isFinite(current.amount) || current.amount < 0) {
    return null;
  }
  const toOriginalUnits = conversionFactor(current.unit, original.unit);
  if (toOriginalUnits === null) return null;
  return (current.amount * toOriginalUnits) / original.amount;
}

export function scaleNutrition(nutrition: IngredientNutrition, factor: number): IngredientNutrition {
  return {
    calories: nutrition.calories * factor,
    protein: nutrition.protein * factor,
    carbs: nutrition.carbs * factor,
    fat: nutrition.fat * factor,
  };
}

/** Rounds for display: whole numbers, matching the app's other nutrition UI. */
export function roundNutrition(nutrition: IngredientNutrition): IngredientNutrition {
  return {
    calories: Math.round(nutrition.calories),
    protein: Math.round(nutrition.protein),
    carbs: Math.round(nutrition.carbs),
    fat: Math.round(nutrition.fat),
  };
}

// ── Stepper geometry ───────────────────────────────────────────────────────

export function stepForUnit(unit: string): number {
  const cu = canonicalUnit(unit);
  if (cu === 'tsp' || cu === 'cup' || cu === 'lb') return 0.25;
  return 0.5; // oz, tbsp, counts, cloves, spears, cans, scoops, …
}

/**
 * Editable range for a row, expressed in the CURRENT unit: from 0 (skip this
 * ingredient entirely) up to 8× the original portion.
 */
export function amountBounds(
  original: { amount: number; unit: string },
  currentUnit: string,
): { min: number; max: number; step: number } {
  const step = stepForUnit(currentUnit);
  const toCurrent = conversionFactor(original.unit, currentUnit) ?? 1;
  const originalInCurrent = original.amount * toCurrent;
  const max = Math.max(step, Math.ceil((originalInCurrent * 8) / step) * step);
  return { min: 0, max, step };
}

export function clampAmount(
  amount: number,
  original: { amount: number; unit: string },
  currentUnit: string,
): number {
  const { min, max } = amountBounds(original, currentUnit);
  if (!Number.isFinite(amount)) return min;
  return Math.min(max, Math.max(min, amount));
}

// ── Amount formatting ──────────────────────────────────────────────────────

/**
 * "6", "½", "1.5", "0.375" — reproduces the screens' historic formatting for
 * the values that existed before (integers, ½ ¼ ¾, one-decimal halves) and
 * trims longer conversion results to at most 3 decimals without padding.
 */
export function formatIngredientAmount(amount: number): string {
  if (amount % 1 === 0) return String(amount);
  if (amount === 0.5) return '½';
  if (amount === 0.25) return '¼';
  if (amount === 0.75) return '¾';
  return String(parseFloat(amount.toFixed(3)));
}

// ── Adjustment application ─────────────────────────────────────────────────

export interface IngredientView {
  index: number;
  name: string;
  originalAmount: number;
  originalUnit: string;
  /** Current (possibly adjusted) amount, in `unit`. */
  amount: number;
  unit: string;
  /** True when a (sanitized) adjustment applies to this row. */
  adjusted: boolean;
  /** Contribution to one serving at the ORIGINAL amount. */
  originalNutrition?: IngredientNutrition;
  /** Contribution to one serving at the CURRENT amount — unrounded. */
  nutrition?: IngredientNutrition;
  /** Rows without nutrition data or with amount 0 cannot expand into the editor. */
  editable: boolean;
}

function adjustmentFor(
  adjustments: IngredientAdjustment[],
  index: number,
): IngredientAdjustment | undefined {
  // Last write wins, mirroring sanitizeAdjustments' dedupe rule.
  for (let i = adjustments.length - 1; i >= 0; i -= 1) {
    if (adjustments[i].index === index) return adjustments[i];
  }
  return undefined;
}

/**
 * Resolves each ingredient row against the adjustment list. Invalid
 * adjustments (bad index, incompatible unit, non-positive amount) are
 * ignored, leaving the row at its original values — old or damaged data
 * degrades to "unchanged" instead of breaking the screen.
 */
export function applyAdjustments(
  ingredients: RecipeIngredient[],
  adjustments: IngredientAdjustment[],
): IngredientView[] {
  return ingredients.map((ingredient, index) => {
    const base: IngredientView = {
      index,
      name: ingredient.name,
      originalAmount: ingredient.amount,
      originalUnit: ingredient.unit,
      amount: ingredient.amount,
      unit: ingredient.unit,
      adjusted: false,
      originalNutrition: ingredient.nutrition,
      nutrition: ingredient.nutrition,
      editable: ingredient.amount > 0 && !!ingredient.nutrition,
    };
    if (!base.editable) return base;
    const adjustment = adjustmentFor(adjustments, index);
    if (!adjustment) return base;
    const factor = scaleFactorFromOriginal(
      { amount: ingredient.amount, unit: ingredient.unit },
      { amount: adjustment.amount, unit: adjustment.unit },
    );
    if (factor === null || adjustment.amount < 0) return base;
    return {
      ...base,
      amount: adjustment.amount,
      unit: adjustment.unit,
      adjusted: true,
      nutrition: ingredient.nutrition ? scaleNutrition(ingredient.nutrition, factor) : undefined,
    };
  });
}

/**
 * Recipe per-serving totals with adjustments folded in, via deltas against
 * the stated totals: base + Σ(current − original contribution), clamped at 0.
 * With no adjustments this returns exactly the stated values — the unadjusted
 * view never shows rounding jitter from re-summing ingredients.
 */
export function adjustedPerServing(
  base: IngredientNutrition,
  ingredients: RecipeIngredient[],
  adjustments: IngredientAdjustment[],
): IngredientNutrition {
  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  for (const view of applyAdjustments(ingredients, adjustments)) {
    if (!view.adjusted || !view.nutrition || !view.originalNutrition) continue;
    calories += view.nutrition.calories - view.originalNutrition.calories;
    protein += view.nutrition.protein - view.originalNutrition.protein;
    carbs += view.nutrition.carbs - view.originalNutrition.carbs;
    fat += view.nutrition.fat - view.originalNutrition.fat;
  }
  return {
    calories: Math.max(0, base.calories + calories),
    protein: Math.max(0, base.protein + protein),
    carbs: Math.max(0, base.carbs + carbs),
    fat: Math.max(0, base.fat + fat),
  };
}

/** Entry-ready totals for a serving count: rounded once, at the boundary. */
export function totalsForQuantity(
  perServing: IngredientNutrition,
  quantity: number,
): IngredientNutrition {
  return {
    calories: Math.round(perServing.calories * quantity),
    protein: Math.round(perServing.protein * quantity),
    carbs: Math.round(perServing.carbs * quantity),
    fat: Math.round(perServing.fat * quantity),
  };
}

/**
 * Canonical form of an adjustment list against its recipe: drops entries
 * that are out of range, target non-editable rows, carry non-positive or
 * non-finite amounts, use units incompatible with the original, or equal the
 * original amount+unit (no-ops). Deduped by index (last wins), sorted, and
 * amounts clamped into stepper bounds.
 */
export function sanitizeAdjustments(
  ingredients: RecipeIngredient[],
  adjustments: IngredientAdjustment[] | undefined,
): IngredientAdjustment[] {
  if (!adjustments || adjustments.length === 0) return [];
  const byIndex = new Map<number, IngredientAdjustment>();
  for (const raw of adjustments) {
    if (!raw || !Number.isInteger(raw.index)) continue;
    const ingredient = ingredients[raw.index];
    if (!ingredient || !(ingredient.amount > 0) || !ingredient.nutrition) continue;
    if (!Number.isFinite(raw.amount) || raw.amount < 0) continue;
    if (typeof raw.unit !== 'string') continue;
    const original = { amount: ingredient.amount, unit: ingredient.unit };
    if (conversionFactor(raw.unit, ingredient.unit) === null) continue;
    const amount = clampAmount(raw.amount, original, raw.unit);
    if (
      amount === ingredient.amount &&
      canonicalUnit(raw.unit) === canonicalUnit(ingredient.unit)
    ) {
      byIndex.delete(raw.index); // explicit return-to-original clears earlier writes
      continue;
    }
    byIndex.set(raw.index, { index: raw.index, amount, unit: raw.unit });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** Order-insensitive equality of two SANITIZED adjustment lists. */
export function sameAdjustments(
  a: IngredientAdjustment[],
  b: IngredientAdjustment[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i];
    return (
      other.index === entry.index &&
      other.amount === entry.amount &&
      canonicalUnit(other.unit) === canonicalUnit(entry.unit)
    );
  });
}
