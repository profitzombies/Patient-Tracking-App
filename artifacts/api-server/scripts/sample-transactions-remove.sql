-- Remove the sample sandbox transactions written by sample-transactions.sql
-- and sample-transactions-fill.sql.
--
-- Only rows carrying one of the seed tags are touched: the orders, their items,
-- shipments, ledger entries and refunds, plus the subscriptions those orders
-- belong to. Nothing that came from a real charge matches the tag.
--
-- Safe to run when the batch is absent; it reports that it found nothing.
do $$
declare
  v_tags     constant text[] := array['sample-2026-09', 'sample-2026-09-fill'];
  v_provider constant text := 'live-74913542d0cf4f5292642ceee81dcfc2';
  v_ids  uuid[];
  v_subs uuid[];
  n_orders int;
begin
  select array_agg(id), array_remove(array_agg(subscription_id), null)
    into v_ids, v_subs
    from public.billing_orders
    where metadata->>'sample_seed' = any(v_tags);
  n_orders := coalesce(array_length(v_ids, 1), 0);
  if n_orders = 0 then
    raise notice 'No sample transactions tagged % to remove.', v_tags;
    return;
  end if;

  -- Null-safe: a row missing its mode flag is treated as non-sandbox, not skipped.
  if exists (
    select 1 from public.billing_orders
      where id = any(v_ids)
        and (coalesce(livemode, true) or coalesce(stripe_mode, '') <> 'test'
             or provider_id is distinct from v_provider)
  ) then
    raise exception 'Tagged orders include rows outside the sandbox office; refusing to delete.';
  end if;

  alter table public.billing_orders disable trigger user;
  alter table public.billing_order_items disable trigger user;
  alter table public.billing_shipments disable trigger user;
  alter table public.billing_ledger disable trigger user;
  alter table public.billing_refunds disable trigger user;
  alter table public.billing_subscriptions disable trigger user;

  delete from public.billing_ledger where order_id = any(v_ids);
  delete from public.billing_refunds where order_id = any(v_ids);
  delete from public.billing_shipments where order_id = any(v_ids);
  delete from public.billing_order_items where order_id = any(v_ids);
  delete from public.billing_orders where id = any(v_ids);
  if coalesce(array_length(v_subs, 1), 0) > 0 then
    delete from public.billing_subscriptions
      where id = any(v_subs) and stripe_subscription_id like 'sub_sample_%';
  end if;

  alter table public.billing_orders enable trigger user;
  alter table public.billing_order_items enable trigger user;
  alter table public.billing_shipments enable trigger user;
  alter table public.billing_ledger enable trigger user;
  alter table public.billing_refunds enable trigger user;
  alter table public.billing_subscriptions enable trigger user;

  raise notice 'Removed % sample orders tagged %.', n_orders, v_tags;
end $$;
