-- Staff-recorded body measurement visits (inches lost alongside pounds lost).
--
-- One row per visit: the date, an optional note, and whichever body areas
-- staff measured that day. Every area is nullable — a visit is valid with a
-- date and at least one measurement — so unmeasured areas read back as
-- "not measured", never zero. Values are inches, at most one decimal.
--
-- Same posture as patient_staff_weights: service-role only (RLS on, no
-- policies, client grants revoked), office-scoped through the composite
-- (patient_id, provider_id) FK, and enrolled in the patient-identity
-- reconciliation write barrier by rerunning the guard installer.

create table if not exists public.patient_body_measurements (
  visit_id uuid primary key,
  provider_id text not null references public.providers(provider_id) on delete restrict,
  patient_id uuid not null references public.patients(id) on delete cascade,
  date_key date not null,
  note text check (note is null or char_length(note) between 1 and 500),
  neck numeric check (neck is null or neck between 1 and 120),
  chest numeric check (chest is null or chest between 1 and 120),
  left_arm numeric check (left_arm is null or left_arm between 1 and 120),
  right_arm numeric check (right_arm is null or right_arm between 1 and 120),
  waist numeric check (waist is null or waist between 1 and 120),
  hips numeric check (hips is null or hips between 1 and 120),
  left_thigh numeric check (left_thigh is null or left_thigh between 1 and 120),
  right_thigh numeric check (right_thigh is null or right_thigh between 1 and 120),
  left_calf numeric check (left_calf is null or left_calf between 1 and 120),
  right_calf numeric check (right_calf is null or right_calf between 1 and 120),
  recorded_by uuid not null,
  recorded_by_name text not null check (char_length(recorded_by_name) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_body_measurements_patient_provider_fk
    foreign key (patient_id, provider_id) references public.patients(id, provider_id) on delete cascade,
  constraint patient_body_measurements_at_least_one check (
    num_nonnulls(neck, chest, left_arm, right_arm, waist, hips, left_thigh, right_thigh, left_calf, right_calf) >= 1
  )
);
create index if not exists patient_body_measurements_patient_date_idx
  on public.patient_body_measurements(patient_id, date_key desc, created_at desc);
create index if not exists patient_body_measurements_provider_patient_idx
  on public.patient_body_measurements(provider_id, patient_id);
alter table public.patient_body_measurements enable row level security;
revoke all on public.patient_body_measurements from public, anon, authenticated;
grant all on public.patient_body_measurements to service_role;
comment on table public.patient_body_measurements is
  'Office-recorded body measurement visits in inches (one row per visit, nullable per area). API/service-role access only; the patient app never reads this table.';

-- Every new patient_id table joins the identity reconciliation write barrier.
select private.install_patient_identity_write_guards();
