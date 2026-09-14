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
