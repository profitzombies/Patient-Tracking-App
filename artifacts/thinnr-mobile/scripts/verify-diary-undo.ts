/**
 * Diary delete/undo invariants check.
 *
 * Exercises the pure state transitions behind the diary's remove → Undo flow
 * (data/diary-entry-state.ts) so a refactor can never reintroduce the two
 * failure modes that matter:
 *   1. a restore that double-counts (duplicate seed copy or re-added row),
 *   2. an undo that silently fails to bring the entry back.
 * Covers immediate undo, repeated (double-tap) undo and deletes, out-of-order
 * calls, undo after the edit flow's tombstone + re-add of a seeded entry, and
 * the batched multi-delete undo (rapid clean-up → one Undo restores all).
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:diary-undo
 */
import {
  applyRemoveEntry,
  applyRestoreEntries,
  applyRestoreEntry,
  type DiaryEntryState,
} from '../data/diary-entry-state';
import { buildSeedEntries, type MealLogEntry } from '../data/patient-data';

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

/** The diary's merged projection: seeds + user entries minus tombstones. */
function visible(state: DiaryEntryState): MealLogEntry[] {
  const removed = new Set(state.removedEntryIds);
  return [...SEED_ENTRIES, ...state.addedEntries].filter(e => !removed.has(e.id));
}

const calorieTotal = (entries: MealLogEntry[]) => entries.reduce((acc, e) => acc + e.calories, 0);
const snapshot = (state: DiaryEntryState) => JSON.stringify(visible(state));

const userEntry: MealLogEntry = {
  id: 'log_test_1',
  dateKey: SEED_ENTRIES[0]!.dateKey,
  meal: 'dinner',
  kind: 'food',
  refId: 'fd_test',
  name: 'Test Salmon',
  detail: '1 fillet',
  quantity: 1,
  calories: 367,
  protein: 39,
  carbs: 0,
  fat: 22,
};

const base: DiaryEntryState = { addedEntries: [userEntry], removedEntryIds: [] };
const baseSnapshot = snapshot(base);
const baseTotal = calorieTotal(visible(base));

// ── 1. Seed entry: remove → restore round-trips exactly ─────────────────────
{
  const seed = SEED_ENTRIES[0]!;
  const afterRemove = applyRemoveEntry(base, seed.id, isSeedId);
  assert('seed removal hides exactly one entry', visible(afterRemove).length === visible(base).length - 1);
  assert('seed removal tombstones without touching user entries', afterRemove.addedEntries === base.addedEntries);
  assert('seed removal drops the right calories', calorieTotal(visible(afterRemove)) === baseTotal - seed.calories);

  const afterRestore = applyRestoreEntry(afterRemove, seed, isSeedId);
  assert('seed restore round-trips to the identical visible diary (values, order, ids)', snapshot(afterRestore) === baseSnapshot);
  assert(
    'seed restore drops the tombstone instead of re-adding a copy',
    afterRestore.addedEntries.length === base.addedEntries.length && afterRestore.removedEntryIds.length === 0,
  );
}

// ── 2. User entry: remove → restore keeps id and values ─────────────────────
{
  const afterRemove = applyRemoveEntry(base, userEntry.id, isSeedId);
  assert('user removal drops the row', !visible(afterRemove).some(e => e.id === userEntry.id));
  assert('user removal records no tombstone', afterRemove.removedEntryIds.length === 0);

  const afterRestore = applyRestoreEntry(afterRemove, userEntry, isSeedId);
  const restored = afterRestore.addedEntries.find(e => e.id === userEntry.id);
  assert('user restore brings the entry back', restored !== undefined);
  assert('user restore keeps the exact snapshot (same id and values)', JSON.stringify(restored) === JSON.stringify(userEntry));
  assert('user restore round-trips totals', calorieTotal(visible(afterRestore)) === baseTotal);
}

