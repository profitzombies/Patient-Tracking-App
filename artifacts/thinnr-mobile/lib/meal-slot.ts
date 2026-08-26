/**
 * Meal-slot defaults from the device clock.
 *
 * The coach's recipe and meal-photo cards preselect a diary slot. The server
 * resolves it (explicit pin > a meal the patient names > the patient's local
 * time) using the SAME time bands as `mealSlotForDate` below; the app sends
 * `localTimeForDate(...)` as that clock reading on every coach call (see
 * CoachChatContext), and the preview screen falls back to the device clock
 * only when a card somehow carries no slot.
 *
 * Bands (device-local, half-open):
 *   04:00–10:59 breakfast · 11:00–14:59 lunch · 15:00–16:59 snacks
 *   17:00–21:59 dinner    · 22:00–03:59 snacks
 * Mirrors artifacts/api-server/src/coach/meal-slot.ts — keep the two tables
 * in step.
 *
 * Every function takes an injected Date so suites can pin fixed times; only
 * composition points (screens, the chat provider's default clock) pass
 * `new Date()`.
 */
import type { MealSlot } from '@/data/patient-data';

/** The diary slot a meal eaten at `date`'s wall-clock time belongs to. */
export function mealSlotForDate(date: Date): MealSlot {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 15) return 'lunch';
  if (hour >= 15 && hour < 17) return 'snacks';
  if (hour >= 17 && hour < 22) return 'dinner';
  return 'snacks';
}

/** Formats a Date's wall-clock time as the API's 24-hour "HH:MM". */
export function localTimeForDate(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * The slot the AI-recipe preview preselects: the card's own slot when the
 * server resolved one (it already weighed an explicit pin, the patient's
 * words, and their local time), otherwise the device clock — replacing the
 * old hardcoded Snacks fallback. The patient can always switch by hand.
 */
export function previewMealSlot(cardMeal: MealSlot | undefined, now: Date): MealSlot {
  return cardMeal ?? mealSlotForDate(now);
}
