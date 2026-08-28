/** Node stand-in for expo-blur: the classic tab bar's iOS backdrop. */
import React from 'react';

export function BlurView(
  props: Record<string, unknown> & { children?: React.ReactNode },
): React.ReactElement {
  const { children, ...rest } = props;
  return React.createElement('BlurView', rest, children);
}
