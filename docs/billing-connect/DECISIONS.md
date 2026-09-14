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
