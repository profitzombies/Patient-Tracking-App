/**
 * Client-side contract for the coach chat's nutrition-label flow.
 *
 * A label photo turn streams back a `labelDraft` SSE event: the server's
 * validated transcription of the printed panel (never estimates). The chat
 * context holds that draft through the name conversation — the product name
 * is the one thing a label never prints — and once the patient confirms a
 * name, the CLIENT builds the "food" chat card from draft + name. The name
 * never round-trips through the model, so fixing a typo is a pure
 * client-side rename.
 *
 * Tapping Add on the card runs through the SAME custom-food path as the
 * create-food screen (`addCustomFood`, category "My Foods"), then logs a
 * diary entry to the chosen slot exactly like Add Food would — so undo,
 * editing, and the library all treat the result as an ordinary custom food.
 * The card's serving stepper multiplies the LOGGED ENTRY only (quantity ×
 * per-serving macros); the reusable custom food always stays per-serving.
 */
import { formatQty } from '@/data/diary-entries';
import { MEAL_SLOTS, type FoodItem, type MealLogEntry, type MealSlot } from '@/data/patient-data';
import type { FoodNutritionSnapshot } from '@/data/food-nutrition';

/** Server-transcribed Nutrition Facts read (one label photo). */
export interface LabelDraft {
  /** Server-issued draft id (`label_...`), reused as the card payload id. */
  id: string;
  /** Serving size as printed, e.g. "2/3 cup (55g)". */
  servingSize: string;
  /** Servings per container; null when the panel does not print one. */
  servingsPerContainer: number | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
  /** Diary slot the server suggests (explicit pin beats clock beats snacks). */
  suggestedSlot: MealSlot;
  /** Printed calories disagree with the 4/4/9 macro math — double-check. */
  flagged?: boolean;
}

/** Payload of the client-built "food" chat card: the draft plus the name. */
export interface LabelFoodCardPayload extends LabelDraft {
  /** Product name the patient supplied, already Title Case. */
  name: string;
  /** Set once Add saved the food and logged it (freezes the card). */
  added?: boolean;
  /** Slot the entry was logged to (for the card's confirmation line). */
  addedSlot?: MealSlot;
  /**
   * Servings Add logged (for the card's confirmation line). Multiplied the
   * diary entry only — the saved custom food stays per-serving.
   */
  addedQuantity?: number;
}

function isMealSlot(value: unknown): value is MealSlot {
  return typeof value === 'string' && (MEAL_SLOTS as string[]).includes(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Defensive parse of a `labelDraft` SSE event (extra keys, like a card
 * payload's name, pass through untouched). Returns null on anything
 * malformed so a bad payload drops the flow instead of crashing the chat —
 * and so older clients, which never registered these pieces, stay inert.
 */
export function parseLabelDraft(value: unknown): LabelDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.servingSize !== 'string' || r.servingSize.trim().length === 0) return null;
  if (!finiteNonNegative(r.calories) || !finiteNonNegative(r.protein)) return null;
  if (!finiteNonNegative(r.carbs) || !finiteNonNegative(r.fat)) return null;
  const draft: LabelDraft = {
    id: r.id,
    servingSize: r.servingSize.trim().slice(0, 80),
    servingsPerContainer: finiteNonNegative(r.servingsPerContainer) ? r.servingsPerContainer : null,
    calories: r.calories,
    protein: r.protein,
    carbs: r.carbs,
    fat: r.fat,
    suggestedSlot: isMealSlot(r.suggestedSlot) ? r.suggestedSlot : 'snacks',
  };
  if (finiteNonNegative(r.fiber)) draft.fiber = r.fiber;
  if (finiteNonNegative(r.sugar)) draft.sugar = r.sugar;
  if (finiteNonNegative(r.sodium)) draft.sodium = r.sodium;
  if (r.flagged === true) draft.flagged = true;
  return draft;
}

/** Parse of a full "food" card payload: a draft that also carries the name. */
export function parseLabelFoodCardPayload(value: unknown): LabelFoodCardPayload | null {
  const draft = parseLabelDraft(value);
  if (!draft) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.trim().length === 0) return null;
  const payload: LabelFoodCardPayload = { ...draft, name: r.name.trim() };
  if (r.added === true) payload.added = true;
  if (isMealSlot(r.addedSlot)) payload.addedSlot = r.addedSlot;
  // Quantity must be a finite positive number; junk drops the field so the
  // confirmation falls back to its single-serving wording.
  if (typeof r.addedQuantity === 'number' && Number.isFinite(r.addedQuantity) && r.addedQuantity > 0) {
    payload.addedQuantity = r.addedQuantity;
  }
  return payload;
}

