/**
 * The leaderboard facts aggregate, run for real.
 *
 * provider_leaderboard_facts is plain SQL that the PostgREST fakes cannot
 * exercise, so this suite boots a throwaway PostgreSQL cluster (unix socket
 * only), applies the activity-summary migration (for
 * patient_effective_timezone) and the canonical leaderboard migration file
 * verbatim on top of a minimal copy of the patient tables, then asserts:
 *
 *  - period bounds per patient local day (program to date vs rolling
 *    windows, program start inside a window, unstarted programs);
 *  - activity counts inside the period only, distinct diary days, water
 *    goal from the per-patient override or the 64 oz default;
 *  - weight readings merged across check-ins and office weigh-ins with the
 *    newest-first order, the pre-period baseline and in-period counts;
 *  - office scoping and the HQ "every office" form;
 *  - service-role gating and grants.
 *
 * Skips (loudly) when no PostgreSQL binaries are available.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../../../supabase/migrations");
const ACTIVITY_MIGRATION = path.join(MIGRATIONS, "20260925138000_patient_activity_summary.sql");
const MIGRATION = path.join(MIGRATIONS, "20261001000000_office_leaderboard.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("leaderboard facts.sql.test: PostgreSQL binaries not on PATH — SQL aggregate suite skipped");
}

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.patients (
  id uuid primary key, provider_id text not null, timezone text, program_start_date date,
  starting_weight numeric, current_weight numeric,
  last_log_date date, last_login_at timestamptz, created_at timestamptz not null default now());
create table public.patient_diary_entries (
  patient_id uuid references public.patients(id), entry_id text, date_key date not null,
  calories numeric not null default 0, primary key (patient_id, entry_id));
create table public.patient_water_days (
  patient_id uuid references public.patients(id), date_key date not null, oz integer not null,
  primary key (patient_id, date_key));
create table public.patient_target_overrides (
  patient_id uuid primary key references public.patients(id), water_oz numeric);
create table public.patient_check_ins (
  patient_id uuid references public.patients(id), date_key date not null, check_in_id text not null,
  weight numeric, mood integer not null default 3, side_effects jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(), primary key (patient_id, date_key));
create table public.patient_staff_weights (
  id uuid primary key default gen_random_uuid(), patient_id uuid references public.patients(id),
  date_key date not null, weight numeric not null, updated_at timestamptz not null default now());
create table public.patient_health_measurements (
  patient_id uuid references public.patients(id), source text, source_id text, kind text,
  value numeric, measured_at timestamptz not null, primary key (patient_id, source, source_id));
create table public.patient_progress_photos (
  patient_id uuid references public.patients(id), photo_id text, date_key date not null,
  primary key (patient_id, photo_id));
`;

let dir = "";
let dataDir = "";
const PORT = 55_400 + (process.pid % 1000);

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

type Fact = {
  patient_id: string; provider_id: string; as_of_date: string; period_start: string; eligible_days: number;
  logged_days: number; check_in_days: number; water_goal_days: number; weigh_in_count: number; period_weigh_ins: number;
  baseline_weight: number | null; baseline_weight_date: string | null; latest_weight: number | null; latest_weight_date: string | null;
};

function facts(provider: string | null, at: string, windowDays: number | null): Fact[] {
  return rows<Fact>(
    `select * from public.provider_leaderboard_facts(${provider === null ? "null" : `'${provider}'`}, '${at}'::timestamptz, ${windowDays ?? "null"}) order by patient_id`,
  );
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function insertPatient(n: number, provider: string, timezone: string | null, programStart: string | null, createdAt = "2026-01-01T12:00:00Z") {
  psql(
    `insert into public.patients (id, provider_id, timezone, program_start_date, created_at) values ('${uuid(n)}', '${provider}', ${
      timezone === null ? "null" : `'${timezone}'`
    }, ${programStart === null ? "null" : `'${programStart}'`}, '${createdAt}')`,
  );
}

function insertDiary(n: number, entries: string[]) {
  if (!entries.length) return;
  const values = entries.map((day, i) => `('${uuid(n)}', 'e-${n}-${i}', '${day}', 100)`).join(",");
  psql(`insert into public.patient_diary_entries (patient_id, entry_id, date_key, calories) values ${values}`);
}

function insertWater(n: number, days: Array<[string, number]>) {
  if (!days.length) return;
  const values = days.map(([day, oz]) => `('${uuid(n)}', '${day}', ${oz})`).join(",");
  psql(`insert into public.patient_water_days (patient_id, date_key, oz) values ${values}`);
}

function insertCheckIns(n: number, items: Array<[string, number | null, string?]>) {
  if (!items.length) return;
  const values = items
    .map(([day, weight, updated], i) => `('${uuid(n)}', '${day}', 'c-${n}-${i}', ${weight ?? "null"}, '${updated ?? `${day}T08:00:00Z`}')`)
    .join(",");
  psql(`insert into public.patient_check_ins (patient_id, date_key, check_in_id, weight, updated_at) values ${values}`);
}

function insertStaffWeights(n: number, items: Array<[string, number, string?]>) {
  if (!items.length) return;
  const values = items.map(([day, weight, updated]) => `('${uuid(n)}', '${day}', ${weight}, '${updated ?? `${day}T09:00:00Z`}')`).join(",");
  psql(`insert into public.patient_staff_weights (patient_id, date_key, weight, updated_at) values ${values}`);
}

function resetData() {
  psql(
    "truncate public.patient_diary_entries, public.patient_water_days, public.patient_target_overrides, public.patient_check_ins, public.patient_staff_weights, public.patient_health_measurements, public.patient_progress_photos, public.patients",
  );
}

const AT = "2026-09-07 15:00:00+00";

describe.skipIf(!POSTGRES_AVAILABLE)("provider_leaderboard_facts (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lb-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, ACTIVITY_MIGRATION, MIGRATION]) {
      execFileSync(
        "psql",
        ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file],
        { stdio: "pipe", encoding: "utf8" },
      );
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies the canonical migration file verbatim and is service-role only", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("provider_leaderboard_facts");
    resetData();
    insertPatient(1, "office-a", "UTC", "2026-08-01");
    expect(() => facts("office-a", AT, null)).not.toThrow();
    expect(() => rows("select * from public.provider_leaderboard_facts('office-a', now(), null)", "anon")).toThrow(/service role required/);
    expect(() => rows("select * from public.provider_leaderboard_facts('office-a', now(), null)", "authenticated")).toThrow(/service role required/);
    expect(() => facts("office-a", AT, 0)).toThrow(/at least 1/);
    const grants = rows<{ role: string; can: boolean }>(
      `select r.role, has_function_privilege(r.role, 'public.provider_leaderboard_facts(text, timestamptz, integer)', 'execute') as can
         from (values ('anon'), ('authenticated'), ('service_role')) r(role)`,
    );
    expect(grants).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: true },
    ]);
  });

  it("bounds the period per patient: program to date, rolling windows, and a program that starts inside the window", () => {
    resetData();
    insertPatient(1, "office-a", "UTC", "2026-06-01");
    insertPatient(2, "office-a", "UTC", "2026-08-20");
    insertPatient(3, "office-a", "UTC", "2026-09-10"); // starts in the future
    insertPatient(4, "office-a", "UTC", null, "2026-07-15T03:00:00Z"); // no start → account day

    const program = new Map(facts("office-a", AT, null).map((row) => [row.patient_id, row]));
    expect(program.get(uuid(1))).toMatchObject({ as_of_date: "2026-09-07", period_start: "2026-06-01", eligible_days: 99 });
    expect(program.get(uuid(2))).toMatchObject({ period_start: "2026-08-20", eligible_days: 19 });
    expect(program.get(uuid(3))).toMatchObject({ period_start: "2026-09-10", eligible_days: 0 });
    expect(program.get(uuid(4))).toMatchObject({ period_start: "2026-07-15", eligible_days: 55 });

    const thirty = new Map(facts("office-a", AT, 30).map((row) => [row.patient_id, row]));
    expect(thirty.get(uuid(1))).toMatchObject({ period_start: "2026-08-09", eligible_days: 30 });
    // Program started inside the window: the period shrinks to the program.
    expect(thirty.get(uuid(2))).toMatchObject({ period_start: "2026-08-20", eligible_days: 19 });
    expect(thirty.get(uuid(3))).toMatchObject({ eligible_days: 0 });

    const ninety = new Map(facts("office-a", AT, 90).map((row) => [row.patient_id, row]));
    expect(ninety.get(uuid(1))).toMatchObject({ period_start: "2026-06-10", eligible_days: 90 });
  });

  it("anchors as_of on the patient's local day", () => {
    resetData();
    // 2026-09-07 03:30Z is still 09-06 in New York and already 09-07 in UTC.
    insertPatient(1, "office-a", "America/New_York", "2026-09-01");
    insertPatient(2, "office-a", null, "2026-09-01");
    insertDiary(1, ["2026-09-06", "2026-09-07"]);
    insertDiary(2, ["2026-09-06", "2026-09-07"]);
    const byId = new Map(facts("office-a", "2026-09-07 03:30:00+00", null).map((row) => [row.patient_id, row]));
    expect(byId.get(uuid(1))).toMatchObject({ as_of_date: "2026-09-06", eligible_days: 6, logged_days: 1 });
    expect(byId.get(uuid(2))).toMatchObject({ as_of_date: "2026-09-07", eligible_days: 7, logged_days: 2 });
  });

  it("counts activity inside the period only, with distinct diary days and the water goal from the override or 64 oz", () => {
    resetData();
    insertPatient(1, "office-a", "UTC", "2026-06-01");
    insertPatient(2, "office-a", "UTC", "2026-06-01");
    psql(`insert into public.patient_target_overrides (patient_id, water_oz) values ('${uuid(2)}', 80)`);
    // Three entries on two days inside the 30-day window, one day before it.
    insertDiary(1, ["2026-08-08", "2026-08-09", "2026-08-09", "2026-09-07"]);
    insertWater(1, [["2026-08-08", 64], ["2026-08-09", 63], ["2026-08-10", 64], ["2026-09-07", 100]]);
    insertCheckIns(1, [["2026-08-08", null], ["2026-08-09", null], ["2026-09-01", null]]);
    insertWater(2, [["2026-09-01", 64], ["2026-09-02", 80]]);

    const thirty = new Map(facts("office-a", AT, 30).map((row) => [row.patient_id, row]));
    expect(thirty.get(uuid(1))).toMatchObject({ logged_days: 2, water_goal_days: 2, check_in_days: 2 });
    expect(thirty.get(uuid(2))).toMatchObject({ logged_days: 0, water_goal_days: 1, check_in_days: 0 });

    const program = new Map(facts("office-a", AT, null).map((row) => [row.patient_id, row]));
    expect(program.get(uuid(1))).toMatchObject({ logged_days: 3, water_goal_days: 3, check_in_days: 3 });
  });

  it("merges check-in and office weigh-ins newest first, with the pre-period baseline and in-period count", () => {
    resetData();
    insertPatient(1, "office-a", "UTC", "2026-06-01");
    // Check-ins: a weightless one (not a reading), an early reading, a
    // same-day pair where the office weigh-in was recorded later.
    insertCheckIns(1, [["2026-06-02", 210], ["2026-07-15", null], ["2026-08-01", 200], ["2026-09-05", 191, "2026-09-05T07:00:00Z"]]);
    insertStaffWeights(1, [["2026-08-05", 198], ["2026-09-05", 190.5, "2026-09-05T18:00:00Z"]]);
    // A reading dated after as_of never counts.
    insertStaffWeights(1, [["2026-09-08", 100]]);

    const program = facts("office-a", AT, null)[0];
    expect(program).toMatchObject({
      weigh_in_count: 5, period_weigh_ins: 5, baseline_weight: null, baseline_weight_date: null,
      latest_weight: 190.5, latest_weight_date: "2026-09-05",
    });
    const thirty = facts("office-a", AT, 30)[0];
    // Window starts 08-09: baseline is the 08-05 office weigh-in (newest before the window).
    expect(thirty).toMatchObject({ period_start: "2026-08-09", period_weigh_ins: 2, baseline_weight: 198, baseline_weight_date: "2026-08-05", latest_weight: 190.5 });
    const ninety = facts("office-a", AT, 90)[0];
    // Window starts 06-10: baseline is the 06-02 check-in.
    expect(ninety).toMatchObject({ period_start: "2026-06-10", period_weigh_ins: 4, baseline_weight: 210, baseline_weight_date: "2026-06-02" });
  });

  it("returns no readings for a patient who has never weighed in", () => {
    resetData();
    insertPatient(1, "office-a", "UTC", "2026-08-01");
    insertCheckIns(1, [["2026-08-02", null]]);
    expect(facts("office-a", AT, null)[0]).toMatchObject({
      weigh_in_count: 0, period_weigh_ins: 0, baseline_weight: null, latest_weight: null, latest_weight_date: null, check_in_days: 1,
    });
  });

  it("scopes to one office, or every office when the provider is null", () => {
    resetData();
    insertPatient(1, "office-a", "UTC", "2026-08-01");
    insertPatient(2, "office-b", "UTC", "2026-08-01");
    insertPatient(3, "office-a", "UTC", "2026-08-01");
    expect(facts("office-a", AT, null).map((row) => row.patient_id)).toEqual([uuid(1), uuid(3)]);
    expect(facts("office-b", AT, null).map((row) => [row.patient_id, row.provider_id])).toEqual([[uuid(2), "office-b"]]);
    expect(facts(null, AT, 30).map((row) => row.patient_id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(facts("office-zzz", AT, null)).toEqual([]);
  });
});
