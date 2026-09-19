---
name: Record-access audit (staff reads of patient records)
description: How "viewed" audit events for staff/HQ reads are deduped, where they must NOT be written, and the live-DB traps met while proving the RPC.
---

**Rule:** staff/HQ reads of a patient record write audit events through one read-audit helper whose dedupe is decided in SQL (actor + `action:targetKind:targetId[:facet]` window upsert, then conditional insert, in ONE RPC). The process-side cache only short-circuits windows the server already reported open; it never decides on its own.
**Why:** the API runs several instances; a process-local window would emit one event per instance, and a client-decided window is client-side tracking (out of scope by policy).
**How to apply:** new read surfaces call the fire-and-forget helper with the staff actor; patient self-reads pass no actor and write nothing. Test fakes for the RPC must return `window_started_at` = now — a past date looks expired and a second call fires.

- **The helper must not import runtime values from the admin audit writer module.** **Why:** many route suites factory-mock that module; a runtime import turned into 502s across unrelated suites. Import types only.
- **Live audit table facts unit fakes hide:** `admin_audit_events.provider_id` is a real FK to providers (a made-up office id fails 23503 and rolls back the whole RPC), and the table is append-only by trigger — clean-up of smoke rows needs `set_config('app.audit_retention_run','on',true)` in the same management-API request.
- **Patient copy vs HQ copy:** the patient export's "who viewed my record" lists date, office name, role and thread only; HQ's deletions drill-in adds actor names/ids. Keep the two shapes in one module so the redaction stays in one place.
- **RTR suites that render the office patient record must answer `/coach-conversations` and `/coach-memories`** (hyphenated) before any catch-all `/api/office/patients/` matcher, or the coach review panel crashes on `undefined.length`.
