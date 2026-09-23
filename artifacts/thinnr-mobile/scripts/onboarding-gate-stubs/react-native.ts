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
export type StyleProp<T> = T | StyleProp<T>[] | false | null | undefined;
export type TextStyle = Record<string, unknown>;
export type ViewStyle = Record<string, unknown>;
export type PressableProps = {
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityState?: Record<string, unknown>;
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
};

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
/**
 * Like the real ScrollView, a `refreshControl` element is rendered as the
 * first child rather than left in host props (an element in props is a
 * circular structure for renderer.toJSON()).
 */
const ScrollViewHost = hostComponent('ScrollView');
export function ScrollView(props: AnyProps & { refreshControl?: React.ReactNode }): React.ReactElement {
  const { refreshControl, children, ...rest } = props;
  return React.createElement(ScrollViewHost, rest, refreshControl ?? null, children as React.ReactNode);
}
ScrollView.displayName = 'ScrollView';
export const Pressable = hostComponent('Pressable') as React.FC<PressableProps>;
export const Switch = hostComponent('Switch');
/**
 * Image also carries RN's static resolveAssetSource: a bundled require()
 * (a number on native, a sentinel object here) becomes a {uri} descriptor,
 * which the Progress viewer needs for seed photos.
 */
export const Image = Object.assign(hostComponent('Image'), {
  resolveAssetSource(source: unknown): { uri: string; width: number; height: number } {
    const record = source && typeof source === 'object' ? (source as Record<string, unknown>) : null;
    const uri = typeof record?.uri === 'string' ? record.uri : `asset:${String(record?.testUri ?? source)}`;
    return { uri, width: 0, height: 0 };
  },
});
export const ActivityIndicator = hostComponent('ActivityIndicator');
export const RefreshControl = hostComponent('RefreshControl');

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

/** Messages handed to the native share sheet by payment-link screens. */
export const sharedMessages: string[] = [];
export const Share = {
  async share(content: { message?: string; url?: string }): Promise<{ action: string }> {
    sharedMessages.push(content.message ?? content.url ?? '');
    return { action: 'sharedAction' };
  },
};

export const Alert = {
  alert(_title: string, _message?: string, buttons?: Array<{ onPress?: () => void; style?: string }>) {
    buttons?.find(button => button.style === 'destructive')?.onPress?.();
  },
};
