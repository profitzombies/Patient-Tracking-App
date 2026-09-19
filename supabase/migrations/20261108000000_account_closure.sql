-- Patient account closure: remove account-only data now, seal the clinical
-- chart for the configured retention window, then run the existing final
-- purge after that window expires.

alter table public.patients
  add column if not exists closed_at timestamptz,
  add column if not exists record_retain_until timestamptz;

comment on column public.patients.closed_at is
  'Account closure time. A non-null value seals this chart read-only; archived_at is stamped to the same value.';
comment on column public.patients.record_retain_until is
  'Earliest time the sealed clinical chart may be finally purged, subject to legal hold.';

alter table public.patient_deletion_requests
  add column if not exists closed_at timestamptz,
  add column if not exists retain_until timestamptz;
alter table public.patient_deletion_requests
  drop constraint if exists patient_deletion_requests_status_check;
alter table public.patient_deletion_requests
  add constraint patient_deletion_requests_status_check
  check (status in ('pending', 'held', 'closing', 'closed', 'cancelled', 'purging', 'purged', 'failed'));

drop index if exists public.patient_deletion_requests_active_idx;
create unique index patient_deletion_requests_active_idx
  on public.patient_deletion_requests (patient_id)
  where status in ('pending', 'held', 'closing', 'closed', 'purging', 'failed');

create or replace function public.patient_deletion_request(p_patient_id uuid, p_grace_seconds integer default 604800)
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
  where r.patient_id = p_patient_id and r.status in ('pending', 'held', 'closing', 'closed', 'purging', 'failed');
  if v_id is null then
    insert into patient_deletion_requests (patient_id, provider_id, auth_user_id, purge_after, status, held_at)
    values (
      p_patient_id, v_provider, v_auth,
      now() + make_interval(secs => greatest(0, coalesce(p_grace_seconds, 604800))),
      case when public.legal_hold_active(p_patient_id) then 'held' else 'pending' end,
      case when public.legal_hold_active(p_patient_id) then now() else null end
    )
    returning id into v_id;
  end if;
  update patients set deletion_requested_at = coalesce(deletion_requested_at, now()) where id = p_patient_id;
  return query select * from patient_deletion_requests where id = v_id;
end;
$$;
revoke all on function public.patient_deletion_request(uuid, integer) from public, anon, authenticated;
grant execute on function public.patient_deletion_request(uuid, integer) to service_role;

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
    where ((r.status = 'pending' and r.purge_after <= now())
       or (r.status = 'closed' and r.retain_until is not null and r.retain_until <= now())
       or (r.status = 'failed' and r.next_attempt_at is not null and r.next_attempt_at <= now())
       or (r.status in ('closing', 'purging') and (r.lease_until is null or r.lease_until < now())))
      and not public.legal_hold_active(r.patient_id)
    order by case when r.closed_at is null then r.purge_after else r.retain_until end asc
    limit greatest(1, least(coalesce(p_limit, 5), 50))
    for update skip locked
  )
  update patient_deletion_requests r
  set status = case when r.closed_at is null then 'closing' else 'purging' end,
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

