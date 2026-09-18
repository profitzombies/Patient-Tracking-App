-- Request speed, slow queries, and data growth for HQ → System health.
--
-- Three read paths feed the page:
--   * api_request_metrics: one row per (minute, server instance, route family)
--     flushed from each API process's in-memory latency histogram. Rows are
--     per instance on purpose (autoscale runs several copies); the read RPC
--     sums them. Minute rows are kept for a week — the page only needs the
--     last hour and the last day.
--   * pg_stat_statements (Supabase preloads it; the create below is the
--     idempotent "make sure it is on" step) read through a service-role RPC
--     that returns the heaviest statements by total and by mean time.
--   * system_size_snapshots: one row per (day, kind, name) written by the
--     daily data-growth job — every application table, the database total,
--     and object-storage byte totals per prefix. Kept 400 days so a year of
--     growth stays comparable.
--
-- The staff alert outbox gains a second kind, system_threshold, addressed to
-- HQ members (no office), so a crossed threshold rides the same leased send
-- lifecycle and delivery audit as the daily patient-attention digest.

create extension if not exists pg_stat_statements with schema extensions;

-- ── Request latency minute rows ─────────────────────────────────────────────
create table if not exists public.api_request_metrics (
  bucket_start timestamptz not null,
  instance text not null check (char_length(instance) between 1 and 160),
  route_family text not null check (char_length(route_family) between 1 and 120),
  requests integer not null check (requests >= 0),
  errors integer not null check (errors >= 0),
  db_requests integer not null default 0 check (db_requests >= 0),
  ai_requests integer not null default 0 check (ai_requests >= 0),
  total_ms double precision not null check (total_ms >= 0),
  max_ms double precision not null check (max_ms >= 0),
  -- Cumulative-free counts per latency bucket; boundaries live in the API
  -- (lib/request-metrics.ts LATENCY_BUCKETS_MS) and never change in place.
  buckets integer[] not null,
  created_at timestamptz not null default now(),
  primary key (bucket_start, instance, route_family)
);
comment on table public.api_request_metrics is
  'Per-minute, per-server-instance API latency histograms by route family. Service-role only; HQ reads the summed view through hq_request_latency.';
create index if not exists api_request_metrics_bucket_idx on public.api_request_metrics (bucket_start);
alter table public.api_request_metrics enable row level security;
revoke all on public.api_request_metrics from public, anon, authenticated;
grant all on public.api_request_metrics to service_role;

-- Sums the instance rows for one window. Histogram buckets are summed
-- position by position so the API can estimate p50/p95 from the merged shape.
create or replace function public.hq_request_latency(p_since timestamptz, p_until timestamptz default null)
returns table (
  route_family text,
  requests bigint,
  errors bigint,
  db_requests bigint,
  ai_requests bigint,
  total_ms double precision,
  max_ms double precision,
  buckets bigint[]
) language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  return query
    with rows_in_window as (
      select m.*
      from public.api_request_metrics m
      where m.bucket_start >= p_since
        and m.bucket_start < coalesce(p_until, now() + interval '1 minute')
    ),
    exploded as (
      select r.route_family, b.ordinality as position, sum(b.count)::bigint as count
      from rows_in_window r
      cross join lateral unnest(r.buckets) with ordinality as b(count, ordinality)
      group by r.route_family, b.ordinality
    ),
    merged as (
      select e.route_family, array_agg(e.count order by e.position) as buckets
      from exploded e
      group by e.route_family
    )
    select
      r.route_family,
      sum(r.requests)::bigint,
      sum(r.errors)::bigint,
      sum(r.db_requests)::bigint,
      sum(r.ai_requests)::bigint,
      sum(r.total_ms)::double precision,
      max(r.max_ms)::double precision,
      m.buckets
    from rows_in_window r
    join merged m on m.route_family = r.route_family
    group by r.route_family, m.buckets
    order by sum(r.requests) desc;
