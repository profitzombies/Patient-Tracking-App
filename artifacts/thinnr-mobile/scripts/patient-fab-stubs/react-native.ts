/**
 * Node stand-in for the slice of react-native the FabMenu tree renders.
 *
 * Mapped over the real package by tsconfig.patient-fab.json (`paths`) so the
 * REAL FabMenu / PatientFabMenu / ProviderFabMenu / patient tab layout can
 * run under tsx with react-test-renderer. Host components keep every prop
 * (testID, handlers, accessibility*) visible to the test tree;
 * function-valued `style` and `children` (Pressable's pressed-state API)
 * resolve with { pressed: false }. Platform.OS reports 'web' so the FAB
 * takes the web placement branch (84px pinned tab bar) and Animated skips
 * the native driver.
 */
import React from 'react';

type AnyProps = Record<string, unknown> & { children?: unknown };

function hostComponent(name: string) {
  function Host(props: AnyProps): React.ReactElement {
    const { children, style, ...rest } = props;
    const resolvedStyle = typeof style === 'function' ? style({ pressed: false }) : style;
    const resolvedChildren =
      typeof children === 'function'
        ? (children as (state: { pressed: boolean }) => React.ReactNode)({ pressed: false })
        : (children as React.ReactNode);
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

/**
 * Modal mirrors the visibility contract the suite cares about: children
 * only exist in the tree while `visible` — closing the menu must actually
 * remove the card. Props (onRequestClose etc.) stay queryable on the host.
 */
export function Modal(props: AnyProps): React.ReactElement | null {
  if (props.visible === false) return null;
  const { children, ...rest } = props;
  return React.createElement('Modal', rest, children as React.ReactNode);
}

export const StyleSheet = {
  create<T>(styles: T): T {
    return styles;
  },
  flatten(style: unknown): unknown {
    return style;
  },
  absoluteFillObject: {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  hairlineWidth: 1,
};

export const Platform = {
  OS: 'web' as string,
  select<T>(spec: Record<string, T>): T | undefined {
    return 'web' in spec ? spec.web : spec.default;
  },
};

/** Minimal Animated: values apply synchronously; timing completes at once. */
class AnimatedValue {
  __value: number;
  constructor(value: number) {
    this.__value = value;
  }
  setValue(value: number): void {
    this.__value = value;
  }
  interpolate(config: unknown): { __interpolate: unknown } {
    return { __interpolate: config };
  }
}

export const Animated = {
  Value: AnimatedValue,
  View: hostComponent('AnimatedView'),
  timing(
    value: AnimatedValue,
    config: { toValue: number },
  ): { start(callback?: (result: { finished: boolean }) => void): void } {
    return {
      start(callback) {
        value.setValue(config.toValue);
        callback?.({ finished: true });
      },
    };
  },
};

export const Easing = {
  out: <T>(fn: T): T => fn,
  cubic: (t: number): number => t,
  linear: (t: number): number => t,
};

export function useWindowDimensions(): {
  width: number;
  height: number;
  scale: number;
  fontScale: number;
} {
  return { width: 393, height: 852, scale: 1, fontScale: 1 };
}

/** Captured iOS-style announcements (unused on the 'web' platform path). */
export const announcements: string[] = [];
export const AccessibilityInfo = {
  announceForAccessibility(message: string): void {
    announcements.push(message);
  },
};

export function useColorScheme(): 'light' | 'dark' | null {
  return 'light';
}
