-- Adopt pre-isolation billing rows into the Test identity.
--
-- 20261112000000_billing_mode_isolation.sql added (stripe_mode,
-- stripe_platform_account_id) to every Stripe-derived table and left the rows
-- that already existed NULL. Every scoped read filters on that identity, so the
-- history became invisible: signed-in HQ saw an empty Transactions list even
-- though nothing had been deleted. This adopts that unlabelled history into the
-- Test identity, and is deliberately conservative about when it is allowed to.
--
-- The platform account id is derived from rows already stamped in this
-- database, never embedded here: migrations are committed source and that id
-- comes from a secret.
--
-- Refuses to act unless every precondition holds, because a wrong guess would
-- relabel real money:
--   * exactly one Test platform account is present,
--   * the database holds no Live-scope billing rows at all (tables without a
--     livemode column offer no other proof that their history is test data),
--   * only known identity/timestamp triggers guard the tables being touched.
-- After adoption it proves that every scoped row still references a parent in
-- its own identity, and aborts the whole migration otherwise.
do $$
declare
  t text;
  account_id text;
  account_count int;
  live_rows bigint;
  has_livemode boolean;
  predicate text;
  row_id record;
  extra text;
  fk record;
  offenders bigint;
  tables constant text[] := array[
    'billing_connected_accounts','billing_account_events','billing_office_prices',
    'billing_payment_links','billing_payers','billing_orders','billing_order_items',
    'billing_subscriptions','billing_ledger','billing_refunds','billing_disputes',
    'billing_payouts','billing_webhook_endpoints','billing_webhook_events','billing_shipments',
    'billing_carts','billing_customer_emails','billing_prebuilt_carts',
    'billing_warehouse_submissions','billing_warehouse_sync_polls'
  ];
  -- Guards that exist precisely to keep application writes from moving an
  -- identity, plus the updated_at touch we do not want to fire for a relabel.
  bypassable constant text[] := array[
    'billing_identity_guard','billing_touch_updated_at','protect_connect_identity',
    'protect_connect_financial_write','patient_identity_write_guard'
  ];
begin
  select count(distinct stripe_platform_account_id) into account_count
    from public.billing_connected_accounts where stripe_mode = 'test';
  select count(distinct stripe_platform_account_id) into account_count
    from (
      select stripe_platform_account_id from public.billing_connected_accounts where stripe_mode = 'test'
      union
      select stripe_platform_account_id from public.billing_orders where stripe_mode = 'test'
    ) accounts;
  if account_count <> 1 then
    raise notice 'Legacy billing adoption skipped: % Test platform accounts present.', account_count;
    return;
  end if;
  select distinct stripe_platform_account_id into account_id
    from public.billing_orders where stripe_mode = 'test'
    union
    select distinct stripe_platform_account_id from public.billing_connected_accounts where stripe_mode = 'test';

  foreach t in array tables loop
    execute format('select count(*) from public.%I where stripe_mode = ''live''', t) into live_rows;
    if live_rows > 0 then
      raise notice 'Legacy billing adoption skipped: % holds Live rows, so unlabelled history cannot be assumed to be test data.', t;
      return;
    end if;
  end loop;

  foreach t in array tables loop
    -- An unknown trigger firing on UPDATE could do real work during a relabel.
    select string_agg(tg.tgname, ', ') into extra
      from pg_trigger tg
      where tg.tgrelid = format('public.%I', t)::regclass
        and not tg.tgisinternal and (tg.tgtype & 16) <> 0
        and not (tg.tgname = any(bypassable));
    if extra is not null then
      raise exception 'Unexpected update trigger(s) on %: %', t, extra;
    end if;

    select exists(
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'livemode'
    ) into has_livemode;
    predicate := case when has_livemode then 'stripe_mode is null and livemode is not true'
                      else 'stripe_mode is null' end;

    execute format('alter table public.%I disable trigger user', t);
    -- Row at a time: a natural key extended with the identity columns can already
    -- be held by a current Test row, which makes the legacy row a superseded
    -- duplicate. Those stay quarantined rather than overwriting live data; the
    -- referential proof below catches any case where that would strand a child.
    for row_id in execute format('select ctid from public.%I where %s', t, predicate) loop
      begin
        execute format(
          'update public.%I set stripe_mode = ''test'', stripe_platform_account_id = $1 where ctid = $2', t
        ) using account_id, row_id.ctid;
      exception when unique_violation then
        raise notice 'Skipped superseded % row %', t, row_id.ctid;
      end;
    end loop;
    execute format('alter table public.%I enable trigger user', t);
  end loop;

  -- Adopted financial history still counts as history for Connect safety.
  update public.billing_connect_guards g set ever_used = true
    where g.stripe_mode = 'test' and g.platform_account_id = account_id and not g.ever_used
      and exists (
        select 1 from public.billing_orders o
        where o.provider_id = g.provider_id and o.stripe_mode = g.stripe_mode
          and o.stripe_platform_account_id = g.platform_account_id
      );

  for fk in
    select c.conrelid::regclass as child, a.attname as child_column,
           c.confrelid::regclass as parent, b.attname as parent_column
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute b on b.attrelid = c.confrelid and b.attnum = c.confkey[1]
    where c.contype = 'f' and cardinality(c.conkey) = 1
      and exists(select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'stripe_mode' and not x.attisdropped)
      and exists(select 1 from pg_attribute y where y.attrelid = c.confrelid and y.attname = 'stripe_mode' and not y.attisdropped)
  loop
    execute format(
      'select count(*) from %s ch where ch.stripe_mode is not null and ch.%I is not null and not exists ('
      || 'select 1 from %s pa where pa.%I::text = ch.%I::text and pa.stripe_mode = ch.stripe_mode'
      || ' and pa.stripe_platform_account_id = ch.stripe_platform_account_id)',
      fk.child, fk.child_column, fk.parent, fk.parent_column, fk.child_column
    ) into offenders;
    if offenders > 0 then
      raise exception 'Legacy adoption would leave % cross-identity reference(s) from %.% to %',
        offenders, fk.child, fk.child_column, fk.parent;
    end if;
  end loop;
end $$;
