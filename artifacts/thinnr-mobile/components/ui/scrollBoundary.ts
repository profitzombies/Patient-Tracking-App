import type { ScrollViewProps, ViewStyle } from 'react-native';

export type ScrollBoundary = 'bounded' | 'refresh';

/**
 * Boundary handling only: no scrollEnabled, touch-action, responder, inset,
 * keyboard or sizing changes. Horizontal/zoom surfaces keep their own policy.
 */
export function scrollBoundaryProps(
  platform: string,
  { horizontal = false, scrollBoundary = 'bounded' }: {
    horizontal?: boolean | null;
    scrollBoundary?: ScrollBoundary;
  } = {},
): Pick<ScrollViewProps, 'bounces' | 'alwaysBounceVertical' | 'overScrollMode' | 'style'> {
  if (horizontal) return {};
  if (platform === 'web') {
    // This must be on the outer ScrollView (the actual overflow:auto node),
    // not contentContainerStyle. RNW ignores the native bounce props.
    return { style: { overscrollBehaviorY: 'none' } as ViewStyle };
  }
  if (platform === 'ios') {
    // UIRefreshControl needs bounce, even when its list fits on the screen.
    const refresh = scrollBoundary === 'refresh';
    return { bounces: refresh, alwaysBounceVertical: refresh };
  }
  if (platform === 'android') return { overScrollMode: 'never' };
  return {};
}

/** Root document only, never a universal selector or a touch event blocker. */
export const WEB_SCROLL_BOUNDARY_CSS = `
html, body, #root {
  overscroll-behavior: none;
}
`;