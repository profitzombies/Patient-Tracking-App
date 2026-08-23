/**
 * Node stand-in for react-native-keyboard-controller (see
 * tsconfig.onboarding-hints.json `paths`). Platform.OS is pinned to 'web' so
 * these never actually render — they exist so the imports resolve.
 */
import React from 'react';

export function KeyboardStickyView({ children }: { children?: React.ReactNode }) {
  return React.createElement('KeyboardStickyView', null, children);
}

export function KeyboardAwareScrollView({
  children,
  ...props
}: {
  children?: React.ReactNode;
  [key: string]: unknown;
}) {
  return React.createElement('KeyboardAwareScrollView', props, children);
}
