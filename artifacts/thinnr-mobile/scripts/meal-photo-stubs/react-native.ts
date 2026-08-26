/**
 * Node stand-in for react-native for the meal-photo suite: the shared
 * onboarding-gate stub (host components, mutable Platform.OS, captured iOS
 * announcements) plus the pieces the camera surface and photo modals also
 * render — ActivityIndicator, and a Linking whose openSettings calls are
 * counted (the camera fallback's Settings link).
 */
import React from 'react';

export * from '../onboarding-gate-stubs/react-native';

export function ActivityIndicator(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('ActivityIndicator', props);
}

/** Count of Linking.openSettings() calls. */
export const openSettingsCalls = { count: 0 };

export const Linking = {
  async openSettings(): Promise<void> {
    openSettingsCalls.count += 1;
  },
};
