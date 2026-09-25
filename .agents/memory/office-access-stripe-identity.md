---
name: Office access Stripe identity & safe replacement
description: How office access customers are labeled in Stripe and how bank/card replacement stays safe (detach, staged bank, no delete).
---

- Replacement is replace-only: DELETE answers 405; the old method is detached after the new one saves; the primary card is the customer's default.
  **Why:** the owner saw "Unnamed customer" and replaced cards lingering in Stripe.
  **How to apply:** any new instrument path must retire through the shared detach helper, which waits while a charge on that slot is processing.
- Stripe REFUSES `paymentMethods.attach` for a us_bank_account still awaiting microdeposits. A SetupIntent created with `customer` attaches it itself once verified. Skip attach (and PM update) for pending banks, and cancel the SetupIntent when a staged bank is dropped so a late verification can't attach a 4th method.
  **Why:** fake-Stripe unit tests passed while the live Test run returned 502. Only the live replace harness caught it.
- Only stage a replacement bank when the bank it replaces is verified. The verified bank stays chargeable until the staged one verifies.
- Holder name/email: the web form hides Stripe's own name/email fields and sends billing_details itself. The server fills blanks from the office (office name → owner name; owner email).
- Identity sync is fire-and-forget on practice-details / HQ account edits. The back-fill script defaults to dry run and only detaches untracked methods more than 1h old (so it doesn't race an in-progress save).
- Live proof: `pnpm --filter @workspace/api-server run test:office-access-replace-live` (Test mode only; it refuses otherwise and cleans up its customer).
