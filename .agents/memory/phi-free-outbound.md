---
name: PHI-free push and email
description: Vendor-bound push and email (Expo, Resend; no BAA) carry only generic copy and ids; rules for adding a new push builder or email template.
---
Rule: nothing that leaves through Expo push or the email vendor may pair a person with a medication, weight, finding, or product; lock-screen copy is generic ("Time for a dose", "A note from your coach", "Your order is on its way", "N patients need attention. Open the app.") and the in-app screen the deep link opens carries the detail.

**Why:** neither vendor signs a BAA, so any clinical wording in a push/email body is a disclosure. Earlier builders named the medication, the patient, and per-patient reasons.

**How to apply:**
- All email goes through the one send seam in api-server `src/email/transport.ts` (single vendor client, per-template PHI class, structured send log). Never call the vendor directly; tests swap the client with `__setEmailClientForTests` and must set the RESEND/CLAIM_EMAIL_FROM env in beforeEach because config is read per call.
- Every new template needs a PHI class in the templates lib `phi.ts`; the catalog lint runs on variable keys/labels (camelCase tokens), so pick keys honestly (`reasons` counts are fine, `patientName` outside claim/invitation is not). Full names are allowed only on the identity family.
- Both push sender paths wrap the client with `sendGuarded` (title ≤60, body ≤140, flat scalar data, forbidden key tokens like name/medication/weight/reasons/message/product/carrier). A refused message becomes a non-transient ticket error, so the row fails without retry. New push data must be ids + route only; keys ending in Id/Key are exempt from the token check.
- Staff digest rows snapshot `reasonCounts` (label+count), never `patients`; old rows with `patients` are ignored by the renderer.
- Mobile deep links resolve on kind + ids, so generic copy costs nothing client-side; add each new payload shape to `scripts/verify-push-notifications.ts`.
