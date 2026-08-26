/**
 * One-shot handoff of a just-logged batch from the "Yesterday's [meal]"
 * review to whichever screen the patient lands back on (Diary or Today).
 * The review commits its batch in one action, parks the created entries
 * here, and dismisses; the destination screen takes the notice on focus and
 * arms its Undo snackbar with exactly that batch — the same
 * remove-precisely-these-ids semantics as the diary's copy Undo.
 *
 * Module-level on purpose: the notice must survive the review screen
 * unmounting, but has no reason to persist — an un-taken notice simply
 * expires with the session.
 */
import type { MealLogEntry, MealSlot } from '@/data/patient-data';

export interface PendingLogNotice {
  /** Exactly the entries the review's confirm committed (fresh ids). */
  entries: MealLogEntry[];
  /** Slot the batch landed in — for the snackbar message. */
  meal: MealSlot;
  /** Day the batch landed on. */
  dateKey: string;
}

let pending: PendingLogNotice | null = null;

export function setPendingLogNotice(notice: PendingLogNotice): void {
  pending = notice;
}

/** Returns and clears the parked notice — one screen shows it, once. */
export function takePendingLogNotice(): PendingLogNotice | null {
  const taken = pending;
  pending = null;
  return taken;
}
