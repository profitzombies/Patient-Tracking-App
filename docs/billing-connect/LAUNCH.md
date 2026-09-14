# Billing Connect — go-live checklist

Work through this top to bottom before the first office collects a real
payment. Every item is either a configuration step outside the code or an
automated check that already exists. Nothing here changes code.

## 1. Stripe account (platform)

- [ ] Stripe account is fully activated for live payments (business details,
      bank account, identity checks) and **Connect** is enabled on it with the
      platform profile completed (Stripe Dashboard → Connect → Settings).
- [ ] Connect branding is set (name "THINNR", icon, brand colour) so office
      owners see THINNR on the OAuth screen and on embedded components.
- [ ] Stripe Connect **OAuth redirect URI** registered:
      `https://<production origin>/api/billing/connect/callback`
      (Connect → Settings → Integration → Redirects). Test-mode and live-mode
      lists are separate; add the URI to both.
- [ ] Stripe Tax is enabled on the platform account if any office intends to
      collect tax (office-level `tax_enabled` is refused otherwise).
- [ ] Application fee behaviour reviewed: first invoice fee is capped at the
      product's exact fee; renewals set `application_fee_amount` on
      `invoice.created` (see DECISIONS.md, 03-server-orders).

## 2. Replit configuration

- [ ] **Stripe connection** in the workspace is switched to the **live** keys
      (the API only ever reads keys from the Replit Stripe connection; nothing
      is stored in env or code). The HQ Payments overview shows a "Sandbox"
      chip while `pk_test_` keys are in use; it must disappear in production.
- [ ] `STRIPE_CONNECT_CLIENT_ID` production secret set to the **live** `ca_…`
      client id (test and live ids differ). Without it the OAuth path is
      hidden and only in-app account creation is offered.
- [ ] `BILLING_PUBLIC_ORIGIN` production env set to the published origin
      (`https://…`) with no trailing slash. This origin is baked into payment
      links, receipt emails, cancel links, the OAuth redirect and the webhook
      endpoint URLs. Leaving it unset falls back to `REPLIT_DOMAINS`, which is
      correct for the published app but wrong for a custom domain.
- [ ] `CLAIM_EMAIL_FROM` is a verified Resend sender; billing mail is sent as
      "THINNR Weight Loss <that address>". `RESEND_API_KEY` present.
- [ ] `BILLING_WEBHOOKS_DISABLED` is **not** set in production.
- [ ] Optional knobs reviewed: `BILLING_RECONCILE_PENDING_MINUTES` (default 60),
      `BILLING_WEBHOOK_PAYLOAD_RETENTION_DAYS` (default 90).

## 3. Database

- [ ] Every `supabase/migrations/2026101*_billing_*.sql` file and the privacy
      purge replacement migration have been applied to the live Supabase
      project through the management API, in file order, and the security
      advisors were re-checked afterwards.
- [ ] `select count(*) from billing_webhook_endpoints` returns the two
      self-registered endpoints (`platform`, `connect`) with live URLs after
      the first production boot.

## 4. First production boot

- [ ] Publish, then open **HQ → Payments**. The health banner at the top must
      be absent (healthy). If it shows problems, fix them before inviting an
      office: webhooks not registered means the origin or keys are wrong.
- [ ] `GET /api/billing/hq/health` (signed in as HQ with financial read)
      shows `credentials_ok: true`, `sandbox: false`, both webhook endpoints
      `enabled`, `connect_client_id_configured: true`.
- [ ] **HQ → System health** lists `billing-reconcile` and
      `retention-billing-webhooks`; run `billing-reconcile` once with "Run now"
      and confirm it succeeds with zero items.
- [ ] In the Stripe Dashboard → Developers → Webhooks, both endpoints exist,
      the Connect one has "Listen to events on connected accounts" enabled,
      and a test delivery returns 200.

## 5. Pilot office (first real office)

- [ ] Office owner connects their account from **Payments → Get started**
      (in-app account creation or OAuth). `charges_enabled` and
      `payouts_enabled` show green in HQ → Payments → Offices.
- [ ] Office sets prices at or above every floor; HQ sees the price list.
- [ ] A $1 real-card one-time order end to end: pay, receipt email arrives,
      order appears in office fulfilment queue and HQ orders, ledger shows
      the fee split, refund it from HQ, refund email/ledger reconcile,
      `charge.refunded` webhook processed (HQ → Payments → health has zero
      unprocessed events).
- [ ] One subscription order with a real card, then cancel at period end from
      the patient cancel link; cancellation email arrives.
- [ ] Payout appears in the office Payouts tab after Stripe's first payout.

## 6. Ongoing operations

- The reconcile job repairs missed webhooks every 30 minutes; a red or amber
  banner on HQ → Payments is the signal that something needs a person.
- Money actions (refunds, cancellations, price changes, link changes, connect
  and disconnect, fulfilment) are in HQ → Audit and the office Audit page.
- Patient account deletion anonymises billing rows and cancels live
  subscriptions; financial records are never deleted (see DECISIONS.md).
- Webhook payloads are pruned after 90 days; processed events keep their
  ids and outcome.

## 7. Rollback

- Switching the Replit Stripe connection back to test keys immediately puts
  the whole billing area in sandbox mode (chip reappears, links use test
  keys). Existing live subscriptions keep billing inside Stripe; pause them
  from the Stripe Dashboard if a rollback must stop money movement.
