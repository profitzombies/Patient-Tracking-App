/**
 * The roster activity aggregate, run for real.
 *
 * provider_patient_activity_summary is plain SQL that PostgREST fakes cannot
 * exercise, so this suite boots a throwaway PostgreSQL cluster from the
 * binaries on PATH (unix socket only, no TCP port), applies the canonical
 * migration file verbatim on top of a minimal copy of the patient tables,
 * seeds fixtures, and asserts:
 *
 *  - per-patient local day anchoring (timezone boundaries, unset/invalid
 *    zones falling back to UTC, future-dated rows excluded);
 *  - zero-versus-unknown semantics for every signal family;
 *  - streak, window, rounding and ordering definitions;
 *  - service-role gating and grants;
 *  - parity with the TypeScript reference used by the patient detail
 *    record, on a shared multi-patient fixture.
 *
 * Skips (loudly) when no PostgreSQL binaries are available.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computePatientActivity,
  activityFromSummaryRow,
  type PatientActivitySignals,
} from "./patient-activity";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  here,
  "../../../../supabase/migrations/20260925138000_patient_activity_summary.sql",
);

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("patient-activity.sql.test: PostgreSQL binaries not on PATH — SQL aggregate suite skipped");
}

// Minimal mirror of the live tables (only the columns the aggregate touches),
// Supabase's auth.role() replaced by a session setting, and the three
// PostgREST roles so the migration's grants apply unchanged.
const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.patients (
  id uuid primary key, provider_id text not null, timezone text,
  last_log_date date, last_login_at timestamptz, created_at timestamptz default now());
create table public.patient_diary_entries (
  patient_id uuid references public.patients(id), entry_id text, date_key date not null,
  calories numeric not null default 0, primary key (patient_id, entry_id));
create table public.patient_water_days (
  patient_id uuid references public.patients(id), date_key date not null, oz integer not null,
  primary key (patient_id, date_key));
create table public.patient_check_ins (
  patient_id uuid references public.patients(id), date_key date not null, check_in_id text not null,
  weight numeric, mood integer not null, side_effects jsonb not null default '[]'::jsonb,
  primary key (patient_id, date_key));
create table public.patient_health_measurements (
  patient_id uuid references public.patients(id), source text, source_id text, kind text,
  value numeric, measured_at timestamptz not null, primary key (patient_id, source, source_id));
create table public.patient_progress_photos (
  patient_id uuid references public.patients(id), photo_id text, date_key date not null,
  primary key (patient_id, photo_id));
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

function summary(providerId: string, at: string) {
  return rows(
    `select * from public.provider_patient_activity_summary('${providerId}', '${at}'::timestamptz) order by patient_id`,
  );
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function insertPatient(n: number, provider: string, timezone: string | null) {
  psql(
    `insert into public.patients (id, provider_id, timezone) values ('${uuid(n)}', '${provider}', ${
      timezone === null ? "null" : `'${timezone}'`
    })`,
  );
}

function insertDiary(n: number, entries: Array<[string, number]>) {
  if (!entries.length) return;
  const values = entries
    .map(([day, calories], i) => `('${uuid(n)}', 'e-${n}-${i}', '${day}', ${calories})`)
    .join(",");
  psql(`insert into public.patient_diary_entries (patient_id, entry_id, date_key, calories) values ${values}`);
}

function insertWater(n: number, days: Array<[string, number]>) {
  if (!days.length) return;
  const values = days.map(([day, oz]) => `('${uuid(n)}', '${day}', ${oz})`).join(",");
  psql(`insert into public.patient_water_days (patient_id, date_key, oz) values ${values}`);
}

function insertCheckIns(n: number, items: Array<[string, number, string[], number | null]>) {
  if (!items.length) return;
  const values = items
    .map(([day, mood, effects, weight], i) =>
      `('${uuid(n)}', '${day}', 'c-${n}-${i}', ${weight ?? "null"}, ${mood}, '${JSON.stringify(effects)}'::jsonb)`)
    .join(",");
  psql(
    `insert into public.patient_check_ins (patient_id, date_key, check_in_id, weight, mood, side_effects) values ${values}`,
  );
}

function resetData() {
  psql(
    "truncate public.patient_diary_entries, public.patient_water_days, public.patient_check_ins, public.patient_health_measurements, public.patient_progress_photos, public.patients",
  );
}

function shift(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!POSTGRES_AVAILABLE)("provider_patient_activity_summary (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pa-"));
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

  it("applies the canonical migration file verbatim", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("provider_patient_activity_summary");
    expect(rows("select proname from pg_proc where proname in ('provider_patient_activity_summary','patient_effective_timezone') order by 1"))
      .toEqual([{ proname: "patient_effective_timezone" }, { proname: "provider_patient_activity_summary" }]);
  });

  it("is service-role only", () => {
    resetData();
    insertPatient(1, "office-a", "UTC");
    expect(() => rows("select * from public.provider_patient_activity_summary('office-a', now())", "anon"))
      .toThrow(/service role required/);
    expect(() => rows("select * from public.provider_patient_activity_summary('office-a', now())", "authenticated"))
      .toThrow(/service role required/);
    const grants = rows<{ role: string; can: boolean }>(
      `select r.role, has_function_privilege(r.role, 'public.provider_patient_activity_summary(text, timestamptz)', 'execute') as can
         from (values ('anon'), ('authenticated'), ('service_role')) r(role)`,
    );
    expect(grants).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: true },
    ]);
  });

  it("anchors each patient on their own local day and falls back to UTC for unset or bad zones", () => {
    resetData();
    // 2026-09-06 03:30Z: still 2026-09-05 in New York, already 2026-09-06 in
    // UTC and 2026-09-06 17:30 in Kiritimati (UTC+14).
    insertPatient(1, "office-a", "America/New_York");
    insertPatient(2, "office-a", "Not/AZone");
    insertPatient(3, "office-a", null);
    insertPatient(4, "office-a", "Pacific/Kiritimati");
    insertPatient(9, "office-b", "UTC");
    // NY patient logged "today" (their 09-05) and has a row on 09-06 that the
    // app cannot have written yet from their clock's point of view.
    insertDiary(1, [["2026-09-05", 400], ["2026-09-06", 900]]);
    insertDiary(2, [["2026-09-06", 500]]);
    insertDiary(4, [["2026-09-06", 100], ["2026-09-07", 200]]);
    insertDiary(9, [["2026-09-06", 100]]);

    const result = summary("office-a", "2026-09-06 03:30:00+00");
    expect(result.map((row) => row.patient_id)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    const byId = new Map(result.map((row) => [row.patient_id, row]));
    expect(byId.get(uuid(1))).toMatchObject({
      as_of_date: "2026-09-05", latest_diary_date: "2026-09-05", logged_days_7: 1,
      logged_last_7: [false, false, false, false, false, false, true], avg_calories_7: 400,
    });
    expect(byId.get(uuid(2))).toMatchObject({ as_of_date: "2026-09-06", latest_diary_date: "2026-09-06", logged_days_7: 1 });
    expect(byId.get(uuid(3))).toMatchObject({ as_of_date: "2026-09-06", latest_diary_date: null });
    expect(byId.get(uuid(4))).toMatchObject({ as_of_date: "2026-09-06", latest_diary_date: "2026-09-06", logged_days_7: 1 });

    // Two hours later New York has crossed midnight: same rows, next local day,
    // and the 09-06 entry now counts.
    const later = summary("office-a", "2026-09-06 05:30:00+00");
    expect(later.find((row) => row.patient_id === uuid(1))).toMatchObject({
      as_of_date: "2026-09-06", latest_diary_date: "2026-09-06", logged_days_7: 2, meal_streak: 2, avg_calories_7: 650,
    });
  });

  it("keeps whole families null until data of that kind exists, and zero once it does", () => {
    resetData();
    const asOf = "2026-09-06";
    insertPatient(1, "office-a", "UTC"); // nothing at all
    insertPatient(2, "office-a", "UTC"); // water only
    insertPatient(3, "office-a", "UTC"); // logged long ago, checked in long ago
    insertWater(2, [[asOf, 40]]);
    insertDiary(3, [[shift(asOf, -20), 800]]);
    insertCheckIns(3, [[shift(asOf, -45), 3, ["Nausea"], 180]]);

    const [none, waterOnly, stale] = summary("office-a", `${asOf} 12:00:00+00`);
    expect(none).toMatchObject({
      latest_activity_date: null, logged_days_7: null, check_ins_7: null, logged_last_7: null, meal_streak: null,
      avg_calories_7: null, avg_water_7: null, check_in_streak: null, check_in_rate_30: null, mood_counts: null,
      top_side_effects: null,
    });
    expect(waterOnly).toMatchObject({
      latest_water_date: asOf, avg_water_7: 40, logged_days_7: null, logged_last_7: null, check_in_streak: null,
    });
    expect(stale).toMatchObject({
      logged_days_7: 0, logged_last_7: [false, false, false, false, false, false, false], meal_streak: 0,
      avg_calories_7: null, check_ins_7: 0, check_in_streak: 0, check_in_rate_30: 0,
      mood_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }, top_side_effects: [],
      latest_check_in_date: shift(asOf, -45), latest_weight_date: shift(asOf, -45),
    });
  });

  it("counts streaks with today open, windows inclusive of today, and rounds averages and rates", () => {
    resetData();
    const asOf = "2026-09-06";
    insertPatient(1, "office-a", "UTC"); // logged days -1..-3, not today -> streak 3
    insertPatient(2, "office-a", "UTC"); // logged today, gap yesterday -> streak 1
    insertPatient(3, "office-a", "UTC"); // logged 3 days ago only -> streak 0
    insertDiary(1, [[shift(asOf, -1), 1000], [shift(asOf, -1), 500], [shift(asOf, -2), 1001], [shift(asOf, -3), 0]]);
    insertDiary(2, [[asOf, 1], [shift(asOf, -2), 1], [shift(asOf, -7), 5000]]);
    insertDiary(3, [[shift(asOf, -3), 100]]);
    insertWater(1, [[asOf, 0], [shift(asOf, -1), 33], [shift(asOf, -2), 34], [shift(asOf, -7), 200]]);
    // Check-ins: today + yesterday (streak 2); one exactly 29 days back is in
    // the 30-day window, one 30 days back is not.
    insertCheckIns(1, [
      [asOf, 5, ["Fatigue", "Nausea"], null],
      [shift(asOf, -1), 4, ["Nausea"], 180],
      [shift(asOf, -29), 2, ["Headache", "Nausea"], null],
      [shift(asOf, -30), 1, ["Dizziness"], null],
    ]);

    const [one, two, three] = summary("office-a", `${asOf} 12:00:00+00`);
    expect(one).toMatchObject({
      logged_last_7: [false, false, false, true, true, true, false],
      logged_days_7: 3, meal_streak: 3,
      avg_calories_7: 834, // (1500 + 1001 + 0) / 3 = 833.67
      avg_water_7: 34, // (33 + 34) / 2 = 33.5, zero-oz day and day -7 excluded
      check_ins_7: 2, check_in_streak: 2, check_in_rate_30: 10, // 3 / 30
      mood_counts: { "1": 0, "2": 1, "3": 0, "4": 1, "5": 1 },
      top_side_effects: [{ name: "Nausea", count: 3 }, { name: "Fatigue", count: 1 }, { name: "Headache", count: 1 }],
      latest_check_in_date: asOf, latest_weight_date: shift(asOf, -1),
    });
    expect(two).toMatchObject({ logged_days_7: 2, meal_streak: 1, avg_calories_7: 1 });
    expect(three).toMatchObject({ logged_days_7: 1, meal_streak: 0 });
  });

  it("agrees with the TypeScript reference the patient detail record uses", () => {
    resetData();
    const asOf = "2026-09-06";
    // Deterministic pseudo-random fixture: several patients with irregular
    // logging, water and check-in histories, including one with nothing.
    let seed = 7;
    const rand = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    const effects = ["Nausea", "Fatigue", "Headache", "Constipation", "Dizziness"];
    const zones = ["UTC", "America/Los_Angeles", "Asia/Tokyo", null, "America/New_York", "Europe/London"];
    const raw = new Map<number, { diary: Array<[string, number]>; water: Array<[string, number]>; checkIns: Array<[string, number, string[], number | null]> }>();
    for (let n = 1; n <= 6; n += 1) {
      insertPatient(n, "office-a", zones[n - 1] ?? null);
      const diary: Array<[string, number]> = [];
      const water: Array<[string, number]> = [];
      const checkIns: Array<[string, number, string[], number | null]> = [];
      if (n !== 6) {
        for (let back = 0; back < 45; back += 1) {
          const day = shift(asOf, -back);
          if (rand() < 0.6) {
            const meals = 1 + Math.floor(rand() * 3);
            for (let m = 0; m < meals; m += 1) diary.push([day, Math.round(rand() * 900)]);
          }
          if (rand() < 0.5) water.push([day, Math.floor(rand() * 100)]);
          if (rand() < 0.35) {
            const picked = effects.filter(() => rand() < 0.4);
            checkIns.push([day, 1 + Math.floor(rand() * 5), picked, rand() < 0.5 ? 150 + Math.round(rand() * 50) : null]);
          }
        }
      }
      raw.set(n, { diary, water, checkIns });
      insertDiary(n, diary);
      insertWater(n, water);
      insertCheckIns(n, checkIns);
    }

    // Noon UTC on the as-of day is the same calendar day in every zone above.
    const result = summary("office-a", `${asOf} 12:00:00+00`);
    expect(result).toHaveLength(6);
    for (const row of result) {
      const n = Number(String(row.patient_id).slice(-2));
      const fixture = raw.get(n)!;
      const fromSql = activityFromSummaryRow(row, "1970-01-01");
      const fromTs: PatientActivitySignals = computePatientActivity(
        {
          diary: fixture.diary.map(([dateKey, calories]) => ({ dateKey, calories })),
          water: fixture.water.map(([dateKey, oz]) => ({ dateKey, oz })),
          checkIns: fixture.checkIns.map(([dateKey, mood, sideEffects]) => ({ dateKey, mood, sideEffects })),
        },
        asOf,
      );
      expect(fromSql, `patient ${n}`).toEqual(fromTs);
      expect(fromSql?.asOfDate).toBe(asOf);
    }
    // Sanity: the fixture really exercised the interesting states.
    const states = result.map((row) => [row.meal_streak, row.check_in_rate_30]);
    expect(states.some(([streak]) => typeof streak === "number" && streak > 0)).toBe(true);
    expect(states.some(([, rate]) => rate === null)).toBe(true);
  });
});
