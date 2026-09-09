-- Private patient bloodwork metadata. Bytes remain in private object storage.
create extension if not exists pgcrypto;

create table public.patient_bloodwork_reports (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  client_request_id uuid not null,
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  report_date date,
  kind text not null check (kind in ('images','pdf')),
  lifecycle_status text not null default 'staging' check (lifecycle_status in ('staging','committed','deleted')),
  extraction_status text not null default 'queued' check (extraction_status in ('queued','processing','completed','failed')),
  extraction_error text,
  version integer not null default 1 check (version > 0),
  uploaded_at timestamptz not null default now(),
  committed_at timestamptz,
  deleted_at timestamptz,
  extraction_lease_token uuid,
  extraction_lease_until timestamptz,
  extraction_attempt integer not null default 0,
  transcription_consented_at timestamptz not null default now(),
  unique (patient_id, client_request_id),
  unique (id, patient_id)
);

create table public.patient_bloodwork_files (
  id uuid primary key,
  patient_id uuid not null,
  report_id uuid not null,
  client_file_id uuid not null,
  position integer not null check (position between 0 and 9),
  declared_mime_type text not null check (declared_mime_type in ('application/pdf','image/jpeg','image/png')),
  declared_size_bytes bigint not null check (declared_size_bytes between 1 and 20000000),
  staging_object_path text not null,
  object_path text,
  mime_type text check (mime_type in ('application/pdf','image/jpeg','image/png')),
  size_bytes bigint,
  page_count integer,
  width integer,
  height integer,
  created_at timestamptz not null default now(),
  foreign key (report_id, patient_id) references public.patient_bloodwork_reports(id, patient_id) on delete cascade,
  unique (report_id, client_file_id),
  unique (report_id, position),
  unique (id, patient_id),
  check (staging_object_path = '/objects/patients/' || patient_id || '/bloodwork/staging/' || report_id || '/' || id),
  check (object_path is null or object_path = '/objects/patients/' || patient_id || '/bloodwork/reports/' || report_id || '/' || id),
  check ((object_path is null and mime_type is null and size_bytes is null and page_count is null)
      or (object_path is not null and mime_type is not null and size_bytes between 1 and 20000000 and page_count > 0))
);

create table public.patient_bloodwork_results (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  report_id uuid not null,
  source_file_id uuid not null,
  source_page integer not null check (source_page > 0),
  position integer not null check (position >= 0),
  original_test_name text check (char_length(original_test_name) <= 500),
  original_value_text text check (char_length(original_value_text) <= 500),
  original_units text check (char_length(original_units) <= 500),
  original_reference_range text check (char_length(original_reference_range) <= 500),
  original_lab_flag text check (char_length(original_lab_flag) <= 500),
  original_uncertain boolean not null,
  test_name text check (char_length(test_name) <= 500),
  value_text text check (char_length(value_text) <= 500),
  units text check (char_length(units) <= 500),
  reference_range text check (char_length(reference_range) <= 500),
  lab_flag text check (char_length(lab_flag) <= 500),
  uncertain boolean not null,
  version integer not null default 1 check (version > 0),
  corrected boolean not null default false,
  updated_at timestamptz not null default now(),
  foreign key (report_id, patient_id) references public.patient_bloodwork_reports(id, patient_id) on delete cascade,
  foreign key (source_file_id, patient_id) references public.patient_bloodwork_files(id, patient_id) on delete cascade,
  unique (report_id, source_file_id, source_page, position),
  unique (id, patient_id)
);

create table public.patient_bloodwork_corrections (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  report_id uuid not null,
  result_id uuid not null,
  actor_role text not null check (actor_role in ('patient','provider','hq')),
  actor_user_id uuid not null,
  before_values jsonb not null,
  after_values jsonb not null,
  version integer not null check (version > 1),
  created_at timestamptz not null default now(),
  foreign key (report_id, patient_id) references public.patient_bloodwork_reports(id, patient_id) on delete cascade,
  foreign key (result_id, patient_id) references public.patient_bloodwork_results(id, patient_id) on delete cascade
);

