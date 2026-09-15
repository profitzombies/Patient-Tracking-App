---
name: Organization policy settings
description: Durable decisions behind the HQ policy contract and office overrides (persistence shape, precedence, demo isolation).
---
**Decision:** HQ policy is one versioned row edited with section-scoped partial PUTs guarded by `expectedVersion` (stale → 409, client re-seeds from the fresh copy). Office overrides live in a separate per-office row where **null means inherit**, and quiet hours are tri-state (inherit / explicit none / custom window) so "no quiet hours" is distinguishable from "never set". Only quiet hours and the escalation destination are office-overridable.

**Why:** consumers (sender, inbox auto-close, coach availability, export TTL) must read one server truth, and two admins editing different sections at once must not clobber each other; per-section rows were rejected as heavier than a single version column.

**How to apply:** new policy fields join the existing row + section stamps, never a parallel settings store. Signed-in users must never fall through to the seeded demo settings (a signed-in HQ admin without an office scope gets an "open an office" notice instead). The guided-demo settings pages stay seeded and non-persisting by design.

## New policy fields: single row, checked-in migration runner

**Decision:** store-listing links (and any future HQ-set, office-read values) join the organization section of the same versioned row, with the same host-shape rule enforced in the DB CHECK and the API so a bypassing write cannot diverge from what the UI accepts. Offices never persist a copy; they read the HQ echo.

**Why:** "set once by HQ, every practice updates automatically" falls out of the single-row contract; a parallel store would need its own version/audit/409 handling.

**How to apply:** every new column on this table must also be listed in the startup migration runner (`scripts/apply-coach-migrations.mjs`, run by post-merge) with a postcondition, because Drizzle push does not own this table — a migration applied only by hand through the management API breaks fresh environments at first policy read. QR-style derived views must render from the exact saved value locally (no external image service) so Node RTR suites can assert the encoded value. Suites that render a page must be re-pointed when that page is re-homed (grep every RTR script importing it); a moved page silently reddens an unrelated suite on main.
