import React from 'react';

type AnyProps = Record<string, unknown> & { children?: unknown };
export type StyleProp<T> = T | StyleProp<T>[] | false | null | undefined;
export type TextStyle = Record<string, unknown>;
export type ViewStyle = Record<string, unknown>;

function hostComponent(name: string) {
  function Host(props: AnyProps): React.ReactElement {
    const { children, style, ...rest } = props;
    const resolvedStyle = typeof style === 'function' ? style({ pressed: false }) : style;
    const resolvedChildren = typeof children === 'function'
      ? (children as (state: { pressed: boolean }) => React.ReactNode)({ pressed: false })
      : children as React.ReactNode;
    return React.createElement(name, { ...rest, style: resolvedStyle }, resolvedChildren);
  }
  Host.displayName = name;
  return Host;
}

export const View = hostComponent('View');
export const Text = hostComponent('Text');
export const TextInput = hostComponent('TextInput');
export const ScrollView = hostComponent('ScrollView');
export const Pressable = hostComponent('Pressable');

export const StyleSheet = {
  create<T>(styles: T): T {
    return styles;
  },
};

export const Platform = {
  OS: 'web' as const,
  select<T>(styles: Record<string, T>): T | undefined {
    return styles.web ?? styles.default;
  },
};

export const Keyboard = {
  dismiss() {},
};