-- Bloodwork lifecycle integration: upload hygiene, private-object identity
-- binding, and account-purge preparation. This migration is intentionally
-- additive and follows the canonical bloodwork schema migration.

-- Upload URLs for bloodwork staging objects participate in the same abandoned
-- upload grace period as every other upload surface.
alter table public.storage_upload_intents
  drop constraint if exists storage_upload_intents_surface_check;
alter table public.storage_upload_intents
  add constraint storage_upload_intents_surface_check check (surface in (
    'patient_media', 'hq_file', 'training_video', 'training_thumbnail',
    'training_attachment', 'knowledge_document', 'bloodwork'
  ));

-- Both staging objects and immutable committed source objects are live
-- references while their file row exists. This keeps both sides of storage
-- reconciliation from deleting a report that is still bound in the database.
create or replace function public.storage_referenced_paths(p_paths text[])
returns setof text
language sql
stable
set search_path = public, pg_temp
as $$
  select object_path from public.patient_media where object_path = any(p_paths)
  union
  select object_path from public.patient_progress_photos where object_path = any(p_paths)
  union
  select photo_path from public.patient_custom_foods where photo_path = any(p_paths)
  union
  select photo_path from public.patient_saved_recipes where photo_path = any(p_paths)
  union
  select photo->>'path' from public.patient_chat_messages where photo->>'path' = any(p_paths)
  union
  select object_path from public.hq_private_files where object_path = any(p_paths)
  union
  select object_path from public.knowledge_documents where object_path = any(p_paths)
  union
  select video_source from public.training_videos where video_source = any(p_paths)
  union
  select thumbnail_source from public.training_videos where thumbnail_source = any(p_paths)
  union
  select a->>'source'
    from public.training_videos v,
      jsonb_array_elements(case when jsonb_typeof(v.attachments) = 'array' then v.attachments else '[]'::jsonb end) a
   where a->>'source' = any(p_paths)
  union
  select object_path from public.data_exports where object_path = any(p_paths)
  union
  select object_path from public.patient_data_exports where object_path = any(p_paths)
  union
  select object_path from public.training_media_cleanup where object_path = any(p_paths)
  union
  select bf.staging_object_path
    from public.patient_bloodwork_files bf
    join public.patient_bloodwork_reports br on br.id = bf.report_id and br.patient_id = bf.patient_id
   where br.lifecycle_status = 'staging' and bf.staging_object_path = any(p_paths)
  union
  select bf.object_path
    from public.patient_bloodwork_files bf
    join public.patient_bloodwork_reports br on br.id = bf.report_id and br.patient_id = bf.patient_id
   where br.lifecycle_status = 'committed' and bf.object_path = any(p_paths)
$$;

