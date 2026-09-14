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

**Re-keying the Stripe connection strands webhook registration.** Saved `billing_webhook_endpoints` rows only prove an endpoint existed on the account connected when they were written; a new account has zero endpoints while startup short-circuits on the saved row and the stored secret is one the new account never issued. Startup must `retrieve` the saved endpoint id and re-register on `resource_missing`. Verify by listing `/v1/webhook_endpoints` with the current key — endpoint ids carry the account suffix.
**Probing a fresh sandbox:** `accounts.create` with the controller combo answers "You can only create new accounts if you've signed up for Connect" until Connect is enabled; the OAuth authorize URL returns 200 for registered redirect URIs and 400 for unregistered ones (a cheap client-id + redirect check that needs no user click).

**Invoice items take inline amounts, not `price_data.product_data`.** `invoiceItems.create` rejects the Checkout-style `price_data.product_data` shape ("Received unknown parameter"); use `currency` + `unit_amount_decimal` + `quantity` + `description` (+ top-level `tax_code`). Probe unfamiliar param shapes against the sandbox before wiring them.

**Stripe expansion depth is capped at 4.** `subscriptions.create({ expand: ["latest_invoice.payments.data.payment.payment_intent"] })` is 5 levels and fails; create without expanding, then `invoices.retrieve(latest_invoice, { expand: ["payments.data.payment.payment_intent"] })`.

**Only `resource_missing` means "rebuild the mirrored object".** Product/price/customer ids live on the account that created them; on reconnect they answer `resource_missing` and must be recreated there (idempotency keys include the account id). Any other error (timeout, 429, 5xx, auth, or a test mock missing the method) must be re-thrown — a bare `catch {}` around `retrieve` created duplicates and hid a broken mock for weeks.

**Reading a paid order must not require charge capability.** Detail/fulfillment serializers read the connected-account row directly; only checkout/refund paths go through the charges-enabled gate, otherwise one paused office blanks the whole HQ shipping queue.

**Public order-status ids must be UUID-checked before hitting PostgREST**, or a pasted order number becomes a 503 ("temporarily unavailable") instead of a 404.

**E2E recipes.** In-app embedded onboarding is blocked by hCaptcha (needs a human); a blank Standard OAuth test account cannot charge. For automation, create a platform-controlled account with `controller.fees.payer=application`, complete it with test identity data, and PATCH the office's `billing_connected_accounts` row to it. Renewals: create the customer under a `test_clock`, subscribe, advance 28d+2h, wait for `invoice.paid`. stripe-node `retrieve`/`del` are `(id, params, options)` — pass `{}` before `{ stripeAccount }`. Fixture teardown must delete refunds/disputes/ledger by order id and `billing_account_events` by provider before providers.

## Seeding real test-mode activity for a live office (Sept 2026)
- In-app Connect onboarding is hCaptcha-blocked for scripts. Recipe that works: create the connected account via the Stripe API with `controller.requirement_collection: "application"` (+ `fees.payer: "application"`, `losses.payments: "application"`, dashboard none), pass test identity data (`address_full_match`, tax_id 000000000, person dob 1901-01-01 ssn_last_4 0000, `owners_provided` flags, tos_acceptance, test bank routing 110000000 / 000123456789), insert the `billing_connected_accounts` row yourself, then `POST /billing/office/connect/sync?office=<id>` as HQ until charges+payouts flip on (about a minute). **Caveat:** with `fees.payer: application` the office's Stripe fee column reads $0, so office net = collected − THINNR fee.
- HQ can drive every office write with `?office=<provider_id>` (prices, links, refunds); public checkout returns a `client_secret` and the PaymentIntent is confirmed on the connected account with a `tok_visa` payment method (`connectedOpts(acct)`); webhooks flip orders to paid in ≈10 s.
- Throwaway HQ login for scripts/testers: an `hq_memberships` row needs `status: active` + `activated_at` + a non-`super_admin` role (owner-role constraint), and email delivery is LIVE in this workspace (`CLAIM_EMAIL_DELIVERY_MODE=live`), so the tester must restart the API with `CLAIM_EMAIL_DELIVERY_MODE=dev` to see the inline code, then restart clean. Delete the membership + auth user afterwards.
- HQ provider-detail endpoint hydrates recent orders with two bulk `in.(…)` reads (items by order_id, payers by id); the older list routes still bundle per row — reuse the bulk pattern for any new page of orders.

## HQ payments UI + billing email lessons (Sept 2026)
- **Charts are pure SVG drawn in real pixels.** Width comes from a ResizeObserver (fallback 640 under react-test-renderer); a fixed viewBox stretched to the card scales text ~1.6× on wide screens and was rejected as "zoomed in". Readout is a card anchored to the active point (above, or beside it at the top of the plot); below ~480px it becomes a row under the plot. Axis labels are spaced by pixels, never by a fixed count.
- **"Today" hourly revenue** is a separate endpoint keyed by the viewer's IANA zone (`?tz=`, default New York); the server computes the local-day UTC window (DST-safe) and buckets by local hour. Demo data pins the anchor day at 4 PM; never derive from the clock.
- Heritage `BTN_*`/`INPUT_CLASS` constants carry no sizing; `SectionCard` children are unpadded; `~/` on a wouter Link escapes the `/admin/payments` nest; `/admin/team?member=` opens the profile dialog.
- Team member id ≠ auth-user id: any PostgREST `select` must list every column the mapper reads (mock only the selected columns in tests).
- Product images live outside the storage reconcile prefixes; the status/active lockstep CHECK must follow the backfill in the same migration.
- Settings optimistic concurrency: a dirty form keeps the version it was filled from (server moves on → notice + discard, save gets 409); only an untouched form or the editor's own save advances the baseline. Reorder requests serialize client-side and read archived ids from a current ref.
- Billing emails ride the shared `@workspace/email-templates` shell (ids in the `/email` studio; `?template=<id>` deep-links a proof). Items are one multi-line variable (`label · amount`); timestamps in America/New_York; from name "THINNR Weight Loss" derived from the `CLAIM_EMAIL_FROM` address only for billing mail. Everything that prepares a receipt (including building links from the public origin) must sit inside the never-throw boundary.

## Office (provider) payments area mirrors HQ
- Office pages reuse the HQ reporting code with the provider pinned server-side; query `provider_id` can never override it, HQ drill-in rides `?office=` through the office scope middleware. The office "today" endpoint reuses the HQ today shape and its `profit_cents` line means the **office net** — UI labels it "Office net", never "Profit".
- Refund and dispute rows have no provider column. Scope them by resolving their `order_id`s against provider-filtered orders (chunked id lists, bounded by the date window), not by starting from the office's whole order history — otherwise a same-day refund of an older order is dropped and mature offices overflow the URL.
- Fulfillment queues (HQ and office) show only `paid`/`partially_refunded` orders; a disputed to-ship order is intentionally absent. Do not treat that as a bug in tests.
- Office demo billing is pinned to Oct 10 2026 (HQ billing demo: Sep 24 2026); both never derive from the clock.
- The route-test PostgREST mock must honour `gte/gt/lte/lt` operators, or date-window bugs pass silently.
- Shared payments tables (ActivityTable etc.) need `relative` on any `th` holding an `sr-only` label, or the phone page widens past 390px (see table-overflow-phone.md).
