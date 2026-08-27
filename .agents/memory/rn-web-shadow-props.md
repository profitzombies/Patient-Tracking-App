---
name: RN web deprecated & unmapped props
description: react-native-web props that break silently on Expo web — shadow*/textShadow*/pointerEvents warnings, and accessibilityState objects that never reach the DOM
---

Rule: In the Expo mobile app, never use `shadowColor/shadowOpacity/shadowRadius/shadowOffset` or `textShadowColor/textShadowOffset/textShadowRadius` style props unguarded, and never pass `pointerEvents` as a component *prop* — on web, react-native-web (Expo SDK 54 / RN 0.81) logs "deprecated" console warnings for all of them.

**Why:** Tester runs flag dev-console warnings as failures; the shadow warnings fire on bundle load, so they surface on unrelated routes and pollute every log check.

**How to apply:**
- Shadows: `Platform.select` — web gets CSS shorthand strings (`boxShadow: '0 6px 14px rgba(...)'`, `textShadow: '0 0 10px rgba(...)'`, cast via `as unknown as TextStyle` for textShadow); native keeps the classic shadow*/elevation props.
- TS gotcha: this project's RN 0.81 type defs accept the `boxShadow` string key but NOT `textShadow` — an uncast `textShadow` in `StyleSheet.create` fails typecheck even though RNW renders it. Either cast as above or skip the shadow (a translucent pill background behind light-on-camera text reads fine and is fully cross-platform).
- pointerEvents: put it in the style object (`pointerEvents: 'none' | 'box-none'` is a valid ViewStyle key since RN 0.71) instead of a prop.
- Accepted residual: `@react-navigation/bottom-tabs` internally passes pointerEvents props (BottomTabBar/BottomTabView), emitting one warnOnce notice on web when the tab navigator first mounts. Library-internal, not fixable in app code — tell testers to exclude it (and Metro HMR disconnect notices) from zero-warning checks. All app-level instances have been fixed; keep it that way.

**accessibilityState is silently unmapped (worse than a warning):** react-native-web 0.21 never translates the legacy `accessibilityState={{ selected | disabled | expanded | checked }}` object into DOM ARIA — createDOMProps/forwardedProps read only flat props (`aria-selected` etc.), and NO deprecation warning fires (only legacy Touchable still reads the object internally). Visual state still works, so the gap is invisible except to a DOM/screen-reader check.

**Why:** A tester DOM assertion on chip selection (`aria-selected`) came back empty even though selection visibly worked; confirmed by grepping the RNW dist — zero accessibilityState handling in the DOM prop builders.

**How to apply:** Use flat `aria-*` props (`aria-selected={sel}` — valid cross-platform since RN 0.71, still sets native selected state). When writing e2e/a11y checks, never assume the object prop reached the DOM; grep for `accessibilityState={{` when auditing (a follow-up task was filed to sweep existing call sites).
