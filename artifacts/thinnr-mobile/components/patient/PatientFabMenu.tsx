/**
 * Floating quick actions for the patient section — the exact corner
 * launcher the staff side uses (one shared FabMenu implementation, see
 * components/ui/FabMenu, so the two corners can never drift), mounted once
 * on the patient tab layout and floating just above the visible tab bar
 * (staff has no tab bar, which is why theirs sits lower).
 *
 * The five rows are fast paths to screens that already exist:
 * - Log food / Scan a barcode open their modals with their own defaults
 *   (today; log-food starts on breakfast, the scanner logs to snacks —
 *   both adjustable on the screen itself).
 * - Snap a meal photo runs the same capture flow as every other meal-photo
 *   entry point, hosted HERE via useMealPhotoFlow so its confirm preview
 *   outlives the closing menu. No slot pin — the server's clock guess
 *   picks the meal, adjustable on the resulting card.
 * - Daily check-in opens the check-in modal; Progress photos switches to
 *   the Progress tab with the same active-tick/skip-when-there semantics
 *   as the staff rows.
 * Below the divider, "Message Coach" hands over to the coach chat as the
 * cobalt primary — the patient mirror of the staff side's AI Support.
 */
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FabMenu, type FabMenuItem } from '@/components/ui/FabMenu';
import { useMealPhotoFlow } from '@/components/patient/MealPhotoButton';
import { patientFabBottom } from '@/constants/layout';

export function PatientFabMenu() {
  const insets = useSafeAreaInsets();
  const mealPhoto = useMealPhotoFlow();

  const items: FabMenuItem[] = [
    {
      key: 'log-food',
      label: 'Log food',
      icon: { family: 'feather', name: 'plus' },
      action: { kind: 'push', href: '/log-food' },
    },
    {
      key: 'barcode',
      label: 'Scan a barcode',
      icon: { family: 'mci', name: 'barcode-scan' },
      action: { kind: 'push', href: '/barcode-scan' },
    },
    {
      key: 'meal-photo',
      label: 'Snap a meal photo',
      icon: { family: 'feather', name: 'camera' },
      action: { kind: 'run', run: mealPhoto.start },
    },
    {
      key: 'check-in',
      label: 'Daily check-in',
      icon: { family: 'feather', name: 'check-circle' },
      action: { kind: 'push', href: '/check-in' },
    },
    {
      key: 'progress-photos',
      label: 'Progress photos',
      icon: { family: 'feather', name: 'image' },
      action: { kind: 'navigate', href: '/progress' },
    },
  ];

  return (
    <>
      <FabMenu
        idPrefix="patient"
        openAccessibilityLabel="Open quick actions menu"
        closeAccessibilityLabel="Close quick actions menu"
        sectionLabel="QUICK ACTIONS"
        items={items}
        primaryAction={{
          key: 'coach',
          label: 'Message Coach',
          icon: 'message-circle',
          accessibilityLabel: 'Message your coach',
          action: { kind: 'push', href: '/coach-chat' },
        }}
        fabBottom={patientFabBottom(insets.bottom)}
      />
      {/* The meal-photo fallback/preview modals live beside the menu (not
          inside it): the row closes the menu first, then starts the flow,
          and these must survive that close. */}
      {mealPhoto.modals}
    </>
  );
}
