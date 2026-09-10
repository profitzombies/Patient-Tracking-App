import React from 'react';

type HostProps = Record<string, unknown> & { children?: React.ReactNode };

function host(name: string) {
  return function Host({ children, ...props }: HostProps) {
    return React.createElement(name, props, children);
  };
}

export const View = host('View');
export const Text = host('Text');
export const Pressable = host('Pressable');
export const ActivityIndicator = host('ActivityIndicator');
export const ScrollView = host('ScrollView');
export const Image = host('Image');
export const TextInput = host('TextInput');
export const Alert = { alert() {} };

export const Platform = { OS: 'ios' as const };
export const StyleSheet = {
  create<T>(styles: T): T { return styles; },
  flatten(style: unknown): unknown { return style; },
  hairlineWidth: 1,
  absoluteFill: {},
};