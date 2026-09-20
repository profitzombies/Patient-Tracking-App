# Patient checkout launch verification

## Genuine browser cold start

The coordinating browser tester reported a successful cold start on the direct
Expo origin at **`/shop`** (not `/thinnr-mobile/shop`):

- Genuine temporary Supabase patient session, real patient/profile/consent rows;
  no mocked authentication, profile, or consent responses.
- Shop → cart → checkout reached the Stripe form with its sandbox label.
- Real hydration requests returned HTTP 200.
- Reload preserved the authenticated account and cart.
- Browser stopped before submitting payment. It created no payment intent.

Session material was delivered through a private mode-0600 local fixture file,
not through chat or a publicly served helper.

## Authenticated duplicate submission and discarded-response retry

After the tester released the fixture, the server harness used the patient's
genuine bearer session, the exact TEST billing-scope header, a distinct UUID
cart key, a real quote, and Stripe's `tok_threeDSecure2Required` test method.
The patient's payer email was blanked and phone set null before checkout.
No authentication challenge was completed.

Observed results:

| Check | Result |
| --- | --- |
| Two concurrent identical checkout requests | HTTP 402 and HTTP 409 (checkout still processing) |
| Same-key replay after deliberately discarding first responses | HTTP 402 |
| Persisted patient cart count for the key | 1 |
| Persisted order count for the key | 1 |
| Associated Stripe PaymentIntent count | 1 |
| Stripe PaymentIntent state | `requires_action` |
| Replay returned the same order | Yes |
| App checkout result | `failed` |
| App order state | `failed` |
| Provider customer-email claims | 0 |

**Partial proof, not an end-to-end pass:** the concurrent submission and replay
did not duplicate the cart, order, or PaymentIntent. However, the application
returned `failed`/402 while Stripe's intent required authentication. The harness
correctly failed its expected `requires_action`/200 assertion. Investigate the
authentication-required result handling before launch.

This exercised a deliberately discarded response followed by replay, not a
physical socket interruption or browser payment challenge.

Earlier harness attempts omitted `X-Billing-Scope`; the application correctly
rejected them with 409 before creating any cart/order/intent. Those attempts
are harness setup errors, not product failures.

## Cleanup and ownership

The fixture reused the existing synthetic sandbox provider without owning it.
Cleanup voided the unpaid invoice, deleted the test customer, removed the
throwaway Auth identity and patient-linked rows, and deleted the private session
file. No successful charge or refund was necessary. Unattached test payment
method objects and immutable Stripe test history may remain; no payable invoice
or renewable subscription was intentionally left behind.

Read-back verification returned HTTP 200 and zero rows for this patient's
patients, billing_orders, billing_payers, billing_carts, and patient_consents
queries. The shared synthetic provider still existed and was not deleted.

Reusable harness:
`artifacts/api-server/scripts/patient-checkout-browser-fixture.mts`.
Sanitized local retry evidence:
`/tmp/thinnr-patient-checkout-retry-evidence.json`.