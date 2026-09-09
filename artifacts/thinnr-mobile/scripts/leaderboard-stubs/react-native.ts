/**
 * Node stand-in for react-native used by the leaderboard suite (see
 * tsconfig.leaderboard.json `paths`). Re-exports the onboarding-gate stub
 * (prop-preserving host components, Platform.OS 'web') and adds the two
 * pieces the leaderboard tab renders on top of it: ActivityIndicator and a
 * FlatList that lays out header / rows / separators / empty / footer exactly
 * as the real one would.
 */
import React from 'react';

export * from '../onboarding-gate-stubs/react-native';

export function ActivityIndicator(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('ActivityIndicator', props);
}

export function RefreshControl(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('RefreshControl', props);
}

export function useWindowDimensions() {
  return { width: 393, height: 852, scale: 1, fontScale: 1 };
}

export function Modal(props: Record<string, unknown>): React.ReactElement | null {
  return props.visible ? React.createElement('Modal', props, props.children as React.ReactNode) : null;
}

export function KeyboardAvoidingView(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('KeyboardAvoidingView', props, props.children as React.ReactNode);
}

interface FlatListProps<T> {
  data: ReadonlyArray<T>;
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: { item: T; index: number }) => React.ReactElement | null;
  ItemSeparatorComponent?: React.ComponentType | null;
  ListHeaderComponent?: React.ReactNode;
  ListEmptyComponent?: React.ReactNode;
  ListFooterComponent?: React.ReactNode;
  [key: string]: unknown;
}

export function FlatList<T>(props: FlatListProps<T>): React.ReactElement {
  const { data, keyExtractor, renderItem, ItemSeparatorComponent, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...rest } = props;
  const items: React.ReactNode[] = [];
  data.forEach((item, index) => {
    if (index > 0 && ItemSeparatorComponent) items.push(React.createElement(ItemSeparatorComponent, { key: `sep-${index}` }));
    items.push(React.createElement(React.Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index })));
  });
  return React.createElement(
    'FlatList',
    rest,
    ListHeaderComponent ?? null,
    data.length === 0 ? ListEmptyComponent ?? null : items,
    ListFooterComponent ?? null,
  );
}
