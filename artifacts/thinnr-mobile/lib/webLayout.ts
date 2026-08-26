import { Platform } from 'react-native';

/**
 * Web preview sizing parity with iOS (permanent project rule — see replit.md).
 *
 * A real iPhone lays this app out at ~393pt wide. The Expo web preview instead
 * hands the app whatever CSS width the preview iframe happens to have, so
 * every fixed point size (fonts, gaps, cards) reads proportionally oversized
 * in a narrower pane and undersized in a wider one. To make web mimic iOS
 * permanently — without ever hand-tuning per-platform sizes — the app on web:
 *
 * 1. lays out on a fixed-width canvas of IPHONE_REFERENCE_WIDTH layout px
 *    (WebFitShell in app/_layout.tsx), visually scaled to fill the frame, and
 * 2. reports that same canvas size to window-width consumers
 *    (hooks/useAppWindowDimensions).
 *
 * Native platforms bypass all of this: resolveWebFitMode() is 'off' anywhere
 * but a real web DOM.
 *
 * Overrides (web only, resolved once at startup):
 * - `?layoutWidth=<px>`   lay out at another width (clamped 240–1440), still
 *   scaled to fit the frame. Lets width sweeps and width-pinned tests reach
 *   the narrow-layout steps (e.g. the Today hero below 390/350).
 * - `?layoutWidth=off`    disable the shell entirely; the app tracks the real
 *   frame width 1:1 (the pre-parity legacy behavior).
 * - `globalThis.__THINNR_LAYOUT_WIDTH__ = <px> | 'off'` — same knob for
 *   programmatic/test environments, checked before the query param. It must
 *   be set before this module first loads.
 */
export const IPHONE_REFERENCE_WIDTH = 393;

/** Sanity clamp for overrides: narrower than any supported phone breaks
 * layouts in uninteresting ways, and huge canvases are never iOS-like. */
const MIN_OVERRIDE_WIDTH = 240;
const MAX_OVERRIDE_WIDTH = 1440;

export type WebFitMode = { kind: 'fit'; layoutWidth: number } | { kind: 'off' };

/** True only in a real browser document — never in Node verify suites, even
 * ones whose react-native stub reports Platform.OS === 'web'. */
function hasUsableDom(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof document !== 'undefined' &&
      typeof window.location?.search === 'string'
    );
  } catch {
    return false;
  }
}

function parseOverride(raw: string | null | undefined): number | 'off' | null {
  if (raw == null || raw === '') return null;
  if (raw === 'off') return 'off';
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_OVERRIDE_WIDTH, Math.max(MIN_OVERRIDE_WIDTH, Math.round(n)));
}

function resolveWebFitMode(): WebFitMode {
  if (Platform.OS !== 'web' || !hasUsableDom()) return { kind: 'off' };
  const injected = (globalThis as { __THINNR_LAYOUT_WIDTH__?: unknown })
    .__THINNR_LAYOUT_WIDTH__;
  let override =
    typeof injected === 'number' || typeof injected === 'string'
      ? parseOverride(String(injected))
      : null;
  if (override == null) {
    try {
      override = parseOverride(
        new URLSearchParams(window.location.search).get('layoutWidth'),
      );
    } catch {
      override = null;
    }
  }
  if (override === 'off') return { kind: 'off' };
  return { kind: 'fit', layoutWidth: override ?? IPHONE_REFERENCE_WIDTH };
}

/** Resolved once at startup — the override can only change with a reload,
 * so the canvas width is stable for the whole session. */
export const WEB_FIT_MODE: WebFitMode = resolveWebFitMode();

/** The fixed layout-canvas width on web, or null when the shell is inactive
 * (native platforms, non-DOM environments, or `?layoutWidth=off`). */
export function webFitLayoutWidth(): number | null {
  return WEB_FIT_MODE.kind === 'fit' ? WEB_FIT_MODE.layoutWidth : null;
}
