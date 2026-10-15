/**
 * Office kind SQL, run for real.
 *
 * Boots a throwaway PostgreSQL cluster, applies the canonical office-kind
 * migration over a mirror of the tables it touches, and proves what the API
 * relies on the database for: every existing office reads as a reseller, the
 * HQ account RPCs carry and validate the kind, the software settings and the
 * accepted-agreement column exist with their defaults and bounds, and
 * training fails closed for software-office staff at the row-security layer
 * (empty catalog, no office roster, caller_is_staff false, training_add_staff
 * refused) while anonymous learner previews, HQ admins and reseller staff keep
 * reading and adding. Skips loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261210000000_office_kind.sql");
const STAFF_RPC_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261211000000_office_kind_training_staff.sql");
const STAFF_RPC_BASELINE = path.resolve(here, "../../../../supabase/migrations/20260829000000_provider_account_locks.sql");
const available = ["initdb", "pg_ctl", "psql"].every((name) => spawnSync("which", [name], { stdio: "ignore" }).status === 0);
if (!available) console.warn("office-kind.sql.test: PostgreSQL binaries unavailable — skipped");

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HQ_USER = uuid(1);
const RESELLER_OWNER = uuid(2);
const RESELLER_STAFF = uuid(3);
const SOFTWARE_OWNER = uuid(4);
const SOFTWARE_STAFF = uuid(5);
const SOFTWARE_TEAM_ONLY = uuid(6);
const COURSE = uuid(50);
const MODULE = uuid(51);
const VIDEO = uuid(52);

/**
 * The slice of the live schema the migration depends on. auth.uid() reads a
 * session setting so one connection can act as any signed-in user; the
 * browser roles get the same grants the real project gives them.
 */
const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
grant usage on schema public, auth, private to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table auth.users (id uuid primary key, email text, phone text);
create type public.app_role as enum ('hq_admin', 'provider_staff', 'patient');
create table public.profiles (id uuid primary key, role public.app_role not null, provider_account_code text, display_name text);
create table public.providers (
  provider_id text primary key, provider_name text, office_name text, email text, phone text,
  address_line_1 text, address_line_2 text, city text, state text, postal_code text,
  provider_role text, plan text, onboarding_code text unique, access_disabled boolean not null default false,
  auth_user_id uuid, created_at timestamptz not null default now());
create table public.team_members (
  id uuid primary key default gen_random_uuid(), provider_id text not null references public.providers(provider_id),
  email text, auth_user_id uuid, activation_status text not null default 'active');
create table public.hq_memberships (auth_user_id uuid, status text, department_role text);
create table public.provider_account_locks (account_id text primary key);
create function private.provider_account_is_locked(p_account text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.provider_account_locks where account_id = p_account) $$;
create function private.is_hq_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'hq_admin'::public.app_role) $$;
grant execute on function private.provider_account_is_locked(text), private.is_hq_admin() to authenticated;
create table public.hq_organization_settings (id integer primary key default 1, access_included_period_days integer not null default 365,
  access_disclosure_text text not null default 'reseller disclosure');
insert into public.hq_organization_settings default values;
create table public.billing_office_access_subscriptions (id uuid primary key default gen_random_uuid(), provider_id text not null,
  disclosure_acknowledged_at timestamptz, disclosure_version integer);
create table public.training_courses (id uuid primary key, title text, status text not null default 'live');
create table public.training_modules (id uuid primary key, course_id uuid references public.training_courses(id), position integer not null default 1, published text not null default 'published');
create table public.training_subgroups (id uuid primary key, module_id uuid references public.training_modules(id), position integer not null default 1, published text not null default 'published');
create table public.training_videos (id uuid primary key, module_id uuid references public.training_modules(id), subgroup_id uuid, position integer not null default 1, published text not null default 'published');
create table public.staff_role_assignments (email text primary key, role public.app_role not null, provider_account_code text);
create table public.training_viewers (id uuid primary key default gen_random_uuid(), auth_user_id uuid, account_id text, name text,
  email text, phone text, location text, sessions integer not null default 0, is_demo boolean not null default false, created_at timestamptz not null default now());
