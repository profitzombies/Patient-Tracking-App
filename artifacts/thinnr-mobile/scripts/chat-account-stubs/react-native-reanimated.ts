/**
 * Node stand-in for react-native-reanimated — just enough for the
 * ThinkingIndicator the support-chat screen renders while a reply streams.
 * Animations are identity transforms: shared values hold their target
 * numbers, animated styles evaluate once, nothing ticks.
 */
import React from 'react';

type AnyProps = Record<string, unknown> & { children?: unknown };

function hostComponent(name: string) {
  function Host(props: AnyProps): React.ReactElement {
    const { children, ...rest } = props;
    return React.createElement(name, rest, children as React.ReactNode);
  }
  Host.displayName = name;
  return Host;
}

const Animated = {
  View: hostComponent('Animated.View'),
  Text: hostComponent('Animated.Text'),
};
export default Animated;

type EasingFn = (t: number) => number;
const identity: EasingFn = t => t;
export const Easing = {
  linear: identity,
  quad: identity,
  cubic: identity,
  in: (fn: EasingFn) => fn,
  out: (fn: EasingFn) => fn,
  inOut: (fn: EasingFn) => fn,
};

export function useSharedValue<T>(initial: T): { value: T } {
  return React.useRef({ value: initial }).current;
}

export function useAnimatedStyle(factory: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return factory();
  } catch {
    return {};
  }
}

export const withTiming = (value: unknown, _config?: unknown): unknown => value;
export const withRepeat = (value: unknown, _times?: number, _reverse?: boolean): unknown => value;
export const withSequence = (...values: unknown[]): unknown => values[values.length - 1];
export const withDelay = (_ms: number, value: unknown): unknown => value;
export function cancelAnimation(_shared: unknown): void {}
export function interpolate(value: number, _input: number[], output: number[]): number {
  return output[0] ?? value;
}
