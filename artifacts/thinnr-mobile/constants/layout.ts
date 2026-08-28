/**
 * Patient-side floating-surface shelf.
 *
 * Patients keep a visible tab bar (unlike staff, whose corner launcher
 * replaced theirs), so everything that floats near the bottom of a patient
 * screen stacks on one shared shelf above it:
 *
 *   tab bar allowance → corner quick-actions launcher → snackbar
 *
 * Keeping the math here (instead of per-surface literals) is what makes
 * the stacking safe: the snackbar's action button ("UNDO") sits exactly in
 * the bottom-right corner the launcher occupies, so the snackbar MUST
 * clear the circle — Material's snackbar-over-FAB rule — or the button
 * becomes untappable while a notice is up.
 */
import { Platform } from 'react-native';
import { FAB_SIZE } from '@/components/ui/FabMenu';

/**
 * Bottom allowance that clears the patient tab bar. The web preview pins
 * the classic bar at a fixed 84 (see app/(patient)/_layout.tsx); native
 * bars add the home-indicator inset, and the same 84 covers both the
 * classic bar and the iOS 26 liquid-glass tabs with breathing room.
 */
export function patientTabBarAllowance(insetsBottom: number): number {
  return Platform.OS === 'web' ? 84 : insetsBottom + 84;
}

/** Gap between the tab-bar allowance and the launcher circle — the same 14
 *  the staff circle keeps above its own anchor. */
const PATIENT_FAB_GAP = 14;

/**
 * Bottom offset of the patient corner quick-actions launcher: just above
 * the tab bar, per the shared-corner design (staff has no tab bar, which
 * is why theirs sits lower).
 */
export function patientFabBottom(insetsBottom: number): number {
  return patientTabBarAllowance(insetsBottom) + PATIENT_FAB_GAP;
}

/**
 * Bottom offset for patient snackbars: above the launcher circle with the
 * snackbar's usual 12 gap, so its corner action button always stays
 * tappable.
 */
export function patientSnackbarBottom(insetsBottom: number): number {
  return patientFabBottom(insetsBottom) + FAB_SIZE + 12;
}
