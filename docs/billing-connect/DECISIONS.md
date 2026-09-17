## Work package 2: Billing resilience

- Billing reconciliation runs every 30 minutes and shares webhook handlers and payout mirroring paths.
- Webhook registration retries every five minutes and payments health exposes cached Stripe endpoint status.
- Webhook retry attempts are persisted so poison events remain visible after ten failed replays.

# Billing Connect build — decisions and deviations log

Builders append under their brief heading. Integrator resolves cross-file
requests here and records final calls. Keep entries short: what, why.

## Integrator
- Route files split into six (office / office-orders / hq / hq-orders / public / webhooks) so parallel builders never edit the same router; all six are mounted in `routes/index.ts` / `app.ts` already.
- Web areas mount with wouter `nest` (`/admin/payments`, `/payments`, `/pay`) so each builder owns one sub-router file.
- Wire contract frozen in `lib/billing-types.ts` (web) = `billing/types.ts` (server). Missing fields get logged here first.

## 02-server-foundation
- No wire-contract or database-contract deviations.
- Webhook deliveries use a five-minute `claimed_at` lease. A duplicate arriving during a fresh lease returns 500, not 200, so Stripe retries if the active worker dies before completing the event.

## 04-web-hq
- Refund and subscription cancellation mutations live locally in the HQ pages because the shared billing hooks expose their reads but not those mutations. They retain the `billingKeys.hq(user)` cache prefix through `useInvalidateHqBilling`.
- HQ sandbox configuration uses the requested local `useBillingSandbox` hook and the same HQ cache prefix.

## 05-web-office
- `tsconfig.billing.json` maps `@stripe/connect-js` and `@stripe/react-connect-js` to DOM-free test stubs under `scripts/billing-stubs/` for the office payments renderer.

## 03-server-orders
- Added `billing/store-orders.ts` for provider and order bundle reads without changing the foundation store module.
- Payout responses include a `stale` runtime field when a mirrored fallback is used. Existing wire fields remain unchanged.
- Added migration `20261011020000_billing_price_snapshot.sql`: subscription Stripe ids are nullable while a durable incomplete row precedes Stripe creation, and subscriptions snapshot `shipping_cost_cents` for renewal profit accuracy.
- `PublicOrderStatus.payer_email` carries a server-masked address rather than the raw payer address. Its existing string wire type is unchanged.

## 01-failed-renewal-recovery
- A dedicated invoice-id marker records automatic dunning email attempts, while staff-requested resends remain available.
- Subscription payment failures preserve canceled and unpaid states; all other subscription states move to past due.
- Retry requests use the subscription id, invoice id, and current failure count as their Stripe idempotency key.

## Work package 4: privacy purge and webhook retention

- Billing rows are anonymized, never deleted, because accounting and Stripe reconciliation require durable financial history.
- Active subscriptions are canceled and connected-account customer PII is scrubbed before local patient rows are purged.
- Processed webhook payloads are pruned after 90 days by default; event identity and processing status remain.

## Work package 3: billing audit and permissions

- Billing audit events are best-effort and never roll back a completed Stripe or database action.
- Refund audit metadata uses Stripe's fixed requested_by_customer reason, never the staff-entered free-text note.
- Office billing events are visible to that office; HQ-only catalog, fulfilment, and sandbox events remain HQ-only.

## Money-state invariants
- Invoice orders and ledger event keys are unique; duplicate writes use conflict-ignore semantics.
- Ledger identity is `(kind, stripe_ref)`, so sale, fee adjustment, and explicit reversal entries remain distinct.
- Dunning, stale reconciliation, and Stripe subscription sync use compare-and-set filters.

## Privacy purge Stripe safety

- Purges use the office's stored Connect account even while charges are paused.
- Missing or disconnected accounts and non-missing Stripe errors block local anonymization and surface on the deletion request.
- Stripe `resource_missing` is treated as an idempotent completion.

