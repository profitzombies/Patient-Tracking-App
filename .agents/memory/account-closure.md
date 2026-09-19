---
name: Patient account closure (seal, don't purge)
description: How self-service account closure splits personal vs clinical data, the identity fences it relies on, and the traps hit while wiring exclusions across API/web/mobile.
---

**Rule:** "Close my account" is a two-phase lifecycle: at grace end a closure RPC deletes the PERSONAL families and nulls `auth_user_id`/`email`/`phone`, stamping `closed_at` + `archived_at` + `record_retain_until` (HQ clinical retention days, floored at 1825); the pre-existing final purge runs only when `retain_until` passes and no legal hold is active. Sealed ⇔ `closed_at` set; every exclusion query keys on `archived_at is null`, and UI/DTOs distinguish sealed via `closed_at`/`closure`.

**Why:** patients have no HIPAA right to erase the chart and state law forces multi-year retention, so a hard purge at day 7 was a compliance bug. Reusing `archived_at` means the existing partial unique indexes and the dependency write guard give the fences (same-phone re-signup makes a fresh row; late writes to a sealed chart are rejected) with no new triggers.

**How to apply:**
- Every new `patient_id` table must be classified: personal (explicit array inside the closure RPC), clinical (kept), or special. A static migration-parsing test enumerates the tables and fails on an unclassified name — when in doubt, clinical.
- A `closed` request under a legal hold is simply not claimable; only pre-closure rows park as `held`. Placing a hold must never flip a closed row.
- The "account closed" courtesy hint for an unlinked session (lookup in `patient_deletion_requests`) is best-effort: failures fall through to the normal 403, never a 502. Likewise the retention-years copy falls back to the default org policy on a policy read failure — explanatory copy must not take the diary state read down.
- Adding a column to a shared select (e.g. identity lookup gaining `archived_at=is.null`, inbox rows gaining a `patients?id=in.(...)` seal lookup) breaks route suites whose PostgREST fakes implement a small operator set or an allow-list of paths; run the FULL api suite once and teach the fakes (`is.null`, the new path), not the route.
- Live schema: a merged migration is not applied — push it through the management API and re-check advisors before restarting the API server.
