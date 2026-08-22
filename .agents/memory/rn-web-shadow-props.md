---
name: RN web deprecated style props
description: Avoiding react-native-web deprecation warnings (shadow*, textShadow*, pointerEvents prop) in the Expo app
---

Rule: In the Expo mobile app, never use `shadowColor/shadowOpacity/shadowRadius/shadowOffset` or `textShadowColor/textShadowOffset/textShadowRadius` style props unguarded, and never pass `pointerEvents` as a component *prop* — on web, react-native-web (Expo SDK 54 / RN 0.81) logs "deprecated" console warnings for all of them.

**Why:** Tester runs flag dev-console warnings as failures; the shadow warnings fire on bundle load, so they surface on unrelated routes and pollute every log check.

**How to apply:**
- Shadows: `Platform.select` — web gets CSS shorthand strings (`boxShadow: '0 6px 14px rgba(...)'`, `textShadow: '0 0 10px rgba(...)'`, cast via `as unknown as TextStyle` for textShadow); native keeps the classic shadow*/elevation props.
- pointerEvents: put it in the style object (`pointerEvents: 'none' | 'box-none'` is a valid ViewStyle key since RN 0.71) instead of a prop.
- Accepted residual: `@react-navigation/bottom-tabs` internally passes pointerEvents props (BottomTabBar/BottomTabView), emitting one warnOnce notice on web when the tab navigator first mounts. Library-internal, not fixable in app code — tell testers to exclude it (and Metro HMR disconnect notices) from zero-warning checks. All app-level instances have been fixed; keep it that way.