/**
 * The custom food Add saves — the same shape the create-food screen builds,
 * so the result is an ordinary "My Foods" entry (editable, undoable).
 * Values round to whole numbers to match every other food in the library.
 * Always per-serving: the card's serving stepper never touches this shape.
 */
export function buildCustomFoodFromLabel(
  payload: LabelFoodCardPayload,
): Omit<FoodItem, 'id' | 'category'> {
  const nutrients: FoodNutritionSnapshot['nutrients'] = [
    { id: 'energy', name: 'Calories', unit: 'kcal', amount: payload.calories },
    { id: 'protein', name: 'Protein', unit: 'g', amount: payload.protein },
    { id: 'carbohydrate', name: 'Total Carbohydrate', unit: 'g', amount: payload.carbs },
    { id: 'fat', name: 'Total Fat', unit: 'g', amount: payload.fat },
  ];
  if (payload.fiber !== undefined) nutrients.push({ id: 'fiber', name: 'Dietary Fiber', unit: 'g', amount: payload.fiber });
  if (payload.sugar !== undefined) nutrients.push({ id: 'sugars', name: 'Total Sugars', unit: 'g', amount: payload.sugar });
  if (payload.sodium !== undefined) nutrients.push({ id: 'sodium', name: 'Sodium', unit: 'mg', amount: payload.sodium });
  const nutritionSnapshot: FoodNutritionSnapshot = {
    version: 1,
    source: {
      provider: 'nutrition_label',
      recordId: payload.id,
      revision: payload.id,
      canonicalName: payload.name,
    },
    basis: { amount: 1, unit: 'serving', label: payload.servingSize },
    nutrients,
    portions: [{
      id: 'serving',
      label: payload.servingSize,
      unit: 'serving',
      dimension: 'serving',
      basisMultiplier: 1,
      evidence: 'Printed Nutrition Facts serving',
    }],
    selected: { amount: 1, unitId: 'serving', scale: 1 },
    provenance: 'personal_label',
  };
  return {
    name: payload.name,
    serving: payload.servingSize,
    calories: Math.round(payload.calories),
    protein: Math.round(payload.protein),
    carbs: Math.round(payload.carbs),
    fat: Math.round(payload.fat),
    nutritionSnapshot,
  };
}

/**
 * The diary entry Add logs alongside the save — `quantity` servings of the
 * freshly created food, mirroring log-food's entry shape exactly (same
 * detail format, same macros-×-quantity-then-round math). The multiplication
 * lives HERE, on the entry, so the reusable food stays per-serving.
 */
export function buildLabelDiaryEntry(
  food: FoodItem,
  slot: MealSlot,
  dateKey: string,
  quantity: number = 1,
): Omit<MealLogEntry, 'id'> {
  return {
    dateKey,
    meal: slot,
    kind: 'food',
    refId: food.id,
    name: food.name,
    detail: `${formatQty(quantity)} × ${food.serving}`,
    quantity,
    calories: Math.round(food.calories * quantity),
    protein: Math.round(food.protein * quantity),
    carbs: Math.round(food.carbs * quantity),
    fat: Math.round(food.fat * quantity),
    ...(food.nutritionSnapshot
      ? {
          nutritionSnapshot: {
            ...food.nutritionSnapshot,
            selected: {
              ...food.nutritionSnapshot.selected,
              amount: food.nutritionSnapshot.selected.amount * quantity,
              scale: food.nutritionSnapshot.selected.scale * quantity,
            },
          },
        }
      : {}),
  };
}
