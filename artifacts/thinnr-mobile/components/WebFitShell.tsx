import React, { useEffect } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { webFitLayoutWidth } from '@/lib/webLayout';
import { WEB_SCROLL_BOUNDARY_CSS } from '@/components/ui/scrollBoundary';

/**
 * Web-only fit-to-reference shell (permanent project rule — see replit.md and
 * lib/webLayout.ts). Wraps the entire app in app/_layout.tsx:
 *
 * - The app lays out on a fixed canvas webFitLayoutWidth() layout px wide
 *   (iPhone reference 393, unless a ?layoutWidth= override pins another
 *   width) and frameHeight/scale tall, then a CSS transform scales that
 *   canvas so it exactly fills the preview frame at any pane size. Web
 *   proportions therefore always match a real iPhone.
 * - transform (not zoom) keeps everything in canvas coordinates: RNW's
 *   onLayout path (ResizeObserver → UIManager.measure) reads offset geometry,
 *   which ignores ancestor transforms, so SafeAreaProvider's frame, the tab
 *   bar's compact/label math, and any measuring component keep seeing canvas
 *   px. The transform also makes this wrapper the containing block for
 *   absolutely-positioned chrome (tab bar, snackbars, modals routes), so they
 *   scale with the canvas instead of escaping to the real viewport.
 * - Native platforms (and non-DOM environments) render children untouched.
 * - RNW's Modal portals to document.body — OUTSIDE this canvas — so dialogs
 *   go through components/ui/AppModal, which re-applies this same shell
 *   inside the modal (with its own testIDs, passed via props below).
 */
export function WebFitShell({ children, testID, viewportTestID }: ShellProps) {
  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }
  return (
    <WebFitFrame testID={testID} viewportTestID={viewportTestID}>
      {children}
    </WebFitFrame>
  );
}

type ShellProps = {
  children: React.ReactNode;
  /** DOM assertion handle for the canvas node. Default: web-fit-canvas. */
  testID?: string;
  /** DOM assertion handle for the clipping viewport. Default: web-fit-viewport. */
  viewportTestID?: string;
};

function WebFitFrame({
  children,
  testID = 'web-fit-canvas',
  viewportTestID = 'web-fit-viewport',
}: ShellProps) {
  const { width: frameWidth, height: frameHeight } = useWindowDimensions();
  const layoutWidth = webFitLayoutWidth();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    // Each shell owns its style node. Closing a portalled AppModal must not
    // remove the root shell's document boundary. Also active with layoutWidth=off.
    const sheet = document.createElement('style');
    sheet.dataset.thinnrScrollBoundary = '';
    sheet.textContent = WEB_SCROLL_BOUNDARY_CSS;
    document.head.appendChild(sheet);
    return () => sheet.remove();
  }, []);

  // Inactive shell (?layoutWidth=off / no DOM) or degenerate frame sizes:
  // render 1:1 rather than divide by zero into an invisible app.
  if (layoutWidth == null || frameWidth <= 0 || frameHeight <= 0) {
    return <>{children}</>;
  }

  const scale = frameWidth / layoutWidth;
  const layoutHeight = frameHeight / scale;

  return (
    <View style={styles.viewport} testID={viewportTestID}>
      <View
        testID={testID}
        style={{
          width: layoutWidth,
          height: layoutHeight,
          transform: [{ scale }],
          transformOrigin: 'top left',
        }}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    flex: 1,
    // The scaled canvas equals the frame size up to float rounding; clip the
    // stray fraction of a pixel so the page never grows scrollbars.
    overflow: 'hidden',
    overscrollBehavior: 'none',
  },
});
