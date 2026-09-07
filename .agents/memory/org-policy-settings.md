---
name: Organization policy settings
description: Durable decisions behind the HQ policy contract and office overrides (persistence shape, precedence, demo isolation).
---
**Decision:** HQ policy is one versioned row edited with section-scoped partial PUTs guarded by `expectedVersion` (stale → 409, client re-seeds from the fresh copy). Office overrides live in a separate per-office row where **null means inherit**, and quiet hours are tri-state (inherit / explicit none / custom window) so "no quiet hours" is distinguishable from "never set". Only quiet hours and the escalation destination are office-overridable.

**Why:** consumers (sender, inbox auto-close, coach availability, export TTL) must read one server truth, and two admins editing different sections at once must not clobber each other; per-section rows were rejected as heavier than a single version column.

**How to apply:** new policy fields join the existing row + section stamps, never a parallel settings store. Signed-in users must never fall through to the seeded demo settings (a signed-in HQ admin without an office scope gets an "open an office" notice instead). The guided-demo settings pages stay seeded and non-persisting by design.
