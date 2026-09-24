---
name: Office access subscription engine
description: How THINNR bills offices for dashboard access on its own platform Stripe account, and the rules that keep that billing correct.
---

THINNR has two independent money directions. Everything in `billing_*` that moves a
patient's money runs on the OFFICE's connected Stripe account; the office's own access
subscription runs on THINNR's PLATFORM account. Webhook handlers therefore act only when
the event carries no connected account — the same event type on a connected account
belongs to the other direction entirely.

**No Stripe Subscription or Invoice objects exist for access billing.** The engine creates
PaymentIntents directly and drives its own dunning from the job tick.
**Why:** Stripe Smart Retries and Stripe dunning cannot be reliably disabled per
subscription, and two retry engines on one debt double-charge or contradict each other.
**How to apply:** any future work on access billing (plan changes, proration, tax) must
stay on direct PaymentIntents; reaching for Stripe Billing re-introduces the second
retry engine.

**Access state is derived from dates, never trusted as a stored flag.** The stored state
column is a cache; the server re-derives it from lifetime / paid_through /
included_period_ends_at / grace clocks on every pass, and only elapsed grace may newly
produce "restricted".
**Why:** a flag drifts the moment a webhook, a job tick and an HQ override race; a
derivation is re-checkable and self-heals.
**How to apply:** a future paid-through or grace column must be part of the derivation,
not a new independent flag. A future paid_through outranks an open grace clock — a
payment that lands during recovery clears the restriction by itself.

**The grace clock starts at the failure NOTIFICATION, not the charge date.** An ACH debit
can bounce days after it was submitted; stamping the clock from the original charge would
hand the office a recovery window that had already expired.

**Charging is claimed in SQL before Stripe is called.** One advisory-locked RPC per
subscription refuses a period that already has a succeeded attempt, refuses while an
unsettled ACH attempt is still `processing`, and treats a named recovery cycle that
already ran as a replay.
**Why:** the billing pass, a retry and a webhook-driven re-run can all decide the same
period is owed; the claim is the only thing standing between that and a double charge.
**How to apply:** never add a charge path that inserts an attempt row without claiming
first, and keep an ACH `processing` result stopping the waterfall — falling through to a
card while a debit is in flight is exactly the double charge.

**Duplicate cards are rejected on Stripe's fingerprint, not last4 + expiry.** The same
physical card re-added through a wallet or a reissued number shares the fingerprint but
not the digits, and a "backup" card that is the primary card is not a backup at all.

**Access rows are Stripe-scoped, so any route that touches them needs a billing
identity — including routes outside the /api/billing tree.** The billing store throws
"Billing identity is required." (HTTP 503) unless the request ran inside the
identity middleware's path match.
**Why:** HQ office-access endpoints were mounted under an /api/hq path; every unit test
mocked the store, so the 503 only appeared against a real server.
**How to apply:** when adding a billing-backed surface on a non-billing URL, extend the
identity middleware's path match at the same time, and prove the routes against the
running server rather than trusting store-mocked suites.