end;
$$;
revoke all on function public.hq_request_latency(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.hq_request_latency(timestamptz, timestamptz) to service_role;
comment on function public.hq_request_latency(timestamptz, timestamptz) is
  'Sums api_request_metrics rows across server instances per route family for a window, including position-wise summed latency buckets. Service-role only.';

-- ── Slow statements ─────────────────────────────────────────────────────────
-- Runs as the function owner (postgres, a pg_read_all_stats member) so the
-- service role can read every role's statements without holding that grant
-- itself. Query text is capped: it is normalised by pg_stat_statements
-- (constants replaced by $1, $2...), so no row values leave the database.
create or replace function public.hq_slow_statements(p_limit integer default 15, p_order text default 'total')
returns table (
  query_id text,
  role_name text,
  query text,
  calls bigint,
  total_ms double precision,
  mean_ms double precision,
  max_ms double precision,
  rows_returned bigint,
  shared_blks_read bigint,
  stats_reset timestamptz
) language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 15), 50));
  v_order text := case when p_order = 'mean' then 'mean' else 'total' end;
  v_reset timestamptz := (select i.stats_reset from extensions.pg_stat_statements_info i limit 1);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  return query
    select
      s.queryid::text,
      r.rolname::text,
      left(s.query, 600),
      s.calls::bigint,
      s.total_exec_time::double precision,
      s.mean_exec_time::double precision,
      s.max_exec_time::double precision,
      s.rows::bigint,
      s.shared_blks_read::bigint,
      v_reset
    from extensions.pg_stat_statements s
    left join pg_catalog.pg_roles r on r.oid = s.userid
    where s.dbid = (select d.oid from pg_catalog.pg_database d where d.datname = current_database())
      and s.calls > 0
      and s.query not ilike '%pg_stat_statements%'
    order by
      case when v_order = 'mean' then s.mean_exec_time else s.total_exec_time end desc,
      s.calls desc
    limit v_limit;
end;
$$;
revoke all on function public.hq_slow_statements(integer, text) from public, anon, authenticated;
grant execute on function public.hq_slow_statements(integer, text) to service_role;
comment on function public.hq_slow_statements(integer, text) is
  'Top pg_stat_statements rows for this database by total (default) or mean execution time, with the last statistics reset. Service-role only; normalised query text, no row values.';

-- ── Relation sizes (read by the daily growth job) ───────────────────────────
create or replace function public.hq_relation_sizes()
returns table (
  schema_name text,
  table_name text,
  total_bytes bigint,
  table_bytes bigint,
  index_bytes bigint,
  toast_bytes bigint,
  row_estimate bigint,
  database_bytes bigint
) language plpgsql security definer set search_path = '' as $$
declare
  v_database bigint := pg_catalog.pg_database_size(current_database());
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  return query
    select
      n.nspname::text,
      c.relname::text,
      pg_catalog.pg_total_relation_size(c.oid)::bigint,
      pg_catalog.pg_table_size(c.oid)::bigint,
      pg_catalog.pg_indexes_size(c.oid)::bigint,
      coalesce(pg_catalog.pg_total_relation_size(c.reltoastrelid), 0)::bigint,
      greatest(c.reltuples, 0)::bigint,
      v_database
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname in ('public', 'private', 'auth', 'storage')
    order by pg_catalog.pg_total_relation_size(c.oid) desc;
end;
$$;
revoke all on function public.hq_relation_sizes() from public, anon, authenticated;
grant execute on function public.hq_relation_sizes() to service_role;
comment on function public.hq_relation_sizes() is
  'Every application table with its total, heap, index, and toast bytes plus the planner row estimate and the whole-database size. Service-role only; sizes and counts, no row values.';

-- ── Daily size snapshots ────────────────────────────────────────────────────
create table if not exists public.system_size_snapshots (
  snapshot_date date not null,
  kind text not null check (kind in ('database', 'table', 'storage', 'storage_total')),
  name text not null check (char_length(name) between 1 and 200),
  total_bytes bigint not null check (total_bytes >= 0),
  table_bytes bigint check (table_bytes is null or table_bytes >= 0),
  index_bytes bigint check (index_bytes is null or index_bytes >= 0),
  toast_bytes bigint check (toast_bytes is null or toast_bytes >= 0),
  row_estimate bigint check (row_estimate is null or row_estimate >= 0),
  object_count bigint check (object_count is null or object_count >= 0),
  captured_at timestamptz not null default now(),
  primary key (snapshot_date, kind, name)
);
comment on table public.system_size_snapshots is
  'Daily table, database, and object-storage size snapshots written by the data-growth job; 400 days kept. Service-role only.';
create index if not exists system_size_snapshots_kind_date_idx on public.system_size_snapshots (kind, snapshot_date desc);
alter table public.system_size_snapshots enable row level security;
revoke all on public.system_size_snapshots from public, anon, authenticated;
grant all on public.system_size_snapshots to service_role;

-- ── HQ system-threshold alerts on the staff outbox ──────────────────────────
alter table public.staff_notifications alter column provider_id drop not null;
alter table public.staff_notifications drop constraint if exists staff_notifications_kind_check;
alter table public.staff_notifications
  add constraint staff_notifications_kind_check check (kind in ('staff_attention_digest', 'system_threshold'));
alter table public.staff_notifications drop constraint if exists staff_notifications_scope_check;
alter table public.staff_notifications
  add constraint staff_notifications_scope_check
  check ((kind = 'system_threshold' and provider_id is null) or (kind <> 'system_threshold' and provider_id is not null));
comment on column public.staff_notifications.provider_id is
  'Office the alert belongs to; null only for kind system_threshold, which is addressed to HQ members.';
