# THINNR Provider Payments (Stripe Connect) — build spec

This is the single source of truth for the Stripe Connect build. Every module,
route, table and screen below follows the same names. Where a builder needs
something the spec does not cover, choose the simplest option consistent with
the decisions here and note it in `docs/billing-connect/DECISIONS.md`.

## 1. Product decisions (confirmed with the owner)

- **Money model:** direct charges on each office's connected account with an
  application fee to THINNR. The office is merchant of record, pays Stripe's
  processing fee (2.9% + 30¢), owns refunds/disputes; Stripe carries negative
  balances and handles KYC.
- **Two onboarding paths on one "Get paid" page:**
  1. *Existing Stripe account* → Connect OAuth (`https://connect.stripe.com/oauth/authorize`,
     `response_type=code`, `scope=read_write`, our `client_id`, signed `state`;
     exchange at `https://connect.stripe.com/oauth/token` using the platform
     secret key as `client_secret`).
  2. *New account created in-app* → `accounts.create` with
     `controller: { stripe_dashboard: { type: "none" }, fees: { payer: "account" }, losses: { payments: "stripe" }, requirement_collection: "stripe" }`,
     `country: "US"`, `capabilities: { card_payments, transfers }`, office email /
     business name prefilled from `providers`. Onboarding + every sensitive
     action (bank, identity, payouts, disputes, tax) happens through **Stripe
     embedded components** (Account Sessions). Providers never log into Stripe.
- **Fee (product sales, one-time and product subscriptions):**
  `thinnr_share_cents = floor(floor_price_cents * 60 / 100)` per unit (truncate),
  plus `shipping_charge_cents` (default 1000) once per order. Office keeps the
  rest, including any markup. App-software subscriptions are OUT OF SCOPE.
- **Subscriptions:** product subscriptions only, cadence fixed at **every 4
  weeks** (`interval: "week", interval_count: 4`). Each renewal is fee-wise
  identical to a one-time order. Patients self-cancel via a signed link in the
  receipt email.
- **Refunds:** THINNR keeps its application fee (including shipping) on refunds
  (`refund_application_fee: false`, `reverse_transfer` n/a for direct charges).
  Refunds are their own ledger lines, never netted into the sale.
- **Shipping:** `shipping_charge_cents` charged once per order (not per unit).
  `shipping_cost_cents` (default 1000) is THINNR's internal cost. Both editable
  in HQ (settings on the catalog page).
- **Tax:** the connected account's responsibility. Offices enable Stripe Tax on
  their own account via the embedded `tax_settings` / `tax_registrations`
  components (office Settings → Sales tax). When `billing_connected_accounts.tax_enabled`
  is true we pass `automatic_tax: { enabled: true }`; tax is stored separately
  and never enters the fee base.
- **Pricing rules:** offices set their own sell price per product. Prices may go
  below floor but never below the **break-even minimum** (see §3). Break-even is
  a formula, recomputed whenever floor / shipping / card-fee assumptions change;
  an office price that ends up below the new minimum is *flagged*, never
  auto-changed.
- **Test vs live:** the environment decides. Credentials come from the Replit
  Stripe connection (sandbox keys in the workspace, live keys after publish).
  No toggle. Payment/onboarding screens show a loud "SANDBOX" badge whenever
  the publishable key starts with `pk_test_`.
- **Roles:** HQ users with `financial_read` see the HQ Payments area; catalog
  and settings writes need `settings_manage`; refunds/fulfillment writes need
  `provider_manage`. Office **owners and admins** see the office Payments area
  (`canManageOffice`); office `staff` role does not. HQ drill-in (`?office=`) is
  honored for office routes exactly like existing office routes.
- **Demo isolation:** signed-out guided-demo sessions keep today's seeded
  Subscriptions/revenue screens. Signed-in sessions get ONLY the new live
  screens; never fall back to seeded data because a live call failed.

## 2. Module layout

