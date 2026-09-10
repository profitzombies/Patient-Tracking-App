/**
 * Small React Native surface for verify-scroll-boundary.ts.
 *
 * The important difference from a "null everything" native mock is that every
 * host keeps its props and accepts a ref.  The boundary suite therefore tests
 * the real PageScrollView/PageFlatList/keyboard wrapper forwarding contract,
 * rather than testing a second copy of those wrappers.
 */
import React from 'react';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function resolveChildren(children: unknown): React.ReactNode {
  return typeof children === 'function'
    ? (children as (state: { pressed: boolean }) => React.ReactNode)({ pressed: false })
    : (children as React.ReactNode);
}

function resolveStyle(style: unknown): unknown {
  return typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style;
}

function hostComponent(name: string) {
  const Host = React.forwardRef<unknown, AnyProps>(function Host({ children, style, ...rest }, ref) {
    React.useImperativeHandle(ref, () => ({ host: name }), []);
    return React.createElement(
      name,
      { ...rest, style: resolveStyle(style) },
      resolveChildren(children),
    );
  });
  Host.displayName = name;
  return Host;
}

export const View = hostComponent('View');
export const Text = hostComponent('Text');
export const TextInput = hostComponent('TextInput');
export const ScrollView = hostComponent('ScrollView');
export const FlatList = hostComponent('FlatList');
export const Pressable = hostComponent('Pressable');
export const Image = hostComponent('Image');
export const ActivityIndicator = hostComponent('ActivityIndicator');
export const RefreshControl = hostComponent('RefreshControl');
export const SafeAreaView = hostComponent('SafeAreaView');
export const KeyboardAvoidingView = hostComponent('KeyboardAvoidingView');
export const TouchableOpacity = hostComponent('TouchableOpacity');
export const TouchableWithoutFeedback = hostComponent('TouchableWithoutFeedback');
export const Modal = hostComponent('Modal');

export const StyleSheet = {
  create<T>(styles: T): T {
    return styles;
  },
  flatten(style: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const visit = (value: unknown): void => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value === 'object') Object.assign(result, value);
    };
    visit(style);
    return result;
  },
  hairlineWidth: 1,
};

export const Platform = {
  OS: 'web' as string,
  select<T>(spec: Record<string, T>): T | undefined {
    return spec[Platform.OS] ?? spec.default;
  },
};

export const Dimensions = {
  get(_kind: string): { width: number; height: number; scale: number; fontScale: number } {
    return { width: 393, height: 852, scale: 1, fontScale: 1 };
  },
  addEventListener() {
    return { remove() {} };
  },
};

export function useWindowDimensions(): { width: number; height: number; scale: number; fontScale: number } {
  return { width: 393, height: 852, scale: 1, fontScale: 1 };
}

export function useColorScheme(): 'light' {
  return 'light';
}

export const AccessibilityInfo = {
  announceForAccessibility(_message: string): void {},
  isScreenReaderEnabled: async () => false,
  addEventListener: () => ({ remove() {} }),
};

export const Alert = {
  alert(_title: string, _message?: string, buttons?: Array<{ onPress?: () => void }>): void {
    buttons?.[0]?.onPress?.();
  },
};

export const Keyboard = {
  dismiss(): void {},
  addListener(): { remove(): void } {
    return { remove() {} };
  },
};

export const AppState = {
  currentState: 'active',
  addEventListener(): { remove(): void } {
    return { remove() {} };
  },
};

export const Linking = {
  openURL: async (_url: string): Promise<void> => {},
  canOpenURL: async (_url: string): Promise<boolean> => true,
};

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
  Text: hostComponent('AnimatedText'),
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
  parallel(animations: Array<{ start: (callback?: (result: { finished: boolean }) => void) => void }>) {
    return {
      start(callback?: (result: { finished: boolean }) => void) {
        animations.forEach(animation => animation.start());
        callback?.({ finished: true });
      },
    };
  },
};

export const Easing = {
  out: <T,>(fn: T): T => fn,
  cubic: (t: number): number => t,
  linear: (t: number): number => t,
};

export const I18nManager = { isRTL: false };
export const NativeModules: Record<string, unknown> = {};
export const UIManager = {};
export function findNodeHandle(value: unknown): unknown {
  return value;
}