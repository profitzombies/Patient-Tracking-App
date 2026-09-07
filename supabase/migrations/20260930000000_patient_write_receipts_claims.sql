-- Idempotency receipts become claim-first.
--
-- The API used to insert a receipt AFTER a patient write landed, which left
-- a window (write committed, receipt insert failed, response lost) in which
-- a replay would apply the write a second time. Now the receipt row is
-- claimed in state 'pending' BEFORE the write and flipped to 'done' with the
-- response afterwards, so a replay always finds a durable, operation-keyed
-- record: done → replay the response; pending → wait, or take the claim
-- over once it is older than the API's pending TTL.
--
-- Existing rows were all recorded after a successful write: they default to
-- state 'done' and keep their status/response.

alter table public.patient_write_receipts
  add column if not exists state text not null default 'done',
  add column if not exists claimed_at timestamptz not null default now();

alter table public.patient_write_receipts
  drop constraint if exists patient_write_receipts_state_check;
alter table public.patient_write_receipts
  add constraint patient_write_receipts_state_check
  check (state in ('pending', 'done'));

-- A pending claim has no response yet; a done receipt always has one.
alter table public.patient_write_receipts
  alter column status drop not null;
alter table public.patient_write_receipts
  drop constraint if exists patient_write_receipts_status_check;
alter table public.patient_write_receipts
  add constraint patient_write_receipts_status_check
  check (status is null or status between 200 and 299);
alter table public.patient_write_receipts
  drop constraint if exists patient_write_receipts_state_status_check;
alter table public.patient_write_receipts
  add constraint patient_write_receipts_state_status_check
  check ((state = 'done') = (status is not null));

comment on column public.patient_write_receipts.state is
  'pending = claimed before the write (exclusive under the primary key); done = write landed, status/response hold the answer to replay.';
comment on column public.patient_write_receipts.claimed_at is
  'When the current claim was taken; a pending claim older than the API pending TTL may be taken over by a replay.';
