/**
 * The record-access dedupe RPC, run on a real PostgreSQL.
 *
 * What a fake cannot prove: the conditional upsert opens a window exactly
 * once per actor + key per 15 minutes, re-opens after expiry, tells rival
 * callers "not recorded" with the open window's start, keeps distinct actors
 * and targets apart, and the sweep is dry-run neutral. Boots a throwaway
 * cluster with the audit ledger mirror and the canonical migration verbatim.
 * Skips loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261106000000_record_access_audit.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("record-access-audit.sql.test: PostgreSQL binaries not on PATH — suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.admin_audit_events (
  id bigint generated always as identity primary key, occurred_at timestamptz not null default now(), action text not null,
  actor_user_id uuid, actor_kind text not null, provider_id text, target_kind text, target_id text, request_id text,
  metadata jsonb not null default '{}'::jsonb);
`;

let dir = "";
let dataDir = "";
const PORT = 56_300 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];

/** Runs as the service role (one session per call, so the setting rides along). */
function psql(sql: string, role = "service_role"): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", `select set_config('test.role', '${role}', false); ${sql}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}
function rows<T = Record<string, unknown>>(sql: string, role?: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`, role);
  const lines = out.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] || "[]") as T[];
}
function scalar<T = unknown>(sql: string): T {
  return rows<{ v: T }>(`select (select ${sql}) as v`)[0].v;
}
function fails(sql: string, role?: string): string {
  try {
    psql(sql, role);
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STAFF_A = uuid(11);
const STAFF_B = uuid(12);
const PATIENT = uuid(1);

function read(actor: string, key: string, action = "patient_record_viewed", windowSeconds = 900) {
  return rows<{ recorded: boolean; window_started_at: string }>(
    `select recorded, window_started_at from public.record_admin_audit_read_event(
       '${action}', '${actor}', 'team_member', 'prov', 'patient', '${PATIENT}', 'req-1', '{"photos": 3}'::jsonb, '${key}', ${windowSeconds})`,
  )[0];
}

describe.skipIf(!POSTGRES_AVAILABLE)("record-access audit SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "raa-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the window table and both functions service-role only", () => {
    expect(scalar<boolean>(`relrowsecurity from pg_class where relname = 'admin_audit_read_windows'`)).toBe(true);
    const grants = rows<{ grantee: string }>(
      `select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'admin_audit_read_windows' and grantee in ('anon','authenticated')`,
    );
    expect(grants).toEqual([]);
    for (const sig of [
      "public.record_admin_audit_read_event(text,uuid,text,text,text,text,text,jsonb,text,integer)",
      "public.retention_trim_audit_read_windows(timestamptz,integer,boolean)",
    ]) {
      expect(scalar<boolean>(`has_function_privilege('anon', '${sig}', 'execute')`)).toBe(false);
      expect(scalar<boolean>(`has_function_privilege('service_role', '${sig}', 'execute')`)).toBe(true);
    }
    expect(fails(`select * from public.record_admin_audit_read_event('patient_record_viewed', '${STAFF_A}', 'hq', 'prov', 'patient', '${PATIENT}', null, '{}', 'k', 900)`, "authenticated"))
      .toContain("service role required");
  });

  it("records the first read, collapses repeats inside the window, and reports the open window", () => {
    const first = read(STAFF_A, "patient_record_viewed:patient:p1");
    expect(first.recorded).toBe(true);
    const again = read(STAFF_A, "patient_record_viewed:patient:p1");
    expect(again.recorded).toBe(false);
    expect(again.window_started_at).toBe(first.window_started_at);
    expect(scalar<number>(`count(*) from public.admin_audit_events where action = 'patient_record_viewed'`)).toBe(1);
    const event = rows<{ actor_user_id: string; provider_id: string; target_id: string; metadata: { photos: number }; request_id: string }>(
      `select actor_user_id, provider_id, target_id, metadata, request_id from public.admin_audit_events where action = 'patient_record_viewed'`,
    )[0];
    expect(event).toEqual({ actor_user_id: STAFF_A, provider_id: "prov", target_id: PATIENT, metadata: { photos: 3 }, request_id: "req-1" });
  });

  it("keeps distinct actors and distinct targets apart", () => {
    expect(read(STAFF_B, "patient_record_viewed:patient:p1").recorded).toBe(true);
    expect(read(STAFF_A, "bloodwork_report_opened:patient:p1:report-9", "bloodwork_report_opened").recorded).toBe(true);
    expect(read(STAFF_A, "bloodwork_report_opened:patient:p1:report-9", "bloodwork_report_opened").recorded).toBe(false);
    expect(read(STAFF_A, "bloodwork_report_opened:patient:p1:report-10", "bloodwork_report_opened").recorded).toBe(true);
    expect(scalar<number>(`count(*) from public.admin_audit_events`)).toBe(4);
    expect(scalar<number>(`count(*) from public.admin_audit_read_windows`)).toBe(4);
  });

  it("re-opens the window once it has expired and writes a fresh event", () => {
    psql(`update public.admin_audit_read_windows set window_started_at = now() - interval '16 minutes'
          where actor_user_id = '${STAFF_A}' and dedupe_key = 'patient_record_viewed:patient:p1'`);
    const reopened = read(STAFF_A, "patient_record_viewed:patient:p1");
    expect(reopened.recorded).toBe(true);
    expect(scalar<number>(`count(*) from public.admin_audit_events where action = 'patient_record_viewed' and actor_user_id = '${STAFF_A}'`)).toBe(2);
    // Still one window row per actor + key.
    expect(scalar<number>(`count(*) from public.admin_audit_read_windows where actor_user_id = '${STAFF_A}' and dedupe_key = 'patient_record_viewed:patient:p1'`)).toBe(1);
    // A shorter window honours its own length.
    psql(`update public.admin_audit_read_windows set window_started_at = now() - interval '2 minutes'
          where actor_user_id = '${STAFF_A}' and dedupe_key = 'patient_record_viewed:patient:p1'`);
    expect(read(STAFF_A, "patient_record_viewed:patient:p1", "patient_record_viewed", 60).recorded).toBe(true);
  });

  it("refuses reads without an actor, action, or dedupe key", () => {
    expect(fails(`select * from public.record_admin_audit_read_event('patient_record_viewed', null, 'hq', 'prov', 'patient', '${PATIENT}', null, '{}', 'k', 900)`)).toContain("needs an actor");
    expect(fails(`select * from public.record_admin_audit_read_event('patient_record_viewed', '${STAFF_A}', 'hq', 'prov', 'patient', '${PATIENT}', null, '{}', '', 900)`)).toContain("needs a dedupe key");
    expect(fails(`select * from public.record_admin_audit_read_event('', '${STAFF_A}', 'hq', 'prov', 'patient', '${PATIENT}', null, '{}', 'k', 900)`)).toContain("needs an action");
  });

  it("sweeps stale windows in batches and stays neutral on dry run", () => {
    psql(`update public.admin_audit_read_windows set window_started_at = now() - interval '2 days' where actor_user_id = '${STAFF_A}'`);
    const before = scalar<number>(`count(*) from public.admin_audit_read_windows`);
    const stale = scalar<number>(`count(*) from public.admin_audit_read_windows where window_started_at < now() - interval '1 day'`);
    expect(stale).toBe(3);
    expect(scalar<number>(`public.retention_trim_audit_read_windows(now() - interval '1 day', 5000, true)`)).toBe(3);
    expect(scalar<number>(`count(*) from public.admin_audit_read_windows`)).toBe(before);
    expect(scalar<number>(`public.retention_trim_audit_read_windows(now() - interval '1 day', 2, false)`)).toBe(2);
    expect(scalar<number>(`public.retention_trim_audit_read_windows(now() - interval '1 day', 2, false)`)).toBe(1);
    expect(scalar<number>(`public.retention_trim_audit_read_windows(now() - interval '1 day', 2, false)`)).toBe(0);
    expect(scalar<number>(`count(*) from public.admin_audit_read_windows`)).toBe(before - 3);
    // Audit events are untouched by the sweep: they are the record, the windows are only the dedupe.
    expect(scalar<number>(`count(*) from public.admin_audit_events`)).toBe(6);
  });
});
