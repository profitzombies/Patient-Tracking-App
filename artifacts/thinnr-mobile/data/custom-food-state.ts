/**
 * Pure state transitions behind My Foods deletion and its Undo.
 *
 * Kept free of React so the remove/restore invariants (exact same-id
 * restores, favorite/recent re-attachment, no duplicates on repeated calls)
 * can be exercised directly by scripts/verify-custom-food-undo.ts as a
 * regression check — the same pattern as data/diary-entry-state.ts.
 *
 * Model: custom foods live only in `customFoods` (seeded foods can't be
 * deleted), so a deletion simply filters the food out — but it also strips
 * the food's favorite/recent references so they don't dangle. The Undo
 * snapshot must therefore be captured *before* the removal and carry those
 * references — plus each one's position, so a restore puts everything back
 * exactly where it was.
 */
import type { FoodItem } from './patient-data';

export interface CustomFoodState {
  customFoods: FoodItem[];
  favorites: string[];
  recents: string[];
}

/** Everything needed to undo a My Foods deletion, captured pre-removal. */
export interface RemovedCustomFood {
  /** Exact food snapshot, restored under its original id. */
  food: FoodItem;
  /** Position in `customFoods`, so the Library list order round-trips. */
  foodIndex: number;
  /** Position in `favorites`, or -1 when the food wasn't favorited. */
  favoriteIndex: number;
  /** Position in `recents`, or -1 when the food wasn't a recent. */
  recentsIndex: number;
}

/**
 * Snapshots a custom food and its favorite/recent references ahead of a
 * removal. Returns null when the id isn't a custom food (e.g. the second tap
 * of a double-tapped delete) — there is nothing to undo then.
 */
export function captureRemovedCustomFood(state: CustomFoodState, id: string): RemovedCustomFood | null {
  const foodIndex = state.customFoods.findIndex(f => f.id === id);
  if (foodIndex === -1) return null;
  return {
    food: state.customFoods[foodIndex]!,
    foodIndex,
    favoriteIndex: state.favorites.indexOf(id),
    recentsIndex: state.recents.indexOf(id),
  };
}

/**
 * Deletes a custom food and strips its favorite/recent references. Returns
 * the input state unchanged (same reference) when nothing references the id
 * (e.g. the second tap of a double-tapped delete), so callers can skip a
 * redundant persist.
 */
export function applyRemoveCustomFood(state: CustomFoodState, id: string): CustomFoodState {
  const { customFoods, favorites, recents } = state;
  const nextFoods = customFoods.some(f => f.id === id) ? customFoods.filter(f => f.id !== id) : customFoods;
  const nextFavorites = favorites.includes(id) ? favorites.filter(f => f !== id) : favorites;
  const nextRecents = recents.includes(id) ? recents.filter(r => r !== id) : recents;
  if (nextFoods === customFoods && nextFavorites === favorites && nextRecents === recents) return state;
  return { customFoods: nextFoods, favorites: nextFavorites, recents: nextRecents };
}

/** Inserts `value` at `index`, clamped to the list bounds. */
function insertAt<T>(list: T[], index: number, value: T): T[] {
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), value, ...list.slice(at)];
}

/**
 * Undoes a My Foods deletion: re-inserts the exact food snapshot at its old
 * position and re-attaches the favorite/recent references the removal
 * stripped. Returns the input state unchanged (same reference) when a food
 * with the same id is already present — a double-tapped Undo must never
 * insert a duplicate. References are re-added only if they were captured
 * (index >= 0) and aren't already present.
 */
export function applyRestoreCustomFood(state: CustomFoodState, removed: RemovedCustomFood): CustomFoodState {
  const { customFoods, favorites, recents } = state;
  const id = removed.food.id;
  if (customFoods.some(f => f.id === id)) return state;
  return {
    customFoods: insertAt(customFoods, removed.foodIndex, removed.food),
    favorites:
      removed.favoriteIndex >= 0 && !favorites.includes(id)
        ? insertAt(favorites, removed.favoriteIndex, id)
        : favorites,
    recents:
      removed.recentsIndex >= 0 && !recents.includes(id)
        ? insertAt(recents, removed.recentsIndex, id)
        : recents,
  };
}
