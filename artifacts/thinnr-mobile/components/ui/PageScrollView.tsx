import React from 'react';
import {
  FlatList,
  Platform,
  ScrollView,
  type FlatListProps,
  type ScrollViewProps,
} from 'react-native';
import { scrollBoundaryProps, type ScrollBoundary } from './scrollBoundary';

export type PageScrollViewProps = ScrollViewProps & { scrollBoundary?: ScrollBoundary };

/** Ordinary vertical pages; horizontal children automatically retain RN defaults. */
export const PageScrollView = React.forwardRef<ScrollView, PageScrollViewProps>(
  function PageScrollView({ scrollBoundary, ...props }, ref) {
    const { style, ...boundary } = scrollBoundaryProps(Platform.OS, { ...props, scrollBoundary });
    return (
      <ScrollView
        {...props}
        {...boundary}
        ref={ref}
        style={style ? [props.style, style] : props.style}
      />
    );
  },
);

function PageFlatListInner<Item>(
  { scrollBoundary, ...props }: FlatListProps<Item> & { scrollBoundary?: ScrollBoundary },
  ref: React.ForwardedRef<FlatList<Item>>,
) {
  const { style, ...boundary } = scrollBoundaryProps(Platform.OS, { ...props, scrollBoundary });
  return (
    <FlatList
      {...props}
      {...boundary}
      ref={ref}
      style={style ? [props.style, style] : props.style}
    />
  );
}

/** Keep item inference and imperative list refs, including scrollToIndex. */
export const PageFlatList = React.forwardRef(PageFlatListInner) as <Item>(
  props: FlatListProps<Item> & {
    scrollBoundary?: ScrollBoundary;
    ref?: React.ForwardedRef<FlatList<Item>>;
  },
) => React.ReactElement;