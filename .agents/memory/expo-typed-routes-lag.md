---
name: Expo typed routes lag new screens
description: Typecheck fails on a brand-new expo-router screen path until Metro regenerates .expo/types/router.d.ts
---

Adding a new route file under `app/` (e.g. a new modal screen) makes `router.push('/new-screen')` fail typecheck with `TS2322: Type '"/new-screen"' is not assignable to type 'RelativePathString | ...'` even though the file and `_layout.tsx` registration are correct.

**Why:** expo-router's typed routes are generated into `.expo/types/router.d.ts` by the Metro dev server, not by `tsc`. A route added while Metro is idle/stale isn't in the union yet.

**How to apply:** after creating a new route file, restart the Expo workflow (Metro regenerates the types on start — confirm with `grep <route-name> .expo/types/router.d.ts`), then re-run typecheck. Don't hand-edit the generated file and don't loosen the push call to `as any`.