create table public.training_completions (id uuid primary key default gen_random_uuid(), viewer_id uuid references public.training_viewers(id), video_id uuid, completed_at timestamptz);
alter table public.training_courses enable row level security;
alter table public.training_modules enable row level security;
alter table public.training_subgroups enable row level security;
alter table public.training_videos enable row level security;
alter table public.training_viewers enable row level security;
alter table public.training_completions enable row level security;
grant select on public.training_courses, public.training_modules, public.training_subgroups, public.training_videos,
  public.training_viewers, public.training_completions to anon, authenticated;
-- The policies the migration replaces, exactly as the training migrations left them.
create policy "Training courses are readable by everyone" on public.training_courses for select to anon, authenticated using (true);
create policy "Training modules are readable by everyone" on public.training_modules for select to anon, authenticated using (true);
create policy "Training subgroups are readable by everyone" on public.training_subgroups for select to anon, authenticated using (true);
create policy "Training videos are readable by everyone" on public.training_videos for select to anon, authenticated using (true);
create policy "HQ admins manage training courses" on public.training_courses for all to authenticated using (private.is_hq_admin()) with check (private.is_hq_admin());
-- Placeholders the migration fully replaces (the real bodies are in the 20260829/20260927 migrations).
create function private.caller_is_staff() returns boolean language sql stable security definer set search_path = '' as $$ select false $$;
create function private.caller_provider_account() returns text language sql stable security definer set search_path = '' as $$ select null::text $$;
create policy "Office staff read their own office roster" on public.training_viewers for select to authenticated
  using ((auth_user_id = (select auth.uid()) and private.caller_is_staff()) or (account_id is not null and account_id = private.caller_provider_account()));
create policy "Office staff read their office completions" on public.training_completions for select to authenticated
  using (exists (select 1 from public.training_viewers viewer where viewer.id = training_completions.viewer_id
    and ((viewer.auth_user_id = (select auth.uid()) and private.caller_is_staff())
      or (viewer.account_id is not null and viewer.account_id = private.caller_provider_account()))));

insert into public.providers (provider_id, provider_name, office_name, email, phone, auth_user_id) values
  ('reseller-1', 'Dr Reseller', 'Reseller Office', 'reseller@example.com', '(555) 111-1111', '${RESELLER_OWNER}'),
  ('software-1', 'Dr Software', 'Software Office', 'software@example.com', '(555) 222-2222', '${SOFTWARE_OWNER}');
insert into public.profiles (id, role, provider_account_code, display_name) values
  ('${HQ_USER}', 'hq_admin', null, 'HQ'),
  ('${RESELLER_OWNER}', 'provider_staff', 'reseller-1', 'Dr Reseller'),
  ('${RESELLER_STAFF}', 'provider_staff', 'reseller-1', 'Reseller Staff'),
  ('${SOFTWARE_OWNER}', 'provider_staff', 'software-1', 'Dr Software'),
  ('${SOFTWARE_STAFF}', 'provider_staff', 'software-1', 'Software Staff');
insert into public.team_members (provider_id, email, auth_user_id) values
  ('reseller-1', 'staff@reseller.example.com', '${RESELLER_STAFF}'),
  ('software-1', 'staff@software.example.com', '${SOFTWARE_STAFF}'),
  ('software-1', 'teamonly@software.example.com', '${SOFTWARE_TEAM_ONLY}');
