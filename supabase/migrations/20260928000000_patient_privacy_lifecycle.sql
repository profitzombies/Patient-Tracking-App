-- Patient consent, self-service data export, and account deletion.
--
-- Three service-only tables, one PII-free tombstone table, and the RPCs the
-- API server drives them with:
--
--   * patient_consents           One row per (patient, policy version): what
--                                was accepted, when, from which app build.
--   * patient_data_exports       Self-service archive jobs (queued → running →
--                                ready | failed → expired). The archive lives
--                                on the patient's own media prefix so the
--                                purge sweeps it with everything else.
--   * patient_deletion_requests  Deletion lifecycle (pending → purging →
--                                purged | failed, or cancelled). The row has
--                                NO foreign key to patients: it must outlive
--                                the patient it describes.
--   * patient_tombstones         Keyed by the former patients.id; carries only
--                                the office, program, and dates staff counts
--                                need. Never a name, contact, or measurement.
--
--   * patient_deletion_request / patient_deletion_cancel
--   * claim_due_patient_deletions   leased FOR UPDATE SKIP LOCKED claim
--   * patient_purge_rows            the database half of a purge: deletes every
--                                   row in every public table carrying
--                                   patient_id (enumerated at run time, so a
--                                   table added later is covered without a
--                                   code change), detaches append-only
--                                   analytics rows, writes the tombstone, and
--                                   deletes the patient row — one transaction,
--                                   idempotent on re-run.
--   * patient_deletion_finish       records purged / failed with step detail.
--
-- All tables are written and read solely by the API server with the service
-- role: RLS enabled with no policies, anon/authenticated grants revoked.
-- Every table carrying patient_id joins the identity write-guard protocol
-- (installer re-run at the end).

-- ── Consent ─────────────────────────────────────────────────────────────────

create table if not exists public.patient_consents (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  policy_version text not null check (char_length(policy_version) between 1 and 40),
  terms_accepted boolean not null,
  privacy_accepted boolean not null,
  health_data_accepted boolean not null,
  -- Optional: AI reading of meal / progress photos.
  photo_analysis_accepted boolean not null default false,
  app_version text check (app_version is null or char_length(app_version) <= 60),
  platform text check (platform is null or char_length(platform) <= 20),
  recorded_at timestamptz not null default now(),
  constraint patient_consents_required_accepted
    check (terms_accepted and privacy_accepted and health_data_accepted),
  constraint patient_consents_patient_version_unique unique (patient_id, policy_version)
);
comment on table public.patient_consents is
  'Explicit, versioned patient consent (terms, privacy, health-data processing, optional photo analysis). Service-role only.';
create index if not exists patient_consents_patient_recorded_idx
  on public.patient_consents (patient_id, recorded_at desc);
alter table public.patient_consents enable row level security;
revoke all on public.patient_consents from public, anon, authenticated;
grant all on public.patient_consents to service_role;

-- ── Data exports ────────────────────────────────────────────────────────────

create table if not exists public.patient_data_exports (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  -- Bound to the patient's own media prefix: ownership is in the path.
  object_path text unique check (
    object_path is null or (
      object_path ~ '^/objects/patient-media/[0-9a-f-]{36}/export-[0-9a-f-]{36}\.zip$'
      and split_part(object_path, '/', 4) = patient_id::text
    )
  ),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  error text check (error is null or char_length(error) <= 400),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null,
  notified_at timestamptz,
  download_count integer not null default 0,
  last_downloaded_at timestamptz
);
comment on table public.patient_data_exports is
  'Self-service patient data archive jobs. Object lives on the patient media prefix; expiry clears the object and flips status.';
create index if not exists patient_data_exports_patient_created_idx
  on public.patient_data_exports (patient_id, created_at desc);
create index if not exists patient_data_exports_status_created_idx
  on public.patient_data_exports (status, created_at);
create index if not exists patient_data_exports_expiry_idx
  on public.patient_data_exports (expires_at) where status in ('queued', 'running', 'ready', 'failed');
alter table public.patient_data_exports enable row level security;
revoke all on public.patient_data_exports from public, anon, authenticated;
grant all on public.patient_data_exports to service_role;

create or replace function public.claim_next_patient_data_export()
returns setof public.patient_data_exports
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  return query
  update patient_data_exports x
  set status = 'running', started_at = now(), attempts = x.attempts + 1
  where x.id = (
    select q.id from patient_data_exports q
    where q.status = 'queued' and q.expires_at > now()
    order by q.created_at
    for update skip locked
    limit 1
  )
  returning x.*;
