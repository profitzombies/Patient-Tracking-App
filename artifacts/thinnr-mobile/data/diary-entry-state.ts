/**
 * Pure state transitions behind the diary: deletion + Undo, and the edit
 * flow's rewrite of a logged entry (meal slot, quantity, day).
 *
 * Kept free of React so the invariants (no duplicates, no double-counting,
 * exact same-id restores, no resurrected seeds) can be exercised directly by
 * scripts/verify-diary-undo.ts and scripts/verify-diary-edit.ts as
 * regression checks.
 *
 * Model: seeded entries are rebuilt from the seed every launch, so deleting
 * one records a tombstone in `removedEntryIds`; user-logged entries live in
 * `addedEntries` and are deleted by filtering them out. Tombstones may only
 * ever reference seed ids.
 */
import { rescaleEntrySnapshot, stripAdjustedTag, withAdjustedTag } from './diary-entries';
import type {
  IngredientAdjustment,
  IngredientNutrition,
  MealLogEntry,
  MealSlot,
} from './patient-data';
import { rescaleSnapshotSelection, scaledSnapshotMacros } from './food-nutrition';

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
 * Deletes a whole batch of entries in one transition — the copy-Undo flow,
 * where the snackbar must take back exactly the clone ids one copy created.
 * Applies applyRemoveEntry left to right, so each per-id invariant holds for
 * the batch as a whole: an id that is already gone (a double-tapped Undo, or
 * a clone the patient deleted by hand before undoing) simply no-ops, and a
 * batch of fresh user-entry ids can never tombstone a seed. Returns the input
 * state unchanged (same reference) when nothing in the batch is deletable,
 * including the empty batch.
 */
export function applyRemoveEntries(
  state: DiaryEntryState,
  ids: readonly string[],
  isSeedId: (id: string) => boolean,
): DiaryEntryState {
  return ids.reduce((cur, id) => applyRemoveEntry(cur, id, isSeedId), state);
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

/**
 * Undoes a whole batch of deletions in one transition — the rapid
 * "clean up my day" flow where several rows are removed back to back and a
 * single Undo must bring every one of them back. Applies applyRestoreEntry
 * left to right (batch order = deletion order), so each per-entry invariant
 * (exact ids, no duplicates, no-op without a recorded deletion) holds for the
 * batch as a whole. Returns the input state unchanged (same reference) when
 * nothing in the batch needs restoring, including the empty batch.
 */
export function applyRestoreEntries(
  state: DiaryEntryState,
  entries: readonly MealLogEntry[],
  isSeedId: (id: string) => boolean,
): DiaryEntryState {
  return entries.reduce((cur, entry) => applyRestoreEntry(cur, entry, isSeedId), state);
}

/** The fields a patient can fix on a logged entry: slot, quantity, day —
 * plus, from the ingredient breakdown, recomputed totals and the adjustment
 * list behind them. */
export interface EntryEditChanges {
  meal: MealSlot;
  quantity: number;
  /** Omitted → the entry stays on its current day. */
  dateKey?: string;
  /**
   * Breakdown saves only: totals already computed for `quantity` (per-serving
   * adjusted values × quantity). Overrides the snapshot rescale, which cannot
   * know about ingredient-level changes.
   */
  nutrition?: IngredientNutrition;
  /**
   * Breakdown saves only: adjustments to persist on the entry. `null` or `[]`
   * clears any stored adjustments (and the detail tag); omitted leaves
   * whatever the entry already carries untouched.
   */
  adjustments?: IngredientAdjustment[] | null;
}

/**
 * Edits a logged entry: meal slot, quantity (macros rescale from the entry's
 * own logged snapshot via rescaleEntrySnapshot — never from the current
 * library food or recipe, which may have changed since), and optionally day.
 *
 *  - user-logged entry → rewritten in place under its original id;
 *  - seeded entry → tombstoned (seeds are rebuilt from the seed every launch,
 *    so the original id must stay dead or the pre-edit row would resurrect on
 *    relaunch) and re-added as a clone under a fresh id from `newEntryId`,
 *    leaving exactly one visible copy;
 *  - unknown id, or an id already in `removedEntryIds` (e.g. a stale edit
 *    panel for a seed that was deleted or already edited) → returns the input
 *    state unchanged (same reference), so nothing can resurrect or
 *    double-count.
 */
export function applyUpdateEntry(
  state: DiaryEntryState,
  id: string,
  changes: EntryEditChanges,
  findSeedEntry: (id: string) => MealLogEntry | undefined,
  newEntryId: () => string,
): DiaryEntryState {
  const { addedEntries, removedEntryIds } = state;
  const added = addedEntries.find(e => e.id === id);
  const source = added ?? findSeedEntry(id);
  if (!source || removedEntryIds.includes(id)) return state;
  const updated: MealLogEntry = {
    ...source,
    ...rescaleEntrySnapshot(source, changes.quantity),
    // Breakdown saves supply exact totals for the new adjustments; they win
    // over the snapshot rescale (which can only scale the OLD totals).
    ...(changes.nutrition ? changes.nutrition : {}),
    meal: changes.meal,
    dateKey: changes.dateKey ?? source.dateKey,
  };
  if (source.nutritionSnapshot) {
    const nutritionSnapshot = rescaleSnapshotSelection(
      source.nutritionSnapshot,
      changes.quantity / source.quantity,
    );
    if (nutritionSnapshot) {
      updated.nutritionSnapshot = nutritionSnapshot;
      // Quantity-only edits use the immutable source facts, not the rounded
      // legacy totals from the previous edit. Explicit nutrition adjustments
      // remain authoritative when the editor intentionally supplies them.
      if (!changes.nutrition) {
        const macros = scaledSnapshotMacros(nutritionSnapshot);
        if (macros) Object.assign(updated, macros);
      }
    }
  }
  if (changes.adjustments !== undefined) {
    if (changes.adjustments && changes.adjustments.length > 0) {
      updated.adjustments = changes.adjustments;
      updated.detail = withAdjustedTag(updated.detail);
    } else {
      delete updated.adjustments;
      updated.detail = stripAdjustedTag(updated.detail);
    }
  }
  if (added) {
    return { addedEntries: addedEntries.map(e => (e.id === id ? updated : e)), removedEntryIds };
  }
  return {
    addedEntries: [...addedEntries, { ...updated, id: newEntryId() }],
    removedEntryIds: [...removedEntryIds, id],
  };
}
