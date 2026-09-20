-- Unknown historical identities are deliberately NULL and quarantined: never infer
-- mode/account from the current credentials, a deployment, or a connected account.
begin;
create table public.billing_mode_state (
  deployment_id text primary key,
  mode text not null check (mode in ('test', 'live')),
  platform_account_id text not null,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);
create table public.billing_mode_audit (
  id uuid primary key default gen_random_uuid(),
  deployment_id text not null,
  previous_mode text not null,
  mode text not null,
  platform_account_id text not null,
  version integer not null,
  actor_user_id uuid not null,
  request_id text,
  created_at timestamptz not null default now()
);
alter table public.billing_mode_state enable row level security;
alter table public.billing_mode_audit enable row level security;
revoke all on public.billing_mode_state, public.billing_mode_audit from anon, authenticated;
grant all on public.billing_mode_state, public.billing_mode_audit to service_role;

create function public.switch_billing_mode(
  p_deployment_id text, p_mode text, p_platform_account_id text,
  p_expected_version integer, p_confirm_live boolean, p_actor_user_id uuid, p_request_id text
) returns public.billing_mode_state
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  old_row public.billing_mode_state;
  new_row public.billing_mode_state;
begin
  if p_mode not in ('test','live') or p_platform_account_id !~ '^acct_' or
     coalesce(length(trim(p_deployment_id)),0) = 0 or p_actor_user_id is null then
    raise exception 'Invalid billing mode request';
  end if;
  if p_mode = 'live' and p_confirm_live is distinct from true then
    raise exception 'Live mode confirmation required';
  end if;
  -- Serialize first activation too, when no state row exists yet.
  perform pg_advisory_xact_lock(hashtextextended('billing-mode:' || p_deployment_id, 0));
  select * into old_row from public.billing_mode_state where deployment_id = p_deployment_id for update;
  if coalesce(old_row.version, 0) <> p_expected_version then
    raise exception 'Billing mode changed' using errcode = '40001';
  end if;
  insert into public.billing_mode_state(deployment_id, mode, platform_account_id, version)
    values(p_deployment_id, p_mode, p_platform_account_id, p_expected_version + 1)
    on conflict(deployment_id) do update set mode = excluded.mode,
      platform_account_id = excluded.platform_account_id, version = excluded.version, updated_at = now()
    returning * into new_row;
  insert into public.billing_mode_audit(deployment_id, previous_mode, mode, platform_account_id, version, actor_user_id, request_id)
    values(p_deployment_id, coalesce(old_row.mode,'test'), p_mode, p_platform_account_id, new_row.version, p_actor_user_id, p_request_id);
  return new_row;
end $$;
revoke all on function public.switch_billing_mode(text,text,text,integer,boolean,uuid,text) from public, anon, authenticated;
grant execute on function public.switch_billing_mode(text,text,text,integer,boolean,uuid,text) to service_role;

do $$
declare t text; c record; columns_sql text;
begin
  foreach t in array array[
    'billing_connected_accounts','billing_account_events','billing_office_prices',
    'billing_payment_links','billing_payers','billing_orders','billing_order_items',
    'billing_subscriptions','billing_ledger','billing_refunds','billing_disputes',
    'billing_payouts','billing_webhook_endpoints','billing_webhook_events','billing_shipments',
    'billing_carts','billing_customer_emails','billing_prebuilt_carts',
    'billing_warehouse_submissions','billing_warehouse_sync_polls'
  ] loop
    execute format('alter table public.%I add column stripe_mode text check (stripe_mode in (''test'',''live'')), add column stripe_platform_account_id text', t);
    execute format('alter table public.%I add constraint %I check ((stripe_mode is null) = (stripe_platform_account_id is null))', t, t || '_identity_pair');
    execute format('create index on public.%I (stripe_mode, stripe_platform_account_id)', t);
    -- UUID row identities and unguessable bearer tokens remain globally unique.
    -- Natural keys must allow Test and Live and multiple platform accounts.
    for c in select conname, contype, conkey from pg_constraint
      where conrelid = format('public.%I', t)::regclass and contype in ('p','u')
    loop
      select string_agg(quote_ident(a.attname), ',' order by k.ord) into columns_sql
        from unnest(c.conkey) with ordinality k(attnum,ord)
        join pg_attribute a on a.attrelid = format('public.%I',t)::regclass and a.attnum = k.attnum;
      if columns_sql in ('id','token','order_number') then continue; end if;
      execute format('alter table public.%I drop constraint %I',t,c.conname);
      execute format('alter table public.%I add constraint %I unique (%s,stripe_mode,stripe_platform_account_id)',t,c.conname,columns_sql);
    end loop;
  end loop;
