-- Per-patient activity signals for the live office roster.
--
-- The roster used to receive only "latest date" facts plus two window counts
-- and the web app filled everything else (7-day pattern, streaks, check-in
-- rate, averages, mood, side effects) with zeros. This adds one service-only
-- aggregate that answers all of those signals for a whole office in a single
-- query, computed against EACH patient's own local calendar day.
--
-- Day bucketing: every stored row already carries the patient's local day in
-- date_key (the app writes local days), so buckets are simply date_key —
-- the same definition provider_engagement_daily and the patient detail use.
-- Only the "as of" anchor needs a timezone: the roster is read by staff whose
-- clock may sit hours away from the patient's, so "today" is derived from
-- patients.timezone (UTC when unset or unrecognised) at the request moment.
--
-- Zero versus unknown: a family of signals is NULL when the patient has no
-- rows of that kind at all as of their day (nothing to summarise yet);
-- window counts are real zeros only once at least one row exists. Averages
-- are NULL when their window holds no qualifying day (an average over
-- nothing is undefined, not 0).
--
-- Definitions (mirrored by the API's TypeScript reference implementation so
-- roster and detail figures reconcile):
--   logged_last_7    seven booleans, oldest -> newest, ending on as_of_date:
--                    "at least one diary entry that day"
--   logged_days_7    count of true values in logged_last_7
--   meal_streak      consecutive logged days ending on as_of_date, or on the
--                    day before when today has no entry yet (today stays open)
--   avg_calories_7   rounded mean of per-day calorie totals over logged days
--                    in the 7-day window; NULL when no day was logged
--   avg_water_7      rounded mean oz over days in the 7-day window with
--                    oz > 0; NULL when none
--   check_in_streak  consecutive check-in days ending today or yesterday
--   check_in_rate_30 round(100 * check-in days in the 30 days ending
--                    as_of_date / 30)
--   mood_counts      {"1".."5": n} over check-ins in that 30-day window
--   top_side_effects up to three [{name, count}] from the same window,
--                    most frequent first, ties alphabetical
-- Streaks look back at most 400 days (bounded scan; a longer run reports 400).

create or replace function public.patient_effective_timezone(p_timezone text)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_zone text := nullif(btrim(coalesce(p_timezone, '')), '');
begin
  if v_zone is null then
    return 'UTC';
  end if;
  begin
    perform now() at time zone v_zone;
  exception when others then
    return 'UTC';
  end;
  return v_zone;
end;
$$;
comment on function public.patient_effective_timezone(text) is
  'The IANA zone a patient row actually resolves to: the stored timezone when PostgreSQL recognises it, otherwise UTC (the documented last resort for profiles without a zone).';

