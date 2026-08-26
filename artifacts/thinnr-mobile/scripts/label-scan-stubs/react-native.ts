/**
 * Node stand-in for react-native for the label-scan suite: the shared
 * onboarding-gate stub (host components, Platform 'web', captured iOS
 * announcements) plus the ActivityIndicator the scan card's progress states
 * render.
 */
import React from 'react';

export * from '../onboarding-gate-stubs/react-native';

export function ActivityIndicator(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('ActivityIndicator', props);
}
