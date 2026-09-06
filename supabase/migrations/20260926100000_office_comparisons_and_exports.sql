-- Office-dimensioned operational analytics + asynchronous CSV export jobs.
--
-- * nonfinancial_office_rollup: one row per (enabled) office for a date
--   range. Point-in-time figures (active, needs attention, lapsed, overdue,
--   inactive, invited) are taken as of the range END; enrollments count
--   inside [p_start, p_end]; engagement figures (engaged, logging patients,
--   check-in patients) use the TRAILING 7-DAY WINDOW ending on the range end
--   (the same contract as the network rollup's engaged_7d and the roster's
--   "last 7 days"); avg_pounds_lost averages ACTIVE patients with both a
--   starting and a current weight (invited/inactive accounts are excluded).
--   first_patient_date lets callers report ranges that predate the office's
--   data as unavailable rather than zero.
-- * nonfinancial_office_daily: the per-office daily series behind sparklines
--   and the office Analytics trend. engaged_patients is a rolling 7-day count
--   (active patients with any activity in [day-6, day]) so the last point of
--   the series equals the rollup's engaged figure; enrollments and check_ins
--   are exact-day counts.
-- * data_exports: the export-job ledger. Rows are service-role only; the API
--   server owns the lifecycle (queued -> running -> ready|failed -> expired),
--   generates the CSV into private object storage, and hands out short-lived
--   signed download links. The object path is bound to the job id exactly
--   like hq_private_files so a job can never point at another job's file.

create or replace function public.nonfinancial_office_rollup(
  p_provider_id text default null,
  p_start date default current_date - 29,
  p_end date default current_date
) returns table (
  provider_id text, office_name text, provider_name text,
  first_patient_date date,
  total_patients bigint, active_patients bigint, enrollments bigint, engaged bigint,
  needs_attention bigint, inactive bigint, invited bigint,
  logging_lapsed bigint, check_ins_overdue bigint,
  logging_patients bigint, check_in_patients bigint,
  avg_pounds_lost numeric
) language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_start is null or p_end is null or p_start > p_end then raise exception 'invalid range'; end if;
  return query
  with offices as (
    select pr.provider_id, pr.office_name, pr.provider_name
    from providers pr
    where coalesce(pr.access_disabled, false) = false
      and (p_provider_id is null or pr.provider_id = p_provider_id)
  ), scoped as (
    select p.provider_id, p.id, p.activation_status, p.created_at::date created_date,
      p.starting_weight, p.current_weight,
      greatest(p.last_log_date, p.last_login_at::date, d.latest_diary, w.latest_water,
        c.latest_check, h.latest_weight, x.latest_photo) latest_activity,
      d.latest_diary, c.latest_check
    from patients p
    join offices o on o.provider_id = p.provider_id
    left join lateral (select max(date_key) latest_diary from patient_diary_entries where patient_id = p.id and date_key <= p_end) d on true
    left join lateral (select max(date_key) latest_water from patient_water_days where patient_id = p.id and date_key <= p_end) w on true
    left join lateral (select max(date_key) latest_check from patient_check_ins where patient_id = p.id and date_key <= p_end) c on true
    left join lateral (select max(measured_at::date) latest_weight from patient_health_measurements where patient_id = p.id and measured_at::date <= p_end) h on true
    left join lateral (select max(date_key) latest_photo from patient_progress_photos where patient_id = p.id and date_key <= p_end) x on true
    where p.created_at::date <= p_end
  ), marked as (
    select *, activation_status in ('activated','active') is_active,
      activation_status not in ('activated','active') is_invited,
      coalesce(activation_status in ('activated','active') and
        (latest_activity is null and created_date <= p_end-14 or latest_activity <= p_end-14), false) is_inactive,
      coalesce(activation_status in ('activated','active') and created_date <= p_end-3 and
        (latest_diary is null or latest_diary <= p_end-3), false) is_logging_lapsed,
      coalesce(activation_status in ('activated','active') and created_date <= p_end-7 and
        (latest_check is null or latest_check <= p_end-7), false) is_check_overdue
    from scoped
  )
  select o.provider_id, o.office_name, o.provider_name,
    (select min(p.created_at)::date from patients p where p.provider_id = o.provider_id),
    count(m.id), count(m.id) filter (where m.is_active),
    count(m.id) filter (where m.created_date between p_start and p_end),
    count(m.id) filter (where m.is_active and m.latest_activity between p_end-6 and p_end),
    count(m.id) filter (where not m.is_inactive and (m.is_logging_lapsed or m.is_check_overdue)),
    count(m.id) filter (where m.is_inactive), count(m.id) filter (where m.is_invited),
    count(m.id) filter (where m.is_logging_lapsed), count(m.id) filter (where m.is_check_overdue),
    count(m.id) filter (where m.is_active and m.latest_diary between p_end-6 and p_end),
    count(m.id) filter (where m.is_active and m.latest_check between p_end-6 and p_end),
    round(avg(m.starting_weight - m.current_weight)
      filter (where m.is_active and m.starting_weight is not null and m.current_weight is not null), 1)
  from offices o
  left join marked m on m.provider_id = o.provider_id
  group by o.provider_id, o.office_name, o.provider_name
  order by o.office_name nulls last, o.provider_id;
