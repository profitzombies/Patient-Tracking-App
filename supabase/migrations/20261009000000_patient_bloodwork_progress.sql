-- Persist bounded, non-clinical extraction progress for patient bloodwork.
-- This migration is additive and is intentionally applied after the lifecycle
-- and hardening migrations. Lease tokens and intermediate page payloads remain
-- service-role-only.

alter table public.patient_bloodwork_reports
  add column if not exists extraction_phase text not null default 'waiting',
  add column if not exists extraction_completed_pages integer not null default 0,
  add column if not exists extraction_total_pages integer not null default 0,
  add column if not exists extraction_started_at timestamptz,
  add column if not exists extraction_progress_updated_at timestamptz,
  add column if not exists extraction_completed_at timestamptz,
  add column if not exists extraction_finished_at timestamptz;

do $constraints$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patient_bloodwork_reports'::regclass
      and conname = 'patient_bloodwork_reports_extraction_phase_check'
  ) then
    alter table public.patient_bloodwork_reports
      add constraint patient_bloodwork_reports_extraction_phase_check
      check (extraction_phase in ('waiting','reading_pages','preparing_results','completed','failed'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patient_bloodwork_reports'::regclass
      and conname = 'patient_bloodwork_reports_extraction_total_pages_check'
  ) then
    alter table public.patient_bloodwork_reports
      add constraint patient_bloodwork_reports_extraction_total_pages_check
      check (extraction_total_pages between 0 and 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patient_bloodwork_reports'::regclass
      and conname = 'patient_bloodwork_reports_extraction_completed_pages_check'
  ) then
    alter table public.patient_bloodwork_reports
      add constraint patient_bloodwork_reports_extraction_completed_pages_check
      check (extraction_completed_pages between 0 and 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patient_bloodwork_reports'::regclass
      and conname = 'patient_bloodwork_reports_extraction_progress_bound_check'
  ) then
    alter table public.patient_bloodwork_reports
      add constraint patient_bloodwork_reports_extraction_progress_bound_check
      check (extraction_completed_pages <= extraction_total_pages);
  end if;
end $constraints$;

-- Existing rows predate this contract. Reconcile bounded counts from private
-- checkpoints where available; do not infer extraction timing from upload time.
with page_totals as (
  select r.id,
    coalesce((select sum(f.page_count) from public.patient_bloodwork_files f where f.report_id = r.id), 0)::integer as total_pages,
    (select count(*) from public.patient_bloodwork_extraction_pages p where p.report_id = r.id)::integer as saved_pages
  from public.patient_bloodwork_reports r
)
update public.patient_bloodwork_reports r
set extraction_total_pages = least(greatest(page_totals.total_pages, 0), 100),
    extraction_completed_pages = case
      when r.extraction_status = 'completed'
        then least(greatest(page_totals.total_pages, 0), 100)
      else least(greatest(page_totals.saved_pages, 0), least(greatest(page_totals.total_pages, 0), 100))
    end,
    extraction_phase = case r.extraction_status
      when 'processing' then 'reading_pages'
      when 'completed' then 'completed'
      when 'failed' then 'failed'
      else 'waiting'
    end
from page_totals
where r.id = page_totals.id;

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
    update public.patient_bloodwork_files set object_path=f->>'objectPath',mime_type=f->>'mimeType',
      size_bytes=(f->>'size')::bigint,page_count=(f->>'pageCount')::integer,
      width=(f->>'width')::integer,height=(f->>'height')::integer
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
    extraction_lease_token=null,extraction_lease_until=null
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
      and (extraction_status='queued' or extraction_lease_until < now())
    order by committed_at for update skip locked limit least(greatest(p_limit,1),10)
  ), leased as (
    update public.patient_bloodwork_reports r set
      extraction_status='processing',extraction_phase='reading_pages',
      extraction_lease_token=gen_random_uuid(),
      extraction_lease_until=now()+make_interval(secs=>least(greatest(p_lease_seconds,30),14400)),
      extraction_attempt=extraction_attempt+1,
      extraction_started_at=coalesce(r.extraction_started_at,now()),
      extraction_progress_updated_at=now(),
      extraction_finished_at=null
    from chosen
    where r.id=chosen.id
    returning r.*
  )
  select * from leased;
end $$;

