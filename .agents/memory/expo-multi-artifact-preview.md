---
name: Expo multi-artifact preview routing
description: Multiple Expo artifacts in one workspace can share the same Expo domain even when their local ports and bundles are distinct.
---

When more than one Expo artifact is running, the shared Expo-domain screenshot/preview path may resolve to the other app. Verify the intended artifact by checking its assigned local port and its served HTML title before diagnosing the app as wrong.

**Why:** The workspace can host multiple Expo workflows, but the direct Expo domain is not always artifact-specific.

**How to apply:** Use the artifact pane/presented artifact for the intended app, and use the artifact's local port for shell-level verification.