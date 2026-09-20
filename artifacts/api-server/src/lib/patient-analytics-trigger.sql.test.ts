/**
 * capture_patient_analytics_event() is one trigger function shared by five
 * tables with different row shapes. The original version referenced
 * table-specific columns (new.kind, new.measured_at, …) in expressions that
 * ran for every table, and PL/pgSQL rejected the row at plan time — every
 * live check-in, diary, photo, and imported-weight insert failed with
 * `record "new" has no field "kind"`. This suite applies the fixed migration
 * verbatim over a minimal mirror of the tables and proves each table's
 * insert succeeds and lands (or skips) the expected analytics event. Skips
 * loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261111000000_fix_patient_analytics_trigger.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("patient-analytics-trigger.sql.test: PostgreSQL binaries not on PATH — suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.patients (id uuid primary key, provider_id text, activation_status text not null default 'unactivated', auth_user_id uuid);
create table public.patient_check_ins (patient_id uuid not null, check_in_id text not null, date_key date not null, weight numeric, primary key (patient_id, check_in_id));
create table public.patient_diary_entries (patient_id uuid not null, entry_id text not null, date_key date not null, primary key (patient_id, entry_id));
create table public.patient_progress_photos (patient_id uuid not null, photo_id text not null, date_key date not null, object_path text, primary key (patient_id, photo_id));
create table public.patient_health_measurements (patient_id uuid not null, source text not null, source_id text not null, kind text not null, measured_at timestamptz not null, primary key (patient_id, source, source_id));
create table public.analytics_events (
  id bigint generated always as identity primary key,
  event_name text not null, occurred_at timestamptz not null default now(), provider_id text not null,
  patient_id uuid, actor_user_id uuid, source text not null, properties jsonb not null default '{}'::jsonb,
  dedupe_key text unique
);
`;
const TRIGGERS = `
create trigger analytics_diary_insert after insert on public.patient_diary_entries for each row execute function public.capture_patient_analytics_event();
create trigger analytics_check_in_insert after insert or update on public.patient_check_ins for each row execute function public.capture_patient_analytics_event();
create trigger analytics_photo_insert after insert on public.patient_progress_photos for each row execute function public.capture_patient_analytics_event();
create trigger analytics_weight_insert after insert on public.patient_health_measurements for each row execute function public.capture_patient_analytics_event();
create trigger analytics_patient_activation after update of activation_status on public.patients for each row execute function public.capture_patient_analytics_event();
`;

let dir = "";
let dataDir = "";
const PORT = 55_600 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];

function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}
const P1 = "00000000-0000-4000-8000-000000000001";
const ORPHAN = "00000000-0000-4000-8000-000000000009";

describe.skipIf(!POSTGRES_AVAILABLE)("capture_patient_analytics_event trigger (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pat-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    const triggerFile = path.join(dir, "triggers.sql");
    writeFileSync(triggerFile, TRIGGERS);
    for (const file of [schemaFile, MIGRATION, triggerFile]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
    psql(`insert into public.patients (id, provider_id) values ('${P1}', 'office-1'), ('${ORPHAN}', null)`);
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a check-in, a diary entry, and a progress photo and records one event each (dedupe on re-fire)", () => {
    psql(`insert into public.patient_check_ins (patient_id, check_in_id, date_key, weight) values ('${P1}', 'ci-1', '2026-09-01', 208.4)`);
    psql(`insert into public.patient_diary_entries (patient_id, entry_id, date_key) values ('${P1}', 'entry-1', '2026-09-02')`);
    psql(`insert into public.patient_progress_photos (patient_id, photo_id, date_key, object_path) values ('${P1}', 'photo-1', '2026-09-03', '/objects/x')`);
    // The check-in trigger also fires on update: same dedupe key, no second row.
    psql(`update public.patient_check_ins set weight = 207 where check_in_id = 'ci-1'`);
    const events = rows<{ event_name: string; provider_id: string; dedupe_key: string; properties: { date: string; source: string } }>(
      `select event_name, provider_id, dedupe_key, properties from public.analytics_events order by id`,
    );
    expect(events).toEqual([
      { event_name: "check_in_completed", provider_id: "office-1", dedupe_key: `check_in_completed:${P1}:ci-1`, properties: { date: "2026-09-01", source: "patient_check_ins" } },
      { event_name: "meal_logged", provider_id: "office-1", dedupe_key: `meal_logged:${P1}:entry-1`, properties: { date: "2026-09-02", source: "patient_diary_entries" } },
      { event_name: "progress_photo_added", provider_id: "office-1", dedupe_key: `progress_photo_added:${P1}:photo-1`, properties: { date: "2026-09-03", source: "patient_progress_photos" } },
    ]);
  });

  it("records imported weights only for the weight kind, keyed by source and dated by measured_at", () => {
    psql(`insert into public.patient_health_measurements (patient_id, source, source_id, kind, measured_at) values
      ('${P1}', 'apple_health', 'hk-1', 'weight_lb', '2026-09-04T13:00:00Z'), ('${P1}', 'apple_health', 'hk-2', 'steps', '2026-09-04T14:00:00Z')`);
    const weights = rows<{ dedupe_key: string; properties: { date: string; source: string } }>(
      `select dedupe_key, properties from public.analytics_events where event_name = 'weight_recorded'`,
    );
    expect(weights).toEqual([{ dedupe_key: `weight_recorded:${P1}:apple_health:hk-1`, properties: { date: "2026-09-04", source: "apple_health" } }]);
  });

  it("lets writes for a patient without an office through without recording anything", () => {
    psql(`insert into public.patient_check_ins (patient_id, check_in_id, date_key) values ('${ORPHAN}', 'ci-orphan', '2026-09-05')`);
    expect(rows(`select id from public.analytics_events where patient_id = '${ORPHAN}'`)).toEqual([]);
  });

  it("still records the activation event from the patients table's own columns", () => {
    psql(`update public.patients set activation_status = 'activated' where id = '${P1}'`);
    expect(rows<{ dedupe_key: string }>(`select dedupe_key from public.analytics_events where event_name = 'patient_activated'`)).toEqual([{ dedupe_key: `patient_activated:${P1}` }]);
  });
});
