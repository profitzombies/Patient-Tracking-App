---
name: Staff attention alerts
description: Design rules for provider-facing "patients need attention" alerts (bell, digest, email, staff push) and the seams that were easy to get wrong.
---
# Staff attention alerts

**Rules**
- One shared server evaluator classifies patients; the roster, the bell, the digest and the email all derive from it. Never add a second "needs attention" rule set on a client. Unknown activity (aggregate row missing) yields NO reasons, never zeros.
- Staff deliveries live in their own tables (staff outbox, staff push tokens, staff preferences, office digests, per-user seen rows), not in the patient outbox. **Why:** the patient outbox has a hard patient FK plus identity write guards; staff rows are keyed by auth user id and would either violate the FK or drag staff writes under patient reconciliation locks.
- Opt-outs and quiet hours are applied by the *sender* at send time (reason persisted on the row), not at enqueue. **Why:** HQ can inspect why a recipient did not get mail; enqueue-time filtering leaves no trace.
- The digest email renders from a snapshot stored on the outbox row (office name, recipient name, patient lines) at enqueue time so the message equals the digest that was generated. All transactional mail must go through the shared email-templates library shell — the first version sent a bare `<p>` email and the user rejected it on sight. New templates must be appended to BOTH the id list and the catalog in the same order (a catalog test enforces this).
- HQ drill-in is read-only for seen state and personal preferences (403), even with `?office=`; HQ without `?office=` gets the scope resolver's 400, which is acceptable.
- Demo persona seen state must persist in sessionStorage per office scope, or the bell count resets on every navigation.

- Any JSON snapshot that names a patient (digest items, outbox payloads) must carry `patientId` AND be scrubbed by the patient-delete trigger, plus join a retention RPC. **Why:** the purge RPC only discovers tables with a `patient_id` column; code review rejected the first cut for leaving PHI in JSON after deletion.

**How to apply:** any new staff-facing signal or channel joins the evaluator + staff outbox + template library; do not bolt on ad-hoc fetch/email code. Running the digest job against the dev database sends REAL email to real office owners (Resend is live) — say so before triggering it.
