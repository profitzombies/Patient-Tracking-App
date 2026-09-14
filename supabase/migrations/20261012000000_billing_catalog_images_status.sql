-- Product catalog overhaul: descriptions, a four-state lifecycle
-- (draft / active / retired / archived), product images (up to five per
-- product with one default), and a richer catalog audit trail that also
-- records office price changes.
--
-- `active` stays as the boolean the checkout and pricing paths read; the
-- API keeps it in lockstep with `status` (active <=> status = 'active').

alter table public.billing_products
  add column if not exists description text not null default '',
  add column if not exists status text not null default 'active',
  add column if not exists archived_at timestamptz;

alter table public.billing_products
  drop constraint if exists billing_products_status_check;
alter table public.billing_products
  add constraint billing_products_status_check
  check (status in ('draft', 'active', 'retired', 'archived'));

-- Backfill: retired rows carry retired_at; anything else that is inactive was
-- a paused product, which the new model calls a draft.
update public.billing_products
   set status = case
     when active then 'active'
     when retired_at is not null then 'retired'
     else 'draft'
   end
 where status = 'active' and (not active);

-- Only after the backfill: the lockstep check would otherwise reject any
-- pre-overhaul inactive row that still carries the 'active' default.
alter table public.billing_products
  drop constraint if exists billing_products_status_active_check;
alter table public.billing_products
  add constraint billing_products_status_active_check
  check (active = (status = 'active'));

create table if not exists public.billing_product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.billing_products(id) on delete cascade,
  object_path text not null unique,
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  sort_order integer not null default 0,
  is_default boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_product_images_product_idx
  on public.billing_product_images (product_id, sort_order);

-- At most one default image per product.
create unique index if not exists billing_product_images_one_default_idx
  on public.billing_product_images (product_id)
  where is_default;

drop trigger if exists billing_touch_updated_at on public.billing_product_images;
create trigger billing_touch_updated_at before update on public.billing_product_images
  for each row execute function public.billing_touch_updated_at();

alter table public.billing_product_images enable row level security;
revoke all on table public.billing_product_images from anon, authenticated;

-- Catalog audit: new kinds, and the office whose price changed.
alter table public.billing_catalog_changes
  add column if not exists provider_id text;

alter table public.billing_catalog_changes
  drop constraint if exists billing_catalog_changes_kind_check;
alter table public.billing_catalog_changes
  add constraint billing_catalog_changes_kind_check
  check (kind in (
    'product_created', 'product_updated', 'product_retired',
    'product_reactivated', 'product_published', 'product_archived',
    'product_unarchived', 'product_image_added', 'product_image_removed',
    'product_default_image', 'products_reordered', 'office_price_updated',
    'settings_updated'
  ));

create index if not exists billing_catalog_changes_created_idx
  on public.billing_catalog_changes (created_at desc);
