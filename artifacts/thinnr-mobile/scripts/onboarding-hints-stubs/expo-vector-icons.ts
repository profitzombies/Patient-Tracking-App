/**
 * Node stand-in for @expo/vector-icons (see tsconfig.onboarding-hints.json
 * `paths`). Icons render as an inert host element; the suite never asserts
 * on them.
 */
import React from 'react';

export function Feather(props: { name: string; size?: number; color?: string }) {
  return React.createElement('Icon', props);
}
