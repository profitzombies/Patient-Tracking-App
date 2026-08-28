/**
 * Node stand-in for react-native for the guided-photos suite: the
 * meal-photo stub already layers everything this suite renders (host
 * components, mutable Platform.OS, captured announcements,
 * ActivityIndicator, counted Linking.openSettings) on top of the shared
 * onboarding-gate base. Locally added on top:
 *  - AccessibilityInfo with a scriptable screen-reader flag (the spoken
 *    line-up cues go quiet while a screen reader runs);
 *  - a minimal Animated/Easing pair for the level bar's continuous
 *    indicator (timing() applies the target value synchronously).
 */
import React from 'react';

import { announcements } from '../meal-photo-stubs/react-native';

export * from '../meal-photo-stubs/react-native';

/** Scriptable screen-reader state for the extended AccessibilityInfo. */
export const screenReaderState = {
  enabled: false,
  listeners: new Set<(value: boolean) => void>(),
  set(value: boolean): void {
    screenReaderState.enabled = value;
    for (const listener of [...screenReaderState.listeners]) listener(value);
  },
  reset(): void {
    screenReaderState.enabled = false;
    screenReaderState.listeners.clear();
  },
};

export const AccessibilityInfo = {
  announceForAccessibility(message: string): void {
    announcements.push(message);
  },
  async isScreenReaderEnabled(): Promise<boolean> {
    return screenReaderState.enabled;
  },
  addEventListener(
    _event: string,
    handler: (value: boolean) => void,
  ): { remove(): void } {
    screenReaderState.listeners.add(handler);
    return { remove: () => void screenReaderState.listeners.delete(handler) };
  },
};

/**
 * Fixed iPhone-reference window — the full-screen photo viewer sizes its
 * pages from this, so a page is exactly one "screen" wide under Node too.
 */
export function useWindowDimensions(): {
  width: number;
  height: number;
  scale: number;
  fontScale: number;
} {
  return { width: 393, height: 852, scale: 3, fontScale: 1 };
}

export class AnimatedValueStub {
  constructor(public value: number) {}
  setValue(next: number): void {
    this.value = next;
  }
  interpolate(config: {
    inputRange: number[];
    outputRange: Array<number | string>;
    extrapolate?: 'clamp' | 'extend' | 'identity';
  }): { config: unknown } {
    return { config };
  }
}

function animatedHost(name: string) {
  function Host(props: Record<string, unknown> & { children?: React.ReactNode }) {
    const { children, ...rest } = props;
    return React.createElement(name, rest, children);
  }
  Host.displayName = name;
  return Host;
}

export const Animated = {
  Value: AnimatedValueStub,
  View: animatedHost('AnimatedView'),
  timing(
    value: AnimatedValueStub,
    config: {
      toValue: number;
      duration?: number;
      easing?: (t: number) => number;
      useNativeDriver?: boolean;
    },
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
  quad: (t: number) => t * t,
  out:
    (fn: (t: number) => number) =>
    (t: number) =>
      1 - fn(1 - t),
};