end;
$$;
revoke all on function public.claim_next_patient_data_export() from public, anon, authenticated;
grant execute on function public.claim_next_patient_data_export() to service_role;

-- ── Deletion requests ───────────────────────────────────────────────────────

alter table public.patients add column if not exists deletion_requested_at timestamptz;
comment on column public.patients.deletion_requested_at is
  'Set while a patient-initiated deletion request is pending (grace period). Cleared on cancel; the row is gone after purge.';

create table if not exists public.patient_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately NOT a foreign key: this row must survive the patient purge.
  patient_id uuid not null,
  provider_id text,
  -- Captured at request time so the auth user can still be removed on a
  -- re-run after the patient row is gone.
  auth_user_id uuid,
  status text not null default 'pending'
    check (status in ('pending', 'cancelled', 'purging', 'purged', 'failed')),
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null,
  cancelled_at timestamptz,
  started_at timestamptz,
  purged_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  lease_owner text,
  lease_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 400),
  -- Per-step outcome of the latest purge run (counts and booleans only).
  steps jsonb not null default '{}'::jsonb check (jsonb_typeof(steps) = 'object')
);
comment on table public.patient_deletion_requests is
  'Patient-initiated account deletion lifecycle with grace period, leased purge claim, retry state, and step detail. No PII.';
create unique index if not exists patient_deletion_requests_active_idx
  on public.patient_deletion_requests (patient_id)
  where status in ('pending', 'purging', 'failed');
create index if not exists patient_deletion_requests_due_idx
  on public.patient_deletion_requests (purge_after) where status = 'pending';
create index if not exists patient_deletion_requests_status_idx
  on public.patient_deletion_requests (status, requested_at desc);
alter table public.patient_deletion_requests enable row level security;
revoke all on public.patient_deletion_requests from public, anon, authenticated;
grant all on public.patient_deletion_requests to service_role;

create table if not exists public.patient_tombstones (
  -- The former patients.id, so roster/record lookups can answer "deleted".
  id uuid primary key,
  provider_id text references public.providers(provider_id) on delete set null,
  requested_at timestamptz not null,
  purged_at timestamptz not null default now(),
  was_activated boolean not null default false,
  program_id text,
  enrolled_on date
);
comment on table public.patient_tombstones is
  'PII-free marker left behind by a completed patient purge: office, program, and dates only.';
create index if not exists patient_tombstones_provider_idx
  on public.patient_tombstones (provider_id, purged_at desc);
alter table public.patient_tombstones enable row level security;
revoke all on public.patient_tombstones from public, anon, authenticated;
grant all on public.patient_tombstones to service_role;

create or replace function public.patient_deletion_request(
  p_patient_id uuid,
  p_grace_seconds integer default 604800
)
returns setof public.patient_deletion_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text;
  v_auth uuid;
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select p.provider_id, p.auth_user_id into v_provider, v_auth
  from patients p where p.id = p_patient_id and p.archived_at is null for update;
  if not found then raise exception 'unknown patient'; end if;
  select r.id into v_id from patient_deletion_requests r
  where r.patient_id = p_patient_id and r.status in ('pending', 'purging', 'failed');
  if v_id is null then
    insert into patient_deletion_requests (patient_id, provider_id, auth_user_id, purge_after)
    values (p_patient_id, v_provider, v_auth, now() + make_interval(secs => greatest(0, coalesce(p_grace_seconds, 604800))))
    returning id into v_id;
  end if;
  update patients set deletion_requested_at = coalesce(deletion_requested_at, now()) where id = p_patient_id;
  return query select * from patient_deletion_requests where id = v_id;
end;
$$;
revoke all on function public.patient_deletion_request(uuid, integer) from public, anon, authenticated;
grant execute on function public.patient_deletion_request(uuid, integer) to service_role;

