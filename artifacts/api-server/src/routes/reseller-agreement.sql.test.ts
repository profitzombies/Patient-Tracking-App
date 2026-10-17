/**
 * Reseller agreement date SQL, run for real.
 *
 * Boots a throwaway PostgreSQL cluster, applies the canonical migration
 * (twice: it must be re-runnable) over a mirror of the tables it touches, and
 * proves what the API relies on the database for: the agreement date column
 * exists and is nullable, the HQ create RPC takes it as an optional last
 * parameter, the update RPC only touches it under the explicit "set" flag
 * (so an older form leaves it alone while HQ can clear it), the previous
 * arities are gone, service_role is the only caller, and the owner's first
 * sign-in is backfilled on the access subscription from the history events the
 * sign-in path left. Skips loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261212000000_reseller_agreement_date.sql");
const available = ["initdb", "pg_ctl", "psql"].every((name) => spawnSync("which", [name], { stdio: "ignore" }).status === 0);
if (!available) console.warn("reseller-agreement.sql.test: PostgreSQL binaries unavailable — skipped");

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HQ_USER = uuid(1);
const SUB_SIGNED_IN = uuid(10);
const SUB_HQ_STARTED = uuid(11);
const SUB_UNTOUCHED = uuid(12);

/** The slice of the live schema the migration depends on, as the office-kind migration left it. */
const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
grant usage on schema public, auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, phone text);
create type public.app_role as enum ('hq_admin', 'provider_staff', 'patient');
create table public.profiles (id uuid primary key, role public.app_role not null);
create table public.providers (
  provider_id text primary key, provider_name text, office_name text, email text, phone text,
  address_line_1 text, address_line_2 text, city text, state text, postal_code text,
  provider_role text, plan text, onboarding_code text unique, access_disabled boolean not null default false,
  auth_user_id uuid, created_at timestamptz not null default now(),
  office_kind text not null default 'reseller' check (office_kind in ('reseller', 'software')));
create table public.team_members (id uuid primary key default gen_random_uuid(), provider_id text not null references public.providers(provider_id), email text);
create table public.hq_memberships (auth_user_id uuid, status text, department_role text);
create table public.billing_office_access_subscriptions (
  id uuid primary key default gen_random_uuid(), provider_id text not null,
  included_period_started_at timestamptz, included_period_ends_at timestamptz);
create table public.billing_office_access_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.billing_office_access_subscriptions(id) on delete cascade,
  event text not null, actor_kind text not null default 'system', created_at timestamptz not null default now());
-- The previous arities, as the office-kind migration created them (bodies irrelevant: they must be dropped).
create function public.hq_create_provider_account(uuid, text, text, text, text, text, text, text, text, text, text, text, text default 'reseller')
  returns public.providers language sql as $$ select null::public.providers $$;
create function public.hq_update_provider_account(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text default null)
  returns public.providers language sql as $$ select null::public.providers $$;

insert into public.hq_memberships values ('${HQ_USER}', 'active', 'super_admin');
insert into public.providers (provider_id, provider_name, office_name, email, phone, address_line_1, city, state, postal_code, plan)
  values ('reseller-1', 'Dr Reseller', 'Reseller Office', 'reseller@example.com', '(555) 111-1111', '1 Main St', 'Austin', 'TX', '78701', 'Core');
insert into public.billing_office_access_subscriptions (id, provider_id, included_period_started_at, included_period_ends_at) values
  ('${SUB_SIGNED_IN}', 'reseller-1', '2026-02-20T09:00:00Z', '2027-02-20T09:00:00Z'),
  ('${SUB_HQ_STARTED}', 'office-2', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'),
  ('${SUB_UNTOUCHED}', 'office-3', null, null);
insert into public.billing_office_access_events (subscription_id, event, actor_kind, created_at) values
  ('${SUB_SIGNED_IN}', 'created', 'system', '2026-02-19T09:00:00Z'),
  ('${SUB_SIGNED_IN}', 'included_period_started', 'provider', '2026-02-20T09:00:00Z'),
  ('${SUB_SIGNED_IN}', 'trial_reset', 'hq', '2026-02-25T09:00:00Z'),
  ('${SUB_SIGNED_IN}', 'included_period_started', 'provider', '2026-02-26T09:00:00Z'),
  ('${SUB_HQ_STARTED}', 'hq_included_period', 'hq', '2026-01-01T00:00:00Z');
`;

let dir = "";
let dataDir = "";
const PORT = 57_400 + (process.pid % 500);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  return JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`) || "[]") as T[];
}
const createArgs = (email: string, phone: string, tail: string) =>
  `'${HQ_USER}', 'New Office', 'Dr New', 'MD', '${email}', '${phone}', '1 Main St', null, 'Austin', 'tx', '78701', 'Core'${tail}`;
