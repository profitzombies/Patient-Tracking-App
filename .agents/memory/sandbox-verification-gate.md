---
name: Sandbox end-to-end verification gate
description: How a Stripe TEST checkout is allowed to reach the WarehouseCraft sandbox tenant and email a designated inbox without loosening the live/test isolation; runner pitfalls.
---

**Rule:** Sandbox (Stripe test-mode) orders never submit, sync, or email unless BOTH hold: the warehouse tenant mode is `test` AND a `billing_sandbox_verifications` row names that exact order id (short expiry). There is no env knob that widens this; live tenant + test order and unflagged sandbox orders stay skipped/held, live orders stay held on a test tenant.

**Why:** The e2e proof needed one real order through the whole chain, but a global "allow sandbox" switch would let demo/test carts reach a real warehouse the day the vendor cuts the same credentials over to production.

**How to apply:**
- Read the allowance fail-closed (store error = not allowed) and re-check it at every seam separately: submission drain, status sync, `notifyOnce` customer emails, ledger retry drain, patient notices. Receipts and manual `sendAgain` stay live-only.
- The vendor sandbox will NOT ship an order by itself and its order API rejects `OrderStatus: "Shipped"` from the client (406) — tracking appears only after a NovEx person processes the sandbox order. Design waits as resumable (`wait` exits non-zero, re-run later), never as one long blocking run.
- Financial writes over the patient API must echo `X-Billing-Scope: <mode>:<platform acct>` from the quote response or they 409 as "payment mode changed".
- Office storefront quotes refuse prices under the break-even minimum even when an office price row exists; a synthetic product priced at its floor must have its office price raised to `breakEvenMinimum` first.
- Synthetic product hidden from real offices: floor below break-even + no office price row → `resolveOffering` is null; assert this at creation.
