import React from 'react';

export function LinearGradient(props: Record<string, unknown> & { children?: React.ReactNode }): React.ReactElement {
  const { children, ...rest } = props;
  return React.createElement('LinearGradient', rest, children);
}