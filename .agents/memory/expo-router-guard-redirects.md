---
name: expo-router guarded redirects
description: How to write route guards with <Redirect> in this Expo app without breaking navigation
---

Rule: a screen-level `<Redirect>` guard must only render when its route is the active one — gate it on `usePathname() === ownPath` and render `null` otherwise.

**Why:** Guards re-render on context changes while a screen is still mounted during a transition away (e.g. a completion handler that navigates then clears state). An ungated `<Redirect>` fires during teardown and hijacks the in-flight navigation. `useIsFocused` from @react-navigation/native is not a direct dependency of the mobile package (pnpm strict), so `usePathname` from expo-router is the available signal.

**How to apply:** Any guard in `app/**` that redirects based on shared context state (mode guards, wizard step gating). Also: for multi-step wizards, gate by both visibility (answers-derived) and a furthest-reached pointer kept in full flow order — visible-list indexes shift when conditional answers change, so never compare positions in the filtered list.
