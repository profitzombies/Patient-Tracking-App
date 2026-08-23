/**
 * Diary copy-from-previous-day invariants check.
 *
 * Exercises the pure clone step behind the diary's "Copy yesterday" actions
 * (data/diary-entries.ts cloneEntriesForCopy) plus its interaction with the
 * merged seed+added projection, so a refactor can never reintroduce:
 *   1. clones that re-derive values from the current library instead of the
 *      logged snapshot,
 *   2. clones that reuse source ids (a copied seed id would be tombstoned or
 *      double-counted by later delete/undo flows),
 *   3. a copy that disturbs the source day,
 *   4. a copy Undo that misses part of its batch, over-removes on a double
 *      tap, or touches anything the copy didn't create.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:diary-copy
 */
import { cloneEntriesForCopy } from '../data/diary-entries';
import { applyRemoveEntries, applyRemoveEntry, type DiaryEntryState } from '../data/diary-entry-state';
import {
  buildSeedEntries,
  findFood,
  shiftDateKey,
  TODAY_KEY,
  type MealLogEntry,
} from '../data/patient-data';

const SEED_ENTRIES = buildSeedEntries();
const SEED_IDS = new Set(SEED_ENTRIES.map(e => e.id));
const isSeedId = (id: string) => SEED_IDS.has(id);

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

// Mimics the context's nextId('log') shape without depending on timers.
let idSeq = 0;
const makeId = () => `log_copy_${++idSeq}`;

const calorieTotal = (entries: MealLogEntry[]) => entries.reduce((acc, e) => acc + e.calories, 0);

/** Snapshot fields that must survive a copy untouched (everything but id/date/meal). */
const snapshotOf = ({ id: _id, dateKey: _dateKey, meal: _meal, ...rest }: MealLogEntry) => JSON.stringify(rest);

const YESTERDAY_KEY = shiftDateKey(TODAY_KEY, -1);

// A user-logged entry whose macros deliberately DISAGREE with the current
// library values for the same refId — the copy must keep the logged snapshot.
const driftedUserEntry: MealLogEntry = {
  id: 'log_user_1',
  dateKey: YESTERDAY_KEY,
  meal: 'breakfast',
  kind: 'food',
  refId: 'fd_greek_yogurt',
  name: 'Greek Yogurt (old label)',
  detail: '1 cup',
  quantity: 1,
  calories: 111,
  protein: 20,
  carbs: 7,
  fat: 1,
};

// ── 1. Per-meal copy: seeded yesterday → today's breakfast ──────────────────
{
  const sources = SEED_ENTRIES.filter(e => e.dateKey === YESTERDAY_KEY && e.meal === 'breakfast');
  assert('fixture: seeded yesterday has breakfast entries', sources.length > 0);
  const before = JSON.stringify(sources);

  const clones = cloneEntriesForCopy(sources, { dateKey: TODAY_KEY, meal: 'breakfast' }, makeId);
  assert('copies one clone per source', clones.length === sources.length);
  assert('clones land on the target day', clones.every(c => c.dateKey === TODAY_KEY));
  assert('clones land in the target meal', clones.every(c => c.meal === 'breakfast'));
  assert('clones carry fresh non-source ids', clones.every(c => !sources.some(s => s.id === c.id)));
  assert('clone ids are unique', new Set(clones.map(c => c.id)).size === clones.length);
  assert('no clone reuses a seed id', clones.every(c => !isSeedId(c.id)));
  assert(
    'clones keep the logged snapshot (name/detail/qty/cals/macros/kind/refId)',
    clones.every((c, i) => snapshotOf(c) === snapshotOf(sources[i]!)),
  );
  assert('clone order preserves source order', clones.every((c, i) => c.name === sources[i]!.name));
  assert('sources are not mutated', JSON.stringify(sources) === before);
}

// ── 2. Snapshot wins over the current library ───────────────────────────────
{
  const [clone] = cloneEntriesForCopy([driftedUserEntry], { dateKey: TODAY_KEY, meal: 'breakfast' }, makeId);
  const library = findFood(driftedUserEntry.refId!)!;
  assert('fixture: logged snapshot differs from current library values', library.calories !== driftedUserEntry.calories);
  assert('copy keeps logged calories, not library calories', clone!.calories === driftedUserEntry.calories);
  assert('copy keeps logged name, not library name', clone!.name === driftedUserEntry.name);
  assert('copy keeps logged macros', clone!.protein === 20 && clone!.carbs === 7 && clone!.fat === 1);
}

