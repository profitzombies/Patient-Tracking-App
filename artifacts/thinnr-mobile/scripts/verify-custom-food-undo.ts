/**
 * My Foods delete/undo invariants check.
 *
 * Exercises the pure state transitions behind the Library's delete → Undo
 * flow (data/custom-food-state.ts) so a refactor can never reintroduce the
 * failure modes that matter:
 *   1. a restore that loses the food's id, values, or favorite/recents
 *      references (the capture must happen before the removal strips them),
 *   2. a restore that duplicates the food or its references (double-tapped
 *      Undo, or an Undo racing other changes),
 *   3. a restore that puts things back in the wrong order.
 * Covers immediate undo, repeated (double-tap) deletes and undos, undo after
 * unrelated changes, and reference re-attachment positions.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:custom-food-undo
 */
import {
  applyRemoveCustomFood,
  applyRestoreCustomFood,
  captureRemovedCustomFood,
  type CustomFoodState,
} from '../data/custom-food-state';
import type { FoodItem } from '../data/patient-data';

let checks = 0;
let failures = 0;

function fail(message: string) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) fail(label);
}

const customFood = (id: string, name: string, extra: Partial<FoodItem> = {}): FoodItem => ({
  id,
  name,
  serving: '1 serving',
  calories: 210,
  protein: 18,
  carbs: 9,
  fat: 11,
  category: 'My Foods',
  ...extra,
});

// Base library: three custom foods; the middle one is favorited and recent,
// sitting between seeded-food references in both lists.
const foodA = customFood('custom_a', 'Overnight Oats');
const foodB = customFood('custom_b', 'Turkey Chili', { brand: 'Homemade', photoUri: 'data:image/png;base64,x' });
const foodC = customFood('custom_c', 'Protein Smoothie');

const base: CustomFoodState = {
  customFoods: [foodA, foodB, foodC],
  favorites: ['fd_seed_1', 'custom_b', 'fd_seed_2'],
  recents: ['fd_seed_3', 'custom_b', 'fd_seed_4'],
};

const snapshot = (state: CustomFoodState) => JSON.stringify(state);
const baseSnapshot = snapshot(base);

// ── 1. Capture happens pre-strip and carries the references ─────────────────
{
  const removed = captureRemovedCustomFood(base, 'custom_b')!;
  assert('capture finds the food', removed !== null);
  assert('capture keeps the exact food snapshot (id, values, photo)', JSON.stringify(removed.food) === JSON.stringify(foodB));
  assert('capture records the library position', removed.foodIndex === 1);
  assert('capture records the favorite reference position', removed.favoriteIndex === 1);
  assert('capture records the recents reference position', removed.recentsIndex === 1);
  assert('capture of a non-custom id returns null', captureRemovedCustomFood(base, 'fd_seed_1') === null);
}

// ── 2. Remove strips the food and its references ─────────────────────────────
{
  const afterRemove = applyRemoveCustomFood(base, 'custom_b');
  assert('removal drops the food', !afterRemove.customFoods.some(f => f.id === 'custom_b'));
  assert('removal keeps the other foods in order', afterRemove.customFoods.map(f => f.id).join(',') === 'custom_a,custom_c');
  assert('removal strips the favorite reference', !afterRemove.favorites.includes('custom_b'));
  assert('removal strips the recents reference', !afterRemove.recents.includes('custom_b'));
  assert('removal leaves unrelated references alone', afterRemove.favorites.join(',') === 'fd_seed_1,fd_seed_2' && afterRemove.recents.join(',') === 'fd_seed_3,fd_seed_4');
}

// ── 3. Remove → restore round-trips the entire state exactly ────────────────
{
  const removed = captureRemovedCustomFood(base, 'custom_b')!;
  const afterRemove = applyRemoveCustomFood(base, 'custom_b');
  const afterRestore = applyRestoreCustomFood(afterRemove, removed);
  assert('restore round-trips foods, favorites, and recents (values, ids, order)', snapshot(afterRestore) === baseSnapshot);
}

