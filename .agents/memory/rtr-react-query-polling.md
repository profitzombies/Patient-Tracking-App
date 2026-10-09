---
name: React Query polling under react-test-renderer
description: Why refetchInterval never fires in the Node/RTR web suites and how to prove live polling anyway; plus the offboarding bundle identity rule.
---
# Proving refetchInterval in the RTR (Node) web suites

**Rule:** React Query decides `isServer` at module import (`typeof window === "undefined"`), *before* a script's `globalThis.window ??= {}` shim runs (ESM imports hoist). On a "server" the observer never arms `refetchInterval` timers, so any polling check silently passes/fails on the first fetch only. Call `environmentManager.setIsServer(() => false)` (re-exported from `@tanstack/react-query`) at the top of the suite, then wait a real interval (`act` + 5.4 s) and count GET fetches.

**Why:** The office-offboarding suite "verified" seal polling for months without a timer ever firing; the bundle-polling regression (page stuck on "Queued" forever) was invisible to it.

**How to apply:** Any RTR suite asserting auto-refresh / stop-polling behaviour. Rendering a Radix RadioGroup under RTR needs a DOM-free stub mapped in that suite's tsconfig paths (see `scripts/office-admin-stubs/radio-group.tsx`).

# Offboarding bundle = billing-bearing export

Every export row whose generator touches billing sheets (office bundle included) must store `params.billingIdentity` from `getBillingModeStatus()` at request time; otherwise the worker fails with "no verified frozen billing identity". A new route that queues such a kind must copy the Exports route's capture, and the server's `nextStep` must keep step 2 current until the row is `ready` (queued/running are not done).