end;
$$;
revoke all on function public.nonfinancial_office_rollup(text,date,date) from public, anon, authenticated;
grant execute on function public.nonfinancial_office_rollup(text,date,date) to service_role;

-- Network rollup: a patient with no activity yet made every marker NULL (NOT NULL
-- filters false), so "needs attention" under-counted relative to lapsed/overdue.
-- avg_pounds_lost now averages active patients only, matching its labels.
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
    join providers pr on pr.provider_id = p.provider_id and coalesce(pr.access_disabled,false)=false
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
    (select count(*) from providers pr where (p_provider_id is null or pr.provider_id=p_provider_id) and coalesce(pr.access_disabled,false)=false),
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

create or replace function public.nonfinancial_office_daily(
  p_provider_id text default null,
  p_start date default current_date - 29,
  p_end date default current_date
) returns table (
  provider_id text, date date,
  active_patients bigint, engaged_patients bigint, enrollments bigint, check_ins bigint
) language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_start is null or p_end is null or p_start > p_end or p_end - p_start > 366 then raise exception 'invalid range'; end if;
  return query
  with offices as (
    select pr.provider_id from providers pr
    where coalesce(pr.access_disabled, false) = false
      and (p_provider_id is null or pr.provider_id = p_provider_id)
  ), days as (select d::date as date from generate_series(p_start, p_end, interval '1 day') d),
  active as (
    select p.provider_id, d.date, p.id from days d
    join patients p on p.activation_status in ('activated','active') and p.created_at::date <= d.date
    join offices o on o.provider_id = p.provider_id
  ),
  activity as (
    -- Rolling 7-day engagement: any activity in [day-6, day], mirroring the
    -- rollup's engaged figure (which also counts last_log_date / last login).
    select a.provider_id, a.date, a.id patient_id from active a
    join patients p on p.id = a.id
    where p.last_log_date between a.date-6 and a.date
       or p.last_login_at::date between a.date-6 and a.date
       or exists (select 1 from patient_diary_entries e where e.patient_id = a.id and e.date_key between a.date-6 and a.date)
       or exists (select 1 from patient_check_ins c where c.patient_id = a.id and c.date_key between a.date-6 and a.date)
       or exists (select 1 from patient_water_days w where w.patient_id = a.id and w.date_key between a.date-6 and a.date)
       or exists (select 1 from patient_progress_photos x where x.patient_id = a.id and x.date_key between a.date-6 and a.date)
       or exists (select 1 from patient_health_measurements h where h.patient_id = a.id and h.measured_at::date between a.date-6 and a.date)
  ),
  checks as (
    select a.provider_id, a.date, count(*)::bigint n from active a
    join patient_check_ins c on c.patient_id = a.id and c.date_key = a.date
    group by a.provider_id, a.date
  ),
  enrolled as (
    select p.provider_id, p.created_at::date date, count(*)::bigint n from patients p
    join offices o on o.provider_id = p.provider_id
    where p.created_at::date between p_start and p_end
    group by p.provider_id, p.created_at::date
  )
  select o.provider_id, d.date,
    coalesce((select count(*) from active a where a.provider_id = o.provider_id and a.date = d.date), 0)::bigint,
    coalesce((select count(*) from activity x where x.provider_id = o.provider_id and x.date = d.date), 0)::bigint,
    coalesce((select n from enrolled e where e.provider_id = o.provider_id and e.date = d.date), 0)::bigint,
    coalesce((select n from checks c where c.provider_id = o.provider_id and c.date = d.date), 0)::bigint
  from offices o cross join days d
  order by o.provider_id, d.date;
end;
$$;
revoke all on function public.nonfinancial_office_daily(text,date,date) from public, anon, authenticated;
grant execute on function public.nonfinancial_office_daily(text,date,date) to service_role;

