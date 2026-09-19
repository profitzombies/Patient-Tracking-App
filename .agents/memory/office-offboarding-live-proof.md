---
name: Office offboarding live proof
description: How the live offboarding harness drives the HQ stepper against the shared Supabase project, and the traps found on the way (empty parts checkpoint, consent gate, staff 403 shape).
---
- Live suite: `pnpm --filter @workspace/thinnr-operations run test:office-offboarding-live` (HTTP-driven, needs the api-server workflow up at STAFF_API_BASE, default http://localhost:80). Disposable HQ admin + office owner + claimed patient, all real GoTrue users; cleanup in `finally` (ledgers via management API in replica mode, entities via PostgREST with FKs enforced).
- HQ fresh-code proof without an email code: insert an `auth_sign_ins` row for the HQ user with `session_id` = the JWT's session_id claim and `code_verified_at` now. That is the same stamp the re-auth sheet writes.
- **Trap:** `data_export_parts_valid` accepts null or a 1–500 element array, never `[]`. The bundle builder's very first checkpoint must send `parts: null`; route/worker fakes must reject empty arrays or the live project fails every real office bundle with a 400 the fakes never see.
  **Why:** the bundle suite passed green while every live bundle flipped to `failed` on first commit.
  **How to apply:** any new checkpointing writer against data_exports parts; mirror SQL checks in fake DBs when they gate the first write.
- Live shapes that differ from what the route fakes suggest: a fresh-claimed patient hits `403 CONSENT_REQUIRED` on data routes (identity resolved, not program_ended); the office_offboarded staff 403 carries only `error` text ("...program has ended...") and no `code`.
- Never call staff `/auth/login/start` before offboarding in a live run: the directory would match and a real email goes out. After start it must be neutral with zero `claim_verifications` rows.
- Purge within the run: after complete, backdate `patient_deletion_requests.retain_until` (status closed) and `patients.record_retain_until`; the dev privacy worker (30 s) purges and the certificate CSV shows the tombstone within ~1 min.
