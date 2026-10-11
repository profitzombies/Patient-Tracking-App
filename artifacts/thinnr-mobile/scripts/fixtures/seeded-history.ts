/**
 * Deterministic sample diary history for the hermetic suites (diary undo /
 * copy / edit, stall-nudge classification). Never imported by app code: a
 * real account's history comes only from its own records.
 *
 * The sample person started 94 days before the fixed TODAY anchor at 180 lb
 * and sits in a weight plateau at 169.5 lb (the plateau began on elapsed
 * day 73, interrupting a taper that was heading for 167.2 lb).
 */
import {
  DIARY_WINDOW_DAYS,
  findFood,
  findRecipe,
  RECIPES,
  subDays,
  toDateKey,
  TODAY,
  TODAY_KEY,
  type CheckIn,
  type FoodItem,
  type MealLogEntry,
  type MealSlot,
  type Recipe,
} from '../../data/patient-data';

export const SAMPLE_PROFILE = {
  startDate: '2026-05-20T12:00:00.000Z',
  startingWeight: 180,
  currentWeight: 169.5,
  goalWeight: 150,
  stall: { plateauStartElapsed: 73, preStallTargetWeight: 167.2 },
} as const;

const ENROLLMENT_DATE = new Date(SAMPLE_PROFILE.startDate);
export const ENROLLMENT_DAYS = Math.round((TODAY.getTime() - ENROLLMENT_DATE.getTime()) / 86_400_000);

const seededFraction = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

const BREAKFASTS = RECIPES.filter(r => r.meal === 'breakfast');
const LUNCHES = RECIPES.filter(r => r.meal === 'lunch');
const DINNERS = RECIPES.filter(r => r.meal === 'dinner');
const SNACK_RECIPES = RECIPES.filter(r => r.meal === 'snacks');

export const SEED_DAYS = DIARY_WINDOW_DAYS;

function entryFromRecipe(dateKey: string, meal: MealSlot, recipe: Recipe, n: number): MealLogEntry {
  return {
    id: `seed_${dateKey}_${meal}_${n}`,
    dateKey,
    meal,
    kind: 'recipe',
    refId: recipe.id,
    name: recipe.name,
    detail: '1 serving',
    quantity: 1,
    calories: recipe.calories,
    protein: recipe.protein,
    carbs: recipe.carbs,
    fat: recipe.fat,
  };
}

function entryFromFood(dateKey: string, meal: MealSlot, food: FoodItem, quantity: number, n: number): MealLogEntry {
  return {
    id: `seed_${dateKey}_${meal}_${n}`,
    dateKey,
    meal,
    kind: 'food',
    refId: food.id,
    name: food.name,
    detail: quantity === 1 ? food.serving : `${quantity} × ${food.serving}`,
    quantity,
    calories: Math.round(food.calories * quantity),
    protein: Math.round(food.protein * quantity),
    carbs: Math.round(food.carbs * quantity),
    fat: Math.round(food.fat * quantity),
  };
}

const pickFrom = <T,>(arr: T[], seed: number): T => arr[Math.floor(seededFraction(seed) * arr.length) % arr.length];

/** Diary entries for the past SEED_DAYS days plus a partial log for today. */
export function buildSeedEntries(): MealLogEntry[] {
  const entries: MealLogEntry[] = [];

  for (let offset = SEED_DAYS; offset >= 1; offset--) {
    const dateKey = toDateKey(subDays(TODAY, offset));

    entries.push(entryFromRecipe(dateKey, 'breakfast', pickFrom(BREAKFASTS, offset * 7 + 1), 0));
    if (seededFraction(offset * 11 + 4) < 0.72) {
      entries.push(entryFromFood(dateKey, 'breakfast', findFood('fd_coffee')!, 1, 1));
    }

    entries.push(entryFromRecipe(dateKey, 'lunch', pickFrom(LUNCHES, offset * 7 + 2), 0));
    if (seededFraction(offset * 11 + 5) < 0.38) {
      const extra = seededFraction(offset * 13 + 6) < 0.5 ? 'fd_apple' : 'fd_sparkling';
      entries.push(entryFromFood(dateKey, 'lunch', findFood(extra)!, 1, 1));
    }

    entries.push(entryFromRecipe(dateKey, 'dinner', pickFrom(DINNERS, offset * 7 + 3), 0));

    if (seededFraction(offset * 11 + 6) < 0.55) {
      entries.push(entryFromRecipe(dateKey, 'snacks', pickFrom(SNACK_RECIPES, offset * 7 + 4), 0));
    }
  }

  // Today: breakfast, lunch, and a snack are logged; dinner is still open so
  // "calories remaining" reads meaningfully.
  entries.push(entryFromRecipe(TODAY_KEY, 'breakfast', findRecipe('rec_yogurt_bowl')!, 0));
  entries.push(entryFromFood(TODAY_KEY, 'breakfast', findFood('fd_coffee')!, 1, 1));
  entries.push(entryFromRecipe(TODAY_KEY, 'lunch', findRecipe('rec_cobb_salad')!, 0));
  entries.push(entryFromRecipe(TODAY_KEY, 'snacks', findRecipe('rec_apple_almond')!, 0));

  return entries;
}

