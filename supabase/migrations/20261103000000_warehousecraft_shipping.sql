-- Live WarehouseCraft shipping rates + NovEx pick-and-pack fees at checkout.
--
-- Amount semantics (all cents):
--   billing_orders/billing_subscriptions.shipping_charge_cents  what the patient pays as "Shipping & handling"
--   .shipping_cost_cents                                        what THINNR pays the carrier (live quote) or the flat HQ cost (fallback)
--   .pick_pack_fee_cents / .packaging_cents                     NovEx handling THINNR incurs per shipment (always recovered via the platform fee)
--   .shipping_source                                            'live' (WarehouseCraft rated it) | 'fallback' (flat HQ charge)

-- Per-product fulfillment data (snapshotted onto order items at checkout).
alter table public.billing_products
  add column if not exists warehousecraft_sku text,
  add column if not exists shipping_weight_oz integer check (shipping_weight_oz is null or shipping_weight_oz > 0),
  add column if not exists package_length_in numeric(6,2) check (package_length_in is null or package_length_in > 0),
  add column if not exists package_width_in numeric(6,2) check (package_width_in is null or package_width_in > 0),
  add column if not exists package_height_in numeric(6,2) check (package_height_in is null or package_height_in > 0),
  add column if not exists oversized boolean not null default false;

alter table public.billing_order_items
  add column if not exists warehousecraft_sku_snapshot text,
  add column if not exists shipping_weight_oz_snapshot integer;

-- HQ shipping rules. The flat charge/cost columns stay as the fallback.
alter table public.billing_settings
  add column if not exists free_shipping_over_cents integer check (free_shipping_over_cents is null or free_shipping_over_cents >= 0),
  add column if not exists pick_pack_tier text not null default 'under_50'
    check (pick_pack_tier in ('under_50', 'from_51', 'from_100', 'from_250', 'from_500', 'from_1500')),
  add column if not exists pick_pack_schedule jsonb not null default jsonb_build_object(
    'order_fee_cents', jsonb_build_object('under_50', 495, 'from_51', 425, 'from_100', 395, 'from_250', 345, 'from_500', 295, 'from_1500', 175),
    'unit_cents', 25,
    'oversized_unit_cents', 75,
    'overweight_pick_cents', 200,
    'overweight_threshold_lb', 30,
    'packaging_cents', 0
  ),
  add column if not exists pick_pack_pass_through_default boolean not null default true,
  add column if not exists expedited_enabled boolean not null default true;

-- Per-office overrides (null = inherit the HQ default), same versioned pattern as the org policy overrides.
create table if not exists public.billing_office_settings (
  provider_id text primary key references public.providers(provider_id) on delete cascade,
  pick_pack_pass_through boolean,
  version integer not null default 1 check (version >= 1),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.billing_office_settings enable row level security;
revoke all on table public.billing_office_settings from anon, authenticated;
drop trigger if exists billing_office_settings_touch on public.billing_office_settings;
create trigger billing_office_settings_touch before update on public.billing_office_settings
  for each row execute function public.billing_touch_updated_at();

-- What was quoted and locked for each shipment.
alter table public.billing_orders
  add column if not exists shipping_method text not null default 'standard' check (shipping_method in ('standard', 'expedited')),
  add column if not exists shipping_source text not null default 'fallback' check (shipping_source in ('live', 'fallback')),
  add column if not exists carrier_service_name text,
  add column if not exists pick_pack_fee_cents integer not null default 0 check (pick_pack_fee_cents >= 0),
  add column if not exists packaging_cents integer not null default 0 check (packaging_cents >= 0),
  add column if not exists pick_pack_passed_through boolean not null default false,
  add column if not exists delivery_window_start date,
  add column if not exists delivery_window_end date;

alter table public.billing_subscriptions
  add column if not exists shipping_method text not null default 'standard' check (shipping_method in ('standard', 'expedited')),
  add column if not exists shipping_source text not null default 'fallback' check (shipping_source in ('live', 'fallback')),
  add column if not exists carrier_service_name text,
  add column if not exists pick_pack_fee_cents integer not null default 0 check (pick_pack_fee_cents >= 0),
  add column if not exists packaging_cents integer not null default 0 check (packaging_cents >= 0),
  add column if not exists pick_pack_passed_through boolean not null default false,
  add column if not exists delivery_window_start date,
  add column if not exists delivery_window_end date,
  add column if not exists shipping_requoted_at timestamptz;
