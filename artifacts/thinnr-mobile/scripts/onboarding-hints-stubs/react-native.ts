/**
 * Node stand-in for the slice of react-native the onboarding step components
 * touch (see tsconfig.onboarding-hints.json `paths`).
 *
 * Components render as plain host elements so react-test-renderer can walk
 * them by testID. Pressable reproduces the one behavior the suite depends on:
 * a disabled Pressable swallows presses (RN semantics), while an enabled one
 * forwards them — that is exactly the gate PrimaryButton's onDisabledPress
 * interception relies on.
 *
 * Platform.OS reports 'web' so OnboardingFrame skips KeyboardStickyView and
 * ErrorBox skips the iOS-only announceForAccessibility call.
 */
import React from 'react';

export const Platform = {
  OS: 'web' as const,
  select<T>(options: { web?: T; default?: T }): T | undefined {
    return options.web ?? options.default;
  },
};

export const StyleSheet = {
  create<T>(styles: T): T {
    return styles;
  },
  flatten(style: unknown): unknown {
    return style;
  },
  hairlineWidth: 1,
};

export function useColorScheme(): 'light' {
  return 'light';
}

export const AccessibilityInfo = {
  announceForAccessibility(_message: string): void {},
};

/** Host passthroughs — react-test-renderer treats string types as hosts. */
export const View = 'View';
export const Text = 'Text';
export const TextInput = 'TextInput';
export const ScrollView = 'ScrollView';

interface PressableStubProps {
  onPress?: () => void;
  disabled?: boolean;
  style?: unknown;
  children?: React.ReactNode;
  [key: string]: unknown;
}

export function Pressable({ onPress, disabled, style, children, ...rest }: PressableStubProps) {
  return React.createElement(
    'Pressable',
    {
      ...rest,
      disabled: !!disabled,
      // RN resolves function styles with the pressed flag; nothing here presses.
      style: typeof style === 'function' ? style({ pressed: false }) : style,
      onPress: () => {
        if (disabled) return; // RN swallows presses on disabled Pressables.
        onPress?.();
      },
    },
    children,
  );
}
