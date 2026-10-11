/**
 * The per-feature app event ledger, rollups, and Insights read, run for real.
 *
 * Boots a throwaway PostgreSQL cluster (unix socket only), applies the
 * canonical presence migration and the app-events migration verbatim on top
 * of a minimal mirror of the patient tables, seeds fixtures, and asserts:
 *
 *  - the record RPC stores the patient's LOCAL day / weekday / hour (profile
 *    timezone, UTC fallback) and rejects unknown or archived patients;
 *  - the presence touch writes an app_open event in the same call;
 *  - inserts and deletes mark their day dirty; the rollup recomputes dirty
 *    days, leaves clean ones alone, finalizes only closed days, and a dry run
 *    reports the same figures without writing;
 *  - rollups + raw tail == a fresh aggregate over the raw rows, before and
 *    after a rollup, after new events land on a rolled day, and after a
 *    patient's rows are purged;
 *  - office scoping and disabled offices;
 *  - the backfill is batched, idempotent, respects the live boundary, keeps
 *    the hour for timestamped sources and stores -1 for day-only ones;
 *  - service-role gating, grants, and the identity write guard on the table.
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
const PRESENCE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261026000000_patient_app_presence.sql");
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261027010000_patient_app_events.sql");
const SOURCE_KEYS_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261108000100_app_event_source_keys.sql");
const TIMEZONE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260925138000_patient_activity_summary.sql");
const APP_REVIEW_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261209100000_app_review_event_insights.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("app-events.sql.test: PostgreSQL binaries not on PATH — SQL suite skipped");
}

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.providers (provider_id text primary key, office_name text, provider_name text, access_disabled boolean default false);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id), timezone text,
  auth_user_id uuid, activation_status text not null default 'activated', archived_at timestamptz,
  created_at timestamptz not null default now());
create table public.patient_diary_entries (
  patient_id uuid references public.patients(id), entry_id text, date_key date not null,
  created_at timestamptz not null default now(), primary key (patient_id, entry_id));
create table public.patient_water_days (
  patient_id uuid references public.patients(id), date_key date not null, oz integer not null,
  primary key (patient_id, date_key));
create table public.patient_check_ins (
  patient_id uuid references public.patients(id), date_key date not null, check_in_id text not null,
  weight numeric, created_at timestamptz not null default now(), primary key (patient_id, date_key));
create table public.patient_health_measurements (
  patient_id uuid references public.patients(id), source text, source_id text, kind text,
  value numeric, measured_at timestamptz not null, primary key (patient_id, source, source_id));
create table public.patient_progress_photos (
  patient_id uuid references public.patients(id), photo_id text, date_key date not null,
  created_at timestamptz not null default now(), primary key (patient_id, photo_id));
create table public.patient_chat_conversations (
  id uuid primary key, patient_id uuid references public.patients(id), thread text not null default 'coach');
create table public.patient_chat_messages (
  conversation_id uuid references public.patient_chat_conversations(id), client_id text, role text not null,
  created_at timestamptz not null default now(), primary key (conversation_id, client_id));
create table public.patient_medication_dose_logs (
  id uuid primary key, patient_id uuid references public.patients(id), logged_at timestamptz not null default now());
create table public.billing_orders (
  id uuid primary key, provider_id text not null, patient_id uuid references public.patients(id),
  status text not null, paid_at timestamptz);
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
`;

let dir = "";
let dataDir = "";
const PORT = 54_600 + (process.pid % 1000);

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

function scalar(sql: string, role = "service_role"): string {
  return psql(`set test.role = '${role}'; ${sql};`).trim();
}

function fails(sql: string, role = "service_role"): string {
  const result = spawnSync(
    "psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", `set test.role = '${role}'; ${sql};`],
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: "" } },
  );
  if (result.status === 0) throw new Error(`expected failure: ${sql}`);
  return result.stderr;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const OFFICE_A = "office-a";
const OFFICE_B = "office-b";
const OFFICE_OFF = "office-off";
const NY = uuid(1); // America/New_York
const TOKYO = uuid(2); // Asia/Tokyo
const UTC_PATIENT = uuid(3); // no timezone → UTC fallback
const B_PATIENT = uuid(4); // office B
const ARCHIVED = uuid(5);
const STAFF_ONLY = uuid(6); // no auth user
const OFF_PATIENT = uuid(7); // disabled office
const OFFICE_REVIEW = "office-app-review";
const REVIEW_PATIENT = uuid(8); // App Review office (not a customer)

/** Fresh aggregate straight from the raw rows — the truth the read must match. */
function rawAggregate(feature: string, start: string, end: string, office: string | null) {
  return rows(`
    select e.local_day::text as local_day, e.local_hour, count(*)::int as events, count(distinct e.patient_id)::int as patients
    from patient_app_events e join providers pr on pr.provider_id = e.provider_id
    where e.feature = '${feature}' and e.local_day between '${start}' and '${end}'
      and coalesce(pr.access_disabled, false) = false and coalesce(pr.app_review, false) = false
      ${office ? `and e.provider_id = '${office}'` : ""}
    group by e.local_day, e.local_hour order by 1, 2`);
}
function insights(feature: string, start: string, end: string, office: string | null) {
  return rows(`
    select local_day::text as local_day, local_hour, events::int as events, patients::int as patients
    from public.patient_app_event_insights('${feature}', '${start}', '${end}', ${office ? `'${office}'` : "null"})`);
}
function rollup(now: string, dryRun = false) {
  return rows<{ days_rolled: number; events_rolled: number; days_finalized: number; dirty_remaining: number }>(
    `select days_rolled, events_rolled::int as events_rolled, days_finalized, dirty_remaining from public.patient_app_events_rollup('${now}', ${dryRun})`,
  )[0];
}

