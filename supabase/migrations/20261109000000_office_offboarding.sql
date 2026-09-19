-- Office offboarding: when an office ends its contract HQ disables staff
-- sign-in, hands the office its complete record bundle, records the office's
-- written retain-or-destroy choice, seals every patient chart through the
-- account-closure primitive, and marks the office offboarded. The provider
-- row carries the coarse status every selector reads; the detailed hand-over
-- record lives in provider_offboardings (service role only).

alter table public.providers
  add column if not exists offboarding_status text not null default 'active',
  add column if not exists offboarding_started_at timestamptz,
  add column if not exists offboarded_at timestamptz;

alter table public.providers
  drop constraint if exists providers_offboarding_status_check;
alter table public.providers
  add constraint providers_offboarding_status_check
  check (offboarding_status in ('active', 'offboarding', 'offboarded'));

comment on column public.providers.offboarding_status is
  'active = normal office; offboarding = staff sign-in disabled while HQ hands records over and seals charts; offboarded = contract ended, charts sealed.';

create index if not exists providers_offboarding_status_idx
  on public.providers (offboarding_status)
  where offboarding_status <> 'active';

create table if not exists public.provider_offboardings (
  provider_id text primary key references public.providers(provider_id) on delete cascade,
  started_at timestamptz not null default now(),
  started_by uuid,
  access_disabled_at timestamptz,
  staff_sessions_revoked integer not null default 0,
  bundle_export_id uuid,
  bundle_requested_at timestamptz,
  handover_received_by text check (handover_received_by is null or char_length(handover_received_by) <= 200),
  handover_received_on date,
  handover_choice text check (handover_choice is null or handover_choice in ('retain', 'destroy')),
  handover_letter_reference text check (handover_letter_reference is null or char_length(handover_letter_reference) <= 500),
  handover_note text check (handover_note is null or char_length(handover_note) <= 2000),
  handover_recorded_at timestamptz,
  handover_recorded_by uuid,
  seal_started_at timestamptz,
  seal_started_by uuid,
  seal_retain_until timestamptz,
  seal_completed_at timestamptz,
  seal_patients_total integer,
  seal_patients_done integer,
  seal_patients_held integer,
  offboarded_at timestamptz,
  offboarded_by uuid,
  updated_at timestamptz not null default now()
);

comment on table public.provider_offboardings is
  'One row per office offboarding: hand-over record, chosen disposition, and seal progress. Written only by the API service role.';

alter table public.provider_offboardings enable row level security;
revoke all on public.provider_offboardings from public, anon, authenticated;
grant all on public.provider_offboardings to service_role;

-- Every patient the office still holds an open (unsealed) chart for.
create or replace function public.office_offboarding_patients(p_provider_id text)
returns table (patient_id uuid, held boolean)
language sql
security definer
set search_path = public
stable
as $$
  select p.id as patient_id, public.legal_hold_active(p.id) as held
  from patients p
  where p.provider_id = p_provider_id
    and p.archived_at is null
  order by p.created_at asc, p.id asc;
$$;
revoke all on function public.office_offboarding_patients(text) from public, anon, authenticated;
grant execute on function public.office_offboarding_patients(text) to service_role;