create or replace function public.provider_patient_activity_summary(
  p_provider_id text,
  p_at timestamptz default now()
) returns table (
  patient_id uuid,
  as_of_date date,
  latest_activity_date date,
  latest_diary_date date,
  latest_water_date date,
  latest_check_in_date date,
  latest_weight_date date,
  latest_photo_date date,
  logged_days_7 bigint,
  check_ins_7 bigint,
  logged_last_7 boolean[],
  meal_streak integer,
  avg_calories_7 integer,
  avg_water_7 integer,
  check_in_streak integer,
  check_in_rate_30 integer,
  mood_counts jsonb,
  top_side_effects jsonb
) language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  return query
  with scoped as (
    select p.id,
           p.last_log_date,
           p.last_login_at,
           public.patient_effective_timezone(p.timezone) as zone,
           (p_at at time zone public.patient_effective_timezone(p.timezone))::date as as_of
    from patients p
    where p.provider_id = p_provider_id
  )
  select
    s.id,
    s.as_of,
    greatest(s.last_log_date, (s.last_login_at at time zone s.zone)::date,
             d.latest_date, w.latest_date, c.latest_date, c.weight_latest_date,
             hm.latest_date, ph.latest_date),
    d.latest_date,
    w.latest_date,
    c.latest_date,
    greatest(c.weight_latest_date, hm.latest_date),
    ph.latest_date,
    case when d.latest_date is null then null else coalesce(d.logged_days_7, 0) end,
    case when c.latest_date is null then null else coalesce(c.check_ins_7, 0) end,
    case when d.latest_date is null then null else d.logged_last_7 end,
    case when d.latest_date is null then null else coalesce(d.meal_streak, 0)::integer end,
    case when d.latest_date is null then null else d.avg_calories_7 end,
    w.avg_water_7,
    case when c.latest_date is null then null else coalesce(c.check_in_streak, 0)::integer end,
    case when c.latest_date is null then null else coalesce(c.check_in_rate_30, 0)::integer end,
    case when c.latest_date is null then null else c.mood_counts end,
    case when c.latest_date is null then null else c.top_side_effects end
  from scoped s
  left join lateral (
    with days as (
      select e.date_key, sum(e.calories) as calories
      from patient_diary_entries e
      where e.patient_id = s.id
        and e.date_key <= s.as_of
        and e.date_key >= s.as_of - 400
      group by e.date_key
    ),
    islands as (
      select dy.date_key,
             dy.date_key - (row_number() over (order by dy.date_key))::integer as grp
      from days dy
    )
    select
      (select max(e.date_key) from patient_diary_entries e
        where e.patient_id = s.id and e.date_key <= s.as_of) as latest_date,
      (select count(*) from days dy
        where dy.date_key between s.as_of - 6 and s.as_of) as logged_days_7,
      (select round(avg(dy.calories))::integer from days dy
        where dy.date_key between s.as_of - 6 and s.as_of) as avg_calories_7,
      (select array_agg(exists (select 1 from days dy where dy.date_key = s.as_of - 6 + g.i)
                        order by g.i)
         from generate_series(0, 6) as g(i)) as logged_last_7,
      (select count(*) from islands i
        where i.grp = (select i2.grp from islands i2
                        where i2.date_key in (s.as_of, s.as_of - 1)
                        order by i2.date_key desc limit 1)) as meal_streak
  ) d on true
  left join lateral (
    select
      max(wd.date_key) as latest_date,
      round(avg(wd.oz) filter (where wd.date_key between s.as_of - 6 and s.as_of and wd.oz > 0))::integer as avg_water_7
    from patient_water_days wd
    where wd.patient_id = s.id and wd.date_key <= s.as_of
  ) w on true
  left join lateral (
    with days as (
      select ci.date_key, ci.mood, ci.side_effects
      from patient_check_ins ci
      where ci.patient_id = s.id
        and ci.date_key <= s.as_of
        and ci.date_key >= s.as_of - 400
    ),
    islands as (
      select dy.date_key,
             dy.date_key - (row_number() over (order by dy.date_key))::integer as grp
      from days dy
    ),
    window30 as (
      select dy.date_key, dy.mood, dy.side_effects from days dy
      where dy.date_key between s.as_of - 29 and s.as_of
    )
    select
      (select max(ci.date_key) from patient_check_ins ci
        where ci.patient_id = s.id and ci.date_key <= s.as_of) as latest_date,
      (select max(ci.date_key) from patient_check_ins ci
        where ci.patient_id = s.id and ci.date_key <= s.as_of and ci.weight is not null) as weight_latest_date,
      (select count(*) from days dy
        where dy.date_key between s.as_of - 6 and s.as_of) as check_ins_7,
      (select count(*) from islands i
        where i.grp = (select i2.grp from islands i2
                        where i2.date_key in (s.as_of, s.as_of - 1)
                        order by i2.date_key desc limit 1)) as check_in_streak,
      (select round(100.0 * count(*) / 30)::integer from window30) as check_in_rate_30,
      (select jsonb_build_object(
          '1', count(*) filter (where w30.mood = 1),
          '2', count(*) filter (where w30.mood = 2),
          '3', count(*) filter (where w30.mood = 3),
          '4', count(*) filter (where w30.mood = 4),
          '5', count(*) filter (where w30.mood = 5))
         from window30 w30) as mood_counts,
      (select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'count', t.n)
                                 order by t.n desc, t.name asc), '[]'::jsonb)
         from (
           select x.name, count(*) as n
           from window30 w30
           cross join lateral jsonb_array_elements_text(w30.side_effects) as x(name)
           group by x.name
           order by n desc, x.name asc
           limit 3
         ) t) as top_side_effects
  ) c on true
  left join lateral (
    select max((hm0.measured_at at time zone s.zone)::date) as latest_date
    from patient_health_measurements hm0
    where hm0.patient_id = s.id
      and hm0.kind = 'weight_lb'
      and (hm0.measured_at at time zone s.zone)::date <= s.as_of
  ) hm on true
  left join lateral (
    select max(pp.date_key) as latest_date
    from patient_progress_photos pp
    where pp.patient_id = s.id and pp.date_key <= s.as_of
  ) ph on true;
end;
$$;
comment on function public.provider_patient_activity_summary(text, timestamptz) is
  'Service-role-only roster aggregate: one row per patient of an office with recency facts and 7/30-day activity signals, computed against each patient''s own local day at p_at. NULL signal families mean "no data of that kind yet", never zero.';

revoke all on function public.patient_effective_timezone(text) from public, anon, authenticated;
grant execute on function public.patient_effective_timezone(text) to service_role;
revoke all on function public.provider_patient_activity_summary(text, timestamptz) from public, anon, authenticated;
grant execute on function public.provider_patient_activity_summary(text, timestamptz) to service_role;
