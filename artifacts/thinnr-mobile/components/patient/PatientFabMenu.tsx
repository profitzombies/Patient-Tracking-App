/**
 * Floating quick-actions menu for the patient section — the same corner
 * button and popout card as the provider side (shared FabMenu), filled with
 * patient shortcuts instead of staff destinations.
 *
 * Rows open the existing action screens with their own sensible defaults —
 * no new features, just fast access:
 *   - Log food / Scan a barcode: the root modals, which self-default to
 *     today + breakfast when pushed without params.
 *   - Snap a meal photo: the coach chat with `camera=1`, which auto-runs
 *     the chat's own camera flow once on arrival (app/coach-chat.tsx owns
 *     the module-promise handoff, so the capture lands in the conversation).
 *   - Daily check-in: the check-in modal.
 *   - Progress photos: arms the guided-session handoff exactly like the
 *     Progress tab's button, then opens the session (the session saves
 *     through PatientContext itself; the outcome notice is a Progress-tab
 *     nicety we intentionally skip here).
 *   - Message Coach (cobalt, beneath the divider): the coach chat.
 *
 * Placement: patients keep their visible tab bar, so the circle floats just
 * above it — unlike the provider side, whose bar is hidden. The clearance
 * mirrors the bar's real envelope per platform: the web bar is pinned to
 * exactly 84px in app/(patient)/_layout.tsx; native bars (classic and the
 * iOS 26 liquid-glass NativeTabs) occupy react-navigation's 49pt standard
 * height plus the home-indicator inset.
 */
import React from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { FabMenu, type FabMenuItem } from '@/components/ui/FabMenu';
import { createGuidedPhotoRequest } from '@/lib/guided-photos';

/** The web tab bar's pinned height (see tabBarStyle in the patient layout). */
const WEB_TAB_BAR_HEIGHT = 84;
/** react-navigation's standard bottom-tab-bar height on native. */
const NATIVE_TAB_BAR_HEIGHT = 49;
/** Same visual gap the provider FAB keeps above its bottom anchor. */
const GAP_ABOVE_BAR = 14;

/**
 * Distance from the screen's bottom edge to the FAB circle. Exported for
 * the verification suite, which pins these numbers per platform.
 */
export function patientFabBottom(platform: string, insetBottom: number): number {
  const barHeight =
    platform === 'web' ? WEB_TAB_BAR_HEIGHT : NATIVE_TAB_BAR_HEIGHT + insetBottom;
  return barHeight + GAP_ABOVE_BAR;
}

const QUICK_ACTIONS: FabMenuItem[] = [
  { key: 'log-food', label: 'Log food', icon: 'plus-circle', href: '/log-food', method: 'push' },
  {
    // The exact glyph patients already see on the diary's scan chip
    // (Feather has no barcode).
    key: 'barcode',
    label: 'Scan a barcode',
    iconSet: 'material-community',
    icon: 'barcode-scan',
    href: '/barcode-scan',
    method: 'push',
  },
  {
    key: 'meal-photo',
    label: 'Snap a meal photo',
    icon: 'camera',
    onSelect: () => router.push({ pathname: '/coach-chat', params: { camera: '1' } }),
  },
  { key: 'check-in', label: 'Daily check-in', icon: 'check-circle', href: '/check-in', method: 'push' },
  {
    key: 'progress-photos',
    label: 'Progress photos',
    icon: 'image',
    onSelect: () => {
      // Arm the session handoff first, exactly like the Progress tab's
      // entry point — /guided-photos only makes sense while a request is
      // held. The outcome (saved count) is deliberately dropped: the
      // session itself saves the photos; only the Progress tab shows a
      // snackbar for it.
      void createGuidedPhotoRequest();
      router.push('/guided-photos');
    },
  },
];

export function PatientFabMenu() {
  const insets = useSafeAreaInsets();

  return (
    <FabMenu
      config={{
        fabTestID: 'patient-fab',
        menuTestID: 'patient-menu',
        sectionLabel: 'QUICK ACTIONS',
        openA11yLabel: 'Open quick actions menu',
        closeA11yLabel: 'Close quick actions menu',
        bottom: patientFabBottom(Platform.OS, insets.bottom),
        items: QUICK_ACTIONS,
        primary: {
          testID: 'patient-menu-coach',
          label: 'Message Coach',
          a11yLabel: 'Message your coach',
          icon: 'message-circle',
          onSelect: () => router.push('/coach-chat'),
        },
      }}
    />
  );
}