const update = (tail: string) =>
  rows<{ reseller_agreement_signed_on: string | null; office_kind: string }>(
    `select reseller_agreement_signed_on, office_kind from public.hq_update_provider_account('${HQ_USER}', 'reseller-1', 'Reseller Office', 'Dr Reseller', 'MD', 'reseller@example.com', '5551111111', '1 Main St', null, 'Austin', 'TX', '78701', 'Core'${tail})`,
  )[0];

describe.skipIf(!available)("reseller agreement date SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pgra-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"], { stdio: "ignore" });
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION, MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("adds a nullable calendar date to providers", () => {
    expect(rows<{ data_type: string; is_nullable: string }>(
      "select data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'providers' and column_name = 'reseller_agreement_signed_on'",
    )).toEqual([{ data_type: "date", is_nullable: "YES" }]);
    expect(psql("select reseller_agreement_signed_on is null from public.providers where provider_id = 'reseller-1'")).toBe("t");
  });

  it("creates accounts with or without the date, as an optional last parameter", () => {
    const dated = rows<{ reseller_agreement_signed_on: string | null }>(`select reseller_agreement_signed_on from public.hq_create_provider_account(${createArgs("a@new.example.com", "5553000001", ", 'reseller', '2026-01-15'")})`);
    expect(dated[0].reseller_agreement_signed_on).toBe("2026-01-15");
    const kindOnly = rows<{ reseller_agreement_signed_on: string | null; office_kind: string }>(`select reseller_agreement_signed_on, office_kind from public.hq_create_provider_account(${createArgs("b@new.example.com", "5553000002", ", 'software'")})`);
    expect(kindOnly[0]).toEqual({ reseller_agreement_signed_on: null, office_kind: "software" });
    const defaulted = rows<{ reseller_agreement_signed_on: string | null; office_kind: string }>(`select reseller_agreement_signed_on, office_kind from public.hq_create_provider_account(${createArgs("c@new.example.com", "5553000003", "")})`);
    expect(defaulted[0]).toEqual({ reseller_agreement_signed_on: null, office_kind: "reseller" });
    expect(() => psql(`select public.hq_create_provider_account(${createArgs("d@new.example.com", "5553000004", ", 'reseller', 'not a date'")})`)).toThrow(/date/);
  });

  it("updates touch the date only under the explicit set flag, so older forms leave it alone and HQ can clear it", () => {
    expect(update("").reseller_agreement_signed_on).toBeNull();
    expect(update(", null, '2026-01-15', true").reseller_agreement_signed_on).toBe("2026-01-15");
    // No flag (an older form) and a flag of false both keep the date.
    expect(update("").reseller_agreement_signed_on).toBe("2026-01-15");
    expect(update(", null, null, false").reseller_agreement_signed_on).toBe("2026-01-15");
    expect(update(", 'software', null, false")).toEqual({ reseller_agreement_signed_on: "2026-01-15", office_kind: "software" });
    expect(update(", 'reseller', '2026-03-01', true")).toEqual({ reseller_agreement_signed_on: "2026-03-01", office_kind: "reseller" });
    expect(update(", null, null, true").reseller_agreement_signed_on).toBeNull();
  });

  it("replaces the previous arities and keeps both RPCs service_role-only", () => {
    expect(psql("select to_regprocedure('public.hq_create_provider_account(uuid,text,text,text,text,text,text,text,text,text,text,text,text)') is null")).toBe("t");
    expect(psql("select to_regprocedure('public.hq_update_provider_account(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text)') is null")).toBe("t");
    expect(psql("select to_regprocedure('public.hq_create_provider_account(uuid,text,text,text,text,text,text,text,text,text,text,text,text,date)') is not null")).toBe("t");
    expect(psql("select to_regprocedure('public.hq_update_provider_account(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,date,boolean)') is not null")).toBe("t");
    for (const fn of ["hq_create_provider_account", "hq_update_provider_account"]) {
      expect(psql(`select count(*) from pg_proc where proname = '${fn}'`), fn).toBe("1");
      expect(psql(`select bool_or(has_function_privilege(role_name, p.oid, 'EXECUTE')) from pg_proc p, unnest(array['anon','authenticated']) role_name where p.proname = '${fn}'`), fn).toBe("f");
      expect(psql(`select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) from pg_proc p where p.proname = '${fn}'`), fn).toBe("t");
      expect(psql(`select bool_and(prosecdef) from pg_proc where proname = '${fn}'`), fn).toBe("t");
    }
  });

  it("backfills the owner's first sign-in from the first sign-in-started event only", () => {
    const backfilled = rows<{ id: string; owner_first_sign_in_at: string | null }>(
      "select id, owner_first_sign_in_at from public.billing_office_access_subscriptions order by id",
    );
    expect(backfilled).toEqual([
      // The earliest provider-actor start, not the later restart after HQ's trial reset.
      { id: SUB_SIGNED_IN, owner_first_sign_in_at: "2026-02-20T09:00:00+00:00" },
      // Started by HQ, never signed in: unknown stays unknown.
      { id: SUB_HQ_STARTED, owner_first_sign_in_at: null },
      { id: SUB_UNTOUCHED, owner_first_sign_in_at: null },
    ]);
  });
});
