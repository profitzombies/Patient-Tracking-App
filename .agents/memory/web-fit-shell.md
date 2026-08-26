---
name: Web fit-to-iPhone shell
description: How the Expo web preview mirrors iOS sizing — fixed 393pt canvas + transform scale, width hook, overrides, and the measurement gotchas that shaped it.
---

The mobile app's web preview must mimic native iOS sizing/styling (permanent rule, recorded in replit.md). Mechanism: a root web-only shell (components/WebFitShell.tsx, wired in app/_layout.tsx OUTSIDE SafeAreaProvider) lays the whole app out on a fixed canvas at the iPhone reference width (393pt, lib/webLayout.ts) and CSS-transform-scales it to fill the frame. Width consumers use hooks/useAppWindowDimensions (canvas space), never RN useWindowDimensions directly.

**Why transform, not zoom:** RNW's onLayout path (ResizeObserver → UIManager.measure) reads offset geometry, which ignores ancestor transforms — so SafeAreaProvider's frame and all measuring components keep seeing canvas px. The transform also makes the wrapper the containing block for absolutely-positioned/fixed chrome, keeping it inside the scaled canvas.

**Gotcha — getBoundingClientRect consumers see REAL px:** react-navigation's useFrameSize (elements FrameSizeListenerWeb) measures via gBCR, so on wide panes it reports the inflated frame and would flip bottom-tab labels beside icons (≥768). Fix: pin `tabBarLabelPosition: 'below-icon'` (web-only) in both classic tab layouts. Audit any future gBCR/measureInWindow consumer the same way.

**Gotcha — RNW Modal escapes the canvas:** react-native-web portals Modal to a new document.body child (position:fixed against the real viewport), OUTSIDE any root shell. App code must use components/ui/AppModal, never RN Modal directly: it keeps RNW's Modal (portal, focus trap, Escape, animations) and re-applies WebFitShell INSIDE it (testIDs web-fit-modal-canvas/-viewport), so dialog content lays out at the same canvas width + scale. Native trees are byte-identical (shell passthroughs). When auditing for width consumers, grep components/ and context/, not just app/ — the modal callsites that slipped past the first audit lived in components/.

**How to apply:**
- Never per-platform font/spacing values to "fix" web; the canvas handles it.
- Width-behavior tests: load with `?layoutWidth=<px>` (240–1440, e.g. 360 for the Today hero narrow steps) or `?layoutWidth=off` for legacy 1:1; also `globalThis.__THINNR_LAYOUT_WIDTH__` before module load. Param is read once at startup — always load the URL with it, not client-navigate.
- Shell testIDs for DOM assertions: web-fit-viewport / web-fit-canvas (inline width + scale transform).
- Node verify suites are unaffected: the shell/hook require a real DOM (`document` + `location.search`), so Platform.OS='web' stubs stay passthrough.
- Wide panes intentionally upscale (proportional zoomed phone, short visible height) — that IS the spec; don't "fix" it with a max-scale cap.
