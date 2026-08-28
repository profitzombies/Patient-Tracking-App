/**
 * Floating navigation for the provider (staff) section — the Slack-style
 * bottom-right launcher that replaced the full-width tab bar.
 *
 * The button, popout card, animation, and modal-twin mechanics live in the
 * shared FabMenu (components/ui/FabMenu.tsx), which this file configures
 * with the staff destinations: the same six rows the old tab bar held
 * (same icons), the active screen marked with the small orange tick, and
 * the cobalt "AI Support" action pinned beneath the divider. The patient
 * side mounts the same shared component with its own rows — change the
 * shared file with both sides in mind; this config must keep the provider
 * menu byte-identical in look and behavior.
 *
 * Placement: the staff section has no tab bar (the FAB is its only nav
 * chrome), so the circle sits directly above the home-indicator inset.
 */
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FabMenu, type FabMenuItem } from '@/components/ui/FabMenu';

const DESTINATIONS: FabMenuItem[] = [
  { key: 'overview', label: 'Overview', icon: 'home', href: '/' },
  { key: 'patients', label: 'Patients', icon: 'users', href: '/patients' },
  { key: 'outcomes', label: 'Outcomes', icon: 'bar-chart-2', href: '/outcomes' },
  { key: 'leaderboard', label: 'Leaderboard', icon: 'award', href: '/leaderboard' },
  { key: 'subscriptions', label: 'Subscriptions', icon: 'package', href: '/subscriptions' },
  { key: 'training', label: 'Training', icon: 'book-open', href: '/training' },
];

export function ProviderFabMenu() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <FabMenu
      config={{
        fabTestID: 'provider-fab',
        menuTestID: 'provider-menu',
        sectionLabel: 'NAVIGATE',
        openA11yLabel: 'Open navigation menu',
        closeA11yLabel: 'Close navigation menu',
        bottom: Math.max(insets.bottom, 14) + 14,
        items: DESTINATIONS,
        primary: {
          testID: 'provider-menu-support',
          label: 'AI Support',
          a11yLabel: 'Open AI Support',
          icon: 'message-circle',
          onSelect: () => router.push('/support-chat'),
        },
      }}
    />
  );
}