-- Closure deletes only the account/personal families. Every patient_id table
-- is deliberately classified here: tables not in this list are retained as
-- clinical records, while the lifecycle and append-only ledgers are special.
create or replace function public.patient_close_rows(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req patient_deletion_requests%rowtype;
  v_patient patients%rowtype;
  v_name text;
  v_count bigint;
  v_tables jsonb := '{}'::jsonb;
  v_paths text[] := '{}'::text[];
  v_closed_at timestamptz;
  v_retain_until timestamptz;
  v_days integer;
  v_already_closed boolean;
  v_personal constant text[] := array[
    'coach_conversation_work', 'coach_memories', 'coach_memory_source_suppressions',
    'patient_diary_entries', 'patient_water_days', 'patient_target_overrides',
    'patient_food_prefs', 'patient_custom_foods', 'patient_saved_recipes',
    'food_catalog_usage', 'patient_push_tokens', 'patient_notifications',
    'patient_notification_attempts', 'patient_outreach_state', 'patient_consents',
    'patient_app_events', 'patient_app_presence', 'patient_data_exports',
    'patient_write_receipts', 'billing_carts', 'patient_flags'
  ];
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select * into v_req from patient_deletion_requests where id = p_request_id for update;
  if not found then raise exception 'unknown deletion request'; end if;
  if v_req.status <> 'closing' then raise exception 'deletion request is not being closed'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_req.patient_id::text, 40421001));
  select * into v_patient from patients where id = v_req.patient_id for update;
  if not found then raise exception 'unknown patient'; end if;

  v_already_closed := v_patient.closed_at is not null;
  v_closed_at := coalesce(v_patient.closed_at, now());
  select greatest(1825, coalesce(s.retention_clinical_record_days, 2555))
    into v_days
  from hq_organization_settings s
  where s.singleton = true;
  v_days := coalesce(v_days, 2555);
  v_retain_until := coalesce(v_patient.record_retain_until, v_closed_at + make_interval(days => v_days));

  if not v_already_closed then
    select coalesce(array_agg(path order by path), '{}'::text[])
      into v_paths
    from (
      select pm.object_path as path
      from patient_media pm
      where pm.patient_id = v_req.patient_id and pm.kind in ('food', 'recipe', 'chat')
      union
      select x.object_path
      from patient_data_exports x
      where x.patient_id = v_req.patient_id and x.object_path is not null
    ) objects;

    delete from patient_chat_conversations
    where patient_id = v_req.patient_id and thread in ('coach', 'support');
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('patient_chat_conversations', v_count);

    delete from patient_media
    where patient_id = v_req.patient_id and kind in ('food', 'recipe', 'chat');
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('patient_media', v_count);

    foreach v_name in array v_personal loop
      if to_regclass(format('public.%I', v_name)) is not null then
        execute format('delete from public.%I where patient_id = $1', v_name) using v_req.patient_id;
        get diagnostics v_count = row_count;
        v_tables := v_tables || jsonb_build_object(v_name, v_count);
      end if;
    end loop;

    -- Usage ledgers are append-only aggregate facts; closure only detaches the
    -- account reference. analytics_events remains attached until final purge.
    update ai_usage_events set patient_id = null where patient_id = v_req.patient_id;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('ai_usage_events_detached', v_count);

    delete from auth_sign_ins
    where user_id = v_patient.auth_user_id and realm = 'patient';
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('auth_sign_ins', v_count);
    delete from account_security_state where user_id = v_patient.auth_user_id;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('account_security_state', v_count);

    update patients
    set closed_at = v_closed_at,
        archived_at = v_closed_at,
        record_retain_until = v_retain_until,
        auth_user_id = null,
        email = null,
        phone = null,
        deletion_requested_at = null,
        archived_into_patient_id = null
    where id = v_req.patient_id;
  end if;

  update patient_deletion_requests
  set closed_at = v_closed_at, retain_until = v_retain_until
  where id = p_request_id;

  return jsonb_build_object(
    'tables', v_tables,
    'mediaPaths', to_jsonb(v_paths),
    'authUserId', v_req.auth_user_id,
    'closedAt', v_closed_at,
    'retainUntil', v_retain_until,
    'alreadyClosed', v_already_closed
  );
end;
$$;
revoke all on function public.patient_close_rows(uuid) from public, anon, authenticated;
grant execute on function public.patient_close_rows(uuid) to service_role;

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
  if p_status not in ('closed', 'purged', 'failed') then raise exception 'invalid finish status'; end if;
  return query
  update patient_deletion_requests r
  set status = p_status,
      purge_after = case when p_status = 'closed' then r.retain_until else r.purge_after end,
      purged_at = case when p_status = 'purged' then now() else r.purged_at end,
      last_error = case when p_status = 'failed' then left(p_error, 400) else null end,
      next_attempt_at = case
        when p_status = 'failed' and p_retry_after_seconds is not null
          then now() + make_interval(secs => greatest(0, p_retry_after_seconds))
        else null end,
      lease_owner = null,
      lease_until = null,
      steps = coalesce(p_steps, '{}'::jsonb)
  where r.id = p_request_id and r.status in ('closing', 'purging')
  returning r.*;
