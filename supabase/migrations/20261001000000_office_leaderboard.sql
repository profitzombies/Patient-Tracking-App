-- Per-patient leaderboard facts for the live office leaderboard.
--
-- The leaderboard ranks an office's real patients by weight lost, % lost,
-- goal completion and an adherence score, for a selected period
-- (program-to-date, or a rolling window of N days ending on each patient's
-- own local "today"). This service-only aggregate answers the raw counts
-- and weight readings the API needs for a whole office (or, for HQ, for
-- every office at once) in a single query. The API applies eligibility,
-- computes the scores and assigns ranks — the definitions live in
-- artifacts/api-server/src/leaderboard/ranking.ts and are mirrored here.
--
-- Day bucketing: date_key is the patient's local day (the app writes local
-- days), exactly as provider_patient_activity_summary buckets. "Today" is
-- derived from patients.timezone at p_at (UTC when unset or unrecognised).
--
-- Period (per patient):
--   period_start   program-to-date  → the program start date (the account
--                                     creation day when no start is stored)
--                  N-day window     → greatest(program start, as_of - (N-1))
--   eligible_days  as_of - period_start + 1 (0 when the program has not
--                  started yet); the denominator for every adherence rate
--
-- Activity counts, all within [period_start, as_of]:
--   logged_days     distinct diary days with at least one entry
--   check_in_days   check-in days (one row per day)
--   water_goal_days water days with oz >= the patient's water target
--                   (patient_target_overrides.water_oz, else the program
--                   default of 64 oz)
--
-- Weight readings = patient check-ins with a weight + office weigh-ins
-- (patient_staff_weights), dated on or before as_of; newest = latest
-- date_key, then latest updated_at (the same order the roster's
-- current_weight recompute uses):
--   weigh_in_count       all readings on or before as_of
--   period_weigh_ins     readings dated on/after period_start
--   baseline_weight/date the newest reading dated BEFORE period_start
--                        (NULL when none — the API falls back to the
--                        patient's starting weight)
--   latest_weight/date   the newest reading overall
--
-- NULL versus zero: counts are real zeros (a patient with no diary rows in
-- the period logged zero days); only the weight columns are NULL when no
-- reading exists.

create or replace function public.provider_leaderboard_facts(
  p_provider_id text default null,
  p_at timestamptz default now(),
  p_window_days integer default null
) returns table (
  patient_id uuid,
  provider_id text,
  as_of_date date,
  period_start date,
  eligible_days integer,
  logged_days bigint,
  check_in_days bigint,
  water_goal_days bigint,
  weigh_in_count bigint,
  period_weigh_ins bigint,
  baseline_weight numeric,
  baseline_weight_date date,
  latest_weight numeric,
  latest_weight_date date
) language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_window_days is not null and p_window_days < 1 then
    raise exception 'p_window_days must be at least 1';
  end if;
  return query
  with scoped as (
    select p.id,
           p.provider_id as office_id,
           (p_at at time zone public.patient_effective_timezone(p.timezone))::date as as_of,
           coalesce(
             p.program_start_date,
             (p.created_at at time zone public.patient_effective_timezone(p.timezone))::date
           ) as program_start
    from patients p
    where p_provider_id is null or p.provider_id = p_provider_id
  ),
  bounds as (
    select s.id, s.office_id, s.as_of, s.program_start,
           case when p_window_days is null then s.program_start
                else greatest(s.program_start, s.as_of - (p_window_days - 1)) end as p_start
    from scoped s
  )
  select
    b.id,
    b.office_id,
    b.as_of,
    b.p_start,
    greatest(0, b.as_of - b.p_start + 1)::integer,
    coalesce(d.logged_days, 0),
    coalesce(c.check_in_days, 0),
    coalesce(w.water_goal_days, 0),
    coalesce(r.weigh_in_count, 0),
    coalesce(r.period_weigh_ins, 0),
    r.baseline_weight,
    r.baseline_weight_date,
    r.latest_weight,
    r.latest_weight_date
  from bounds b
  left join lateral (
    select count(distinct e.date_key) as logged_days
    from patient_diary_entries e
    where e.patient_id = b.id
      and e.date_key between b.p_start and b.as_of
  ) d on true
  left join lateral (
    select count(*) as check_in_days
    from patient_check_ins ci
    where ci.patient_id = b.id
      and ci.date_key between b.p_start and b.as_of
  ) c on true
  left join lateral (
    select count(*) as water_goal_days
    from patient_water_days wd
    where wd.patient_id = b.id
      and wd.date_key between b.p_start and b.as_of
      and wd.oz >= coalesce(
        (select t.water_oz from patient_target_overrides t where t.patient_id = b.id),
        64
      )
  ) w on true
  left join lateral (
    with readings as (
      select ci2.weight, ci2.date_key, ci2.updated_at
      from patient_check_ins ci2
      where ci2.patient_id = b.id and ci2.weight is not null and ci2.date_key <= b.as_of
      union all
      select sw.weight, sw.date_key, sw.updated_at
      from patient_staff_weights sw
      where sw.patient_id = b.id and sw.date_key <= b.as_of
    ),
    newest as (
      select rr.weight, rr.date_key from readings rr
      order by rr.date_key desc, rr.updated_at desc limit 1
    ),
    before_period as (
      select rr.weight, rr.date_key from readings rr
      where rr.date_key < b.p_start
      order by rr.date_key desc, rr.updated_at desc limit 1
    )
    select
      (select count(*) from readings) as weigh_in_count,
      (select count(*) from readings rr where rr.date_key >= b.p_start) as period_weigh_ins,
      (select bp.weight from before_period bp) as baseline_weight,
      (select bp.date_key from before_period bp) as baseline_weight_date,
      (select n.weight from newest n) as latest_weight,
      (select n.date_key from newest n) as latest_weight_date
  ) r on true;
end;
$$;
comment on function public.provider_leaderboard_facts(text, timestamptz, integer) is
  'Service-role-only leaderboard aggregate: one row per patient (one office, or every office when p_provider_id is null) with period-window activity counts and weight readings computed against each patient''s own local day at p_at. p_window_days NULL = program to date.';

revoke all on function public.provider_leaderboard_facts(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.provider_leaderboard_facts(text, timestamptz, integer) to service_role;
