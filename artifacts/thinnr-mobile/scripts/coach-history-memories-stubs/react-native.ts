import React from "react";

function host(name: string) {
  return ({ children, ...props }: Record<string, unknown>) =>
    React.createElement(name, props, typeof children === "function" ? children({ pressed: false }) : children);
}

export const View = host("View");
export const Text = host("Text");
export const Pressable = host("Pressable");
export const TextInput = host("TextInput");
export const KeyboardAvoidingView = host("KeyboardAvoidingView");
export const ActivityIndicator = host("ActivityIndicator");
export const StyleSheet = { create: <T,>(value: T) => value };
export const Platform: { OS: "web" | "ios" | "android" } = { OS: "web" };
export const useColorScheme = () => "light";
export const AccessibilityInfo = { announceForAccessibility: (_message: string) => {} };
export const Alert = { alert: (_title: string, _message?: string, _buttons?: unknown[]) => {} };

export function FlatList<T>({
  data,
  renderItem,
  ListEmptyComponent,
  ListFooterComponent,
  ...props
}: {
  data: T[];
  renderItem: (arg: { item: T; index: number }) => React.ReactNode;
  ListEmptyComponent?: React.ReactNode;
  ListFooterComponent?: React.ReactNode;
  [key: string]: unknown;
}) {
  return React.createElement(
    "FlatList",
    props,
    ...data.map((item, index) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index }))),
    data.length === 0 ? ListEmptyComponent : null,
    ListFooterComponent,
  );
}