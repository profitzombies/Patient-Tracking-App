---
name: Patient purge lifecycle
description: Non-obvious traps when adding patient-initiated deletion/purge, consent gating, and data export on top of the Supabase patient schema.
---
Rule: a purge is a **service-only RPC that walks every table carrying `patient_id` in FK-dependency order, writes the tombstone FIRST, and is safe to re-run**; the worker records per-step outcomes so HQ can retry rather than guess.

**Why:** the schema has protective triggers that fight a naive delete:
- the patient identity write-barrier trigger must short-circuit on a **null** `patient_id` — detaching analytics rows (`SET patient_id = NULL`) otherwise fails the reconciliation lock lookup;
- the append-only analytics trigger needs an explicit **detach carve-out** (only `patient_id` → null allowed) or the purge can never finish;
- the purge uses `DELETE` (not TRUNCATE) so cascades and audit hooks still run — order tables children-first and retry the batch a few passes for late-arriving FK dependants.

**How to apply:**
- New patient-owned tables must join both the write-barrier protocol AND the purge enumeration; the API test enumerates `information_schema` columns named `patient_id` and fails on any table the RPC does not cover — keep that test authoritative.
- Roster/record tombstone lookups are keyed on **UUID-shaped ids only**; demo/seeded string ids never hit the tombstone table, which keeps the guided demo byte-identical.
- Grace countdown fixtures must ride the **real clock** (`Date.now()` offsets) — "Deletes in N days" is computed against device time, not the seeded anchor date.
- Consent is enforced at the server's `resolvePatient` choke point (every patient route refuses with `CONSENT_REQUIRED` until the current version is recorded; privacy/consent/deletion routes opt out). The client `/consent` redirect is UX only — never the gate. Mobile hydration treats that 403 as "fetch privacy, park on /consent, no outage notice", and the consent screen rehydrates after recording.
- Anonymous photo routes (menu/label scan) gate photo-analysis opt-out **only when a bearer is present**; signed-in clients must send the token, the demo stays tokenless. Code review rejected consent that was client-side only and an opt-out with no server effect.
- Keep consent admission ahead of onboarding admission in the entry ladder; the consent screen doubles as the pending-deletion keep/sign-out fork. A policy-bump re-prompt must seed the photo choice from the recorded value, never default it back on.
