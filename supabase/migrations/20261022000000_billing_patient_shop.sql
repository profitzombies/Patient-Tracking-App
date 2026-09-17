-- Patient shop: shipments, subscription plans, and cart grouping.
--
-- Shipments become their own record so a future shipping provider can post
-- label / transit / delivered updates without touching the order row or the
-- patient-facing contract. One shipment per order (the order IS the parcel
-- today); the legacy fulfillment columns on billing_orders stay in place and
-- are mirrored by the API on every shipment write so staff screens, HQ
-- fulfillment filters, and shipped-notice emails keep working unchanged.
--   to_ship  → processing
--   shipped  → shipped
--   canceled → canceled
--
-- Subscriptions record the plan the patient chose (cadence in weeks, units per
-- shipment, the Stripe prices the items were built on) and the next shipment
-- date (mirrors Stripe's current period end, moved by skip/move-next).
--
-- Orders gain cart_id: every order created by one in-app checkout shares the
-- checkout's idempotency id, so staff and receipts can see the cart as a whole
-- and a retried checkout never creates a second set of rows.
--
-- Everything is additive; no existing column or constraint changes.

create table if not exists public.billing_shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.billing_orders(id) on delete cascade,
  provider_id text not null references public.providers(provider_id),
  status text not null default 'processing'
    check (status in ('processing', 'shipped', 'delivered', 'canceled')),
  carrier text,
  tracking_number text,
  tracking_url text,
  -- Who last wrote the shipment: staff (HQ fulfillment screen) or a shipping provider.
  source text not null default 'staff' check (source in ('staff', 'provider')),
  -- The shipping provider's own id for this parcel, once one exists.
  external_id text,
  label_created_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  canceled_at timestamptz,
  canceled_reason text,
  -- Append-only provider events ([{ at, status, detail }]) for a future tracking timeline.
  events jsonb not null default '[]'::jsonb,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_shipments_provider_status_idx
  on public.billing_shipments (provider_id, status);
create index if not exists billing_shipments_external_idx
  on public.billing_shipments (external_id) where external_id is not null;

alter table public.billing_shipments enable row level security;

drop trigger if exists billing_touch_updated_at on public.billing_shipments;
create trigger billing_touch_updated_at before update on public.billing_shipments
  for each row execute function public.billing_touch_updated_at();

-- Backfill one shipment per existing order from the legacy fulfillment columns.
insert into public.billing_shipments (
  order_id, provider_id, status, carrier, tracking_number, shipped_at, canceled_at, canceled_reason, updated_by, created_at
)
select
  o.id, o.provider_id,
  case o.fulfillment_status when 'shipped' then 'shipped' when 'canceled' then 'canceled' else 'processing' end,
  o.carrier, o.tracking_number, o.shipped_at,
  case when o.fulfillment_status = 'canceled' then o.updated_at end,
  o.canceled_reason, o.shipped_by, o.created_at
from public.billing_orders o
on conflict (order_id) do nothing;

-- Every new order starts with a processing shipment, whichever path created it
-- (public link checkout, in-app checkout, renewal webhooks).
create or replace function public.billing_order_create_shipment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.billing_shipments (order_id, provider_id, status)
  values (new.id, new.provider_id, 'processing')
  on conflict (order_id) do nothing;
  return new;
end;
$$;

drop trigger if exists billing_order_create_shipment on public.billing_orders;
create trigger billing_order_create_shipment after insert on public.billing_orders
  for each row execute function public.billing_order_create_shipment();

alter table public.billing_subscriptions
  add column if not exists cadence_weeks integer not null default 4
    check (cadence_weeks in (2, 4, 6, 8, 10, 12)),
  add column if not exists quantity integer not null default 1 check (quantity between 1 and 10),
  add column if not exists next_shipment_at timestamptz,
  add column if not exists stripe_price_id text,
  add column if not exists stripe_shipping_price_id text;

update public.billing_subscriptions
  set next_shipment_at = current_period_end
  where next_shipment_at is null and current_period_end is not null;

alter table public.billing_orders
  add column if not exists cart_id uuid;

create index if not exists billing_orders_cart_idx
  on public.billing_orders (cart_id) where cart_id is not null;
