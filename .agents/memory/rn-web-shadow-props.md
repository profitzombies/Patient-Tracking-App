---
name: RN web shadow props
description: Avoiding react-native-web deprecation warnings for shadow*/textShadow* style props in the Expo app
---

Rule: In the Expo mobile app, do not use `shadowColor/shadowOpacity/shadowRadius/shadowOffset` or `textShadowColor/textShadowOffset/textShadowRadius` style props unguarded — on web, react-native-web (Expo SDK 54 / RN 0.81) logs "style props are deprecated" console warnings for them.

**Why:** A tester run flagged the dev-console warnings as failures; the warnings fire on bundle load, so they surface on unrelated routes and pollute every log check.

**How to apply:** Use `Platform.select`: web gets CSS shorthand strings (`boxShadow: '0 6px 14px rgba(...)'`, `textShadow: '0 0 10px rgba(...)'`, cast via `as unknown as TextStyle` for textShadow), native keeps the classic shadow*/elevation props. A pre-existing instance remains in the error-fallback component (rendered only on crashes).