create or replace function public.bloodwork_renew_extraction(
  p_report_id uuid,p_lease_token uuid,p_lease_seconds integer
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_lease_token is null then return false; end if;
  update public.patient_bloodwork_reports set
    extraction_lease_until=clock_timestamp()+make_interval(secs=>least(greatest(p_lease_seconds,30),900)),
    extraction_started_at=coalesce(extraction_started_at,clock_timestamp()),
    extraction_progress_updated_at=clock_timestamp()
  where id=p_report_id and lifecycle_status='committed' and extraction_status='processing'
    and extraction_lease_token=p_lease_token and extraction_lease_until>clock_timestamp();
  return found;
end $$;

create or replace function public.bloodwork_save_extraction_page(
  p_report_id uuid,p_lease_token uuid,p_source_file_id uuid,p_source_page integer,p_results jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; saved_pages integer;
begin
  if p_lease_token is null or jsonb_typeof(p_results)<>'array' or jsonb_array_length(p_results)>200 then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=clock_timestamp() then return false; end if;
  if not exists(select 1 from public.patient_bloodwork_files f where f.id=p_source_file_id
    and f.report_id=p_report_id and p_source_page between 1 and f.page_count) then return false; end if;
  if exists(select 1 from jsonb_array_elements(p_results) x where
    greatest(char_length(coalesce(x->>'testName','')),char_length(coalesce(x->>'valueText','')),
      char_length(coalesce(x->>'units','')),char_length(coalesce(x->>'referenceRange','')),
      char_length(coalesce(x->>'labFlag','')))>500
    or jsonb_typeof(x->'uncertain')<>'boolean') then return false; end if;
  insert into public.patient_bloodwork_extraction_pages(report_id,source_file_id,source_page,results)
  values(p_report_id,p_source_file_id,p_source_page,p_results)
  on conflict(report_id,source_file_id,source_page) do nothing;
  select count(*)::integer into saved_pages
  from public.patient_bloodwork_extraction_pages where report_id=p_report_id;
  update public.patient_bloodwork_reports set
    extraction_completed_pages=least(saved_pages,extraction_total_pages),
    extraction_progress_updated_at=clock_timestamp()
  where id=p_report_id;
  return true;
end $$;

create or replace function public.bloodwork_prepare_extraction(
  p_report_id uuid,p_lease_token uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; expected_pages integer; saved_pages integer;
begin
  if p_lease_token is null then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=clock_timestamp() then return false; end if;
  select coalesce(sum(page_count),0)::integer into expected_pages
  from public.patient_bloodwork_files where report_id=p_report_id;
  select count(*)::integer into saved_pages
  from public.patient_bloodwork_extraction_pages where report_id=p_report_id;
  if saved_pages<>expected_pages or exists(select 1 from public.patient_bloodwork_results where report_id=p_report_id)
  then return false; end if;
  update public.patient_bloodwork_reports set
    extraction_phase='preparing_results',
    extraction_completed_pages=least(saved_pages,extraction_total_pages),
    extraction_progress_updated_at=clock_timestamp()
  where id=p_report_id;
  return true;
end $$;

create or replace function public.bloodwork_release_extraction(p_report_id uuid,p_lease_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_lease_token is null then return false; end if;
  update public.patient_bloodwork_reports set extraction_status='queued',
    extraction_phase='waiting', extraction_lease_token=null,extraction_lease_until=null,
    extraction_progress_updated_at=clock_timestamp()
  where id=p_report_id and lifecycle_status='committed' and extraction_status='processing'
    and extraction_lease_token=p_lease_token and extraction_lease_until>clock_timestamp();
  return found;
end $$;

create or replace function public.bloodwork_complete_extraction_from_pages(
  p_report_id uuid,p_lease_token uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; expected_pages integer; saved_pages integer; result_count integer; completed_at timestamptz;
begin
  if p_lease_token is null then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_phase not in ('reading_pages','preparing_results')
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=clock_timestamp() then return false; end if;
  select coalesce(sum(page_count),0)::integer into expected_pages
  from public.patient_bloodwork_files where report_id=p_report_id;
  select count(*)::integer,coalesce(sum(jsonb_array_length(results)),0)::integer
    into saved_pages,result_count
    from public.patient_bloodwork_extraction_pages where report_id=p_report_id;
  if saved_pages<>expected_pages or result_count>20000
    or exists(select 1 from public.patient_bloodwork_results where report_id=p_report_id) then return false; end if;
  insert into public.patient_bloodwork_results(
    patient_id,report_id,source_file_id,source_page,position,
    original_test_name,original_value_text,original_units,original_reference_range,original_lab_flag,original_uncertain,
    test_name,value_text,units,reference_range,lab_flag,uncertain)
  select r.patient_id,r.id,p.source_file_id,p.source_page,
    row_number() over(order by f.position,p.source_page,x.ord)::integer-1,
    x.value->>'testName',x.value->>'valueText',x.value->>'units',x.value->>'referenceRange',x.value->>'labFlag',
    (x.value->>'uncertain')::boolean,x.value->>'testName',x.value->>'valueText',x.value->>'units',
    x.value->>'referenceRange',x.value->>'labFlag',(x.value->>'uncertain')::boolean
  from public.patient_bloodwork_extraction_pages p
  join public.patient_bloodwork_files f on f.id=p.source_file_id and f.report_id=p.report_id
  cross join lateral jsonb_array_elements(p.results) with ordinality x(value,ord)
  where p.report_id=p_report_id;
  completed_at:=clock_timestamp();
  update public.patient_bloodwork_reports set extraction_status='completed',extraction_phase='completed',
    extraction_error=null,extraction_completed_pages=expected_pages,extraction_lease_token=null,
    extraction_lease_until=null,extraction_completed_at=completed_at,extraction_finished_at=completed_at,
    extraction_progress_updated_at=completed_at where id=p_report_id;
  delete from public.patient_bloodwork_extraction_pages where report_id=p_report_id;
  return true;
end $$;

-- Retain the original RPC signature for old workers, while giving its
-- successful terminal transition the same frozen progress metadata.
create or replace function public.bloodwork_complete_extraction(
  p_report_id uuid,p_lease_token uuid,p_results jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; supplied integer; inserted integer; expected_pages integer; completed_at timestamptz;
begin
  if p_lease_token is null or jsonb_typeof(p_results)<>'array' or jsonb_array_length(p_results)>20000 then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=clock_timestamp()
    or exists(select 1 from public.patient_bloodwork_results where report_id=p_report_id) then return false; end if;
  supplied:=jsonb_array_length(p_results);
  insert into public.patient_bloodwork_results(
    patient_id,report_id,source_file_id,source_page,position,
    original_test_name,original_value_text,original_units,original_reference_range,original_lab_flag,original_uncertain,
    test_name,value_text,units,reference_range,lab_flag,uncertain)
  select r.patient_id,r.id,names.source_file_id,names.source_page,x.position,
    names.test_name,names.value_text,x.units,names.reference_range,names.lab_flag,x.uncertain,
    names.test_name,names.value_text,x.units,names.reference_range,names.lab_flag,x.uncertain
  from jsonb_to_recordset(p_results) as x(
    "sourceFileId" uuid,"sourcePage" integer,position integer,"testName" text,"valueText" text,
    units text,"referenceRange" text,"labFlag" text,uncertain boolean
  )
  join public.patient_bloodwork_files f
    on f.id=x."sourceFileId" and f.report_id=r.id and x."sourcePage" between 1 and f.page_count
  cross join lateral (select x."sourceFileId" source_file_id,x."sourcePage" source_page,
    x."testName" test_name,x."valueText" value_text,x."referenceRange" reference_range,x."labFlag" lab_flag) names
  where greatest(char_length(coalesce(x."testName",'')),char_length(coalesce(x."valueText",'')),
    char_length(coalesce(x.units,'')),char_length(coalesce(x."referenceRange",'')),
    char_length(coalesce(x."labFlag",'')))<=500;
  get diagnostics inserted=row_count;
  if inserted<>supplied then raise exception 'invalid extraction output'; end if;
  select coalesce(sum(page_count),0)::integer into expected_pages
  from public.patient_bloodwork_files where report_id=p_report_id;
  completed_at:=clock_timestamp();
  update public.patient_bloodwork_reports set extraction_status='completed',extraction_phase='completed',
    extraction_error=null,extraction_total_pages=greatest(extraction_total_pages,expected_pages),
    extraction_completed_pages=expected_pages,extraction_lease_token=null,
    extraction_lease_until=null,extraction_completed_at=completed_at,extraction_finished_at=completed_at,
    extraction_progress_updated_at=completed_at where id=p_report_id;
  return true;
end $$;

create or replace function public.bloodwork_fail_extraction(p_report_id uuid,p_lease_token uuid,p_error text)
returns boolean language plpgsql security definer set search_path='' as $$
declare failed_at timestamptz;
begin
  if p_lease_token is null then return false; end if;
  failed_at:=clock_timestamp();
  update public.patient_bloodwork_reports set extraction_status='failed',extraction_phase='failed',
    extraction_error=left(p_error,200),extraction_lease_token=null,extraction_lease_until=null,
    extraction_finished_at=failed_at,extraction_progress_updated_at=failed_at
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
    extraction_progress_updated_at=clock_timestamp()
  where id=p_report_id and patient_id=p_patient_id and lifecycle_status='committed' and extraction_status='failed'
    and not exists(select 1 from public.patient_bloodwork_results x where x.report_id=p_report_id);
  return found;
end $$;

revoke all on function public.bloodwork_prepare_extraction(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.bloodwork_prepare_extraction(uuid,uuid) to service_role;