// ── 3. Repeated / out-of-order calls can never duplicate ────────────────────
{
  const seed = SEED_ENTRIES[0]!;

  // Double-tapped Undo on a seed: second call must be a no-op.
  const removedSeed = applyRemoveEntry(base, seed.id, isSeedId);
  const restoredOnce = applyRestoreEntry(removedSeed, seed, isSeedId);
  const restoredTwice = applyRestoreEntry(restoredOnce, seed, isSeedId);
  assert('double seed restore is a no-op', restoredTwice === restoredOnce);
  assert('double seed restore never duplicates', snapshot(restoredTwice) === baseSnapshot);

  // Double-tapped Undo on a user entry.
  const removedUser = applyRemoveEntry(base, userEntry.id, isSeedId);
  const userOnce = applyRestoreEntry(removedUser, userEntry, isSeedId);
  const userTwice = applyRestoreEntry(userOnce, userEntry, isSeedId);
  assert('double user restore is a no-op', userTwice === userOnce);
  assert('double user restore never duplicates', visible(userTwice).filter(e => e.id === userEntry.id).length === 1);

  // Undo arriving without a recorded deletion (e.g. racing ahead): no-op.
  assert('restore before any deletion no-ops for a seed', applyRestoreEntry(base, seed, isSeedId) === base);
  assert('restore before any deletion no-ops for a user entry', applyRestoreEntry(base, userEntry, isSeedId) === base);

  // Repeated remove is idempotent (no duplicate tombstones).
  const removedTwice = applyRemoveEntry(applyRemoveEntry(base, seed.id, isSeedId), seed.id, isSeedId);
  assert('repeated seed removal keeps a single tombstone', removedTwice.removedEntryIds.filter(id => id === seed.id).length === 1);
}

// ── 4. Edited seed (tombstone + re-added copy) stays single after undo ───────
{
  const seed = SEED_ENTRIES[1]!;
  const editedCopy: MealLogEntry = { ...seed, id: 'log_edit_1', quantity: 2, calories: seed.calories * 2 };
  // updateEntry's seed branch: tombstone the seed, append the edited copy.
  const edited: DiaryEntryState = {
    addedEntries: [...base.addedEntries, editedCopy],
    removedEntryIds: [seed.id],
  };
  const editedSnapshot = snapshot(edited);

  const afterRemove = applyRemoveEntry(edited, editedCopy.id, isSeedId);
  assert('removing the edited copy keeps the seed tombstoned', afterRemove.removedEntryIds.includes(seed.id));

  const afterRestore = applyRestoreEntry(afterRemove, editedCopy, isSeedId);
  assert('undoing the edited-copy deletion restores exactly the copy', snapshot(afterRestore) === editedSnapshot);
  assert('the original seed row stays hidden (no resurrection)', !visible(afterRestore).some(e => e.id === seed.id));
  assert('exactly one instance of the edited entry exists', visible(afterRestore).filter(e => e.id === editedCopy.id).length === 1);
}

// ── 5. Double-tapped delete of a user entry stays restorable ─────────────────
{
  // Two remove calls for the same user entry can land back to back (the second
  // tap fires before React unmounts the row); the second must be a pure no-op —
  // in particular it must NOT tombstone the user id, or the later Undo would
  // just drop the tombstone instead of re-adding the entry.
  const removedOnce = applyRemoveEntry(base, userEntry.id, isSeedId);
  const removedTwice = applyRemoveEntry(removedOnce, userEntry.id, isSeedId);
  assert('repeated user removal is a no-op (same state reference)', removedTwice === removedOnce);
  assert('repeated user removal never tombstones a user id', removedTwice.removedEntryIds.length === 0);

  const afterRestore = applyRestoreEntry(removedTwice, userEntry, isSeedId);
  const matches = afterRestore.addedEntries.filter(e => e.id === userEntry.id);
  assert('restore after repeated removal re-adds the entry exactly once', matches.length === 1);
  assert(
    'restore after repeated removal keeps the exact snapshot (same id and values)',
    JSON.stringify(matches[0]) === JSON.stringify(userEntry),
  );
  assert('restore after repeated removal round-trips the visible diary', snapshot(afterRestore) === baseSnapshot);

  // Removing an id that is neither a user entry nor a seed is a no-op.
  assert('removing an unknown id is a no-op', applyRemoveEntry(base, 'log_ghost_9', isSeedId) === base);

  // States persisted before tombstones were restricted to seed ids may carry
  // a tombstone for a user id: Undo must still bring the entry back.
  const legacy: DiaryEntryState = { addedEntries: [], removedEntryIds: [userEntry.id] };
  const healed = applyRestoreEntry(legacy, userEntry, isSeedId);
  assert('legacy user-id tombstone: restore re-adds the exact entry', JSON.stringify(healed.addedEntries) === JSON.stringify([userEntry]));
  assert('legacy user-id tombstone: the dead tombstone is dropped', healed.removedEntryIds.length === 0);
}

