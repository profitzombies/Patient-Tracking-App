# Brief 02 — Server foundation: Stripe client, fees, store, accounts, catalog, prices, links, webhooks infra

Owner files (all under `artifacts/api-server/src/`):
- `billing/stripe-client.ts`, `billing/fees.ts` (+ `fees.test.ts`), `billing/money.ts`,
  `billing/store.ts`, `billing/accounts.ts` (+ test), `billing/catalog.ts` (+ test),
  `billing/prices.ts` (+ test), `billing/links.ts` (+ test), `billing/webhook-endpoints.ts`,
  `billing/app-origin.ts`, `billing/auth.ts`
- `billing/webhooks.ts` and `billing/webhook-handlers.ts` exist (registry). You may
  extend `webhooks.ts`; leave the four `register*WebhookHandlers` imports alone.
- `routes/billing-webhooks.ts` (+ test), `routes/billing-office.ts` (+ test),
  `routes/billing-hq.ts` (+ test)
- `index.ts`: add ONE line after `startJobScheduler();` that calls
  `void ensureBillingWebhookEndpoints()` (import from `./billing/webhook-endpoints`).
- `docs/billing-connect/DECISIONS.md` (append under "## 02-server-foundation")

Another agent (brief 03) will later write `orders.ts`, `subscriptions.ts`,
`payouts.ts`, `reporting.ts`, `receipts.ts`, `routes/billing-office-orders.ts`,
`routes/billing-hq-orders.ts`, `routes/billing-public.ts` ON TOP of your
`store.ts`, `stripe-client.ts`, `fees.ts`, `links.ts`, `accounts.ts`. Design
those as clean, documented, reusable modules. The stubs for orders/subscriptions/
payouts already exist; do not fill them.

## 1. `stripe-client.ts`
- `getStripeCredentials()` fetches from the Replit connection (SPEC §5
  "Credentials"), caches 5 min, throws a `BillingConfigError` (503 at the route)
  when the connection is unavailable. Support `REPL_IDENTITY` (`repl `) and
  `WEB_REPL_RENEWAL` (`depl `) tokens. Never log values.
- `getStripe()` returns a cached `Stripe` instance (package `stripe`, already
  installed; `appInfo: { name: "THINNR Operations" }`); recreate when the secret
  changes. `getPublishableKey()`, `isSandbox()`, `getPlatformAccountId()`,
  `getConnectClientId()` (env `STRIPE_CONNECT_CLIENT_ID`, blank ⇒ null).
- Test seam: `__setStripeForTests(stripe | null)` and `__setCredentialsForTests`.
- `connectedOpts(accountId, idempotencyKey?)` → `{ stripeAccount, idempotencyKey }`.

## 2. `fees.ts` (pure) + `fees.test.ts`
Implement SPEC §3 exactly: per-unit THINNR share = floor(0.6 × floor_price_cents)
(truncate), shipping fee = settings.shipping_charge_cents per order,
`application_fee_cents = Σ(share × qty) + shipping_charge_cents`, break-even
minimum per §3 formula, first-invoice `application_fee_percent` (ceil to 2dp,
computed from the actual invoice total incl. shipping, never > 100),
over-collection = collected − exact, Stripe fee estimate = round(total × bps/10000) + fixed,
office net (estimate/actual), HQ profit = application_fee − hard_cost − shipping_cost.
Export typed functions: `thinnrSharePerUnit`, `breakEvenMinimum`, `computeOrderFees`,
`applicationFeePercentFor`, `estimateStripeFee`, `hqProfit`, `belowMinimum`.
The test must reproduce every row of the §3 expected table byte-for-byte
(minimums: Control/Regulate/Detox 3767, Fiber 1913, Creatine+/B-Active 5621,
Maintenance Stack 6239, Boost 7475, Maint+Detox 9329 — re-derive from the §3
formula and confirm they match; if the formula gives a different number, the
table in SPEC is wrong: write it in DECISIONS.md and keep the formula).
Include adversarial cases: qty 3, two products, zero shipping, 1-cent prices,
percent rounding never under-collects.

## 3. `money.ts` — `formatCents`, `parseDollarsToCents` (reject >2 decimals), `centsToDollars`.

