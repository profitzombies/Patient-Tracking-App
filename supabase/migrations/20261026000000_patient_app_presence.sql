-- App presence + HQ active-app-user aggregates.
--
-- Until now "using the app" was invisible unless a patient logged something:
-- patients.last_login_at is dead and the activity families are all writes.
-- This migration adds:
--
--   * patient_app_presence        One row per (patient, local day) recording
--                                 the first and last instant the patient's
--                                 app was seen and the platform it reported.
--                                 Service-role only; repeated touches are
--                                 idempotent upserts (see the touch RPC).
--   * patient_app_presence_touch  Upsert for today's row, where "today" is
--                                 the patient's own local day (profile
--                                 timezone, UTC as the documented fallback).
--   * patient_app_activity_days   The union of presence and every recorded
--                                 in-app action (meal / water log, check-in,
--                                 weight import, progress photo, coach
--                                 message) as (patient, office, local day)
--                                 rows for patients with a real account.
--   * patient_app_usage_offices   Per enabled office: point figures (active
--                                 in the last 15 minutes, active on the
--                                 patient's local today, rolling 7 / 30 day
--                                 distinct actives ending today and ending on
--                                 the range end) plus first_patient_date so
--                                 callers can report ranges predating the
--                                 office's data as unavailable, never zero.
--   * patient_app_usage_daily     Per enabled office and calendar day of the
--                                 range: rolling 7-day and 30-day distinct
--                                 active patients.
--
-- Patients belong to exactly one office, so network figures are the sum of
-- the per-office distinct counts; the API adds them up.
--
-- The presence table carries patient_id, so it joins the identity write-guard
-- protocol (installer re-run at the end) and is swept by patient_purge_rows,
-- which enumerates patient_id tables at run time.

create table if not exists public.patient_app_presence (
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- The patient's local calendar day (profile timezone at the time of the touch).
  day date not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  platform text not null default 'unknown'
    check (platform in ('ios', 'android', 'web', 'unknown')),
  -- Throttled touches that landed on this row (a coarse "opens" signal).
  touches integer not null default 1 check (touches >= 1),
  primary key (patient_id, day),
  constraint patient_app_presence_seen_order check (first_seen_at <= last_seen_at)
);
comment on table public.patient_app_presence is
  'One row per patient per local day the app was opened or used: first/last seen instants and the reported platform. Service-role only; written by the API presence recorder.';
create index if not exists patient_app_presence_day_idx
  on public.patient_app_presence (day, patient_id);
create index if not exists patient_app_presence_last_seen_idx
  on public.patient_app_presence (last_seen_at desc);
alter table public.patient_app_presence enable row level security;
revoke all on public.patient_app_presence from public, anon, authenticated;
grant all on public.patient_app_presence to service_role;

-- ── Touch ───────────────────────────────────────────────────────────────────

