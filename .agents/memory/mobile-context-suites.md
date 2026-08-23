---
name: Mobile context suites in Node
description: How to regression-test real Expo context/lib modules (React state + streaming clients) under tsx without jest/jsdom, and how to prove a new suite isn't vacuous.
---

Rule: To regression-test THINNR mobile logic that lives in React contexts or native-importing libs, run the REAL modules under tsx with a dedicated tsconfig, instead of extracting copies of the logic or spinning up an e2e browser.

**Why:** The valuable regressions (race guards, staleness checks, lock/unlock timing) live in hook wiring that a pure-function extraction would not exercise, and e2e runs are too slow/flaky to serve as a validation command.

**How to apply:**
- Dedicated `tsconfig.<suite>.json` extending the app tsconfig, passed via `tsx --tsconfig`. Override `"jsx": "react-jsx"` — the inherited Expo `"jsx": "react-native"` leaves JSX untransformed and Node throws a syntax error.
- Map native-only bare specifiers to tiny Node stubs via `paths` (works for exact keys like `react-native`, `expo/fetch`); redeclare `"@/*": ["./*"]` because `paths` replaces the base map wholesale. Keep stubs minimal (e.g. `Platform.OS = 'web'` so clients bind `globalThis.fetch`, which the suite replaces with a scripted transport).
- Drive hooks with `react-test-renderer` pinned to the exact react version (19.1.0), `React.act`, and `IS_REACT_ACT_ENVIRONMENT = true`; a probe child component captures the context value each render.
- For streaming/abort behavior, script the transport in two modes: "faithful" (abort errors the pending read, like real fetch — proves the client's silence contract) and "leaky" (keeps emitting after abort — proves the UI-side staleness guards alone protect the chat). Testing only one mode masks whichever layer is broken.
- `scripts/` is excluded from the mobile package typecheck, so suites there don't need extra `@types/*`.
- Before trusting a new suite, mutation-test it: break each guarded behavior on purpose and confirm the suite fails loudly, then restore. A suite that passes on first run is unproven.
- Full screen/component trees render the same way: stub the UI specifiers (react-native, expo-router, expo-haptics, @expo/vector-icons, keyboard-controller, safe-area-context) as host strings/no-ops and traverse by testID. The Pressable stub must reproduce RN's "disabled swallows onPress" semantics, or disabled-interception tests pass vacuously.
- Assert navigation by recording it: an expo-router stub that logs push/replace lets blocked-action tests prove "never advances" and valid-action tests pin the exact next route.
- When a sibling task is actively changing a step's behavior, pin the shared contract with a synthetic probe (render the frame/component directly with crafted props) instead of that step, so the suite doesn't fight in-flight work.
- `findAllByProps` matches component AND host instances for the same testID. Interact via the deepest HOST element (`typeof instance.type === 'string'`): component-level matches carry the raw pre-wrap props (unwrapped onPress, un-derived disabled) and bypass the real press semantics — e.g. a button that routes blocked taps through an onDisabledPress interceptor looks permanently disabled at the component layer.
- When a suite guards a state-RESET effect (e.g. "stale hint must not resurrect on re-block"), arm the state first (trigger the visible behavior), then flip valid → invalid and assert nothing lingers. Asserting reset without arming passes vacuously — a mutation run is what exposes the vacuous ordering.
