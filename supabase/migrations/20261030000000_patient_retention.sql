-- HQ patient retention: per office, at each requested as-of date, how many
-- patients have been onboarded onto the platform and how many of those are
-- still active, still buying, or have gone quiet (and for how long).
--
-- Definitions (all as of one date D, evaluated per patient):
--   onboarded  a real-account patient (auth user attached, activated, not
--              archived) whose claim date — or creation date when the
--              account was created directly — is on or before D
--   active     an app-activity day (presence or any recorded action; the
--              same source the App usage page counts) within the trailing
--              30 days ending D
--   buying     a paid order in the trailing 90 days ending D (a partially
--              refunded order still counts; a fully refunded one does not),
--              or a subscription that was active on D — judged by its
--              lifetime (started on or before D, not yet canceled on D), not
--              by its status today, so earlier sample dates stay true after
--              a cancellation
--   inactive   onboarded and not active; tiered by days since the last
--              activity day (or since onboarding when there has never been
--              one): under 30, 30–59, 60–89, 90 or more
--
-- Service role only — the HQ API is the only caller.

create or replace function public.patient_retention_offices(
  p_dates date[]
) returns table (
  provider_id text, office_name text, provider_name text,
  first_patient_date date,
  as_of date,
  onboarded bigint, active bigint, buying bigint, subscribed bigint,
  inactive_under_30 bigint, inactive_30_60 bigint, inactive_60_90 bigint, inactive_90_plus bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from date;
  v_to date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_dates is null or cardinality(p_dates) = 0 or cardinality(p_dates) > 120 then raise exception 'invalid dates'; end if;
  select min(d), max(d) into v_from, v_to from unnest(p_dates) as d;
  if v_from is null or v_to - v_from > 400 then raise exception 'invalid dates'; end if;
  return query
  with offices as (
    select pr.provider_id, pr.office_name, pr.provider_name
    from providers pr
    where coalesce(pr.access_disabled, false) = false
  ), dates as (
    select distinct d as as_of from unnest(p_dates) as d
  ), subjects as (
    select p.id, p.provider_id, coalesce(p.claimed_at, p.created_at)::date as onboarded_on
    from patients p
    join offices o on o.provider_id = p.provider_id
    where p.auth_user_id is not null
      and p.archived_at is null
      and p.activation_status in ('activated', 'active')
  ), days as (
    -- 90 days of history before the earliest as-of date settles every tier.
    select x.patient_id, x.day from public.patient_app_activity_days(v_from - 90, v_to) x
  ), last_activity as (
    select s.id as patient_id, d.as_of, max(x.day) as last_day
    from subjects s
    cross join dates d
    left join days x on x.patient_id = s.id and x.day <= d.as_of
    group by s.id, d.as_of
  ), purchases as (
    select s.id as patient_id, d.as_of,
      bool_or(bo.id is not null) as bought
    from subjects s
    cross join dates d
    left join billing_orders bo
      on bo.patient_id = s.id
     and bo.status in ('paid', 'partially_refunded')
     and bo.paid_at is not null
     and bo.paid_at::date between d.as_of - 89 and d.as_of
    group by s.id, d.as_of
  ), subscriptions as (
    select s.id as patient_id, d.as_of,
      bool_or(bs.id is not null) as subscribed
    from subjects s
    cross join dates d
    left join billing_subscriptions bs
      on bs.patient_id = s.id
     -- Lifetime, not current status: started on or before D and not yet
     -- canceled on D. Never-activated (incomplete) subscriptions never count;
     -- an unpaid one lapses at the end of the last period it paid for.
     and bs.status <> 'incomplete'
     and bs.created_at::date <= d.as_of
     and (bs.canceled_at is null or bs.canceled_at::date > d.as_of)
     and (bs.status <> 'unpaid' or (bs.current_period_end is not null and bs.current_period_end::date > d.as_of))
    group by s.id, d.as_of
  ), per_patient as (
    select s.provider_id, d.as_of, s.id,
      (la.last_day is not null and la.last_day >= d.as_of - 29) as is_active,
      coalesce(pu.bought, false) as bought,
      coalesce(su.subscribed, false) as subscribed,
      (d.as_of - coalesce(la.last_day, s.onboarded_on)) as quiet_days
    from subjects s
    cross join dates d
    join last_activity la on la.patient_id = s.id and la.as_of = d.as_of
    join purchases pu on pu.patient_id = s.id and pu.as_of = d.as_of
    join subscriptions su on su.patient_id = s.id and su.as_of = d.as_of
    where s.onboarded_on <= d.as_of
  )
  select o.provider_id, o.office_name, o.provider_name,
    (select min(p.created_at)::date from patients p where p.provider_id = o.provider_id),
    d.as_of,
    count(pp.id)::bigint,
    count(pp.id) filter (where pp.is_active)::bigint,
    count(pp.id) filter (where pp.bought or pp.subscribed)::bigint,
    count(pp.id) filter (where pp.subscribed)::bigint,
    count(pp.id) filter (where not pp.is_active and pp.quiet_days < 30)::bigint,
    count(pp.id) filter (where not pp.is_active and pp.quiet_days between 30 and 59)::bigint,
    count(pp.id) filter (where not pp.is_active and pp.quiet_days between 60 and 89)::bigint,
    count(pp.id) filter (where not pp.is_active and pp.quiet_days >= 90)::bigint
  from offices o
  cross join dates d
  left join per_patient pp on pp.provider_id = o.provider_id and pp.as_of = d.as_of
  group by o.provider_id, o.office_name, o.provider_name, d.as_of
  order by o.office_name, o.provider_id, d.as_of;
end;
$$;
revoke all on function public.patient_retention_offices(date[]) from public, anon, authenticated;
grant execute on function public.patient_retention_offices(date[]) to service_role;
