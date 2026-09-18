-- Verification cost visibility: how many text-message login codes patients
-- redeem per calendar month, against how many patients used the app.
--
-- Every SMS code costs money, so HQ needs "codes per active patient" to see
-- whether sessions really persist. auth_sign_ins already records the method
-- of every sign-in (service-role only, durable); patient_app_presence holds
-- one row per patient per local day. This function rolls both up per UTC
-- month so the API can log the ratio per job tick and show it on System
-- health without any client ever reading the ledger directly.
create or replace function public.hq_patient_sign_in_metrics(p_months integer default 6)
returns table (
  month date,
  sms_sign_ins bigint,
  patients_with_sms_sign_in bigint,
  new_device_sms_sign_ins bigint,
  signups bigint,
  active_patients bigint
) language plpgsql security definer set search_path = '' as $$
declare
  v_months integer := greatest(1, least(coalesce(p_months, 6), 24));
  v_from date := (date_trunc('month', now() at time zone 'utc') - make_interval(months => v_months - 1))::date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  return query
    with months as (
      select generate_series(v_from, (date_trunc('month', now() at time zone 'utc'))::date, interval '1 month')::date as m
    ),
    sign_ins as (
      select
        (date_trunc('month', s.created_at at time zone 'utc'))::date as m,
        count(*) filter (where s.method in ('sms_code', 'password_sms_code'))::bigint as sms_sign_ins,
        count(distinct s.user_id) filter (where s.method in ('sms_code', 'password_sms_code'))::bigint as patients_with_sms_sign_in,
        count(*) filter (where s.method in ('sms_code', 'password_sms_code') and s.new_device)::bigint as new_device_sms_sign_ins,
        count(*) filter (where s.method = 'signup')::bigint as signups
      from public.auth_sign_ins s
      where s.realm = 'patient'
        and s.created_at >= (v_from::timestamp at time zone 'utc')
      group by 1
    ),
    presence as (
      select
        (date_trunc('month', p.day))::date as m,
        count(distinct p.patient_id)::bigint as active_patients
      from public.patient_app_presence p
      where p.day >= v_from
      group by 1
    )
    select
      months.m,
      coalesce(sign_ins.sms_sign_ins, 0)::bigint,
      coalesce(sign_ins.patients_with_sms_sign_in, 0)::bigint,
      coalesce(sign_ins.new_device_sms_sign_ins, 0)::bigint,
      coalesce(sign_ins.signups, 0)::bigint,
      coalesce(presence.active_patients, 0)::bigint
    from months
    left join sign_ins on sign_ins.m = months.m
    left join presence on presence.m = months.m
    order by months.m desc;
end;
$$;
revoke all on function public.hq_patient_sign_in_metrics(integer) from public, anon, authenticated;
grant execute on function public.hq_patient_sign_in_metrics(integer) to service_role;
comment on function public.hq_patient_sign_in_metrics(integer) is
  'Per UTC month (newest first): patient SMS-code sign-ins, distinct patients who redeemed one, new-device SMS sign-ins, signups, and distinct active patients from app presence. Service-role only; counts only, no identities.';
