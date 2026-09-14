-- Stripe objects are attached only after durable local rows exist. Existing
-- subscription rows are unaffected; new incomplete rows may briefly have no
-- remote identifiers while Stripe creation is in flight.
alter table public.billing_subscriptions
  alter column stripe_subscription_id drop not null,
  alter column stripe_customer_id drop not null;

alter table public.billing_subscriptions
  add column if not exists shipping_cost_cents integer;

update public.billing_subscriptions
set shipping_cost_cents = (
  select shipping_cost_cents from public.billing_settings where id = 1
)
where shipping_cost_cents is null;

alter table public.billing_subscriptions
  alter column shipping_cost_cents set default 1000,
  alter column shipping_cost_cents set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'billing_subscriptions_shipping_cost_nonnegative'
      and conrelid = 'public.billing_subscriptions'::regclass
  ) then
    alter table public.billing_subscriptions
      add constraint billing_subscriptions_shipping_cost_nonnegative
      check (shipping_cost_cents >= 0);
  end if;
end
$$;