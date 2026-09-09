-- Post-review lifecycle, provenance, and extraction hardening.
alter table public.patient_bloodwork_reports
  add column if not exists staging_touched_at timestamptz not null default now(),
  add column if not exists cleanup_claim_token uuid,
  add column if not exists cleanup_claim_until timestamptz;

alter table public.patient_bloodwork_files
  add constraint patient_bloodwork_files_id_report_patient_unique unique (id, report_id, patient_id);
alter table public.patient_bloodwork_files
  add constraint patient_bloodwork_files_id_report_unique unique (id, report_id);
alter table public.patient_bloodwork_files
  add constraint patient_bloodwork_files_page_count_limit check (page_count is null or page_count between 1 and 100);
alter table public.patient_bloodwork_results
  add constraint patient_bloodwork_results_id_report_patient_unique unique (id, report_id, patient_id);
alter table public.patient_bloodwork_results
  drop constraint if exists patient_bloodwork_results_source_file_id_patient_id_fkey;
alter table public.patient_bloodwork_results
  add constraint patient_bloodwork_results_source_same_report_fkey
  foreign key (source_file_id, report_id, patient_id)
  references public.patient_bloodwork_files(id, report_id, patient_id) on delete cascade;
alter table public.patient_bloodwork_corrections
  drop constraint if exists patient_bloodwork_corrections_result_id_patient_id_fkey;
alter table public.patient_bloodwork_corrections
  add constraint patient_bloodwork_corrections_result_same_report_fkey
  foreign key (result_id, report_id, patient_id)
  references public.patient_bloodwork_results(id, report_id, patient_id) on delete cascade;

create table public.patient_bloodwork_extraction_pages (
  report_id uuid not null,
  source_file_id uuid not null,
  source_page integer not null check (source_page > 0),
  results jsonb not null check (jsonb_typeof(results) = 'array' and jsonb_array_length(results) <= 200),
  created_at timestamptz not null default now(),
  primary key (report_id, source_file_id, source_page),
  foreign key (source_file_id, report_id)
    references public.patient_bloodwork_files(id, report_id) on delete cascade
);
alter table public.patient_bloodwork_extraction_pages enable row level security;
revoke all on public.patient_bloodwork_extraction_pages from public, anon, authenticated;

