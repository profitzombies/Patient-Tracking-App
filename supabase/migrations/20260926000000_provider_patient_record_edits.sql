-- Provider-portal write actions on the live patient record.
--
-- Office staff (and HQ with provider_manage) can now edit demographics and
-- contact details, leave staff-only provider notes, record staff weigh-ins,
-- and set an activation status with a reason. Everything here is service-role
-- only: the API server resolves office scope and audits each write; RLS is on
-- with no policies and client grants are revoked, matching the other
-- patient-owned tables.

-- ── Activation status with reason ───────────────────────────────────────────
--
-- 'paused' and 'discharged' join the legal activation states. Paused and
-- discharged patients are still linked accounts (their login keeps working)
-- but they leave the office's outreach signals and are badged on the roster.

alter table public.patients
  drop constraint if exists patients_activation_status_check;
alter table public.patients
  add constraint patients_activation_status_check
    check (activation_status in ('unactivated', 'activated', 'disabled', 'invited', 'paused', 'discharged'));

alter table public.patients
  add column if not exists activation_reason text,
  add column if not exists activation_updated_at timestamptz,
  add column if not exists activation_updated_by uuid;

alter table public.patients
  drop constraint if exists patients_activation_reason_length_check,
  add constraint patients_activation_reason_length_check
    check (activation_reason is null or char_length(activation_reason) between 1 and 500) not valid;

comment on column public.patients.activation_reason is
  'Staff-entered reason for the current activation status (paused/discharged/reactivated). Operational wording only.';
comment on column public.patients.activation_updated_at is
  'When office staff last changed activation_status through the provider portal.';
comment on column public.patients.activation_updated_by is
  'Auth user id of the staff member who last changed activation_status.';

-- ── Provider notes (staff-only) ─────────────────────────────────────────────

