-- A deletion request may begin while an extraction worker is waiting on the
-- renderer or model.  Treat the privacy lifecycle as authoritative: pending
-- remains cancellable grace time, while purging/failed and tombstones prohibit
-- any extraction transition.

create or replace function private.bloodwork_extraction_patient_allowed(p_patient_id uuid)
returns boolean language sql security definer set search_path='' stable as $$
  select not exists (
    select 1 from public.patient_tombstones t where t.id = p_patient_id
  ) and not exists (
    select 1 from public.patient_deletion_requests d
    where d.patient_id = p_patient_id and d.status in ('purging', 'failed')
  )
$$;
revoke all on function private.bloodwork_extraction_patient_allowed(uuid) from public, anon, authenticated;

-- All extraction mutations acquire this patient lock before a report row lock.
-- The purge-start trigger uses the same order; this is deliberately separate
-- from the row lookup so callers can re-check state after waiting.
create or replace function private.lock_bloodwork_extraction_patient(p_report_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_patient_id uuid;
begin
  select patient_id into v_patient_id
  from public.patient_bloodwork_reports where id = p_report_id;
  if found then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_patient_id::text, 40421001)
    );
  end if;
  return v_patient_id;
end $$;
revoke all on function private.lock_bloodwork_extraction_patient(uuid) from public, anon, authenticated;

-- This runs in the same transaction that starts the purge.  Locking and
-- invalidating every active report token makes a worker's next renew/save
-- return false, rather than allowing it to checkpoint after storage deletion.
create or replace function private.cancel_bloodwork_extraction_on_purge()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status = 'purging'
    and (tg_op = 'INSERT' or old.status is distinct from 'purging') then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.patient_id::text, 40421001)
    );
    update public.patient_bloodwork_reports set
      extraction_status = 'failed',
      extraction_phase = 'failed',
      extraction_error = 'PATIENT_PURGING',
      extraction_lease_token = null,
      extraction_lease_until = null,
      extraction_finished_at = clock_timestamp(),
      extraction_progress_updated_at = clock_timestamp()
    where patient_id = new.patient_id and extraction_status = 'processing';
  end if;
  return new;
end $$;
revoke all on function private.cancel_bloodwork_extraction_on_purge() from public, anon, authenticated;

drop trigger if exists patient_deletion_cancel_bloodwork_extraction on public.patient_deletion_requests;
create trigger patient_deletion_cancel_bloodwork_extraction
after insert or update of status on public.patient_deletion_requests
for each row execute function private.cancel_bloodwork_extraction_on_purge();

create or replace function public.bloodwork_lease_extraction(p_limit integer,p_lease_seconds integer)
returns setof public.patient_bloodwork_reports language plpgsql security definer set search_path='' as $$
declare
  candidate record;
  current_report public.patient_bloodwork_reports%rowtype;
  leased public.patient_bloodwork_reports%rowtype;
  claimed integer := 0;
begin
  for candidate in
    select id, patient_id from public.patient_bloodwork_reports
    where lifecycle_status='committed' and extraction_status in ('queued','processing')
      and (extraction_status='queued' or extraction_lease_until < clock_timestamp())
      and private.bloodwork_extraction_patient_allowed(patient_id)
    order by coalesce(extraction_queue_at, extraction_started_at, committed_at, uploaded_at), id
    -- Over-fetch candidates so one busy patient cannot hide a healthy report
    -- behind it; claimed below still enforces the public maximum of ten.
    limit 100
  loop
    -- Do not hold a report row lock while waiting for the patient lock: purge
    -- always takes patient → report. Skip a busy patient and let another
    -- worker/next scheduler pass revisit it.
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(candidate.patient_id::text, 40421001)
    ) then continue; end if;
    if private.bloodwork_extraction_patient_allowed(candidate.patient_id) then
      select * into current_report
      from public.patient_bloodwork_reports
      where id=candidate.id
      for update skip locked;
      if not found then continue; end if;
      update public.patient_bloodwork_reports r set
      extraction_status='processing',extraction_phase='reading_pages',
      extraction_lease_token=gen_random_uuid(),
      extraction_lease_until=clock_timestamp()+make_interval(secs=>least(greatest(p_lease_seconds,30),14400)),
      extraction_attempt=extraction_attempt+1,
      extraction_started_at=coalesce(r.extraction_started_at,clock_timestamp()),
      extraction_progress_updated_at=clock_timestamp(),
      extraction_finished_at=null
      where r.id=current_report.id and r.lifecycle_status='committed'
        and r.extraction_status in ('queued','processing')
        and (r.extraction_status='queued' or r.extraction_lease_until < clock_timestamp())
        and private.bloodwork_extraction_patient_allowed(r.patient_id)
      returning r.* into leased;
      if found then
        return next leased;
        claimed := claimed + 1;
        exit when claimed >= least(greatest(p_limit,1),10);
      end if;
    end if;
  end loop;
