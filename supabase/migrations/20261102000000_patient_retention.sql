-- HQ Patient retention: how many patients each practice onboarded and how
-- many are still active, still buying, or have gone quiet.
--
-- Definitions (all "as of" a date D, per office; a patient is in exactly one
-- of active / inactive):
--
--   onboarded   a patient with a claimed, activated account — auth_user_id
--               linked, activation_status activated/active, not archived, in
--               an enabled office — whose onboarding day
--               (coalesce(claimed_at, created_at)) is on or before D.
--   active      onboarded AND an app-activity day in the trailing 30 days
--               (D-29 .. D). Activity days are the App usage notion
--               (patient_app_activity_days: presence or any logged action,
--               staff excluded).
--   inactive    onboarded AND not active. Quiet days = D minus the last
--               activity day; a patient who never opened the app is quiet
--               since their onboarding day. Tiers: under 60 days ("30-60",
--               which also holds the rare never-active newcomer), 60-89, 90+.
--   buying      onboarded AND (an order paid in the trailing 90 days
--               (D-89 .. D; paid / partially_refunded / refunded / disputed —
--               money changed hands) OR a subscription that is active on D).
--
-- Both functions are service-role only (the API narrows to HQ analytics
-- readers); patients belong to exactly one office, so network figures are
-- plain sums of the per-office rows.

-- ── Per-patient lifecycle status as of a date ───────────────────────────────

create or replace function public.patient_retention_status(
  p_as_of date,
  p_provider_id text default null
) returns table (
  patient_id uuid, provider_id text, onboarded_on date,
  is_active boolean, is_buying boolean, quiet_days integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_as_of is null then raise exception 'invalid date'; end if;
  return query
  with onboarded as (
    select p.id, p.provider_id, p.timezone,
           coalesce(p.claimed_at, p.created_at)::date as onboarded_on
    from patients p
    join providers pr on pr.provider_id = p.provider_id
    where coalesce(pr.access_disabled, false) = false
      and (p_provider_id is null or p.provider_id = p_provider_id)
      and p.auth_user_id is not null
      and p.archived_at is null
      and p.activation_status in ('activated', 'active')
      and coalesce(p.claimed_at, p.created_at)::date <= p_as_of
  ), days as (
    select d.patient_id, max(d.day) as last_day
    from public.patient_app_activity_days(p_as_of - 89, p_as_of) d
    where p_provider_id is null or d.provider_id = p_provider_id
    group by d.patient_id
  )
  select o.id, o.provider_id, o.onboarded_on,
    (d.last_day is not null and d.last_day >= p_as_of - 29) as is_active,
    (
      exists (
        select 1 from billing_orders bo
        where bo.patient_id = o.id
          and bo.status in ('paid', 'partially_refunded', 'refunded', 'disputed')
          and bo.paid_at is not null
          and (bo.paid_at at time zone public.patient_effective_timezone(o.timezone))::date between p_as_of - 89 and p_as_of
      )
      or exists (
        select 1 from billing_subscriptions bs
        where bs.patient_id = o.id
          and bs.status = 'active'
          and (bs.created_at at time zone public.patient_effective_timezone(o.timezone))::date <= p_as_of
          and (bs.current_period_end is null
               or (bs.current_period_end at time zone public.patient_effective_timezone(o.timezone))::date >= p_as_of)
      )
    ) as is_buying,
    (p_as_of - coalesce(d.last_day, greatest(o.onboarded_on, p_as_of - 90)))::integer as quiet_days
  from onboarded o
  left join days d on d.patient_id = o.id;
end;
$$;
revoke all on function public.patient_retention_status(date, text) from public, anon, authenticated;
grant execute on function public.patient_retention_status(date, text) to service_role;

-- ── Per-office counts at each requested date ────────────────────────────────
--
-- One row per enabled office (or the requested office) per date, zero-filled,
-- plus first_onboarded_on so callers can report "unavailable" for ranges that
-- predate an office's first onboarded patient. At most 60 dates per call.

create or replace function public.patient_retention_points(
  p_dates date[],
  p_provider_id text default null
) returns table (
  provider_id text, office_name text, provider_name text,
  first_onboarded_on date, as_of date,
  onboarded bigint, active bigint, buying bigint, inactive bigint,
  inactive_30_60 bigint, inactive_60_90 bigint, inactive_90_plus bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_dates is null or cardinality(p_dates) = 0 or cardinality(p_dates) > 60 then raise exception 'invalid dates'; end if;
  if exists (select 1 from unnest(p_dates) x where x is null) then raise exception 'invalid dates'; end if;
  return query
  with offices as (
    select pr.provider_id, pr.office_name, pr.provider_name,
      (select min(coalesce(p.claimed_at, p.created_at))::date from patients p
        where p.provider_id = pr.provider_id and p.auth_user_id is not null
          and p.archived_at is null and p.activation_status in ('activated', 'active')) as first_onboarded_on
    from providers pr
    where coalesce(pr.access_disabled, false) = false
      and (p_provider_id is null or pr.provider_id = p_provider_id)
  ), dates as (
    select distinct x as as_of from unnest(p_dates) x
  ), status as (
    select d.as_of, s.*
    from dates d
    cross join lateral public.patient_retention_status(d.as_of, p_provider_id) s
  )
  select o.provider_id, o.office_name, o.provider_name, o.first_onboarded_on, d.as_of,
    count(s.patient_id)::bigint,
    count(s.patient_id) filter (where s.is_active)::bigint,
    count(s.patient_id) filter (where s.is_buying)::bigint,
    count(s.patient_id) filter (where not s.is_active)::bigint,
    count(s.patient_id) filter (where not s.is_active and s.quiet_days < 60)::bigint,
    count(s.patient_id) filter (where not s.is_active and s.quiet_days >= 60 and s.quiet_days < 90)::bigint,
    count(s.patient_id) filter (where not s.is_active and s.quiet_days >= 90)::bigint
  from offices o
  cross join dates d
  left join status s on s.provider_id = o.provider_id and s.as_of = d.as_of
  group by o.provider_id, o.office_name, o.provider_name, o.first_onboarded_on, d.as_of
  order by o.office_name, o.provider_id, d.as_of;
end;
$$;
revoke all on function public.patient_retention_points(date[], text) from public, anon, authenticated;
grant execute on function public.patient_retention_points(date[], text) to service_role;
