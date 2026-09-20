# Live Stripe read-only verification

## Status

**Blocked — not executed.** The authoritative Development environment snapshot
reported `STRIPE_LIVE_CONNECT_CLIENT_ID` as absent. The Test client ID is
present, but it is mode-specific and is not a substitute for the Live client
ID. The subsequent secure request for the Live client ID was declined by the
user. The live review therefore remains blocked; do not repeat the request
unless the user chooses to resume it.

No live Stripe API request was made, and no charge, account activation,
settings change, terms acceptance, OAuth authorization, or webhook endpoint
registration was attempted.

## Reusable verifier

Run `artifacts/api-server/scripts/verify-stripe-live-readonly.mts` only after
the Live Connect client ID and the other Live environment values in
`LAUNCH.md` are available to the process:

```sh
pnpm --filter @workspace/api-server exec tsx scripts/verify-stripe-live-readonly.mts
```

The verifier fails closed when the Live client ID is absent or malformed. It
uses the application's env-based `getStripe("live")` path; it does not read or
migrate connector credentials. It prints no key, client ID, account ID,
webhook URL or ID, redirect query string, or balance amount.

Its network operations are limited to:

1. authenticated `GET /v1/account`, including comparison with the configured
   Live platform account;
2. authenticated `GET /v1/balance`, checking Live mode without printing
   amounts;
3. authenticated listing of webhook destinations, comparing the configured
   production origin and required events from `BILLING_WEBHOOK_EVENTS`; and
4. an unauthenticated, no-follow `GET` of Stripe's OAuth authorize endpoint.
   It does not follow the redirect, submit consent, exchange a code, or accept
   terms.

The process exits nonzero if any check fails. Its JSON result always records
`writes_attempted: 0`.

## Evidence boundaries

A passing run will prove that:

- the supplied Live credentials authenticate as the configured platform;
- Stripe reports Live mode and allows read access to account, capability, and
  balance metadata;
- a matching enabled webhook destination is visible for each expected Live
  URL and includes all required event names; and
- the Live Connect client ID has the expected shape and Stripe accepts the
  initial authorize-page request.

A passing run will **not** prove that:

- Stripe delivered an event to this deployment or the application accepted
  its signature;
- the Connect destination listens to events on connected accounts, because
  that source-scope setting is not reliably returned by the endpoint-list
  response;
- the OAuth redirect is registered end to end, consent succeeds, or a
  connected account can complete onboarding;
- the platform or a connected account is operational for a real payment; or
- live receipts, fulfillment, refunds, renewals, payouts, disputes, or
  reconciliation work.

Delivery and Connect source scope still require read-only review of Stripe's
Dashboard delivery evidence. Real payment and onboarding checks remain
separate, explicitly authorized launch activities.