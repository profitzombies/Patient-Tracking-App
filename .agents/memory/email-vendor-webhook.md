---
name: Email vendor delivery webhook
description: How Resend delivery/open/click events reach the customer-email ledger and the HQ outbox, and the design rules that keep the page honest.
---

**Rule:** vendor events land in an identity-free inbox table keyed by the webhook delivery id, then get copied onto the ledger row by vendor message id; unmatched events are never dropped, a tick-driven job re-links them once the send finalises. Delivery facts are denormalised onto the ledger row as first-seen timestamps (last_event only advances forward).
**Why:** the vendor can post `sent`/`delivered` before the send transaction has written `vendor_message_id`; idempotency must survive replays and out-of-order arrival.
**How to apply:** any new outbound email channel must record the vendor message id on its ledger row, or its events stay unmatched forever.

- **"Tracking not enabled" beats zeros.** Tracking state = secret configured AND at least one event ever seen; it rides the list response (`summary=1`) because the outbox page's permission set differs from System health. Opens are pixel-based; say "indicative" wherever they show.
- **Only Super Admin/Admin pass the HQ Payments gate**, so `canWrite` is always true inside it — there is no "HQ viewer" persona for payments suites; test refusal with a Clinical role instead.
- **Filter changes replace-navigate and drop the cursor; paging pushes** so Back returns to the previous page. A mutation run proved the RTR suite catches both.
- Unconfigured secret → 503 without counting; bad signature → 401 and counted in a singleton health row (UTC-day tally); unknown event types → 200 ignored.
- Setup note for the user lives in `docs/email-delivery-tracking-setup.md`.