insert into public.hq_memberships values ('${HQ_USER}', 'active', 'super_admin');
insert into public.training_courses (id, title) values ('${COURSE}', 'Welcome to THINNR');
insert into public.training_modules (id, course_id) values ('${MODULE}', '${COURSE}');
insert into public.training_subgroups (id, module_id) values ('${uuid(53)}', '${MODULE}');
insert into public.training_videos (id, module_id) values ('${VIDEO}', '${MODULE}');
insert into public.training_viewers (auth_user_id, account_id, name) values
  ('${RESELLER_OWNER}', 'reseller-1', 'Dr Reseller'), ('${RESELLER_STAFF}', 'reseller-1', 'Reseller Staff'),
  ('${SOFTWARE_OWNER}', 'software-1', 'Dr Software'), ('${SOFTWARE_STAFF}', 'software-1', 'Software Staff');
`;

let dir = "";
let dataDir = "";
const PORT = 56_900 + (process.pid % 500);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  return JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`) || "[]") as T[];
}
/** Run one statement as a browser role signed in as `uid` (anon when null). */
function as(uid: string | null, sql: string): string {
  const role = uid ? "authenticated" : "anon";
  const setting = uid ? `set local "test.uid" = '${uid}';` : `set local "test.uid" = '';`;
  return psql(`begin; set local role ${role}; ${setting} ${sql}; rollback;`);
}
const count = (uid: string | null, table: string) => Number(as(uid, `select count(*) from public.${table}`));
const createArgs = (email: string, phone: string, kind: string | null) =>
  `'${HQ_USER}', 'New Office', 'Dr New', 'MD', '${email}', '${phone}', '1 Main St', null, 'Austin', 'tx', '78701', 'Core'${kind === null ? "" : `, ${kind}`}`;

/** One `create or replace function <name>(…) … $$;` block plus its grant lines, cut from a migration file. */
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = sql.indexOf("\n$$;", start);
  const grants = sql.split("\n").filter((line) => /^(revoke|grant) .*\bfunction /.test(line) && line.includes(`${name}(`));
  return `${sql.slice(start, end + 4)}\n${grants.join("\n")}\n`;
}