```
artifacts/api-server/src/billing/
  stripe-client.ts      credentials from the Replit connection + cached Stripe instance
  fees.ts               pure fee math (tested, no I/O)
  money.ts              cents/dollars formatting + parsing helpers (pure)
  store.ts              typed Supabase REST helpers for billing_* tables
  accounts.ts           connected account create / oauth / account sessions / sync
  catalog.ts            catalog + settings + change history logic
  prices.ts             office price list, break-even enforcement, Stripe price mirror
  links.ts              payment link tokens (generic + per-patient), payer resolution
  orders.ts             order assembly, invoice/payment-intent creation, refunds
  subscriptions.ts      4-week subscriptions on the connected account
  webhooks.ts           event verification + dispatch (platform + connect endpoints)
  webhook-endpoints.ts  self-registration of endpoints per environment
  reporting.ts          HQ/office aggregates (collected, fees, net, profit, payouts)
  receipts.ts           receipt / cancellation emails (Resend, via src/claim/delivery.ts pattern)
  types.ts              server copy of the wire contract (byte-identical to web lib/billing-types.ts)
  webhook-handlers.ts   registers every module's handlers once (accounts/orders/subscriptions/payouts)
  payouts.ts            payout mirror + balance reads
artifacts/api-server/src/routes/   (all six already scaffolded + mounted; fill, don't re-mount)
  billing-webhooks.ts        POST /api/billing/webhooks/platform, /connect (express.raw; mounted in app.ts BEFORE json)
  billing-office.ts          /api/billing/office: status, connect/*, prices, links, patients/search
  billing-office-orders.ts   /api/billing/office: dashboard, orders, subscriptions, payouts
  billing-hq.ts              /api/billing/hq: catalog/*, providers, providers/:id
  billing-hq-orders.ts       /api/billing/hq: overview, transactions, fulfillment, subscriptions
  billing-public.ts          /api/billing/public/*
supabase/migrations/20261011000000_billing_connect.sql
artifacts/thinnr-operations/src/   (lib/hooks/primitives already written — the wire contract lives there)
  lib/billing-types.ts             THE wire contract (every JSON shape, integer cents)
  lib/billing-api.ts               typed client (officeBilling / hqBilling / publicBilling)
  lib/billing-format.ts            money + status label helpers (shared by all screens)
  hooks/use-billing.ts             react-query hooks (enabled only when liveEnabled)
  components/billing/primitives.tsx shared UI: SandboxBadge, MoneyCell, StatusPill, FeeBreakdown, DetailList
  components/billing/ConnectEmbed.tsx      Connect.js loader (office screens)
  components/billing/StripeElementsForm.tsx Payment Element form (public pay page)
  pages/admin/payments/*           HQ screens
  pages/office/payments/*          office screens
  pages/public/pay/*               public payment / confirmation / cancel pages
```

Money is **integer cents everywhere** (DB `bigint`/`integer`, JSON numbers named
`*_cents`). Dollars appear only in UI formatting and in HQ price inputs (parsed
to cents at the edge; reject more than 2 decimals).

## 3. Fee math (`billing/fees.ts`, pure, unit-tested)

```
thinnrShareCents(floorCents)            = Math.floor(floorCents * 60 / 100)
stripeFeeEstimateCents(totalCents, s)   = Math.round(totalCents * s.card_fee_bps / 10000) + s.card_fee_fixed_cents   // defaults 290 bps, 30¢
orderFee(lines, settings) = {
  thinnr_share_cents: Σ thinnrShareCents(line.floor_cents) * qty,
  shipping_charge_cents: settings.shipping_charge_cents,
  application_fee_cents: thinnr_share_cents + shipping_charge_cents,
}
breakEvenMinimumCents(floorCents, settings):
  smallest integer sell such that
    (sell + ship) - (share + ship) - stripeFeeEstimateCents(sell + ship) >= 0
  Solve by closed form then verify/adjust ±1 with the inequality (never trust
  float rounding). ship = shipping_charge_cents, share = thinnrShareCents(floor).
officeNetEstimateCents(order)  = subtotal + shipping + tax - application_fee - stripeFeeEstimate(total)
hqProfitCents(order)           = application_fee - Σ hard_cost_cents*qty - shipping_cost_cents
```

Expected values with defaults (must be covered by tests):

| product | floor | share (60% trunc) | break-even min |
|---|---|---|---|
| Control / Regulate / Detox | 59.99 | 35.99 | 37.67 |
| Fiber | 29.99 | 17.99 | 19.13 |
| Creatine+ / B-Active | 89.99 | 53.99 | 56.21 |
| Maintenance Stack (both) | 99.99 | 59.99 | 62.39 |
| Boost | 119.99 | 71.99 | 74.75 |
| Maintenance + Detox Stack | 149.99 | 89.99 | 93.29 |

