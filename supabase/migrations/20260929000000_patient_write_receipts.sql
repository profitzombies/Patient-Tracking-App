-- Idempotency receipts for patient write routes (offline queue replay).
--
-- The patient app queues diary/water/check-in/library/photo/preference/flag
-- writes while offline and replays them in order when the connection
-- returns. Each queued write carries a client-generated Idempotency-Key; the
-- API stores the successful response under (patient, key) and answers a
-- replay from the receipt instead of applying the write a second time.
--
-- Rows are small (status + a tiny JSON body) and short-lived in spirit: the
-- retention sweep may prune anything older than a few days, and the purge
-- lifecycle deletes them with every other patient_id table.
--
-- Same posture as the other patient-owned tables: service-role only (RLS on,
-- no policies, client grants revoked) and enrolled in the identity
-- reconciliation write barrier by rerunning the guard installer.

create table if not exists public.patient_write_receipts (
  patient_id uuid not null references public.patients(id) on delete cascade,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  route text not null check (char_length(route) between 1 and 64),
  status integer not null check (status between 200 and 299),
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (patient_id, idempotency_key)
);
create index if not exists patient_write_receipts_created_idx
  on public.patient_write_receipts(created_at);
alter table public.patient_write_receipts enable row level security;
revoke all on public.patient_write_receipts from public, anon, authenticated;
grant all on public.patient_write_receipts to service_role;
comment on table public.patient_write_receipts is
  'Idempotency receipts for patient write routes: (patient, client key) -> the 2xx response first returned, replayed verbatim on retry. API/service-role access only.';

-- Every new patient_id table joins the identity reconciliation write barrier.
select private.install_patient_identity_write_guards();
