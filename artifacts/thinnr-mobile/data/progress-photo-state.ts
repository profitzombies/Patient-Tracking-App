/**
 * Pure state transitions behind Progress-photo removal and its Undo, plus
 * the derived display labels that keep same-label photos apart.
 *
 * Kept free of React so the remove/restore invariants (only the patient's
 * own photos are removable, exact same-id restores at the captured
 * position, no duplicates on repeated calls) can be exercised directly by
 * scripts/verify-photo-remove.ts as a regression check — the same pattern
 * as data/custom-food-state.ts.
 *
 * Model: only user-added photos live in the persisted `photos` array, so
 * a removal simply filters the persisted array. On web each user photo's
 * uri is a base64 data URI stored inside the persisted blob, so dropping
 * the row is what actually frees browser storage — the Undo snapshot lives
 * only in component state and lapses with the undo window.
 */
import type { ProgressPhoto } from './patient-data';

/** Everything needed to undo a photo removal, captured pre-removal. */
export interface RemovedProgressPhoto {
  /** Exact photo snapshot (including the image uri), restored under its original id. */
  photo: ProgressPhoto;
  /** Position in the persisted user-photo list, so ordering round-trips. */
  index: number;
}

/**
 * Snapshots a user-added photo ahead of a removal. Returns null when the id
 * isn't a removable photo — an unknown id, or the second tap
 * of a double-tapped remove — since there is nothing to undo then.
 */
export function captureRemovedPhoto(photos: ProgressPhoto[], id: string): RemovedProgressPhoto | null {
  const index = photos.findIndex(p => p.id === id && p.source === 'user');
  if (index === -1) return null;
  return { photo: photos[index]!, index };
}

/**
 * Removes a user-added photo. Returns the input list unchanged (same
 * reference) when the id isn't a removable user photo, so callers can skip
 * a redundant persist. The source guard keeps any non-user row safe.
 */
export function applyRemovePhoto(photos: ProgressPhoto[], id: string): ProgressPhoto[] {
  if (!photos.some(p => p.id === id && p.source === 'user')) return photos;
  return photos.filter(p => p.id !== id);
}

/**
 * Undoes a photo removal: re-inserts the exact snapshot at its old position
 * (clamped to the current list bounds). Returns the input list unchanged
 * (same reference) when a photo with the same id is already present — a
 * double-tapped Undo, or an Undo somehow arriving before its removal, must
 * never insert a duplicate.
 */
export function applyRestorePhoto(photos: ProgressPhoto[], removed: RemovedProgressPhoto): ProgressPhoto[] {
  if (photos.some(p => p.id === removed.photo.id)) return photos;
  const at = Math.max(0, Math.min(removed.index, photos.length));
  return [...photos.slice(0, at), removed.photo, ...photos.slice(at)];
}

/**
 * Display labels for the photo grid, de-duplicated in list order: two
 * photos added the same day both persist the same "Week N" label, so the
 * second and later occurrences of any label gain a counter — "Week 12",
 * "Week 12 (2)", "Week 12 (3)". Derived at render time (nothing persisted
 * changes), so removing a duplicate heals the numbering on its own.
 */
export function photoDisplayLabels(photos: readonly ProgressPhoto[]): Map<string, string> {
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const photo of photos) {
    const n = (seen.get(photo.label) ?? 0) + 1;
    seen.set(photo.label, n);
    labels.set(photo.id, n > 1 ? `${photo.label} (${n})` : photo.label);
  }
  return labels;
}