## 4. `store.ts`
Thin typed helpers over `supabaseAdmin` (PostgREST) for every `billing_*` table:
`selectOne/selectMany/insert/upsert/update` with table-typed row interfaces
(`BillingOrderRow`, …) matching SPEC §4 columns, cursor pagination helper
(`created_at|id` opaque cursor, limit default 50 max 200), and
`nowIso()`. Throw `BillingStoreError` with the PostgREST message. Keep it
boring and predictable; brief 03 relies on it.

## 5. `auth.ts`
`requireOfficeBillingScope(req, res, { write })`: wraps `resolveOfficeScope`
(`src/auth/office-scope.ts`) with `hqPermission: write ? "provider_manage" : "financial_read"`,
`requireUnlocked: write`; for non-HQ callers require `canManageOffice(scope)`
else 403 `{ error: "Only office owners and admins can manage payments." }`.
Returns `{ providerId, officeName, actorUserId, isHq, officeRole, canManage }`
or null after responding. Read `office-scope.ts` first and reuse its
helpers; also expose `viewerOfficeRole` for the `/status` payload.

## 6. `accounts.ts` (+ test with mocked Stripe)
- `createInAppAccount(providerId, actorUserId)` — SPEC §1/§5 controller combo
  (`controller: { stripe_dashboard: { type: "none" }, fees: { payer: "account" }, losses: { payments: "stripe" }, requirement_collection: "stripe" }`,
  `capabilities: { card_payments: { requested: true }, transfers: { requested: true } }`,
  `country: "US"`, `business_profile` prefilled from `providers` (name, email,
  phone, address), `metadata: { thinnr_provider_id }`, idempotency key
  `account:<provider_id>`). 409 if a non-disconnected row exists. Insert row +
  `account_created` event.
- `buildOauthStartUrl(providerId, actorUserId)` — HMAC state via `SESSION_SECRET`
  (`crypto.createHmac`), 15-min expiry, `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=…&scope=read_write&state=…&redirect_uri=<origin>/api/billing/oauth/callback&stripe_user[email]=…`.
  `completeOauth(code, state)` → verify state, `stripe.oauth.token`, retrieve
  account, upsert row (`origin: "oauth"`, dashboard type from
  `account.controller?.stripe_dashboard?.type ?? (account.type === "standard" ? "full" : account.type)`),
  store `refresh_token`, event `oauth_connected`, then `syncAccount`.
- `createAccountSession(providerId, components[])` — allow-list per SPEC §5;
  map Stripe "not supported" errors to 409 with `unsupported`.
- `syncAccount(providerId)` — retrieve, diff flags → events
  (`charges_enabled`, `payouts_enabled`, `requirements_updated`,
  `capability_updated`), tax status via `stripe.tax.settings.retrieve({}, { stripeAccount })`
  (status `active` ⇒ tax_enabled; toggle events), `last_synced_at`.
- `toConnectedAccount(row)` → wire `ConnectedAccount` (never expose refresh token).
- `registerAccountWebhookHandlers()` → `onStripeEvent("account.updated")`,
  `("capability.updated")` ⇒ `syncAccount` by `stripe_account_id`;
  `("account.application.deauthorized")` ⇒ set `disconnected_at`, event.

## 7. `catalog.ts` (+ test)
Settings singleton read/update with `expected_version` (409 stale) + change
row; product CRUD with slug generation, retire/reactivate, change rows with
`before/after`; `listCatalog()` returns wire `CatalogProduct[]` incl.
`thinnr_share_cents`, `break_even_minimum_cents`, `hq_profit_per_unit_cents`,
`offices_offering`, `offices_below_minimum` (join office prices). Actor
display names for changes via `fetchAuthUser` or the `profiles`/`team_members`
table — look at how `hq-audit-events.ts` resolves actor names and reuse.

