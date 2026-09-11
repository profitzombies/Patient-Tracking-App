---
name: THINNR mobile test target
description: How to avoid validating the sibling web dashboard when testing the native companion.
---

Before trusting a THINNR mobile end-to-end result, verify the browser is on the Expo development domain and confirm an Expo-specific UI sentinel.

**Why:** The sibling web dashboard closely matches the mobile companion. A shared-preview test can appear valid while exercising the wrong artifact, producing misleading navigation and persistence failures.

**How to apply:** Open the Expo domain directly, use a fresh mobile-sized browser context, and confirm one native-only label or interaction before running the main journey.

Describe sentinels to the tester by VISIBLE UI, never by testID: both THINNR apps share branding and a tester told to look for a testID may abort a correct run as "wrong app". The reliable distinction is bottom navigation after sign-in versus the web dashboard's sidebar. Do not hardcode remembered tab labels in tester briefs; these have changed while the app remained correct. testIDs render as data-testid attributes on Expo web if DOM-level confirmation is needed. Tell the tester UP FRONT that the shared persona chooser is expected on BOTH apps and is not evidence either way; judgment happens at the post-sign-in layout.

On Expo web, a disabled Pressable does not render a native `disabled` DOM attribute — have testers judge inert controls by behavior (tapping changes nothing) or dimmed opacity, never by asserting the attribute.

Known capture quirk: static Expo web screenshots can finish before provider hydration, even after fonts have loaded; repeated white captures do not prove a broken app. **Why:** interactive browser verification has reached healthy screens after the static tool captured only startup. **How to apply:** wait for a visible ready screen in one browser session and inspect its a11y/layout state before changing app code or repeatedly restarting. A transient 502 on first load can instead indicate a workflow or bundling delay.

A PERSISTENT blank page + repeated 502s means the browser is on the shared-proxy artifact path (e.g. /thinnr-mobile/), which never serves the Expo app. Always hand testers the literal Expo dev-domain base URL (resolve $REPLIT_EXPO_DEV_DOMAIN first) in the brief; a tester left to guess will default to the proxy path, burn its run on retries/workflow restarts, and return "unable" even though the app is healthy.

A freshly (re)started Metro also 502s until its first web bundle finishes (~2 min). Pre-warm before dispatching a tester: curl the Expo root HTML, extract the entry.bundle src, and curl that URL to completion — it doubles as proof the served bundle contains the new code (grep for a new testID).
