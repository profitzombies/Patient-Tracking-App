create table if not exists public.billing_settings (
  id integer primary key default 1 check (id = 1),
  shipping_charge_cents integer not null default 1000 check (shipping_charge_cents >= 0),
  shipping_cost_cents integer not null default 1000 check (shipping_cost_cents >= 0),
  card_fee_bps integer not null default 290 check (card_fee_bps >= 0),
  card_fee_fixed_cents integer not null default 30 check (card_fee_fixed_cents >= 0),
  version integer not null default 1 check (version >= 1),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.billing_settings (id)
select 1
where not exists (select 1 from public.billing_settings where id = 1);

create table if not exists public.billing_products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  floor_price_cents integer not null check (floor_price_cents >= 0),
  hard_cost_cents integer not null check (hard_cost_cents >= 0),
  active boolean not null default true,
  retired_at timestamptz,
  sort_order integer not null,
  stripe_tax_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.billing_products
  (slug, name, floor_price_cents, hard_cost_cents, sort_order)
values
  ('control', 'Control', 5999, 433, 1),
  ('regulate', 'Regulate', 5999, 816, 2),
  ('detox', 'Detox', 5999, 679, 3),
  ('fiber', 'Fiber', 2999, 427, 4),
  ('creatine-plus', 'Creatine+', 8999, 1383, 5),
  ('b-active', 'B-Active', 8999, 500, 6),
  ('boost', 'Boost', 11999, 990, 7),
  ('maintenance-stack', 'Maintenance Stack', 9999, 1249, 8),
  ('maintenance-stack-2', 'Maintenance Stack – 2 Products', 9999, 1249, 9),
  ('maintenance-detox-stack', 'Maintenance + Detox Stack', 14999, 1928, 10)
on conflict (slug) do nothing;

create table if not exists public.billing_catalog_changes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.billing_products(id) on delete set null,
  kind text not null check (kind in (
    'product_created', 'product_updated', 'product_retired',
    'product_reactivated', 'settings_updated'
  )),
  before jsonb,
  after jsonb,
  actor_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_connected_accounts (
  provider_id text primary key references public.providers(provider_id),
  stripe_account_id text not null unique,
  origin text not null check (origin in ('created', 'oauth')),
  dashboard_type text not null check (dashboard_type in ('none', 'full', 'express')),
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  requirements jsonb not null default '{}'::jsonb,
  capabilities jsonb not null default '{}'::jsonb,
  default_currency text,
  business_name text,
  email text,
  tax_enabled boolean not null default false,
  tax_last_checked_at timestamptz,
  oauth_refresh_token text,
  livemode boolean not null,
  last_synced_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_account_events (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(provider_id),
  kind text not null check (kind in (
    'account_created', 'oauth_connected', 'onboarding_started',
    'requirements_updated', 'charges_enabled', 'payouts_enabled',
    'capability_updated', 'deauthorized', 'tax_enabled', 'tax_disabled'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_office_prices (
  provider_id text not null references public.providers(provider_id),
  product_id uuid not null references public.billing_products(id),
  sell_price_cents integer not null check (sell_price_cents >= 0),
  subscription_enabled boolean not null default false,
  stripe_product_id text,
  stripe_price_id text,
  stripe_shipping_price_id text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_id, product_id)
);

create table if not exists public.billing_payment_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  provider_id text not null references public.providers(provider_id),
  patient_id uuid references public.patients(id) on delete set null,
  created_by uuid,
  label text,
  active boolean not null default true,
  expires_at timestamptz,
  uses integer not null default 0 check (uses >= 0),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_payers (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(provider_id),
  patient_id uuid references public.patients(id) on delete set null,
  name text not null,
  email text not null,
  phone text,
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, stripe_customer_id)
);

create table if not exists public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(provider_id),
  payer_id uuid not null references public.billing_payers(id),
  patient_id uuid references public.patients(id) on delete set null,
  product_id uuid not null references public.billing_products(id),
  stripe_subscription_id text not null unique,
  stripe_customer_id text not null,
  status text not null check (status in ('incomplete', 'active', 'past_due', 'canceled', 'unpaid')),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  shipping_charge_cents integer not null check (shipping_charge_cents >= 0),
  application_fee_cents integer not null check (application_fee_cents >= 0),
  shipping_address jsonb not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  cancel_token text not null unique,
  livemode boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  provider_id text not null references public.providers(provider_id),
  payer_id uuid not null references public.billing_payers(id),
  patient_id uuid references public.patients(id) on delete set null,
  link_id uuid references public.billing_payment_links(id) on delete set null,
  kind text not null check (kind in ('one_time', 'subscription_initial', 'subscription_renewal')),
  subscription_id uuid references public.billing_subscriptions(id) on delete set null,
  status text not null check (status in (
    'pending', 'paid', 'failed', 'refunded', 'partially_refunded',
    'disputed', 'canceled'
  )),
  currency text not null default 'usd',
  subtotal_cents integer not null check (subtotal_cents >= 0),
  shipping_charge_cents integer not null check (shipping_charge_cents >= 0),
  tax_cents integer not null check (tax_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  application_fee_cents integer not null check (application_fee_cents >= 0),
  application_fee_collected_cents integer check (application_fee_collected_cents >= 0),
  stripe_fee_cents integer check (stripe_fee_cents >= 0),
  office_net_cents integer,
  hard_cost_cents integer not null check (hard_cost_cents >= 0),
  shipping_cost_cents integer not null check (shipping_cost_cents >= 0),
  hq_profit_cents integer,
  shipping_address jsonb not null,
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_balance_transaction_id text,
  livemode boolean not null,
  paid_at timestamptz,
  fulfillment_status text not null default 'to_ship'
    check (fulfillment_status in ('to_ship', 'shipped', 'canceled')),
  tracking_number text,
  carrier text,
  shipped_at timestamptz,
  shipped_by uuid,
  canceled_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.billing_orders(id) on delete cascade,
  product_id uuid not null references public.billing_products(id),
  product_name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  floor_price_cents_snapshot integer not null check (floor_price_cents_snapshot >= 0),
  thinnr_share_cents integer not null check (thinnr_share_cents >= 0),
  hard_cost_cents_snapshot integer not null check (hard_cost_cents_snapshot >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_ledger (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(provider_id),
  order_id uuid references public.billing_orders(id),
  subscription_id uuid references public.billing_subscriptions(id),
  kind text not null check (kind in (
    'sale', 'refund', 'dispute_opened', 'dispute_won', 'dispute_lost',
    'application_fee_adjustment', 'fee_discrepancy', 'payout'
  )),
  amount_cents integer not null,
  application_fee_cents integer not null,
  stripe_ref text,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.billing_orders(id),
  stripe_refund_id text not null unique,
  amount_cents integer not null check (amount_cents >= 0),
  reason text not null,
  status text not null,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.billing_orders(id),
  stripe_dispute_id text not null unique,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null,
  reason text,
  evidence_due_by timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_payouts (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(provider_id),
  stripe_payout_id text not null unique,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null,
  arrival_date date,
  method text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('platform', 'connect')),
  url text not null unique,
  stripe_endpoint_id text,
  secret text not null,
  livemode boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_webhook_events (
  stripe_event_id text primary key,
  kind text not null check (kind in ('platform', 'connect')),
  type text not null,
  account text,
  livemode boolean not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_orders_provider_created_idx
  on public.billing_orders (provider_id, created_at desc);
create index if not exists billing_orders_patient_idx
  on public.billing_orders (patient_id);
create index if not exists billing_orders_status_idx
  on public.billing_orders (status);
create index if not exists billing_orders_fulfillment_status_idx
  on public.billing_orders (fulfillment_status);
create index if not exists billing_ledger_provider_occurred_idx
  on public.billing_ledger (provider_id, occurred_at desc);
create index if not exists billing_subscriptions_provider_status_idx
  on public.billing_subscriptions (provider_id, status);
create index if not exists billing_payers_provider_lower_email_idx
  on public.billing_payers (provider_id, lower(email));

create or replace function public.billing_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

do $triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'billing_settings', 'billing_products', 'billing_catalog_changes',
    'billing_connected_accounts', 'billing_account_events',
    'billing_office_prices', 'billing_payment_links', 'billing_payers',
    'billing_orders', 'billing_order_items', 'billing_subscriptions',
    'billing_ledger', 'billing_refunds', 'billing_disputes',
    'billing_payouts', 'billing_webhook_endpoints', 'billing_webhook_events'
  ]
  loop
    execute format('drop trigger if exists billing_touch_updated_at on public.%I', table_name);
    execute format(
      'create trigger billing_touch_updated_at before update on public.%I '
      'for each row execute function public.billing_touch_updated_at()',
      table_name
    );
  end loop;
end;
$triggers$;

do $rls$
declare
  table_name text;
begin
  foreach table_name in array array[
    'billing_settings', 'billing_products', 'billing_catalog_changes',
    'billing_connected_accounts', 'billing_account_events',
    'billing_office_prices', 'billing_payment_links', 'billing_payers',
    'billing_orders', 'billing_order_items', 'billing_subscriptions',
    'billing_ledger', 'billing_refunds', 'billing_disputes',
    'billing_payouts', 'billing_webhook_endpoints', 'billing_webhook_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
  end loop;
end;
$rls$;

revoke all on function public.billing_touch_updated_at() from public, anon, authenticated;