create table if not exists public.patient_provider_notes (
  note_id uuid primary key,
  provider_id text not null references public.providers(provider_id) on delete restrict,
  patient_id uuid not null references public.patients(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  author_user_id uuid not null,
  author_kind text not null check (author_kind in ('provider', 'team_member', 'hq')),
  author_name text not null check (char_length(author_name) between 1 and 160),
  created_at timestamptz not null default now(),
  constraint patient_provider_notes_patient_provider_fk
    foreign key (patient_id, provider_id) references public.patients(id, provider_id) on delete cascade
);
create index if not exists patient_provider_notes_patient_created_idx
  on public.patient_provider_notes(patient_id, created_at desc);
create index if not exists patient_provider_notes_provider_patient_idx
  on public.patient_provider_notes(provider_id, patient_id);
alter table public.patient_provider_notes enable row level security;
revoke all on public.patient_provider_notes from public, anon, authenticated;
grant all on public.patient_provider_notes to service_role;
comment on table public.patient_provider_notes is
  'Staff-only provider notes on a patient record. Never read by patient-facing endpoints; API/service-role access only.';

-- ── Staff-recorded weights ──────────────────────────────────────────────────
--
-- Kept apart from patient_check_ins: a check-in is patient-authored, carries a
-- mood, and is one-per-day. A staff weigh-in is a separate reading with its
-- own audit trail; the record view merges both series with a source marker.

create table if not exists public.patient_staff_weights (
  weight_id uuid primary key,
  provider_id text not null references public.providers(provider_id) on delete restrict,
  patient_id uuid not null references public.patients(id) on delete cascade,
  date_key date not null,
  weight numeric not null check (weight between 40 and 1500),
  note text check (note is null or char_length(note) between 1 and 500),
  recorded_by uuid not null,
  recorded_by_name text not null check (char_length(recorded_by_name) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_staff_weights_patient_provider_fk
    foreign key (patient_id, provider_id) references public.patients(id, provider_id) on delete cascade,
  constraint patient_staff_weights_one_per_day unique (patient_id, date_key)
);
create index if not exists patient_staff_weights_patient_date_idx
  on public.patient_staff_weights(patient_id, date_key desc);
alter table public.patient_staff_weights enable row level security;
revoke all on public.patient_staff_weights from public, anon, authenticated;
grant all on public.patient_staff_weights to service_role;
comment on table public.patient_staff_weights is
  'Office-recorded weigh-ins (one per patient per day). API/service-role access only; the patient app never reads this table.';

-- The roster's current weight / loss figures live on the patients row. Any
-- staff weigh-in change recomputes them from the newest dated reading across
-- patient check-ins and staff entries, in the same transaction as the write.
create or replace function private.recompute_patient_current_weight(p_patient_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  latest numeric;
begin
  select reading.weight into latest
  from (
    select c.weight, c.date_key, c.updated_at
    from public.patient_check_ins c
    where c.patient_id = p_patient_id and c.weight is not null
    union all
    select s.weight, s.date_key, s.updated_at
    from public.patient_staff_weights s
    where s.patient_id = p_patient_id
  ) reading
  order by reading.date_key desc, reading.updated_at desc
  limit 1;

  update public.patients p
  set current_weight = coalesce(latest, p.starting_weight),
      weight_gain_lost = case
        when coalesce(latest, p.starting_weight) is null or p.starting_weight is null then p.weight_gain_lost
        else round(coalesce(latest, p.starting_weight) - p.starting_weight, 1)
      end,
      updated_at = clock_timestamp()
  where p.id = p_patient_id;
end;
$$;
revoke all on function private.recompute_patient_current_weight(uuid) from public, anon, authenticated;

create or replace function private.staff_weight_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.recompute_patient_current_weight(old.patient_id);
    return old;
  end if;
  perform private.recompute_patient_current_weight(new.patient_id);
  return new;
end;
$$;
revoke all on function private.staff_weight_changed() from public, anon, authenticated;

drop trigger if exists staff_weight_recompute on public.patient_staff_weights;
create trigger staff_weight_recompute
  after insert or update or delete on public.patient_staff_weights
  for each row execute function private.staff_weight_changed();

-- Every new patient_id table joins the identity reconciliation write barrier.
select private.install_patient_identity_write_guards();

-- ── Profile edits: one transaction with the login identifiers ───────────────
--
-- Staff contact edits follow the same rule as patient-initiated changes: a
-- claimed account's GoTrue email/phone moves inside the same transaction as
-- the patients row (only where the login actually used the old contact), so
-- a uniqueness failure rolls both back and never strands the credential.
-- Optimistic concurrency rides patients.updated_at: the caller sends the
-- version it rendered and a mismatch raises office_patient_record_conflict.

create or replace function public.office_update_patient_profile(
  p_provider_id text,
  p_patient_id uuid,
  p_patch jsonb,
  p_expected_updated_at timestamptz,
  p_actor_user_id uuid
)
returns public.patients
language plpgsql
security definer
set search_path = ''
as $$
declare
  patient public.patients%rowtype;
  result public.patients%rowtype;
  new_email text;
  new_phone text;
  auth_email text;
  auth_phone text;
  key text;
  -- Legacy rows carry only the combined name; edits to one half must keep
  -- the other half from that split instead of blanking it.
  current_first text;
  current_last text;
  next_first text;
  next_last text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'office_patient_patch_invalid'; end if;
  for key in select jsonb_object_keys(p_patch) loop
    if key not in ('first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'height_inches',
                   'height', 'goal_weight', 'program_start_date', 'timezone') then
      raise exception 'office_patient_patch_invalid';
    end if;
  end loop;

  select * into patient
  from public.patients p
  where p.id = p_patient_id and p.provider_id = p_provider_id and p.archived_at is null
  for update;
  if not found then raise exception 'office_patient_record_not_found'; end if;
  if patient.updated_at is distinct from p_expected_updated_at then
    raise exception 'office_patient_record_conflict';
  end if;

  new_email := case when p_patch ? 'email' then nullif(btrim(p_patch ->> 'email'), '') else patient.email end;
  new_phone := case when p_patch ? 'phone' then nullif(btrim(p_patch ->> 'phone'), '') else patient.phone end;

  if patient.auth_user_id is not null
     and (new_email is distinct from patient.email or new_phone is distinct from patient.phone) then
    select u.email, u.phone into auth_email, auth_phone
    from auth.users u where u.id = patient.auth_user_id
    for update;
    if found then
      if new_email is distinct from patient.email and new_email is not null
         and auth_email is not distinct from patient.email then
        update auth.users
        set email = new_email,
            email_confirmed_at = coalesce(email_confirmed_at, clock_timestamp()),
            updated_at = clock_timestamp()
        where id = patient.auth_user_id;
        update auth.identities
        set identity_data = jsonb_set(coalesce(identity_data, '{}'::jsonb), '{email}', to_jsonb(new_email), true),
            updated_at = clock_timestamp()
        where user_id = patient.auth_user_id and provider = 'email';
      end if;
      if new_phone is distinct from patient.phone and new_phone is not null
         and auth_phone is not null
         and right(regexp_replace(auth_phone, '\D', '', 'g'), 10)
             = right(regexp_replace(coalesce(patient.phone, ''), '\D', '', 'g'), 10) then
        update auth.users
        set phone = new_phone,
            phone_confirmed_at = coalesce(phone_confirmed_at, clock_timestamp()),
            updated_at = clock_timestamp()
        where id = patient.auth_user_id;
        update auth.identities
        set identity_data = jsonb_set(coalesce(identity_data, '{}'::jsonb), '{phone}', to_jsonb(new_phone), true),
            updated_at = clock_timestamp()
        where user_id = patient.auth_user_id and provider = 'phone';
      end if;
    end if;
  end if;

  current_first := coalesce(nullif(btrim(patient.first_name), ''), split_part(btrim(coalesce(patient.name, '')), ' ', 1));
  current_last := coalesce(nullif(btrim(patient.last_name), ''),
    nullif(btrim(regexp_replace(btrim(coalesce(patient.name, '')), '^\S+\s*', '')), ''));
  next_first := case when p_patch ? 'first_name' then nullif(btrim(p_patch ->> 'first_name'), '') else current_first end;
  next_last := case when p_patch ? 'last_name' then nullif(btrim(p_patch ->> 'last_name'), '') else current_last end;

  update public.patients p
  set
    first_name = case when p_patch ? 'first_name' or p_patch ? 'last_name' then next_first else p.first_name end,
    last_name = case when p_patch ? 'first_name' or p_patch ? 'last_name' then next_last else p.last_name end,
    name = case when p_patch ? 'first_name' or p_patch ? 'last_name'
      then nullif(btrim(concat_ws(' ', next_first, next_last)), '')
      else p.name end,
    email = new_email,
    phone = new_phone,
    date_of_birth = case when p_patch ? 'date_of_birth' then (p_patch ->> 'date_of_birth')::date else p.date_of_birth end,
    height_inches = case when p_patch ? 'height_inches' then (p_patch ->> 'height_inches')::numeric else p.height_inches end,
    height = case when p_patch ? 'height' then nullif(btrim(p_patch ->> 'height'), '') else p.height end,
    goal_weight = case when p_patch ? 'goal_weight' then (p_patch ->> 'goal_weight')::numeric else p.goal_weight end,
    program_start_date = case when p_patch ? 'program_start_date' then (p_patch ->> 'program_start_date')::date else p.program_start_date end,
    timezone = case when p_patch ? 'timezone' then nullif(btrim(p_patch ->> 'timezone'), '') else p.timezone end,
    profile_updated_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where p.id = patient.id
  returning * into result;
  return result;
end;
$$;
revoke all on function public.office_update_patient_profile(text, uuid, jsonb, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.office_update_patient_profile(text, uuid, jsonb, timestamptz, uuid) to service_role;

-- ── Roster facts: staff weigh-ins count as weight readings, not activity ────

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
    d.latest_date, w.latest_date, c.latest_date, greatest(c.weight_latest_date, hm.latest_date, sw.latest_date), ph.latest_date,
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
  left join lateral (select max(date_key) latest_date from patient_staff_weights where patient_id = p.id and date_key <= p_as_of) sw on true
  left join lateral (select max(date_key) latest_date from patient_progress_photos where patient_id = p.id and date_key <= p_as_of) ph on true
  where p.provider_id = p_provider_id;
end;
$$;
revoke all on function public.provider_patient_operational_summary(text, date) from public, anon, authenticated;
grant execute on function public.provider_patient_operational_summary(text, date) to service_role;

-- ── HQ rollup: paused/discharged are neither active nor invited ─────────────

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
      activation_status not in ('activated','active','paused','discharged') is_invited,
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
