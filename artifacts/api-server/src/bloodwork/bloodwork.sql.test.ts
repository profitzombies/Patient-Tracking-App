import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync as spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = path.resolve(here, "../../../../supabase/migrations/20261006000000_patient_bloodwork.sql");
const hardening = path.resolve(here, "../../../../supabase/migrations/20261006020000_patient_bloodwork_hardening.sql");
const progress = path.resolve(here, "../../../../supabase/migrations/20261009000000_patient_bloodwork_progress.sql");
const available = ["initdb", "pg_ctl", "psql"].every((name) => spawn("which", [name]).status === 0);
if (!available) console.warn("bloodwork.sql.test: PostgreSQL binaries unavailable — skipped");

let dir = "";
let data = "";
const port = 55_300 + (process.pid % 500);
const patient = "00000000-0000-4000-8000-000000000001";
const request = "00000000-0000-4000-8000-000000000002";
const file = "00000000-0000-4000-8000-000000000003";
const clientFile = "00000000-0000-4000-8000-000000000004";
const legacyReport = "00000000-0000-4000-8000-000000000005";
const legacyFile = "00000000-0000-4000-8000-000000000006";
const legacyProcessingReport = "00000000-0000-4000-8000-000000000009";
const legacyProcessingFile = "00000000-0000-4000-8000-000000000010";
const legacyProcessingToken = "00000000-0000-4000-8000-000000000011";

function psql(sql: string): string {
  return execFileSync("psql", ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
}
function scalar(sql: string): string { return psql(`select ${sql};`).trim(); }

const schema = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema private;
create table public.patients(id uuid primary key, archived_at timestamptz);
create function private.guard_patient_dependency_write() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from public.patients where id=new.patient_id and archived_at is null)
 then raise exception 'invalid patient'; end if; return new;
end $$;
create function private.install_patient_identity_write_guards() returns integer language plpgsql as $$
declare x record; n integer:=0; begin
 for x in select table_name from information_schema.columns where table_schema='public' and column_name='patient_id'
 loop execute format('drop trigger if exists patient_identity_write_guard on public.%I',x.table_name);
 execute format('create trigger patient_identity_write_guard before insert or update of patient_id on public.%I for each row execute function private.guard_patient_dependency_write()',x.table_name); n:=n+1; end loop;
 return n; end $$;
