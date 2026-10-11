-- App Store / Google Play review readiness.
--
-- 1. providers.app_review flags the one dedicated "App Review" office whose
--    patient and staff identities Apple and Google reviewers sign in with.
--    It is not a customer: HQ shows the flag, and every customer-facing
--    selector (customer health, weekly health email, retention outreach,
--    rosters and HQ counts) skips it. The office stays sign-in-able, which is
--    why it cannot reuse access_disabled or the offboarding states.
-- 2. claim_verifications.delivery gains 'app_review': a login code row whose
--    fixed code is never texted or emailed. The send-time rule that issues
--    such rows lives in the API (environment-named identities only).

alter table public.providers
  add column if not exists app_review boolean not null default false;

comment on column public.providers.app_review is
  'True only for the dedicated App Review office used by store reviewers. Not a customer: excluded from health, outreach and counts.';

create unique index if not exists providers_single_app_review_idx
  on public.providers ((true)) where app_review;

alter table public.claim_verifications
  drop constraint if exists claim_verifications_delivery_check;
alter table public.claim_verifications
  add constraint claim_verifications_delivery_check
  check (delivery in ('dev', 'twilio_verify', 'resend', 'app_review'));

-- HQ overview counts: the review office and its sample patients are not part
-- of the network. Same body as 20260926100000 plus the app_review filter.
create or replace function public.nonfinancial_operational_rollup(
  p_provider_id text default null,
  p_as_of date default current_date
) returns table (
  provider_count bigint, total_patients bigint, active_patients bigint,
  enrollments_30d bigint, engaged_7d bigint, needs_attention bigint,
  inactive bigint, invited bigint, watchlist bigint, logging_lapsed bigint,
  check_ins_overdue bigint, avg_pounds_lost numeric
) language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  return query
  with scoped as (
    select p.id, p.activation_status, p.created_at::date created_date,
      p.starting_weight, p.current_weight,
      greatest(p.last_log_date, p.last_login_at::date, d.latest_diary, w.latest_water,
        c.latest_check, h.latest_weight, x.latest_photo) latest_activity,
      d.latest_diary, c.latest_check
    from patients p
    join providers pr on pr.provider_id = p.provider_id
      and coalesce(pr.access_disabled,false)=false
      and coalesce(pr.app_review,false)=false
    left join lateral (select max(date_key) latest_diary from patient_diary_entries where patient_id=p.id and date_key<=p_as_of) d on true
    left join lateral (select max(date_key) latest_water from patient_water_days where patient_id=p.id and date_key<=p_as_of) w on true
    left join lateral (select max(date_key) latest_check from patient_check_ins where patient_id=p.id and date_key<=p_as_of) c on true
    left join lateral (select max(measured_at::date) latest_weight from patient_health_measurements where patient_id=p.id and measured_at::date<=p_as_of) h on true
    left join lateral (select max(date_key) latest_photo from patient_progress_photos where patient_id=p.id and date_key<=p_as_of) x on true
    where p_provider_id is null or p.provider_id=p_provider_id
  ), marked as (
    select *, activation_status in ('activated','active') is_active,
      activation_status not in ('activated','active') is_invited,
      coalesce(activation_status in ('activated','active') and
        (latest_activity is null and created_date <= p_as_of-14 or latest_activity <= p_as_of-14), false) is_inactive,
      coalesce(activation_status in ('activated','active') and created_date <= p_as_of-3 and
        (latest_diary is null or latest_diary <= p_as_of-3), false) is_logging_lapsed,
      coalesce(activation_status in ('activated','active') and created_date <= p_as_of-7 and
        (latest_check is null or latest_check <= p_as_of-7), false) is_check_overdue
    from scoped
  )
  select
    (select count(*) from providers pr where (p_provider_id is null or pr.provider_id=p_provider_id)
       and coalesce(pr.access_disabled,false)=false and coalesce(pr.app_review,false)=false),
    count(*), count(*) filter(where is_active),
    count(*) filter(where created_date between p_as_of-29 and p_as_of),
    count(*) filter(where is_active and latest_activity between p_as_of-6 and p_as_of),
    count(*) filter(where not is_inactive and (is_logging_lapsed or is_check_overdue)),
    count(*) filter(where is_inactive), count(*) filter(where is_invited),
    count(*) filter(where is_inactive or is_logging_lapsed or is_check_overdue),
    count(*) filter(where is_logging_lapsed), count(*) filter(where is_check_overdue),
    round(avg(starting_weight-current_weight)
      filter(where is_active and starting_weight is not null and current_weight is not null), 1)
  from marked;
end;
$$;
revoke all on function public.nonfinancial_operational_rollup(text,date) from public, anon, authenticated;
grant execute on function public.nonfinancial_operational_rollup(text,date) to service_role;