create or replace function public.storage_ledger_paths(p_prefix text, p_after text, p_limit integer)
returns table(object_path text, source text, missing boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  select * from (
    select pm.object_path, 'patient_media'::text as source, pm.object_missing_at is not null as missing
      from public.patient_media pm
    union all
    select pp.object_path, 'patient_progress_photos', false from public.patient_progress_photos pp
    union all
    select cf.photo_path, 'patient_custom_foods', false from public.patient_custom_foods cf where cf.photo_path is not null
    union all
    select sr.photo_path, 'patient_saved_recipes', false from public.patient_saved_recipes sr where sr.photo_path is not null
    union all
    select m.photo->>'path', 'patient_chat_messages', false from public.patient_chat_messages m where m.photo->>'path' is not null
    union all
    select hf.object_path, 'hq_private_files', hf.object_missing_at is not null from public.hq_private_files hf
    union all
    select kd.object_path, 'knowledge_documents', kd.object_missing_at is not null from public.knowledge_documents kd
    union all
    select tv.video_source, 'training_video', tv.video_missing_at is not null from public.training_videos tv where tv.video_source is not null
    union all
    select tv.thumbnail_source, 'training_thumbnail', tv.thumbnail_missing_at is not null from public.training_videos tv where tv.thumbnail_source is not null
    union all
    select a->>'source', 'training_attachment', false
      from public.training_videos v,
        jsonb_array_elements(case when jsonb_typeof(v.attachments) = 'array' then v.attachments else '[]'::jsonb end) a
     where a->>'source' is not null
    union all
    select de.object_path, 'data_exports', de.object_missing_at is not null from public.data_exports de where de.object_path is not null
    union all
    select pe.object_path, 'patient_data_exports', pe.object_missing_at is not null from public.patient_data_exports pe where pe.object_path is not null
    union all
    select mc.object_path, 'training_media_cleanup', false from public.training_media_cleanup mc
    union all
    select bf.staging_object_path, 'patient_bloodwork_staging', false
      from public.patient_bloodwork_files bf
      join public.patient_bloodwork_reports br on br.id = bf.report_id and br.patient_id = bf.patient_id
     where br.lifecycle_status = 'staging'
    union all
    select bf.object_path, 'patient_bloodwork_file', false
      from public.patient_bloodwork_files bf
      join public.patient_bloodwork_reports br on br.id = bf.report_id and br.patient_id = bf.patient_id
     where br.lifecycle_status = 'committed' and bf.object_path is not null
  ) ledger
  where ledger.object_path like p_prefix || '%'
    and (p_after is null or ledger.object_path > p_after)
  order by ledger.object_path
  limit greatest(coalesce(p_limit, 500), 1)
$$;

revoke all on function public.storage_referenced_paths(text[]) from public, anon, authenticated;
grant execute on function public.storage_referenced_paths(text[]) to service_role;
revoke all on function public.storage_ledger_paths(text, text, integer) from public, anon, authenticated;
grant execute on function public.storage_ledger_paths(text, text, integer) to service_role;

-- The safe invitation reconciliation cannot reassign paths containing the
-- duplicate patient UUID. Include bloodwork staging as well as committed
-- sources by treating any bloodwork file row as path-bound media.
create or replace function private.reconcile_invited_patient_duplicate(
  p_canonical_patient_id uuid,
  p_duplicate_patient_id uuid,
  p_reason text,
  p_reviewed_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical public.patients%rowtype;
  duplicate public.patients%rowtype;
  audit_id uuid;
  dependency record;
  moved_count bigint;
  moved jsonb := '{}'::jsonb;
  dependency_counts jsonb;
  canonical_email_key text;
  duplicate_email_key text;
  canonical_phone_key text;
  duplicate_phone_key text;
  path_bound_count bigint;
  first_lock_id uuid;
  second_lock_id uuid;
begin
  if p_canonical_patient_id = p_duplicate_patient_id then
    raise exception 'canonical and duplicate patient must differ';
  end if;
  if p_canonical_patient_id::text < p_duplicate_patient_id::text then
    first_lock_id := p_canonical_patient_id;
    second_lock_id := p_duplicate_patient_id;
  else
    first_lock_id := p_duplicate_patient_id;
    second_lock_id := p_canonical_patient_id;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(first_lock_id::text, 40421001)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(second_lock_id::text, 40421001)
  );
  if length(btrim(coalesce(p_reason, ''))) < 8 then
    raise exception 'an explicit review reason is required';
  end if;

  perform 1
  from public.patients
  where id in (p_canonical_patient_id, p_duplicate_patient_id)
  order by id
  for update;

  select * into canonical from public.patients where id = p_canonical_patient_id;
  select * into duplicate from public.patients where id = p_duplicate_patient_id;
  if canonical.id is null or duplicate.id is null then
    raise exception 'both patient rows must exist';
  end if;
  if canonical.archived_at is not null or duplicate.archived_at is not null then
    raise exception 'an archived patient cannot be reconciled again';
  end if;
  if canonical.auth_user_id is null or canonical.activation_status <> 'activated' then
    raise exception 'canonical patient must be activated and auth-linked';
  end if;
  if duplicate.auth_user_id is not null or duplicate.activation_status <> 'invited' then
    raise exception 'duplicate patient must be an unlinked invitation';
  end if;
  if canonical.provider_id is distinct from duplicate.provider_id then
    raise exception 'cross-office identities require manual review';
  end if;

  canonical_email_key := nullif(lower(btrim(canonical.email)), '');
  duplicate_email_key := nullif(lower(btrim(duplicate.email)), '');
  canonical_phone_key := case
    when length(regexp_replace(coalesce(canonical.phone, ''), '\D', '', 'g')) >= 10
      then right(regexp_replace(canonical.phone, '\D', '', 'g'), 10)
  end;
  duplicate_phone_key := case
    when length(regexp_replace(coalesce(duplicate.phone, ''), '\D', '', 'g')) >= 10
      then right(regexp_replace(duplicate.phone, '\D', '', 'g'), 10)
  end;
  if canonical_email_key is null or canonical_email_key is distinct from duplicate_email_key
    or canonical_phone_key is null or canonical_phone_key is distinct from duplicate_phone_key
  then raise exception 'safe reconciliation requires matching normalized email and phone'; end if;

  select
    (select count(*) from public.patient_media where patient_id = duplicate.id)
    + (select count(*) from public.patient_progress_photos where patient_id = duplicate.id)
    + (select count(*) from public.patient_custom_foods where patient_id = duplicate.id and photo_path is not null)
    + (select count(*) from public.patient_saved_recipes where patient_id = duplicate.id and photo_path is not null)
    + (select count(*) from public.patient_bloodwork_files where patient_id = duplicate.id)
  into path_bound_count;
  if path_bound_count > 0 then
    raise exception 'duplicate has patient-id-bound media and requires manual review';
  end if;

  dependency_counts := private.patient_dependency_counts(duplicate.id);
  insert into private.patient_identity_reconciliation_audit (
    canonical_patient_id,
    archived_patient_id,
    classification,
    reason,
    reviewed_by,
    canonical_before,
    archived_before,
    dependency_counts_before
  )
  values (
    canonical.id,
    duplicate.id,
    'unambiguous_invitation_duplicate',
    btrim(p_reason),
    p_reviewed_by,
    to_jsonb(canonical),
    to_jsonb(duplicate),
    dependency_counts
  )
  returning id into audit_id;

  for dependency in
    select c.table_schema, c.table_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name = 'patient_id'
    order by c.table_name
  loop
    execute format(
      'update %I.%I set patient_id = $1 where patient_id = $2',
      dependency.table_schema,
      dependency.table_name
    )
    using canonical.id, duplicate.id;
    get diagnostics moved_count = row_count;
    moved := moved || jsonb_build_object(dependency.table_name, moved_count);
  end loop;

  update public.patients
  set
    activation_status = 'disabled',
    auth_user_id = null,
    email = null,
    phone = null,
    archived_at = clock_timestamp(),
    archived_into_patient_id = canonical.id,
    identity_reconciliation_id = audit_id
  where id = duplicate.id
    and auth_user_id is null
    and activation_status = 'invited'
    and archived_at is null;
  if not found then
    raise exception 'duplicate changed during reconciliation';
  end if;

  update private.patient_identity_reconciliation_audit
  set moved_rows = moved
  where id = audit_id;

  return audit_id;
end
$$;

revoke all on function private.reconcile_invited_patient_duplicate(uuid, uuid, text, uuid)
  from public, anon, authenticated;

-- Materialize the PII-free tombstone before object deletion begins. The
-- existing row-purge RPC repeats this operation idempotently in its own
-- transaction before deleting FK-dependent rows.
create or replace function public.patient_purge_prepare_tombstone(p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req patient_deletion_requests%rowtype;
  v_patient patients%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select * into v_req from patient_deletion_requests where id = p_request_id for update;
  if not found then raise exception 'unknown deletion request'; end if;
  if v_req.status <> 'purging' then raise exception 'deletion request is not being purged'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_req.patient_id::text, 40421001));
  select * into v_patient from patients where id = v_req.patient_id for update;
  if found then
    insert into patient_tombstones (id, provider_id, requested_at, purged_at, was_activated, program_id, enrolled_on)
    values (
      v_patient.id, v_patient.provider_id, v_req.requested_at, now(),
      v_patient.activation_status = 'activated', v_patient.program_id,
      coalesce(v_patient.program_start_date::date, v_patient.created_at::date)
    )
    on conflict (id) do nothing;
  end if;
  return exists (select 1 from patient_tombstones where id = v_req.patient_id);
end
$$;
revoke all on function public.patient_purge_prepare_tombstone(uuid) from public, anon, authenticated;
grant execute on function public.patient_purge_prepare_tombstone(uuid) to service_role;

-- Re-run the shared installer after all four bloodwork tables exist.
select private.install_patient_identity_write_guards();