---
name: Expo multi-artifact preview routing
description: Multiple Expo artifacts in one workspace can share the same Expo domain even when their local ports and bundles are distinct.
---

When more than one Expo artifact is running, the shared Expo-domain screenshot/preview path may resolve to the other app. Verify the intended artifact by checking its assigned local port and its served HTML title before diagnosing the app as wrong.

**Why:** The workspace can host multiple Expo workflows, but the direct Expo domain is not always artifact-specific.

**How to apply:** Use the artifact pane/presented artifact for the intended app, and use the artifact's local port for shell-level verification.
## E2E testers need the direct Expo domain spelled out

The Playwright tester will guess the shared-proxy path (`/thinnr-mobile/`) and get a blank page with 502 resource loads — Expo web bypasses the proxy entirely. Put the full `https://$REPLIT_EXPO_DEV_DOMAIN/` URL in the test task verbatim (echo the env var first), note that routes live at `/` on that domain, and that the first web bundle compile can take 30-60s.