end;
$$;
revoke all on function public.patient_deletion_finish(uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.patient_deletion_finish(uuid, text, text, jsonb, integer) to service_role;

create or replace function public.legal_hold_place(
  p_target_kind text,
  p_target_id text,
  p_reason text,
  p_actor uuid default null
)
returns setof public.legal_holds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_target_kind not in ('patient', 'provider') then raise exception 'invalid hold target kind'; end if;
  if p_target_kind = 'patient' then
    if not exists (select 1 from patients p where p.id::text = p_target_id) then raise exception 'unknown patient'; end if;
  elsif not exists (select 1 from providers v where v.provider_id = p_target_id) then
    raise exception 'unknown office';
  end if;
  select h.id into v_id from legal_holds h
  where h.lifted_at is null and h.target_kind = p_target_kind and h.target_id = p_target_id
  for update;
  if v_id is null then
    insert into legal_holds (target_kind, target_id, reason, placed_by)
    values (p_target_kind, p_target_id, p_reason, p_actor)
    returning id into v_id;
  end if;
  -- Closed rows stay closed: the claim predicate blocks their final purge.
  -- Park only grace-phase or closure-failed rows so lift can resume pending.
  update patient_deletion_requests r
  set status = 'held', held_at = now(), next_attempt_at = null
  where r.status in ('pending', 'failed')
    and r.closed_at is null
    and public.legal_hold_active(r.patient_id);
  return query select * from legal_holds where id = v_id;
end;
$$;
revoke all on function public.legal_hold_place(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.legal_hold_place(text, text, text, uuid) to service_role;

create or replace function public.legal_hold_lift(
  p_hold_id uuid,
  p_reason text,
  p_actor uuid default null
)
returns setof public.legal_holds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  update legal_holds h
  set lifted_at = now(), lifted_by = p_actor, lift_reason = p_reason
  where h.id = p_hold_id and h.lifted_at is null;
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'hold not active'; end if;
  update patient_deletion_requests r
  set status = 'pending',
      purge_after = now() + greatest(r.purge_after - coalesce(r.held_at, now()), interval '0'),
      held_at = null
  where r.status = 'held'
    and not public.legal_hold_active(r.patient_id);
  return query select * from legal_holds where id = p_hold_id;
end;
$$;
revoke all on function public.legal_hold_lift(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.legal_hold_lift(uuid, text, uuid) to service_role;

create or replace function public.claim_find_candidates(p_kind text, p_value text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
  from (
    select 'provider' as type,
           pr.provider_id as ref,
           coalesce(nullif(pr.provider_name, ''), pr.office_name) as name,
           pr.email, null::text as phone, null::date as dob,
           (pr.auth_user_id is not null) as claimed, pr.auth_user_id
    from public.providers pr
    where p_kind = 'email' and pr.email is not null
      and lower(pr.email) = lower(p_value)
      and coalesce(pr.access_disabled, false) = false
    union all
    select 'team_member', tm.id::text, tm.name, tm.email, null::text, null::date,
           (tm.auth_user_id is not null), tm.auth_user_id
    from public.team_members tm
    where p_kind = 'email' and tm.email is not null
      and lower(tm.email) = lower(p_value)
      and coalesce(tm.activation_status, '') <> 'disabled'
    union all
    select 'patient', pa.id::text, pa.name, pa.email, pa.phone, pa.date_of_birth,
           (pa.auth_user_id is not null), pa.auth_user_id
    from public.patients pa
    where coalesce(pa.activation_status, '') <> 'disabled'
      and pa.archived_at is null
      and (
        (p_kind = 'email' and pa.email is not null and lower(pa.email) = lower(p_value))
        or (
          p_kind = 'phone' and pa.phone is not null
          and right(regexp_replace(pa.phone, '\D', '', 'g'), 10)
              = right(regexp_replace(p_value, '\D', '', 'g'), 10)
          and length(regexp_replace(pa.phone, '\D', '', 'g')) >= 10
        )
      )
  ) c;
$$;
revoke all on function public.claim_find_candidates(text, text) from public, anon, authenticated;

-- The latest purge already requires purging and reads the patient row before
-- deleting it. A sealed chart is therefore accepted without weakening the
-- lifecycle gate; recreate the canonical implementation in the final schema.
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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_req.patient_id::text, 40421001));
  select * into v_patient from patients where id = v_req.patient_id for update;
  v_patient_existed := found;
  if v_patient_existed and not exists (select 1 from patient_tombstones t where t.id = v_req.patient_id) then
    insert into patient_tombstones (id, provider_id, requested_at, purged_at, was_activated, program_id, enrolled_on)
    values (v_patient.id, v_patient.provider_id, v_req.requested_at, now(),
      v_patient.activation_status = 'activated', v_patient.program_id,
      coalesce(v_patient.program_start_date::date, v_patient.created_at::date));
  end if;
  update billing_payment_links set active = false, patient_id = null where patient_id = v_req.patient_id;
  get diagnostics v_count = row_count;
  v_tables := v_tables || jsonb_build_object('billing_payment_links_anonymized', v_count);
  update billing_payers set patient_id = null, name = 'Deleted patient',
    email = 'deleted+' || id::text || '@invalid.thinnr', phone = null where patient_id = v_req.patient_id;
  get diagnostics v_count = row_count;
  v_tables := v_tables || jsonb_build_object('billing_payers_anonymized', v_count);
  update billing_orders set patient_id = null,
    shipping_address = jsonb_build_object('city', shipping_address->>'city', 'state', shipping_address->>'state',
      'postal_code', shipping_address->>'postal_code', 'country', shipping_address->>'country'),
    metadata = metadata - 'payer' where patient_id = v_req.patient_id;
  get diagnostics v_count = row_count;
  v_tables := v_tables || jsonb_build_object('billing_orders_anonymized', v_count);
  update billing_subscriptions set patient_id = null,
    shipping_address = jsonb_build_object('city', shipping_address->>'city', 'state', shipping_address->>'state',
      'postal_code', shipping_address->>'postal_code', 'country', shipping_address->>'country')
    where patient_id = v_req.patient_id;
  get diagnostics v_count = row_count;
  v_tables := v_tables || jsonb_build_object('billing_subscriptions_anonymized', v_count);
  delete from billing_carts where patient_id = v_req.patient_id;
  get diagnostics v_count = row_count;
  v_tables := v_tables || jsonb_build_object('billing_carts', v_count);
  v_pending := array(
    select c.table_name::text
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema
      and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    left join lateral (
      select count(*) as referenced_by from pg_catalog.pg_constraint k
      where k.contype = 'f' and k.confrelid = format('public.%I', c.table_name)::regclass
    ) refs on true
    where c.table_schema = 'public' and c.column_name = 'patient_id'
      and c.table_name not in ('patient_deletion_requests', 'analytics_events')
      and c.table_name not like 'billing\_%' escape '\'
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
    if v_pass = 3 then raise exception 'purge blocked by foreign keys on %', array_to_string(v_blocked, ', '); end if;
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
    'analyticsDetached', v_detached, 'tables', v_tables, 'authUserId', v_req.auth_user_id
  );
end;
$$;
revoke all on function public.patient_purge_rows(uuid) from public, anon, authenticated;
grant execute on function public.patient_purge_rows(uuid) to service_role;