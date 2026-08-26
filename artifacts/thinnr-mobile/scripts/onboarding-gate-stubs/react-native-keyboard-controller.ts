/**
 * Node stand-in for react-native-keyboard-controller. Platform.OS is 'web'
 * in the suite, so these should never render — but passing children through
 * keeps the tree inspectable if a component ever loses its web branch.
 */
import React from 'react';

export type KeyboardAwareScrollViewProps = Record<string, unknown>;

export function KeyboardStickyView(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement('KeyboardStickyView', null, props.children);
}

export function KeyboardAwareScrollView(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement('KeyboardAwareScrollView', null, props.children);
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
