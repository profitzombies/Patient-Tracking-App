import { useWindowDimensions, type ScaledSize } from 'react-native';
import { webFitLayoutWidth } from '@/lib/webLayout';

/**
 * Drop-in replacement for React Native's useWindowDimensions — always use
 * this in app code (project rule in replit.md).
 *
 * On web the app renders on a fixed iPhone-reference canvas that WebFitShell
 * scales to the preview frame, so the *layout* width every screen actually
 * gets is the canvas width, not window.innerWidth. This hook reports that
 * canvas space: width is the canvas width and height is the frame height
 * mapped into canvas units (frameHeight / scale) — i.e. exactly the region a
 * full-screen component occupies. Width steps like the Today hero's
 * below-390 behavior therefore fire on web exactly as on a 393pt iPhone,
 * and only when a `?layoutWidth=` override pins a genuinely narrower canvas.
 *
 * On native (and in non-DOM test environments) it is a pure passthrough.
 */
export function useAppWindowDimensions(): ScaledSize {
  const real = useWindowDimensions();
  const layoutWidth = webFitLayoutWidth();
  if (layoutWidth == null || real.width <= 0 || real.height <= 0) {
    return real;
  }
  const zoom = real.width / layoutWidth;
  return {
    ...real,
    width: layoutWidth,
    height: real.height / zoom,
  };
}
