alter table public.billing_subscriptions
  add column if not exists paused_at timestamptz,
  add column if not exists pending_product_id uuid references public.billing_products(id),
  add column if not exists pending_unit_price_cents integer,
  add column if not exists pending_application_fee_cents integer,
  add column if not exists pending_effective_at timestamptz,
  add column if not exists pending_shipping_charge_cents integer;

alter table public.billing_subscriptions
  add constraint billing_subscriptions_pending_unit_price_nonnegative
    check (pending_unit_price_cents is null or pending_unit_price_cents >= 0),
  add constraint billing_subscriptions_pending_application_fee_nonnegative
    check (pending_application_fee_cents is null or pending_application_fee_cents >= 0),
  add constraint billing_subscriptions_pending_shipping_charge_nonnegative
    check (pending_shipping_charge_cents is null or pending_shipping_charge_cents >= 0),
  add constraint billing_subscriptions_pending_change_complete
    check (
      (pending_product_id is null and pending_unit_price_cents is null
        and pending_application_fee_cents is null and pending_effective_at is null
        and pending_shipping_charge_cents is null)
      or
      (pending_product_id is not null and pending_unit_price_cents is not null
        and pending_application_fee_cents is not null
        and pending_shipping_charge_cents is not null)
    );