describe.skipIf(!POSTGRES_AVAILABLE)("patient app events + rollups + insights (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ae-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    const tzSource = readFileSync(TIMEZONE_MIGRATION, "utf8");
    const tzStart = tzSource.indexOf("create or replace function public.patient_effective_timezone");
    const tzEnd = tzSource.indexOf("create or replace function public.provider_patient_activity_summary");
    const tzFile = path.join(dir, "tz.sql");
    writeFileSync(tzFile, tzSource.slice(tzStart, tzEnd));
    for (const file of [schemaFile, tzFile, PRESENCE_MIGRATION, MIGRATION, SOURCE_KEYS_MIGRATION, APP_REVIEW_MIGRATION]) {
      execFileSync(
        "psql",
        ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file],
        { stdio: "pipe", encoding: "utf8" },
      );
    }
    psql(`
      insert into providers (provider_id, office_name, provider_name, access_disabled) values
        ('${OFFICE_A}', 'Harbor', 'Dr A', false), ('${OFFICE_B}', 'Summit', 'Dr B', false), ('${OFFICE_OFF}', 'Closed', 'Dr C', true);
      insert into patients (id, provider_id, timezone, auth_user_id, archived_at) values
        ('${NY}', '${OFFICE_A}', 'America/New_York', '${uuid(101)}', null),
        ('${TOKYO}', '${OFFICE_A}', 'Asia/Tokyo', '${uuid(102)}', null),
        ('${UTC_PATIENT}', '${OFFICE_A}', null, '${uuid(103)}', null),
        ('${B_PATIENT}', '${OFFICE_B}', 'America/Chicago', '${uuid(104)}', null),
        ('${ARCHIVED}', '${OFFICE_A}', 'America/New_York', '${uuid(105)}', now()),
        ('${STAFF_ONLY}', '${OFFICE_A}', 'America/New_York', null, null),
        ('${OFF_PATIENT}', '${OFFICE_OFF}', 'America/New_York', '${uuid(107)}', null);
    `);
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies the canonical migration verbatim, gates every RPC on the service role, and installs the identity write guard", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("patient_app_event_insights");
    expect(rows("select proname from pg_proc where proname like 'patient_app_event%' and pronamespace = 'public'::regnamespace order by 1")).toEqual([
      { proname: "patient_app_event_bounds" },
      { proname: "patient_app_event_insights" },
      { proname: "patient_app_event_record" },
      { proname: "patient_app_events_backfill" },
      { proname: "patient_app_events_dedupe" },
      { proname: "patient_app_events_rollup" },
    ]);
    // Exactly one overload of the record RPC (PostgREST needs an unambiguous
    // call) and it is the keyed one, still SECURITY DEFINER.
    expect(rows("select pg_get_function_identity_arguments(oid) as args, prosecdef from pg_proc where proname = 'patient_app_event_record'")).toEqual([
      { args: "p_patient_id uuid, p_feature text, p_platform text, p_at timestamp with time zone, p_count integer, p_source_keys text[]", prosecdef: true },
    ]);
    expect(
      rows("select tgname from pg_trigger where tgrelid = 'public.patient_app_events'::regclass and not tgisinternal order by 1"),
    ).toEqual([{ tgname: "patient_app_event_mark_dirty" }, { tgname: "patient_identity_write_guard" }]);
    for (const call of [
      `public.patient_app_event_record('${NY}', 'food_log')`,
      "public.patient_app_events_rollup(now(), true)",
      "public.patient_app_event_insights('food_log', '2026-09-01', '2026-09-02', null)",
      "public.patient_app_event_bounds('food_log', null)",
      "public.patient_app_events_backfill('food_log', now(), 10, true)",
      "public.patient_app_events_dedupe('coach_message', true)",
    ]) {
      expect(fails(`select * from ${call}`, "authenticated")).toContain("service role required");
    }
    for (const table of ["patient_app_events", "patient_app_event_rollups", "patient_app_event_days"]) {
      expect(scalar(`select has_table_privilege('authenticated', 'public.${table}', 'SELECT')`)).toBe("f");
      expect(scalar(`select has_table_privilege('service_role', 'public.${table}', 'SELECT')`)).toBe("t");
    }
  });

  it("records the patient's LOCAL day, weekday, and hour, and rejects unknown or archived patients", () => {
    // 2026-09-10 01:30Z is Wed 21:30 in New York (Sep 9), Thu 10:30 in Tokyo, Thu 01:30 UTC.
    expect(scalar(`select public.patient_app_event_record('${NY}', 'food_log', 'ios', '2026-09-10T01:30:00Z', 2)`)).toBe("2");
    expect(scalar(`select public.patient_app_event_record('${TOKYO}', 'food_log', 'android', '2026-09-10T01:30:00Z')`)).toBe("1");
    expect(scalar(`select public.patient_app_event_record('${UTC_PATIENT}', 'food_log', 'bogus', '2026-09-10T01:30:00Z')`)).toBe("1");
    expect(
      rows("select patient_id, local_day::text as local_day, local_weekday, local_hour, platform, source, count(*)::int as n from patient_app_events group by 1,2,3,4,5,6 order by patient_id"),
    ).toEqual([
      { patient_id: NY, local_day: "2026-09-09", local_weekday: 3, local_hour: 21, platform: "ios", source: "live", n: 2 },
      { patient_id: TOKYO, local_day: "2026-09-10", local_weekday: 4, local_hour: 10, platform: "android", source: "live", n: 1 },
      { patient_id: UTC_PATIENT, local_day: "2026-09-10", local_weekday: 4, local_hour: 1, platform: "unknown", source: "live", n: 1 },
    ]);
    expect(fails(`select public.patient_app_event_record('${ARCHIVED}', 'food_log')`)).toContain("unknown patient");
    expect(fails(`select public.patient_app_event_record('${uuid(999)}', 'food_log')`)).toContain("unknown patient");
    expect(fails(`select public.patient_app_event_record('${NY}', 'made_up')`)).toContain("violates check constraint");
    expect(scalar(`select public.patient_app_event_record('${NY}', 'food_log', 'ios', now(), 0)`)).toBe("0");
    // Both local days are now dirty.
    expect(rows("select local_day::text as local_day, dirty from patient_app_event_days order by 1")).toEqual([
      { local_day: "2026-09-09", dirty: true },
      { local_day: "2026-09-10", dirty: true },
    ]);
  });

  it("the presence touch writes one app_open event alongside the presence row", () => {
    expect(rows(`select local_day::text as local_day, first_touch_today from public.patient_app_presence_touch('${NY}', 'ios', '2026-09-10T14:05:00Z')`)).toEqual([
      { local_day: "2026-09-10", first_touch_today: true },
    ]);
    expect(rows(`select feature, local_day::text as local_day, local_hour, platform from patient_app_events where patient_id = '${NY}' and feature = 'app_open'`)).toEqual([
      { feature: "app_open", local_day: "2026-09-10", local_hour: 10, platform: "ios" },
    ]);
    expect(scalar(`select touches from patient_app_presence where patient_id = '${NY}' and day = '2026-09-10'`)).toBe("1");
  });

  it("rollup + tail equals the raw aggregate before, during, and after rollups; only closed days finalize; dry runs write nothing", () => {
    // Seed a spread of food logs across days / hours / offices, including a disabled office.
    const seeds: Array<[string, string, string]> = [
      [NY, "food_log", "2026-09-01T12:00:00Z"], [NY, "food_log", "2026-09-01T23:30:00Z"], [NY, "food_log", "2026-09-02T12:00:00Z"],
      [TOKYO, "food_log", "2026-09-01T12:00:00Z"], [TOKYO, "food_log", "2026-09-03T02:00:00Z"],
      [B_PATIENT, "food_log", "2026-09-02T18:00:00Z"], [B_PATIENT, "food_log", "2026-09-02T18:10:00Z"],
      [OFF_PATIENT, "food_log", "2026-09-02T18:10:00Z"],
      [NY, "water_log", "2026-09-02T12:00:00Z"],
    ];
    for (const [patient, feature, at] of seeds) {
      psql(`set test.role = 'service_role'; select public.patient_app_event_record('${patient}', '${feature}', 'ios', '${at}')`);
    }
    const range = ["2026-08-31", "2026-09-10"] as const;
    const before = rawAggregate("food_log", ...range, null);
    expect(before.length).toBeGreaterThan(3);
    // Nothing rolled yet: every day is served from the raw rows.
    expect(insights("food_log", ...range, null)).toEqual(before);
    expect(insights("food_log", ...range, OFFICE_B)).toEqual(rawAggregate("food_log", ...range, OFFICE_B));
    expect(insights("food_log", ...range, OFFICE_OFF)).toEqual([]);

    // Dry run: reports the work, writes nothing.
    const dry = rollup("2026-09-10T15:00:00Z", true);
    expect(dry.days_rolled).toBe(rows("select 1 from patient_app_event_days where dirty").length);
    expect(dry.events_rolled).toBe(Number(scalar("select count(*) from patient_app_events")));
    expect(scalar("select count(*) from patient_app_event_rollups")).toBe("0");
    expect(scalar("select count(*) from patient_app_event_days where not dirty")).toBe("0");

    // Real run at 2026-09-10 15:00Z: days before 2026-09-09 are closed everywhere (09-09 may still be live in UTC-12).
    const first = rollup("2026-09-10T15:00:00Z");
    expect(first).toEqual({ days_rolled: dry.days_rolled, events_rolled: dry.events_rolled, days_finalized: 3, dirty_remaining: 0 });
    expect(rows("select local_day::text as local_day, dirty, finalized_at is not null as finalized from patient_app_event_days order by 1")).toEqual([
      { local_day: "2026-09-01", dirty: false, finalized: true },
      { local_day: "2026-09-02", dirty: false, finalized: true },
      { local_day: "2026-09-03", dirty: false, finalized: true },
      { local_day: "2026-09-09", dirty: false, finalized: false },
      { local_day: "2026-09-10", dirty: false, finalized: false },
    ]);
    // Rollups carry distinct patients per bucket and exclude nothing (the read filters offices).
    expect(rows(`select events, patients from patient_app_event_rollups where local_day = '2026-09-02' and local_hour = 13 and provider_id = '${OFFICE_B}' and feature = 'food_log'`)).toEqual([{ events: 2, patients: 1 }]);
    expect(insights("food_log", ...range, null)).toEqual(before);
    expect(insights("food_log", ...range, OFFICE_A)).toEqual(rawAggregate("food_log", ...range, OFFICE_A));
    expect(insights("water_log", ...range, null)).toEqual(rawAggregate("water_log", ...range, null));

    // A second run with nothing dirty is a no-op.
    expect(rollup("2026-09-10T15:15:00Z")).toEqual({ days_rolled: 0, events_rolled: 0, days_finalized: 0, dirty_remaining: 0 });

    // A late event on a finalized day: served raw immediately, re-rolled next run.
    psql(`set test.role = 'service_role'; select public.patient_app_event_record('${NY}', 'food_log', 'web', '2026-09-01T13:00:00Z')`);
    expect(rows("select dirty from patient_app_event_days where local_day = '2026-09-01'")).toEqual([{ dirty: true }]);
    const after = rawAggregate("food_log", ...range, null);
    expect(after).not.toEqual(before);
    expect(insights("food_log", ...range, null)).toEqual(after);
    expect(rollup("2026-09-10T15:30:00Z")).toEqual({ days_rolled: 1, events_rolled: Number(scalar("select count(*) from patient_app_events where local_day = '2026-09-01'")), days_finalized: 1, dirty_remaining: 0 });
    expect(insights("food_log", ...range, null)).toEqual(after);

    // Purging a patient (plain deletes, as patient_purge_rows does) re-dirties their days so their counts drop out.
    psql(`set test.role = 'service_role'; delete from patient_app_events where patient_id = '${B_PATIENT}'`);
    expect(rows("select local_day::text as local_day from patient_app_event_days where dirty order by 1")).toEqual([{ local_day: "2026-09-02" }]);
    const purged = rawAggregate("food_log", ...range, null);
    expect(insights("food_log", ...range, null)).toEqual(purged);
    expect(insights("food_log", ...range, OFFICE_B)).toEqual([]);
    rollup("2026-09-10T15:45:00Z");
    expect(insights("food_log", ...range, null)).toEqual(purged);
    expect(scalar(`select count(*) from patient_app_event_rollups where provider_id = '${OFFICE_B}'`)).toBe("0");
  });

  it("rejects an inverted or oversized range", () => {
    expect(fails("select * from public.patient_app_event_insights('food_log', '2026-09-02', '2026-09-01', null)")).toContain("invalid range");
    expect(fails("select * from public.patient_app_event_insights('food_log', '2020-01-01', '2026-09-01', null)")).toContain("invalid range");
  });

  it("backfills timestamped sources with their local hour, day-only sources with hour -1, in idempotent batches before the live boundary", () => {
    psql(`
      set test.role = 'service_role';
      insert into patient_diary_entries (patient_id, entry_id, date_key, created_at) values
        ('${NY}', 'e1', '2026-08-01', '2026-08-01T23:30:00Z'),
        ('${NY}', 'e2', '2026-08-02', '2026-08-02T12:00:00Z'),
        ('${TOKYO}', 'e3', '2026-08-02', '2026-08-02T12:00:00Z'),
        ('${STAFF_ONLY}', 'e4', '2026-08-02', '2026-08-02T12:00:00Z'),
        ('${NY}', 'e5', '2026-09-20', '2026-09-20T12:00:00Z');
      insert into patient_water_days (patient_id, date_key, oz) values ('${NY}', '2026-08-03', 64), ('${NY}', '2026-08-04', 0);
      insert into patient_check_ins (patient_id, date_key, check_in_id, weight, created_at) values
        ('${NY}', '2026-08-05', 'c1', 180.2, '2026-08-05T11:00:00Z'), ('${NY}', '2026-08-06', 'c2', null, '2026-08-06T11:00:00Z');
      insert into patient_progress_photos (patient_id, photo_id, date_key, created_at) values ('${B_PATIENT}', 'ph1', '2026-08-05', '2026-08-05T20:00:00Z');
      insert into patient_chat_conversations (id, patient_id, thread) values ('${uuid(201)}', '${NY}', 'coach'), ('${uuid(202)}', '${NY}', 'care_team');
      insert into patient_chat_messages (conversation_id, client_id, role, created_at) values
        ('${uuid(201)}', 'm1', 'user', '2026-08-07T13:00:00Z'), ('${uuid(201)}', 'm2', 'assistant', '2026-08-07T13:00:05Z'),
        ('${uuid(202)}', 'm3', 'user', '2026-08-08T13:00:00Z');
      insert into patient_medication_dose_logs (id, patient_id, logged_at) values ('${uuid(301)}', '${NY}', '2026-08-09T12:30:00Z');
      insert into billing_orders (id, provider_id, patient_id, status, paid_at) values
        ('${uuid(401)}', '${OFFICE_A}', '${NY}', 'paid', '2026-08-10T16:00:00Z'),
        ('${uuid(402)}', '${OFFICE_A}', '${NY}', 'pending', null);
      insert into patient_app_presence (patient_id, day, first_seen_at, last_seen_at, platform, touches) values
        ('${TOKYO}', '2026-08-11', '2026-08-11T01:00:00Z', '2026-08-11T02:00:00Z', 'android', 3);
    `);
    const boundary = "2026-09-01T00:00:00Z";
    // Dry run counts candidates without inserting.
    expect(scalar(`select public.patient_app_events_backfill('food_log', '${boundary}', 100, true)`)).toBe("3");
    expect(scalar("select count(*) from patient_app_events where source = 'backfill'")).toBe("0");
    // Batched: two at a time, then the remainder, then nothing.
    expect(scalar(`select public.patient_app_events_backfill('food_log', '${boundary}', 2)`)).toBe("2");
    expect(scalar(`select public.patient_app_events_backfill('food_log', '${boundary}', 2)`)).toBe("1");
    expect(scalar(`select public.patient_app_events_backfill('food_log', '${boundary}', 2)`)).toBe("0");
    expect(
      rows("select patient_id, local_day::text as local_day, local_weekday, local_hour, source_key from patient_app_events where source = 'backfill' and feature = 'food_log' order by source_key"),
    ).toEqual([
      { patient_id: NY, local_day: "2026-08-01", local_weekday: 6, local_hour: 19, source_key: `${NY}:e1` },
      { patient_id: NY, local_day: "2026-08-02", local_weekday: 0, local_hour: 8, source_key: `${NY}:e2` },
      { patient_id: TOKYO, local_day: "2026-08-02", local_weekday: 0, local_hour: 21, source_key: `${TOKYO}:e3` },
    ]);
    const expected: Record<string, Array<Record<string, unknown>>> = {
      water_log: [{ local_day: "2026-08-03", local_hour: -1 }],
      weigh_in: [{ local_day: "2026-08-05", local_hour: 7 }],
      progress_photo: [{ local_day: "2026-08-05", local_hour: 15 }],
      coach_message: [{ local_day: "2026-08-07", local_hour: 9 }],
      care_team_message: [{ local_day: "2026-08-08", local_hour: 9 }],
      medication_log: [{ local_day: "2026-08-09", local_hour: 8 }],
      order: [{ local_day: "2026-08-10", local_hour: 12 }],
      app_open: [{ local_day: "2026-08-11", local_hour: -1 }],
    };
    for (const [feature, want] of Object.entries(expected)) {
      expect(scalar(`select public.patient_app_events_backfill('${feature}', '${boundary}', 100)`), feature).toBe(String(want.length));
      expect(scalar(`select public.patient_app_events_backfill('${feature}', '${boundary}', 100)`), feature).toBe("0");
      expect(rows(`select local_day::text as local_day, local_hour from patient_app_events where source = 'backfill' and feature = '${feature}' order by 1`), feature).toEqual(want);
    }
    expect(scalar("select platform from patient_app_events where source = 'backfill' and feature = 'app_open'")).toBe("android");
    expect(fails("select public.patient_app_events_backfill('made_up', now(), 10)")).toContain("unknown feature");
    // Bounds: first day overall, first day with a real hour, first live instant.
    expect(rows("select first_day::text as first_day, first_hourly_day::text as first_hourly_day, first_live_at is not null as has_live from public.patient_app_event_bounds('water_log', null)")).toEqual([
      { first_day: "2026-08-03", first_hourly_day: "2026-09-02", has_live: true },
    ]);
    expect(rows("select first_day::text as first_day, first_hourly_day::text as first_hourly_day, first_live_at from public.patient_app_event_bounds('order', null)")).toEqual([
      { first_day: "2026-08-10", first_hourly_day: "2026-08-10", first_live_at: null },
    ]);
    expect(rows(`select first_day from public.patient_app_event_bounds('order', '${OFFICE_B}')`)).toEqual([{ first_day: null }]);
    // Backfilled day-only rows count in the series but carry no hour.
    expect(insights("water_log", "2026-08-01", "2026-08-31", null)).toEqual([{ local_day: "2026-08-03", local_hour: -1, events: 1, patients: 1 }]);
  });

  it("keyed live events: a replayed message id inserts one row, a backfilled twin collides, blank keys count nothing", () => {
    const conv = uuid(201);
    const record = (feature: string, keys: string[], at = "2026-09-12T13:00:00Z") =>
      scalar(`select public.patient_app_event_record('${NY}', '${feature}', 'ios', '${at}', 1, array[${keys.map((key) => `'${key}'`).join(",")}]::text[])`);
    // First save of two patient messages: two rows, both keyed, local-time columns as usual.
    expect(record("coach_message", [`${conv}:m9`, `${conv}:m10`])).toBe("2");
    // The app replays the finalized transcript: nothing new lands.
    expect(record("coach_message", [`${conv}:m9`, `${conv}:m10`])).toBe("0");
    // A batch mixing one seen and one new message counts exactly the new one.
    expect(record("coach_message", [`${conv}:m10`, `${conv}:m11`])).toBe("1");
    // The same key repeated inside one call is one row.
    expect(record("coach_message", [`${conv}:m12`, `${conv}:m12`])).toBe("1");
    expect(
      rows(`select source_key, local_day::text as local_day, local_hour, platform, source from patient_app_events where feature = 'coach_message' and source = 'live' and source_key is not null order by source_key`),
    ).toEqual([
      { source_key: `${conv}:m10`, local_day: "2026-09-12", local_hour: 9, platform: "ios", source: "live" },
      { source_key: `${conv}:m11`, local_day: "2026-09-12", local_hour: 9, platform: "ios", source: "live" },
      { source_key: `${conv}:m12`, local_day: "2026-09-12", local_hour: 9, platform: "ios", source: "live" },
      { source_key: `${conv}:m9`, local_day: "2026-09-12", local_hour: 9, platform: "ios", source: "live" },
    ]);
    // Live keys share the backfill's format, so a live write for an already backfilled entry collides.
    expect(record("food_log", [`${NY}:e1`])).toBe("0");
    expect(scalar(`select count(*) from patient_app_events where source_key = '${NY}:e1'`)).toBe("1");
    // Blank / empty key lists record nothing; p_count is ignored in keyed mode.
    expect(scalar(`select public.patient_app_event_record('${NY}', 'food_log', 'ios', now(), 7, array['', null]::text[])`)).toBe("0");
    expect(scalar(`select public.patient_app_event_record('${NY}', 'food_log', 'ios', now(), 7, array[]::text[])`)).toBe("0");
    // Keyed mode still rejects unknown / archived patients and other roles.
    expect(fails(`select public.patient_app_event_record('${ARCHIVED}', 'food_log', 'ios', now(), 1, array['${ARCHIVED}:x']::text[])`)).toContain("unknown patient");
    expect(fails(`select public.patient_app_event_record('${NY}', 'food_log', 'ios', now(), 1, array['${NY}:x']::text[])`, "authenticated")).toContain("service role required");
  });

  it("dedupe repairs rows recorded before keys existed: stamps the paired event, deletes the surplus, leaves history without source rows alone", () => {
    const conv = uuid(201);
    const live = (patient: string, at: string, feature = "coach_message") =>
      scalar(`select public.patient_app_event_record('${patient}', '${feature}', 'web', '${at}')`);
    psql(`
      set test.role = 'service_role';
      insert into patient_chat_messages (conversation_id, client_id, role, created_at) values
        ('${conv}', 'm20', 'user', '2026-09-14T10:00:00Z'),
        ('${conv}', 'm21', 'user', '2026-09-14T11:00:00Z'),
        ('${conv}', 'm22', 'user', '2026-09-14T12:00:00Z'),
        ('${conv}', 'm23', 'assistant', '2026-09-14T12:00:04Z');
    `);
    // m20 was recorded twice by the old seam (a replay), m21 once, m22 once by
    // the old seam and once more by the new keyed seam.
    live(NY, "2026-09-14T10:00:05Z"); live(NY, "2026-09-14T10:00:06Z");
    live(NY, "2026-09-14T11:00:02Z");
    live(NY, "2026-09-14T12:00:03Z");
    scalar(`select public.patient_app_event_record('${NY}', 'coach_message', 'ios', '2026-09-14T12:00:03Z', 1, array['${conv}:m22']::text[])`);
    // History that must be left alone: an unkeyed event older than NY's oldest
    // surviving message (retention trimmed its source), and TOKYO's events
    // (no surviving messages at all, so no floor).
    live(NY, "2026-07-01T10:00:00Z");
    live(TOKYO, "2026-09-13T10:00:00Z");
    const unkeyed = () => rows(`select patient_id, occurred_at::text as at from patient_app_events where feature = 'coach_message' and source = 'live' and source_key is null order by patient_id, occurred_at`);
    const before = unkeyed();
    expect(before).toHaveLength(6);
    const total = scalar("select count(*) from patient_app_events");
    rollup("2026-09-16T15:00:00Z");
    expect(scalar("select count(*) from patient_app_event_days where dirty")).toBe("0");

    // Dry run reports the repair and writes nothing.
    expect(rows("select keyed, removed from public.patient_app_events_dedupe('coach_message', true)")).toEqual([{ keyed: 2, removed: 2 }]);
    expect(unkeyed()).toEqual(before);
    expect(scalar("select count(*) from patient_app_events")).toBe(total);
    expect(scalar("select count(*) from patient_app_event_days where dirty")).toBe("0");

    // Real run: m20 and m21 get their keys (oldest event in the hour), the two surplus rows go.
    expect(rows("select keyed, removed from public.patient_app_events_dedupe('coach_message', false)")).toEqual([{ keyed: 2, removed: 2 }]);
    expect(rows(`select source_key, occurred_at::text as at, platform from patient_app_events where source_key in ('${conv}:m20', '${conv}:m21', '${conv}:m22') order by source_key`)).toEqual([
      { source_key: `${conv}:m20`, at: "2026-09-14 10:00:05+00", platform: "web" },
      { source_key: `${conv}:m21`, at: "2026-09-14 11:00:02+00", platform: "web" },
      { source_key: `${conv}:m22`, at: "2026-09-14 12:00:03+00", platform: "ios" },
    ]);
    expect(unkeyed()).toEqual([
      { patient_id: NY, at: "2026-07-01 10:00:00+00" },
      { patient_id: TOKYO, at: "2026-09-13 10:00:00+00" },
    ]);
    expect(Number(scalar("select count(*) from patient_app_events"))).toBe(Number(total) - 2);
    // The day is dirty again so the next rollup re-rolls it; a replay of a repaired message inserts nothing.
    expect(rows("select local_day::text as local_day from patient_app_event_days where dirty")).toEqual([{ local_day: "2026-09-14" }]);
    expect(scalar(`select public.patient_app_event_record('${NY}', 'coach_message', 'ios', now(), 1, array['${conv}:m20']::text[])`)).toBe("0");
    // Idempotent: a second run finds nothing.
    expect(rows("select keyed, removed from public.patient_app_events_dedupe('coach_message', false)")).toEqual([{ keyed: 0, removed: 0 }]);
    expect(fails("select * from public.patient_app_events_dedupe('app_open', true)")).toContain("unsupported feature");
  });

  it("leaves the App Review office out of network insights and bounds, rolled or raw", () => {
    const range: [string, string] = ["2026-09-01", "2026-09-30"];
    const beforeNetwork = insights("progress_photo", ...range, null);
    const beforeBounds = rows("select first_day::text as first_day from public.patient_app_event_bounds('progress_photo', null)");
    psql(`
      insert into providers (provider_id, office_name, provider_name, access_disabled, app_review) values
        ('${OFFICE_REVIEW}', 'THINNR App Review', 'App Review', false, true);
      insert into patients (id, provider_id, timezone, auth_user_id, archived_at) values
        ('${REVIEW_PATIENT}', '${OFFICE_REVIEW}', 'America/New_York', '${uuid(108)}', null);
      set test.role = 'service_role';
      select public.patient_app_event_record('${REVIEW_PATIENT}', 'progress_photo', 'ios', '2026-09-03T15:00:00Z', 3);
      select public.patient_app_event_record('${REVIEW_PATIENT}', 'progress_photo', 'ios', '2026-09-20T15:00:00Z', 1);
    `);
    // The raw rows exist; the network reads do not see them.
    expect(scalar(`select count(*) from patient_app_events where provider_id = '${OFFICE_REVIEW}'`)).toBe("4");
    expect(insights("progress_photo", ...range, null)).toEqual(beforeNetwork);
    expect(insights("progress_photo", ...range, null)).toEqual(rawAggregate("progress_photo", ...range, null));
    expect(rows("select first_day::text as first_day from public.patient_app_event_bounds('progress_photo', null)")).toEqual(beforeBounds);
    // Naming the review office explicitly reads nothing either: it is not a customer anywhere in Insights.
    expect(insights("progress_photo", ...range, OFFICE_REVIEW)).toEqual([]);
    expect(rows(`select first_day from public.patient_app_event_bounds('progress_photo', '${OFFICE_REVIEW}')`)).toEqual([{ first_day: null }]);
    // Rolled-up days are excluded the same way as the raw tail.
    rollup("2026-10-02T15:00:00Z");
    expect(insights("progress_photo", ...range, null)).toEqual(beforeNetwork);
    expect(insights("progress_photo", ...range, OFFICE_REVIEW)).toEqual([]);
  });
});
