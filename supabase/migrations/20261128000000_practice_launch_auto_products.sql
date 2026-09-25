begin;
-- New offices no longer confirm product prices during first-time setup: the
-- suggested prices are saved for them and the products step counts as done.
-- One service-role RPC does it atomically and NEVER overwrites a price the
-- office already has in this payment mode (insert ... on conflict do nothing).
-- It is a no-op for offices outside first-time full setup and for offices that
-- already hold a product receipt for this payment identity.
create or replace function public.autoconfirm_practice_launch_products(
  p_provider_id text, p_actor_user_id uuid, p_products jsonb,
  p_stripe_mode text, p_platform_account_id text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  launch public.practice_launch%rowtype;
  settings public.billing_settings%rowtype;
  product public.billing_products%rowtype;
  choice jsonb;
  sell integer;
  minimum integer;
  share integer;
  discount integer;
  effective_price integer;
  enabled boolean;
  subscribed boolean;
begin
  if p_stripe_mode not in ('test','live') or p_stripe_mode is null
    or coalesce(p_platform_account_id,'') = '' or p_actor_user_id is null
    or jsonb_typeof(p_products) is distinct from 'array' then
    raise exception 'Invalid product setup request' using errcode='22023';
  end if;
  select * into launch from public.practice_launch where provider_id=p_provider_id for update;
  if not found then raise exception 'Practice setup not found' using errcode='22023'; end if;
  if not launch.required then
    return jsonb_build_object('applied',false,'version',launch.version);
  end if;
  if launch.products_confirmed and exists(select 1 from public.practice_launch_product_receipts r
      where r.provider_id=p_provider_id and r.stripe_mode=p_stripe_mode
        and r.platform_account_id=p_platform_account_id) then
    return jsonb_build_object('applied',false,'version',launch.version);
  end if;
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
    -- A suggestion that cannot cover processing costs is saved switched off
    -- rather than failing the whole office's setup.
    enabled := (choice->>'enabled')::boolean and sell >= minimum;
    subscribed := enabled and (choice->>'subscriptionEnabled')::boolean and effective_price >= minimum;
    insert into public.billing_office_prices(provider_id,product_id,sell_price_cents,
      subscription_enabled,enabled,updated_by,stripe_mode,stripe_platform_account_id)
    values(p_provider_id,product.id,sell,subscribed,enabled,p_actor_user_id,p_stripe_mode,p_platform_account_id)
    on conflict(provider_id,product_id,stripe_mode,stripe_platform_account_id) do nothing;
  end loop;
  insert into public.practice_launch_product_receipts values
    (p_provider_id,launch.version,p_stripe_mode,p_platform_account_id,p_products);
  update public.practice_launch set products_confirmed=true,version=version+1 where provider_id=p_provider_id
    returning * into launch;
  return jsonb_build_object('applied',true,'version',launch.version);
end $$;
revoke all on function public.autoconfirm_practice_launch_products(text,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.autoconfirm_practice_launch_products(text,uuid,jsonb,text,text) to service_role;
commit;
