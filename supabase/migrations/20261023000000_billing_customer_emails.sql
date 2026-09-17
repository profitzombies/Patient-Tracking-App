-- Branded shop emails: one row per customer email THINNR has claimed for a
-- trusted transition. The unique dedupe key IS the once-only guarantee: the
-- row is inserted before the send, so a webhook replay, job re-run, or double
-- tap finds the claim and sends nothing. Rows hold ids only (no addresses,
-- names, or message bodies); the generic purge loop skips billing_% tables.
create table if not exists public.billing_customer_emails (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  template_id text not null,
  provider_id text references public.providers(provider_id),
  subscription_id uuid,
  order_id uuid,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'skipped', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_customer_emails_dedupe_key_unique unique (dedupe_key)
);
create index if not exists billing_customer_emails_subscription_idx on public.billing_customer_emails (subscription_id, created_at desc);
create index if not exists billing_customer_emails_order_idx on public.billing_customer_emails (order_id, created_at desc);
alter table public.billing_customer_emails enable row level security;
revoke all on public.billing_customer_emails from anon, authenticated;
drop trigger if exists billing_touch_updated_at on public.billing_customer_emails;
create trigger billing_touch_updated_at before update on public.billing_customer_emails
  for each row execute function public.billing_touch_updated_at();

-- Whether Stripe itself may email this office's customers (receipts, invoice
-- and renewal notices). THINNR sends every customer email, so the expected
-- state is 'off'. Stripe exposes no API for the Customer emails toggles: an
-- account without Stripe Dashboard access can never turn them on ('off' by
-- construction), while an account with its own Dashboard controls them itself
-- and is only 'off' once HQ confirms it ('unverified' until then).
alter table public.billing_connected_accounts
  add column if not exists stripe_customer_emails text not null default 'unverified'
    check (stripe_customer_emails in ('off', 'unverified', 'on')),
  add column if not exists stripe_customer_emails_checked_at timestamptz,
  add column if not exists stripe_customer_emails_note text;

-- Accounts THINNR created have no Stripe Dashboard, so Stripe cannot email
-- their customers; record that instead of waiting for the next sync.
update public.billing_connected_accounts
   set stripe_customer_emails = 'off', stripe_customer_emails_checked_at = now(),
       stripe_customer_emails_note = 'No Stripe Dashboard: Stripe customer emails cannot be enabled on this account.'
 where dashboard_type = 'none' and stripe_customer_emails <> 'off';
