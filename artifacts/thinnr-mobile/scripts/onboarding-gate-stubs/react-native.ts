/**
 * Node stand-in for the slice of react-native the onboarding steps render.
 *
 * Mapped over the real package by tsconfig.onboarding-gate.json (`paths`) so
 * the REAL OnboardingFrame / Steps components can run under tsx with
 * react-test-renderer. Host components keep every prop (testID, handlers,
 * accessibility*) visible to the test tree; function-valued `style` and
 * `children` (Pressable's pressed-state API) resolve with { pressed: false }.
 * Platform.OS reports 'web' so OnboardingFrame skips KeyboardStickyView and
 * the compat scroll view takes its plain ScrollView branch.
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
export const Image = hostComponent('Image');

export const StyleSheet = {
  create<T>(styles: T): T {
    return styles;
  },
  flatten(style: unknown): unknown {
    return style;
  },
  hairlineWidth: 1,
};

export const Platform = {
  OS: 'web' as string,
  select<T>(spec: Record<string, T>): T | undefined {
    return 'web' in spec ? spec.web : spec.default;
  },
};

/** Captured iOS-style announcements (unused on the 'web' platform path). */
/** No-op app-state handle — lib/supabase.ts wires token auto-refresh to it. */
export const AppState = {
  currentState: 'active' as const,
  addEventListener(_type: string, _handler: (state: string) => void) {
    return { remove() {} };
  },
};

export const announcements: string[] = [];
export const AccessibilityInfo = {
  announceForAccessibility(message: string): void {
    announcements.push(message);
  },
};

export function useColorScheme(): 'light' | 'dark' | null {
  return 'light';
}