// ── 4. A food without references round-trips without gaining any ────────────
{
  const removed = captureRemovedCustomFood(base, 'custom_a')!;
  assert('unreferenced food captures -1 positions', removed.favoriteIndex === -1 && removed.recentsIndex === -1);
  const afterRemove = applyRemoveCustomFood(base, 'custom_a');
  assert('removing an unreferenced food leaves favorites/recents untouched', afterRemove.favorites === base.favorites && afterRemove.recents === base.recents);
  const afterRestore = applyRestoreCustomFood(afterRemove, removed);
  assert('restoring an unreferenced food round-trips exactly', snapshot(afterRestore) === baseSnapshot);
  assert('restoring an unreferenced food does not invent references', !afterRestore.favorites.includes('custom_a') && !afterRestore.recents.includes('custom_a'));
}

// ── 5. Repeated / out-of-order calls can never duplicate ────────────────────
{
  const removed = captureRemovedCustomFood(base, 'custom_b')!;
  const afterRemove = applyRemoveCustomFood(base, 'custom_b');

  // Double-tapped delete: second removal is a no-op (same reference), and
  // there is nothing new to capture.
  assert('second removal is a no-op (same reference)', applyRemoveCustomFood(afterRemove, 'custom_b') === afterRemove);
  assert('capture after removal returns null', captureRemovedCustomFood(afterRemove, 'custom_b') === null);

  // Double-tapped Undo: the second restore sees the food present and no-ops.
  const restoredOnce = applyRestoreCustomFood(afterRemove, removed);
  const restoredTwice = applyRestoreCustomFood(restoredOnce, removed);
  assert('second restore is a no-op (same reference)', restoredTwice === restoredOnce);
  assert('second restore never duplicates the food', restoredTwice.customFoods.filter(f => f.id === 'custom_b').length === 1);
  assert('second restore never duplicates references', restoredTwice.favorites.filter(id => id === 'custom_b').length === 1 && restoredTwice.recents.filter(id => id === 'custom_b').length === 1);

  // Undo arriving without a recorded deletion (food still present) no-ops.
  assert('restore with the food still present is a no-op', applyRestoreCustomFood(base, removed) === base);

  // Removing an unknown id is a no-op.
  assert('removing an unknown id is a no-op', applyRemoveCustomFood(base, 'custom_ghost') === base);
}

// ── 6. Restore stays sane when the library changed during the window ────────
{
  const removed = captureRemovedCustomFood(base, 'custom_b')!;
  let state = applyRemoveCustomFood(base, 'custom_b');
  // The patient creates another food and favorites it before tapping Undo.
  const foodD = customFood('custom_d', 'Egg Bites');
  state = { ...state, customFoods: [...state.customFoods, foodD], favorites: [...state.favorites, 'custom_d'] };

  const afterRestore = applyRestoreCustomFood(state, removed);
  assert('restore re-inserts at the captured library position', afterRestore.customFoods.map(f => f.id).join(',') === 'custom_a,custom_b,custom_c,custom_d');
  assert('restore re-attaches the favorite at its captured position', afterRestore.favorites.join(',') === 'fd_seed_1,custom_b,fd_seed_2,custom_d');
  assert('restore keeps the new food and its favorite intact', afterRestore.customFoods.some(f => f.id === 'custom_d') && afterRestore.favorites.includes('custom_d'));

  // Captured positions beyond the current list length clamp to the end.
  const removedC = captureRemovedCustomFood(base, 'custom_c')!;
  const emptied: CustomFoodState = { customFoods: [], favorites: [], recents: [] };
  const restoredIntoEmpty = applyRestoreCustomFood(emptied, removedC);
  assert('restore into a shrunken library clamps the position', restoredIntoEmpty.customFoods.map(f => f.id).join(',') === 'custom_c');
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ My Foods delete/undo invariants: ${failures} failure(s) across ${checks} checks`);
  process.exit(1);
}
console.log(`✓ My Foods delete/undo invariants: ${checks} checks passed`);