Subscription application fee per renewal invoice = the same `orderFee` for one
unit of the product (+ shipping). First invoice: Stripe finalizes it
immediately, so we pass `application_fee_percent = ceil((fee/total)*10000)/100`
(never under-collects); after `invoice.paid` on the FIRST invoice we compute
`collected - exact` and, if positive, refund that many cents of the
application fee (`applicationFees.createRefund`), recording an
`application_fee_adjustment` ledger line. Renewal invoices arrive as drafts
(`invoice.created`, ~1h before finalization): we set the exact
`application_fee_amount` on the draft. `application_fee_percent` stays on the
subscription as a backstop; a renewal we could not correct is logged as a
`fee_discrepancy` row for HQ.

## 4. Data model (Supabase, migration `20261011000000_billing_connect.sql`)

All tables live in `public`, prefixed `billing_`, RLS **enabled with no
policies** (only the API's service role touches them). `created_at`/`updated_at`
timestamptz on every table (`updated_at` via the existing `set_updated_at`
trigger pattern if one exists, otherwise a new `billing_touch_updated_at()`).

- `billing_settings` (singleton row id=1): `shipping_charge_cents int default 1000`,
  `shipping_cost_cents int default 1000`, `card_fee_bps int default 290`,
  `card_fee_fixed_cents int default 30`, `version int` (optimistic; PUT sends
  `expected_version`, 409 on mismatch), `updated_by uuid`.
- `billing_products`: `id uuid pk`, `slug text unique`, `name text`, `floor_price_cents int`,
  `hard_cost_cents int`, `active bool default true`, `retired_at timestamptz null`,
  `sort_order int`, `stripe_tax_code text null`.
  Seed (slug → name, floor, hard cost): control→Control 5999/433, regulate→Regulate 5999/816,
  detox→Detox 5999/679, fiber→Fiber 2999/427, creatine-plus→Creatine+ 8999/1383,
  b-active→B-Active 8999/500, boost→Boost 11999/990,
  maintenance-stack→Maintenance Stack 9999/1249,
  maintenance-stack-2→Maintenance Stack – 2 Products 9999/1249,
  maintenance-detox-stack→Maintenance + Detox Stack 14999/1928.
- `billing_catalog_changes`: `id`, `product_id null`, `kind text`
  (`product_created|product_updated|product_retired|product_reactivated|settings_updated`),
  `before jsonb`, `after jsonb`, `actor_user_id uuid`, `created_at`.
- `billing_connected_accounts`: `provider_id text pk` (FK providers), `stripe_account_id text unique`,
  `origin text` (`created|oauth`), `dashboard_type text` (`none|full|express`),
  `charges_enabled bool`, `payouts_enabled bool`, `details_submitted bool`,
  `requirements jsonb` (currently_due, past_due, eventually_due, disabled_reason, current_deadline),
  `capabilities jsonb`, `default_currency text`, `business_name text`, `email text`,
  `tax_enabled bool default false`, `tax_last_checked_at`, `oauth_refresh_token text null`
  (store, never expose), `livemode bool`, `last_synced_at`, `disconnected_at null`.
- `billing_account_events`: `id`, `provider_id`, `kind text`
  (`account_created|oauth_connected|onboarding_started|requirements_updated|
  charges_enabled|payouts_enabled|capability_updated|deauthorized|tax_enabled|tax_disabled`),
  `detail jsonb`, `created_at`. Feeds the HQ onboarding timeline.
- `billing_office_prices`: `provider_id`, `product_id`, `sell_price_cents int`,
  `subscription_enabled bool default false`, `stripe_product_id text null`,
  `stripe_price_id text null` (recurring 4-week price mirrored on the connected
  account; recreated when sell price changes — old price archived),
  `stripe_shipping_price_id text null`, `updated_by`, pk(provider_id, product_id).
  Missing row ⇒ product not offered by that office (offices opt in per product).
- `billing_payment_links`: `id uuid`, `token text unique` (32 url-safe chars),
  `provider_id`, `patient_id uuid null` (per-patient link locks identity),
  `created_by uuid`, `label text null`, `active bool default true`,
  `expires_at null`, `uses int default 0`, `last_used_at`.
- `billing_payers`: `id uuid`, `provider_id`, `patient_id uuid null`,
  `name`, `email`, `phone`, `stripe_customer_id text null` (customer on the
  CONNECTED account), unique(provider_id, stripe_customer_id).
  Resolution rule for generic links: match `patients` by normalized email then
  phone within the office → link `patient_id`; else create/reuse a payer row by
  email.
- `billing_orders`: `id uuid`, `order_number text unique` (`TH-` + 6 base32),
  `provider_id`, `payer_id`, `patient_id null`, `link_id null`,
  `kind text` (`one_time|subscription_initial|subscription_renewal`),
  `subscription_id uuid null`, `status text`
  (`pending|paid|failed|refunded|partially_refunded|disputed|canceled`),
  `currency text default 'usd'`, `subtotal_cents`, `shipping_charge_cents`,
  `tax_cents`, `total_cents`, `application_fee_cents` (exact expected),
  `application_fee_collected_cents null`, `stripe_fee_cents null` (from balance
  transaction), `office_net_cents null`, `hard_cost_cents`, `shipping_cost_cents`,
  `hq_profit_cents`, `shipping_address jsonb` (name, line1, line2, city, state,
  postal_code, country, phone), `stripe_invoice_id`, `stripe_payment_intent_id`,
  `stripe_charge_id`, `stripe_balance_transaction_id`, `livemode`, `paid_at`,
  `fulfillment_status text` (`to_ship|shipped|canceled`) default `to_ship`,
  `tracking_number text null`, `carrier text null`, `shipped_at`, `shipped_by`,
  `canceled_reason text null`, `metadata jsonb`.
- `billing_order_items`: `id`, `order_id`, `product_id`, `product_name_snapshot`,
  `quantity int`, `unit_price_cents`, `floor_price_cents_snapshot`,
  `thinnr_share_cents` (per unit × qty), `hard_cost_cents_snapshot`.
- `billing_subscriptions`: `id uuid`, `provider_id`, `payer_id`, `patient_id null`,
  `product_id`, `stripe_subscription_id unique`, `stripe_customer_id`,
  `status text` (`incomplete|active|past_due|canceled|unpaid`),
  `unit_price_cents`, `shipping_charge_cents`, `application_fee_cents`,
  `shipping_address jsonb`, `current_period_end`, `cancel_at_period_end bool`,
  `canceled_at`, `cancel_token text unique` (for the email link), `livemode`.
- `billing_ledger`: `id`, `provider_id`, `order_id null`, `subscription_id null`,
  `kind text` (`sale|refund|dispute_opened|dispute_won|dispute_lost|
  application_fee_adjustment|fee_discrepancy|payout`), `amount_cents` (signed,
  from the office's perspective), `application_fee_cents` (signed),
  `stripe_ref text`, `detail jsonb`, `occurred_at`.
- `billing_refunds`: `id`, `order_id`, `stripe_refund_id unique`, `amount_cents`,
  `reason text`, `status`, `requested_by uuid null`, `created_at`.
- `billing_disputes`: `id`, `order_id`, `stripe_dispute_id unique`, `amount_cents`,
  `status`, `reason`, `evidence_due_by`, `created_at`, `closed_at`.
- `billing_payouts`: `id`, `provider_id`, `stripe_payout_id unique`, `amount_cents`,
  `status`, `arrival_date date`, `method`, `created_at`.
- `billing_webhook_endpoints`: `id`, `kind text` (`platform|connect`), `url text unique`,
  `stripe_endpoint_id`, `secret text`, `livemode`, `created_at`.
- `billing_webhook_events`: `stripe_event_id text pk`, `kind`, `type`,
  `account text null`, `livemode`, `received_at`, `processed_at null`,
  `error text null`, `payload jsonb`. Idempotency: insert first (on conflict do
  nothing → already handled), process, then mark processed.

Indexes: orders by (provider_id, created_at desc), (patient_id), (status),
(fulfillment_status); ledger by (provider_id, occurred_at desc); subscriptions
by (provider_id, status); payers by (provider_id, lower(email)).

## 5. Stripe flows

**Credentials** (`stripe-client.ts`): GET
`https://$REPLIT_CONNECTORS_HOSTNAME/api/v2/connection?include_secrets=true&connector_names=stripe`
with header `X_REPLIT_TOKEN: repl <REPL_IDENTITY>` (or `depl <WEB_REPL_RENEWAL>`
when published). `items[0].settings` has `secret`, `publishable`, `account_id`.
Cache for 5 minutes; refetch on 401 from Stripe. Export `getStripe()`,
`getPublishableKey()`, `isSandbox()` (`pk_test_`), `getPlatformAccountId()`.
Also read `STRIPE_CONNECT_CLIENT_ID` from env (the `ca_…` value; required for
the OAuth path only — missing ⇒ that path shows "not configured").
Stripe SDK: `new Stripe(secret, { apiVersion: <the SDK default>, appInfo: { name: "THINNR Operations" } })`.

**App URL** for redirects/emails: `BILLING_PUBLIC_ORIGIN` env if set, else
`https://${REPLIT_DOMAINS.split(",")[0]}` in the workspace. Never hard-code.

**OAuth:** `GET /api/billing/office/connect/oauth/start` → returns `{ url }`;
state = HMAC-signed `{provider_id, actor, exp}` using `SESSION_SECRET`.
Callback `GET /api/billing/oauth/callback?code&state` (public, no bearer):
verify state, exchange code, upsert `billing_connected_accounts`
(origin `oauth`, dashboard_type from the retrieved account controller /
`type`), log event, then `302` to `/payments/get-paid?connected=1` (office) or
`/payments/get-paid?error=…`. Redirect URL to register in Stripe: `<origin>/api/billing/oauth/callback`.

**Account sessions:** `POST /api/billing/office/connect/account-session`
body `{ components: ["account_onboarding"|"account_management"|"payouts"|"balances"|"payments"|"tax_settings"|"tax_registrations"|"notification_banner"|"documents"|"payment_details"] }`
→ `{ client_secret, publishable_key, sandbox }`. Enable exactly the requested
components (allow-list). For `full`-dashboard (OAuth) accounts, if Stripe
rejects a component, respond 409 `{ error, unsupported: [..] }` so the UI can
show the "Manage in Stripe" fallback link (`https://dashboard.stripe.com/`).

**Account sync:** `syncAccount(providerId)` retrieves the account, updates
flags/requirements/capabilities, diff-logs events, and reads tax settings
(`GET /v1/tax/settings` on the connected account → `status === "active"` ⇒
`tax_enabled`). Called after onboarding returns, on `account.updated`, and
lazily when the office opens Get paid if `last_synced_at` > 10 min old.

**One-time order** (public):
1. `GET /api/billing/public/links/:token` → link + office display name +
   offered products (name, unit price, subscription available?) + locked payer
   identity for per-patient links + `sandbox` + `publishable_key` + `stripe_account_id`.
2. `POST /api/billing/public/links/:token/orders` body
   `{ items: [{product_id, quantity}], payer: {name,email,phone} (ignored for per-patient links), shipping_address, purchase: "one_time" }`
   → server recomputes everything from the DB (never trusts client amounts),
   creates/reuses a Customer on the connected account, creates an **Invoice**
   on the connected account (`collection_method: send_invoice` is NOT used —
   use `charge_automatically` with `auto_advance: false`, add invoice items via
   `price_data` for each product line + a "Shipping" line, `automatic_tax`
   per office, `application_fee_amount` exact, `metadata: { thinnr_order_id }`,
   `shipping_details`), finalizes it, retrieves the invoice's PaymentIntent,
   stores order `pending`, returns
   `{ order_id, order_number, client_secret, stripe_account_id, publishable_key, totals }`.
   Frontend mounts Elements with `{ stripeAccount }` and `confirmPayment`
   with `return_url = <origin>/pay/<token>/done?order=<order_id>`.
3. `invoice.paid` (connect webhook) ⇒ order `paid`, `paid_at`, charge id, then
   fetch the balance transaction for `stripe_fee_cents`, compute
   `office_net_cents`, write `sale` ledger line, send receipt email.
   `invoice.payment_failed` ⇒ `failed`. The done page polls
   `GET /api/billing/public/orders/:order_id/status?token=` (short poll, max 60s)
   and shows the receipt when `paid`.

**Subscription order:** same first step, then
`POST …/orders` with `purchase: "subscription"` and exactly one product with
`subscription_enabled`: ensure recurring price mirror exists
(product + price on the connected account, 4-week; shipping recurring price per
office too), create Customer, `subscriptions.create` with
`items: [{price: product_price}, {price: shipping_price}]`,
`payment_behavior: "default_incomplete"`,
`payment_settings: { save_default_payment_method: "on_subscription" }`,
`application_fee_percent` as in §3, `automatic_tax` per office,
`expand: ["latest_invoice.payment_intent"]`, metadata with `thinnr_subscription_id`.
Store `billing_subscriptions` (`incomplete`) + an order with kind
`subscription_initial` (`pending`), return the PI `client_secret`.
Webhooks: `invoice.paid` (subscription_create ⇒ initial order paid + fee
adjustment; subscription_cycle ⇒ create a `subscription_renewal` order from
the invoice lines), `invoice.created` with `billing_reason=subscription_cycle`
⇒ set exact `application_fee_amount` on the draft, `customer.subscription.updated/deleted`
⇒ status sync. Cancel: `GET /pay/cancel/:cancel_token` page → confirm →
`POST /api/billing/public/subscriptions/:cancel_token/cancel` ⇒
`subscriptions.update(cancel_at_period_end: true)`; office/HQ can cancel
immediately via their routes.

**Refund** (office owner/admin, HQ provider_manage): `POST …/orders/:id/refund`
`{ amount_cents?, reason }` ⇒ `refunds.create` on the connected account with
`payment_intent`, `refund_application_fee: false`; webhook `charge.refunded`
updates the order status and writes a `refund` ledger line (negative amount,
application fee 0). Disputes: `charge.dispute.created/closed` ⇒ rows + ledger.

**Payouts / balances:** read live from Stripe (`balance.retrieve`, `payouts.list`
on the connected account) for the office dashboard; `payout.paid/failed`
webhooks mirror into `billing_payouts` for history.

**Webhook endpoints** (`webhook-endpoints.ts`): on API boot (non-test env,
credentials available) ensure two endpoints exist for the current origin:
`<origin>/api/billing/webhooks/platform` (`connect: false`, events:
`account.application.deauthorized`) and `<origin>/api/billing/webhooks/connect`
(`connect: true`, events: `account.updated`, `capability.updated`,
`invoice.created`, `invoice.paid`, `invoice.payment_failed`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`,
`payout.paid`, `payout.failed`, `payment_intent.payment_failed`). Look up the
secret in `billing_webhook_endpoints` by url; if missing, list Stripe endpoints
for that url — if one exists but we lack its secret, delete and recreate (the
secret is only returned at creation). Never log secrets. Verification uses
`stripe.webhooks.constructEvent(rawBody, sig, secret)`; the raw route must be
mounted in `app.ts` BEFORE the JSON parser. Route replies 200 quickly and
processes inline (idempotent via `billing_webhook_events`).

Every Stripe call against a connected account passes `{ stripeAccount }` as
the request option. Every write to Stripe uses an idempotency key derived from
our row id (`order:<id>:invoice`, etc.).

## 6. API contract

Auth: office routes use `resolveOfficeScope({ hqPermission: "financial_read" | "provider_manage", requireUnlocked: <writes> })`
and additionally require `canManageOffice(scope)` for non-HQ callers
(403 "Only office owners and admins can manage payments."). HQ routes use
`requireHqPermission`. Public routes are unauthenticated, rate-limited per IP
via `createLimiter` (link reads 120/10min, order creation 20/10min, cancel 10/10min),
and never reveal other patients' data.

Errors: `{ error: string, field?: string }` with 400/401/403/404/409/429/503.
All money fields are integer cents. All lists accept `?limit=` (default 50, max 200)
and `?cursor=` (opaque created_at|id) and return `{ items, next_cursor }`.

### Office (`/api/billing/office/...`, `?office=` honored for HQ)
- `GET  /status` → `{ account: ConnectedAccount|null, offered_products: n, links: n, sandbox, oauth_available }`
- `POST /connect/create` → creates the in-app account (409 if one exists) → `{ account }`
- `GET  /connect/oauth/start` → `{ url }`
- `POST /connect/account-session` → `{ client_secret, publishable_key, sandbox }`
- `POST /connect/sync` → `{ account }`
- `GET  /dashboard?from&to` → `{ balance: { available_cents, pending_cents }, next_payout: {amount_cents, arrival_date}|null, collected_cents, thinnr_fee_cents, stripe_fee_cents, refunded_cents, net_cents, orders: n, active_subscriptions: n, series: [{date, collected_cents, net_cents}] }`
- `GET  /prices` → `{ products: [{ product_id, slug, name, floor_price_cents, break_even_minimum_cents, sell_price_cents|null, subscription_enabled, offered, below_minimum }] , settings: { shipping_charge_cents } }`
- `PUT  /prices/:product_id` `{ sell_price_cents|null (null = stop offering), subscription_enabled }` → 400 `field:"sell_price_cents"` below minimum → `{ product }`
- `GET  /links` / `POST /links { patient_id?, label? }` / `DELETE /links/:id` (deactivate) → link rows with `url`
- `GET  /orders?status&fulfillment&patient_id&from&to&q` / `GET /orders/:id` (items, fee breakdown, refunds, disputes, ledger) / `POST /orders/:id/refund`
- `GET  /subscriptions?status` / `POST /subscriptions/:id/cancel { at_period_end: bool }`
- `GET  /payouts` → `{ items (live list, merged with mirrored rows), balance }`
- `GET  /patients/search?q=` → `[{ id, name, email, phone }]` (for the per-patient link builder; office scope only)

### HQ (`/api/billing/hq/...`)
- `GET  /overview?from&to` (`financial_read`) → program totals: collected, thinnr fees, shipping, hard costs, profit, refunds, disputes, active subs, providers onboarded/pending, orders to ship, recent activity, series.
- `GET  /providers` → `[{ provider_id, office_name, account: {…}|null, offered_products, orders_30d, collected_30d_cents, fees_30d_cents, below_minimum_count }]`
- `GET  /providers/:provider_id` → `{ office, account, events, prices (with floor/min/sell/flag), subscriptions summary, recent orders, payouts }`
- `GET  /transactions?provider_id&status&kind&from&to&q` / `GET /transactions/:id` (everything incl. hq profit + fulfillment + stripe refs) / `POST /transactions/:id/refund` (`provider_manage`)
- `GET  /fulfillment?status=to_ship|shipped|canceled&provider_id&q` / `PUT /fulfillment/:order_id { status, tracking_number?, carrier?, canceled_reason? }` (`provider_manage`) — shipping an order emails the payer the tracking number.
- `GET  /catalog` → `{ products: [ …, thinnr_share_cents, break_even_minimum_cents, hq_profit_per_unit_cents ], settings, offices_below_minimum: n }`
- `POST /catalog/products` / `PUT /catalog/products/:id` / `POST /catalog/products/:id/retire` / `POST /catalog/products/:id/reactivate` (`settings_manage`; record change rows)
- `PUT  /catalog/settings { shipping_charge_cents, shipping_cost_cents, card_fee_bps, card_fee_fixed_cents, expected_version }` (409 stale)
- `GET  /catalog/changes` → change history with actor display names.
- `GET  /subscriptions?provider_id&status` → program-wide list.

### Public (`/api/billing/public/...`)
- `GET  /links/:token`, `POST /links/:token/orders`, `GET /orders/:id/status?token=`,
  `GET /subscriptions/:cancel_token`, `POST /subscriptions/:cancel_token/cancel`,
  `GET /config` → `{ sandbox }` (for the badge before a link loads).

### Webhooks
- `POST /api/billing/webhooks/platform`, `POST /api/billing/webhooks/connect` (raw body).

## 7. Screens (operations web, desktop-first, existing design system)

Use the existing primitives (`components/ui/*`, `components/admin/primitives.tsx`,
`PageHeader`/cards/tables already used by office and HQ pages), serif Playfair
titles, cream cards, `text-navy`. Every table row that opens a detail uses the
approved clickable-row pattern (one announced row link, pointer-only tr onClick).
Filters persist in the URL query string (wouter `useSearch`). Loading =
skeletons; errors = the app's ErrorBox pattern with retry; empty states with a
one-line next step. SandboxBadge on every payments page when `sandbox`.

HQ (`/admin/payments/...`, nav "Payments" in the Manage section, permission
`financial_read`):
1. `/admin/payments` Overview — headline cards (collected, THINNR fees, profit,
   refunds, active subs, providers onboarded/pending, orders to ship), series
   chart, recent activity list.
2. `/admin/payments/providers` Providers — table with onboarding status pill,
   offered products, 30-day collected/fees, below-minimum flag, links to detail.
3. `/admin/payments/providers/:providerId` Provider detail — account status +
   requirements, onboarding timeline, price list vs floor/minimum, subscriptions,
   recent transactions, payouts.
4. `/admin/payments/transactions` — filters (office, status, kind, date range, search),
   table → detail.
5. `/admin/payments/transactions/:orderId` — patient/payer, items, shipping address,
   tax, total, fee breakdown (THINNR share, shipping, application fee, est./actual
   Stripe fee, office net), hard cost + profit, fulfillment panel (status,
   tracking), refund/dispute history, Stripe references (ids as fine print),
   Refund action (dialog with amount + reason).
6. `/admin/payments/fulfillment` — tabs To ship / Shipped / Canceled, address,
   items, mark shipped with carrier + tracking, cancel with reason.
7. `/admin/payments/catalog` — products table (name, floor, hard cost, THINNR share,
   break-even min, profit/unit, active), add/edit/retire dialogs, shipping
   charge/cost + card-fee settings card, link to change history.
8. `/admin/payments/catalog/history` — change history table.
9. `/admin/payments/subscriptions` — program-wide subscriptions with status,
   office, product, next renewal, cancel action.

Office (`/payments/...`, nav "Payments" in the Operations section, owner/admin only;
staff role gets the UnauthorizedState pattern):
10. `/payments/get-paid` — setup: if no account → two cards (Connect existing
    Stripe account / Set up a new account); if account → status
    (charges/payouts enabled, requirements due with deadline), embedded
    onboarding / notification banner, "Continue setup" button; bank/payout
    settings via embedded `account_management` + `payouts` components.
11. `/payments` Dashboard — balances (available/pending), next payout, collected,
    THINNR fees, Stripe fees, net, subs, series, quick links. Redirects to
    `/payments/get-paid` when no account.
12. `/payments/transactions` + 13. `/payments/transactions/:orderId` — office view
    (no hard cost / profit), refund action, fulfillment status read-only.
14. `/payments/prices` — per product: floor, break-even minimum, sell price input
    (dollars), 4-week subscription toggle, offered toggle; inline validation
    below minimum; flag rows below minimum.
15. `/payments/links` — generic office link card (copy button, QR optional),
    per-patient link builder (patient search → create → copy), list of links
    with uses / last used / deactivate.
16. `/payments/subscriptions` — list + cancel (now / at period end).
17. `/payments/payouts` — balance + payout history (amount, arrival, status, method).
18. `/payments/settings` — tabs Bank & payouts (embedded), Identity & business
    (embedded account_management), Sales tax (embedded tax_settings +
    tax_registrations; explains that tax is the office's responsibility and
    Stripe Tax pricing applies to their account), Documents.

Public (no session; mounted like `/email` and `/security/report` in `App.tsx`):
19. `/pay/:token` — office name + logo mark, product picker with quantities,
    "Subscribe every 4 weeks" option when available (one product per
    subscription), payer fields (locked for per-patient links), shipping
    address, order summary (subtotal, shipping, tax "calculated at payment" when
    tax enabled else "—", total), Stripe Payment Element, Pay button, SANDBOX
    badge, fine print (merchant = office, THINNR is the platform).
20. `/pay/:token/done?order=` — polls status; shows receipt summary and
    "we emailed your receipt".
21. `/pay/cancel/:cancelToken` — subscription summary + confirm cancel at period end.

Emails (Resend, THINNR sender already used by claim emails): receipt (items,
totals, office name, shipping address, order number, cancel link for
subscriptions), shipped notice (tracking), cancellation confirmation. Plain
HTML matching the existing email builder style in `src/claim/delivery.ts`.

## 8. Testing conventions

- API: vitest next to the module (`*.test.ts`), fetch-mocked Supabase like the
  existing route tests; Stripe is injected/mocked via `vi.mock("../billing/stripe-client")`.
  `fees.test.ts` covers the table in §3 plus adversarial cases (rounding, zero
  shipping, multi-quantity). Webhook tests use `stripe.webhooks.generateTestHeaderString`.
- SQL: the migration must apply cleanly to the live project through the
  management API (`docs/…` memory rule) AND be covered by a local-Postgres
  vitest (`billing.sql.test.ts`) that applies the file and exercises the
  idempotent webhook insert + updated_at triggers.
- Web: `pnpm --filter @workspace/thinnr-operations run typecheck` must pass;
  add a react-test-renderer suite for the price list minimum validation and
  the fee breakdown component, wired as `test:billing` script + `billing-web`
  validation command.
- E2E in the Stripe sandbox (owner-run + testing subagent): in-app account
  creation, OAuth connect, one-time order with `4242 4242 4242 4242`,
  subscription order, refund, renewal invoice fee correction (use a test clock
  on the connected account customer), fulfillment mark-shipped email.

## 9. Environment / config

- `STRIPE_CONNECT_CLIENT_ID` (env, `ca_…`) — OAuth path. Absent ⇒ path hidden with a note.
- `BILLING_PUBLIC_ORIGIN` (optional) — overrides the origin used in links/emails/redirects.
- `BILLING_WEBHOOKS_DISABLED=1` — skips endpoint self-registration (tests, CI).
- Stripe secret/publishable keys: ONLY via the Replit connection. Never in env, code, or logs.