describe.skipIf(!available)("office kind SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pgk-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"], { stdio: "ignore" });
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    // The 20260829 training_add_staff body is the baseline the new RPC
    // migration fully replaces; only that function is lifted from the file.
    const baselineFile = path.join(dir, "baseline-rpc.sql");
    writeFileSync(baselineFile, functionBody(readFileSync(STAFF_RPC_BASELINE, "utf8"), "public.training_add_staff"));
    // Applied twice: the migrations must be re-runnable.
    for (const file of [schemaFile, baselineFile, MIGRATION, MIGRATION, STAFF_RPC_MIGRATION, STAFF_RPC_MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
    psql(`update public.providers set office_kind = 'software' where provider_id = 'software-1'`);
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads every existing office as a reseller and refuses unknown kinds", () => {
    expect(psql(`select office_kind from public.providers where provider_id = 'reseller-1'`)).toBe("reseller");
    expect(psql(`select count(*) from public.providers where office_kind = 'reseller'`)).toBe("1");
    expect(() => psql(`update public.providers set office_kind = 'enterprise' where provider_id = 'reseller-1'`)).toThrow(/providers_office_kind_check/);
    expect(() => psql(`update public.providers set office_kind = null where provider_id = 'reseller-1'`)).toThrow(/not-null/);
  });

  it("creates accounts as resellers unless HQ says software, and validates the choice", () => {
    const defaulted = rows<{ office_kind: string }>(`select office_kind from public.hq_create_provider_account(${createArgs("a@new.example.com", "5553000001", null)})`);
    expect(defaulted[0].office_kind).toBe("reseller");
    const explicit = rows<{ office_kind: string }>(`select office_kind from public.hq_create_provider_account(${createArgs("b@new.example.com", "5553000002", "'software'")})`);
    expect(explicit[0].office_kind).toBe("software");
    const blank = rows<{ office_kind: string }>(`select office_kind from public.hq_create_provider_account(${createArgs("c@new.example.com", "5553000003", "''")})`);
    expect(blank[0].office_kind).toBe("reseller");
    expect(() => psql(`select public.hq_create_provider_account(${createArgs("d@new.example.com", "5553000004", "'enterprise'")})`)).toThrow(/valid office type/);
    // The old 12-argument signature is gone: a stale caller fails loudly rather than silently defaulting.
    expect(psql(`select to_regprocedure('public.hq_create_provider_account(uuid,text,text,text,text,text,text,text,text,text,text,text)') is null`)).toBe("t");
  });

  it("updates leave the kind alone unless HQ changes it", () => {
    const update = (kind: string) =>
      rows<{ office_kind: string }>(`select office_kind from public.hq_update_provider_account('${HQ_USER}', 'reseller-1', 'Reseller Office', 'Dr Reseller', 'MD', 'reseller@example.com', '5551111111', '1 Main St', null, 'Austin', 'TX', '78701', 'Core'${kind})`)[0].office_kind;
    expect(update("")).toBe("reseller");
    expect(update(", null")).toBe("reseller");
    expect(update(", 'software'")).toBe("software");
    expect(update(", null")).toBe("software");
    expect(update(", 'reseller'")).toBe("reseller");
    expect(() => update(", 'enterprise'")).toThrow(/valid office type/);
    for (const fn of ["hq_create_provider_account", "hq_update_provider_account"]) {
      expect(psql(`select bool_or(has_function_privilege(role_name, p.oid, 'EXECUTE')) from pg_proc p, unnest(array['anon','authenticated']) role_name where p.proname = '${fn}'`), fn).toBe("f");
      expect(psql(`select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) from pg_proc p where p.proname = '${fn}'`), fn).toBe("t");
      expect(psql(`select bool_and(prosecdef) from pg_proc where proname = '${fn}'`), fn).toBe("t");
    }
  });

  it("adds the software agreement, a 30-day software included period within the reseller bounds, and the accepted-agreement kind", () => {
    const settings = rows<{ days: number; text: string }>(`select access_software_included_period_days as days, access_software_agreement_text as text from public.hq_organization_settings`)[0];
    expect(settings.days).toBe(30);
    expect(settings.text).toMatch(/software agreement/i);
    expect(settings.text).not.toBe(psql(`select access_disclosure_text from public.hq_organization_settings`));
    expect(() => psql(`update public.hq_organization_settings set access_software_included_period_days = 1096`)).toThrow(/access_software_included_period_days_c/);
    expect(() => psql(`update public.hq_organization_settings set access_software_included_period_days = -1`)).toThrow(/access_software_included_period_days_c/);
    psql(`update public.hq_organization_settings set access_software_included_period_days = 0`);
    psql(`update public.hq_organization_settings set access_software_included_period_days = 30`);
    psql(`insert into public.billing_office_access_subscriptions (provider_id, disclosure_kind) values ('software-1', 'software'), ('reseller-1', 'reseller'), ('legacy', null)`);
    expect(() => psql(`insert into public.billing_office_access_subscriptions (provider_id, disclosure_kind) values ('x', 'enterprise')`)).toThrow(/disclosure_kind_check/);
  });

  it("hides the training catalog from software-office staff only", () => {
    for (const table of ["training_courses", "training_modules", "training_subgroups", "training_videos"]) {
      expect(count(null, table), `anon ${table}`).toBe(1);
      expect(count(HQ_USER, table), `hq ${table}`).toBe(1);
      expect(count(RESELLER_OWNER, table), `reseller owner ${table}`).toBe(1);
      expect(count(RESELLER_STAFF, table), `reseller staff ${table}`).toBe(1);
      expect(count(SOFTWARE_OWNER, table), `software owner ${table}`).toBe(0);
      expect(count(SOFTWARE_STAFF, table), `software staff ${table}`).toBe(0);
      // A teammate with a login but no profile row yet is still the office's.
      expect(count(SOFTWARE_TEAM_ONLY, table), `software team-only ${table}`).toBe(0);
    }
  });

  it("makes the training caller helpers answer 'not staff / no office' for software offices", () => {
    expect(as(RESELLER_STAFF, `select private.caller_is_staff()`)).toBe("t");
    expect(as(RESELLER_STAFF, `select private.caller_provider_account()`)).toBe("reseller-1");
    expect(as(HQ_USER, `select private.caller_is_staff()`)).toBe("t");
    expect(as(SOFTWARE_OWNER, `select private.caller_is_staff()`)).toBe("f");
    expect(as(SOFTWARE_STAFF, `select private.caller_is_staff()`)).toBe("f");
    expect(as(SOFTWARE_STAFF, `select coalesce(private.caller_provider_account(), '<null>')`)).toBe("<null>");
    expect(as(HQ_USER, `select private.caller_office_is_software()`)).toBe("f");
    // Anonymous learners never reach the private helpers; their catalog policy stays using(true).
    expect(() => as(null, `select private.caller_office_is_software()`)).toThrow(/permission denied/);
    // Office roster and own-row reads close with them.
    expect(count(RESELLER_STAFF, "training_viewers")).toBe(2);
    expect(count(SOFTWARE_STAFF, "training_viewers")).toBe(0);
    expect(count(SOFTWARE_OWNER, "training_viewers")).toBe(0);
    // Flipping the office back reopens everything without touching any other row.
    psql(`update public.providers set office_kind = 'reseller' where provider_id = 'software-1'`);
    expect(count(SOFTWARE_STAFF, "training_courses")).toBe(1);
    expect(count(SOFTWARE_STAFF, "training_viewers")).toBe(2);
    expect(as(SOFTWARE_STAFF, `select private.caller_provider_account()`)).toBe("software-1");
    psql(`update public.providers set office_kind = 'software' where provider_id = 'software-1'`);
    expect(count(SOFTWARE_STAFF, "training_courses")).toBe(0);
  });

  it("refuses the self-serve training roster add for software-office staff, not for HQ or resellers", () => {
    const add = (uid: string, office: string, email: string) =>
      as(uid, `select public.training_add_staff('${office}', 'New Teammate', '${email}')`);
    expect(add(RESELLER_STAFF, "reseller-1", "new1@reseller.example.com")).toContain("New Teammate");
    expect(() => add(SOFTWARE_STAFF, "software-1", "new2@software.example.com")).toThrow(/Training is not part of this office/);
    expect(() => add(SOFTWARE_OWNER, "software-1", "new3@software.example.com")).toThrow(/Training is not part of this office/);
    // The earlier refusals still come first: another office, or a locked one.
    expect(() => add(SOFTWARE_STAFF, "reseller-1", "new4@software.example.com")).toThrow(/own office/);
    psql(`insert into public.provider_account_locks values ('software-1')`);
    expect(() => add(SOFTWARE_STAFF, "software-1", "new5@software.example.com")).toThrow(/locked by THINNR/);
    psql(`delete from public.provider_account_locks where account_id = 'software-1'`);
    // HQ may still add staff to a software office (that is a login pre-approval, not Training).
    expect(add(HQ_USER, "software-1", "new6@software.example.com")).toContain("New Teammate");
    // Flipping the kind back reopens the add; the function keeps its definer + grants.
    psql(`update public.providers set office_kind = 'reseller' where provider_id = 'software-1'`);
    expect(add(SOFTWARE_STAFF, "software-1", "new7@software.example.com")).toContain("New Teammate");
    psql(`update public.providers set office_kind = 'software' where provider_id = 'software-1'`);
    expect(psql(`select prosecdef from pg_proc where proname = 'training_add_staff'`)).toBe("t");
    expect(psql(`select has_function_privilege('anon', 'public.training_add_staff(text,text,text)', 'EXECUTE')`)).toBe("f");
    expect(psql(`select has_function_privilege('authenticated', 'public.training_add_staff(text,text,text)', 'EXECUTE')`)).toBe("t");
  });
});
