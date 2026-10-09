-- HQ Customer health: the raw facts behind the per-practice health score.
--
-- One row per enabled office (access_disabled is not true; the API also drops
-- offboarding / offboarded offices through the shared officeIsActive rule).
-- Nothing here is new tracking — every column restates a definition that
-- already exists elsewhere, as of now:
--
--   last_paid_order_at        the latest paid shop order OWNED by the office
--                             (billing_orders.provider_id, not the patient's
--                             office), live mode only, with a paid timestamp;
--                             orders refunded or disputed later still count
--                             (money changed hands). Sandbox / test-mode orders
--                             never count. Null = no order on record (order
--                             history from the old system is not in this
--                             database).
--   active_subscribers        distinct patients with a subscription whose
--                             status is active (people, not rows).
--   cancelling_subscriptions  active subscriptions set to cancel at period end.
--   app_users                 the Patient retention "onboarded" rule: a claimed,
--                             activated, non-archived patient account.
--   active_app_users_30d      distinct app users with an app-activity day in the
--                             trailing 30 days (today-29 .. today) — the App
--                             usage feed (patient_app_activity_days: presence or
--                             any logged action, staff excluded).
--   active_app_users_prior_30d the same for the 30 days before that
--                             (today-59 .. today-30), for the month-over-month
--                             attention signal.
--   staff_enrolled            non-disabled team members with a linked sign-in,
--                             plus the provider account holder when their own
--                             sign-in is linked (the implicit owner has no team
--                             row).
--
-- Service-role only: the API narrows to HQ analytics readers before calling.

create or replace function public.office_customer_health(
  p_as_of date default current_date
) returns table (
  provider_id text,
  office_name text,
  provider_name text,
  access_disabled boolean,
  offboarding_status text,
  created_at timestamptz,
  last_paid_order_at timestamptz,
  active_subscribers bigint,
  cancelling_subscriptions bigint,
  app_users bigint,
  active_app_users_30d bigint,
  active_app_users_prior_30d bigint,
  staff_enrolled bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_as_of is null then raise exception 'invalid date'; end if;
  return query
  with offices as (
    select pr.provider_id, pr.office_name, pr.provider_name,
           coalesce(pr.access_disabled, false) as access_disabled,
           pr.offboarding_status, pr.created_at, pr.auth_user_id
    from providers pr
    where coalesce(pr.access_disabled, false) = false
  ), app_users as (
    select p.id, p.provider_id
    from patients p
    join offices o on o.provider_id = p.provider_id
    where p.auth_user_id is not null
      and p.archived_at is null
      and p.activation_status in ('activated', 'active')
  ), activity as (
    select u.provider_id,
           count(distinct d.patient_id) filter (where d.day >= p_as_of - 29) as active_30d,
           count(distinct d.patient_id) filter (where d.day < p_as_of - 29) as active_prior_30d
    from public.patient_app_activity_days(p_as_of - 59, p_as_of) d
    join app_users u on u.id = d.patient_id
    group by u.provider_id
  ), orders as (
    select bo.provider_id, max(bo.paid_at) as last_paid_order_at
    from billing_orders bo
    where bo.livemode = true
      and bo.paid_at is not null
      and bo.status in ('paid', 'partially_refunded', 'refunded', 'disputed')
    group by bo.provider_id
  ), subscriptions as (
    select bs.provider_id,
           count(distinct bs.patient_id) as active_subscribers,
           count(*) filter (where bs.cancel_at_period_end = true) as cancelling_subscriptions
    from billing_subscriptions bs
    where bs.status = 'active'
    group by bs.provider_id
  ), users as (
    select u.provider_id, count(*) as app_users
    from app_users u
    group by u.provider_id
  ), staff as (
    select tm.provider_id, count(*) as linked_members
    from team_members tm
    where tm.auth_user_id is not null
      and tm.activation_status is distinct from 'disabled'
    group by tm.provider_id
  )
  select o.provider_id, o.office_name, o.provider_name, o.access_disabled, o.offboarding_status, o.created_at,
         ord.last_paid_order_at,
         coalesce(s.active_subscribers, 0)::bigint,
         coalesce(s.cancelling_subscriptions, 0)::bigint,
         coalesce(u.app_users, 0)::bigint,
         coalesce(a.active_30d, 0)::bigint,
         coalesce(a.active_prior_30d, 0)::bigint,
         (coalesce(st.linked_members, 0) + case when o.auth_user_id is not null then 1 else 0 end)::bigint
  from offices o
  left join orders ord on ord.provider_id = o.provider_id
  left join subscriptions s on s.provider_id = o.provider_id
  left join users u on u.provider_id = o.provider_id
  left join activity a on a.provider_id = o.provider_id
  left join staff st on st.provider_id = o.provider_id
  order by o.office_name, o.provider_id;
end;
$$;
revoke all on function public.office_customer_health(date) from public, anon, authenticated;
grant execute on function public.office_customer_health(date) to service_role;