// ── 3. Whole-day copy keeps each entry's own meal slot ──────────────────────
{
  const sources = [...SEED_ENTRIES.filter(e => e.dateKey === YESTERDAY_KEY), driftedUserEntry];
  const clones = cloneEntriesForCopy(sources, { dateKey: TODAY_KEY }, makeId);
  assert('whole-day copy clones every source (seeded and user-added alike)', clones.length === sources.length);
  assert('whole-day copy preserves each meal slot', clones.every((c, i) => c.meal === sources[i]!.meal));
  assert('whole-day copy retargets every date', clones.every(c => c.dateKey === TODAY_KEY));
  assert('whole-day clone ids are all fresh', clones.every(c => c.id.startsWith('log_copy_')));
}

// ── 4. Merged projection: target totals grow, source day untouched ──────────
{
  const sources = SEED_ENTRIES.filter(e => e.dateKey === YESTERDAY_KEY && e.meal === 'lunch');
  const addedBefore: MealLogEntry[] = [driftedUserEntry];
  const clones = cloneEntriesForCopy(sources, { dateKey: TODAY_KEY, meal: 'lunch' }, makeId);
  const addedAfter = [...addedBefore, ...clones];

  const visibleFor = (added: MealLogEntry[], dateKey: string) =>
    [...SEED_ENTRIES, ...added].filter(e => e.dateKey === dateKey);

  const todayBefore = calorieTotal(visibleFor(addedBefore, TODAY_KEY));
  const todayAfter = calorieTotal(visibleFor(addedAfter, TODAY_KEY));
  assert('target-day totals grow by exactly the copied calories', todayAfter === todayBefore + calorieTotal(sources));
  assert(
    'source day is untouched by the copy',
    JSON.stringify(visibleFor(addedAfter, YESTERDAY_KEY)) === JSON.stringify(visibleFor(addedBefore, YESTERDAY_KEY)),
  );

  // Deleting a clone behaves like any user entry: dropped from addedEntries,
  // no tombstone, and the source seed row it was copied from stays visible.
  const removed = applyRemoveEntry({ addedEntries: addedAfter, removedEntryIds: [] }, clones[0]!.id, isSeedId);
  assert('removing a clone drops only the clone', removed.addedEntries.length === addedAfter.length - 1);
  assert('removing a clone records no tombstone', removed.removedEntryIds.length === 0);
  assert('removing a clone leaves the copied-from seed visible', visibleFor(removed.addedEntries, YESTERDAY_KEY).some(e => e.id === sources[0]!.id));
}

// ── 5. Whole-day copy onto the already-populated seeded today ────────────────
// The diary's one-tap "Copy all meals" is offered on days that already have
// entries; it must append the previous day without disturbing what's there.
{
  const sources = SEED_ENTRIES.filter(e => e.dateKey === YESTERDAY_KEY);
  const clones = cloneEntriesForCopy(sources, { dateKey: TODAY_KEY }, makeId);
  const visibleToday = (added: MealLogEntry[]) =>
    [...SEED_ENTRIES, ...added].filter(e => e.dateKey === TODAY_KEY);

  const before = visibleToday([]);
  assert('fixture: the seeded today already has entries', before.length > 0);

  const after = visibleToday(clones);
  assert('append: today gains exactly one entry per source', after.length === before.length + sources.length);
  assert(
    'append: every pre-existing today entry survives untouched',
    before.every(e => after.some(a => JSON.stringify(a) === JSON.stringify(e))),
  );
  assert('append: day totals grow by exactly the copied calories', calorieTotal(after) === calorieTotal(before) + calorieTotal(sources));
  assert('append: no clone id collides with an existing today entry', clones.every(c => !before.some(e => e.id === c.id)));
  assert('append: clones keep their source meal slots', clones.every((c, i) => c.meal === sources[i]!.meal));
}

