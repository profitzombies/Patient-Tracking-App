/**
 * Node stand-in for react-native-keyboard-controller: the check-in screen
 * scrolls its form through KeyboardAwareScrollView; a bare host node is all
 * the suite needs.
 */
import React from 'react';

export type KeyboardAwareScrollViewProps = Record<string, unknown> & {
  children?: React.ReactNode;
};

export function KeyboardAwareScrollView(props: KeyboardAwareScrollViewProps): React.ReactElement {
  const { children, ...rest } = props;
  return React.createElement('KeyboardAwareScrollView', rest, children);
}
