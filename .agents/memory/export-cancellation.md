---
name: Export job cancellation
description: How staff cancel of a queued/running data export works and the traps around it (cooperative worker stop, ready-flip CAS, terminal status, live suite gaps).
---

# Export job cancellation

**Rule:** cancellation is cooperative and terminal. A queued row flips straight to `cancelled` (CAS on `status=queued`). A running row only gets `cancel_requested_at` stamped; the worker re-reads the row (throttled) at every file/part boundary and, on seeing the flag, deletes everything it wrote and marks the row `cancelled`. A cancelled or failed build never keeps files. The worker's "ready" flip must be conditioned on `status=running AND cancel_requested_at IS NULL`; a lost flip means "delete files, mark cancelled".

**Why:** the archive can run for minutes and produce GB; the only safe stop point is between parts (a half-written ZIP part is useless). Making cancel-request idempotent (200, no re-audit) and finished/failed/expired/cancelled → 409 keeps the UI's optimistic double-click harmless. Row re-read failures must *continue* the build, never abort it, or a transient DB blip cancels legitimate exports.

**How to apply:**
- Any new long-running job that writes parts must adopt the same checkpoint hook rather than polling the row on its own timer.
- Cancelled rows past `expires_at` present as `expired` in the DTO; the retention sweep flips then prunes like any other terminal row.
- Web: the cancel call rides the re-auth-aware office client with **no** fresh-code gate (cancel is a stop, not a disclosure); UI shows "Stopping…" (aria-disabled, no second POST) until the next poll returns `cancelled`.
- Audit both actions ids-only (`patient_record_export_cancelled` targets the patient, `data_export_cancelled` targets the export) and add them to every allowlist (server audit-events, route test lists, web audit labels, OfficeAudit filter) — the audit page test enumerates labels.
- The live `test:exports` script (polite-pollers-web) predates the staff fresh-code gate and now fails on POST /api/exports with `reauth_required` on main; that is not a signal about export changes.