## 8. `prices.ts` (+ test)
`listOfficePrices(providerId)` → wire `OfficePrice[]` for ACTIVE products (plus
retired ones the office still offers, flagged). `setOfficePrice(providerId,
productId, { sell_price_cents|null, subscription_enabled }, actor)`:
null ⇒ delete row (stop offering); below minimum ⇒ 400 `field: "sell_price_cents"`
with the minimum in the message; when a price changes and the office has a
connected account, mirror the recurring Stripe price (SPEC §4/§5: product +
4-week recurring price + shipping recurring price on the connected account;
archive the old price) — do this lazily via `ensureRecurringPrices(providerId,
productId)` exported for brief 03, and call it from `setOfficePrice` only when
`subscription_enabled`. Stripe failures here must not lose the DB write: save
the row first, then mirror, and surface a warning field `stripe_mirror: "failed"`
in the response (log it).

## 9. `links.ts` (+ test)
Token = 32 url-safe chars from `crypto.randomBytes`. `createLink`,
`listLinks`, `deactivateLink`, `resolveActiveLink(token)` (404 inactive),
`touchLinkUse(id)`, `linkUrl(token)` = `<origin>/pay/<token>`,
`resolvePayer(providerId, link, payerInput)` implementing the §4 resolution
rule (per-patient link ⇒ patient identity; generic ⇒ match `patients` by
normalized email then phone within the office, else create/reuse a
`billing_payers` row by lowercase email). `searchPatients(providerId, q)`
(name/email/phone ilike, limit 10).

## 10. `app-origin.ts` — `publicOrigin()` per SPEC §5 "App URL".

## 11. Webhooks
- `routes/billing-webhooks.ts`: `express.raw({ type: "application/json" })`,
  `POST /platform` and `POST /connect`; look up the endpoint secret by url
  (`<origin>/api/billing/webhooks/<kind>`, cached); `constructEvent`; insert
  `billing_webhook_events` (on conflict do nothing ⇒ 200 "duplicate"); call
  `registerBillingWebhookHandlers()` then `dispatchStripeEvent`; mark
  `processed_at` or `error`; respond 200 even on handler errors (log + store
  the error) and 400 only on signature failure. Test with
  `stripe.webhooks.generateTestHeaderString`.
- `webhook-endpoints.ts`: `ensureBillingWebhookEndpoints()` per SPEC §5
  (skip when `BILLING_WEBHOOKS_DISABLED=1` or `NODE_ENV==="test"` or no
  credentials; never throw out of boot — log). `getEndpointSecret(kind)`.

## 12. Routes
- `routes/billing-office.ts`: `GET /billing/office/status`
  (`OfficeBillingStatus` — includes `viewer` + `office`; call `syncAccount`
  lazily when `last_synced_at` older than 10 min and swallow Stripe errors into
  the stale row), `POST /billing/office/connect/create`,
  `GET /billing/office/connect/oauth/start`, `GET /billing/oauth/callback`
  (public; 302 per SPEC), `POST /billing/office/connect/account-session`,
  `POST /billing/office/connect/sync`, `GET/PUT /billing/office/prices[/:product_id]`,
  `GET/POST /billing/office/links`, `DELETE /billing/office/links/:id`,
  `GET /billing/office/patients/search`. Reads use `write: false`, writes
  `write: true`. Note the router is mounted under `/api` with no further prefix.
- `routes/billing-hq.ts`: `GET /billing/hq/catalog`, product CRUD + retire/
  reactivate, `PUT /billing/hq/catalog/settings`, `GET /billing/hq/catalog/changes`,
  `GET /billing/hq/providers` (`HqProviderRow[]` — 30-day order aggregates can
  come from `billing_orders` directly; brief 03 owns reporting.ts, so keep
  this a simple query here), `GET /billing/hq/providers/:provider_id`
  (`HqProviderDetail`; `recent_orders`/`payouts` come straight from the tables
  mapped to the wire shapes — write a small `toOrderSummary(row, items)` in
  `store.ts` so brief 03 can reuse it). Permissions: reads `financial_read`,
  catalog writes `settings_manage`, all via `requireHqPermission`.
- Route tests: fetch-mocked Supabase like `office-team.test.ts`; Stripe via
  `__setStripeForTests` with a hand-rolled fake object.

Do NOT implement orders, subscriptions, refunds, payouts, reporting, receipts,
public routes. Finish with server typecheck green and your tests green.
