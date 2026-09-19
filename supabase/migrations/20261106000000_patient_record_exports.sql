-- Staff download of one patient's full record: a new export kind whose output
-- is a set of numbered ZIP parts rather than one CSV.
--
--   * `parts` records every part the worker wrote (part number, file name,
--     object path, size, file count). `object_path` keeps pointing at part 1
--     so every existing "one path per job" consumer (missing-object marks,
--     expiry sweep, the storage ledger) still sees a path, and the ledger
--     functions below additionally list every part so storage reconciliation
--     never treats part 2+ as an orphan.
--   * Each part path stays bound to the job id, like CSV exports.

alter table public.data_exports drop constraint if exists data_exports_kind_check;
alter table public.data_exports
  add constraint data_exports_kind_check check (kind in (
    'office_comparison', 'patient_activity', 'audit_events', 'training_completion', 'provider_directory',
    'billing_transactions', 'billing_subscriptions', 'billing_payouts', 'patient_record'
  ));

-- The original inline check referenced `id`, so PostgreSQL named it
-- `data_exports_check`; drop it by definition rather than trusting the name.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.data_exports'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%/objects/exports/%'
  loop
    execute format('alter table public.data_exports drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.data_exports
  add constraint data_exports_object_path_check check (
    object_path is null or (
      (
        object_path ~ '^/objects/exports/[0-9a-f-]{36}/export-[0-9a-f-]{36}\.csv$'
        or object_path ~ '^/objects/exports/[0-9a-f-]{36}/record-part-[0-9]{2,}-[0-9a-f-]{36}\.zip$'
      )
      and split_part(object_path, '/', 4) = id::text
    )
  );

alter table public.data_exports add column if not exists parts jsonb;

-- Every part must be an object with a numbered part, a file name, an object
-- path under this job's prefix, and non-negative counts.
create or replace function public.data_export_parts_valid(p_id uuid, p_parts jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_parts is null or (
    jsonb_typeof(p_parts) = 'array'
    and jsonb_array_length(p_parts) between 1 and 500
    and not exists (
      select 1
        from jsonb_array_elements(p_parts) with ordinality as e(part, ordinal)
       where jsonb_typeof(e.part) <> 'object'
          or jsonb_typeof(e.part->'part') <> 'number'
          or (e.part->>'part')::numeric <> e.ordinal
          or coalesce(char_length(e.part->>'fileName'), 0) not between 1 and 200
          or (e.part->>'fileName') ~ '[\x00-\x1f/\\]'
          or (e.part->>'objectPath') !~ '^/objects/exports/[0-9a-f-]{36}/record-part-[0-9]{2,}-[0-9a-f-]{36}\.zip$'
          or split_part(e.part->>'objectPath', '/', 4) <> p_id::text
          or jsonb_typeof(e.part->'sizeBytes') <> 'number'
          or (e.part->>'sizeBytes')::numeric < 0
          or jsonb_typeof(e.part->'fileCount') <> 'number'
          or (e.part->>'fileCount')::numeric < 0
    )
  )
$$;

alter table public.data_exports drop constraint if exists data_exports_parts_check;
alter table public.data_exports
  add constraint data_exports_parts_check check (public.data_export_parts_valid(id, parts));

-- Multi-part exports: every part is a live reference while the row keeps it.
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
    select p->>'objectPath', 'data_exports_part', false
      from public.data_exports de,
        jsonb_array_elements(case when jsonb_typeof(de.parts) = 'array' then de.parts else '[]'::jsonb end) p
     where p->>'objectPath' is not null and p->>'objectPath' is distinct from de.object_path
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

revoke all on function public.data_export_parts_valid(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.storage_referenced_paths(text[]) from public, anon, authenticated;
grant execute on function public.storage_referenced_paths(text[]) to service_role;
revoke all on function public.storage_ledger_paths(text, text, integer) from public, anon, authenticated;
grant execute on function public.storage_ledger_paths(text, text, integer) to service_role;
