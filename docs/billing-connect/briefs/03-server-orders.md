# Brief 03 — Server: orders, subscriptions, refunds, payouts, reporting, receipts, public + order routes

Prerequisite: brief 02 is DONE. Read (do not edit) `billing/stripe-client.ts`,
`billing/fees.ts`, `billing/store.ts`, `billing/links.ts`, `billing/accounts.ts`,
`billing/prices.ts`, `billing/auth.ts`, `billing/app-origin.ts`,
`billing/webhooks.ts`, `billing/webhook-handlers.ts`, `routes/billing-office.ts`
(for the route style), and their tests.

Owner files (under `artifacts/api-server/src/`):
- `billing/orders.ts` (+ test), `billing/subscriptions.ts` (+ test),
  `billing/payouts.ts` (+ test), `billing/reporting.ts` (+ test),
  `billing/receipts.ts` (+ test), `billing/refunds.ts` (optional split)
- `routes/billing-public.ts` (+ test), `routes/billing-office-orders.ts` (+ test),
  `routes/billing-hq-orders.ts` (+ test)
- `docs/billing-connect/DECISIONS.md` (append under "## 03-server-orders")

If `store.ts`/`fees.ts` lack a helper you need, ADD a new exported function
to a new file `billing/store-orders.ts` (or compute locally) rather than
editing brief 02's files; note it in DECISIONS.md.

## orders.ts — SPEC §5 "One-time order", "Refund"
- `quoteOrder(link, items, purchase)`: load active products the office offers
  (`billing_office_prices` join `billing_products`), reject unknown/unoffered
  products (400 `field: "items"`), qty 1–10, compute totals + fees via
  `computeOrderFees`, settings snapshot, hard costs.
- `createOneTimeOrder({ link, payerInput, shipping_address, items })`:
  resolve payer (`links.resolvePayer`), ensure Stripe Customer on the CONNECTED
  account (store `stripe_customer_id`), insert `billing_orders` (pending) +
  items FIRST (so the idempotency keys can use our ids), then Stripe:
  `invoiceItems.create` per line with `price_data` (product name snapshot,
  `unit_amount`, `quantity`, tax code default) + one Shipping line, then
  `invoices.create` with `collection_method: "charge_automatically"`,
  `auto_advance: false`, `automatic_tax: { enabled: account.tax_enabled }`,
  `application_fee_amount`, `metadata.thinnr_order_id`, `shipping_details`,
  `pending_invoice_items_behavior: "include"` (check the installed SDK version's
  API for the right way to attach items — creating the invoice first and then
  invoice items with `invoice: id` is also acceptable; pick one and test it),
  `invoices.finalizeInvoice(id, { expand: ["payment_intent"] })` — if
  `payment_intent` is missing on the finalized invoice, retrieve it via
  `invoices.retrieve(id, { expand: ["payment_intent"] })` or, on SDK ≥ 2025 API
  where invoices carry `payments`, follow `invoice.payments.data[0].payment.payment_intent`.
  Save `stripe_invoice_id`, `stripe_payment_intent_id`, `tax_cents` and
  `total_cents` from the finalized invoice (tax may change the total), update
  `application_fee_cents` unchanged. Return `PublicOrderResponse`.
  If Stripe fails after the row exists: mark order `failed` with
  `metadata.error` and rethrow a 502-style error with a plain message.
- `markOrderPaidFromInvoice(invoice, ctx)`: idempotent (skip when already
  paid); set `paid`, `paid_at`, `stripe_charge_id`, retrieve the balance
  transaction (`charge.balance_transaction`, expand) for `stripe_fee_cents`
  and `application_fee_collected_cents` (from `charge.application_fee_amount`
  or the application fee object), compute `office_net_cents` (total − app fee
  collected − stripe fee), `hq_profit_cents`, write `sale` ledger line, send
  receipt (receipts.ts). For subscription invoices see subscriptions.ts.
- `refundOrder(orderId, { amount_cents?, reason }, actor)`: validate
  refundable remainder (total − Σ refunds), `refunds.create({ payment_intent,
  amount, reason: "requested_by_customer", metadata }, { stripeAccount,
  idempotencyKey: refund:<order>:<n> })` with `refund_application_fee: false`;
  insert `billing_refunds`; update status (`refunded`/`partially_refunded`);
  `refund` ledger line; the webhook `charge.refunded` reconciles (idempotent by
  `stripe_refund_id`). Disputes: `charge.dispute.created/closed` ⇒ rows +
  ledger + order `disputed` (and back to `paid` if won).
- `toOrderDetail(row, items, refunds, disputes, ledger, { hq })` → wire
  `OrderDetail` (profit block only when `hq`).
- `registerOrderWebhookHandlers()` → `invoice.paid` (route by
  `billing_reason`: `manual` ⇒ one-time; `subscription_create`/`subscription_cycle`
  ⇒ delegate to subscriptions.ts), `invoice.payment_failed`,
  `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`,
  `charge.dispute.closed`.

## subscriptions.ts — SPEC §5 "Subscription order"
- `createSubscriptionOrder({ link, payerInput, shipping_address, product_id })`:
  product must be `subscription_enabled` for the office; `ensureRecurringPrices`
  from prices.ts; Customer with shipping; `subscriptions.create` per SPEC
  (`payment_behavior: "default_incomplete"`, `payment_settings.save_default_payment_method: "on_subscription"`,
  `application_fee_percent` via `applicationFeePercentFor(exact_fee, total)`,
  `automatic_tax`, `expand: ["latest_invoice.payment_intent"]` — same PI
  fallback as orders), insert `billing_subscriptions` (incomplete, cancel_token
  32 url-safe chars) + a `subscription_initial` order (pending) linked by
  `stripe_invoice_id` = latest invoice. Return `PublicOrderResponse` with
  `subscription: { every_weeks: 4, renews_on }`.
