/**
 * Pure state transitions behind diary deletion and its Undo.
 *
 * Kept free of React so the remove/restore invariants (no duplicates, no
 * double-counting, exact same-id restores) can be exercised directly by
 * scripts/verify-diary-undo.ts as a regression check.
 *
 * Model: seeded entries are rebuilt from the seed every launch, so deleting
 * one records a tombstone in `removedEntryIds`; user-logged entries live in
 * `addedEntries` and are deleted by filtering them out. Tombstones may only
 * ever reference seed ids.
 */
import type { MealLogEntry } from './patient-data';

export interface DiaryEntryState {
  /** Entries the patient logged themselves (on top of the seed). */
  addedEntries: MealLogEntry[];
  /** Tombstones for deleted seeded entries. */
  removedEntryIds: string[];
}

/**
 * Deletes an entry: user-logged entries drop out of `addedEntries`; seeded
 * entries are tombstoned by id. Idempotent — removing an already-tombstoned
 * seed returns the input state unchanged (same reference), and an id that is
 * neither present in `addedEntries` nor a seed (e.g. the second tap of a
 * double-tapped delete on a user entry) is a no-op: tombstoning a user id
 * would make the later Undo drop the dead tombstone instead of re-adding the
 * entry.
 */
export function applyRemoveEntry(
  state: DiaryEntryState,
  id: string,
  isSeedId: (id: string) => boolean,
): DiaryEntryState {
  const { addedEntries, removedEntryIds } = state;
  if (addedEntries.some(e => e.id === id)) {
    return { addedEntries: addedEntries.filter(e => e.id !== id), removedEntryIds };
  }
  if (!isSeedId(id) || removedEntryIds.includes(id)) return state;
  return { addedEntries, removedEntryIds: [...removedEntryIds, id] };
}

/**
 * Undoes a deletion. Returns the input state unchanged (same reference) when
 * there is no recorded deletion to undo, so a double-tapped Undo — or an Undo
 * that somehow runs before its deletion — can never duplicate an entry:
 *  - tombstoned seed id → drop the tombstone (the original row reappears in
 *    its original position);
 *  - tombstoned user id (possible in states persisted before tombstones were
 *    restricted to seed ids) → drop the dead tombstone and re-add the
 *    snapshot;
 *  - visible seed id (no tombstone) → no-op; appending a copy would
 *    double-count it;
 *  - user entry still present in `addedEntries` → no-op;
 *  - otherwise → re-add the exact snapshot under its original id.
 */
export function applyRestoreEntry(
  state: DiaryEntryState,
  entry: MealLogEntry,
  isSeedId: (id: string) => boolean,
): DiaryEntryState {
  const { addedEntries, removedEntryIds } = state;
  const isPresent = addedEntries.some(e => e.id === entry.id);
  if (removedEntryIds.includes(entry.id)) {
    const prunedTombstones = removedEntryIds.filter(id => id !== entry.id);
    if (!isSeedId(entry.id) && !isPresent) {
      return { addedEntries: [...addedEntries, entry], removedEntryIds: prunedTombstones };
    }
    return { addedEntries, removedEntryIds: prunedTombstones };
  }
  if (isSeedId(entry.id) || isPresent) return state;
  return { addedEntries: [...addedEntries, entry], removedEntryIds };
}
