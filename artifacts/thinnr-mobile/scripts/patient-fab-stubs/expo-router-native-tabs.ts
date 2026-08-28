/**
 * Node stand-in for expo-router/unstable-native-tabs. The suite forces the
 * classic layout (liquid glass unavailable), so these only need to resolve
 * as importable components.
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

function NativeTabsComponent(props: AnyProps): React.ReactElement {
  const { children, ...rest } = props;
  return React.createElement('NativeTabs', rest, children);
}

NativeTabsComponent.Trigger = host('NativeTabsTrigger');

export const NativeTabs = NativeTabsComponent;
export const Icon = host('NativeTabsIcon');
export const Label = host('NativeTabsLabel');