// ── 6. Copy → Undo: one batch remove takes back exactly the clones ──────────
// The diary's copy snackbar undoes by removing the fresh clone ids returned
// from the copy. The batch must return the day to its exact pre-copy state,
// leave everything the copy didn't create alone, and stay safe under a
// double-tapped Undo or a clone the patient already deleted by hand.
{
  // Pre-copy state: a user entry on the source day AND an unrelated user
  // entry already sitting on today — the undo must never touch either.
  const todayUserEntry: MealLogEntry = {
    ...driftedUserEntry,
    id: 'log_user_today',
    dateKey: TODAY_KEY,
    meal: 'lunch',
    name: 'Pre-copy lunch',
  };
  const before: DiaryEntryState = {
    addedEntries: [driftedUserEntry, todayUserEntry],
    removedEntryIds: [],
  };

  const visibleFor = (state: DiaryEntryState, dateKey: string) => {
    const removed = new Set(state.removedEntryIds);
    return [...SEED_ENTRIES, ...state.addedEntries].filter(e => e.dateKey === dateKey && !removed.has(e.id));
  };

  // Whole-day copy of everything visible yesterday (seeded + user-added).
  const sources = [...SEED_ENTRIES.filter(e => e.dateKey === YESTERDAY_KEY), driftedUserEntry];
  const clones = cloneEntriesForCopy(sources, { dateKey: TODAY_KEY }, makeId);
  const cloneIds = clones.map(c => c.id);
  const after: DiaryEntryState = { ...before, addedEntries: [...before.addedEntries, ...clones] };
  assert('fixture: the copy grew today', visibleFor(after, TODAY_KEY).length === visibleFor(before, TODAY_KEY).length + sources.length);
  assert('fixture: no clone id is a seed id (undo can never tombstone a seed)', cloneIds.every(id => !isSeedId(id)));

  const undone = applyRemoveEntries(after, cloneIds, isSeedId);
  assert(
    'undo returns today to the identical pre-copy state (values, order, ids)',
    JSON.stringify(visibleFor(undone, TODAY_KEY)) === JSON.stringify(visibleFor(before, TODAY_KEY)),
  );
  assert(
    'undo returns day totals to their pre-copy values',
    calorieTotal(visibleFor(undone, TODAY_KEY)) === calorieTotal(visibleFor(before, TODAY_KEY)),
  );
  assert(
    'undo leaves the source day untouched',
    JSON.stringify(visibleFor(undone, YESTERDAY_KEY)) === JSON.stringify(visibleFor(before, YESTERDAY_KEY)),
  );
  assert('undo records no tombstones (clones are user entries)', undone.removedEntryIds.length === 0);
  assert('undo keeps the unrelated pre-copy user entry on today', undone.addedEntries.some(e => e.id === todayUserEntry.id));

  // Double-tapped Undo: the second application finds none of its ids and
  // must be a strict no-op — it can never over-remove.
  const undoneTwice = applyRemoveEntries(undone, cloneIds, isSeedId);
  assert('double undo is a strict no-op (same state reference)', undoneTwice === undone);

  // A clone deleted by hand before the Undo lands: the batch takes back only
  // the remaining clones and converges on the same pre-copy day.
  const handDeleted = applyRemoveEntry(after, cloneIds[0]!, isSeedId);
  const undonePartial = applyRemoveEntries(handDeleted, cloneIds, isSeedId);
  assert(
    'undo after a hand-deleted clone still lands on the exact pre-copy day',
    JSON.stringify(visibleFor(undonePartial, TODAY_KEY)) === JSON.stringify(visibleFor(before, TODAY_KEY)),
  );
  assert('undo after a hand-deleted clone records no tombstones', undonePartial.removedEntryIds.length === 0);

  // Per-meal copy undo behaves identically: only that meal's clones go.
  const mealSources = SEED_ENTRIES.filter(e => e.dateKey === YESTERDAY_KEY && e.meal === 'breakfast');
  const mealClones = cloneEntriesForCopy(mealSources, { dateKey: TODAY_KEY, meal: 'breakfast' }, makeId);
  const afterMeal: DiaryEntryState = { ...before, addedEntries: [...before.addedEntries, ...mealClones] };
  const mealUndone = applyRemoveEntries(afterMeal, mealClones.map(c => c.id), isSeedId);
  assert(
    'per-meal copy undo also round-trips today exactly',
    JSON.stringify(visibleFor(mealUndone, TODAY_KEY)) === JSON.stringify(visibleFor(before, TODAY_KEY)),
  );
}

// ── 7. Degenerate input ──────────────────────────────────────────────────────
{
  assert('empty source list clones nothing', cloneEntriesForCopy([], { dateKey: TODAY_KEY }, makeId).length === 0);
  const state: DiaryEntryState = { addedEntries: [driftedUserEntry], removedEntryIds: [] };
  assert('empty undo batch is a strict no-op (same state reference)', applyRemoveEntries(state, [], isSeedId) === state);
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ diary copy invariants: ${failures} failure(s) across ${checks} checks`);
  process.exit(1);
}
console.log(`✓ diary copy invariants: ${checks} checks passed`);
