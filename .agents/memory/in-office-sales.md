---
name: In-office sales (card form + QR prebuilt carts)
description: Durable rules for staff-initiated checkout and single-use prebuilt carts on the public pay page; read before touching billing/prebuilt-carts, billing-office-sales, or the sell dialog.
---

**Rule:** staff sales and QR carts reuse the patient cart checkout (planCart/checkoutCart) unchanged; the browser creates a PaymentMethod on the connected account with a deferred PaymentElement created with `paymentMethodCreation: 'manual'` — without that flag real Stripe rejects `createPaymentMethod({ elements })` while every stub passes. The react-stripe stub now enforces the flag.
**Why:** the first browser pass failed only in the real browser; suites were green.

**Rule:** every prebuilt-cart transition is a PostgREST CAS update filtered on the expected status (+ attempt/session hash/expires_at) that must touch exactly one row; zero rows → re-read and answer with the terminal error. Revoke/lock/expire must win races against verify/checkout.
**Why:** an unconditional `status='verified'` write after a session check could resurrect a revoked cart and charge it.

**Rule:** paid is derived on read: all expected quote groups have a paid order for the current cart id. Mixed paid/failed stays `checkout` with `partial: true` and per-order statuses; never call a partly settled sale "complete" or "no payment completed".

**Rule:** `checkout_attempt` (→ new derived cart id) bumps only on a definite card failure (returned `failed`, or BillingCartError on `payment_method_id` / 402) and only when nothing in the cart is paid; ambiguous errors resume the same cart id and idempotency key.

**Rule:** patient-less carts bind the payer by the VERIFIED phone (office + patient_id null + E.164); never resolve a guest payer by an unverified email.

**Rule:** the pay-page session hash survives the paid transition (status polling after 3DS needs it; it only reveals order numbers/totals) and is cleared on revoked/expired/locked; it dies with the cart's `expires_at`.

**Operational:** a live sale takes 15-40 s (customer + invoice + subscription); browser testers must be told to wait up to 60 s or they close the dialog on a sale that succeeded. Staff-role members may sell (auth `sell` option) but the Payments area itself stays owner/admin — testers reach the dialog through the patient record. Live-office e2e fixture: `team_members` accepts `activation_status='unactivated'`, `patients` needs explicit `created_at/updated_at`.
