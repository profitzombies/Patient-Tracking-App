---
name: Patient edit history live proof
description: How the History tab is proven against the live Supabase project and a browser; traps for staff sign-in fixtures (medication ids, second-factor enrolment, cleanup tables).
---

**Rule:** the edit-history chain is proven by `test:patient-edit-history-live` in thinnr-operations (disposable HQ admin + office owner + claimed patient → weight recorded/corrected/removed, medication added/stopped → owner, family-filtered, HQ `?office=` reads → staff ZIP and patient self-export both carry `edit-history.json`). `--keep` leaves fixtures for a browser session, `--cleanup` removes them.
**Why:** SQL, route-fake and RTR suites never touched the real RPC chain; the first live run found nothing wrong in the product but two harness traps below.
**How to apply:** extend this harness (not a new one) when adding a history family; assert only against the harness's own rows (shared dev DB).

Traps:
- POST `/office/patients/:id/medications` mints its own id; a client-supplied `id` is ignored, so read the id from the response before PATCHing.
- Staff code login in a browser always hits the SMS second factor for owners/HQ (policy default). Recipe: tester restarts the API with BOTH `CLAIM_EMAIL_DELIVERY_MODE=dev` and `CLAIM_SMS_DELIVERY_MODE=dev`, enrols a fake 555 phone on the "Add a sign-in phone" step, reads both codes inline. That writes `staff_second_factors` (staff_ref = provider_id / hq membership id) and phone-keyed `claim_verifications` rows — cleanup must delete them too.
- "Removed medication" in the product is the office Stop action (stopDate null → date); there is no medication delete route. A real `delete`-kind history row comes from DELETE weight.
- Staff record reads are audited into `admin_audit_events` (no separate record-access table); cleanup by provider_id/actor/target covers them.
