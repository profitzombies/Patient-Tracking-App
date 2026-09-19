-- Whole-office record bundle: an HQ-only export kind that packs every patient
-- record an office owns plus the office's business CSVs into numbered ZIP
-- parts. It is built by the leased `office-bundle-export` system job (one
-- office may take hours), NOT by the request-time export drain, so the
-- claim RPC must leave those rows alone.
--
--   * Parts reuse the `record-part-NN-<uuid>.zip` naming (the object-path and
--     `parts` checks already bind them to the job id).
--   * A running bundle keeps the per-file checksum list of every finished
--     part in an append-only storage sidecar (`bundle-files-NN-<uuid>.json`)
--     under the job prefix so a long job never rewrites megabytes into the
--     row. Sidecar paths ride `params.bundle.fileLists`, which the storage
--     reconciler now treats as live references; the sidecars are folded into
--     the top-level manifest and deleted once the bundle is ready.

alter table public.data_exports drop constraint if exists data_exports_kind_check;
alter table public.data_exports
  add constraint data_exports_kind_check check (kind in (
    'office_comparison', 'patient_activity', 'audit_events', 'training_completion', 'provider_directory',
    'billing_transactions', 'billing_subscriptions', 'billing_payouts', 'patient_record', 'office_bundle'
  ));

-- Bundles are HQ-only and always pinned to one office.
alter table public.data_exports drop constraint if exists data_exports_office_bundle_scope_check;
alter table public.data_exports
  add constraint data_exports_office_bundle_scope_check check (
    kind <> 'office_bundle' or (requester_kind = 'hq' and provider_id is not null)
  );

-- Worker claim: unchanged apart from skipping bundle rows (the system job
-- claims those itself under its lease). Keeps security definer + grants.
create or replace function public.claim_next_data_export()
returns setof public.data_exports language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  return query
  update data_exports x
  set status = 'running', started_at = now(), attempts = x.attempts + 1
  where x.id = (
    select q.id from data_exports q
    where q.status = 'queued' and q.expires_at > now() and q.kind <> 'office_bundle'
    order by q.created_at
    for update skip locked
    limit 1
  )
  returning x.*;
end;
$$;
revoke all on function public.claim_next_data_export() from public, anon, authenticated;
grant execute on function public.claim_next_data_export() to service_role;

-- Storage reconciler: bundle file-list sidecars are live references.
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
  select p->>'objectPath'
    from public.data_exports de,
      jsonb_array_elements(case when jsonb_typeof(de.parts) = 'array' then de.parts else '[]'::jsonb end) p
   where p->>'objectPath' = any(p_paths)
  union
  -- Office bundle per-part file-list sidecars stay referenced while the
  -- bundle is being built (they are deleted once the bundle is ready).
  select f.value #>> '{}'
    from public.data_exports de,
      jsonb_array_elements(case when jsonb_typeof(de.params->'bundle'->'fileLists') = 'array' then de.params->'bundle'->'fileLists' else '[]'::jsonb end) f
   where de.kind = 'office_bundle' and f.value #>> '{}' = any(p_paths)
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