create table if not exists public.data_exports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('office_comparison','patient_activity','audit_events','training_completion','provider_directory')),
  status text not null default 'queued' check (status in ('queued','running','ready','failed','expired')),
  requested_by uuid not null,
  requester_kind text not null check (requester_kind in ('hq','provider','team_member')),
  requester_role text check (requester_role is null or char_length(requester_role) <= 40),
  provider_id text references public.providers(provider_id) on delete cascade,
  params jsonb not null default '{}'::jsonb,
  file_name text check (file_name is null or (char_length(file_name) between 1 and 200 and file_name !~ '[\x00-\x1f/\\]')),
  object_path text unique check (
    object_path is null or (
      object_path ~ '^/objects/exports/[0-9a-f-]{36}/export-[0-9a-f-]{36}\.csv$'
      and split_part(object_path, '/', 4) = id::text
    )
  ),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  row_count bigint check (row_count is null or row_count >= 0),
  error text check (error is null or char_length(error) <= 400),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null,
  download_count integer not null default 0,
  last_downloaded_at timestamptz
);
create index if not exists data_exports_requester_created_idx on public.data_exports(requested_by, created_at desc);
create index if not exists data_exports_status_created_idx on public.data_exports(status, created_at);
create index if not exists data_exports_expiry_idx on public.data_exports(expires_at) where status in ('ready','failed');
alter table public.data_exports enable row level security;
revoke all on public.data_exports from public, anon, authenticated;
grant all on public.data_exports to service_role;

-- Worker claim: exactly one worker instance wins a queued job (skip locked).
create or replace function public.claim_next_data_export()
returns setof public.data_exports language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  return query
  update data_exports x
  set status = 'running', started_at = now(), attempts = x.attempts + 1
  where x.id = (
    select q.id from data_exports q
    where q.status = 'queued' and q.expires_at > now()
    order by q.created_at
    for update skip locked
    limit 1
  )
  returning x.*;
end;
$$;
revoke all on function public.claim_next_data_export() from public, anon, authenticated;
grant execute on function public.claim_next_data_export() to service_role;

-- provider_patient_operational_summary declared OUT column patient_id, so the
-- bare `patient_id = p.id` inside its lateral subqueries was ambiguous and
-- every call failed with 42702. Qualify each activity table's column.
create or replace function public.provider_patient_operational_summary(
  p_provider_id text, p_as_of date default current_date
) returns table (
  patient_id uuid, latest_activity_date date, latest_diary_date date, latest_water_date date,
  latest_check_in_date date, latest_weight_date date, latest_photo_date date,
  logged_days_7 bigint, check_ins_7 bigint
) language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  return query
  select p.id,
    greatest(p.last_log_date, p.last_login_at::date, d.latest_date, w.latest_date, c.latest_date, c.weight_latest_date, hm.latest_date, ph.latest_date),
    d.latest_date, w.latest_date, c.latest_date, greatest(c.weight_latest_date, hm.latest_date), ph.latest_date,
    coalesce(d.logged_days_7, 0)::bigint, coalesce(c.check_ins_7, 0)::bigint
  from patients p
  left join lateral (
    select max(de.date_key) latest_date, count(distinct de.date_key) filter (where de.date_key between p_as_of - 6 and p_as_of) logged_days_7
    from patient_diary_entries de where de.patient_id = p.id and de.date_key <= p_as_of
  ) d on true
  left join lateral (select max(wd.date_key) latest_date from patient_water_days wd where wd.patient_id = p.id and wd.date_key <= p_as_of) w on true
  left join lateral (
    select max(ci.date_key) latest_date, max(ci.date_key) filter (where ci.weight is not null) weight_latest_date,
      count(*) filter (where ci.date_key between p_as_of - 6 and p_as_of) check_ins_7
    from patient_check_ins ci where ci.patient_id = p.id and ci.date_key <= p_as_of
  ) c on true
  left join lateral (select max(hm2.measured_at::date) latest_date from patient_health_measurements hm2 where hm2.patient_id = p.id and hm2.kind = 'weight_lb' and hm2.measured_at::date <= p_as_of) hm on true
  left join lateral (select max(pp.date_key) latest_date from patient_progress_photos pp where pp.patient_id = p.id and pp.date_key <= p_as_of) ph on true
  where p.provider_id = p_provider_id;
end;
$$;
revoke all on function public.provider_patient_operational_summary(text, date) from public, anon, authenticated;
grant execute on function public.provider_patient_operational_summary(text, date) to service_role;
