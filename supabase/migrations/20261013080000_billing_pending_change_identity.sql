alter table public.billing_subscriptions
  add column if not exists pending_stripe_price_id text;