end $$;
-- Partial uniqueness rules are indexes rather than constraints.
drop index if exists public.billing_payers_provider_patient_key;
create unique index billing_payers_provider_patient_key on public.billing_payers(provider_id,patient_id,stripe_mode,stripe_platform_account_id) where patient_id is not null;
drop index if exists public.billing_orders_stripe_invoice_unique;
create unique index billing_orders_stripe_invoice_unique on public.billing_orders(stripe_invoice_id,stripe_mode,stripe_platform_account_id) where stripe_invoice_id is not null;
drop index if exists public.billing_ledger_kind_stripe_ref_unique;
create unique index billing_ledger_kind_stripe_ref_unique on public.billing_ledger(kind,stripe_ref,stripe_mode,stripe_platform_account_id) where stripe_ref is not null;
-- New writes cannot create more quarantined rows or reclassify historical data.
-- Validate transactional FK identity as well as the UUID FK itself.
create function public.guard_billing_identity() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare fk record; foreign_value text; foreign_identity jsonb; doc jsonb := to_jsonb(new);
begin
  if new.stripe_mode is null or new.stripe_platform_account_id is null then
    raise exception 'Billing identity is required';
  end if;
  if tg_op = 'UPDATE' and (
    new.stripe_mode is distinct from old.stripe_mode or
    new.stripe_platform_account_id is distinct from old.stripe_platform_account_id
  ) then raise exception 'Billing identity is immutable'; end if;
  for fk in
    select a.attname as local_column, b.attname as foreign_column, c.confrelid::regclass as foreign_table
    from pg_constraint c
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    join pg_attribute b on b.attrelid=c.confrelid and b.attnum=c.confkey[1]
    where c.conrelid=tg_relid and c.contype='f' and cardinality(c.conkey)=1
      and exists(select 1 from pg_attribute x where x.attrelid=c.confrelid and x.attname='stripe_mode' and not x.attisdropped)
  loop
    foreign_value := doc ->> fk.local_column;
    if foreign_value is null then continue; end if;
    execute format('select jsonb_build_object(''mode'',stripe_mode,''account'',stripe_platform_account_id) from %s where %I::text=$1', fk.foreign_table, fk.foreign_column)
      into foreign_identity using foreign_value;
    if foreign_identity is null or foreign_identity->>'mode' is distinct from new.stripe_mode or
      foreign_identity->>'account' is distinct from new.stripe_platform_account_id then
      raise exception 'Cross-identity billing reference is forbidden';
    end if;
  end loop;
  return new;
end $$;
do $$
declare t record;
begin
  for t in select table_name from information_schema.columns
    where table_schema='public' and column_name='stripe_mode' and table_name like 'billing_%'
  loop
    execute format('create trigger billing_identity_guard before insert or update on public.%I for each row execute function public.guard_billing_identity()',t.table_name);
  end loop;
end $$;
-- The order-created shipment inherits the same immutable identity.
create or replace function public.billing_order_create_shipment()
returns trigger language plpgsql set search_path = '' as $$
begin
  insert into public.billing_shipments(order_id, provider_id, status, stripe_mode, stripe_platform_account_id)
  values(new.id, new.provider_id, 'processing', new.stripe_mode, new.stripe_platform_account_id)
  on conflict(order_id, stripe_mode, stripe_platform_account_id) do nothing;
  return new;
end $$;

-- Remove the old unscoped overload: callers must explicitly supply identity.
drop function if exists public.billing_office_patient_spend(text);
create function public.billing_office_patient_spend(
  p_provider_id text, p_stripe_mode text, p_platform_account_id text
) returns table(patient_id uuid, paid_cents bigint, refunded_cents bigint, last_paid_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service role required'; end if;
  if p_stripe_mode not in ('test','live') or p_stripe_mode is null or p_platform_account_id is null then
    raise exception 'Billing identity required';
  end if;
  return query
  with paid as (
    select o.id,o.patient_id,o.total_cents,coalesce(o.paid_at,o.created_at) paid_moment
    from billing_orders o where o.provider_id=p_provider_id
      and o.stripe_mode=p_stripe_mode and o.stripe_platform_account_id=p_platform_account_id
      and o.patient_id is not null and o.status in ('paid','partially_refunded','refunded')
  ), refunds as (
    select p.patient_id,sum(r.amount_cents)::bigint refunded_cents
    from billing_refunds r join paid p on p.id=r.order_id
    where r.status='succeeded' and r.stripe_mode=p_stripe_mode and r.stripe_platform_account_id=p_platform_account_id
    group by p.patient_id
  )
  select p.patient_id,sum(p.total_cents)::bigint,coalesce(max(r.refunded_cents),0)::bigint,max(p.paid_moment)
  from paid p left join refunds r on r.patient_id=p.patient_id group by p.patient_id;
end $$;
revoke all on function public.billing_office_patient_spend(text,text,text) from public,anon,authenticated;
grant execute on function public.billing_office_patient_spend(text,text,text) to service_role;
commit;