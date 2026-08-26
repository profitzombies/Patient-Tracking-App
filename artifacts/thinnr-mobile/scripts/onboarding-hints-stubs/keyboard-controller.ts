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

/** Platform.OS is 'web' in suites, so listeners are never attached; the
 * export only has to exist so destructured imports resolve. */
export const KeyboardEvents = {
  addListener(
    _event: string,
    _handler: (payload: { height: number; duration: number }) => void,
  ) {
    return { remove() {} };
  },
};
