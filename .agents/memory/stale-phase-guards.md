---
name: Stale async phase guards
description: Multi-phase screens with async submits need generation guards so late responses can't hijack navigation; includes the RTR held-fetch test recipe.
---

Screens that drive a phase state machine from async requests (login/signup style: submit → await server → setPhase) must not let a slow response move the user after they've navigated.

**The rule:** keep a `genRef = useRef(0)`. Every user navigation (back button, phase links, channel/flow switches, footer links that push routes) calls an `invalidate()` that bumps the ref and clears `busy`. Every async submit captures `const gen = ++genRef.current`, re-checks `genRef.current === gen` after **each** await before applying state, and guards its `finally { setBusy(false) }` the same way (an unguarded finally re-enables the button while a *newer* request is still in flight).

**Why:** review rejected the disable-only approach — disabling just the submit button leaves back/links live, so a late success forced users into a stale phase (e.g. MFA screen after they'd already bailed to recovery). Locking all navigation during busy was rejected too: it traps users on a hung network. Invalidate-on-navigate gives both — user action always wins, stale completions become no-ops.

**How to test (react-test-renderer suites):** wrap the suite's fetch mock in a gate — `hold()` swaps in a fetch that awaits a manually-released promise before returning the real mock's response (the request still records instantly). Fire the submit with an un-awaited press: `await act(async()=>{held=Promise.resolve(onPress())})` (awaiting the handler inside act deadlocks on the gate). Navigate, assert the new phase, then `release(); await act(async()=>{await held})` and assert the phase did NOT change and busy is released. See verify-patient-auth.ts `staleResponses()` / `pressHeld`.
