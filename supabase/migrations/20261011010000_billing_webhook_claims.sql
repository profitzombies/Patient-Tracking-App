-- A webhook event remains retryable after a failed handler while a short lease
-- prevents concurrent Stripe deliveries from dispatching the same event.
alter table public.billing_webhook_events
  add column if not exists claimed_at timestamptz;

create index if not exists billing_webhook_events_unprocessed_claim_idx
  on public.billing_webhook_events (claimed_at)
  where processed_at is null;