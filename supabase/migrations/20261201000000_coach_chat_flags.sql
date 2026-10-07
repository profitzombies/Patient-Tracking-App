-- Coach chat safety flags: a patient said something urgent to the AI coach.
--
-- Every real-patient coach message is screened in the background by a small
-- model for a short, fixed list of urgent concerns (severe symptoms,
-- medication problems or overdose, pregnancy, self-harm, eating-disorder
-- signs). A hit becomes one row here — WHO, WHICH conversation, WHY (one
-- model-written line) and a short excerpt — and queues a PHI-free staff
-- notification ("A patient's coach chat needs your review") on the existing
-- staff outbox. The reason and excerpt stay in this table, behind sign-in;
-- email and push carry ids only.
--
-- Posture: patient-owned (cascade FK on patients), service-role only (RLS
-- on, no policies, client grants revoked), enrolled in the identity
-- reconciliation write barrier, and covered by the dynamic patient_id purge
-- enumeration.

create table if not exists public.coach_chat_flags (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  provider_id text not null references public.providers(provider_id) on delete cascade,
  conversation_id uuid references public.patient_chat_conversations(id) on delete set null,
  category text not null check (category in (
    'severe_symptoms', 'medication_problem', 'pregnancy', 'self_harm', 'eating_disorder'
  )),
  -- One line, written by the screening model, naming what was said in
  -- clinical terms ("Reports chest pain since this morning").
  reason text not null check (char_length(reason) between 1 and 300),
  -- The patient's own words, truncated. Staff read it in-app only.
  message_excerpt text not null check (char_length(message_excerpt) between 1 and 1000),
  status text not null default 'open' check (status in ('open', 'reviewed')),
  reviewed_by uuid,
  reviewed_by_name text check (reviewed_by_name is null or char_length(reviewed_by_name) between 1 and 160),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'open' and reviewed_at is null) or (status = 'reviewed' and reviewed_at is not null))
);
create index if not exists coach_chat_flags_provider_status_idx
  on public.coach_chat_flags (provider_id, status, created_at desc);
create index if not exists coach_chat_flags_patient_created_idx
  on public.coach_chat_flags (patient_id, created_at desc);
alter table public.coach_chat_flags enable row level security;
revoke all on public.coach_chat_flags from public, anon, authenticated;
grant all on public.coach_chat_flags to service_role;
comment on table public.coach_chat_flags is
  'Urgent concerns the AI coach safety screen found in a real patient''s chat message: category, one-line reason, excerpt, and staff review state. Service-role only; RLS enabled with no policies by design.';

-- Every new patient_id table joins the identity reconciliation write barrier.
select private.install_patient_identity_write_guards();

-- ── Staff outbox: admit the new kind ────────────────────────────────────────
--
-- The live checks only knew the digest and HQ threshold kinds, so the HQ
-- office-access restriction notice (provider_id null) could never be queued
-- either. Admit both it and the chat flag here: HQ-addressed kinds carry no
-- office, office kinds always do.
alter table public.staff_notifications drop constraint if exists staff_notifications_kind_check;
alter table public.staff_notifications
  add constraint staff_notifications_kind_check
  check (kind in ('staff_attention_digest', 'system_threshold', 'office_access_restricted', 'coach_chat_flag'));
alter table public.staff_notifications drop constraint if exists staff_notifications_scope_check;
alter table public.staff_notifications
  add constraint staff_notifications_scope_check
  check (
    (kind in ('system_threshold', 'office_access_restricted') and provider_id is null)
    or (kind not in ('system_threshold', 'office_access_restricted') and provider_id is not null)
  );
comment on column public.staff_notifications.provider_id is
  'Office the alert belongs to; null only for the HQ-addressed kinds (system_threshold, office_access_restricted).';
