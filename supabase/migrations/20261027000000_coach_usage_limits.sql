-- Coach usage limits that hold across API server copies and restarts.
--
-- The coach endpoints (chat turns, photo reads, recipe images) spend paid
-- model credits, and their concurrency + daily caps used to live in each
-- server process's memory: N autoscaled copies meant N× the caps, and every
-- restart reset the day's count to zero. This migration moves the counters
-- into the database behind ONE reservation RPC, serialized per kind by an
-- advisory transaction lock (the same pattern as enqueue_outreach_capped):
--
--   coach_usage_leases  one row per in-flight request (the concurrency
--                       counter). Rows carry a lease deadline so a crashed
--                       server's slots free themselves; the reserve call
--                       prunes expired leases of its kind under the lock.
--   coach_usage_daily   one counter row per (kind, scope, day). The scope is
--                       the caller's key — 'account:<patient id>' for a
--                       signed-in patient, 'ip:<address>' for anonymous demo
--                       traffic — plus the organization-wide row '*'.
--
-- One reservation checks three tiers from those two tables:
--   scope   the caller's own concurrency + daily caps,
--   office  the patient's practice's concurrency ceiling (null scope-less
--           callers skip it), so one busy office cannot starve the others,
--   global  the organization-wide concurrency + daily budget (the AI bill).
-- Denials name the tier so server logs can say why. Caps are passed by the
-- caller on every call (they come from environment knobs, which is how the
-- e2e tester stages denials): a cap of 0 denies every request of that tier,
-- a null cap disables the tier.

create table if not exists public.coach_usage_leases (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  scope text not null,
  office text,
  lease_until timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists coach_usage_leases_kind_scope_idx on public.coach_usage_leases (kind, scope);
create index if not exists coach_usage_leases_kind_office_idx on public.coach_usage_leases (kind, office) where office is not null;
create index if not exists coach_usage_leases_kind_lease_idx on public.coach_usage_leases (kind, lease_until);

create table if not exists public.coach_usage_daily (
  kind text not null,
  scope text not null,
  day date not null,
  used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (kind, scope, day)
);
create index if not exists coach_usage_daily_kind_day_idx on public.coach_usage_daily (kind, day);

-- Service-role only: no client role reads or writes usage rows.
alter table public.coach_usage_leases enable row level security;
alter table public.coach_usage_daily enable row level security;
revoke all on public.coach_usage_leases from public, anon, authenticated;
revoke all on public.coach_usage_daily from public, anon, authenticated;
grant all on public.coach_usage_leases to service_role;
grant all on public.coach_usage_daily to service_role;

create or replace function public.coach_usage_reserve(
  p_kind text,
  p_scope text,
  p_office text,
  p_day date,
  p_scope_concurrent integer,
  p_scope_daily integer,
  p_office_concurrent integer,
  p_global_concurrent integer,
  p_global_daily integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 600), 10), 3600);
  v_scope_used integer;
  v_global_used integer;
  v_active integer;
  v_lease public.coach_usage_leases%rowtype;
begin
  if p_kind is null or char_length(p_kind) = 0 then
    raise exception 'usage kind is required';
  end if;
  if p_scope is null or char_length(p_scope) = 0 then
    raise exception 'usage scope is required';
  end if;
  if p_day is null then
    raise exception 'usage day is required';
  end if;

  -- One reservation of this kind at a time across every server copy. The
  -- lock is held until this transaction commits, so the next caller's
  -- counts include our lease row and daily increments.
  perform pg_advisory_xact_lock(hashtext('coach_usage.' || p_kind));

  -- Self-cleaning: leases a crashed or hung server never released stop
  -- counting the moment they expire, and old daily counters go with them.
  delete from public.coach_usage_leases where kind = p_kind and lease_until <= now();
  delete from public.coach_usage_daily where kind = p_kind and day < p_day - 1;

  -- Daily tiers first: a spent day is final, and must read as such even when
  -- the caller would also have been busy.
  select coalesce(used, 0) into v_scope_used
  from public.coach_usage_daily where kind = p_kind and scope = p_scope and day = p_day;
  v_scope_used := coalesce(v_scope_used, 0);
  if p_scope_daily is not null and v_scope_used >= p_scope_daily then
    return jsonb_build_object('outcome', 'daily', 'tier', 'scope', 'used', v_scope_used);
  end if;

  select coalesce(used, 0) into v_global_used
  from public.coach_usage_daily where kind = p_kind and scope = '*' and day = p_day;
  v_global_used := coalesce(v_global_used, 0);
  if p_global_daily is not null and v_global_used >= p_global_daily then
    return jsonb_build_object('outcome', 'daily', 'tier', 'global', 'used', v_global_used);
  end if;

  -- Concurrency tiers, most specific first so the denial names the real
  -- bottleneck.
  if p_scope_concurrent is not null then
    select count(*)::integer into v_active
    from public.coach_usage_leases where kind = p_kind and scope = p_scope;
    if v_active >= p_scope_concurrent then
      return jsonb_build_object('outcome', 'busy', 'tier', 'scope', 'active', v_active);
    end if;
  end if;

  if p_office is not null and p_office_concurrent is not null then
    select count(*)::integer into v_active
    from public.coach_usage_leases where kind = p_kind and office = p_office;
    if v_active >= p_office_concurrent then
      return jsonb_build_object('outcome', 'busy', 'tier', 'office', 'active', v_active);
    end if;
  end if;

  if p_global_concurrent is not null then
    select count(*)::integer into v_active
    from public.coach_usage_leases where kind = p_kind;
    if v_active >= p_global_concurrent then
      return jsonb_build_object('outcome', 'busy', 'tier', 'global', 'active', v_active);
    end if;
  end if;

  -- Reserve: one lease row (all three concurrency tiers count it) and one
  -- daily unit on the scope row and the organization-wide row.
  insert into public.coach_usage_leases (kind, scope, office, lease_until)
  values (p_kind, p_scope, p_office, now() + make_interval(secs => v_lease_seconds))
  returning * into v_lease;

  insert into public.coach_usage_daily as d (kind, scope, day, used, updated_at)
  values (p_kind, p_scope, p_day, 1, now()), (p_kind, '*', p_day, 1, now())
  on conflict (kind, scope, day) do update set used = d.used + 1, updated_at = now();

  return jsonb_build_object(
    'outcome', 'reserved',
    'lease', v_lease.id,
    'lease_until', v_lease.lease_until,
    'scope_used', v_scope_used + 1,
    'global_used', v_global_used + 1
  );
end;
$$;

-- Frees one concurrency slot. Idempotent: a lease the pruner already expired
-- (or a second release) simply reports false.
create or replace function public.coach_usage_release(p_lease uuid)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  if p_lease is null then
    return false;
  end if;
  delete from public.coach_usage_leases where id = p_lease;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function public.coach_usage_reserve(text, text, text, date, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.coach_usage_reserve(text, text, text, date, integer, integer, integer, integer, integer, integer)
  to service_role;
revoke all on function public.coach_usage_release(uuid) from public, anon, authenticated;
grant execute on function public.coach_usage_release(uuid) to service_role;
