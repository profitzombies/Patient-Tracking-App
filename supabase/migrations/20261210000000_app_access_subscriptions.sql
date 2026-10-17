begin;
-- App access: an office may charge its patients a recurring fee for the
-- app's premium AI features (THINNR keeps a flat 30%). This migration adds
--   * the product kind that keeps the one "app access" catalog row apart from
--     every physical product (no shipping, no warehouse order, no floor price),
--   * the per-office app-access settings on the shared office settings row,
--   * the per-identity Stripe price mirror on the office's connected account,
--   * the subscription kind, and
--   * the 'not_required' fulfillment status, which keeps app-access orders out
--     of the shipment and warehouse triggers.
-- The entitlement rule itself lives in
-- artifacts/api-server/src/billing/app-access/entitlement.ts (pure); nothing
-- here derives a patient's access state.

-- ── Catalog: the product kind ───────────────────────────────────────────────
alter table public.billing_products
  add column if not exists kind text not null default 'physical';
alter table public.billing_products
  drop constraint if exists billing_products_kind_check;
alter table public.billing_products
  add constraint billing_products_kind_check check (kind in ('physical', 'app_access'));
alter table public.billing_products
  drop constraint if exists billing_products_category_check;
alter table public.billing_products
  add constraint billing_products_category_check
  check (category in ('drops', 'supplement', 'bundle', 'app_access'));
-- Exactly one app-access product, ever.
create unique index if not exists billing_products_app_access_single_idx
  on public.billing_products (kind) where kind = 'app_access';

-- The row is deliberately NOT active: `active` is what every physical
-- offering, price and launch query keys on, so an inactive row stays out of
-- every storefront, price list and setup-wizard count without touching them.
-- Subscriptions reference it by this fixed id (billing/app-access/catalog.ts).
insert into public.billing_products
  (id, slug, name, description, category, kind, floor_price_cents, hard_cost_cents, active, status, sort_order,
   tagline, format, benefits, how_to_take, facts_title, facts, faqs, disclaimer)
values
  ('a99acce5-0000-4000-8000-000000000001', 'app-access', 'THINNR app premium features',
   'Recurring access to the app''s premium AI features (coach, photo and menu reads, barcode lookup).',
   'app_access', 'app_access', 0, 0, false, 'draft', 1000000,
   '', 'Subscription', '[]'::jsonb, '', '', '[]'::jsonb, '[]'::jsonb, '')
on conflict (slug) do update
  set kind = 'app_access', category = 'app_access', floor_price_cents = 0, hard_cost_cents = 0;

-- ── Office settings (shared across payment identities) ─────────────────────
alter table public.billing_office_settings
  add column if not exists app_access_enabled boolean not null default false,
  add column if not exists app_access_price_cents integer,
  add column if not exists app_access_cadence text not null default 'monthly',
  add column if not exists app_access_trial_days integer not null default 7;
alter table public.billing_office_settings
  drop constraint if exists billing_office_settings_app_access_price_check;
alter table public.billing_office_settings
  add constraint billing_office_settings_app_access_price_check
  check (app_access_price_cents is null or (app_access_price_cents >= 50 and app_access_price_cents <= 100000000));
alter table public.billing_office_settings
  drop constraint if exists billing_office_settings_app_access_cadence_check;
alter table public.billing_office_settings
  add constraint billing_office_settings_app_access_cadence_check
  check (app_access_cadence in ('2_weeks', 'monthly'));
alter table public.billing_office_settings
  drop constraint if exists billing_office_settings_app_access_trial_check;
alter table public.billing_office_settings
  add constraint billing_office_settings_app_access_trial_check
  check (app_access_trial_days >= 0 and app_access_trial_days <= 365);
-- Charging needs a price: the switch cannot be on without one.
alter table public.billing_office_settings
  drop constraint if exists billing_office_settings_app_access_enabled_price_check;
alter table public.billing_office_settings
  add constraint billing_office_settings_app_access_enabled_price_check
  check (not app_access_enabled or app_access_price_cents is not null);

-- The audit kinds for the office's app-access settings (and the shipping
-- override kind the server already records) join the catalog change ledger.
alter table public.billing_catalog_changes
  drop constraint if exists billing_catalog_changes_kind_check;
