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
- Top-level `await` in a suite needs a `.mts` entry (tsx compiles plain `.ts` to CJS and errors). From that ESM entry, CJS-compiled app modules arrive as namespace objects — unwrap `.default` before `createElement` — and dual-build packages (e.g. @tanstack/react-query) split into two instances: the ESM import in the suite vs the CJS require inside app code, so a Provider from one never reaches a hook from the other. Load such packages via `createRequire` so both sides share the CJS build. React itself is CJS-only, hence safe.
- Suite modules can remap app-internal modules too: exact `paths` keys like `"@/lib/supabase"` beat the `"@/*"` wildcard, giving the suite a swappable stand-in (live `export let` bindings) without touching app code. Cross-artifact imports of the web app's pure data modules work under tsx via plain relative paths — the basis of dual-import parity suites.
- One-off tsx debug scripts must live inside the package (not /tmp) or bare specifiers won't resolve; when asserting rendered copy, join text children with '' (not ' ') so interpolated Text reads back exactly as on screen.
- Wrap `TestRenderer.create` itself in `act(async ...)` — a probe read before the first act flush sees an unset context variable (the root does not render synchronously), and un-wrapped creates also spam act warnings.
- Suites that poll with act-wrapped sleeps around a REAL-timer typed-reveal will still see occasional benign "not wrapped in act" warnings (a tick lands between act slices; the next slice flushes it) — filter that exact message instead of switching to fake timers.
- With the `Platform.OS = 'web'` stub, PatientContext persists via `globalThis.localStorage`, not AsyncStorage — the suite needs a Map-backed localStorage shim or hydration never completes.
