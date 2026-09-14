alter table public.billing_subscriptions
  add column if not exists last_paid_invoice_id text;