alter table public.billing_webhook_events
  add column if not exists retry_count integer not null default 0
  check (retry_count >= 0);