/**
 * Meal-slot defaults for coach cards — from words, the clock, or a pin.
 *
 * Recipe and meal-photo cards preselect the diary slot their "Add to Diary"
 * preview opens with. Which slot wins is resolved in three layers:
 *
 *   1. An explicit slot pinned by the client entry point (a per-meal camera
 *      that already knows it is logging dinner) beats everything and flows
 *      into the card payload untouched.
 *   2. Otherwise, where the patient's words can carry a meal at all, a meal
 *      they NAME wins: recipe prompts instruct the model to honor it
 *      ("steak for dinner" → dinner). Meal-photo scans are image-only calls
 *      with no channel for words, so there a known clock deterministically
 *      outranks the model's visual guess.
 *   3. Otherwise the patient's local wall clock decides: the app sends
 *      device-local "HH:MM" on every chat call and this module maps it onto
 *      a slot. Old clients that send no time keep the legacy defaults.
 *
 * Time bands (device-local, half-open):
 *   04:00–10:59 breakfast · 11:00–14:59 lunch · 15:00–16:59 snacks
 *   17:00–21:59 dinner    · 22:00–03:59 snacks
 * An afternoon bite files as a snack, an evening plate as dinner until
 * 22:00, and late-night or small-hours eating as snacks.
 *
 * The mobile app mirrors these bands for its preview fallback
 * (artifacts/thinnr-mobile/lib/meal-slot.ts); keep the two tables in step.
 */

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snacks"] as const;

export type MealSlot = (typeof MEAL_SLOTS)[number];

/** Resolved slot context for one chat turn, passed to the card pipelines. */
export interface MealSlotContext {
  /** Slot pinned by the client entry point; wins over words and time. */
  explicit?: MealSlot;
  /** Slot derived from the patient's clock — the default when no meal is named. */
  timeDefault?: MealSlot;
  /** The client's "HH:MM" wall-clock reading (set only when it parsed). */
  localTime?: string;
}

/** 24-hour "HH:MM"; lenient on a missing leading zero, strict on junk. */
const LOCAL_TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Parses a client-sent "HH:MM" into minutes since local midnight. Returns
 * null for anything unparseable — a malformed value must degrade to the
 * legacy defaults, never break the chat turn.
 */
export function parseLocalTimeMinutes(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = LOCAL_TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Maps a clock reading onto the diary slot a meal eaten then belongs to. */
export function mealSlotForLocalTime(value: string | undefined): MealSlot | undefined {
  const minutes = parseLocalTimeMinutes(value);
  if (minutes === null) return undefined;
  const hour = minutes / 60;
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 15) return "lunch";
  if (hour >= 15 && hour < 17) return "snacks";
  if (hour >= 17 && hour < 22) return "dinner";
  return "snacks";
}

/**
 * Builds the per-turn slot context straight from the parsed request body.
 * `localTime` is kept only when it actually parsed, so prompts never quote
 * junk back at the model.
 */
export function buildMealSlotContext(input: {
  localTime?: string;
  mealSlot?: MealSlot;
}): MealSlotContext {
  const timeDefault = mealSlotForLocalTime(input.localTime);
  return {
    ...(input.mealSlot ? { explicit: input.mealSlot } : {}),
    ...(timeDefault ? { timeDefault, localTime: input.localTime?.trim() } : {}),
  };
}
