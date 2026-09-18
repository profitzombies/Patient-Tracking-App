/**
 * The AI usage ledger migration, run for real: table constraints, service
 * role-only grants, and the ai_usage_summary RPC's arithmetic (UTC day
 * bucketing, per-office rows that include offices with presence but no
 * spend, active-patient counts from patient_app_presence, unpriced
 * models, and range validation). Boots a throwaway PostgreSQL cluster;
 * skips loudly without the binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261029000000_ai_usage_ledger.sql");

const hasBinary = (name: string) => spawnSync("which", [name], { stdio: "ignore" }).status === 0;
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("summary.sql.test: PostgreSQL binaries not on PATH — ai usage ledger SQL suite skipped");

const P1 = "0a1b2c3d-0000-4000-8000-000000000001";
const P2 = "0a1b2c3d-0000-4000-8000-000000000002";
const P3 = "0a1b2c3d-0000-4000-8000-000000000003";

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
alter database postgres set test.role = 'service_role';
create table public.providers (provider_id text primary key, provider_name text, office_name text, access_disabled boolean default false);
create table public.patients (id uuid primary key, provider_id text not null references public.providers);
create table public.patient_app_presence (patient_id uuid not null references public.patients on delete cascade, day date not null, primary key (patient_id, day));
insert into public.providers values ('office-a', 'Dr A', 'Office A', false), ('office-b', 'Dr B', 'Office B', false), ('office-quiet', 'Dr Q', 'Quiet Office', false);
insert into public.patients values ('${P1}', 'office-a'), ('${P2}', 'office-a'), ('${P3}', 'office-quiet');
`;

let dir = "";
let dataDir = "";
const PORT = 54_700 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string) => execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8" });
const rows = <T = Record<string, unknown>>(sql: string): T[] => JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`).trim() || "[]") as T[];
const summary = (from: string, to: string) => JSON.parse(psql(`select public.ai_usage_summary('${from}', '${to}')`).trim()) as Record<string, any>;

function insert(over: Record<string, string | number | boolean | null>) {
  const row: Record<string, string | number | boolean | null> = {
    occurred_at: "2026-09-17T12:00:00Z", surface: "coach.chat", api: "chat.completions", model: "gpt-5.6-terra", scope: "patient",
    patient_id: P1, provider_id: "office-a", stream: true, status: "ok", usage_reported: true, prompt_tokens: 1000, cached_tokens: 800,
    completion_tokens: 200, reasoning_tokens: 50, latency_ms: 3000, first_token_ms: 800, estimated_cost_micros: 2350, pricing_version: "t", ...over,
  };
  const cols = Object.keys(row);
  const vals = cols.map((c) => (row[c] === null ? "null" : typeof row[c] === "string" ? `'${row[c]}'` : String(row[c])));
  psql(`insert into public.ai_usage_events (${cols.join(",")}) values (${vals.join(",")})`);
}

describe.skipIf(!POSTGRES_AVAILABLE)("ai_usage_events + ai_usage_summary (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "au-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"], { stdio: "ignore" });
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

  it("applies verbatim, re-runs cleanly, and keeps the table and RPC service-role only", () => {
    execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", MIGRATION], { stdio: "pipe", encoding: "utf8" });
    expect(rows<{ rls: boolean }>("select relrowsecurity as rls from pg_class where relname = 'ai_usage_events'")[0]!.rls).toBe(true);
    for (const role of ["anon", "authenticated"]) {
      expect(rows<{ ok: boolean }>(`select has_table_privilege('${role}', 'public.ai_usage_events', 'select') as ok`)[0]!.ok).toBe(false);
      expect(rows<{ ok: boolean }>(`select has_function_privilege('${role}', 'public.ai_usage_summary(date,date)', 'execute') as ok`)[0]!.ok).toBe(false);
    }
    expect(rows<{ ok: boolean }>("select has_table_privilege('service_role', 'public.ai_usage_events', 'insert') as ok")[0]!.ok).toBe(true);
    expect(rows<{ ok: boolean }>("select has_function_privilege('service_role', 'public.ai_usage_summary(date,date)', 'execute') as ok")[0]!.ok).toBe(true);
    expect(rows<{ sd: boolean }>("select prosecdef as sd from pg_proc where proname = 'ai_usage_summary'")[0]!.sd).toBe(true);
  });

  it("rejects rows whose cached or reasoning counts exceed their parents, and detaches rows when a patient is deleted", () => {
    expect(() => insert({ cached_tokens: 1001 })).toThrow();
    expect(() => insert({ reasoning_tokens: 201 })).toThrow();
    expect(() => insert({ scope: "mystery" })).toThrow();
    psql("truncate public.ai_usage_events");
    psql(`insert into public.patients values ('0a1b2c3d-0000-4000-8000-00000000dead', 'office-b')`);
    insert({ patient_id: "0a1b2c3d-0000-4000-8000-00000000dead", provider_id: "office-b" });
    psql(`delete from public.patients where id = '0a1b2c3d-0000-4000-8000-00000000dead'`);
    expect(rows<{ patient_id: string | null; provider_id: string }>("select patient_id, provider_id from public.ai_usage_events")).toEqual([{ patient_id: null, provider_id: "office-b" }]);
    psql("truncate public.ai_usage_events");
  });

  it("summarizes totals, days, offices (presence-only offices included), surfaces and models for the range", () => {
    psql("truncate public.ai_usage_events, public.patient_app_presence");
    psql(`insert into public.patient_app_presence values ('${P1}', '2026-09-16'), ('${P1}', '2026-09-17'), ('${P2}', '2026-09-17'), ('${P3}', '2026-09-17'), ('${P3}', '2026-09-30')`);
    insert({}); // P1, office-a, 17th, 2350 micros
    insert({ occurred_at: "2026-09-17T23:30:00Z", patient_id: P2, surface: "coach.meal_photo", model: "gpt-5.6-luna", estimated_cost_micros: 5000, prompt_tokens: 3000, cached_tokens: 0, completion_tokens: 500, reasoning_tokens: 0 });
    insert({ occurred_at: "2026-09-18T00:10:00Z", status: "error", usage_reported: false, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, estimated_cost_micros: null, pricing_version: null, first_token_ms: null });
    insert({ occurred_at: "2026-09-18T09:00:00Z", scope: "office", patient_id: null, provider_id: "office-b", surface: "support.chat", model: "mystery", estimated_cost_micros: null, pricing_version: null });
    insert({ occurred_at: "2026-09-18T10:00:00Z", scope: "unattributed", patient_id: null, provider_id: null, surface: "unattributed", estimated_cost_micros: 100 });
    insert({ occurred_at: "2026-09-19T00:00:00Z", estimated_cost_micros: 999_999 }); // outside the range

    const result = summary("2026-09-17", "2026-09-18");
    expect(result.totals).toMatchObject({
      calls: 5, ok_calls: 4, error_calls: 1, aborted_calls: 0,
      prompt_tokens: 6000, cached_tokens: 2400, completion_tokens: 1100, reasoning_tokens: 150,
      cost_micros: 7450, unpriced_calls: 1, ai_patients: 2, active_patients: 3,
    });
    expect(result.unattributed).toEqual({ calls: 1, cost_micros: 100 });
    expect(result.by_day.map((d: any) => [d.day, d.calls, d.cost_micros, d.ai_patients])).toEqual([
      ["2026-09-17", 2, 7350, 2],
      ["2026-09-18", 3, 100, 1],
    ]);
    expect(result.by_office.map((o: any) => [o.provider_id, o.office_name, o.calls, o.cost_micros, o.ai_patients, o.active_patients])).toEqual([
      ["office-a", "Office A", 3, 7350, 2, 2],
      ["office-b", "Office B", 1, 0, 0, 0],
      ["office-quiet", "Quiet Office", 0, 0, 0, 1],
    ]);
    expect(result.by_surface[0]).toMatchObject({ surface: "coach.meal_photo", calls: 1, cost_micros: 5000 });
    expect(result.by_surface.find((s: any) => s.surface === "coach.chat")).toMatchObject({ calls: 2, error_calls: 1, cost_micros: 2350, cached_tokens: 800, avg_latency_ms: 3000, p95_latency_ms: 3000 });
    expect(result.by_model.map((m: any) => [m.model, m.calls, m.unpriced])).toEqual([
      ["gpt-5.6-luna", 1, false], ["gpt-5.6-terra", 3, false], ["mystery", 1, true],
    ]);
  });

  it("answers an empty range honestly and rejects invalid or oversized ranges and non-service callers", () => {
    const empty = summary("2020-01-01", "2020-01-02");
    expect(empty.totals).toMatchObject({ calls: 0, cost_micros: 0, active_patients: 0, ai_patients: 0 });
    expect(empty.by_day).toEqual([]);
    expect(empty.by_office).toEqual([]);
    expect(() => summary("2026-09-18", "2026-09-17")).toThrow(/invalid range/);
    expect(() => summary("2025-01-01", "2026-09-18")).toThrow(/range too long/);
    expect(() => psql("set test.role = 'authenticated'; select public.ai_usage_summary('2026-09-17', '2026-09-18')")).toThrow(/service role required/);
  });
});
