-- App Store / Google Play review readiness, part 2.
--
-- The App Review office (providers.app_review) is not a customer, so the HQ
-- app-usage Insights network totals and their date bounds must leave its
-- sample events out, the same way the overview rollup already does. Same
-- bodies as 20261027010000 plus the app_review filter on the office set.
-- Both functions keep SECURITY DEFINER + service-role gate + grants.

alter table public.providers
  add column if not exists app_review boolean not null default false;

create or replace function public.patient_app_event_insights(
  p_feature text,
  p_start date,
  p_end date,
  p_provider_id text default null
) returns table (local_day date, local_hour smallint, events bigint, patients bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_start is null or p_end is null or p_start > p_end or p_end - p_start > 800 then raise exception 'invalid range'; end if;
  return query
  with offices as (
    select pr.provider_id
    from providers pr
    where coalesce(pr.access_disabled, false) = false
      and coalesce(pr.app_review, false) = false
      and (p_provider_id is null or pr.provider_id = p_provider_id)
  ), clean_days as (
    select d.local_day from patient_app_event_days d
    where d.local_day between p_start and p_end and d.dirty = false
  ), rolled as (
    select r.local_day, r.local_hour, sum(r.events)::bigint as events, sum(r.patients)::bigint as patients
    from patient_app_event_rollups r
    join offices o on o.provider_id = r.provider_id
    join clean_days c on c.local_day = r.local_day
    where r.feature = p_feature
    group by r.local_day, r.local_hour
  ), raw as (
    select e.local_day, e.local_hour, count(*)::bigint as events, count(distinct e.patient_id)::bigint as patients
    from patient_app_events e
    join offices o on o.provider_id = e.provider_id
    where e.feature = p_feature
      and e.local_day between p_start and p_end
      and not exists (select 1 from clean_days c where c.local_day = e.local_day)
    group by e.local_day, e.local_hour
  )
  select u.local_day, u.local_hour, u.events, u.patients
  from (select * from rolled union all select * from raw) u
  order by u.local_day, u.local_hour;
end;
$$;
revoke all on function public.patient_app_event_insights(text, date, date, text) from public, anon, authenticated;
grant execute on function public.patient_app_event_insights(text, date, date, text) to service_role;

create or replace function public.patient_app_event_bounds(
  p_feature text,
  p_provider_id text default null
) returns table (first_day date, first_hourly_day date, first_live_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  return query
  select min(e.local_day),
         min(e.local_day) filter (where e.local_hour >= 0),
         min(e.occurred_at) filter (where e.source = 'live')
  from patient_app_events e
  join providers pr on pr.provider_id = e.provider_id
  where e.feature = p_feature
    and coalesce(pr.access_disabled, false) = false
    and coalesce(pr.app_review, false) = false
    and (p_provider_id is null or e.provider_id = p_provider_id);
end;
$$;
revoke all on function public.patient_app_event_bounds(text, text) from public, anon, authenticated;
grant execute on function public.patient_app_event_bounds(text, text) to service_role;

notify pgrst, 'reload schema';