// ── 6. Multi-delete clean-up: one batched undo restores everything ──────────
{
  const seedA = SEED_ENTRIES[0]!;
  const seedB = SEED_ENTRIES[1]!;

  // Rapid clean-up: two seeds and a user entry deleted back to back.
  let s = applyRemoveEntry(base, seedA.id, isSeedId);
  s = applyRemoveEntry(s, userEntry.id, isSeedId);
  s = applyRemoveEntry(s, seedB.id, isSeedId);
  assert('rapid triple delete hides all three rows', visible(s).length === visible(base).length - 3);
  assert(
    'rapid triple delete drops the right calories',
    calorieTotal(visible(s)) === baseTotal - seedA.calories - seedB.calories - userEntry.calories,
  );

  const restored = applyRestoreEntries(s, [seedA, userEntry, seedB], isSeedId);
  assert('batched undo restores the identical visible diary (values, order, ids)', snapshot(restored) === baseSnapshot);
  assert('batched undo round-trips totals', calorieTotal(visible(restored)) === baseTotal);
  assert('batched undo leaves no tombstones behind', restored.removedEntryIds.length === 0);

  // Doubled-up batch members (e.g. the same row armed twice) can't duplicate.
  const doubled = applyRestoreEntries(s, [seedA, seedA, userEntry, userEntry, seedB], isSeedId);
  assert('duplicate batch members never duplicate rows', snapshot(doubled) === baseSnapshot);

  // A member already restored on its own no-ops inside the batch while the
  // rest still come back.
  const partiallyRestored = applyRestoreEntry(s, seedA, isSeedId);
  const completed = applyRestoreEntries(partiallyRestored, [seedA, userEntry, seedB], isSeedId);
  assert('batched undo after a partial restore still completes the set', snapshot(completed) === baseSnapshot);

  // No recorded deletions → strict no-ops (same state reference).
  assert('empty batch restore is a no-op (same state reference)', applyRestoreEntries(s, [], isSeedId) === s);
  assert(
    'batch of already-visible entries is a no-op (same state reference)',
    applyRestoreEntries(base, [seedA, userEntry], isSeedId) === base,
  );

  // Two user entries deleted bottom-to-top: both return exactly once with the
  // exact snapshots and totals, regardless of deletion order.
  const secondUser: MealLogEntry = {
    ...userEntry,
    id: 'log_test_2',
    name: 'Test Rice',
    detail: '1 cup',
    calories: 210,
    protein: 4,
    carbs: 45,
    fat: 2,
  };
  const twoUsers: DiaryEntryState = { addedEntries: [userEntry, secondUser], removedEntryIds: [] };
  let t = applyRemoveEntry(twoUsers, secondUser.id, isSeedId);
  t = applyRemoveEntry(t, userEntry.id, isSeedId);
  assert('bottom-to-top double delete empties the user log', t.addedEntries.length === 0);
  const back = applyRestoreEntries(t, [secondUser, userEntry], isSeedId);
  assert(
    'both user entries return exactly once each',
    [userEntry.id, secondUser.id].every(id => back.addedEntries.filter(e => e.id === id).length === 1),
  );
  assert(
    'multi-user restore keeps the exact snapshots (ids and values)',
    JSON.stringify([...back.addedEntries].sort((a, b) => a.id.localeCompare(b.id))) ===
      JSON.stringify([userEntry, secondUser]),
  );
  assert(
    'multi-user restore round-trips totals',
    calorieTotal(visible(back)) === calorieTotal(visible(twoUsers)),
  );
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ diary delete/undo invariants: ${failures} failure(s) across ${checks} checks`);
  process.exit(1);
}
console.log(`✓ diary delete/undo invariants: ${checks} checks passed`);