end $$;

create or replace function public.bloodwork_renew_extraction(
  p_report_id uuid,p_lease_token uuid,p_lease_seconds integer
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_patient_id uuid;
begin
  if p_lease_token is null then return false; end if;
  v_patient_id := private.lock_bloodwork_extraction_patient(p_report_id);
  if v_patient_id is null or not private.bloodwork_extraction_patient_allowed(v_patient_id) then return false; end if;
  update public.patient_bloodwork_reports set
    extraction_lease_until=clock_timestamp()+make_interval(secs=>least(greatest(p_lease_seconds,30),900)),
    extraction_started_at=coalesce(extraction_started_at,clock_timestamp()),
    extraction_progress_updated_at=clock_timestamp()
  where id=p_report_id and lifecycle_status='committed' and extraction_status='processing'
    and extraction_lease_token=p_lease_token and extraction_lease_until>clock_timestamp()
    and patient_id=v_patient_id and private.bloodwork_extraction_patient_allowed(patient_id);
  return found;
end $$;

create or replace function public.bloodwork_save_extraction_page(
  p_report_id uuid,p_lease_token uuid,p_source_file_id uuid,p_source_page integer,p_results jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; saved_pages integer; v_patient_id uuid;
begin
  if p_lease_token is null or jsonb_typeof(p_results)<>'array' or jsonb_array_length(p_results)>200 then return false; end if;
  v_patient_id := private.lock_bloodwork_extraction_patient(p_report_id);
  if v_patient_id is null or not private.bloodwork_extraction_patient_allowed(v_patient_id) then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=clock_timestamp()
    or r.patient_id<>v_patient_id or not private.bloodwork_extraction_patient_allowed(r.patient_id) then return false; end if;
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
declare r public.patient_bloodwork_reports; expected_pages integer; saved_pages integer; v_patient_id uuid;
begin
  if p_lease_token is null then return false; end if;
  v_patient_id := private.lock_bloodwork_extraction_patient(p_report_id);
  if v_patient_id is null or not private.bloodwork_extraction_patient_allowed(v_patient_id) then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=clock_timestamp()
    or r.patient_id<>v_patient_id or not private.bloodwork_extraction_patient_allowed(r.patient_id) then return false; end if;
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

create or replace function public.bloodwork_complete_extraction_from_pages(
  p_report_id uuid,p_lease_token uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; expected_pages integer; saved_pages integer; result_count integer; completed_at timestamptz; v_patient_id uuid;
begin
  if p_lease_token is null then return false; end if;
  v_patient_id := private.lock_bloodwork_extraction_patient(p_report_id);
  if v_patient_id is null or not private.bloodwork_extraction_patient_allowed(v_patient_id) then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_phase not in ('reading_pages','preparing_results')
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=clock_timestamp()
    or r.patient_id<>v_patient_id or not private.bloodwork_extraction_patient_allowed(r.patient_id) then return false; end if;
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

-- Retain the pre-checkpoint worker RPC with the same privacy guard.
create or replace function public.bloodwork_complete_extraction(
  p_report_id uuid,p_lease_token uuid,p_results jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; supplied integer; inserted integer; expected_pages integer; completed_at timestamptz; v_patient_id uuid;
begin
  if p_lease_token is null or jsonb_typeof(p_results)<>'array' or jsonb_array_length(p_results)>20000 then return false; end if;
  v_patient_id := private.lock_bloodwork_extraction_patient(p_report_id);
  if v_patient_id is null or not private.bloodwork_extraction_patient_allowed(v_patient_id) then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=clock_timestamp()
    or r.patient_id<>v_patient_id or not private.bloodwork_extraction_patient_allowed(r.patient_id)
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