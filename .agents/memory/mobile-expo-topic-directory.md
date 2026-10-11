---
name: Mobile & Expo topic directory
description: Index of the Expo/React Native lessons that used to sit one-per-line in MEMORY.md; open the named file for the detail.
---

Grouped to keep the MEMORY.md index short. Each bullet names the topic file in this
directory that holds the full lesson.

- [mobile-test-target.md](mobile-test-target.md) — prove tests run on the Expo domain before trusting them; the sibling web UI looks close enough to mask a wrong target.
- [expo-router-guard-redirects.md](expo-router-guard-redirects.md) — gate screen-level Redirects on usePathname; ungated guards hijack in-flight navigation during teardown.
- [rn-web-shadow-props.md](rn-web-shadow-props.md) — shadow*/textShadow*/pointerEvents props and accessibilityState objects do nothing on Expo web; use boxShadow/textShadow strings, style.pointerEvents, flat aria-*.
- [expo-font-pipeline.md](expo-font-pipeline.md) — preload icon fonts at the root (lazy load = silent Android tofu); keep static-build font URLs canonical.
- [mobile-context-suites.md](mobile-context-suites.md) — run real Expo contexts and full screen trees under tsx via tsconfig-paths stubs + react-test-renderer; prove new suites with mutation runs.
- [expo-go-sdk-mismatch.md](expo-go-sdk-mismatch.md) — Android-only tofu icons mean store Expo Go outran the project SDK; check the device RN version via a log probe.
- [tab-label-a11y.md](tab-label-a11y.md) — a function tabBarLabel needs tabBarAccessibilityLabel per screen or every tab loses its screen-reader name.
- [expo-persona-gate.md](expo-persona-gate.md) — patient screens hide behind the persona chooser on Expo web; verify through the testing subagent.
- [expo-typed-routes-lag.md](expo-typed-routes-lag.md) — a new app/ route fails typecheck until Metro regenerates .expo/types/router.d.ts; restart the Expo workflow first.
- [mobile-e2e-quirks.md](mobile-e2e-quirks.md) — Undo taps and native warnings have capture gaps; width checks need isMobile; scroll metrics must exclude hidden mounted tabs.
- [expo-multi-artifact-preview.md](expo-multi-artifact-preview.md) — several Expo apps can share a direct domain; confirm the intended artifact by local port and served title.
- [web-fit-shell.md](web-fit-shell.md) — Expo web lays out on a fixed 393pt canvas transform-scaled to the frame; use the app width hook, ?layoutWidth= to pin or disable.
- [expo-sdk-upgrade.md](expo-sdk-upgrade.md) — 54→57: absoluteFillObject gone, media-library needs /legacy, TS6 baseUrl bridge, splash→plugin, blank-screenshot hydration race.

## Scroll-boundary inventory
New mobile screens must scroll through `components/ui/PageScrollView` / `PageFlatList`, never a raw `ScrollView`/`FlatList` from react-native. **Why:** the scroll-boundary suite keeps an exact allowlist of files that import native scrolling; a raw import in a new screen fails it even though typecheck and the screen's own suite stay green. **How to apply:** when a new route or component scrolls vertically, import the Page* wrapper; only horizontal/zoom surfaces earn an allowlist exception.
