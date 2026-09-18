---
name: Coach usage limits store
description: Durable rules for the shared (database-backed) coach usage limiter and the traps hit while moving it out of process memory.
---

**Rule:** paid coach surfaces reserve their slot through the service-only advisory-lock RPC after identity resolves and before any paid work; only the rapid-fire bucket stays process-local, and its token must be claimed synchronously BEFORE the store is awaited (refunded on a store refusal). Store outages fail closed.

**Why:** in-memory counters multiply by autoscale copies and reset on restart. A check-then-await bucket races: every concurrent caller sees the same free token, so an anonymous flood becomes a flood of advisory-lock RPCs — the review rejected exactly that. Claiming first bounds in-flight store calls per caller at `burst`.

**How to apply:**
- Anonymous callers get no office tier even when one is passed; cap `0` denies, `null` disables a tier — the e2e tester stages denials by zeroing the organization-wide knobs, so keep daily-before-busy precedence and the legacy knob names.
- The workspace env carries live Supabase credentials: vitest must pin the memory store in the shared setup file or route suites silently hit the live project (unknown RPC → every request answers busy).
- Prove async limiter guarantees with a parked store (never-resolving reserve) and assert the peak in-flight count; mutation-check by moving the claim after the await.
- Real-PG suite: assert daily counts on a fresh day or the day already used — reserve prunes rows older than the previous day.
- Open routes that take an optional bearer fall back to IP keying when identity fails; acceptable only for surfaces without a consent gate.
