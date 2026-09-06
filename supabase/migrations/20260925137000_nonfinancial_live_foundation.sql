-- Non-financial live operations: aggregate rollups, HQ settings, private-file
-- metadata, and staff-safe access helpers. All access is API/service-role only.

create table if not exists public.hq_organization_settings (
  singleton boolean primary key default true check (singleton),
  organization_name text not null default 'THINNR' check (char_length(organization_name) between 1 and 160),
  support_email text check (support_email is null or char_length(support_email) <= 320),
  support_phone text check (support_phone is null or char_length(support_phone) <= 40),
  default_timezone text not null default 'America/New_York' check (char_length(default_timezone) between 1 and 80),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.hq_organization_settings(singleton) values (true) on conflict (singleton) do nothing;
alter table public.hq_organization_settings enable row level security;
revoke all on public.hq_organization_settings from public, anon, authenticated;
grant all on public.hq_organization_settings to service_role;

create table if not exists public.hq_private_files (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 240 and name !~ '[\x00-\x1f/\\]'),
  content_type text not null check (char_length(content_type) between 1 and 120),
  size_bytes bigint not null check (size_bytes between 1 and 52428800),
  object_path text not null unique check (
    object_path ~ '^/objects/hq-files/[0-9a-f-]{36}/file-[0-9a-f-]{36}$'
    and split_part(object_path, '/', 4) = id::text
  ),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now()
);
create index if not exists hq_private_files_created_idx on public.hq_private_files(created_at desc);
alter table public.hq_private_files enable row level security;
revoke all on public.hq_private_files from public, anon, authenticated;
grant all on public.hq_private_files to service_role;

create index if not exists patient_chat_conversations_updated_idx
  on public.patient_chat_conversations(updated_at desc, id);
create index if not exists patients_provider_activation_created_idx
  on public.patients(provider_id, activation_status, created_at);

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
      activation_status in ('activated','active') and
        (latest_activity is null and created_date <= p_as_of-14 or latest_activity <= p_as_of-14) is_inactive,
      activation_status in ('activated','active') and created_date <= p_as_of-3 and
        (latest_diary is null or latest_diary <= p_as_of-3) is_logging_lapsed,
      activation_status in ('activated','active') and created_date <= p_as_of-7 and
        (latest_check is null or latest_check <= p_as_of-7) is_check_overdue
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
      filter(where starting_weight is not null and current_weight is not null), 1)
  from marked;
end;
$$;
revoke all on function public.nonfinancial_operational_rollup(text,date) from public, anon, authenticated;
grant execute on function public.nonfinancial_operational_rollup(text,date) to service_role;