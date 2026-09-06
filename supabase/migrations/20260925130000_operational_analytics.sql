-- Privacy-safe operational facts and append-only service telemetry.

create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  event_name text not null check (char_length(event_name) between 1 and 80),
  occurred_at timestamptz not null default now(),
  -- providers.provider_id is the existing opaque text account key (for
  -- example live-<uuid>), so this deliberately matches that canonical type.
  provider_id text not null references public.providers(provider_id) on delete restrict,
  patient_id uuid references public.patients(id) on delete set null,
  actor_user_id uuid,
  source text not null check (char_length(source) between 1 and 80),
  properties jsonb not null default '{}'::jsonb
    check (jsonb_typeof(properties) = 'object'),
  dedupe_key text unique check (dedupe_key is null or char_length(dedupe_key) <= 240)
);
create index if not exists analytics_events_provider_time_idx
  on public.analytics_events (provider_id, occurred_at desc);
create index if not exists analytics_events_patient_time_idx
  on public.analytics_events (patient_id, occurred_at desc) where patient_id is not null;
alter table public.analytics_events enable row level security;
revoke all on public.analytics_events from public, anon, authenticated;
grant all on public.analytics_events to service_role;
grant usage, select on sequence public.analytics_events_id_seq to service_role;

create table if not exists public.admin_audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  action text not null check (char_length(action) between 1 and 120),
  actor_user_id uuid,
  actor_kind text not null check (char_length(actor_kind) between 1 and 80),
  provider_id text references public.providers(provider_id) on delete set null,
  target_kind text check (target_kind is null or char_length(target_kind) <= 80),
  target_id text check (target_id is null or char_length(target_id) <= 240),
  request_id text check (request_id is null or char_length(request_id) <= 240),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);
create index if not exists admin_audit_events_provider_time_idx
  on public.admin_audit_events (provider_id, occurred_at desc) where provider_id is not null;
alter table public.admin_audit_events enable row level security;
revoke all on public.admin_audit_events from public, anon, authenticated;
grant all on public.admin_audit_events to service_role;
grant usage, select on sequence public.admin_audit_events_id_seq to service_role;

create or replace function public.reject_operational_event_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'operational event tables are append-only';
end;
$$;
drop trigger if exists analytics_events_append_only on public.analytics_events;
create trigger analytics_events_append_only before update or delete on public.analytics_events
  for each row execute function public.reject_operational_event_mutation();
drop trigger if exists admin_audit_events_append_only on public.admin_audit_events;
create trigger admin_audit_events_append_only before update or delete on public.admin_audit_events
  for each row execute function public.reject_operational_event_mutation();

create or replace function public.record_admin_audit_event(
  p_action text, p_actor_user_id uuid, p_actor_kind text, p_provider_id text default null,
  p_target_kind text default null, p_target_id text default null, p_request_id text default null,
  p_metadata jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  insert into admin_audit_events(action, actor_user_id, actor_kind, provider_id, target_kind, target_id, request_id, metadata)
  values (p_action, p_actor_user_id, p_actor_kind, p_provider_id, p_target_kind, p_target_id, p_request_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;
revoke all on function public.record_admin_audit_event(text, uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_admin_audit_event(text, uuid, text, text, text, text, text, jsonb) to service_role;

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
    coalesce(d.logged_days_7, 0), coalesce(c.check_ins_7, 0)
  from patients p
  left join lateral (
    select max(date_key) latest_date, count(distinct date_key) filter (where date_key between p_as_of - 6 and p_as_of) logged_days_7
    from patient_diary_entries where patient_id = p.id and date_key <= p_as_of
  ) d on true
  left join lateral (select max(date_key) latest_date from patient_water_days where patient_id = p.id and date_key <= p_as_of) w on true
  left join lateral (
    select max(date_key) latest_date, max(date_key) filter (where weight is not null) weight_latest_date,
      count(*) filter (where date_key between p_as_of - 6 and p_as_of) check_ins_7
    from patient_check_ins where patient_id = p.id and date_key <= p_as_of
  ) c on true
  left join lateral (select max(measured_at::date) latest_date from patient_health_measurements where patient_id = p.id and kind = 'weight_lb' and measured_at::date <= p_as_of) hm on true
  left join lateral (select max(date_key) latest_date from patient_progress_photos where patient_id = p.id and date_key <= p_as_of) ph on true
  where p.provider_id = p_provider_id;
end;
$$;
revoke all on function public.provider_patient_operational_summary(text, date) from public, anon, authenticated;
grant execute on function public.provider_patient_operational_summary(text, date) to service_role;

create or replace function public.capture_patient_analytics_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_provider text; v_event text; v_date date; v_key text;
begin
  if tg_table_name = 'patients' then
    if not (new.activation_status = 'activated' and old.activation_status is distinct from 'activated') then return new; end if;
    insert into analytics_events(event_name, occurred_at, provider_id, patient_id, actor_user_id, source, properties, dedupe_key)
    values ('patient_activated', now(), new.provider_id, new.id, new.auth_user_id, 'database_trigger',
      jsonb_build_object('activation_status', 'activated'), 'patient_activated:' || new.id)
    on conflict (dedupe_key) do nothing;
    return new;
  end if;
  select provider_id into v_provider from patients where id = new.patient_id;
  if v_provider is null then return new; end if;
  v_event := case tg_table_name when 'patient_diary_entries' then 'meal_logged'
    when 'patient_check_ins' then 'check_in_completed' when 'patient_progress_photos' then 'progress_photo_added'
    when 'patient_health_measurements' then 'weight_recorded' end;
  if tg_table_name = 'patient_health_measurements' and new.kind <> 'weight_lb' then return new; end if;
  v_date := case when tg_table_name = 'patient_health_measurements' then new.measured_at::date else new.date_key end;
  v_key := v_event || ':' || new.patient_id || ':' ||
    case when tg_table_name = 'patient_diary_entries' then new.entry_id
      when tg_table_name = 'patient_check_ins' then new.check_in_id
      when tg_table_name = 'patient_progress_photos' then new.photo_id else new.source || ':' || new.source_id end;
  insert into analytics_events(event_name, occurred_at, provider_id, patient_id, source, properties, dedupe_key)
  values (v_event, now(), v_provider, new.patient_id, 'database_trigger',
    jsonb_build_object('date', v_date, 'source', case when tg_table_name = 'patient_health_measurements' then new.source else tg_table_name end), v_key)
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;
revoke all on function public.reject_operational_event_mutation() from public, anon, authenticated;
revoke all on function public.capture_patient_analytics_event() from public, anon, authenticated;
drop trigger if exists analytics_diary_insert on public.patient_diary_entries;
create trigger analytics_diary_insert after insert on public.patient_diary_entries for each row execute function public.capture_patient_analytics_event();
drop trigger if exists analytics_check_in_insert on public.patient_check_ins;
create trigger analytics_check_in_insert after insert or update on public.patient_check_ins for each row execute function public.capture_patient_analytics_event();
drop trigger if exists analytics_photo_insert on public.patient_progress_photos;
create trigger analytics_photo_insert after insert on public.patient_progress_photos for each row execute function public.capture_patient_analytics_event();
drop trigger if exists analytics_weight_insert on public.patient_health_measurements;
create trigger analytics_weight_insert after insert on public.patient_health_measurements for each row execute function public.capture_patient_analytics_event();
drop trigger if exists analytics_patient_activation on public.patients;
create trigger analytics_patient_activation after update of activation_status on public.patients for each row execute function public.capture_patient_analytics_event();