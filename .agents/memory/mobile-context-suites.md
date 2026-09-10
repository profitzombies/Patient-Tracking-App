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
- Importing a pure helper FROM a native-importing module drags that module's native edges into every suite whose graph reaches it (esbuild dies with `Unexpected "typeof"` on real react-native — tsconfig paths don't remap imports made inside node_modules packages like expo-image-manipulator). Keep dependency-free helpers in their own zero-import module (e.g. lib/base64) and re-export from the old home for existing callers, instead of stub-mapping every suite tsconfig.
- Wrap `TestRenderer.create` itself in `act(async ...)` — a probe read before the first act flush sees an unset context variable (the root does not render synchronously), and un-wrapped creates also spam act warnings.
- Suites that poll with act-wrapped sleeps around a REAL-timer typed-reveal will still see occasional benign "not wrapped in act" warnings (a tick lands between act slices; the next slice flushes it) — filter that exact message instead of switching to fake timers.
- With the `Platform.OS = 'web'` stub, PatientContext persists via `globalThis.localStorage`, not AsyncStorage — the suite needs a Map-backed localStorage shim or hydration never completes.

## Silent exit 0 with zero output = dangling await, not a pass

If a suite prints NOTHING and exits 0, an `await` never settled (e.g. a scripted never-resolving fetch used for cancel-path checks): Node drains its event loop and exits cleanly without running `finish()`. Two required guards:

- `tap()` must NOT await the handler's promise. Fire it with `void onPress()` inside `act`, then flush a bounded number of microtasks (`for (i<25) await Promise.resolve()`) so settled chains propagate but a hung one can't deadlock the suite.
- Register a `process.on('beforeExit')` hook that fails loudly; only `finish()`'s explicit `process.exit` may end the run.

- testID queries in RTR suites must filter to HOST nodes (typeof node.type === 'string'): a component that forwards a testID prop (e.g. MealPhotoButton) matches findAll before its inner Pressable and carries no onPress, so taps silently no-op.
- Host button wrappers may intentionally fire async handlers with `void`, so `tap()` cannot await delayed retries/recovery. After triggering a real-timer branch, use an act-wrapped bounded sleep before asserting the settled screen.
- To pin "input REMOUNTED, not repurposed in place" (e.g. `key=` per mode so iOS presents the right keyboard — it never swaps an already-presented one), pass `createNodeMock` to `TestRenderer.create` and have the mock's `focus()` record the element's testID captured at ref-attach. The screen's ref+focus effect then logs WHICH mount it focused: dropping the `key` leaves the stale mock attached and records the old testID, so the assertion bites under mutation.

## Suite stubs must track hydration-time calls and screen-graph native imports
When PatientContext (or any provider a suite mounts) gains a new hydration-time fetch, EVERY suite stub that mounts it needs the route scripted — an unscripted hydration route surfaces as a sync notice plus ALL subsequent writes silently blocked (cascading FAILs far from the cause). When a compiled screen graph gains a module using native packages, each suite tsconfig needs the stub mapping — the symptom is an esbuild TransformError inside real react-native (flow syntax), not a clean module-not-found. Exact-path stubs (e.g. `@/context/DeviceFeaturesContext` → stub) win over the `@/*` wildcard and beat stubbing five native packages one by one. Diagnose regressions vs merge damage by swapping the suspect file to its HEAD version and re-running.

- The mobile package is CJS under tsx: no top-level `await` in suite scripts — wrap everything in `async function main()`. With the react-native stubs, `root.findAll(testID startsWith …)` matches BOTH the stub composite and its host node (double counts); filter `typeof node.type === 'string'`. `create()` outside `act` can leave `.root` reporting "unmounted" — wrap creates in `await act(async …)`.

## Navigation lifecycle fidelity
Pagination and source-navigation suites must reproduce focus-effect cleanup and callback-identity changes, not only invoke the page loader directly.

**Why:** A real source lookup stalled despite passing API and renderer checks because a focus refresh invalidated its older-page request. Simplified navigation stubs concealed that interaction.

**How to apply:** Exercise the screen's focus effect alongside delayed page responses. Also avoid assuming React state updaters run later: compute progress before dispatch, since eager execution can change refs before subsequent assertions or guards.
