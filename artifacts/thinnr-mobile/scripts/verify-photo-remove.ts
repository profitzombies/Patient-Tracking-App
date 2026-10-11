/**
 * Progress-photo remove/undo invariants check.
 *
 * Exercises the pure state transitions behind the Progress tab's photo
 * removal → Undo flow (data/progress-photo-state.ts) so a refactor can never
 * reintroduce the failure modes that matter:
 *   1. a seed photo becoming removable (only user-added photos may go),
 *   2. a restore that loses the photo's id, uri, or position (the capture
 *      must happen before the removal drops the only persisted copy of the
 *      image data),
 *   3. a restore that duplicates the photo (double-tapped Undo, or an Undo
 *      racing other changes),
 *   4. same-label display captions colliding ("Week 12" twice) instead of
 *      numbering in list order — and the numbering not healing after one of
 *      the duplicates is removed.
 * Covers immediate undo, repeated (double-tap) removes and undos, undo after
 * the list changed during the window, and the derived display labels.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:photo-remove
 */
import {
  applyRemovePhoto,
  applyRestorePhoto,
  captureRemovedPhoto,
  photoDisplayLabels,
} from '../data/progress-photo-state';
import type { ProgressPhoto } from '../data/patient-data';

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

const userPhoto = (id: string, dateKey: string, label: string): ProgressPhoto => ({
  id,
  dateKey,
  label,
  source: 'user',
  uri: `data:image/jpeg;base64,${id.toUpperCase()}`,
});

// Persisted list = user-added photos only (seeds are rebuilt from the seed
// data each launch and never enter this array). Three photos; the middle two
// were added the same day and share a label.
const photoA = userPhoto('photo_a', '2026-08-09', 'Week 11');
const photoB = userPhoto('photo_b', '2026-08-16', 'Week 12');
const photoC = userPhoto('photo_c', '2026-08-16', 'Week 12');

const base: ProgressPhoto[] = [photoA, photoB, photoC];

const snapshot = (photos: ProgressPhoto[]) => JSON.stringify(photos);
const baseSnapshot = snapshot(base);

const ids = (photos: ProgressPhoto[]) => photos.map(p => p.id).join(',');

// ── 1. Capture happens pre-removal and keeps the exact snapshot ─────────────
{
  const removed = captureRemovedPhoto(base, 'photo_b')!;
  assert('capture finds the photo', removed !== null);
  assert('capture keeps the exact snapshot (id, uri, label, date)', JSON.stringify(removed.photo) === JSON.stringify(photoB));
  assert('capture records the list position', removed.index === 1);
  assert('capture of an unknown id returns null', captureRemovedPhoto(base, 'photo_ghost') === null);
}

// ── 2. Only the patient's own photos are removable ───────────────────────────
{
  // An id outside the persisted list is never removable…
  assert('capture of a foreign id returns null', captureRemovedPhoto(base, 'photo_week2') === null);
  assert('removing a foreign id is a no-op (same reference)', applyRemovePhoto(base, 'photo_week2') === base);

  // …and a row whose source isn't the patient is guarded by source.
  const foreignRow = { id: 'photo_foreign', dateKey: '2026-07-01', label: 'Week 4', source: 'office' } as unknown as ProgressPhoto;
  const withForeign = [foreignRow, ...base];
  assert('capture skips a non-user-source row', captureRemovedPhoto(withForeign, 'photo_foreign') === null);
  assert('removal skips a non-user-source row (same reference)', applyRemovePhoto(withForeign, 'photo_foreign') === withForeign);
}

// ── 3. Remove drops exactly the target ───────────────────────────────────────
{
  const afterRemove = applyRemovePhoto(base, 'photo_b');
  assert('removal drops the photo', !afterRemove.some(p => p.id === 'photo_b'));
  assert('removal keeps the other photos in order', ids(afterRemove) === 'photo_a,photo_c');
}

// ── 4. Remove → restore round-trips the list exactly ────────────────────────
{
  const removed = captureRemovedPhoto(base, 'photo_b')!;
  const afterRemove = applyRemovePhoto(base, 'photo_b');
  const afterRestore = applyRestorePhoto(afterRemove, removed);
  assert('restore round-trips ids, uris, and order', snapshot(afterRestore) === baseSnapshot);
}

