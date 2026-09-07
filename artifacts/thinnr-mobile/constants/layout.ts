/**
 * Patient-side floating-surface shelf.
 *
 * Patients navigate from a floating pill bar in the bottom gutter (the
 * staff side replaced its bar with the corner launcher outright). The bar
 * and the launcher circle share ONE row — pill on the left, circle on the
 * right, vertically centered on each other — and everything else that
 * floats near the bottom of a patient screen stacks above that row:
 *
 *   floating row (pill bar + launcher) → snackbar
 *
 * Keeping the math here (instead of per-surface literals) is what makes
 * the stacking safe: the snackbar's action button ("UNDO") sits exactly in
 * the bottom-right corner the launcher occupies, so the snackbar MUST
 * clear the circle — Material's snackbar-over-FAB rule — or the button
 * becomes untappable while a notice is up. Scrollable screens pad their
 * content by the same shelf so the last row never hides under the row.
 */
import { Platform } from 'react-native';
import { FAB_RIGHT, FAB_SIZE } from '@/components/ui/FabMenu';

/** Height of the floating pill bar (taller than the circle it sits beside). */
export const PATIENT_BAR_HEIGHT = 60;

/** Side gutter the pill bar keeps, matching the launcher's corner offset. */
export const PATIENT_BAR_SIDE = FAB_RIGHT;

/** Breathing room between the pill bar's right edge and the circle. */
const PATIENT_BAR_FAB_GAP = 12;

/**
 * Distance from the canvas bottom edge to the floating row's bottom edge.
 * The web preview draws on the fixed iPhone canvas with no home indicator
 * to clear, so it keeps a flat gutter; devices add their own inset.
 */
export function patientBarBottom(insetsBottom: number): number {
  return Platform.OS === 'web' ? 18 : insetsBottom + 6;
}

/**
 * Right inset of the pill bar: the launcher's corner offset plus the
 * circle plus their gap, so the bar stops short of the circle instead of
 * running under it.
 */
export function patientBarRightInset(): number {
  return FAB_RIGHT + FAB_SIZE + PATIENT_BAR_FAB_GAP;
}

/**
 * Bottom offset of the patient corner launcher: centered on the pill bar
 * beside it, so the circle and the bar read as one floating row (staff
 * have no bar, which is why theirs hugs the corner instead).
 */
export function patientFabBottom(insetsBottom: number): number {
  return patientBarBottom(insetsBottom) + (PATIENT_BAR_HEIGHT - FAB_SIZE) / 2;
}

/**
 * Bottom padding for scrollable patient screens: clears the whole floating
 * row plus the usual 20 of breathing room.
 */
export function patientContentBottom(insetsBottom: number): number {
  return patientBarBottom(insetsBottom) + PATIENT_BAR_HEIGHT + 20;
}

/** Height of the sync status chip that floats above the pill bar. */
export const PATIENT_SYNC_CHIP_HEIGHT = 30;

/** Gap between the pill bar's top edge and the sync chip. */
const PATIENT_SYNC_CHIP_GAP = 8;

/**
 * Bottom offset of the sync status chip (offline / syncing / needs
 * attention): directly above the pill bar, left-aligned with it, and
 * clear of the launcher circle on the right. It only mounts for real
 * accounts with something to say, so it takes no permanent room from the
 * content shelf.
 */
export function patientSyncChipBottom(insetsBottom: number): number {
  return patientBarBottom(insetsBottom) + PATIENT_BAR_HEIGHT + PATIENT_SYNC_CHIP_GAP;
}

/**
 * Bottom offset for patient snackbars: above the floating row with the
 * snackbar's usual 12 gap, so its corner action button always stays
 * tappable. When the sync chip is up the snackbar clears it too.
 */
export function patientSnackbarBottom(insetsBottom: number, syncChipVisible = false): number {
  const base = patientBarBottom(insetsBottom) + PATIENT_BAR_HEIGHT + 12;
  return syncChipVisible ? base + PATIENT_SYNC_CHIP_HEIGHT + PATIENT_SYNC_CHIP_GAP : base;
}

/**
 * Top padding for a full-screen surface (a sheet, a viewer): the reported
 * safe-area inset, floored per platform. A surface presented over the
 * camera — or inside a modal — can be handed a ZERO top inset, which would
 * drop its header level with the clock / Dynamic Island.
 */
export function screenTopPad(insetsTop: number): number {
  if (Platform.OS === 'ios') return Math.max(insetsTop, 44);
  if (Platform.OS === 'android') return Math.max(insetsTop, 24);
  return Math.max(insetsTop, 14);
}

/**
 * Top padding for controls that FLOAT over a full-screen surface (a close
 * X over a camera preview or a photo). Same floor, plus clearance for the
 * system's top-edge gesture strip: a control inside that strip swallows
 * taps into the OS, and the patient cannot leave the screen.
 */
export function overlayTopPad(insetsTop: number): number {
  return screenTopPad(insetsTop) + (Platform.OS === 'web' ? 0 : 10);
}
