---
name: THINNR mobile test target
description: How to avoid validating the sibling web dashboard when testing the native companion.
---

Before trusting a THINNR mobile end-to-end result, verify the browser is on the Expo development domain and confirm an Expo-specific UI sentinel.

**Why:** The sibling web dashboard closely matches the mobile companion. A shared-preview test can appear valid while exercising the wrong artifact, producing misleading navigation and persistence failures.

**How to apply:** Open the Expo domain directly, use a fresh mobile-sized browser context, and confirm one native-only label or interaction before running the main journey.