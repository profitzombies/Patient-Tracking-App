begin;
alter table public.billing_office_prices add column enabled boolean not null default true;

-- Replay receipt is per-office and mode. Only the service-role RPC can write.
create table public.practice_launch_product_receipts (
  provider_id text not null references public.providers(provider_id),
  expected_version integer not null,
  stripe_mode text not null,
  platform_account_id text not null,
  products jsonb not null,
  primary key(provider_id, expected_version)
);
alter table public.practice_launch_product_receipts enable row level security;
revoke all on public.practice_launch_product_receipts from anon, authenticated;

create or replace function public.save_practice_launch_products(
  p_provider_id text, p_actor_user_id uuid, p_expected_version integer,
  p_products jsonb, p_stripe_mode text, p_platform_account_id text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  launch public.practice_launch%rowtype;
  receipt public.practice_launch_product_receipts%rowtype;
  settings public.billing_settings%rowtype;
  product public.billing_products%rowtype;
  choice jsonb;
  sell integer;
  minimum integer;
  share integer;
  discount integer;
  effective_price integer;
begin
  if p_stripe_mode not in ('test','live') or p_stripe_mode is null
    or coalesce(p_platform_account_id,'') = '' or p_actor_user_id is null
    or p_expected_version < 0 or p_expected_version is null
    or jsonb_typeof(p_products) is distinct from 'array' then
    raise exception 'Invalid product setup request' using errcode='22023';
  end if;
  select * into launch from public.practice_launch where provider_id=p_provider_id for update;
  if not found then raise exception 'Practice setup not found' using errcode='22023'; end if;
  select * into receipt from public.practice_launch_product_receipts
    where provider_id=p_provider_id and expected_version=p_expected_version;
  if found then
    if receipt.products=p_products and receipt.stripe_mode=p_stripe_mode
      and receipt.platform_account_id=p_platform_account_id then
      return jsonb_build_object('version',launch.version);
    end if;
    raise exception 'Product setup changed. Refresh and try again.' using errcode='40001';
  end if;
  if launch.version <> p_expected_version then
    raise exception 'Practice setup changed. Refresh and try again.' using errcode='40001';
  end if;
  -- Share locks prevent catalog/settings edits between validation and writes.
  perform 1 from public.billing_products where active for share;
  select * into settings from public.billing_settings where id=1 for share;
  if not found or settings.card_fee_bps >= 10000 then
    raise exception 'Billing settings unavailable' using errcode='22023';
  end if;
  if jsonb_array_length(p_products) <> (select count(*) from public.billing_products where active)
    or (select count(distinct x->>'productId') from jsonb_array_elements(p_products) x)
      <> jsonb_array_length(p_products) then
    raise exception 'Catalog changed. Refresh the product choices.' using errcode='40001';
  end if;
  for choice in select value from jsonb_array_elements(p_products) loop
    select * into product from public.billing_products where id::text=choice->>'productId' and active;
    if not found then raise exception 'Product is no longer available' using errcode='40001'; end if;
    if jsonb_typeof(choice->'enabled') is distinct from 'boolean'
      or jsonb_typeof(choice->'subscriptionEnabled') is distinct from 'boolean'
      or jsonb_typeof(choice->'sellPriceCents') is distinct from 'number'
      or (choice->>'sellPriceCents') !~ '^[0-9]+$' then
      raise exception 'Check the product choices and prices' using errcode='22023';
    end if;
    sell := (choice->>'sellPriceCents')::integer;
    share := floor(product.floor_price_cents::numeric * 60 / 100);
    minimum := greatest(0,floor((share + settings.card_fee_fixed_cents +
      settings.shipping_charge_cents::numeric * settings.card_fee_bps / 10000) /
      (1-settings.card_fee_bps::numeric/10000)));
    while minimum - share - round((minimum+settings.shipping_charge_cents)::numeric *
      settings.card_fee_bps/10000) - settings.card_fee_fixed_cents < 0 loop minimum := minimum+1; end loop;
    while minimum > 0 and minimum-1 - share - round((minimum-1+settings.shipping_charge_cents)::numeric *
      settings.card_fee_bps/10000) - settings.card_fee_fixed_cents >= 0 loop minimum := minimum-1; end loop;
    discount := case when settings.subscribe_save_enabled then settings.subscribe_save_percent else 0 end;
    effective_price := sell - round(sell::numeric * discount / 100);
    if (choice->>'enabled')::boolean and (sell < minimum or
      ((choice->>'subscriptionEnabled')::boolean and effective_price < minimum)) then
      raise exception 'Price must cover processing costs, including the subscription discount.' using errcode='22023';
    end if;
    insert into public.billing_office_prices(provider_id,product_id,sell_price_cents,
      subscription_enabled,enabled,updated_by,stripe_mode,stripe_platform_account_id)
    values(p_provider_id,product.id,sell,(choice->>'enabled')::boolean and (choice->>'subscriptionEnabled')::boolean,
      (choice->>'enabled')::boolean,p_actor_user_id,p_stripe_mode,p_platform_account_id)
    on conflict(provider_id,product_id,stripe_mode,stripe_platform_account_id) do update set
      sell_price_cents=excluded.sell_price_cents, subscription_enabled=excluded.subscription_enabled,
      enabled=excluded.enabled, updated_by=excluded.updated_by, updated_at=now();
  end loop;
  update public.practice_launch set products_confirmed=true,version=version+1 where provider_id=p_provider_id
    returning * into launch;
  insert into public.practice_launch_product_receipts values
    (p_provider_id,p_expected_version,p_stripe_mode,p_platform_account_id,p_products);
  return jsonb_build_object('version',launch.version);
end $$;
revoke all on function public.save_practice_launch_products(text,uuid,integer,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.save_practice_launch_products(text,uuid,integer,jsonb,text,text) to service_role;
commit;