# Billing Connect — go-live checklist

Work through this top to bottom before the first office collects a real
payment. Every item is either a configuration step outside the code or an
automated check that already exists. Nothing here changes code.
For the first internal test office in Test mode, start with
`docs/first-live-provider.md`.

## 1. Stripe account (platform)

- [ ] Stripe account is fully activated for live payments (business details,
      bank account, identity checks) and **Connect** is enabled on it with the
      platform profile completed (Stripe Dashboard → Connect → Settings).
- [ ] Connect branding is set (name "THINNR", icon, brand colour) so office
      owners see THINNR on the OAuth screen and on embedded components.
- [ ] Stripe Connect **OAuth redirect URI** registered:
      `https://app.trythinnr.com/api/billing/oauth/callback`
      (Connect → Settings → Integration → Redirects). Test-mode and live-mode
      lists are separate; add the URI to both.
- [ ] Stripe Tax is enabled on the platform account if any office intends to
      collect tax (office-level `tax_enabled` is refused otherwise).
- [ ] Application fee behaviour reviewed: first invoice fee is capped at the
      product's exact fee; renewals set `application_fee_amount` on
      `invoice.created` (see DECISIONS.md, 03-server-orders).

## 2. Environment configuration

- [ ] Set `BILLING_DEPLOYMENT_ID` to a stable identifier unique to this deployment
      (development and production must differ). This namespaces the persisted HQ
      mode selection; an absent selection defaults to Test. Changing the identifier
      is not a migration or a way to reuse another deployment's financial records.

- [ ] Configure the separate test/live environment credentials; connector credentials
      are no longer read. Verify the selected mode in HQ before taking payments.
      Complete variable names for Test: `STRIPE_TEST_SECRET_KEY`,
      `STRIPE_TEST_PUBLISHABLE_KEY`, `STRIPE_TEST_PLATFORM_ACCOUNT_ID`,
      `STRIPE_TEST_CONNECT_CLIENT_ID`, `STRIPE_TEST_PLATFORM_WEBHOOK_SECRET`,
      `STRIPE_TEST_CONNECT_WEBHOOK_SECRET`. Live equivalents:
      `STRIPE_LIVE_SECRET_KEY`, `STRIPE_LIVE_PUBLISHABLE_KEY`,
      `STRIPE_LIVE_PLATFORM_ACCOUNT_ID`, `STRIPE_LIVE_CONNECT_CLIENT_ID`,
      `STRIPE_LIVE_PLATFORM_WEBHOOK_SECRET`, `STRIPE_LIVE_CONNECT_WEBHOOK_SECRET`.
      Use matching `sk_test_…`/`pk_test_…` or `sk_live_…`/`pk_live_…` pairs and
      the expected platform `acct_…`. Never put secrets in source, logs, client
      build variables, or `.replit`. Missing keys disable payment actions only.
- [ ] The API verifies platform identity before returning a Stripe client.
      Verification is cached for five minutes and invalidates on key/account
      changes. Restart deployed processes after secret rotation. Unscoped code
      defaults to Test; maintained sales/smoke scripts explicitly request Test.
      Do not relabel sandbox records to make them usable in Live.
- [ ] Synthetic tests verify code, not real Stripe configuration. Real validation
      remains pending credentials and an authorized test plan. No real charge,
      publishing, activation or credential request is part of this conversion.
      Removing the installed integration and checking Publish gating remain
      separate manual platform actions: code independence does not prove the
      Publish prompt is removed.
      Owner-only disconnect path: **Integrations → Stripe → Manage → disconnect**.
      Do not remove it automatically; review platform publishing requirements after
      any manual disconnect rather than assuming the Publish gate is fixed.
- [ ] The mode-specific Connect client id is set to the matching `ca_…`
      client id (test and live ids differ). Without it the OAuth path is
      hidden and only in-app account creation is offered.
- [ ] `BILLING_PUBLIC_ORIGIN` production env set to the published origin
      (`https://…`) with no trailing slash. This origin is baked into payment
      links, receipt emails, cancel links, the OAuth redirect and the webhook
      endpoint URLs. Leaving it unset falls back to `REPLIT_DOMAINS`, which is
      correct for the published app but wrong for a custom domain.
- [ ] `CLAIM_EMAIL_FROM` is a verified Resend sender; billing mail is sent as
      "THINNR Weight Loss <that address>". `RESEND_API_KEY` present.
- [ ] Register four webhook destinations manually in the matching Stripe account/mode:
      `/api/billing/webhooks/test/platform`, `/api/billing/webhooks/test/connect`,
      `/api/billing/webhooks/live/platform`, `/api/billing/webhooks/live/connect`.
      Platform destinations receive events on your account; Connect destinations
      receive events on connected accounts. Store each signing secret in
      `STRIPE_TEST_PLATFORM_WEBHOOK_SECRET`, `STRIPE_TEST_CONNECT_WEBHOOK_SECRET`,
      `STRIPE_LIVE_PLATFORM_WEBHOOK_SECRET`, `STRIPE_LIVE_CONNECT_WEBHOOK_SECRET`.
      The server never creates, deletes, or prunes Stripe webhook destinations.
      Old mode-less URLs fail closed with HTTP 410: migrate Dashboard destinations
      explicitly. Both mode-specific routes remain available for delayed deliveries.
