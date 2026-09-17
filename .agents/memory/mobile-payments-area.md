---
name: Provider mobile Payments area
description: Durable rules for the provider app's Payments area (office billing on mobile) — auth-state branching, demo parity, list contracts, RN-web traps, and honest server-capability gaps.
---

**Rule:** every Payments page renders through one screen shell that decides demo vs live from AUTH STATE (session resolving → hold, signed out → pinned demo dataset with writes disabled, signed in → status gate → live body). Pages only supply `demo` and `live` bodies; they never branch on missing data.

**Why:** the web office area already owns these semantics (403 / can_manage=false → permission state, no Stripe account → Get paid redirect). Duplicating them per page drifted immediately during parallel builds.

**How to apply:** new sub-pages join the payments route group and use the shell. The mobile demo dataset is a byte-identical copy of the web office area's demo module guarded by a dual-import deep-equal suite: edit the web file first, then re-copy; never fork values on mobile.

**List controls follow the server, not the UI idiom.** Office billing lists are cursor-paged (`limit` + opaque `cursor`, `next_cursor` in the reply) or return everything with `next_cursor: null` (refunds, subscriptions); there is no `page` param, and status filters are DB `eq` matches (paused subscriptions stay `status=active` with `paused_at` set). Page-number pagers, a `kind` filter on orders, or a `status=paused` chip all pass request-shape suites while silently doing nothing live. Read the route before inventing a filter, and make suites assert the exact query string against the route's accepted params.

**Client path trap:** the shared bearer request helper already appends `/api`; billing paths are relative (`/billing/office/...`).

**Suite harness knobs:** per-query `retryDelay` overrides QueryClient defaults, so the hooks export a test-only retry base setter; screens must be mounted inside the payments range provider (the fallback context is a no-op).

**RN-web traps suites cannot see:** RN-web Pressable overwrites a caller's `aria-disabled` with its own `disabled` prop — pass `disabled` too; a responder view inside a ScrollView loses the gesture on the first move unless it returns false from `onResponderTerminationRequest`. A headless Chromium + CDP script reproduces both quickly without the tester.

**Server capability gaps kept honest:** no office mark-shipped endpoint (HQ ships) → fulfillment is read-only on mobile; Stripe embedded Connect onboarding is web-only → mobile offers only the OAuth link for existing accounts plus a web hand-off notice, never `connect/create` (it returns an account with no onboarding URL); the stripe-react-native import lives only in the `.native.tsx` card form behind a dynamic import.
