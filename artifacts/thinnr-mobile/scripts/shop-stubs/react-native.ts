/**
 * react-native stand-in for the shop suites: the leaderboard slice (host
 * components, Platform 'web', useWindowDimensions) plus Switch, which the
 * checkout screen renders for "save this card".
 */
import React from 'react';

export * from '../leaderboard-stubs/react-native';

export function Switch(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('Switch', props);
}
