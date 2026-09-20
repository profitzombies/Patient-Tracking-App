-- Keep warehouse submission ownership aligned with the canonical provider key.
-- UUID values convert losslessly to text; billing identity is copied from the
-- paid order and is never inferred or rewritten on an existing submission.
begin;

do $$
begin
  if (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'billing_orders'
      and column_name = 'provider_id'
  ) <> 'text' then
    raise exception 'billing_orders.provider_id must be text';
  end if;
end;
$$;

alter table public.billing_warehouse_submissions
  alter column provider_id type text using provider_id::text;

create or replace function public.billing_order_queue_warehouse()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
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

commit;