create or replace function public.patient_app_presence_touch(
  p_patient_id uuid,
  p_platform text default 'unknown',
  p_at timestamptz default now()
) returns table (local_day date, first_touch_today boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone text;
  v_day date;
  v_platform text := case when p_platform in ('ios', 'android', 'web') then p_platform else 'unknown' end;
  v_at timestamptz := coalesce(p_at, now());
  v_inserted boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select public.patient_effective_timezone(p.timezone) into v_zone
  from patients p
  where p.id = p_patient_id and p.archived_at is null;
  if not found then raise exception 'unknown patient'; end if;
  v_day := (v_at at time zone v_zone)::date;
  insert into patient_app_presence as a (patient_id, day, first_seen_at, last_seen_at, platform)
  values (p_patient_id, v_day, v_at, v_at, v_platform)
  on conflict (patient_id, day) do update
    set first_seen_at = least(a.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(a.last_seen_at, excluded.last_seen_at),
        platform = excluded.platform,
        touches = a.touches + 1
  returning (xmax = 0) into v_inserted;
  return query select v_day, v_inserted;
end;
$$;
revoke all on function public.patient_app_presence_touch(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.patient_app_presence_touch(uuid, text, timestamptz) to service_role;

-- ── Activity days ───────────────────────────────────────────────────────────
--
-- A patient counts as an active app user on a local day when the app was
-- opened (presence) or the server recorded any in-app action for that day.
-- Only patients with a real account (linked auth user, not archived) in an
-- enabled office are considered; staff never appear here.

create or replace function public.patient_app_activity_days(
  p_from date,
  p_to date
) returns table (patient_id uuid, provider_id text, day date)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_from is null or p_to is null or p_from > p_to then raise exception 'invalid range'; end if;
  return query
  with real_patients as (
    select p.id, p.provider_id, public.patient_effective_timezone(p.timezone) as zone
    from patients p
    join providers pr on pr.provider_id = p.provider_id
    where coalesce(pr.access_disabled, false) = false
      and p.auth_user_id is not null
      and p.archived_at is null
  )
  select distinct r.id, r.provider_id, s.day
  from real_patients r
  join lateral (
    select a.day from patient_app_presence a
      where a.patient_id = r.id and a.day between p_from and p_to
    union
    select d.date_key from patient_diary_entries d
      where d.patient_id = r.id and d.date_key between p_from and p_to
    union
    select w.date_key from patient_water_days w
      where w.patient_id = r.id and w.date_key between p_from and p_to
    union
    select c.date_key from patient_check_ins c
      where c.patient_id = r.id and c.date_key between p_from and p_to
    union
    select x.date_key from patient_progress_photos x
      where x.patient_id = r.id and x.date_key between p_from and p_to
    union
    select (h.measured_at at time zone r.zone)::date from patient_health_measurements h
      where h.patient_id = r.id
        and h.measured_at between ((p_from::timestamp - interval '2 days') at time zone 'UTC')
                              and ((p_to::timestamp + interval '2 days') at time zone 'UTC')
        and (h.measured_at at time zone r.zone)::date between p_from and p_to
    union
    select (m.created_at at time zone r.zone)::date from patient_chat_messages m
      join patient_chat_conversations cv on cv.id = m.conversation_id
      where cv.patient_id = r.id and m.role = 'user'
        and m.created_at between ((p_from::timestamp - interval '2 days') at time zone 'UTC')
                             and ((p_to::timestamp + interval '2 days') at time zone 'UTC')
        and (m.created_at at time zone r.zone)::date between p_from and p_to
  ) s on true;
end;
$$;
revoke all on function public.patient_app_activity_days(date, date) from public, anon, authenticated;
grant execute on function public.patient_app_activity_days(date, date) to service_role;

-- ── Per-office point figures ────────────────────────────────────────────────

create or replace function public.patient_app_usage_offices(
  p_start date,
  p_end date,
  p_at timestamptz default now()
) returns table (
  provider_id text, office_name text, provider_name text,
  first_patient_date date,
  activated_patients bigint, activated_patients_now bigint,
  active_now bigint, active_today bigint,
  weekly_active_today bigint, monthly_active_today bigint,
  weekly_active bigint, monthly_active bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at timestamptz := coalesce(p_at, now());
  v_utc_today date;
  v_from date;
  v_to date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_start is null or p_end is null or p_start > p_end then raise exception 'invalid range'; end if;
  v_utc_today := (v_at at time zone 'UTC')::date;
  -- Cover every local "today" (UTC-12 .. UTC+14) and the range end, each
  -- with its trailing 30 days.
  v_from := least(p_end, v_utc_today - 1) - 29;
  v_to := greatest(p_end, v_utc_today + 1);
  return query
  with offices as (
    select pr.provider_id, pr.office_name, pr.provider_name
    from providers pr
    where coalesce(pr.access_disabled, false) = false
  ), days as (
    select * from public.patient_app_activity_days(v_from, v_to)
  ), subjects as (
    select p.id, p.provider_id,
           (v_at at time zone public.patient_effective_timezone(p.timezone))::date as today
    from patients p
    join offices o on o.provider_id = p.provider_id
    where p.auth_user_id is not null and p.archived_at is null
  ), per_patient as (
    select s.id, s.provider_id,
      exists (select 1 from patient_app_presence a
              where a.patient_id = s.id
                and a.last_seen_at > v_at - interval '15 minutes'
                and a.last_seen_at <= v_at + interval '5 minutes') as is_now,
      exists (select 1 from days x where x.patient_id = s.id and x.day = s.today) as is_today,
      exists (select 1 from days x where x.patient_id = s.id and x.day between s.today - 6 and s.today) as is_weekly_today,
      exists (select 1 from days x where x.patient_id = s.id and x.day between s.today - 29 and s.today) as is_monthly_today,
      exists (select 1 from days x where x.patient_id = s.id and x.day between p_end - 6 and p_end) as is_weekly,
      exists (select 1 from days x where x.patient_id = s.id and x.day between p_end - 29 and p_end) as is_monthly
    from subjects s
  )
  select o.provider_id, o.office_name, o.provider_name,
    (select min(p.created_at)::date from patients p where p.provider_id = o.provider_id),
    (select count(*) from patients p
      where p.provider_id = o.provider_id and p.archived_at is null
        and p.activation_status in ('activated', 'active') and p.created_at::date <= p_end),
    (select count(*) from patients p
      where p.provider_id = o.provider_id and p.archived_at is null
        and p.activation_status in ('activated', 'active')),
    count(pp.id) filter (where pp.is_now),
    count(pp.id) filter (where pp.is_today),
    count(pp.id) filter (where pp.is_weekly_today),
    count(pp.id) filter (where pp.is_monthly_today),
    count(pp.id) filter (where pp.is_weekly),
    count(pp.id) filter (where pp.is_monthly)
  from offices o
  left join per_patient pp on pp.provider_id = o.provider_id
  group by o.provider_id, o.office_name, o.provider_name
  order by o.office_name, o.provider_id;
end;
$$;
revoke all on function public.patient_app_usage_offices(date, date, timestamptz) from public, anon, authenticated;
grant execute on function public.patient_app_usage_offices(date, date, timestamptz) to service_role;

-- ── Per-office daily rolling series ─────────────────────────────────────────

create or replace function public.patient_app_usage_daily(
  p_start date,
  p_end date
) returns table (provider_id text, date date, weekly_active bigint, monthly_active bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_start is null or p_end is null or p_start > p_end or p_end - p_start > 366 then raise exception 'invalid range'; end if;
  return query
  with offices as (
    select pr.provider_id
    from providers pr
    where coalesce(pr.access_disabled, false) = false
  ), days as (
    select * from public.patient_app_activity_days(p_start - 29, p_end)
  ), calendar as (
    select generate_series(p_start, p_end, interval '1 day')::date as date
  )
  select o.provider_id, c.date,
    (select count(distinct x.patient_id) from days x
      where x.provider_id = o.provider_id and x.day between c.date - 6 and c.date)::bigint,
    (select count(distinct x.patient_id) from days x
      where x.provider_id = o.provider_id and x.day between c.date - 29 and c.date)::bigint
  from offices o
  cross join calendar c
  order by o.provider_id, c.date;
end;
$$;
revoke all on function public.patient_app_usage_daily(date, date) from public, anon, authenticated;
grant execute on function public.patient_app_usage_daily(date, date) to service_role;

-- ── Identity write guard ────────────────────────────────────────────────────

select private.install_patient_identity_write_guards();

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.patient_app_presence'::regclass
      and t.tgname = 'patient_identity_write_guard'
      and not t.tgisinternal
  ) then
    raise exception 'patient identity write guard missing from patient_app_presence';
  end if;
end;
$$;
