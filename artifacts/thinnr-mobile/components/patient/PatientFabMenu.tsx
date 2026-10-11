/**
 * Floating quick actions for the patient section — the exact corner
 * launcher the staff side uses (one shared FabMenu implementation, see
 * components/ui/FabMenu, so the two corners can never drift), mounted once
 * on the patient tab layout beside the floating pill bar (staff have no
 * bar at all, which is why theirs hugs the corner).
 *
 * Two groups in one card. MENU holds the destinations that did not earn a
 * permanent slot in the pill bar — Library and Plan, reference material
 * patients read now and then, and Shop (its badge is the cart count) — with
 * the same active-tick/skip-when-already-there semantics the staff rows use. QUICK ACTIONS below holds the fast
 * paths into screens that already exist:
 * - Scan a barcode opens the scanner (it logs to snacks, adjustable there).
 * - Snap a meal photo runs the same capture flow as every other meal-photo
 *   entry point, hosted HERE via useMealPhotoFlow so its confirm preview
 *   outlives the closing menu. No slot pin — the server's clock guess
 *   picks the meal, adjustable on the resulting card.
 * - Daily check-in opens the check-in modal; Progress photos switches to
 *   the Progress screen.
 * Below the divider, "Log food" is the cobalt primary: the single most
 * common thing a patient opens this menu to do, which is why the launcher
 * itself rests as a plus. (Messaging the coach used to sit here; Coach is
 * a permanent seat in the pill bar now.)
 */
import React from 'react';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FabMenu, type FabMenuSection } from '@/components/ui/FabMenu';
import { useMealPhotoFlow } from '@/components/patient/MealPhotoButton';
import { patientFabBottom } from '@/constants/layout';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { useCareTeamCanCompose, useCareTeamUnreadCount } from '@/context/CareTeamUnreadContext';
import { useCartCount } from '@/context/CartContext';

export function PatientFabMenu() {
  const insets = useSafeAreaInsets();
  const mealPhoto = useMealPhotoFlow();
  const { account } = usePatientAccount();
  const careTeamUnreadCount = useCareTeamUnreadCount();
  // A thread the office is not reading invites no new message; the history
  // behind it stays one tap away.
  const careTeamCanCompose = useCareTeamCanCompose();
  const cartCount = useCartCount();

  const sections: FabMenuSection[] = [
    {
      key: 'destinations',
      label: 'MENU',
      items: [
        {
          key: 'library',
          label: 'Library',
          icon: { family: 'feather', name: 'grid' },
          action: { kind: 'navigate', href: '/recipes' },
        },
        {
          key: 'plan',
          label: 'Plan',
          icon: { family: 'feather', name: 'clipboard' },
          action: { kind: 'navigate', href: '/plan' },
        },
        // The in-app shop: the badge is the cart's item count. Pushed (not
        // navigate) so Back returns to whatever tab the patient was on.
        {
          key: 'shop',
          label: 'Shop',
          icon: { family: 'feather', name: 'shopping-bag' },
          unreadCount: cartCount,
          badgeLabel: count => `${count} item${count === 1 ? '' : 's'} in your cart`,
          action: { kind: 'push', href: '/shop' as Href },
        },
        // Real accounts manage their profile here. Unresolved accounts
        // (still hydrating) get no row rather than a screen that bounces.
        ...(account.kind !== 'unresolved'
          ? [
              {
                key: 'account',
                label: 'Account & settings',
                icon: { family: 'feather' as const, name: 'user' as const },
                action: {
                  kind: 'run' as const,
                  run: () => router.push('/account' as Href),
                },
              },
            ]
          : []),
      ],
    },
    {
      key: 'quick-actions',
      label: 'QUICK ACTIONS',
      items: [
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
          key: 'care-team-chat',
          label: careTeamCanCompose ? 'Message My Care Team' : 'My Care Team',
          icon: { family: 'feather', name: 'message-square' },
          unreadCount: careTeamUnreadCount,
          action: { kind: 'push', href: '/care-team-chat' as Href },
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
      ],
    },
  ];

  return (
    <>
      <FabMenu
        idPrefix="patient"
        restingIcon="plus"
        openAccessibilityLabel="Open menu and quick actions"
        closeAccessibilityLabel="Close menu and quick actions"
        sections={sections}
        primaryAction={{
          key: 'log-food',
          label: 'Log food',
          icon: 'plus',
          accessibilityLabel: 'Log food',
          action: { kind: 'push', href: '/log-food' },
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
