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
 */
import { MEAL_SLOTS, type FoodItem, type MealLogEntry, type MealSlot } from '@/data/patient-data';

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
  return payload;
}

/**
 * The custom food Add saves — the same shape the create-food screen builds,
 * so the result is an ordinary "My Foods" entry (editable, undoable).
 * Values round to whole numbers to match every other food in the library.
 */
export function buildCustomFoodFromLabel(
  payload: LabelFoodCardPayload,
): Omit<FoodItem, 'id' | 'category'> {
  return {
    name: payload.name,
    serving: payload.servingSize,
    calories: Math.round(payload.calories),
    protein: Math.round(payload.protein),
    carbs: Math.round(payload.carbs),
    fat: Math.round(payload.fat),
  };
}

/**
 * The diary entry Add logs alongside the save — one serving of the freshly
 * created food, mirroring log-food's quick-add entry shape exactly.
 */
export function buildLabelDiaryEntry(
  food: FoodItem,
  slot: MealSlot,
  dateKey: string,
): Omit<MealLogEntry, 'id'> {
  return {
    dateKey,
    meal: slot,
    kind: 'food',
    refId: food.id,
    name: food.name,
    detail: `1 × ${food.serving}`,
    quantity: 1,
    calories: food.calories,
    protein: food.protein,
    carbs: food.carbs,
    fat: food.fat,
  };
}