create index patient_bloodwork_reports_history_idx
  on public.patient_bloodwork_reports(patient_id, uploaded_at desc, id desc)
  where lifecycle_status = 'committed';
create index patient_bloodwork_reports_queue_idx
  on public.patient_bloodwork_reports(extraction_status, extraction_lease_until)
  where lifecycle_status = 'committed';
create index patient_bloodwork_results_report_idx
  on public.patient_bloodwork_results(report_id, source_file_id, source_page, position);
create index patient_bloodwork_corrections_result_idx
  on public.patient_bloodwork_corrections(result_id, created_at);

alter table public.patient_bloodwork_reports enable row level security;
alter table public.patient_bloodwork_files enable row level security;
alter table public.patient_bloodwork_results enable row level security;
alter table public.patient_bloodwork_corrections enable row level security;
revoke all on public.patient_bloodwork_reports, public.patient_bloodwork_files,
  public.patient_bloodwork_results, public.patient_bloodwork_corrections
  from public, anon, authenticated;

create or replace function public.bloodwork_create_report(
  p_patient_id uuid, p_client_request_id uuid, p_title text, p_report_date date,
  p_manifest jsonb, p_manifest_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.patient_bloodwork_reports; item jsonb; n integer; k text; was_created boolean := false;
begin
  if jsonb_typeof(p_manifest) <> 'array' then raise exception 'invalid manifest'; end if;
  n := jsonb_array_length(p_manifest);
  if n < 1 or n > 10 then raise exception 'invalid manifest'; end if;
  k := case when n = 1 and p_manifest->0->>'mimeType' = 'application/pdf' then 'pdf' else 'images' end;
  if (k = 'pdf' and exists(select 1 from jsonb_array_elements(p_manifest) x where x->>'mimeType' <> 'application/pdf'))
     or (k = 'images' and exists(select 1 from jsonb_array_elements(p_manifest) x where x->>'mimeType' not in ('image/jpeg','image/png')))
  then raise exception 'invalid manifest'; end if;
  insert into public.patient_bloodwork_reports(patient_id,client_request_id,manifest_hash,title,report_date,kind)
  values(p_patient_id,p_client_request_id,p_manifest_hash,btrim(p_title),p_report_date,k)
  on conflict(patient_id,client_request_id) do nothing returning * into r;
  was_created := r.id is not null;
  if r.id is null then
    select * into r from public.patient_bloodwork_reports
      where patient_id=p_patient_id and client_request_id=p_client_request_id for update;
    if r.manifest_hash <> p_manifest_hash or r.lifecycle_status = 'deleted' then raise exception 'idempotency_conflict'; end if;
  else
    for item in select value from jsonb_array_elements(p_manifest) with ordinality m(value,ord) loop
      insert into public.patient_bloodwork_files(
        id,patient_id,report_id,client_file_id,position,declared_mime_type,declared_size_bytes,staging_object_path)
      values(
        (item->>'fileId')::uuid,p_patient_id,r.id,(item->>'clientFileId')::uuid,(item->>'position')::integer,
        item->>'mimeType',(item->>'size')::bigint,
        '/objects/patients/'||p_patient_id||'/bloodwork/staging/'||r.id||'/'||(item->>'fileId'));
    end loop;
  end if;
  return jsonb_build_object('reportId',r.id,'created',was_created);
end $$;

create or replace function public.bloodwork_commit_report(
  p_patient_id uuid, p_report_id uuid, p_files jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.patient_bloodwork_reports; f jsonb;
begin
  select * into r from public.patient_bloodwork_reports where id=p_report_id and patient_id=p_patient_id for update;
  if not found or r.lifecycle_status='deleted' then return false; end if;
  if r.lifecycle_status='committed' then return true; end if;
  if jsonb_array_length(p_files) <> (select count(*) from public.patient_bloodwork_files where report_id=p_report_id)
  then raise exception 'incomplete_commit'; end if;
  for f in select value from jsonb_array_elements(p_files) loop
    update public.patient_bloodwork_files set
      object_path=f->>'objectPath', mime_type=f->>'mimeType', size_bytes=(f->>'size')::bigint,
      page_count=(f->>'pageCount')::integer, width=(f->>'width')::integer, height=(f->>'height')::integer
    where id=(f->>'id')::uuid and report_id=p_report_id and patient_id=p_patient_id;
    if not found then raise exception 'incomplete_commit'; end if;
  end loop;
  update public.patient_bloodwork_reports set lifecycle_status='committed',committed_at=now(),
    extraction_status='queued',extraction_error=null where id=p_report_id;
  return true;
end $$;

create or replace function public.bloodwork_update_report(
  p_patient_id uuid,p_report_id uuid,p_expected_version integer,p_title text,p_report_date date
) returns setof public.patient_bloodwork_reports language sql security definer set search_path='' as $$
  update public.patient_bloodwork_reports set title=btrim(p_title),report_date=p_report_date,version=version+1
  where id=p_report_id and patient_id=p_patient_id and version=p_expected_version
    and lifecycle_status='committed' returning *;
$$;

create or replace function public.bloodwork_delete_report(
  p_patient_id uuid,p_report_id uuid,p_expected_version integer
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.patient_bloodwork_reports set lifecycle_status='deleted',deleted_at=now(),version=version+1,
    extraction_lease_token=null,extraction_lease_until=null
  where id=p_report_id and patient_id=p_patient_id and version=p_expected_version and lifecycle_status<>'deleted';
  return found;
end $$;

create or replace function public.bloodwork_correct_result(
  p_patient_id uuid,p_report_id uuid,p_result_id uuid,p_expected_version integer,
  p_actor_role text,p_actor_user_id uuid,p_values jsonb
) returns setof public.patient_bloodwork_results language plpgsql security definer set search_path='' as $$
declare oldrow public.patient_bloodwork_results; newrow public.patient_bloodwork_results; before_json jsonb; after_json jsonb;
begin
  select * into oldrow from public.patient_bloodwork_results
    where id=p_result_id and report_id=p_report_id and patient_id=p_patient_id for update;
  if not found or oldrow.version <> p_expected_version then return; end if;
  before_json := jsonb_build_object('testName',oldrow.test_name,'valueText',oldrow.value_text,'units',oldrow.units,
    'referenceRange',oldrow.reference_range,'labFlag',oldrow.lab_flag,'uncertain',oldrow.uncertain);
  after_json := jsonb_build_object('testName',p_values->'testName','valueText',p_values->'valueText','units',p_values->'units',
    'referenceRange',p_values->'referenceRange','labFlag',p_values->'labFlag','uncertain',p_values->'uncertain');
  update public.patient_bloodwork_results set
    test_name=p_values->>'testName', value_text=p_values->>'valueText', units=p_values->>'units',
    reference_range=p_values->>'referenceRange', lab_flag=p_values->>'labFlag',
    uncertain=coalesce((p_values->>'uncertain')::boolean,false), version=version+1,corrected=true,updated_at=now()
  where id=p_result_id returning * into newrow;
  insert into public.patient_bloodwork_corrections(patient_id,report_id,result_id,actor_role,actor_user_id,before_values,after_values,version)
    values(p_patient_id,p_report_id,p_result_id,p_actor_role,p_actor_user_id,before_json,after_json,newrow.version);
  return next newrow;
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
  )
  update public.patient_bloodwork_reports r set extraction_status='processing',extraction_lease_token=gen_random_uuid(),
    extraction_lease_until=now()+make_interval(secs=>least(greatest(p_lease_seconds,30),14400)),extraction_attempt=extraction_attempt+1
  from chosen where r.id=chosen.id returning r.*;
end $$;

create or replace function public.bloodwork_complete_extraction(
  p_report_id uuid,p_lease_token uuid,p_results jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.patient_bloodwork_reports; x jsonb;
begin
  select * into r from public.patient_bloodwork_reports where id=p_report_id for update;
  if not found or r.extraction_status<>'processing' or r.extraction_lease_token<>p_lease_token
    or r.lifecycle_status<>'committed' then return false; end if;
  if exists(select 1 from public.patient_bloodwork_results where report_id=p_report_id) then return false; end if;
  if jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) > 20000
  then raise exception 'invalid extraction output'; end if;
  for x in select value from jsonb_array_elements(p_results) loop
    if not exists (
      select 1 from public.patient_bloodwork_files f
      where f.id=(x->>'sourceFileId')::uuid and f.report_id=r.id and f.patient_id=r.patient_id
        and (x->>'sourcePage')::integer between 1 and f.page_count
    ) or greatest(
      char_length(coalesce(x->>'testName','')), char_length(coalesce(x->>'valueText','')),
      char_length(coalesce(x->>'units','')), char_length(coalesce(x->>'referenceRange','')),
      char_length(coalesce(x->>'labFlag',''))
    ) > 500 then raise exception 'invalid extraction output'; end if;
    insert into public.patient_bloodwork_results(
      patient_id,report_id,source_file_id,source_page,position,
      original_test_name,original_value_text,original_units,original_reference_range,original_lab_flag,original_uncertain,
      test_name,value_text,units,reference_range,lab_flag,uncertain)
    values(r.patient_id,r.id,(x->>'sourceFileId')::uuid,(x->>'sourcePage')::integer,(x->>'position')::integer,
      x->>'testName',x->>'valueText',x->>'units',x->>'referenceRange',x->>'labFlag',(x->>'uncertain')::boolean,
      x->>'testName',x->>'valueText',x->>'units',x->>'referenceRange',x->>'labFlag',(x->>'uncertain')::boolean);
  end loop;
  update public.patient_bloodwork_reports set extraction_status='completed',extraction_error=null,
    extraction_lease_token=null,extraction_lease_until=null where id=p_report_id;
  return true;
end $$;

create or replace function public.bloodwork_fail_extraction(p_report_id uuid,p_lease_token uuid,p_error text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.patient_bloodwork_reports set extraction_status='failed',extraction_error=left(p_error,200),
    extraction_lease_token=null,extraction_lease_until=null
  where id=p_report_id and extraction_status='processing' and extraction_lease_token=p_lease_token;
  return found;
end $$;

create or replace function public.bloodwork_retry_extraction(p_patient_id uuid,p_report_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.patient_bloodwork_reports set extraction_status='queued',extraction_error=null
  where id=p_report_id and patient_id=p_patient_id and lifecycle_status='committed' and extraction_status='failed'
    and not exists(select 1 from public.patient_bloodwork_results x where x.report_id=p_report_id);
  return found;
end $$;

revoke all on function public.bloodwork_create_report(uuid,uuid,text,date,jsonb,text),
 public.bloodwork_commit_report(uuid,uuid,jsonb), public.bloodwork_update_report(uuid,uuid,integer,text,date),
 public.bloodwork_delete_report(uuid,uuid,integer), public.bloodwork_correct_result(uuid,uuid,uuid,integer,text,uuid,jsonb),
 public.bloodwork_lease_extraction(integer,integer), public.bloodwork_complete_extraction(uuid,uuid,jsonb),
 public.bloodwork_fail_extraction(uuid,uuid,text), public.bloodwork_retry_extraction(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.bloodwork_create_report(uuid,uuid,text,date,jsonb,text),
 public.bloodwork_commit_report(uuid,uuid,jsonb), public.bloodwork_update_report(uuid,uuid,integer,text,date),
 public.bloodwork_delete_report(uuid,uuid,integer), public.bloodwork_correct_result(uuid,uuid,uuid,integer,text,uuid,jsonb),
 public.bloodwork_lease_extraction(integer,integer), public.bloodwork_complete_extraction(uuid,uuid,jsonb),
 public.bloodwork_fail_extraction(uuid,uuid,text), public.bloodwork_retry_extraction(uuid,uuid)
to service_role;

select private.install_patient_identity_write_guards();

do $$ begin
  if exists (
    select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name like 'patient_bloodwork_%' and c.column_name='patient_id'
      and not exists(select 1 from pg_trigger t join pg_class k on k.oid=t.tgrelid
        where k.relname=c.table_name and t.tgname='patient_identity_write_guard' and not t.tgisinternal)
  ) then raise exception 'bloodwork identity write guard missing'; end if;
end $$;