// ── 5. Repeated / out-of-order calls can never duplicate ────────────────────
{
  const removed = captureRemovedPhoto(base, 'photo_b')!;
  const afterRemove = applyRemovePhoto(base, 'photo_b');

  // Double-tapped remove: second removal is a no-op, nothing new to capture.
  assert('second removal is a no-op (same reference)', applyRemovePhoto(afterRemove, 'photo_b') === afterRemove);
  assert('capture after removal returns null', captureRemovedPhoto(afterRemove, 'photo_b') === null);

  // Double-tapped Undo: the second restore sees the photo present and no-ops.
  const restoredOnce = applyRestorePhoto(afterRemove, removed);
  const restoredTwice = applyRestorePhoto(restoredOnce, removed);
  assert('second restore is a no-op (same reference)', restoredTwice === restoredOnce);
  assert('second restore never duplicates the photo', restoredTwice.filter(p => p.id === 'photo_b').length === 1);

  // Undo arriving without a recorded removal (photo still present) no-ops.
  assert('restore with the photo still present is a no-op', applyRestorePhoto(base, removed) === base);

  // Removing an unknown id is a no-op.
  assert('removing an unknown id is a no-op', applyRemovePhoto(base, 'photo_ghost') === base);
}

// ── 6. Restore stays sane when the list changed during the window ───────────
{
  const removed = captureRemovedPhoto(base, 'photo_a')!;
  let state = applyRemovePhoto(base, 'photo_a');
  // The patient adds another photo before tapping Undo.
  state = [...state, userPhoto('photo_d', '2026-08-23', 'Week 13')];

  const afterRestore = applyRestorePhoto(state, removed);
  assert('restore re-inserts at the captured position', ids(afterRestore) === 'photo_a,photo_b,photo_c,photo_d');
  assert('restore keeps the newly added photo intact', afterRestore.some(p => p.id === 'photo_d'));

  // Captured positions beyond the current list length clamp to the end.
  const removedC = captureRemovedPhoto(base, 'photo_c')!;
  const restoredIntoEmpty = applyRestorePhoto([], removedC);
  assert('restore into a shrunken list clamps the position', ids(restoredIntoEmpty) === 'photo_c');
}

// ── 7. Display labels de-duplicate in list order and heal on removal ────────
{
  const earlierRows: ProgressPhoto[] = [
    { id: 'photo_baseline', dateKey: '2026-06-01', label: 'Baseline', source: 'user' },
    { id: 'photo_week2', dateKey: '2026-06-15', label: 'Week 2', source: 'user' },
  ];
  const merged = [...earlierRows, ...base];

  const labels = photoDisplayLabels(merged);
  assert('unique labels stay untouched', labels.get('photo_baseline') === 'Baseline' && labels.get('photo_week2') === 'Week 2' && labels.get('photo_a') === 'Week 11');
  assert('first duplicate keeps the plain label', labels.get('photo_b') === 'Week 12');
  assert('second duplicate gains a counter', labels.get('photo_c') === 'Week 12 (2)');

  // A third same-label photo keeps counting.
  const withThird = [...merged, userPhoto('photo_e', '2026-08-16', 'Week 12')];
  assert('third duplicate counts on', photoDisplayLabels(withThird).get('photo_e') === 'Week 12 (3)');

  // Removing the first duplicate heals the numbering: the survivor goes back
  // to the plain label because nothing persisted ever changed.
  const healed = photoDisplayLabels(merged.filter(p => p.id !== 'photo_b'));
  assert('numbering heals after removing a duplicate', healed.get('photo_c') === 'Week 12');
  assert('every photo gets a label entry', photoDisplayLabels(merged).size === merged.length);
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n✗ Progress-photo remove/undo invariants: ${failures} failure(s) across ${checks} checks`);
  process.exit(1);
}
console.log(`✓ Progress-photo remove/undo invariants: ${checks} checks passed`);
