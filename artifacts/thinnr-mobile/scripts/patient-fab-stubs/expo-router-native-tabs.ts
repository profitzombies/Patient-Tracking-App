/**
 * Node stand-in for expo-router/unstable-native-tabs (the iOS 26 liquid
 * glass variant). The glass-effect stub reports unavailable, so these only
 * need to exist for the import graph — they still render as host elements
 * in case a scenario ever flips the branch.
 */
import React from 'react';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function host(name: string) {
  function Host(props: AnyProps): React.ReactElement {
    const { children, ...rest } = props;
    return React.createElement(name, rest, children);
  }
  Host.displayName = name;
  return Host;
}

const NativeTabsImpl = host('NativeTabs');

export const NativeTabs = Object.assign(NativeTabsImpl, {
  Trigger: host('NativeTabsTrigger'),
});

export const Icon = host('NativeTabsIcon');
export const Label = host('NativeTabsLabel');