-- Enqueue closure (grace 0) for up to p_limit unsealed patients of the office.
-- Idempotent: patients already carrying an open request are only brought
-- forward (purge_after = now), never duplicated. A destroy choice pins the
-- chart's retain-until before closure so patient_close_rows keeps it.
-- Patient-level legal holds park the request as held, exactly as a patient's
-- own closure would. Returns how many rows were queued this call.
create or replace function public.office_offboarding_seal_batch(
  p_provider_id text,
  p_retain_until timestamptz default null,
  p_limit integer default 200
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patient record;
  v_queued integer := 0;
  v_existing uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if public.legal_hold_office_active(p_provider_id) then
    raise exception 'office is under legal hold';
  end if;
  for v_patient in
    select p.id, p.auth_user_id
    from patients p
    where p.provider_id = p_provider_id
      and p.archived_at is null
      and p.closed_at is null
      -- Skip charts already closing/closed and those whose open request is
      -- already due: a repeat call then finds nothing and returns 0.
      and not exists (
        select 1 from patient_deletion_requests r
        where r.patient_id = p.id
          and (r.status in ('closing', 'closed', 'purging', 'failed')
            or (r.status in ('pending', 'held') and r.purge_after <= now()))
      )
    order by p.created_at asc, p.id asc
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
    for update of p skip locked
  loop
    if p_retain_until is not null then
      update patients set record_retain_until = p_retain_until where id = v_patient.id;
    end if;
    select r.id into v_existing from patient_deletion_requests r
    where r.patient_id = v_patient.id and r.status in ('pending', 'held');
    if v_existing is null then
      insert into patient_deletion_requests (patient_id, provider_id, auth_user_id, purge_after, status, held_at)
      values (
        v_patient.id, p_provider_id, v_patient.auth_user_id, now(),
        case when public.legal_hold_active(v_patient.id) then 'held' else 'pending' end,
        case when public.legal_hold_active(v_patient.id) then now() else null end
      );
    else
      update patient_deletion_requests set purge_after = least(purge_after, now()) where id = v_existing;
    end if;
    update patients set deletion_requested_at = coalesce(deletion_requested_at, now()) where id = v_patient.id;
    v_queued := v_queued + 1;
  end loop;
  return v_queued;
end;
$$;
revoke all on function public.office_offboarding_seal_batch(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.office_offboarding_seal_batch(text, timestamptz, integer) to service_role;

-- Seal progress for one office: how many charts exist, how many are sealed
-- (closed or already purged), how many are parked behind a patient hold, how
-- many are still queued or failing.
create or replace function public.office_offboarding_progress(p_provider_id text)
returns table (total bigint, sealed bigint, held bigint, pending bigint, failed bigint, destroyed bigint)
language sql
security definer
set search_path = public
stable
as $$
  with charts as (
    select p.id, p.closed_at,
      (select r.status from patient_deletion_requests r
        where r.patient_id = p.id
        order by r.requested_at desc limit 1) as request_status
    from patients p
    where p.provider_id = p_provider_id
  ),
  tomb as (
    select count(*)::bigint as n from patient_tombstones t where t.provider_id = p_provider_id
  )
  select
    ((select count(*) from charts) + (select n from tomb))::bigint as total,
    ((select count(*) from charts c where c.closed_at is not null) + (select n from tomb))::bigint as sealed,
    (select count(*) from charts c where c.closed_at is null and c.request_status = 'held')::bigint as held,
    (select count(*) from charts c where c.closed_at is null and (c.request_status is null or c.request_status in ('pending', 'closing')))::bigint as pending,
    (select count(*) from charts c where c.closed_at is null and c.request_status = 'failed')::bigint as failed,
    (select n from tomb)::bigint as destroyed;
$$;
revoke all on function public.office_offboarding_progress(text) from public, anon, authenticated;
grant execute on function public.office_offboarding_progress(text) to service_role;

-- Office-scoped claim mirroring claim_due_patient_deletions: the seal job
-- drains one office's queued closures without waiting on the global worker.
-- The hold predicate stays inside the statement; only unclosed (closing-side)
-- requests are claimed here, final purges stay with the global drain.
create or replace function public.claim_office_patient_deletions(
  p_provider_id text,
  p_owner text,
  p_limit integer default 20,
  p_lease_seconds integer default 600
)
returns setof public.patient_deletion_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_owner is null or char_length(p_owner) = 0 then raise exception 'lease owner is required'; end if;
  return query
  with due as (
    select r.id
    from patient_deletion_requests r
    where r.provider_id = p_provider_id
      and r.closed_at is null
      and ((r.status = 'pending' and r.purge_after <= now())
        or (r.status = 'failed' and r.next_attempt_at is not null and r.next_attempt_at <= now())
        or (r.status = 'closing' and (r.lease_until is null or r.lease_until < now())))
      and not public.legal_hold_active(r.patient_id)
      and not public.legal_hold_office_active(p_provider_id)
    order by r.purge_after asc
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  )
  update patient_deletion_requests r
  set status = 'closing',
      started_at = coalesce(r.started_at, now()),
      attempts = r.attempts + 1,
      lease_owner = p_owner,
      lease_until = now() + make_interval(secs => greatest(30, coalesce(p_lease_seconds, 600)))
  from due
  where r.id = due.id
  returning r.*;
end;
$$;
revoke all on function public.claim_office_patient_deletions(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_office_patient_deletions(text, text, integer, integer) to service_role;
