# Remaining sandbox launch checks — 2026-09-20

**Launch remains blocked.** Genuine connected-account TEST runs found renewal
financial/reporting problems. These results do not authorize real payments.

## Method and safety

Reused `stripe-app-e2e-fixture.mts` and the existing run harness guards; added
`stripe-app-e2e-remaining.mts`. Explicit run authorization, test-key/platform
identity, Stripe balance mode, connected-account controller, scoped fixture,
suppressed outbound effects, and running API sandbox configuration were checked.
The account used has a full Dashboard: this is not no-Dashboard onboarding proof.

Payments used synthetic, non-deliverable contacts. Application payer emails were
blanked before confirmation. Recorded application email claims: **zero**.
Warehouse rows were local intents only; TEST lifecycle guards prevent transport.
Some renewal intents remained pending locally after direct Stripe refunds; this
is not evidence of any external warehouse submission.

The renewal customer used a real connected-account Stripe Test Clock. Clock
advancement generated scheduled invoices; assertions waited for application
state projected from real webhook delivery, with no locally signed replay.

## Results

| Check | Result |
| --- | --- |
| Initial subscription payment fee/net | Passed: charged 6,999 cents, application fee 4,599, Stripe fee 233, office net 2,167; checked against Stripe charge/application-fee objects |
| Authentication-required card | Genuine PaymentIntent reached `requires_action` / `use_stripe_sdk`; browser challenge completion **not tested** |
| Scheduled renewal | Invoice charged and application renewal order appeared, but financial correctness **failed**, below |
| Failed renewal | Attached `pm_card_chargeCustomerFail`, advanced clock, application subscription became `past_due` |
| Renewal recovery | Replaced default card and paid failed Stripe invoice; paid application renewal appeared. This proves webhook recovery, **not the app Retry button** |
| Public payment-link double submit | Two concurrent identical initialization requests created **different orders and intents**. Neither was confirmed. Do not claim duplicate prevention |
| Patient cart interrupted retry | Separate authenticated verification preserved one cart/order/intent across concurrent calls and discarded-response replay, but exposed an authentication-required handling defect; see linked report below |

## Confirmed renewal defects

1. Renewal Stripe invoice included product 5,999 cents, shipping 1,000 cents,
   and a **−4,999-cent shipping adjustment**, producing a 2,000-cent total.
   This requires shipping-line selection/rating investigation; no correct
   renewal total is asserted here.
2. Application renewal recorded application fee **5,119 cents** and office net
   **−3,207 cents**. Stripe actually collected application fee **1,912 cents**
   plus processor fee **88 cents**. The local fee/net snapshot does not match
   Stripe (actual remaining net zero). Both scheduled and recovered renewals
   exhibited this discrepancy.
3. Paid renewal order had a Stripe charge and invoice but
   `stripe_payment_intent_id = null`. App refund rejected it as
   **“Order is not refundable.”** Cleanup therefore required a direct,
   TEST-only Stripe refund by verified charge ID.

## Cleanup and evidence

All three test-clock runs were unwound: subscriptions canceled, charged amounts
refunded, unpaid invoices voided and clocks deleted. The first script iteration
had an SDK argument-placement error; it was corrected and cleanup retried before
the successful run. Evidence is in private local state:
`stripe-app-e2e-remaining.json`, with prior iteration evidence retained separately.
The final successful run spanned 21:10:22–21:12:03 UTC.

After the browser worker confirmed removal of its patient-owned records and
released the shared provider, guarded `cleanup-financial` completed. It verified
every remote subscription canceled and every charged amount refunded, refunded
remaining application fees, deleted surviving test customers, archived the
fixture's plan/shipping products and all 12 associated prices, then removed
local fixture rows. Stripe's immutable test objects and webhook audit records
remain as history.

Final scoped readbacks: **zero** providers, connected accounts, office prices,
payment links, payers, orders, subscriptions, ledger entries, shipments,
customer-email claims, warehouse submissions, and named fixture Test Clocks.
The private active fixture state file was removed. No real money was charged.

## Separate patient checkout findings

See [patient checkout verification](patient-checkout-verification.md). A genuine
authenticated patient session produced HTTP 402/409 for concurrent checkout and
402 on same-key replay, with exactly one cart, order, and PaymentIntent. Stripe
reported `requires_action` but the app reported `failed`: another launch blocker.
This provides discarded-response replay evidence, not completed browser 3DS or
a physical socket interruption. The browser fixture was separately cleaned
before this report's provider cleanup.

Live Connect client ID remains missing, and no-Dashboard onboarding still needs
human completion. Neither is passed or bypassed by these sandbox results.