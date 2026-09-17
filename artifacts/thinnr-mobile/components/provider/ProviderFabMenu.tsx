/**
 * Floating navigation for the provider (staff) section — the Slack-style
 * bottom-right launcher that replaced the full-width tab bar.
 *
 * A round navy button floats in the bottom-right corner of every staff
 * screen and never leaves it. Tapping it pops out a Heritage menu card with
 * one row per destination (the same six the old tab bar held, same icons),
 * the active screen marked with the small orange tick the tabs used, and a
 * prominent cobalt "AI Support" action pinned full-width beneath a divider
 * — the staff-side AI chat lives outside the six rows the way Slack's
 * primary action does.
 *
 * All rendering, animation, and interaction live in the shared FabMenu
 * (components/ui/FabMenu) — the patient side mounts the exact same
 * component with its own rows, so the two corners can never drift apart.
 * This file is only the provider CONFIG: the six destinations, the AI
 * Support primary, and the staff-side corner anchor (staff has no tab bar,
 * so the circle hugs the home-indicator inset).
 */
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { type Href } from 'expo-router';
import { FabMenu, type FabMenuItem } from '@/components/ui/FabMenu';

const DESTINATIONS: {
  key: string;
  label: string;
  icon: keyof typeof Feather.glyphMap;
  href: Href;
}[] = [
  { key: 'overview', label: 'Overview', icon: 'home', href: '/' },
  { key: 'patients', label: 'Patients', icon: 'users', href: '/patients' },
  { key: 'outcomes', label: 'Outcomes', icon: 'bar-chart-2', href: '/outcomes' },
  { key: 'leaderboard', label: 'Leaderboard', icon: 'award', href: '/leaderboard' },
  { key: 'payments', label: 'Payments', icon: 'credit-card', href: '/payments' },
  { key: 'training', label: 'Training', icon: 'book-open', href: '/training' },
];

const ITEMS: FabMenuItem[] = DESTINATIONS.map((destination) => ({
  key: destination.key,
  label: destination.label,
  icon: { family: 'feather', name: destination.icon },
  action: { kind: 'navigate', href: destination.href },
}));

export function ProviderFabMenu() {
  const insets = useSafeAreaInsets();
  // No staff tab bar: the circle clears the home indicator (or 14 where
  // there is none) plus a 14 gap — the resting spot the menu raises above.
  const fabBottom = Math.max(insets.bottom, 14) + 14;

  return (
    <FabMenu
      idPrefix="provider"
      openAccessibilityLabel="Open navigation menu"
      closeAccessibilityLabel="Close navigation menu"
      sections={[{ key: 'navigate', label: 'NAVIGATE', items: ITEMS }]}
      primaryAction={{
        key: 'support',
        label: 'AI Support',
        icon: 'message-circle',
        accessibilityLabel: 'Open AI Support',
        action: { kind: 'push', href: '/support-chat' },
      }}
      fabBottom={fabBottom}
    />
  );
}