insert into public.patients values('${patient}',null);
`;

describe.skipIf(!available)("patient bloodwork migration (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bloodwork-"));
    data = path.join(dir, "data");
    execFileSync("initdb", ["-D", data, "-U", "postgres", "--auth=trust"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", data, "-w", "-o", `-k ${dir} -p ${port} -c listen_addresses=''`,
      "-l", path.join(dir, "log"), "start"], { stdio: "ignore" });
    const setup = path.join(dir, "setup.sql");
    writeFileSync(setup, schema);
    for (const target of [setup, migration, hardening]) {
      execFileSync("psql", ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
        "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", target], { stdio: "pipe" });
    }
    psql(`insert into public.patient_bloodwork_reports(
      id,patient_id,client_request_id,manifest_hash,title,kind,lifecycle_status,extraction_status,committed_at)
      values('${legacyReport}','${patient}','00000000-0000-4000-8000-000000000007',repeat('9',64),
        'Legacy','images','committed','completed',now()-interval '2 days');
      insert into public.patient_bloodwork_files(
        id,patient_id,report_id,client_file_id,position,declared_mime_type,declared_size_bytes,
        staging_object_path,object_path,mime_type,size_bytes,page_count,width,height)
      values('${legacyFile}','${patient}','${legacyReport}','00000000-0000-4000-8000-000000000008',0,
        'image/png',10,'/objects/patients/${patient}/bloodwork/staging/${legacyReport}/${legacyFile}',
        '/objects/patients/${patient}/bloodwork/reports/${legacyReport}/${legacyFile}',
        'image/png',10,1,1,1);`);
    psql(`insert into public.patient_bloodwork_reports(
      id,patient_id,client_request_id,manifest_hash,title,kind,lifecycle_status,extraction_status,
      committed_at,extraction_lease_token,extraction_lease_until)
      values('${legacyProcessingReport}','${patient}','00000000-0000-4000-8000-000000000012',repeat('8',64),
        'Legacy in flight','images','committed','processing',now()-interval '2 days',
        '${legacyProcessingToken}',now()+interval '5 minutes');
      insert into public.patient_bloodwork_files(
        id,patient_id,report_id,client_file_id,position,declared_mime_type,declared_size_bytes,
        staging_object_path,object_path,mime_type,size_bytes,page_count,width,height)
      values('${legacyProcessingFile}','${patient}','${legacyProcessingReport}','00000000-0000-4000-8000-000000000013',0,
        'image/png',10,'/objects/patients/${patient}/bloodwork/staging/${legacyProcessingReport}/${legacyProcessingFile}',
        '/objects/patients/${patient}/bloodwork/reports/${legacyProcessingReport}/${legacyProcessingFile}',
        'image/png',10,1,1,1);`);
    execFileSync("psql", ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
      "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", progress], { stdio: "pipe" });
  }, 60_000);
  afterAll(() => {
    if (data) spawn("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("installs service-only tables and identity guards", () => {
    expect(readFileSync(migration, "utf8")).toContain("bloodwork_complete_extraction");
    expect(scalar(`count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
      where c.relname like 'patient_bloodwork_%' and t.tgname='patient_identity_write_guard'`)).toBe("4");
    expect(scalar(`has_table_privilege('authenticated','public.patient_bloodwork_results','select')`)).toBe("f");
    expect(scalar(`has_function_privilege('service_role','public.bloodwork_commit_report(uuid,uuid,jsonb)','execute')`)).toBe("t");
    expect(scalar(`has_function_privilege('service_role','public.bloodwork_prepare_extraction(uuid,uuid)','execute')`)).toBe("t");
    expect(scalar(`extraction_completed_pages from public.patient_bloodwork_reports where id='${legacyReport}'`)).toBe("1");
    expect(scalar(`extraction_started_at from public.patient_bloodwork_reports where id='${legacyReport}'`)).toBe("");
    expect(scalar(`extraction_completed_at from public.patient_bloodwork_reports where id='${legacyReport}'`)).toBe("");
    expect(scalar(`extraction_finished_at from public.patient_bloodwork_reports where id='${legacyReport}'`)).toBe("");
    const legacyCommittedAt = Date.parse(scalar(`committed_at::text from public.patient_bloodwork_reports where id='${legacyProcessingReport}'`));
    expect(scalar(`public.bloodwork_renew_extraction('${legacyProcessingReport}','${legacyProcessingToken}',300)`)).toBe("t");
    const legacyStartedAt = Date.parse(scalar(`extraction_started_at::text from public.patient_bloodwork_reports where id='${legacyProcessingReport}'`));
    expect(legacyStartedAt).toBeGreaterThan(legacyCommittedAt);
  });

  it("creates idempotently, rejects conflicting manifests, and commits atomically", () => {
    const manifest = `[{"fileId":"${file}","clientFileId":"${clientFile}","position":0,"mimeType":"image/png","size":10}]`;
    const create = `public.bloodwork_create_report('${patient}','${request}','CBC',null,'${manifest}'::jsonb,repeat('a',64))`;
    const first = scalar(`${create}->>'reportId'`);
    expect(scalar(`${create}->>'reportId'`)).toBe(first);
    expect(() => psql(`select public.bloodwork_create_report('${patient}','${request}','CBC',null,'${manifest}'::jsonb,repeat('b',64));`))
      .toThrow(/idempotency_conflict/);
    const committedPath = `/objects/patients/${patient}/bloodwork/reports/${first}/${file}`;
    const files = `[{"id":"${file}","objectPath":"${committedPath}","mimeType":"image/png","size":10,"pageCount":1,"width":1,"height":1}]`;
    expect(scalar(`public.bloodwork_commit_report('${patient}','${first}','${files}'::jsonb)`)).toBe("t");
    expect(scalar(`lifecycle_status from public.patient_bloodwork_reports where id='${first}'`)).toBe("committed");
    expect(scalar(`extraction_total_pages from public.patient_bloodwork_reports where id='${first}'`)).toBe("1");
    expect(scalar(`extraction_completed_pages from public.patient_bloodwork_reports where id='${first}'`)).toBe("0");
    expect(scalar(`count(*) from public.patient_bloodwork_files where report_id='${first}' and object_path='${committedPath}'`)).toBe("1");
    psql("select * from public.bloodwork_lease_extraction(1,300);");
    const lease = scalar(`extraction_lease_token from public.patient_bloodwork_reports where id='${first}'`);
    const extracted = `[{"sourceFileId":"${file}","sourcePage":1,"position":0,"testName":"HCG","valueText":"<5","units":"mIU/mL","referenceRange":"Negative: <5","labFlag":null,"uncertain":false}]`;
    expect(scalar(`public.bloodwork_complete_extraction('${first}','${lease}','${extracted}'::jsonb)`)).toBe("t");
    expect(scalar(`extraction_phase from public.patient_bloodwork_reports where id='${first}'`)).toBe("completed");
    expect(scalar(`extraction_completed_pages from public.patient_bloodwork_reports where id='${first}'`)).toBe("1");
    const result = scalar(`id from public.patient_bloodwork_results where report_id='${first}'`);
    const changed = `{"testName":"HCG","valueText":"Negative","units":null,"referenceRange":"Negative: <5","labFlag":null,"uncertain":true}`;
    expect(psql(`select id from public.bloodwork_correct_result('${patient}','${first}','${result}',1,'patient','${request}','${changed}'::jsonb);`).trim()).toBe(result);
    expect(scalar(`version from public.patient_bloodwork_results where id='${result}'`)).toBe("2");
    expect(scalar(`count(*) from public.patient_bloodwork_corrections where result_id='${result}' and actor_role='patient' and version=2`)).toBe("1");
    expect(scalar(`public.bloodwork_retry_extraction('${patient}','${first}')`)).toBe("f");
  });

  it("retains page checkpoints across continuation and retry until atomic completion", () => {
    const fileId = "00000000-0000-4000-8000-000000000031";
    const clientId = "00000000-0000-4000-8000-000000000032";
    const requestId = "00000000-0000-4000-8000-000000000033";
    const manifest = `[{"fileId":"${fileId}","clientFileId":"${clientId}","position":0,"mimeType":"image/png","size":10}]`;
    psql(`select public.bloodwork_create_report('${patient}','${requestId}','Batched',null,
      '${manifest}'::jsonb,repeat('e',64));`);
    const actualReport = scalar(`id from public.patient_bloodwork_reports where client_request_id='${requestId}'`);
    const destination = `/objects/patients/${patient}/bloodwork/reports/${actualReport}/${fileId}`;
    const files = `[{"id":"${fileId}","objectPath":"${destination}","mimeType":"image/png","size":10,"pageCount":3,"width":1,"height":1}]`;
    expect(scalar(`public.bloodwork_commit_report('${patient}','${actualReport}','${files}'::jsonb)`)).toBe("t");
    const lease = scalar(`extraction_lease_token from public.bloodwork_lease_extraction(1,300) where id='${actualReport}'`);
    expect(scalar(`public.bloodwork_save_extraction_page('${actualReport}','${lease}','${fileId}',1,'[]'::jsonb)`)).toBe("t");
    expect(scalar(`extraction_completed_pages from public.patient_bloodwork_reports where id='${actualReport}'`)).toBe("1");
    expect(scalar(`public.bloodwork_release_extraction('${actualReport}','${lease}')`)).toBe("t");
    expect(scalar(`extraction_completed_pages from public.patient_bloodwork_reports where id='${actualReport}'`)).toBe("1");
    const resumedLease = scalar(`extraction_lease_token from public.bloodwork_lease_extraction(1,300) where id='${actualReport}'`);
    expect(scalar(`public.bloodwork_save_extraction_page('${actualReport}','${resumedLease}','${fileId}',2,'[]'::jsonb)`)).toBe("t");
    expect(scalar(`public.bloodwork_save_extraction_page('${actualReport}','${resumedLease}','${fileId}',3,'[]'::jsonb)`)).toBe("t");
    expect(scalar(`public.bloodwork_prepare_extraction('${actualReport}','${resumedLease}')`)).toBe("t");
    expect(scalar(`extraction_phase from public.patient_bloodwork_reports where id='${actualReport}'`)).toBe("preparing_results");
    expect(scalar(`public.bloodwork_complete_extraction_from_pages('${actualReport}','${resumedLease}')`)).toBe("t");
    expect(scalar(`extraction_phase from public.patient_bloodwork_reports where id='${actualReport}'`)).toBe("completed");
    expect(scalar(`extraction_completed_pages from public.patient_bloodwork_reports where id='${actualReport}'`)).toBe("3");
    expect(scalar(`count(*) from public.patient_bloodwork_results where report_id='${actualReport}'`)).toBe("0");

    const failedReport = "00000000-0000-4000-8000-000000000040";
    const failedFile = "00000000-0000-4000-8000-000000000041";
    const failedClient = "00000000-0000-4000-8000-000000000042";
    const failedRequest = "00000000-0000-4000-8000-000000000043";
    const failedManifest = `[{"fileId":"${failedFile}","clientFileId":"${failedClient}","position":0,"mimeType":"image/png","size":10}]`;
    psql(`select public.bloodwork_create_report('${patient}','${failedRequest}','Retry',null,
      '${failedManifest}'::jsonb,repeat('f',64));`);
    const actualFailed = scalar(`id from public.patient_bloodwork_reports where client_request_id='${failedRequest}'`);
    const failedDestination = `/objects/patients/${patient}/bloodwork/reports/${actualFailed}/${failedFile}`;
    const failedFiles = `[{"id":"${failedFile}","objectPath":"${failedDestination}","mimeType":"image/png","size":10,"pageCount":2,"width":1,"height":1}]`;
    expect(scalar(`public.bloodwork_commit_report('${patient}','${actualFailed}','${failedFiles}'::jsonb)`)).toBe("t");
    const failedLease = scalar(`extraction_lease_token from public.bloodwork_lease_extraction(1,300) where id='${actualFailed}'`);
    expect(scalar(`public.bloodwork_save_extraction_page('${actualFailed}','${failedLease}','${failedFile}',1,'[]'::jsonb)`)).toBe("t");
    expect(scalar(`public.bloodwork_fail_extraction('${actualFailed}','${failedLease}','TRANSIENT')`)).toBe("t");
    expect(scalar(`extraction_completed_pages from public.patient_bloodwork_reports where id='${actualFailed}'`)).toBe("1");
    expect(scalar(`public.bloodwork_retry_extraction('${patient}','${actualFailed}')`)).toBe("t");
    expect(scalar(`extraction_completed_pages from public.patient_bloodwork_reports where id='${actualFailed}'`)).toBe("1");
    expect(scalar(`extraction_phase from public.patient_bloodwork_reports where id='${actualFailed}'`)).toBe("waiting");
  });

  it("serializes cleanup/deletion and enforces live extraction leases at maximum output", () => {
    const report = scalar(`id from public.patient_bloodwork_reports where client_request_id='${request}'`);
    const result = scalar(`id from public.patient_bloodwork_results where report_id='${report}'`);
    expect(scalar(`public.bloodwork_delete_report('${patient}','${report}',1)`)).toBe("t");
    expect(psql(`select id from public.bloodwork_correct_result('${patient}','${report}','${result}',2,'patient','${request}','{}'::jsonb);`).trim()).toBe("");

    const cleanupRequest = "00000000-0000-4000-8000-000000000010";
    const cleanupFile = "00000000-0000-4000-8000-000000000011";
    const cleanupClient = "00000000-0000-4000-8000-000000000012";
    const cleanupManifest = `[{"fileId":"${cleanupFile}","clientFileId":"${cleanupClient}","position":0,"mimeType":"image/png","size":10}]`;
    const cleanupReport = scalar(`public.bloodwork_create_report('${patient}','${cleanupRequest}','Old',null,
      '${cleanupManifest}'::jsonb,repeat('c',64))->>'reportId'`);
    psql(`update public.patient_bloodwork_reports set staging_touched_at=now()-interval '2 days' where id='${cleanupReport}'`);
    const claim = "00000000-0000-4000-8000-000000000013";
    expect(scalar(`count(*) from public.bloodwork_claim_cleanup(now()-interval '1 day','${claim}',300,1)
      where report_id='${cleanupReport}'`)).toBe("1");
    const destination = `/objects/patients/${patient}/bloodwork/reports/${cleanupReport}/${cleanupFile}`;
    const commit = `[{"id":"${cleanupFile}","objectPath":"${destination}","mimeType":"image/png","size":10,"pageCount":1,"width":1,"height":1}]`;
    expect(scalar(`public.bloodwork_commit_report('${patient}','${cleanupReport}','${commit}'::jsonb)`)).toBe("f");
    expect(() => psql(`select public.bloodwork_create_report('${patient}','${cleanupRequest}','Old',null,
      '${cleanupManifest}'::jsonb,repeat('c',64));`)).toThrow(/idempotency_conflict/);

    const maxReport = "00000000-0000-4000-8000-000000000020";
    const maxFile = "00000000-0000-4000-8000-000000000021";
    const maxLease = "00000000-0000-4000-8000-000000000022";
    psql(`insert into public.patient_bloodwork_reports(id,patient_id,client_request_id,manifest_hash,title,kind,lifecycle_status,
      extraction_status,committed_at,extraction_lease_token,extraction_lease_until)
      values('${maxReport}','${patient}','00000000-0000-4000-8000-000000000023',repeat('d',64),'Maximum','images',
      'committed','processing',now(),'${maxLease}',now()+interval '5 minutes');
      insert into public.patient_bloodwork_files(id,patient_id,report_id,client_file_id,position,declared_mime_type,
      declared_size_bytes,staging_object_path,object_path,mime_type,size_bytes,page_count,width,height)
      values('${maxFile}','${patient}','${maxReport}','00000000-0000-4000-8000-000000000024',0,'image/png',10,
      '/objects/patients/${patient}/bloodwork/staging/${maxReport}/${maxFile}',
      '/objects/patients/${patient}/bloodwork/reports/${maxReport}/${maxFile}','image/png',10,1,1,1);`);
    expect(scalar(`public.bloodwork_complete_extraction('${maxReport}',null,'[]'::jsonb)`)).toBe("f");
    expect(scalar(`public.bloodwork_renew_extraction('${maxReport}',null,300)`)).toBe("f");
    expect(scalar(`public.bloodwork_renew_extraction('${maxReport}','00000000-0000-4000-8000-000000000099',300)`)).toBe("f");
    psql(`update public.patient_bloodwork_reports set extraction_lease_until=now()-interval '1 second' where id='${maxReport}'`);
    expect(scalar(`public.bloodwork_fail_extraction('${maxReport}','${maxLease}','TIMEOUT')`)).toBe("f");
    expect(scalar(`public.bloodwork_complete_extraction('${maxReport}','${maxLease}','[]'::jsonb)`)).toBe("f");
    psql(`update public.patient_bloodwork_reports set extraction_lease_until=now()+interval '5 minutes' where id='${maxReport}'`);
    const started = Date.now();
    expect(scalar(`public.bloodwork_complete_extraction('${maxReport}','${maxLease}',
      (select jsonb_agg(jsonb_build_object('sourceFileId','${maxFile}','sourcePage',1,'position',n,
       'testName','Test','valueText',n::text,'units',null,'referenceRange',null,'labFlag',null,'uncertain',false))
       from generate_series(0,19999) n))`)).toBe("t");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(scalar(`count(*) from public.patient_bloodwork_results where report_id='${maxReport}'`)).toBe("20000");
  }, 30_000);
});