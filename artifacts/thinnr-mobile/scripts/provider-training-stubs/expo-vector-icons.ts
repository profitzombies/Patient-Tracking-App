/**
 * Node stand-in for @expo/vector-icons used by the provider-training suite
 * (see tsconfig.provider-training.json `paths`). Icons render as inert host
 * elements; the suite can find them by their `name` prop (e.g. the outline's
 * lock glyphs).
 */
import React from 'react';

interface IconProps {
  name: string;
  size?: number;
  color?: string;
}

export function Feather(props: IconProps) {
  return React.createElement('Icon', props);
}

export function MaterialCommunityIcons(props: IconProps) {
  return React.createElement('Icon', props);
}
