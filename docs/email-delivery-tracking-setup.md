# Email delivery tracking (Resend webhooks) — setup

HQ → Payments → **Email outbox** (`/admin/payments/emails`) lists every outbound
customer email across offices with the vendor's delivery facts (delivered,
delivery delayed, bounced, marked as spam, opened, clicked), a summary strip for
the active filter, and the same preview / Resend / send-to-other actions as the
order page. Those facts arrive through a signed vendor webhook; nothing is
inferred. Until the webhook is live the page says **Tracking not enabled**
instead of showing zeros, and HQ → System health shows the same state under
"Email delivery tracking".

## One-time setup (user actions in the Resend dashboard)

1. **Switch on tracking for the sending domain.** Resend → Domains → the domain
   THINNR sends from → enable **Open tracking** and **Click tracking**. Both are
   off by default. Open tracking adds a 1×1 pixel to each HTML email; click
   tracking rewrites links through Resend's redirect. Plain-text-only sends
   cannot be tracked.
2. **Add the webhook endpoint.** Resend → Webhooks → Add endpoint:
   - URL: `https://<your production origin>/api/email/webhooks/resend`
     (`BILLING_PUBLIC_ORIGIN` is the production origin).
   - Events: `email.sent`, `email.delivered`, `email.delivery_delayed`,
     `email.bounced`, `email.complained`, `email.opened`, `email.clicked`.
     Other Resend event types are accepted and ignored.
3. **Store the signing secret.** Copy the endpoint's signing secret
   (`whsec_…`) into the workspace secret **`RESEND_WEBHOOK_SECRET`** for the
   environment that receives the webhook (production; development too if you
   point a second endpoint at the dev URL). Never commit it. Without the secret
   the route answers `503 Email tracking is not enabled.` and counts nothing.

Optional: `EMAIL_WEBHOOK_STALLED_MINUTES` (default 120) — how long after the
newest confirmed customer send the system waits for any event before raising the
HQ staff alert "Email delivery tracking stalled".

## How to read the numbers

- **Opens are indicative, not authoritative.** Apple Mail Privacy Protection,
  Gmail image proxies, and corporate scanners pre-fetch the pixel (false opens);
  clients that block images never fire it (missed opens). Clicks are far more
  reliable.
- **Delivered** means the recipient's mail server accepted the message, not that
  it reached the inbox.
- **Sent** counts on the outbox strip come from THINNR's own ledger; only
  bounced / opened / clicked come from the vendor and show "Tracking not
  enabled" until the first event lands.

## How it works (for engineers)

- Route `POST /api/email/webhooks/resend` (`src/routes/email-webhooks.ts`)
  verifies the Svix-style headers (`svix-id`, `svix-timestamp`,
  `svix-signature`, 5-minute tolerance, constant-time compare), normalises the
  event, and stores it once per `svix-id` in `email_vendor_events`. Events whose
  `email_id` matches a `billing_customer_emails.vendor_message_id` are copied
  into `billing_customer_email_events` and the first-seen timestamps
  (`delivered_at`, `opened_at`, …) plus `last_event_type/at` are denormalised
  onto the ledger row. Unknown ids stay unlinked; the `email-webhook-rematch`
  job (runs on the external tick) links them when the send finalises.
- Signature failures are counted in the singleton `email_webhook_health` row
  (`rejected_today` is a UTC day) and surfaced on System health.
- `GET /api/billing/hq/emails?summary=1` returns `summary` (counts over the
  whole filter, capped at 5,000 rows with a `truncated` flag) and `tracking`
  (`configured`, `last_event_at`) alongside the page. Filters: `q` (patient,
  office, phone, email, order number), `template`, `status` (ledger statuses
  plus `delivered|opened|clicked|delayed|bounced|complained`), `provider_id`,
  `from`, `to`, `cursor`.
- Migration: `supabase/migrations/20261117000000_email_vendor_webhook_events.sql`.
- Tests: `src/email/vendor-webhook.test.ts`, `src/routes/email-webhooks.test.ts`,
  `src/routes/billing-customer-emails.test.ts`; web
  `pnpm --filter @workspace/thinnr-operations run test:email-outbox`.
