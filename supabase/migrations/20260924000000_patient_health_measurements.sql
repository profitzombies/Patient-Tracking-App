create table if not exists public.patient_health_measurements (
  patient_id uuid not null references public.patients(id) on delete cascade,
  source text not null check (source in ('apple_health', 'health_connect')),
  source_id text not null,
  kind text not null check (kind in ('weight_lb', 'steps')),
  value numeric not null check (value >= 0),
  measured_at timestamptz not null,
  imported_at timestamptz not null default now(),
  primary key (patient_id, source, source_id)
);

create index if not exists patient_health_measurements_patient_time_idx
  on public.patient_health_measurements (patient_id, measured_at desc);

alter table public.patient_health_measurements enable row level security;
revoke all on public.patient_health_measurements from anon, authenticated;

comment on table public.patient_health_measurements is
  'Service-role-only, account-scoped measurements explicitly imported from patient device health stores.';