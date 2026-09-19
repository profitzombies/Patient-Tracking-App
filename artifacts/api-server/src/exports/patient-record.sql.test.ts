/**
 * The patient-record export migration, run for real.
 *
 * Proves the constraints a fake cannot: the new kind is accepted, part paths
 * stay bound to the job id, the `parts` shape is validated, and BOTH storage
 * ledger functions list every part so reconciliation never treats part 2+ of
 * a record as an orphan. Boots a throwaway PostgreSQL cluster over a minimal
 * mirror of the referenced tables and applies the migration verbatim. Skips
 * loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261106000000_patient_record_exports.sql");
const CANCEL_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261107000000_data_export_cancellation.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("exports/patient-record.sql.test: PostgreSQL binaries not on PATH — suite skipped");

// Mirrors the live shape of data_exports (kind + object_path checks as first
// created) plus every table the storage ledger functions reference.
const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.data_exports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('office_comparison','patient_activity','audit_events','training_completion','provider_directory')),
  status text not null default 'queued' check (status in ('queued','running','ready','failed','expired')),
  requested_by uuid not null default gen_random_uuid(),
  requester_kind text not null default 'hq',
  provider_id text,
  params jsonb not null default '{}'::jsonb,
  file_name text,
  object_path text unique check (
    object_path is null or (
      object_path ~ '^/objects/exports/[0-9a-f-]{36}/export-[0-9a-f-]{36}\\.csv$'
      and split_part(object_path, '/', 4) = id::text
    )
  ),
  size_bytes bigint, row_count bigint, error text, expires_at timestamptz not null default now() + interval '1 day',
  object_missing_at timestamptz
);
create table public.patient_media (object_path text primary key, object_missing_at timestamptz);
create table public.patient_progress_photos (object_path text primary key);
create table public.patient_custom_foods (food_id text primary key, photo_path text);
create table public.patient_saved_recipes (recipe_id text primary key, photo_path text);
create table public.patient_chat_messages (id serial primary key, photo jsonb);
create table public.hq_private_files (object_path text primary key, object_missing_at timestamptz);
create table public.knowledge_documents (object_path text primary key, object_missing_at timestamptz);
create table public.training_videos (id serial primary key, video_source text, thumbnail_source text, video_missing_at timestamptz, thumbnail_missing_at timestamptz, attachments jsonb default '[]'::jsonb);
create table public.patient_data_exports (object_path text primary key, object_missing_at timestamptz);
create table public.training_media_cleanup (object_path text primary key);
create table public.patient_bloodwork_reports (id uuid primary key, patient_id uuid, lifecycle_status text);
create table public.patient_bloodwork_files (id uuid primary key, report_id uuid, patient_id uuid, object_path text, staging_object_path text);
`;

let dir = "";
let dataDir = "";
const PORT = 56_300 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];

function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}
function fails(sql: string): string {
  try {
    psql(sql);
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JOB = uuid(1);
const OTHER = uuid(2);
const part = (job: string, n: number, tag: number) => `/objects/exports/${job}/record-part-${String(n).padStart(2, "0")}-${uuid(tag)}.zip`;
const parts = (job: string) =>
  JSON.stringify([
    { part: 1, fileName: "rec_part-01-of-02.zip", objectPath: part(job, 1, 11), sizeBytes: 10, fileCount: 20 },
    { part: 2, fileName: "rec_part-02-of-02.zip", objectPath: part(job, 2, 12), sizeBytes: 20, fileCount: 3 },
  ]);

describe.skipIf(!POSTGRES_AVAILABLE)("patient record export SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pre-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION, CANCEL_MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a patient_record job whose part paths are bound to its id and rejects foreign or malformed parts", () => {
    psql(`insert into public.data_exports (id, kind, status, object_path, parts) values ('${JOB}', 'patient_record', 'ready', '${part(JOB, 1, 11)}', '${parts(JOB)}')`);
    // CSV exports are untouched.
    psql(`insert into public.data_exports (id, kind, status, object_path) values ('${OTHER}', 'audit_events', 'ready', '/objects/exports/${OTHER}/export-${uuid(21)}.csv')`);
    expect(fails(`insert into public.data_exports (kind) values ('office_bundle')`)).toContain("data_exports_kind_check");
    // object_path must be a part of THIS job.
    expect(fails(`insert into public.data_exports (id, kind, object_path) values ('${uuid(3)}', 'patient_record', '${part(JOB, 1, 31)}')`)).toContain("data_exports_object_path_check");
    // parts: another job's path, out-of-order numbering, and a slash in a file name are all rejected.
    const foreign = parts(JOB).replace(part(JOB, 2, 12), part(OTHER, 2, 12));
    expect(fails(`update public.data_exports set parts = '${foreign}' where id = '${JOB}'`)).toContain("data_exports_parts_check");
    const reordered = JSON.stringify([JSON.parse(parts(JOB))[1], JSON.parse(parts(JOB))[0]]);
    expect(fails(`update public.data_exports set parts = '${reordered}' where id = '${JOB}'`)).toContain("data_exports_parts_check");
    expect(fails(`update public.data_exports set parts = '${parts(JOB).replace("rec_part-01", "../rec_part-01")}' where id = '${JOB}'`)).toContain("data_exports_parts_check");
    expect(fails(`update public.data_exports set parts = '[]' where id = '${JOB}'`)).toContain("data_exports_parts_check");
    // Clearing parts (expiry) is fine.
    psql(`update public.data_exports set parts = null where id = '${OTHER}'`);
  });

  it("lists every part in both storage ledger functions, without double-counting part 1", () => {
    const referenced = rows<{ p: string }>(
      `select storage_referenced_paths as p from public.storage_referenced_paths(array['${part(JOB, 1, 11)}', '${part(JOB, 2, 12)}', '${part(JOB, 3, 13)}'])`,
    ).map((row) => row.p).sort();
    expect(referenced).toEqual([part(JOB, 1, 11), part(JOB, 2, 12)].sort());
    const ledger = rows<{ object_path: string; source: string; missing: boolean }>(
      `select object_path, source, missing from public.storage_ledger_paths('/objects/exports/', null, 100)`,
    );
    expect(ledger.map((row) => row.object_path)).toEqual(
      [part(JOB, 1, 11), part(JOB, 2, 12), `/objects/exports/${OTHER}/export-${uuid(21)}.csv`].sort(),
    );
    expect(ledger.find((row) => row.object_path === part(JOB, 2, 12))?.source).toBe("data_exports_part");
    expect(ledger.filter((row) => row.object_path === part(JOB, 1, 11))).toHaveLength(1);
    // Once the sweep clears the row, nothing lingers in the ledger.
    psql(`update public.data_exports set status = 'expired', object_path = null, parts = null where id = '${JOB}'`);
    expect(rows(`select object_path from public.storage_ledger_paths('/objects/exports/${JOB}/', null, 100)`)).toEqual([]);
  });

  it("admits the cancelled status and the cancel flag after the cancellation migration, still refusing unknown states", () => {
    const CANCELLED = uuid(4);
    psql(`insert into public.data_exports (id, kind, status, cancel_requested_at) values ('${CANCELLED}', 'patient_record', 'running', now())`);
    psql(`update public.data_exports set status = 'cancelled' where id = '${CANCELLED}' and status = 'running'`);
    expect(rows<{ status: string; flagged: boolean }>(`select status, cancel_requested_at is not null as flagged from public.data_exports where id = '${CANCELLED}'`)).toEqual([{ status: "cancelled", flagged: true }]);
    expect(fails(`update public.data_exports set status = 'stopped' where id = '${CANCELLED}'`)).toContain("data_exports_status_check");
    // Re-running the migration is harmless (idempotent DDL).
    expect(fails(readFileSync(CANCEL_MIGRATION, "utf8"))).toBe("");
    psql(`delete from public.data_exports where id = '${CANCELLED}'`);
  });

  it("keeps the helpers service-role only", () => {
    const grants = rows<{ grantee: string; routine_name: string }>(
      `select grantee, routine_name from information_schema.role_routine_grants
        where routine_schema = 'public' and routine_name in ('data_export_parts_valid', 'storage_referenced_paths', 'storage_ledger_paths')
          and grantee in ('anon', 'authenticated', 'public')`,
    );
    expect(grants).toEqual([]);
  });
});
