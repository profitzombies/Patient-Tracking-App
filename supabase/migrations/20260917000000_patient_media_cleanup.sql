-- Cleanup for progress uploads that never became grid rows.
--
-- The guided/picker save is upload+finalize first, grid write second. When
-- the grid write fails, the client keeps the uploaded paths and offers a
-- retry; if the patient abandons instead, the finalized object would stay
-- on the account invisibly (a patient_media row + bytes nothing references).
-- This RPC lets the API discard the caller's own UNREFERENCED progress-kind
-- ledger rows — never a row a progress grid row points at, and never other
-- media kinds (food/recipe/chat photos are referenced by their own tables).
-- Returns the paths actually deleted so the route can clear the bytes too.

create or replace function public.patient_media_cleanup_progress(
  p_patient_id uuid,
  p_paths text[]
)
returns text[]
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_removed text[];
begin
  if p_patient_id is null then
    raise exception 'patient id is required';
  end if;

  with deleted as (
    delete from public.patient_media pm
    where pm.patient_id = p_patient_id
      and pm.kind = 'progress'
      and pm.object_path = any(coalesce(p_paths, array[]::text[]))
      and not exists (
        select 1
          from public.patient_progress_photos pp
         where pp.patient_id = p_patient_id
           and pp.object_path = pm.object_path
      )
    returning pm.object_path
  )
  select coalesce(array_agg(object_path), array[]::text[])
    into v_removed
    from deleted;

  return v_removed;
end;
$$;

revoke all on function public.patient_media_cleanup_progress(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.patient_media_cleanup_progress(uuid, text[])
  to service_role;
