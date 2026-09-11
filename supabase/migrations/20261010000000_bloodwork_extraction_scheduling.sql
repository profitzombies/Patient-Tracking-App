-- Fair, durable scheduling metadata for bounded bloodwork extraction work.
-- A queued report itself is the durable queue: in-process prompts only make
-- it faster to pick up after a commit or continuation.

alter table public.patient_bloodwork_files
  add column if not exists content_sha256 text;

do $constraints$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patient_bloodwork_files'::regclass
      and conname = 'patient_bloodwork_files_content_sha256_check'
  ) then
    alter table public.patient_bloodwork_files
      add constraint patient_bloodwork_files_content_sha256_check
      check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $constraints$;

alter table public.patient_bloodwork_reports
  add column if not exists extraction_queue_at timestamptz;

-- Existing admitted reports did not retain a digest. Keep those rows readable
-- and processable; new commits provide one in the commit payload.
update public.patient_bloodwork_reports
set extraction_queue_at = coalesce(extraction_queue_at, extraction_started_at, committed_at, uploaded_at)
where extraction_queue_at is null;

create index if not exists patient_bloodwork_reports_fair_extraction_queue_idx
  on public.patient_bloodwork_reports(extraction_queue_at, id)
  where lifecycle_status = 'committed' and extraction_status in ('queued', 'processing');

create or replace function public.bloodwork_commit_report(
  p_patient_id uuid,p_report_id uuid,p_files jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; f jsonb; changed integer := 0; total_pages integer;
begin
  select * into r from public.patient_bloodwork_reports
  where id=p_report_id and patient_id=p_patient_id for update;
  if not found or r.lifecycle_status='deleted' then return false; end if;
  if r.lifecycle_status='committed' then return true; end if;
  if r.lifecycle_status<>'staging' or r.cleanup_claim_token is not null
    or jsonb_typeof(p_files)<>'array'
    or jsonb_array_length(p_files)<>(select count(*) from public.patient_bloodwork_files where report_id=p_report_id)
  then return false; end if;
  for f in select value from jsonb_array_elements(p_files) loop
    update public.patient_bloodwork_files set
      object_path=f->>'objectPath',mime_type=f->>'mimeType',
      size_bytes=(f->>'size')::bigint,page_count=(f->>'pageCount')::integer,
      width=(f->>'width')::integer,height=(f->>'height')::integer,
      content_sha256=nullif(f->>'sha256','')
    where id=(f->>'id')::uuid and report_id=p_report_id and patient_id=p_patient_id;
    if not found then raise exception 'incomplete_commit'; end if;
    changed := changed+1;
  end loop;
  if changed<>jsonb_array_length(p_files) then raise exception 'incomplete_commit'; end if;
  select coalesce(sum(page_count),0)::integer into total_pages
  from public.patient_bloodwork_files where report_id=p_report_id;
  if total_pages > 100 then raise exception 'too_many_pages'; end if;
  update public.patient_bloodwork_reports set
    lifecycle_status='committed',committed_at=clock_timestamp(),
    extraction_status='queued',extraction_error=null,extraction_phase='waiting',
    extraction_completed_pages=0,extraction_total_pages=total_pages,
    extraction_started_at=null,extraction_progress_updated_at=clock_timestamp(),
    extraction_completed_at=null,extraction_finished_at=null,
    extraction_lease_token=null,extraction_lease_until=null,
    extraction_queue_at=clock_timestamp()
  where id=p_report_id;
  return true;
end $$;

create or replace function public.bloodwork_lease_extraction(p_limit integer,p_lease_seconds integer)
returns setof public.patient_bloodwork_reports language plpgsql security definer set search_path='' as $$
begin
  return query
  with chosen as (
    select id from public.patient_bloodwork_reports
    where lifecycle_status='committed' and extraction_status in ('queued','processing')
      and (extraction_status='queued' or extraction_lease_until < clock_timestamp())
    -- A report released after its bounded quantum moves behind all currently
    -- eligible work. extraction_started_at is deliberately not changed.
    order by coalesce(extraction_queue_at, extraction_started_at, committed_at, uploaded_at), id
    for update skip locked limit least(greatest(p_limit,1),10)
  ), leased as (
    update public.patient_bloodwork_reports r set
      extraction_status='processing',extraction_phase='reading_pages',
      extraction_lease_token=gen_random_uuid(),
      extraction_lease_until=clock_timestamp()+make_interval(secs=>least(greatest(p_lease_seconds,30),14400)),
      extraction_attempt=extraction_attempt+1,
      extraction_started_at=coalesce(r.extraction_started_at,clock_timestamp()),
      extraction_progress_updated_at=clock_timestamp(),
      extraction_finished_at=null
    from chosen
    where r.id=chosen.id
    returning r.*
  )
  select * from leased;
end $$;

create or replace function public.bloodwork_release_extraction(p_report_id uuid,p_lease_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_lease_token is null then return false; end if;
  update public.patient_bloodwork_reports set extraction_status='queued',
    extraction_phase='waiting',extraction_lease_token=null,extraction_lease_until=null,
    extraction_queue_at=clock_timestamp(), extraction_progress_updated_at=clock_timestamp()
  where id=p_report_id and lifecycle_status='committed' and extraction_status='processing'
    and extraction_lease_token=p_lease_token and extraction_lease_until>clock_timestamp();
  return found;
end $$;

create or replace function public.bloodwork_retry_extraction(p_patient_id uuid,p_report_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare saved_pages integer;
begin
  select count(*)::integer into saved_pages
  from public.patient_bloodwork_extraction_pages where report_id=p_report_id;
  update public.patient_bloodwork_reports set extraction_status='queued',extraction_phase='waiting',
    extraction_error=null,extraction_lease_token=null,extraction_lease_until=null,
    extraction_completed_pages=least(saved_pages,extraction_total_pages),
    extraction_finished_at=null,extraction_completed_at=null,
    extraction_progress_updated_at=clock_timestamp(),extraction_queue_at=clock_timestamp()
  where id=p_report_id and patient_id=p_patient_id and lifecycle_status='committed' and extraction_status='failed'
    and not exists(select 1 from public.patient_bloodwork_results x where x.report_id=p_report_id);
  return found;
end $$;