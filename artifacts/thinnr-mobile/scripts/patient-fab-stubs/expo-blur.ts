/** Node stand-in for expo-blur. */
import React from 'react';

export function BlurView(props: Record<string, unknown>): React.ReactElement {
  const { children, ...rest } = props;
  return React.createElement('BlurView', rest, children as React.ReactNode);
}