- [ ] Platform subscriptions (6): `account.application.deauthorized`, plus the
      office-access events THINNR's own charges to offices need:
      `payment_intent.succeeded`, `payment_intent.payment_failed`,
      `charge.dispute.created`, `setup_intent.succeeded`, `setup_intent.setup_failed`.
      Connect subscriptions (20): `account.updated`, `capability.updated`,
      `invoice.created`, `invoice.paid`, `invoice.payment_failed`, `invoice.finalized`,
      `customer.subscription.created`, `customer.subscription.updated`,
      `customer.subscription.deleted`, `charge.refunded`, `refund.updated`,
      `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`,
      `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`,
      `payout.paid`, `payout.failed`, `payout.canceled`, `payment_intent.payment_failed`.
      Adding `account.application.deauthorized` to the Connect destination too is
      recommended (offices that disconnect themselves are noticed sooner).
      Source of truth: `BILLING_WEBHOOK_EVENTS` in `webhook-endpoints.ts`.
- [ ] Each destination's **API version** is in the same family as the server's
      Stripe library (`2026-08-26.dahlia` today; `EXPECTED_STRIPE_API_VERSION`).
      Stripe cannot change a destination's version after it is created: if it is
      on another family (for example `….basil`), create a new destination at the
      same URL on the right version, save its new signing secret, then delete the
      old one. Payloads in an older family can be read wrongly.
- [ ] A configured signing secret alone does not prove Dashboard registration.
      HQ → Payments health and HQ → System health read the destinations from
      Stripe (read-only) and name each problem: missing, wrong scope (platform vs
      connected accounts), disabled, missing events, secret not saved, API
      version mismatch, or an API version Stripe did not report (unpinned
      destination and no recent event to read the account default from; shown
      as "Check", never as healthy). Verify deliveries in Stripe before launch
      without making live charges.
- [ ] Optional knobs reviewed: `BILLING_RECONCILE_PENDING_MINUTES` (default 60),
      `BILLING_WEBHOOK_PAYLOAD_RETENTION_DAYS` (default 90).
- [ ] WarehouseCraft live tenant: secrets `WAREHOUSECRAFT_API_BASE_URL`,
      `WAREHOUSECRAFT_API_USERNAME`, `WAREHOUSECRAFT_API_PASSWORD` hold the LIVE
      tenant, and the production env var `WAREHOUSECRAFT_TENANT_MODE=live` is set
      only after they exist. The tenant counts as live only when the flag AND all
      three live settings are set; the flag with any of them blank stays on the
      test tenant, real orders stay held, and System health fails the tenant
      check naming what is missing. Each tenant signs in with its own login only:
      live uses `WAREHOUSECRAFT_API_*`, test uses `NOVEX_API_*`, never a mix.
      Development strips all four (`scripts/dev-environment.mjs`) and stays on
      the `NOVEX_API_*` test tenant. Real orders are released only from the live
      tenant while Live is selected; Test orders never reach it.
      HQ → System health → Warehouse must show the connection, tenant and
      catalog checks passing (every sold product needs a warehouse SKU; a
      missing weight falls back to the flat shipping charge).

## 3. Database

- [ ] Legacy rows with nullable billing identity remain quarantined until an
      authorized operator verifies their actual Stripe platform account and mode,
      then explicitly classifies the related records consistently. Null does not
      mean Test. Existing sandbox records are not usable merely because Test is
      selected, and must never be silently relabeled Live or financially migrated.

- [ ] Every `supabase/migrations/2026101*_billing_*.sql` file and the privacy
      purge replacement migration have been applied to the live Supabase
      project through the management API, in file order, and the security
      advisors were re-checked afterwards.
- [ ] `20261203000000_billing_payouts_allow_debits.sql` is applied (through
      `scripts/apply-coach-migrations.mjs --project <ref>`). Stripe debits an
      office's bank with a negative payout when its balance stays negative;
      without this the payout webhook fails and stays unprocessed.
- [ ] Historical `billing_webhook_endpoints` rows are not used as signing-secret
      configuration. Confirm the Dashboard destinations and environment secrets
      instead; startup never provisions live endpoints.

## 4. First production boot

- [ ] Publish, then open **HQ → Payments**. The health banner at the top must
      be absent (healthy). If it shows problems, fix them before inviting an
      office: webhooks not registered means the origin or keys are wrong.
- [ ] `GET /api/billing/hq/health` (signed in as HQ with financial read, Live
      selected) shows `credentials_ok: true`, `sandbox: false`,
      `connect_client_id_configured: true`, `public_origin:
      "https://app.trythinnr.com"`, `webhooks.mode: "live"`,
      `webhooks.registered: true` and both `webhooks.endpoints[].status: "ok"`.
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

- Selecting **Test** again in HQ → Settings → Stripe payment mode puts the whole billing area back
  in sandbox mode (chip reappears, new links and checkouts use test keys).
  Live records stay Live and are never relabeled. Existing live subscriptions
  keep billing inside Stripe; pause them from the Stripe Dashboard if a
  rollback must stop money movement.