## Integrator: Group 1 launch safety net (Sept 14, 2026)
- Five migrations applied live in order: 20261013010000 (privacy purge anonymizes billing rows), 020000 (webhook retry_count), 030000 (dunning fields), 040000 (unique invoice orders + unique (kind, stripe_ref) ledger rows), 050000 (last_paid_invoice_id). Security advisors unchanged.
- Money-state rule: every terminal transition written by a webhook or the reconcile job is a compare-and-set on the row's current status/marker; a late event that loses the CAS is a no-op, never an overwrite.
- Ledger rows post only on succeeded/paid Stripe outcomes; later failed/canceled outcomes add a `:reversal` row; the unique index makes replays idempotent. Order + item inserts for renewals are still two requests (accepted; the invoice-unique index prevents the duplicate, an itemless order is the residual risk).
- Patient purge fails loudly (retryable) when a live Stripe subscription cannot be cancelled because its office is disconnected; local anonymization never runs first.
- Demo persona keeps every payments write control disabled (established convention); HQ demo subscription list now honours the status filter so the attention card link lands on the failed rows.

## 06-subscription-controls
- Product item updates use `proration_behavior: none` with an unchanged billing anchor; Stripe changes the future renewal price without charging during the current period.
- Pending price snapshots are promoted with a product-id compare-and-set before the paid renewal order is built.
- Invoice preparation uses the pending application fee so the next cycle and its promoted local snapshot agree.
- Pending changes promote only on cycle invoices carrying the recorded Stripe price; retried older invoices retain their original snapshot.
- Pausing is limited to current active subscriptions; webhook-first pause/resume races are treated as successful convergence.

## Group 2: Link options, disputes, and billing exports
- Link use claims and compensating releases are security-definer CAS functions, available only to the service role.
- Link usability is derived from active, expiry, and use-limit state; exhausted and expired links retain the existing unavailable response.
- Billing CSV money headers explicitly identify dollar values and omit duplicate cents columns.
- Office subscription controls schedule product changes at renewal and keep pause state distinct from Stripe status.
- Office dispute responses use Stripe's embedded disputes list; demo mode substitutes a read-only card.
- Payment exports are filtered to the three billing report kinds and pinned to the viewer's office.

## Group 2: HQ subscription tools
- The HQ subscriptions route only accepts Stripe subscription statuses, so the URL-persisted Paused filter is applied client-side using `paused_at`.
- Payment activity embeds the shared exports panel, restricted to transaction, subscription, and payout report kinds.

