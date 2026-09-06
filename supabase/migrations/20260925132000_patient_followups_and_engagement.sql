-- Operational follow-up state and aggregate-only historical engagement.
create unique index if not exists patients_id_provider_unique_idx
  on public.patients(id, provider_id);

create table if not exists public.patient_operational_follow_ups (
  id bigint generated always as identity primary key,
  provider_id text not null references public.providers(provider_id) on delete restrict,
  patient_id uuid not null references public.patients(id) on delete cascade,
  reason text not null check (reason in ('no_activity_14d', 'logging_lapsed', 'check_in_overdue')),
  status text not null check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  created_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  constraint patient_operational_follow_ups_patient_provider_fk
    foreign key (patient_id, provider_id) references public.patients(id, provider_id) on delete cascade,
  check (
    (status = 'open' and resolved_at is null and resolved_by is null) or
    (status = 'resolved' and resolved_at is not null)
  )
);
create unique index if not exists patient_operational_follow_ups_one_open_idx
  on public.patient_operational_follow_ups(patient_id, reason) where status = 'open';
create index if not exists patient_operational_follow_ups_provider_patient_idx
  on public.patient_operational_follow_ups(provider_id, patient_id, created_at desc);
create index if not exists patient_operational_follow_ups_patient_provider_idx
  on public.patient_operational_follow_ups(patient_id, provider_id);
alter table public.patient_operational_follow_ups enable row level security;
revoke all on public.patient_operational_follow_ups from public, anon, authenticated;
grant all on public.patient_operational_follow_ups to service_role;
grant usage, select on sequence public.patient_operational_follow_ups_id_seq to service_role;

create or replace function public.provider_engagement_daily(
  p_provider_id text, p_start date, p_end date
) returns table (
  date date, active_patients bigint, engaged_patients bigint,
  patients_with_meal_log bigint, patients_with_check_in bigint,
  patients_with_water bigint, patients_with_photo bigint, patients_with_weight bigint,
  meal_logs bigint, check_ins bigint
) language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  return query
  with days as (select d::date as date from generate_series(p_start, p_end, interval '1 day') d),
  active as (
    select d.date, p.id from days d join patients p on p.provider_id = p_provider_id
      and p.activation_status = 'activated' and p.created_at::date <= d.date
  ),
  meals as (
    select d.date, e.patient_id, count(*) as n from days d join patient_diary_entries e on e.date_key = d.date
      join active p on p.id = e.patient_id and p.date = d.date group by d.date, e.patient_id
  ),
  checks as (
    select d.date, c.patient_id, count(*) as n from days d join patient_check_ins c on c.date_key = d.date
      join active p on p.id = c.patient_id and p.date = d.date group by d.date, c.patient_id
  ),
  water as (select distinct d.date, w.patient_id from days d join patient_water_days w on w.date_key = d.date join active p on p.id = w.patient_id and p.date = d.date),
  photos as (select distinct d.date, x.patient_id from days d join patient_progress_photos x on x.date_key = d.date join active p on p.id = x.patient_id and p.date = d.date),
  weights as (
    select distinct all_weights.date, all_weights.patient_id from (
      select d.date, h.patient_id from days d join patient_health_measurements h on h.measured_at::date = d.date and h.kind = 'weight_lb'
        join active p on p.id = h.patient_id and p.date = d.date
      union
      select d.date, c.patient_id from days d join patient_check_ins c on c.date_key = d.date and c.weight is not null
        join active p on p.id = c.patient_id and p.date = d.date
    ) all_weights
  ),
  engaged as (
    select meals.date, meals.patient_id from meals
    union select checks.date, checks.patient_id from checks
    union select water.date, water.patient_id from water
    union select photos.date, photos.patient_id from photos
    union select weights.date, weights.patient_id from weights
  )
  select d.date, (select count(*) from active a where a.date = d.date), coalesce((select count(*) from engaged x where x.date = d.date), 0),
    coalesce((select count(*) from meals x where x.date = d.date), 0),
    coalesce((select count(*) from checks x where x.date = d.date), 0),
    coalesce((select count(*) from water x where x.date = d.date), 0),
    coalesce((select count(*) from photos x where x.date = d.date), 0),
    coalesce((select count(*) from weights x where x.date = d.date), 0),
    coalesce((select sum(n) from meals x where x.date = d.date), 0)::bigint,
    coalesce((select sum(n) from checks x where x.date = d.date), 0)::bigint
  from days d order by d.date;
end;
$$;
revoke all on function public.provider_engagement_daily(text, date, date) from public, anon, authenticated;
grant execute on function public.provider_engagement_daily(text, date, date) to service_role;