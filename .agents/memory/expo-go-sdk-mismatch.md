---
name: Expo Go SDK mismatch on Android
description: Tofu/garbled icon fonts on Android Expo Go usually mean the store app outran the project SDK
---
Expo Go bundles exactly one SDK. The Play Store build tracks the newest SDK quickly, while the App Store build can stay frozen on the previous one. When a tester's Android Expo Go moves past the project's SDK, the newer native runtime loads the project's older JS and icon fonts render as tofu **silently** — web and iOS look fine, so it masquerades as a code bug.

**Why:** font/icon modules fail quietly across mismatched native/JS versions instead of erroring, so nothing in the app code is actually wrong.

**How to apply:** when one platform shows tofu icons while others are fine, first compare the device's `Platform.constants.reactNativeVersion` against the project's RN version before touching code — a root-layout log probe (`[fonts] gate v2` in the mobile app's `_layout.tsx`) prints it from the device. If the device RN minor is newer than the project's, the fix is user-side: install the SDK-matching Expo Go build from expo.dev/go. No code change fixes a runtime mismatch.
