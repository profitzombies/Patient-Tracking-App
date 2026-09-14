alter table public.billing_subscriptions
  add column if not exists last_payment_failed_at timestamptz,
  add column if not exists payment_failure_count integer not null default 0,
  add column if not exists last_failed_invoice_id text,
  add column if not exists last_hosted_invoice_url text,
  add column if not exists last_failure_message text,
  add column if not exists payment_failure_email_sent_invoice_id text;

alter table public.billing_orders
  add column if not exists failure_message text;

alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_payment_failure_count_check;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_payment_failure_count_check
  check (payment_failure_count >= 0);

alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_last_failure_message_check;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_last_failure_message_check
  check (last_failure_message is null or char_length(last_failure_message) <= 200);