/** Water totals (fl oz) keyed by date, including a partial total for today. */
export function buildSeedWater(): Record<string, number> {
  const water: Record<string, number> = {};
  for (let offset = SEED_DAYS; offset >= 1; offset--) {
    const dateKey = toDateKey(subDays(TODAY, offset));
    water[dateKey] = 40 + Math.floor(seededFraction(offset * 13 + 5) * 5) * 8; // 40–72 oz
  }
  water[TODAY_KEY] = 32;
  return water;
}

/** The sample person's weight on a given program day (taper, then plateau). */
function weightOnProgramDay(elapsed: number): number {
  const start = SAMPLE_PROFILE.startingWeight;
  const stall = SAMPLE_PROFILE.stall;
  const variation = elapsed === 0 || elapsed >= ENROLLMENT_DAYS
    ? 0
    : (seededFraction(elapsed * 41 + 7) - 0.5) * 1.1;
  // Inside the plateau the reading bounces tightly around the frozen
  // current weight instead of tapering.
  if (stall && elapsed >= stall.plateauStartElapsed) {
    return parseFloat((SAMPLE_PROFILE.currentWeight + variation).toFixed(1));
  }
  // Pre-plateau days follow the original taper toward the weight the
  // protocol was projecting.
  const current = stall ? stall.preStallTargetWeight : SAMPLE_PROFILE.currentWeight;
  const progress = Math.min(1, Math.max(0, elapsed / ENROLLMENT_DAYS));
  const taper = Math.pow(progress, 0.78);
  const weight = start - (start - current) * taper + variation;
  return parseFloat(Math.max(current - 0.4, weight).toFixed(1));
}

const CHECKIN_NOTES = [
  'Felt steady today. Meals were easy to stick to.',
  'Busy day but kept up with water and walks.',
  'Slept well and energy is holding.',
  'Prepped meals for the next two days.',
  'Craving hit in the afternoon — tea helped.',
  'Weekend routine held up better than expected.',
];

/** Daily check-ins over the seeded window (a few days are skipped). */
export function buildSeedCheckIns(): CheckIn[] {
  const checkIns: CheckIn[] = [];
  for (let offset = SEED_DAYS; offset >= 1; offset--) {
    if (seededFraction(offset * 3 + 2) < 0.16) continue; // occasional missed day
    const dateKey = toDateKey(subDays(TODAY, offset));
    const elapsed = ENROLLMENT_DAYS - offset;
    const moodRoll = seededFraction(offset * 5 + 9);
    const mood: 1 | 2 | 3 | 4 | 5 = moodRoll < 0.1 ? 3 : moodRoll > 0.72 ? 5 : 4;
    const sideEffects = seededFraction(offset * 9 + 3) < 0.08 ? ['Headache'] : [];
    const checkIn: CheckIn = {
      id: `seed_ci_${dateKey}`,
      dateKey,
      mood,
      sideEffects,
    };
    if (offset % 2 === 0) checkIn.weight = weightOnProgramDay(elapsed);
    if (seededFraction(offset * 17 + 11) < 0.3) {
      checkIn.notes = CHECKIN_NOTES[Math.floor(seededFraction(offset * 19 + 13) * CHECKIN_NOTES.length) % CHECKIN_NOTES.length];
    }
    checkIns.push(checkIn);
  }
  return checkIns;
}
