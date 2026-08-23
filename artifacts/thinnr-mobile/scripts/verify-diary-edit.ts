/**
 * Diary edit math + state invariants check.
 *
 * Exercises the two pure pieces behind the entry edit flow so a regression
 * (rescale drift, double-counting after a move, an edited seed resurrecting
 * on relaunch) can never reach patients silently:
 *   1. rescaleEntrySnapshot (data/diary-entries.ts) — macro math and the
 *      rebuilt human-readable detail line for foods, recipes, and bad data;
 *   2. applyUpdateEntry (data/diary-entry-state.ts) — the updateEntry state
 *      transition: in-place rewrite for user-logged entries, tombstone +
 *      re-added clone for seeded entries, no-ops for unknown/removed ids.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:diary-edit
 */
import { formatQty, rescaleEntrySnapshot } from '../data/diary-entries';
import {
  applyRemoveEntry,
  applyUpdateEntry,
  type DiaryEntryState,
} from '../data/diary-entry-state';
import { buildSeedEntries, shiftDateKey, type MealLogEntry } from '../data/patient-data';

const SEED_ENTRIES = buildSeedEntries();
const SEED_BY_ID = new Map(SEED_ENTRIES.map(e => [e.id, e]));
const findSeed = (id: string) => SEED_BY_ID.get(id);
const isSeedId = (id: string) => SEED_BY_ID.has(id);

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

