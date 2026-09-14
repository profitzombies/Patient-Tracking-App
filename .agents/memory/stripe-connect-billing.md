---
name: Stripe Connect billing (office-collects, THINNR fee)
description: Durable lessons from building direct-charge Connect billing — sandbox key mismatch, first-invoice fee workaround, webhook claim semantics, price replacement idempotency.
---

**Two-sandbox key mismatch.** The Replit Stripe connection can hold keys for a sandbox where Connect is NOT enabled while the Connect client id (`ca_…`) lives in a different sandbox. Symptom: `accounts.create` / OAuth fail with "Connect not enabled" even though a client id exists.
**How to apply:** before any Connect e2e, hit `GET /v1/account` with the connector key and compare the account id with the sandbox that owns the client id; ask the user to re-key the integration or enable Connect + supply the matching client id. Do not mix keys and client ids across sandboxes.

**First-invoice fee cannot be exact.** Subscriptions created `default_incomplete` only accept `application_fee_percent` on the first invoice; the exact per-unit fee is applied by setting `application_fee_amount` on renewal drafts in `invoice.created`. First-invoice over-collection is refunded via an application-fee refund on the PLATFORM (no `stripeAccount` header) and the order snapshot must be corrected in the same step, or office-net reporting stays wrong.

**Webhook rows are a claim, not a log.** Insert-before-dispatch + "duplicate → 200" silently discards any event whose handler failed (Stripe's retry hits the unique conflict). Duplicates must re-check `processed_at`/lease and re-dispatch; only successful processing acknowledges with 200.

**Never archive-then-recreate a Stripe price under the same idempotency key.** Stripe replays the original (now inactive) price → subscription creation fails on the second checkout. Reuse when amount unchanged; create the replacement with a versioned key, then archive the old one.

**Connected-account events must be tenant-bound.** Resolve the record, then require its provider's `stripe_account_id === event.account` for connect-kind events; platform events never mutate connected records.

**Nest-mounted feature areas.** Wouter `nest` routes resolve `Link`/`navigate`/`Redirect` targets relative to the base — in-area targets must be base-relative (`/transactions`, not `/payments/transactions`), and `~/` for true root. Test harnesses must mount the area inside the same `nest` Route or they pass while the browser doubles the segment.

**Parallel builders skip demo data and tests unless briefed as hard requirements.** The signed-out demo persona and the vitest suites both had to be requested in follow-ups; put "demo dataset renders every screen" and "suite list" in the brief's acceptance criteria and verify with a browser pass before review.
