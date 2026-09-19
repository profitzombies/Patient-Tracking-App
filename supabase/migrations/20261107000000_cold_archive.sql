-- Nightly cold archive of raw events and business rows to object storage.
--
-- Off by default behind an HQ organization setting. When on, the
-- cold-archive system job copies each closed UTC day's rows, table by table,
-- into gzip NDJSON files under a dedicated storage prefix and records the day
-- here once every file and the daily manifest landed. Nothing here deletes
-- live rows; the archive is an insurance policy that makes trimming safe to
-- decide later.
--
--   hq_organization_settings.cold_archive_enabled   the HQ toggle
--   system_cold_archive_days                         one row per archived day
--                                                    (the high-water mark)
--   cold_archive_rows(table, day, after_id, limit)   keyset page of one
--                                                    table's rows for a day,
--                                                    rows as-is (row_to_json)
--   cold_archive_earliest_day()                      first day with any data
--   cold_archive_status(today)                       backlog / last day /
--                                                    bytes tallies
--
-- The table allowlist and each table's "day" column are fixed inside
-- cold_archive_rows: a caller can never point it at a table that was not
-- signed off for the archive (clinical tables are covered by exports and
-- record sealing, not by this job).

alter table public.hq_organization_settings
  add column if not exists cold_archive_enabled boolean not null default false;

create table if not exists public.system_cold_archive_days (
  archive_day date primary key,
  archived_at timestamptz not null default now(),
  manifest_path text not null,
  row_count bigint not null default 0 check (row_count >= 0),
  bytes_written bigint not null default 0 check (bytes_written >= 0),
  manifest jsonb not null default '{}'::jsonb
);

alter table public.system_cold_archive_days enable row level security;
revoke all on table public.system_cold_archive_days from public, anon, authenticated;
grant select, insert, update on table public.system_cold_archive_days to service_role;

-- ── Row pages ───────────────────────────────────────────────────────────────
-- Rows are returned as JSON exactly as stored (row_to_json), ordered by id so
-- pages are stable, with the id echoed as text for keyset continuation. The
-- day is a closed UTC day: [day 00:00Z, day+1 00:00Z).

create or replace function public.cold_archive_rows(
  p_table text,
  p_day date,
  p_after_id text,
  p_limit integer
)
returns table (row_id text, row_json jsonb)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_day_column text;
  v_id_type text;
  v_from timestamptz := (p_day::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_day + 1)::timestamp at time zone 'UTC');
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  v_sql text;
begin
  if p_table is null or p_day is null then
    raise exception 'table and day are required';
  end if;
  case p_table
    when 'patient_app_events' then v_day_column := 'occurred_at'; v_id_type := 'bigint';
    when 'admin_audit_events' then v_day_column := 'occurred_at'; v_id_type := 'bigint';
    when 'billing_orders' then v_day_column := 'created_at'; v_id_type := 'uuid';
    when 'billing_order_items' then v_day_column := 'created_at'; v_id_type := 'uuid';
    when 'billing_shipments' then v_day_column := 'created_at'; v_id_type := 'uuid';
    when 'billing_ledger' then v_day_column := 'occurred_at'; v_id_type := 'uuid';
    when 'billing_refunds' then v_day_column := 'created_at'; v_id_type := 'uuid';
    when 'billing_subscriptions' then v_day_column := 'updated_at'; v_id_type := 'uuid';
    else raise exception 'table % is not archived', p_table;
  end case;
  v_sql := format(
    'select t.id::text, to_jsonb(t) from public.%I t where t.%I >= $1 and t.%I < $2 and ($3 is null or t.id > $3::%s) order by t.id limit $4',
    p_table, v_day_column, v_day_column, v_id_type
  );
  return query execute v_sql using v_from, v_to, p_after_id, v_limit;
end;
$$;
revoke all on function public.cold_archive_rows(text, date, text, integer) from public, anon, authenticated;
grant execute on function public.cold_archive_rows(text, date, text, integer) to service_role;

-- ── Earliest day with data ──────────────────────────────────────────────────
-- The backlog starts at the earliest row across every archived table (UTC
-- day); null when there is no data at all.

create or replace function public.cold_archive_earliest_day()
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select min(d)::date from (
    select min(occurred_at at time zone 'UTC') as d from public.patient_app_events
    union all select min(occurred_at at time zone 'UTC') from public.admin_audit_events
    union all select min(created_at at time zone 'UTC') from public.billing_orders
    union all select min(created_at at time zone 'UTC') from public.billing_order_items
    union all select min(created_at at time zone 'UTC') from public.billing_shipments
    union all select min(occurred_at at time zone 'UTC') from public.billing_ledger
    union all select min(created_at at time zone 'UTC') from public.billing_refunds
    union all select min(updated_at at time zone 'UTC') from public.billing_subscriptions
  ) firsts
$$;
revoke all on function public.cold_archive_earliest_day() from public, anon, authenticated;
grant execute on function public.cold_archive_earliest_day() to service_role;

-- ── Status ──────────────────────────────────────────────────────────────────
-- Pending = closed days (before p_today, UTC) from the earliest data day that
-- have no archive row yet. Returned in one row for the settings page, System
-- health, and the threshold evaluator.

create or replace function public.cold_archive_status(p_today date)
returns table (
  earliest_day date,
  last_archived_day date,
  last_archived_at timestamptz,
  days_archived bigint,
  days_pending bigint,
  rows_archived bigint,
  bytes_written bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with bounds as (
    select public.cold_archive_earliest_day() as earliest_day
  ),
  marks as (
    select max(d.archive_day) as last_day,
           max(d.archived_at) as last_at,
           count(*)::bigint as archived,
           coalesce(sum(d.row_count), 0)::bigint as rows_archived,
           coalesce(sum(d.bytes_written), 0)::bigint as bytes_written
      from public.system_cold_archive_days d
  ),
  pending as (
    select count(*)::bigint as n
      from bounds b
      cross join lateral generate_series(b.earliest_day, p_today - 1, interval '1 day') as g(day)
     where b.earliest_day is not null
       and not exists (select 1 from public.system_cold_archive_days x where x.archive_day = g.day::date)
  )
  select b.earliest_day, m.last_day, m.last_at, m.archived, p.n, m.rows_archived, m.bytes_written
    from bounds b, marks m, pending p
$$;
revoke all on function public.cold_archive_status(date) from public, anon, authenticated;
grant execute on function public.cold_archive_status(date) to service_role;

notify pgrst, 'reload schema';