-- Only a still-pending request can be cancelled: once a purge has started
-- there is nothing left to keep.
create or replace function public.patient_deletion_cancel(p_patient_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  update patient_deletion_requests
  set status = 'cancelled', cancelled_at = now()
  where patient_id = p_patient_id and status = 'pending';
  get diagnostics v_count = row_count;
  if v_count > 0 then
    update patients set deletion_requested_at = null where id = p_patient_id;
  end if;
  return v_count > 0;
end;
$$;
revoke all on function public.patient_deletion_cancel(uuid) from public, anon, authenticated;
grant execute on function public.patient_deletion_cancel(uuid) to service_role;

create or replace function public.claim_due_patient_deletions(
  p_owner text,
  p_limit integer default 5,
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
    where (r.status = 'pending' and r.purge_after <= now())
       or (r.status = 'failed' and r.next_attempt_at is not null and r.next_attempt_at <= now())
       or (r.status = 'purging' and (r.lease_until is null or r.lease_until < now()))
    order by r.purge_after asc
    limit greatest(1, least(coalesce(p_limit, 5), 50))
    for update skip locked
  )
  update patient_deletion_requests r
  set status = 'purging',
      started_at = coalesce(r.started_at, now()),
      attempts = r.attempts + 1,
      lease_owner = p_owner,
      lease_until = now() + make_interval(secs => greatest(30, coalesce(p_lease_seconds, 600)))
  from due
  where r.id = due.id
  returning r.*;
end;
$$;
revoke all on function public.claim_due_patient_deletions(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_due_patient_deletions(text, integer, integer) to service_role;

-- The identity write guard fires on every UPDATE OF patient_id. Detaching a
-- reference (patient_id → null) attaches data to nobody, so it must pass:
-- without this, a purge could never null analytics_events.patient_id and the
-- FK's ON DELETE SET NULL would fail the same way.
create or replace function private.guard_patient_dependency_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_id uuid;
  second_id uuid;
  target_archived_at timestamptz;
begin
  if new.patient_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.patient_id is distinct from new.patient_id and old.patient_id is not null then
    if old.patient_id::text < new.patient_id::text then
      first_id := old.patient_id;
      second_id := new.patient_id;
    else
      first_id := new.patient_id;
      second_id := old.patient_id;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(first_id::text, 40421001)
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(second_id::text, 40421001)
    );
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.patient_id::text, 40421001)
    );
  end if;

  select p.archived_at
  into target_archived_at
  from public.patients p
  where p.id = new.patient_id
  for key share;
  if not found then
    raise exception 'cannot attach data to an unknown patient';
  end if;
  if target_archived_at is not null then
    raise exception 'cannot attach data to an archived patient';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_patient_dependency_write() from public, anon, authenticated;

-- The append-only guard on analytics_events stays, with exactly one carve-out:
-- detaching a purged patient (patient_id → null, nothing else changed).
create or replace function public.reject_operational_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and tg_table_schema = 'public'
     and tg_table_name = 'analytics_events'
     and old.patient_id is not null
     and new.patient_id is null
     and (to_jsonb(new) - 'patient_id') = (to_jsonb(old) - 'patient_id') then
    return new;
  end if;
  raise exception 'operational event tables are append-only';
end;
$$;
revoke all on function public.reject_operational_event_mutation() from public, anon, authenticated;

