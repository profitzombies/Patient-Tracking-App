-- Office-defined patient groups ("MJH", "Tuesday clinic") and their members.
--
-- Groups are operational labels an office invents for itself: no clinical
-- content, visible to every active teammate of that office, read-only for HQ
-- drill-in. They follow the follow-ups/notes convention — RLS enabled with no
-- client policies, service-role grants only, every read and write goes
-- through the API's office-scope helper.
--
-- Membership rows carry the office alongside the patient AND the group so the
-- two composite foreign keys refuse a cross-office attach at the database
-- (a patient of office A can never join a group of office B even if the API
-- is wrong). Cascades remove memberships with their group or their patient,
-- and because the table carries a patient_id column it is enumerated by
-- patient_purge_rows and enrolled in the identity write-guard protocol below.

-- Composite FK target (already present since the follow-ups migration).
create unique index if not exists patients_id_provider_unique_idx
  on public.patients(id, provider_id);

create table if not exists public.patient_groups (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(provider_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  description text check (description is null or char_length(description) between 1 and 200),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_groups_id_provider_unique unique (id, provider_id)
);
-- Names are unique per office, case-insensitively and ignoring outer spaces.
create unique index if not exists patient_groups_provider_name_ci_idx
  on public.patient_groups(provider_id, lower(btrim(name)));
alter table public.patient_groups enable row level security;
revoke all on public.patient_groups from public, anon, authenticated;
grant all on public.patient_groups to service_role;

create table if not exists public.patient_group_members (
  group_id uuid not null references public.patient_groups(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  provider_id text not null references public.providers(provider_id) on delete cascade,
  added_by uuid,
  added_at timestamptz not null default now(),
  primary key (group_id, patient_id),
  constraint patient_group_members_patient_provider_fk
    foreign key (patient_id, provider_id) references public.patients(id, provider_id) on delete cascade,
  constraint patient_group_members_group_provider_fk
    foreign key (group_id, provider_id) references public.patient_groups(id, provider_id) on delete cascade
);
create index if not exists patient_group_members_provider_patient_idx
  on public.patient_group_members(provider_id, patient_id);
create index if not exists patient_group_members_patient_provider_idx
  on public.patient_group_members(patient_id, provider_id);
alter table public.patient_group_members enable row level security;
revoke all on public.patient_group_members from public, anon, authenticated;
grant all on public.patient_group_members to service_role;

-- Enrol the membership table in the patient identity write barrier so a late
-- write cannot attach a member to an unknown or archived patient.
select private.install_patient_identity_write_guards();
