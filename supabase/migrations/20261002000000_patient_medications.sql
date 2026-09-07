-- Patient medication records and dose logs.
--
-- A medication row is one thing the patient takes on a schedule: a name, a
-- form, a free-text dose ("1 mL under the tongue"), a schedule (daily at one
-- or more local clock times, or weekly on one weekday at one or more times),
-- optional notes, and start/stop dates. Times are the patient's LOCAL wall
-- clock ("HH:MM", 24 h); the API and the app resolve them against the
-- profile / device timezone, so a schedule survives a timezone move.
--
-- A dose log row is one decision about one scheduled dose occurrence:
-- (medication, local due date, local due time) → taken or skipped. The
-- unique key makes a correction an upsert; an occurrence with no row is
-- "unlogged", which the readers turn into "missed" once its grace period
-- has passed. Deleting a log restores the unlogged state.
--
-- Posture matches every other patient-owned table: service-role only (RLS
-- on, no policies, client grants revoked), patient_id FK cascade, and both
-- tables join the patient-identity reconciliation write barrier by rerunning
-- the guard installer.

create table if not exists public.patient_medications (
  id uuid primary key,
  patient_id uuid not null references public.patients(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  form text not null check (form in ('tablet', 'capsule', 'drops', 'injection', 'liquid', 'other')),
  dose text check (dose is null or char_length(dose) between 1 and 80),
  schedule_kind text not null check (schedule_kind in ('daily', 'weekly')),
  -- Local wall-clock times, "HH:MM" 24 h, ascending, one to six per day.
  times text[] not null check (cardinality(times) between 1 and 6),
  -- 0 = Sunday … 6 = Saturday; required for weekly schedules, null for daily.
  weekday smallint check (weekday is null or weekday between 0 and 6),
  notes text check (notes is null or char_length(notes) between 1 and 500),
  start_date date not null,
  stop_date date check (stop_date is null or stop_date >= start_date),
  source text not null check (source in ('onboarding', 'patient', 'office')),
  created_by uuid,
  created_by_name text check (created_by_name is null or char_length(created_by_name) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_medications_weekly_has_weekday
    check ((schedule_kind = 'weekly') = (weekday is not null))
);
create index if not exists patient_medications_patient_idx
  on public.patient_medications(patient_id, created_at asc);
alter table public.patient_medications enable row level security;
revoke all on public.patient_medications from public, anon, authenticated;
grant all on public.patient_medications to service_role;
comment on table public.patient_medications is
  'Per-patient medication list (name, form, dose, daily/weekly local-time schedule, start/stop). API/service-role access only.';

create table if not exists public.patient_medication_dose_logs (
  id uuid primary key,
  patient_id uuid not null references public.patients(id) on delete cascade,
  medication_id uuid not null references public.patient_medications(id) on delete cascade,
  due_date date not null,
  due_time text not null check (due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  status text not null check (status in ('taken', 'skipped')),
  source text not null check (source in ('reminder', 'check_in', 'account', 'office')),
  logged_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_medication_dose_logs_one_per_occurrence unique (medication_id, due_date, due_time)
);
create index if not exists patient_medication_dose_logs_patient_due_idx
  on public.patient_medication_dose_logs(patient_id, due_date desc);
alter table public.patient_medication_dose_logs enable row level security;
revoke all on public.patient_medication_dose_logs from public, anon, authenticated;
grant all on public.patient_medication_dose_logs to service_role;
comment on table public.patient_medication_dose_logs is
  'One taken/skipped decision per scheduled dose occurrence (medication, local due date, local due time). Unlogged = missed after grace. API/service-role access only.';

-- Every new patient_id table joins the identity reconciliation write barrier.
select private.install_patient_identity_write_guards();
