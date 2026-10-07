---
name: Office patient groups
description: Staff-defined roster groups (office-scoped labels) — scope rules, roster filter integration, demo parity, live-proof fixture lessons.
---

# Office patient groups

**Rules**
- Groups are operational labels only (no clinical content), office-scoped, visible to every active teammate, read-only for HQ drill-in (HQ reads need `?office=`; HQ writes are 403 by design, not a bug).
- Member responses are nested: `{ membership: { groupId, patientId, added|removed } }` — client types and harnesses must read `membership.added`, not a top-level flag.
- Roster rows and the patient detail carry `groupIds`; the roster filter is a client-side predicate over that array (unknown-group conditions are pruned only once the live group list is ready, so a slow load never drops a URL filter).
- Group tags render in office order (name-sorted), not insertion order.
- The roster route now reads the membership table: any API suite whose fake backend reaches `/office/roster` needs a `patient_group_members` stub (empty array is fine) or the roster returns 502.

**Why:** staff want employer cohorts and clinic-day lists without touching program facts; keeping groups off the clinical record keeps them out of PHI exports and patient-facing surfaces.

**Live-proof fixture lessons (throwaway office)**
- A bare `providers` row sits behind the practice-setup gate: every office route 403s with "The practice owner must complete setup…" unless the office's `practice_launch` row carries `setup_override_at` (HQ waiver). Upsert it with `required:false`.
- Fake backends that return `{required:false}` without `setup_override_at` fall through to the billing-mode lookup (`billing_mode_state`) and 502 — stale suites from before the gate need the waiver field.
- `admin_audit_events` orders by `occurred_at` (there is no `created_at`); cleanup of append-only ledgers needs the management API with `session_replication_role = replica`.
- Alert-dialog stubs in RTR suites must forward props on `AlertDialogDescription`, or the "N patients" confirm copy is invisible to assertions.

**Migration rollout lesson (2026-10-07):** a task environment that predates the dev/prod split applied this migration with the ref derived from `SUPABASE_URL` — which was PRODUCTION — and the first live proof ran there too (fixtures cleaned up; verified zero leftovers). Any table the roster or detail route joins must be enrolled in `scripts/apply-coach-migrations.mjs` (ledger receipt + postcondition) in the same task, or a publish against an unmigrated project breaks every office's roster. Enrolling an already-applied idempotent migration is safe: the runner re-runs it as a no-op and records the receipt.

**How to apply:** when adding another office-scoped label or any new column read by the roster route, extend the roster fakes in every API suite that calls `/office/roster`, keep HQ writes refused server-side, and reuse the live harness (`test:patient-groups-live`) as the template for office-scoped proofs.