-- A repeated create is activity on a staging report. It obtains the same row
-- lock as cleanup/commit, so cleanup cannot invalidate a newly resumed grant.
create or replace function public.bloodwork_create_report(
  p_patient_id uuid, p_client_request_id uuid, p_title text, p_report_date date,
  p_manifest jsonb, p_manifest_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.patient_bloodwork_reports; item jsonb; n integer; k text; was_created boolean := false;
begin
  if jsonb_typeof(p_manifest) <> 'array' then raise exception 'invalid manifest'; end if;
  n := jsonb_array_length(p_manifest);
  if n < 1 or n > 10 then raise exception 'invalid manifest'; end if;
  k := case when n=1 and p_manifest->0->>'mimeType'='application/pdf' then 'pdf' else 'images' end;
  if (k='pdf' and exists(select 1 from jsonb_array_elements(p_manifest) x where x->>'mimeType'<>'application/pdf'))
    or (k='images' and exists(select 1 from jsonb_array_elements(p_manifest) x where x->>'mimeType' not in ('image/jpeg','image/png')))
  then raise exception 'invalid manifest'; end if;
  insert into public.patient_bloodwork_reports(patient_id,client_request_id,manifest_hash,title,report_date,kind)
  values(p_patient_id,p_client_request_id,p_manifest_hash,btrim(p_title),p_report_date,k)
  on conflict(patient_id,client_request_id) do nothing returning * into r;
  was_created := r.id is not null;
  if r.id is null then
    select * into r from public.patient_bloodwork_reports
      where patient_id=p_patient_id and client_request_id=p_client_request_id for update;
    if r.manifest_hash<>p_manifest_hash or r.lifecycle_status='deleted' then raise exception 'idempotency_conflict'; end if;
    if r.lifecycle_status='staging' then
      update public.patient_bloodwork_reports set staging_touched_at=clock_timestamp()
        where id=r.id returning * into r;
    end if;
  else
    for item in select value from jsonb_array_elements(p_manifest) loop
      insert into public.patient_bloodwork_files(
        id,patient_id,report_id,client_file_id,position,declared_mime_type,declared_size_bytes,staging_object_path)
      values((item->>'fileId')::uuid,p_patient_id,r.id,(item->>'clientFileId')::uuid,(item->>'position')::integer,
        item->>'mimeType',(item->>'size')::bigint,
        '/objects/patients/'||p_patient_id||'/bloodwork/staging/'||r.id||'/'||(item->>'fileId'));
    end loop;
  end if;
  return jsonb_build_object('reportId',r.id,'created',was_created);
end $$;

create or replace function public.bloodwork_commit_report(
  p_patient_id uuid,p_report_id uuid,p_files jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; f jsonb; changed integer := 0;
begin
  select * into r from public.patient_bloodwork_reports where id=p_report_id and patient_id=p_patient_id for update;
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
  if (select coalesce(sum(page_count),0) from public.patient_bloodwork_files where report_id=p_report_id)>100
    then raise exception 'too_many_pages'; end if;
  update public.patient_bloodwork_reports set lifecycle_status='committed',committed_at=now(),
    extraction_status='queued',extraction_error=null where id=p_report_id;
  return true;
end $$;

-- Claim first, then return paths from the now-tombstoned rows. Commit and
-- repeated-create serialize on the report lock and can no longer race deletion.
create or replace function public.bloodwork_claim_cleanup(
  p_staging_cutoff timestamptz,p_claim_token uuid,p_lease_seconds integer,p_limit integer
) returns table(report_id uuid,staging_object_path text,object_path text)
language plpgsql security definer set search_path='' as $$
begin
  if p_claim_token is null then raise exception 'claim token required'; end if;
  return query
  with chosen as (
    select r.id from public.patient_bloodwork_reports r
    where (r.lifecycle_status='deleted'
      or (r.lifecycle_status='staging' and r.staging_touched_at<p_staging_cutoff))
      and (r.cleanup_claim_until is null or r.cleanup_claim_until<now())
    order by r.staging_touched_at,r.id
    for update skip locked limit least(greatest(p_limit,1),50)
  ), claimed as (
    update public.patient_bloodwork_reports r set lifecycle_status='deleted',
      deleted_at=coalesce(r.deleted_at,now()),cleanup_claim_token=p_claim_token,
      cleanup_claim_until=now()+make_interval(secs=>least(greatest(p_lease_seconds,60),3600)),
      extraction_lease_token=null,extraction_lease_until=null
    from chosen where r.id=chosen.id returning r.id
  )
  select c.id,f.staging_object_path,
    coalesce(f.object_path,'/objects/patients/'||f.patient_id||'/bloodwork/reports/'||f.report_id||'/'||f.id)
  from claimed c join public.patient_bloodwork_files f on f.report_id=c.id
  order by c.id,f.position;
end $$;

create or replace function public.bloodwork_finish_cleanup(p_report_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  delete from public.patient_bloodwork_reports
  where id=p_report_id and lifecycle_status='deleted' and cleanup_claim_token=p_claim_token
    and cleanup_claim_until>now();
  return found;
end $$;

create or replace function public.bloodwork_correct_result(
  p_patient_id uuid,p_report_id uuid,p_result_id uuid,p_expected_version integer,
  p_actor_role text,p_actor_user_id uuid,p_values jsonb
) returns setof public.patient_bloodwork_results language plpgsql security definer set search_path='' as $$
declare parent public.patient_bloodwork_reports; oldrow public.patient_bloodwork_results;
 newrow public.patient_bloodwork_results; before_json jsonb; after_json jsonb;
begin
  select * into parent from public.patient_bloodwork_reports
    where id=p_report_id and patient_id=p_patient_id for update;
  if not found or parent.lifecycle_status<>'committed' then return; end if;
  select * into oldrow from public.patient_bloodwork_results
    where id=p_result_id and report_id=p_report_id and patient_id=p_patient_id for update;
  if not found or oldrow.version<>p_expected_version then return; end if;
  before_json:=jsonb_build_object('testName',oldrow.test_name,'valueText',oldrow.value_text,'units',oldrow.units,
    'referenceRange',oldrow.reference_range,'labFlag',oldrow.lab_flag,'uncertain',oldrow.uncertain);
  after_json:=jsonb_build_object('testName',p_values->'testName','valueText',p_values->'valueText','units',p_values->'units',
    'referenceRange',p_values->'referenceRange','labFlag',p_values->'labFlag','uncertain',p_values->'uncertain');
  update public.patient_bloodwork_results set test_name=p_values->>'testName',value_text=p_values->>'valueText',
    units=p_values->>'units',reference_range=p_values->>'referenceRange',lab_flag=p_values->>'labFlag',
    uncertain=coalesce((p_values->>'uncertain')::boolean,false),version=version+1,corrected=true,updated_at=now()
  where id=p_result_id returning * into newrow;
  insert into public.patient_bloodwork_corrections(patient_id,report_id,result_id,actor_role,actor_user_id,before_values,after_values,version)
  values(p_patient_id,p_report_id,p_result_id,p_actor_role,p_actor_user_id,before_json,after_json,newrow.version);
  return next newrow;
end $$;

create or replace function public.bloodwork_renew_extraction(
  p_report_id uuid,p_lease_token uuid,p_lease_seconds integer
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_lease_token is null then return false; end if;
  update public.patient_bloodwork_reports set
    extraction_lease_until=now()+make_interval(secs=>least(greatest(p_lease_seconds,30),900))
  where id=p_report_id and lifecycle_status='committed' and extraction_status='processing'
    and extraction_lease_token=p_lease_token and extraction_lease_until>now();
  return found;
end $$;

create or replace function public.bloodwork_save_extraction_page(
  p_report_id uuid,p_lease_token uuid,p_source_file_id uuid,p_source_page integer,p_results jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports;
begin
  if p_lease_token is null or jsonb_typeof(p_results)<>'array' or jsonb_array_length(p_results)>200 then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=now() then return false; end if;
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
  return true;
end $$;

create or replace function public.bloodwork_release_extraction(p_report_id uuid,p_lease_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_lease_token is null then return false; end if;
  update public.patient_bloodwork_reports set extraction_status='queued',
    extraction_lease_token=null,extraction_lease_until=null
  where id=p_report_id and lifecycle_status='committed' and extraction_status='processing'
    and extraction_lease_token=p_lease_token and extraction_lease_until>now();
  return found;
end $$;

create or replace function public.bloodwork_complete_extraction_from_pages(
  p_report_id uuid,p_lease_token uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; expected_pages integer; saved_pages integer; result_count integer;
begin
  if p_lease_token is null then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=now() then return false; end if;
  select coalesce(sum(page_count),0) into expected_pages from public.patient_bloodwork_files where report_id=p_report_id;
  select count(*),coalesce(sum(jsonb_array_length(results)),0) into saved_pages,result_count
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
  update public.patient_bloodwork_reports set extraction_status='completed',extraction_error=null,
    extraction_lease_token=null,extraction_lease_until=null where id=p_report_id;
  delete from public.patient_bloodwork_extraction_pages where report_id=p_report_id;
  return true;
end $$;

-- Retain the original RPC signature for in-flight old workers, but require a
-- live non-null lease and use one validated set-based insert.
create or replace function public.bloodwork_complete_extraction(
  p_report_id uuid,p_lease_token uuid,p_results jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; supplied integer; inserted integer;
begin
  if p_lease_token is null or jsonb_typeof(p_results)<>'array' or jsonb_array_length(p_results)>20000 then return false; end if;
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.lifecycle_status<>'committed' or r.extraction_status<>'processing'
    or r.extraction_lease_token is null or r.extraction_lease_token<>p_lease_token
    or r.extraction_lease_until<=now()
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
  update public.patient_bloodwork_reports set extraction_status='completed',extraction_error=null,
    extraction_lease_token=null,extraction_lease_until=null where id=p_report_id;
  return true;
end $$;

create or replace function public.bloodwork_fail_extraction(p_report_id uuid,p_lease_token uuid,p_error text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_lease_token is null then return false; end if;
  update public.patient_bloodwork_reports set extraction_status='failed',extraction_error=left(p_error,200),
    extraction_lease_token=null,extraction_lease_until=null
  where id=p_report_id and lifecycle_status='committed' and extraction_status='processing'
    and extraction_lease_token=p_lease_token and extraction_lease_until>now();
  return found;
end $$;

revoke all on function public.bloodwork_claim_cleanup(timestamptz,uuid,integer,integer),
 public.bloodwork_finish_cleanup(uuid,uuid), public.bloodwork_renew_extraction(uuid,uuid,integer),
 public.bloodwork_save_extraction_page(uuid,uuid,uuid,integer,jsonb),
 public.bloodwork_release_extraction(uuid,uuid),
 public.bloodwork_complete_extraction_from_pages(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.bloodwork_claim_cleanup(timestamptz,uuid,integer,integer),
 public.bloodwork_finish_cleanup(uuid,uuid), public.bloodwork_renew_extraction(uuid,uuid,integer),
 public.bloodwork_save_extraction_page(uuid,uuid,uuid,integer,jsonb),
 public.bloodwork_release_extraction(uuid,uuid),
 public.bloodwork_complete_extraction_from_pages(uuid,uuid)
to service_role;