- Webhooks: `invoice.created` with `billing_reason === "subscription_cycle"` ⇒
  compute exact fee, `invoices.update(id, { application_fee_amount })`
  (if that fails, log `fee_discrepancy` ledger line) and pre-create the
  `subscription_renewal` order (pending) from the invoice lines;
  `invoice.paid` with `subscription_create` ⇒ mark initial order paid, then
  over-collection check: `collected − exact > 0` ⇒
  `applicationFees.createRefund(feeId, { amount })` + `application_fee_adjustment`
  ledger line; `subscription_cycle` ⇒ mark renewal order paid (create it if
  `invoice.created` was missed); `customer.subscription.updated/deleted` ⇒
  status/current_period_end/cancel flags sync.
- `cancelSubscription(id, { at_period_end })` (office/HQ) and
  `cancelByToken(cancel_token)` (public, always at period end) ⇒ Stripe update
  + row update + cancellation email.
- `toSubscriptionRow`, `toPublicSubscription`.

## payouts.ts
`getBalance(accountId)` → cents; `listPayouts(accountId)` live (limit 20)
merged with mirrored rows; `registerPayoutWebhookHandlers()` for
`payout.paid`/`payout.failed` ⇒ upsert `billing_payouts` + `payout` ledger line.
All Stripe reads tolerate failures (return `null` balance with a `stale` flag
the route turns into a 503 only if BOTH live and mirror fail).

## reporting.ts
Aggregates from `billing_orders` / `billing_ledger` / `billing_subscriptions`
(PostgREST selects + in-memory reduce is fine at this scale; document that a
SQL RPC is the upgrade path): `officeDashboard(providerId, range)` →
`OfficeDashboard`, `hqOverview(range)` → `HqOverview` (series per day,
recent activity from ledger + account events + shipped orders). Ranges are
inclusive UTC dates; default last 30 days. Pre-dataset ranges return zeros
(there is no seeded history to compare against).

## receipts.ts
Plain HTML + text emails via the Resend pattern in `src/claim/delivery.ts`
(same sender): receipt (order number, items, subtotal, shipping, tax, total,
office name + contact, shipping address, "renews every 4 weeks" + cancel link
`<origin>/pay/cancel/<cancel_token>` when subscription), shipped notice
(carrier + tracking, carrier tracking URL for USPS/UPS/FedEx), cancellation
confirmation. Never throw out of a webhook because email failed — log.
Export `sendReceipt`, `sendShippedNotice`, `sendCancellationNotice`.

## Routes
- `routes/billing-public.ts` (unauthenticated; `createLimiter` from
  `src/coach/limits.ts`: link reads 120/10min/IP, order creation 20/10min/IP,
  cancel 10/10min/IP): `GET /billing/public/config`, `GET /billing/public/links/:token`
  (`PublicLink`: never expose other patients; `locked_payer` only for
  per-patient links), `POST /billing/public/links/:token/orders`
  (zod body per `PublicOrderRequest`; `purchase` routes to orders/subscriptions),
  `GET /billing/public/orders/:id/status?token=` (token must match the
  order's link; `PublicOrderStatus`), `GET /billing/public/subscriptions/:cancel_token`,
  `POST /billing/public/subscriptions/:cancel_token/cancel`.
- `routes/billing-office-orders.ts` (use `requireOfficeBillingScope`):
  `GET /billing/office/dashboard`, `GET /billing/office/orders` (filters +
  cursor), `GET /billing/office/orders/:id`, `POST /billing/office/orders/:id/refund`
  (write), `GET /billing/office/subscriptions`, `POST /billing/office/subscriptions/:id/cancel`
  (write), `GET /billing/office/payouts`.
- `routes/billing-hq-orders.ts` (`requireHqPermission`): `GET /billing/hq/overview`
  (`financial_read`), `GET /billing/hq/transactions[/:id]` (`financial_read`),
  `POST /billing/hq/transactions/:id/refund` (`provider_manage`),
  `GET /billing/hq/fulfillment` (`financial_read`), `PUT /billing/hq/fulfillment/:order_id`
  (`provider_manage`; shipped ⇒ tracking required, sets `shipped_at/shipped_by`,
  sends the shipped email; canceled ⇒ reason required; only `paid` orders can
  be shipped), `GET /billing/hq/subscriptions`, `POST /billing/hq/subscriptions/:id/cancel`
  (`provider_manage`).

## Tests
vitest with fetch-mocked Supabase and a fake Stripe via `__setStripeForTests`.
Must cover: one-time order creation writes the row before Stripe and returns
the PI secret; invoice.paid marks paid once (replay is a no-op) and computes
net from the balance transaction; first subscription invoice over-collection
triggers an application-fee refund of exactly `collected − exact`;
`invoice.created` renewal sets the exact `application_fee_amount`; refund
validation (over-remainder ⇒ 400); fulfillment PUT requires tracking and sends
the email; public status endpoint rejects a mismatched token; rate limit
returns 429. Finish with server typecheck + all `src/billing` and
`src/routes/billing-*` tests green.
