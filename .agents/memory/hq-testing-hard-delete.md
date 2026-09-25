---
name: HQ testing hard delete
description: Temporary non-compliant HQ override that erases an office or patient; what it deliberately leaves and how to prove it live.
---

**Rule:** The testing override is self-contained (own engine folder, router, web section, SQL function) so it can be removed in one go; never route the compliant offboarding / deletion-request / legal-hold flows through it.

**Why:** Owner asked for a temporary, explicitly non-HIPAA "wipe test data" tool that must be removable later without touching compliant lifecycles.

**How to apply:**
- Stripe runs BEFORE the SQL transaction (DB still knows the ids); a patient-subscription cancel failure aborts with nothing deleted; account-delete refusals are reported and rows still go.
- Sign-out list rows (`auth_session_revocations`) are the one deliberate leftover: opaque user/session ids that self-expire at the token horizon. Deleting them early lets unexpired tokens verify locally and hit provisioning routes that recreate rows.
- The DB-wide leftover scan (every public text/uuid `*id`/`*_ref`/email column via `query_to_xml`) is the proof of "nothing remains"; rerun it after adding any table keyed to a provider or patient.
- Live proof needs HQ billing mode = Test; it creates a real Stripe test connected account via the app's own create path (direct inserts are blocked by the connect identity trigger).
- `auth_sign_ins` has a unique session key but not usable for ON CONFLICT; stamp fresh codes with update-then-insert-if-missing.
