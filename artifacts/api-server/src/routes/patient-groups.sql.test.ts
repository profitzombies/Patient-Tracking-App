/**
 * Patient groups SQL, run for real.
 *
 * Boots a throwaway PostgreSQL cluster, applies the canonical migration over
 * a mirror of the tables it depends on, and proves the properties the API
 * relies on the database for: a member row can never attach a patient of one
 * office to a group of another, names are unique per office regardless of
 * case, deleting a group or a patient removes memberships, the membership
 * table joins the identity write barrier, and both tables stay service-role
 * only. (The purge path itself is proven in privacy/purge.sql.test.ts, whose
 * mirror now includes these tables.) Skips loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261201000000_patient_groups.sql");
const available = ["initdb", "pg_ctl", "psql"].every((name) => spawnSync("which", [name], { stdio: "ignore" }).status === 0);
if (!available) console.warn("patient-groups.sql.test: PostgreSQL binaries unavailable — skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
alter database postgres set test.role = 'service_role';
create table public.providers (provider_id text primary key);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  archived_at timestamptz);
create function private.guard_patient_dependency_write() returns trigger language plpgsql security definer set search_path = '' as $$
declare target_archived_at timestamptz;
begin
  select p.archived_at into target_archived_at from public.patients p where p.id = new.patient_id for key share;
  if not found then raise exception 'cannot attach data to an unknown patient'; end if;
  if target_archived_at is not null then raise exception 'cannot attach data to an archived patient'; end if;
  return new;
end; $$;
create function private.install_patient_identity_write_guards() returns integer language plpgsql security definer set search_path = '' as $$
declare dependency record; installed integer := 0;
begin
  for dependency in select c.table_schema, c.table_name from information_schema.columns c where c.table_schema = 'public' and c.column_name = 'patient_id' order by c.table_name loop
    execute format('drop trigger if exists patient_identity_write_guard on %I.%I', dependency.table_schema, dependency.table_name);
    execute format('create trigger patient_identity_write_guard before insert or update of patient_id on %I.%I for each row execute function private.guard_patient_dependency_write()', dependency.table_schema, dependency.table_name);
    installed := installed + 1;
  end loop;
  return installed;
end; $$;
insert into public.providers values ('office-1'), ('office-2');
`;

let dir = "";
let dataDir = "";
const PORT = 56_300 + (process.pid % 500);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  return JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`) || "[]") as T[];
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PATIENT = uuid(1);
const PATIENT_B = uuid(2);
const OTHER_OFFICE_PATIENT = uuid(3);
const GROUP = uuid(11);
const GROUP_2 = uuid(12);
const OTHER_GROUP = uuid(21);
const STAFF = uuid(9);
const count = (table: string, where = "true") => Number(psql(`select count(*) from public.${table} where ${where}`));

describe.skipIf(!available)("patient groups SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pgr-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"], { stdio: "ignore" });
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
    psql(`insert into public.patients (id, provider_id) values ('${PATIENT}', 'office-1'), ('${PATIENT_B}', 'office-1'), ('${OTHER_OFFICE_PATIENT}', 'office-2')`);
    psql(`insert into public.patient_groups (id, provider_id, name, description, created_by) values
      ('${GROUP}', 'office-1', 'MJH', 'Employer cohort', '${STAFF}'),
      ('${GROUP_2}', 'office-1', 'Tuesday clinic', null, '${STAFF}'),
      ('${OTHER_GROUP}', 'office-2', 'MJH', null, null)`);
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps names unique per office case-insensitively while other offices may reuse them", () => {
    expect(() => psql(`insert into public.patient_groups (provider_id, name) values ('office-1', '  mjh ')`)).toThrow(/patient_groups_provider_name_ci_idx/);
    expect(() => psql(`update public.patient_groups set name = 'TUESDAY CLINIC' where id = '${GROUP}'`)).toThrow(/patient_groups_provider_name_ci_idx/);
    expect(() => psql(`insert into public.patient_groups (provider_id, name) values ('office-1', '   ')`)).toThrow(/name_check/);
    expect(() => psql(`insert into public.patient_groups (provider_id, name, description) values ('office-1', 'Long', '')`)).toThrow(/description_check/);
    // The same name in another office is fine (seeded above) and renames within an office work.
    expect(count("patient_groups", "lower(name) = 'mjh'")).toBe(2);
    psql(`update public.patient_groups set name = 'MJH staff' where id = '${GROUP}'`);
    psql(`update public.patient_groups set name = 'MJH' where id = '${GROUP}'`);
  });

  it("refuses a member whose patient and group belong to different offices", () => {
    const add = (group: string, patient: string, office: string) =>
      psql(`insert into public.patient_group_members (group_id, patient_id, provider_id, added_by) values ('${group}', '${patient}', '${office}', '${STAFF}')`);
    add(GROUP, PATIENT, "office-1");
    add(GROUP, PATIENT_B, "office-1");
    add(GROUP_2, PATIENT, "office-1");
    // Patient of office 2 into a group of office 1, however the office column is set.
    expect(() => add(GROUP, OTHER_OFFICE_PATIENT, "office-1")).toThrow(/patient_group_members_patient_provider_fk/);
    expect(() => add(GROUP, OTHER_OFFICE_PATIENT, "office-2")).toThrow(/patient_group_members_group_provider_fk/);
    // Patient of office 1 into a group of office 2.
    expect(() => add(OTHER_GROUP, PATIENT, "office-1")).toThrow(/patient_group_members_group_provider_fk/);
    expect(() => add(OTHER_GROUP, PATIENT, "office-2")).toThrow(/patient_group_members_patient_provider_fk/);
    // Adding twice is a primary-key conflict, not a second row.
    expect(() => add(GROUP, PATIENT, "office-1")).toThrow(/patient_group_members_pkey/);
    expect(count("patient_group_members")).toBe(3);
  });

  it("joins the identity write barrier", () => {
    expect(rows<{ n: number }>(`select count(*)::int as n from pg_trigger where tgname = 'patient_identity_write_guard' and tgrelid = 'public.patient_group_members'::regclass`)[0].n).toBe(1);
    expect(() => psql(`insert into public.patient_group_members (group_id, patient_id, provider_id) values ('${GROUP}', '${uuid(77)}', 'office-1')`)).toThrow(/unknown patient/);
    psql(`update public.patients set archived_at = now() where id = '${OTHER_OFFICE_PATIENT}'`);
    expect(() => psql(`insert into public.patient_group_members (group_id, patient_id, provider_id) values ('${OTHER_GROUP}', '${OTHER_OFFICE_PATIENT}', 'office-2')`)).toThrow(/archived patient/);
  });

  it("removes memberships with their group and with their patient", () => {
    psql(`delete from public.patient_groups where id = '${GROUP_2}'`);
    expect(count("patient_group_members", `group_id = '${GROUP_2}'`)).toBe(0);
    expect(count("patient_group_members", `group_id = '${GROUP}'`)).toBe(2);
    psql(`delete from public.patients where id = '${PATIENT_B}'`);
    expect(count("patient_group_members", `patient_id = '${PATIENT_B}'`)).toBe(0);
    expect(count("patient_group_members")).toBe(1);
    // The group itself survives losing a member.
    expect(count("patient_groups", `id = '${GROUP}'`)).toBe(1);
  });

  it("keeps both tables service-role only with row security on", () => {
    for (const table of ["patient_groups", "patient_group_members"]) {
      expect(rows(`select grantee from information_schema.role_table_grants where table_name = '${table}' and grantee in ('anon','authenticated')`), table).toEqual([]);
      expect(psql(`select relrowsecurity from pg_class where relname = '${table}'`), table).toBe("t");
      expect(psql(`select has_table_privilege('service_role', 'public.${table}', 'select,insert,update,delete')`), table).toBe("t");
    }
  });
});
