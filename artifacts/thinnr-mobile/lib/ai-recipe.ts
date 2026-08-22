/**
 * Types + runtime guard for AI recipe suggestions arriving over the coach
 * chat's card slot (`data: {"card": {"kind": "recipe", "payload": ...}}`).
 *
 * The server already validates shape and (in cravings mode) the Approved
 * Foods ingredient ids; this guard is the client's defensive re-check so a
 * malformed payload degrades to "no card" instead of a crashed screen.
 * Suggestions live only in the chat session — saving one copies it into
 * patient state (see PatientContext.addSavedRecipe / addCustomFood).
 */
import type { MealSlot } from '@/data/patient-data';

export interface AiRecipeIngredient {
  amount: number;
  unit: string;
  name: string;
  approvedItemId?: string;
}

export interface AiRecipeSuggestion {
  id: string;
  mode: 'recipe' | 'cravings';
  name: string;
  description: string;
  meal: MealSlot;
  minutes: number;
  servings: number;
  /** Estimated per-serving numbers — always label them as estimates. */
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  ingredients: AiRecipeIngredient[];
  steps: string[];
  /** Cravings mode only: shopping list for the approved ingredients. */
  groceryList?: string[];
  /** Cached after on-demand generation so re-opens don't re-generate. */
  photoUri?: string;
}

const MEALS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snacks'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseIngredient(value: unknown): AiRecipeIngredient | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isFiniteNumber(v.amount) || typeof v.unit !== 'string' || !isNonEmptyString(v.name)) {
    return null;
  }
  const ingredient: AiRecipeIngredient = {
    amount: v.amount,
    unit: v.unit,
    name: v.name,
  };
  if (isNonEmptyString(v.approvedItemId)) ingredient.approvedItemId = v.approvedItemId;
  return ingredient;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(isNonEmptyString);
  return items.length === value.length ? items : null;
}

/** Returns a typed suggestion, or null when the payload is malformed. */
export function parseRecipeCardPayload(payload: unknown): AiRecipeSuggestion | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  if (!isNonEmptyString(p.id) || !isNonEmptyString(p.name) || !isNonEmptyString(p.description)) {
    return null;
  }
  if (p.mode !== 'recipe' && p.mode !== 'cravings') return null;
  if (!MEALS.includes(p.meal as MealSlot)) return null;
  if (
    !isFiniteNumber(p.minutes) ||
    !isFiniteNumber(p.servings) ||
    !isFiniteNumber(p.calories) ||
    !isFiniteNumber(p.protein) ||
    !isFiniteNumber(p.carbs) ||
    !isFiniteNumber(p.fat)
  ) {
    return null;
  }

  if (!Array.isArray(p.ingredients) || p.ingredients.length === 0) return null;
  const ingredients: AiRecipeIngredient[] = [];
  for (const raw of p.ingredients) {
    const ingredient = parseIngredient(raw);
    if (!ingredient) return null;
    ingredients.push(ingredient);
  }

  const steps = parseStringArray(p.steps);
  if (!steps || steps.length === 0) return null;

  let groceryList: string[] | undefined;
  if (p.groceryList !== undefined) {
    const parsed = parseStringArray(p.groceryList);
    if (!parsed) return null;
    groceryList = parsed;
  }

  return {
    id: p.id,
    mode: p.mode,
    name: p.name,
    description: p.description,
    meal: p.meal as MealSlot,
    minutes: p.minutes,
    servings: p.servings,
    calories: p.calories,
    protein: p.protein,
    carbs: p.carbs,
    fat: p.fat,
    ingredients,
    steps,
    ...(groceryList ? { groceryList } : {}),
  };
}