function assertEqual(label: string, actual: string | number, expected: string | number) {
  checks += 1;
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Synthetic logged entry with sensible defaults, overridable per test. */
const entry = (over: Partial<MealLogEntry>): MealLogEntry => ({
  id: 'log_fx',
  dateKey: '2026-08-01',
  meal: 'dinner',
  kind: 'food',
  refId: 'fd_fx',
  name: 'Fixture Food',
  detail: '2 × 4 oz',
  quantity: 2,
  calories: 300,
  protein: 50,
  carbs: 4,
  fat: 10,
  ...over,
});

// ── 1. formatQty — the quantity as patients see it ──────────────────────────
assertEqual('formatQty integer', formatQty(2), '2');
assertEqual('formatQty trailing .0 dropped', formatQty(3.0), '3');
assertEqual('formatQty half step', formatQty(1.5), '1.5');
assertEqual('formatQty minimum step', formatQty(0.5), '0.5');
assertEqual('formatQty two digits', formatQty(10), '10');

// ── 2. rescaleEntrySnapshot — food math and detail rebuild ───────────────────
{
  const base = entry({});

  const doubled = rescaleEntrySnapshot(base, 4);
  assertEqual('qty 2→4 detail', doubled.detail, '4 × 4 oz');
  assertEqual('qty 2→4 quantity', doubled.quantity, 4);
  assertEqual('qty 2→4 calories', doubled.calories, 600);
  assertEqual('qty 2→4 protein', doubled.protein, 100);
  assertEqual('qty 2→4 carbs', doubled.carbs, 8);
  assertEqual('qty 2→4 fat', doubled.fat, 20);

  const single = rescaleEntrySnapshot(base, 1);
  assertEqual('qty 2→1 detail', single.detail, '1 × 4 oz');
  assertEqual('qty 2→1 calories', single.calories, 150);
  assertEqual('qty 2→1 protein', single.protein, 25);

  const fractional = rescaleEntrySnapshot(base, 1.5);
  assertEqual('qty 2→1.5 detail', fractional.detail, '1.5 × 4 oz');
  assertEqual('qty 2→1.5 calories', fractional.calories, 225);
  assertEqual('qty 2→1.5 protein (37.5 rounds up)', fractional.protein, 38);
  assertEqual('qty 2→1.5 carbs', fractional.carbs, 3);
  assertEqual('qty 2→1.5 fat (7.5 rounds up)', fractional.fat, 8);

  // Seeded qty-1 foods log the bare serving ("4 oz") — scaling must add the ×.
  const bare = entry({ detail: '4 oz', quantity: 1, calories: 100, protein: 20, carbs: 2, fat: 3 });
  assertEqual('bare serving gains multiplier', rescaleEntrySnapshot(bare, 2).detail, '2 × 4 oz');
  assertEqual('bare serving doubles calories', rescaleEntrySnapshot(bare, 2).calories, 200);
  assertEqual('bare serving fractional detail', rescaleEntrySnapshot(bare, 0.5).detail, '0.5 × 4 oz');
  assertEqual('bare serving halves calories', rescaleEntrySnapshot(bare, 0.5).calories, 50);

  // Fractional base quantity: per-unit macros = totals ÷ 0.5.
  const half = entry({ detail: '0.5 × 1 cup', quantity: 0.5, calories: 60, protein: 6, carbs: 9, fat: 1 });
  assertEqual('qty 0.5→2 calories', rescaleEntrySnapshot(half, 2).calories, 240);
  assertEqual('qty 0.5→2 protein', rescaleEntrySnapshot(half, 2).protein, 24);
  assertEqual('qty 0.5→2 detail', rescaleEntrySnapshot(half, 2).detail, '2 × 1 cup');
}

// ── 3. rescaleEntrySnapshot — recipe detail lines ────────────────────────────
{
  const recipe = entry({ kind: 'recipe', detail: '1 serving', quantity: 1, calories: 420, protein: 38, carbs: 22, fat: 18 });
  assertEqual('recipe 1→2 pluralizes', rescaleEntrySnapshot(recipe, 2).detail, '2 servings');
  assertEqual('recipe 1→2 calories', rescaleEntrySnapshot(recipe, 2).calories, 840);
  assertEqual('recipe 1→1.5 detail', rescaleEntrySnapshot(recipe, 1.5).detail, '1.5 servings');
  assertEqual('recipe 1→1.5 calories', rescaleEntrySnapshot(recipe, 1.5).calories, 630);

  const suffixed = entry({ kind: 'recipe', detail: '2 servings · recipe', quantity: 2, calories: 500, protein: 40, carbs: 30, fat: 20 });
  assertEqual('recipe suffix survives + singularizes', rescaleEntrySnapshot(suffixed, 1).detail, '1 serving · recipe');
  assertEqual('recipe suffix halves calories', rescaleEntrySnapshot(suffixed, 1).calories, 250);
}

// ── 4. rescaleEntrySnapshot — guards against drift and bad data ──────────────
{
  // qty-0 snapshot (corrupt persisted data) must not divide by zero.
  const broken = entry({ kind: 'quick', refId: undefined, detail: 'Estimated bite', quantity: 0, calories: 200, protein: 10, carbs: 5, fat: 2 });
  const scaled = rescaleEntrySnapshot(broken, 3);
  assertEqual('qty-0 base treated as 1 (calories)', scaled.calories, 600);
  assertEqual('qty-0 base treated as 1 (protein)', scaled.protein, 30);
  assert(
    'qty-0 rescale stays finite',
    [scaled.calories, scaled.protein, scaled.carbs, scaled.fat].every(Number.isFinite),
  );

  // Same-quantity edits keep the detail string byte-for-byte and totals exact
  // even when totals don't divide evenly by the quantity.
  const awkward = entry({ quantity: 3, detail: '3 × 1 cup', calories: 100, protein: 7, carbs: 11, fat: 2 });
  const same = rescaleEntrySnapshot(awkward, 3);
  assert('same-qty keeps the exact detail string', same.detail === awkward.detail);
  assertEqual('same-qty keeps calories (no ÷3 ×3 drift)', same.calories, 100);
  assertEqual('same-qty keeps protein', same.protein, 7);
  assertEqual('same-qty keeps carbs', same.carbs, 11);

  // Edit then edit back: the second edit works from the stored rescaled
  // snapshot (exactly what the app persists) and must return the original.
  const edited = { ...entry({}), ...rescaleEntrySnapshot(entry({}), 3) };
  const back = rescaleEntrySnapshot(edited, 2);
  assertEqual('round-trip detail', back.detail, '2 × 4 oz');
  assertEqual('round-trip calories', back.calories, 300);
  assertEqual('round-trip protein', back.protein, 50);
  assertEqual('round-trip carbs', back.carbs, 4);
  assertEqual('round-trip fat', back.fat, 10);
}

// ── 5. Every real seeded entry rescales cleanly ──────────────────────────────
{
  const offenders: string[] = [];
  for (const seed of SEED_ENTRIES) {
    const next = rescaleEntrySnapshot(seed, seed.quantity + 1);
    const finite = [next.calories, next.protein, next.carbs, next.fat].every(
      n => Number.isFinite(n) && n >= 0,
    );
    const prefixed = next.detail.startsWith(formatQty(seed.quantity + 1));
    if (!finite || !prefixed) {
      offenders.push(`${seed.id} ("${seed.detail}" → "${next.detail}", ${next.calories} cal)`);
    }
  }
  assert(
    `all ${SEED_ENTRIES.length} seeded entries rescale to finite macros + parseable detail` +
      (offenders.length > 0 ? ` — offenders: ${offenders.slice(0, 3).join('; ')}` : ''),
    offenders.length === 0,
  );
}

// ── applyUpdateEntry setup ───────────────────────────────────────────────────

/** The diary's merged projection: pristine seeds + user entries − tombstones.
 *  Rebuilding from SEED_ENTRIES here is exactly what a relaunch does. */
function visible(state: DiaryEntryState): MealLogEntry[] {
  const removed = new Set(state.removedEntryIds);
  return [...SEED_ENTRIES, ...state.addedEntries].filter(e => !removed.has(e.id));
}

const calorieTotal = (entries: MealLogEntry[]) => entries.reduce((acc, e) => acc + e.calories, 0);

let idCalls = 0;
const nextCloneId = () => `log_clone_${(idCalls += 1)}`;

const userEntry = entry({
  id: 'log_user_1',
  dateKey: SEED_ENTRIES[0]!.dateKey,
  detail: '4 oz',
  quantity: 1,
  calories: 367,
  protein: 39,
  carbs: 0,
  fat: 22,
});
const base: DiaryEntryState = { addedEntries: [userEntry], removedEntryIds: [] };
const baseJson = JSON.stringify(base);
const baseTotal = calorieTotal(visible(base));

// ── 6. User-added entry: rewritten in place under its original id ────────────
{
  const targetDay = shiftDateKey(userEntry.dateKey, 1);
  const before = idCalls;
  const after = applyUpdateEntry(
    base,
    userEntry.id,
    { meal: 'lunch', quantity: 2, dateKey: targetDay },
    findSeed,
    nextCloneId,
  );
  const updated = after.addedEntries.find(e => e.id === userEntry.id);
  assert('user edit keeps the original id', updated !== undefined);
  assertEqual('user edit stays a single row', after.addedEntries.length, 1);
  assertEqual('user edit moves the meal slot', updated!.meal, 'lunch');
  assertEqual('user edit moves the day', updated!.dateKey, targetDay);
  assertEqual('user edit updates quantity', updated!.quantity, 2);
  assertEqual('user edit doubles calories', updated!.calories, 734);
  assertEqual('user edit doubles protein', updated!.protein, 78);
  assertEqual('user edit rebuilds detail', updated!.detail, '2 × 4 oz');
  assert(
    'user edit records no tombstone',
    after.removedEntryIds === base.removedEntryIds && after.removedEntryIds.length === 0,
  );
  assertEqual('user edit consumes no fresh id', idCalls, before);
  assertEqual('user edit never duplicates the row', visible(after).filter(e => e.id === userEntry.id).length, 1);
  assertEqual('user edit total = base + delta', calorieTotal(visible(after)), baseTotal + 367);
  assertEqual(
    'old day loses the moved entry',
    visible(after).filter(e => e.dateKey === userEntry.dateKey && e.id === userEntry.id).length,
    0,
  );
  assertEqual(
    'new day gains the moved entry once',
    visible(after).filter(e => e.dateKey === targetDay && e.id === userEntry.id).length,
    1,
  );
  assert('inputs stay unmutated', JSON.stringify(base) === baseJson && userEntry.meal === 'dinner');

  // Slot-only change: same quantity, no dateKey → macros/detail/day untouched.
  const slotOnly = applyUpdateEntry(base, userEntry.id, { meal: 'snacks', quantity: 1 }, findSeed, nextCloneId);
  const slotRow = slotOnly.addedEntries[0]!;
  assertEqual('slot-only edit moves the slot', slotRow.meal, 'snacks');
  assertEqual('slot-only edit keeps calories', slotRow.calories, 367);
  assert('slot-only edit keeps the exact detail string', slotRow.detail === userEntry.detail);
  assertEqual('slot-only edit keeps the day (dateKey omitted)', slotRow.dateKey, userEntry.dateKey);
}

// ── 7. Seeded entry: tombstone + re-added clone, dead after relaunch ─────────
{
  const seed = SEED_ENTRIES[0]!;
  const targetDay = shiftDateKey(seed.dateKey, 1);
  const expected = rescaleEntrySnapshot(seed, seed.quantity + 1); // math pinned in §2–4
  const before = idCalls;
  const after = applyUpdateEntry(
    base,
    seed.id,
    { meal: 'snacks', quantity: seed.quantity + 1, dateKey: targetDay },
    findSeed,
    nextCloneId,
  );

  assert('seed edit tombstones the seed id', after.removedEntryIds.includes(seed.id));
  assertEqual('seed edit adds exactly one tombstone', after.removedEntryIds.length, 1);
  assertEqual('seed edit appends exactly one clone', after.addedEntries.length, base.addedEntries.length + 1);
  const clone = after.addedEntries[after.addedEntries.length - 1]!;
  assertEqual('seed edit consumes exactly one fresh id', idCalls, before + 1);
  assertEqual('clone takes the freshly minted id', clone.id, `log_clone_${idCalls}`);
  assert('clone id is not a seed id', !isSeedId(clone.id));
  assertEqual('clone lands on the new day', clone.dateKey, targetDay);
  assertEqual('clone moves the meal slot', clone.meal, 'snacks');
  assertEqual('clone carries rescaled quantity', clone.quantity, seed.quantity + 1);
  assertEqual('clone carries rescaled calories', clone.calories, expected.calories);
  assertEqual('clone carries rescaled protein', clone.protein, expected.protein);
  assertEqual('clone carries rescaled carbs', clone.carbs, expected.carbs);
  assertEqual('clone carries rescaled fat', clone.fat, expected.fat);
  assertEqual('clone carries the rebuilt detail', clone.detail, expected.detail);
  assertEqual('clone keeps the library link', clone.refId ?? '', seed.refId ?? '');
  assertEqual('clone keeps the name', clone.name, seed.name);

  // Relaunch: visible() re-merges the pristine seed list against the state.
  const rows = visible(after);
  assert('edited seed stays dead after relaunch', !rows.some(e => e.id === seed.id));
  assertEqual('exactly one clone is visible', rows.filter(e => e.id === clone.id).length, 1);
  assertEqual('row count is unchanged (swap, not add)', rows.length, visible(base).length);
  assertEqual('total calories = base − seed + clone', calorieTotal(rows), baseTotal - seed.calories + clone.calories);
  assertEqual(
    'old day drops exactly one row',
    rows.filter(e => e.dateKey === seed.dateKey).length,
    visible(base).filter(e => e.dateKey === seed.dateKey).length - 1,
  );
  assertEqual(
    'new day gains exactly one row',
    rows.filter(e => e.dateKey === targetDay).length,
    visible(base).filter(e => e.dateKey === targetDay).length + 1,
  );
  assert('base state stays unmutated by seed edit', JSON.stringify(base) === baseJson);

  // Editing the clone again goes through the in-place branch: no second
  // tombstone, no extra clone — repeat edits can never multiply the row.
  const again = applyUpdateEntry(
    after,
    clone.id,
    { meal: 'dinner', quantity: seed.quantity + 2, dateKey: seed.dateKey },
    findSeed,
    nextCloneId,
  );
  assertEqual('second edit adds no tombstone', again.removedEntryIds.length, 1);
  assertEqual('second edit appends no extra clone', again.addedEntries.length, after.addedEntries.length);
  assertEqual('second edit keeps the clone id', again.addedEntries[again.addedEntries.length - 1]!.id, clone.id);
  assertEqual(
    'still exactly one visible copy of the edited meal',
    visible(again).filter(e => e.id === clone.id || e.id === seed.id).length,
    1,
  );

  // A stale edit panel still holding the original seed id must no-op.
  assert(
    'stale edit of the tombstoned seed id no-ops (same reference)',
    applyUpdateEntry(after, seed.id, { meal: 'lunch', quantity: 1 }, findSeed, nextCloneId) === after,
  );

  // dateKey omitted → the clone stays on the seed's own day.
  const sameDay = applyUpdateEntry(base, seed.id, { meal: seed.meal, quantity: seed.quantity + 1 }, findSeed, nextCloneId);
  assertEqual(
    'dateKey omitted keeps the day',
    sameDay.addedEntries[sameDay.addedEntries.length - 1]!.dateKey,
    seed.dateKey,
  );
}

// ── 8. No-ops: unknown ids and already-removed entries ───────────────────────
{
  const seed = SEED_ENTRIES[1]!;
  const before = idCalls;

  assert(
    'unknown id no-ops (same reference)',
    applyUpdateEntry(base, 'log_ghost_9', { meal: 'lunch', quantity: 2 }, findSeed, nextCloneId) === base,
  );

  // Deleted seed: remove first, then a late edit arrives for the same id.
  const removed = applyRemoveEntry(base, seed.id, isSeedId);
  assert(
    'editing a deleted seed no-ops (same reference)',
    applyUpdateEntry(removed, seed.id, { meal: 'lunch', quantity: 2 }, findSeed, nextCloneId) === removed,
  );
  assert('deleted seed stays hidden', !visible(removed).some(e => e.id === seed.id));

  // Legacy persisted state: a user id tombstoned while its row still exists.
  const legacy: DiaryEntryState = { addedEntries: [userEntry], removedEntryIds: [userEntry.id] };
  assert(
    'legacy tombstoned user id no-ops (same reference)',
    applyUpdateEntry(legacy, userEntry.id, { meal: 'lunch', quantity: 2 }, findSeed, nextCloneId) === legacy,
  );

  assertEqual('no-ops never consume fresh ids', idCalls, before);
}

// ── 9. Ingredient-adjustment edits: nutrition override + adjustments field ──
{
  const adjustment = { index: 0, amount: 3, unit: 'oz' };
  const nutrition = { calories: 512, protein: 41, carbs: 19, fat: 23 };

  // Explicit nutrition wins over the quantity rescale, and the adjustment
  // list rides along with a tagged detail line.
  const overridden = applyUpdateEntry(
    base,
    userEntry.id,
    { meal: userEntry.meal, quantity: userEntry.quantity, nutrition, adjustments: [adjustment] },
    findSeed,
    nextCloneId,
  );
  const row = overridden.addedEntries.find(e => e.id === userEntry.id)!;
  assertEqual('adjust edit takes override calories', row.calories, 512);
  assertEqual('adjust edit takes override protein', row.protein, 41);
  assertEqual('adjust edit takes override carbs', row.carbs, 19);
  assertEqual('adjust edit takes override fat', row.fat, 23);
  assertEqual('adjust edit keeps quantity', row.quantity, userEntry.quantity);
  assert(
    'adjust edit stores the adjustment list',
    JSON.stringify(row.adjustments) === JSON.stringify([adjustment]),
  );
  assert('adjust edit tags the detail', row.detail.endsWith(' · adjusted'));

  // A later edit that does not mention adjustments keeps them (undefined =
  // untouched) and rescales from the stored snapshot.
  const requantified = applyUpdateEntry(
    overridden,
    userEntry.id,
    { meal: 'lunch', quantity: 2 },
    findSeed,
    nextCloneId,
  );
  const requantifiedRow = requantified.addedEntries.find(e => e.id === userEntry.id)!;
  assert(
    'later edit keeps stored adjustments',
    JSON.stringify(requantifiedRow.adjustments) === JSON.stringify([adjustment]),
  );
  assert('later edit keeps the adjusted tag', requantifiedRow.detail.endsWith(' · adjusted'));
  assertEqual('later edit rescales from the adjusted snapshot', requantifiedRow.calories, 1024);

  // Explicit null clears the list and strips the tag (reset-to-original save).
  const cleared = applyUpdateEntry(
    overridden,
    userEntry.id,
    {
      meal: userEntry.meal,
      quantity: userEntry.quantity,
      nutrition: { calories: 300, protein: 50, carbs: 4, fat: 10 },
      adjustments: null,
    },
    findSeed,
    nextCloneId,
  );
  const clearedRow = cleared.addedEntries.find(e => e.id === userEntry.id)!;
  assert('null clears stored adjustments', clearedRow.adjustments === undefined);
  assert('null strips the adjusted tag', !clearedRow.detail.includes('· adjusted'));
  assertEqual('cleared row carries the reset calories', clearedRow.calories, 300);

  // Seed path: the tombstone + clone branch carries both fields too.
  const seed = SEED_ENTRIES.find(e => e.kind === 'recipe') ?? SEED_ENTRIES[0]!;
  const seedEdited = applyUpdateEntry(
    base,
    seed.id,
    { meal: seed.meal, quantity: seed.quantity, nutrition, adjustments: [adjustment] },
    findSeed,
    nextCloneId,
  );
  const seedClone = seedEdited.addedEntries[seedEdited.addedEntries.length - 1]!;
  assert('seed edit still tombstones', seedEdited.removedEntryIds.includes(seed.id));
  assert(
    'seed clone stores adjustments',
    JSON.stringify(seedClone.adjustments) === JSON.stringify([adjustment]),
  );
  assert('seed clone is tagged', seedClone.detail.endsWith(' · adjusted'));
  assertEqual('seed clone carries the override calories', seedClone.calories, 512);

  // Re-saving an adjusted entry never double-tags the detail line.
  const retagged = applyUpdateEntry(
    overridden,
    userEntry.id,
    { meal: userEntry.meal, quantity: userEntry.quantity, nutrition, adjustments: [adjustment] },
    findSeed,
    nextCloneId,
  );
  const retaggedRow = retagged.addedEntries.find(e => e.id === userEntry.id)!;
  assertEqual(
    'tag applied once across repeat saves',
    retaggedRow.detail.split('· adjusted').length - 1,
    1,
  );
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ diary edit invariants: ${failures} failure(s) across ${checks} checks`);
  process.exit(1);
}
console.log(`✓ diary edit invariants: ${checks} checks passed`);