## Integrator: Group 2 staff subscription tools (Sept 15, 2026)
- Four migrations applied live: 20261013060000 (paused_at + pending_* change columns), 070000 (link product_id/max_uses + service-role claim/release RPCs), 080000 (pending_stripe_price_id), 090000 (data_exports.kind check widened to the billing kinds — the original constraint silently 502'd every billing export request until this landed).
- Disputes: offices respond themselves inside their Payments area through Stripe's embedded disputes list (owner decision); the old "THINNR responds" notice is gone.
- Product change policy: no proration, takes effect at the next renewal; both the product and shipping Stripe items move together with a recomputed application fee percent; promotion is gated on a `subscription_cycle` invoice that carries the pending Stripe price id.
- Pause policy: only current `active` subscriptions can be paused (past due must be brought current or cancelled); pause does not change fulfillment — shipments follow paid orders only, and a paused subscription produces no orders.
- Shared demo convention holds for the exports panel: demo persona shows "Sign in with a staff account to request exports"; unlimited links display "N uses", limited links "x of y used".
- Adding a new FK to a table that PostgREST callers embed (billing_subscriptions → billing_products twice) makes the bare embed ambiguous; every embed now names its constraint.

## Group 3: patient billing API
- Patient billing identity always comes from the bearer session and its linked patient row; clients never supply a patient or office id.
- The patient catalog and public payment-link catalog share one offering builder so product eligibility, prices, subscriptions, and images cannot drift.
- Patient-app checkout links are reusable, unlimited, non-expiring links labeled `Patient app`, with one link per patient and optional selected product.
- Receipts remain Stripe-hosted: card purchases expose the connected-account receipt and subscription purchases expose the hosted invoice and PDF.
- Subscription cancellation is at period end only and returns a conflict after cancellation has already been scheduled.

## Group 3: patient shop and checkout API
- Cart checkout first claims the cart key with a primary-key insert into `billing_carts` (one patient owns a key; a racing duplicate is a 409 while the first attempt is in flight), then inserts every order and subscription row on ids derived from the cart id before the first Stripe call, and charges each group independently with the one saved card; a partial failure is reported per item (HTTP 200 `partial`), an all-failed cart is 402, a finished cart key replays the existing rows instead of charging again (re-reading any still-pending PaymentIntent so a lost 3DS response can still be confirmed), a cart that died mid-insert resumes onto the same rows, and the key is bound to a fingerprint of the first attempt's request (lines + address + card) so a changed body under the same key is refused; prices are not in the fingerprint — the first attempt's priced plan is persisted with the claim and a resume runs on it (cadence price ids are pinned to the subscription row before the Stripe create), so price drift while a cart is stranded after a Stripe object exists can never orphan the charge; an existing key is resolved before any catalog or live-account validation, so an archived product, a disabled subscription, a below-minimum price, or a disconnected office can block only a new key, never a replay or resume; the claim pins the office's Connect account id and every resume or replay uses exactly that account (idempotency keys are account-scoped), a stranded cart whose office has since connected a different account is terminal (unpaid Stripe objects voided on the old account, rows failed, patient starts over; an already-paid old-account invoice is refused with a 409 and left pending for staff), and an unpinned subscription line on a no-longer-live account fails honestly instead of mirroring prices.
- Patient-backed payers are unique per office at the database (partial unique index on `(provider_id, patient_id)`), and payer resolution is insert-or-reread on that constraint, so racing checkouts share one payer row and, through the payer-keyed Stripe idempotency key, one Stripe customer.
- Checkout distinguishes definite from unknown Stripe answers: a decline, an invalid request raised before any Stripe object existed, or an office that no longer sells the quoted cadence fails the line, while a connection/API error (price mirroring included) or any failure after an invoice or subscription came back re-throws with the order pending and the cart resumable, and an already-settled first invoice is read back as paid; order items carry derived ids so a resume fills in only what is missing.
- Every patient billing read and action (shop list/detail, overview, receipts, cancel and the self-service actions) filters by patient **and** current office; a patient moved between practices never sees or acts on the other office's rows from the new one.
- Checkout carts are transient: they store no address or card, join the patient identity write guard, cascade from the patient row, and are deleted (not anonymized) by the purge RPC.
- Break-even is enforced on the price actually charged, so a subscription line is refused when the subscribe-and-save discount takes the unit below the minimum even though the office's list price clears it; plan changes apply the same rule.
- Shipping is charged once per checkout group: the whole one-time order shares one shipping charge, and every subscription line becomes its own subscription with its own shipping line, because it renews and ships on its own schedule.
- Subscription lines are only sold on cadences the office actually offers with subscription pricing enabled and above break-even; unpriced (floor-price) products are one-time only in the app, matching the public link rule.
- Shipments are a separate row per order (`billing_shipments`) that mirrors the legacy fulfillment columns on every write, so staff screens keep reading the order while a future shipping provider posts label/transit/delivered updates into the shipment row.
- Move-next-shipment uses Stripe `trial_end` without proration and skip is a move-next by one cadence; Stripe's resulting `trialing` status maps to `active` so staff screens never see a new state.
- Change-plan rewrites the live items to the chosen cadence prices with no proration, `billing_cycle_anchor: unchanged` (Stripe would otherwise reset the anchor and invoice immediately when the recurring interval changes) and a re-derived application fee percent; the current period is never re-billed and the new cadence starts at the next renewal.
- A patient's Stripe customer belongs to the office's connected account; card ownership is checked against that customer before any attach, default, detach, or subscription card change, the last card cannot be removed while a subscription still renews, and every renewing subscription that names a card (not only the customer default) is re-pointed before that card is detached.