alter table public.billing_catalog_changes
  add constraint billing_catalog_changes_kind_check
  check (kind in (
    'product_created', 'product_updated', 'product_retired',
    'product_reactivated', 'product_published', 'product_archived',
    'product_unarchived', 'product_image_added', 'product_image_removed',
    'product_default_image', 'products_reordered', 'office_price_updated',
    'settings_updated', 'office_shipping_settings_updated', 'office_app_access_settings_updated'
  ));

-- ── Stripe price mirror (per payment identity) ─────────────────────────────
-- Stripe ids only mean something on the account they were created on, so the
-- mirror is isolated per Stripe mode + platform account like every other
-- Stripe-derived row (the shared settings row above never stores them).
create table if not exists public.billing_app_access_prices (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  -- The amount + cadence the mirrored price was created for; the server
  -- replaces the Stripe price whenever the settings no longer match.
  price_cents integer not null check (price_cents >= 50),
  cadence text not null check (cadence in ('2_weeks', 'monthly')),
  stripe_product_id text,
  stripe_price_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stripe_mode text not null check (stripe_mode in ('test', 'live')),
  stripe_platform_account_id text not null,
  constraint billing_app_access_prices_identity_pair
    check (stripe_mode is not null and stripe_platform_account_id is not null),
  constraint billing_app_access_prices_provider_key
    unique (provider_id, stripe_mode, stripe_platform_account_id)
);
create index if not exists billing_app_access_prices_identity_idx
  on public.billing_app_access_prices (stripe_mode, stripe_platform_account_id);
alter table public.billing_app_access_prices enable row level security;
revoke all on table public.billing_app_access_prices from public, anon, authenticated;
grant all on table public.billing_app_access_prices to service_role;
drop trigger if exists billing_identity_guard on public.billing_app_access_prices;
create trigger billing_identity_guard before insert or update on public.billing_app_access_prices
  for each row execute function public.guard_billing_identity();
drop trigger if exists billing_app_access_prices_touch on public.billing_app_access_prices;
create trigger billing_app_access_prices_touch before update on public.billing_app_access_prices
  for each row execute function public.billing_touch_updated_at();

-- ── Subscriptions: the kind ────────────────────────────────────────────────
alter table public.billing_subscriptions
  add column if not exists kind text not null default 'product';
alter table public.billing_subscriptions
  drop constraint if exists billing_subscriptions_kind_check;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_kind_check check (kind in ('product', 'app_access'));
-- One open app-access subscription per patient per payment identity: the
-- entitlement reads "the" subscription, so a second one must never start.
create unique index if not exists billing_subscriptions_app_access_open_idx
  on public.billing_subscriptions (patient_id, stripe_mode, stripe_platform_account_id)
  where kind = 'app_access' and status in ('incomplete', 'active', 'past_due', 'unpaid') and patient_id is not null;

-- ── Orders: nothing to ship ────────────────────────────────────────────────
alter table public.billing_orders
  drop constraint if exists billing_orders_fulfillment_status_check;
alter table public.billing_orders
  add constraint billing_orders_fulfillment_status_check
  check (fulfillment_status in ('to_ship', 'shipped', 'canceled', 'not_required'));

-- An app-access order never gets a shipment row …
create or replace function public.billing_order_create_shipment()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.fulfillment_status = 'not_required' then return new; end if;
  insert into public.billing_shipments(order_id, provider_id, status, stripe_mode, stripe_platform_account_id)
  values(new.id, new.provider_id, 'processing', new.stripe_mode, new.stripe_platform_account_id)
  on conflict(order_id, stripe_mode, stripe_platform_account_id) do nothing;
  return new;
end $$;

-- … nor a warehouse submission intent.
create or replace function public.billing_order_queue_warehouse()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.fulfillment_status = 'not_required' then return new; end if;
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    insert into public.billing_warehouse_submissions (
      order_id, provider_id, patient_id, stripe_mode, stripe_platform_account_id
    )
    values (
      new.id, new.provider_id, new.patient_id, new.stripe_mode, new.stripe_platform_account_id
    )
    on conflict (order_id, stripe_mode, stripe_platform_account_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.billing_order_queue_warehouse() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
