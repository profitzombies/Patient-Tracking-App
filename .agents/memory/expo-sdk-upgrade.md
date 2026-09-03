---
name: Expo SDK upgrade lessons
description: What actually breaks when this app crosses Expo SDK majors (learned on 54→57) and how to verify the result
---

Traps for future Expo SDK major upgrades of this app (learned on 54→57). The `upgrading-expo` skill drives the workflow; these are the project-specific parts it doesn't cover. Current versions are in package.json — don't trust any listed here.

**Workspace/toolchain**
- React/react-dom live in the pnpm catalog and are shared with the web + API packages: bump the catalog, not per-package literals. `expo install --fix` writes literal versions into mobile package.json — restore `catalog:`/exact refs afterward, and keep react-test-renderer pinned exactly to the React version (suites require an exact match).
- TS 6 deprecates `baseUrl` (TS5101, a config-level error that hides all real type errors until fixed). The mobile tsconfig feeds ~18 suite tsconfigs that inherit `baseUrl` for path stubs — use `"ignoreDeprecations": "6.0"` as the bridge instead of removing `baseUrl` mid-upgrade.

**API removals that type-check catches**
- RN 0.86 removed `StyleSheet.absoluteFillObject`; `absoluteFill` is now a plain object (spreadable and array-usable) — mechanical rename.
- `expo-media-library`'s main entry is the new class API; the old function names still exist as typed stubs that THROW at runtime ("import from expo-media-library/legacy"). Import `expo-media-library/legacy` instead — and remember suite stub tsconfigs map bare specifiers, so the `/legacy` subpath needs its own `paths` entry pointing at the same stub.
- app.json top-level `"splash"` fails the SDK 57 schema — move it into an `expo-splash-screen` plugin block (same image/resizeMode/backgroundColor keys).

**Things that look broken but aren't**
- A blank static Screenshot of the Expo web app right after boot is usually the live-entry hydration overlay (an opaque background sheet) racing the capture — the browser log showing fonts loaded + no errors means boot is fine; re-shoot. `?layoutWidth=393` "fixing" it is a coincidence trap: 393 IS the default canvas width, so that URL changes nothing.
- `react-native-health` (latest 1.19.0) pins `@expo/config-plugins` ^7, so expo-doctor reports a duplicate `@expo/fingerprint` — upstream-inherent, only relevant to native builds (never made here). Health libs are native-build-only with zero runtime imports; Expo Go can't validate them either way.
- React Native DevTools fails to install on Nix (`libglib-2.0.so.0` missing) — harmless dev-only noise in the Expo workflow log.
- The package-install storm auto-restarts every test workflow at once → EAGAIN/fork/pthread failures. Only serial re-runs are evidence.

**Verification that worked**
- Serve + `curl -H "expo-platform: ios" https://$REPLIT_EXPO_DEV_DOMAIN/` → manifest `sdkVersion` proves what's actually served.
- `expo export --platform ios|android` after every code fix (exports bundle with the fixed graph; pre-fix exports prove nothing).
- Version-stamped log probes (fonts gate "project JS RN") must derive from `require('react-native/package.json').version`, never a hardcoded string — the old hardcode silently lied after the upgrade.