-- Tables carrying patient_id that the purge must NOT delete from:
--   * patient_deletion_requests — the lifecycle record itself.
--   * analytics_events          — append-only office analytics; the patient
--                                 reference is detached instead.
create or replace function public.patient_purge_rows(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req patient_deletion_requests%rowtype;
  v_patient patients%rowtype;
  v_pending text[];
  v_blocked text[];
  v_name text;
  v_pass integer;
  v_count bigint;
  v_tables jsonb := '{}'::jsonb;
  v_detached bigint := 0;
  v_patient_existed boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select * into v_req from patient_deletion_requests where id = p_request_id for update;
  if not found then raise exception 'unknown deletion request'; end if;
  if v_req.status not in ('purging') then raise exception 'deletion request is not being purged'; end if;

  -- Serialise against identity reconciliation and every guarded writer.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_req.patient_id::text, 40421001));

  select * into v_patient from patients where id = v_req.patient_id for update;
  v_patient_existed := found;

  -- Tombstone first: the identity write guard would reject it once the patient
  -- row is gone, and a re-run must find it already present.
  if v_patient_existed and not exists (select 1 from patient_tombstones t where t.id = v_req.patient_id) then
    insert into patient_tombstones (id, provider_id, requested_at, purged_at, was_activated, program_id, enrolled_on)
    values (
      v_patient.id,
      v_patient.provider_id,
      v_req.requested_at,
      now(),
      v_patient.activation_status = 'activated',
      v_patient.program_id,
      coalesce(v_patient.program_start_date::date, v_patient.created_at::date)
    );
  end if;

  -- Referencing tables first (a NO ACTION foreign key between two
  -- patient-owned tables would otherwise reject the parent's delete); any
  -- table still blocked by a foreign key is retried after the rest.
  v_pending := array(
    select c.table_name::text
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    left join lateral (
      select count(*) as referenced_by
      from pg_catalog.pg_constraint k
      where k.contype = 'f' and k.confrelid = format('public.%I', c.table_name)::regclass
    ) refs on true
    where c.table_schema = 'public'
      and c.column_name = 'patient_id'
      and c.table_name not in ('patient_deletion_requests', 'analytics_events')
    order by refs.referenced_by asc, c.table_name asc
  );
  for v_pass in 1..3 loop
    v_blocked := '{}'::text[];
    foreach v_name in array v_pending loop
      begin
        execute format('delete from public.%I where patient_id = $1', v_name) using v_req.patient_id;
        get diagnostics v_count = row_count;
        v_tables := v_tables || jsonb_build_object(v_name, v_count);
      exception when foreign_key_violation then
        v_blocked := v_blocked || v_name;
      end;
    end loop;
    exit when cardinality(v_blocked) = 0;
    if v_pass = 3 then
      raise exception 'purge blocked by foreign keys on %', array_to_string(v_blocked, ', ');
    end if;
    v_pending := v_blocked;
  end loop;

  update analytics_events set patient_id = null where patient_id = v_req.patient_id;
  get diagnostics v_detached = row_count;

  if v_patient_existed then
    update patients set archived_into_patient_id = null where archived_into_patient_id = v_req.patient_id;
    delete from patients where id = v_req.patient_id;
  end if;

  return jsonb_build_object(
    'patientRowDeleted', v_patient_existed,
    'tombstone', exists (select 1 from patient_tombstones t where t.id = v_req.patient_id),
    'analyticsDetached', v_detached,
    'tables', v_tables,
    'authUserId', v_req.auth_user_id
  );
end;
$$;
revoke all on function public.patient_purge_rows(uuid) from public, anon, authenticated;
grant execute on function public.patient_purge_rows(uuid) to service_role;

create or replace function public.patient_deletion_finish(
  p_request_id uuid,
  p_status text,
  p_error text default null,
  p_steps jsonb default '{}'::jsonb,
  p_retry_after_seconds integer default null
)
returns setof public.patient_deletion_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_status not in ('purged', 'failed') then raise exception 'invalid finish status'; end if;
  return query
  update patient_deletion_requests r
  set status = p_status,
      purged_at = case when p_status = 'purged' then now() else r.purged_at end,
      last_error = case when p_status = 'failed' then left(p_error, 400) else null end,
      next_attempt_at = case
        when p_status = 'failed' and p_retry_after_seconds is not null
          then now() + make_interval(secs => greatest(0, p_retry_after_seconds))
        else null end,
      lease_owner = null,
      lease_until = null,
      steps = coalesce(p_steps, '{}'::jsonb)
  where r.id = p_request_id and r.status = 'purging'
  returning r.*;
end;
$$;
revoke all on function public.patient_deletion_finish(uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.patient_deletion_finish(uuid, text, text, jsonb, integer) to service_role;

-- Account-level (transactional) push category: "your export is ready".
alter table public.patient_notifications drop constraint if exists patient_notifications_category_check;
alter table public.patient_notifications add constraint patient_notifications_category_check
  check (category in ('coach_outreach', 'check_in_reminders', 'office_reminders', 'account'));

-- ── Identity write guard ────────────────────────────────────────────────────

select private.install_patient_identity_write_guards();

do $$
begin
  if exists (
    select 1
    from information_schema.columns c
    join pg_catalog.pg_class table_class on table_class.relname = c.table_name
    join pg_catalog.pg_namespace table_namespace
      on table_namespace.oid = table_class.relnamespace and table_namespace.nspname = c.table_schema
    where c.table_schema = 'public'
      and c.column_name = 'patient_id'
      and not exists (
        select 1 from pg_catalog.pg_trigger trigger_row
        where trigger_row.tgrelid = table_class.oid
          and trigger_row.tgname = 'patient_identity_write_guard'
          and not trigger_row.tgisinternal
      )
  ) then
    raise exception 'patient identity write guard missing from a dependent table';
  end if;
end;
$$;
