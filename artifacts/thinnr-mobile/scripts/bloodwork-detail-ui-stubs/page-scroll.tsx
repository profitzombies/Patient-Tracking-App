import React from 'react';

export function PageScrollView({ children, ...props }: Record<string, unknown>) {
  return React.createElement('ScrollView', props, children as React.ReactNode);
}