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
/**
 * App-state handle — lib/supabase.ts wires token auto-refresh to it and
 * PatientContext re-checks the local day on foreground. Handlers are kept
 * so suites can emit a transition via emitAppStateChange().
 */
const appStateHandlers = new Set<(state: string) => void>();
export const AppState = {
  currentState: 'active' as const,
  addEventListener(_type: string, handler: (state: string) => void) {
    appStateHandlers.add(handler);
    return {
      remove() {
        appStateHandlers.delete(handler);
      },
    };
  },
};

/** Test hook: deliver an app-state transition to every live listener. */
export function emitAppStateChange(state: string): void {
  for (const handler of [...appStateHandlers]) handler(state);
}

export const announcements: string[] = [];
export const AccessibilityInfo = {
  announceForAccessibility(message: string): void {
    announcements.push(message);
  },
};

export function useColorScheme(): 'light' | 'dark' | null {
  return 'light';
}

/** URLs the app asked the platform to open (privacy export downloads). */
export const openedUrls: string[] = [];
export const Linking = {
  async openURL(url: string): Promise<void> {
    openedUrls.push(url);
  },
  async canOpenURL(): Promise<boolean> {
    return true;
  },
};
