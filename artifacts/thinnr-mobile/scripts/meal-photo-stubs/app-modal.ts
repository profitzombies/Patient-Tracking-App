/**
 * Node stand-in for @/components/ui/AppModal (which wraps react-native's
 * Modal in the WebFitShell canvas — both meaningless under Node). Mirrors
 * the one Modal semantic the suite depends on: children render ONLY while
 * `visible`, so testID presence tracks modal state.
 */
import React from 'react';

export function AppModal(
  props: { visible?: boolean; children?: React.ReactNode } & Record<string, unknown>,
): React.ReactElement | null {
  if (!props.visible) return null;
  const { children, ...rest } = props;
  return React.createElement('AppModal', rest, children as React.ReactNode);
}
