/**
 * hq_patient_sign_in_metrics, run for real.
 *
 * Boots a throwaway PostgreSQL cluster, applies the canonical migration on
 * top of a minimal mirror of auth_sign_ins and patient_app_presence, and
 * asserts:
 *
 *  - only patient-realm SMS methods count as codes; staff email codes,
 *    patient email codes, signups (separate column) and claims do not;
 *  - a patient redeeming several codes in a month counts once in the distinct
 *    column and once per code in the total;
 *  - new-device codes are split out;
 *  - active patients are distinct per month from presence days;
 *  - every month in the window is present (zeros, newest first), clamped 1..24;
 *  - service-role gating and grants.
 *
 * Skips (loudly) when no PostgreSQL binaries are available.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261027000000_patient_sign_in_metrics.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("patient-sign-in-metrics.sql.test: PostgreSQL binaries not on PATH — SQL suite skipped");
}

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.auth_sign_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  realm text not null check (realm in ('patient', 'staff')),
  method text not null check (method in ('email_code', 'sms_code', 'password_sms_code', 'password_email_code', 'signup', 'claim')),
  new_device boolean not null default false,
  created_at timestamptz not null default now());
create table public.patient_app_presence (
  patient_id uuid not null, day date not null, primary key (patient_id, day));
`;

let dir = "";
let dataDir = "";
const PORT = 54_400 + (process.pid % 1000);

function psql(sql: string): string {
  return execFileSync(
    "psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: "" } },
  );
}

function rows<T = Record<string, unknown>>(sql: string, role = "service_role"): T[] {
  const out = psql(`set test.role = '${role}'; select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

interface MetricRow {
  month: string;
  sms_sign_ins: number;
  patients_with_sms_sign_in: number;
  new_device_sms_sign_ins: number;
  signups: number;
  active_patients: number;
}

function signIn(user: number, realm: string, method: string, at: string, newDevice = false) {
  psql(
    `insert into public.auth_sign_ins (user_id, realm, method, new_device, created_at) values ('${uuid(user)}', '${realm}', '${method}', ${newDevice}, '${at}'::timestamptz)`,
  );
}

function presence(patient: number, day: string) {
  psql(`insert into public.patient_app_presence (patient_id, day) values ('${uuid(patient)}', '${day}') on conflict do nothing`);
}

/** First day of the UTC month `back` months before the current one. */
function monthStart(back: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!POSTGRES_AVAILABLE)("hq_patient_sign_in_metrics (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "psm-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    execFileSync("psql", ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", schemaFile], { stdio: "ignore" });
    execFileSync("psql", ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", MIGRATION], { stdio: "inherit" });

    const thisMonth = monthStart(0);
    const lastMonth = monthStart(1);
    // This month: patient 1 redeems two SMS codes (one on a new device),
    // patient 2 one passwordless SMS code, patient 3 an email code, patient 4
    // signs up, patient 5 claims; staff 9 uses an email code.
    signIn(1, "patient", "password_sms_code", `${thisMonth}T10:00:00Z`);
    signIn(1, "patient", "password_sms_code", `${thisMonth}T12:00:00Z`, true);
    signIn(2, "patient", "sms_code", `${thisMonth}T09:00:00Z`);
    signIn(3, "patient", "password_email_code", `${thisMonth}T09:00:00Z`);
    signIn(4, "patient", "signup", `${thisMonth}T09:00:00Z`);
    signIn(5, "patient", "claim", `${thisMonth}T09:00:00Z`);
    signIn(9, "staff", "email_code", `${thisMonth}T09:00:00Z`);
    // Last month: one code.
    signIn(2, "patient", "password_sms_code", `${lastMonth}T09:00:00Z`);
    // Presence: this month patients 1, 2, 6 (patient 6 on three days); last month patient 6.
    presence(1, thisMonth);
    presence(2, thisMonth);
    presence(6, thisMonth);
    presence(6, `${thisMonth.slice(0, 8)}02`);
    presence(6, `${thisMonth.slice(0, 8)}03`);
    presence(6, lastMonth);
  });

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("counts patient SMS codes, distinct patients, new devices, signups and active patients per month", () => {
    const list = rows<MetricRow>("select * from public.hq_patient_sign_in_metrics(3)");
    expect(list).toHaveLength(3);
    expect(list.map((r) => r.month)).toEqual([monthStart(0), monthStart(1), monthStart(2)]);
    expect(list[0]).toMatchObject({
      sms_sign_ins: 3,
      patients_with_sms_sign_in: 2,
      new_device_sms_sign_ins: 1,
      signups: 1,
      active_patients: 3,
    });
    expect(list[1]).toMatchObject({ sms_sign_ins: 1, patients_with_sms_sign_in: 1, new_device_sms_sign_ins: 0, signups: 0, active_patients: 1 });
    expect(list[2]).toMatchObject({ sms_sign_ins: 0, patients_with_sms_sign_in: 0, new_device_sms_sign_ins: 0, signups: 0, active_patients: 0 });
  });

  it("clamps the window to 1..24 months and defaults to 6", () => {
    expect(rows<MetricRow>("select * from public.hq_patient_sign_in_metrics()")).toHaveLength(6);
    expect(rows<MetricRow>("select * from public.hq_patient_sign_in_metrics(0)")).toHaveLength(1);
    expect(rows<MetricRow>("select * from public.hq_patient_sign_in_metrics(99)")).toHaveLength(24);
    expect(rows<MetricRow>("select * from public.hq_patient_sign_in_metrics(null)")).toHaveLength(6);
  });

  it("is service-role only", () => {
    expect(() => rows("select * from public.hq_patient_sign_in_metrics(3)", "authenticated")).toThrow(/service role required/);
    expect(() => rows("select * from public.hq_patient_sign_in_metrics(3)", "anon")).toThrow(/service role required/);
    const grants = rows<{ grantee: string }>(
      "select grantee from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'hq_patient_sign_in_metrics' and privilege_type = 'EXECUTE'",
    ).map((g) => g.grantee);
    expect(grants).toContain("service_role");
    expect(grants).not.toContain("anon");
    expect(grants).not.toContain("authenticated");
    expect(grants).not.toContain("PUBLIC");
  });
});
