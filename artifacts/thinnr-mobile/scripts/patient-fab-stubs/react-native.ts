/**
 * Node stand-in for react-native for the patient-fab suite: the shared
 * onboarding-gate stub (host components, mutable Platform.OS, captured iOS
 * announcements) plus the pieces the corner launcher and its hosted
 * meal-photo flow also render — ActivityIndicator, and a minimal Animated /
 * Easing pair (the menu card's pop-in): timing() jumps straight to its
 * target and interpolations echo their node, so the suite sees the settled
 * layout without running an animation loop.
 */
import React from 'react';

export * from '../onboarding-gate-stubs/react-native';

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

export function ActivityIndicator(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('ActivityIndicator', props);
}

class AnimatedValue {
  constructor(private value: number) {}
  setValue(next: number): void {
    this.value = next;
  }
  interpolate(_config: unknown): AnimatedValue {
    return this;
  }
}

export const Animated = {
  Value: AnimatedValue,
  View: hostComponent('AnimatedView'),
  timing(
    value: AnimatedValue,
    config: { toValue: number },
  ): { start: (callback?: (result: { finished: boolean }) => void) => void } {
    return {
      start(callback) {
        value.setValue(config.toValue);
        callback?.({ finished: true });
      },
    };
  },
};

export const Easing = {
  out: <T,>(fn: T): T => fn,
  cubic: (t: number): number => t,
};
