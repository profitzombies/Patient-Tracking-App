/**
 * The HQ active-app-user aggregates, run for real.
 *
 * Boots a throwaway PostgreSQL cluster (unix socket only), applies the
 * canonical presence/usage migration verbatim on top of a minimal mirror of
 * the patient tables, seeds fixtures, and asserts:
 *
 *  - the presence touch is an idempotent upsert on the patient's LOCAL day;
 *  - distinct counting across the 7- and 30-day windows (a patient active on
 *    several days counts once; presence-only days count like logged days);
 *  - offices that predate the dataset / have no patients still return a row
 *    with first_patient_date = null so callers can report "unavailable";
 *  - the daily series' last point matches the range-end point figures;
 *  - staff-only accounts (no auth user) and archived patients never count;
 *  - service-role gating and grants, plus the identity write guard landing
 *    on the new table.
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
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261026000000_patient_app_presence.sql");
const TIMEZONE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260925138000_patient_activity_summary.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("app-usage.sql.test: PostgreSQL binaries not on PATH — SQL aggregate suite skipped");
}

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.providers (provider_id text primary key, office_name text, provider_name text, access_disabled boolean default false);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id), timezone text,
  auth_user_id uuid, activation_status text not null default 'activated', archived_at timestamptz,
  last_log_date date, last_login_at timestamptz, created_at timestamptz not null default now());
create table public.patient_diary_entries (
  patient_id uuid references public.patients(id), entry_id text, date_key date not null,
  calories numeric not null default 0, primary key (patient_id, entry_id));
create table public.patient_water_days (
  patient_id uuid references public.patients(id), date_key date not null, oz integer not null,
  primary key (patient_id, date_key));
create table public.patient_check_ins (
  patient_id uuid references public.patients(id), date_key date not null, check_in_id text not null,
  weight numeric, mood integer not null default 3, side_effects jsonb not null default '[]'::jsonb,
  primary key (patient_id, date_key));
create table public.patient_health_measurements (
  patient_id uuid references public.patients(id), source text, source_id text, kind text,
  value numeric, measured_at timestamptz not null, primary key (patient_id, source, source_id));
create table public.patient_progress_photos (
  patient_id uuid references public.patients(id), photo_id text, date_key date not null,
  primary key (patient_id, photo_id));
create table public.patient_chat_conversations (
  id uuid primary key, patient_id uuid references public.patients(id), thread text not null default 'coach');
create table public.patient_chat_messages (
  conversation_id uuid references public.patient_chat_conversations(id), client_id text, role text not null,
  created_at timestamptz not null default now(), primary key (conversation_id, client_id));
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

interface PatientOptions {
  timezone?: string | null;
  real?: boolean;
  archived?: boolean;
  status?: string;
  createdAt?: string;
}

function insertPatient(n: number, provider: string, options: PatientOptions = {}) {
  const timezone = options.timezone === undefined ? "UTC" : options.timezone;
  const real = options.real ?? true;
  psql(
    `insert into public.patients (id, provider_id, timezone, auth_user_id, activation_status, archived_at, created_at) values (
      '${uuid(n)}', '${provider}', ${timezone === null ? "null" : `'${timezone}'`},
      ${real ? `'${uuid(1000 + n)}'` : "null"}, '${options.status ?? "activated"}',
      ${options.archived ? "now()" : "null"}, '${options.createdAt ?? "2026-01-01T00:00:00Z"}')`,
  );
}

function touch(n: number, at: string, platform = "ios") {
  return rows<{ local_day: string; first_touch_today: boolean }>(
    `select * from public.patient_app_presence_touch('${uuid(n)}', '${platform}', '${at}'::timestamptz)`,
  )[0];
}

function insertDiary(n: number, days: string[]) {
  const values = days.map((day) => `('${uuid(n)}', 'e-${n}-${day}', '${day}', 100)`).join(",");
  psql(`insert into public.patient_diary_entries (patient_id, entry_id, date_key, calories) values ${values}`);
}

function insertCoachMessage(n: number, at: string, role = "user") {
  psql(
    `insert into public.patient_chat_conversations (id, patient_id) values ('${uuid(5000 + n)}', '${uuid(n)}') on conflict do nothing;
     insert into public.patient_chat_messages (conversation_id, client_id, role, created_at) values ('${uuid(5000 + n)}', 'm-${at}', '${role}', '${at}'::timestamptz)`,
  );
}

function resetData() {
  psql(
    "truncate public.patient_chat_messages, public.patient_chat_conversations, public.patient_app_presence, public.patient_diary_entries, public.patient_water_days, public.patient_check_ins, public.patient_health_measurements, public.patient_progress_photos, public.patients, public.providers",
  );
  psql(
    "insert into public.providers (provider_id, office_name, provider_name, access_disabled) values ('office-a', 'Alpha Clinic', 'Dr. Alpha', false), ('office-b', 'Beta Clinic', 'Dr. Beta', false), ('office-off', 'Disabled Clinic', 'Dr. Off', true)",
  );
}

interface OfficeRow {
  provider_id: string;
  first_patient_date: string | null;
  activated_patients: number;
  activated_patients_now: number;
  active_now: number;
  active_today: number;
  weekly_active_today: number;
  monthly_active_today: number;
  weekly_active: number;
  monthly_active: number;
}

function offices(start: string, end: string, at: string) {
  return rows<OfficeRow>(
    `select * from public.patient_app_usage_offices('${start}', '${end}', '${at}'::timestamptz)`,
  );
}

function daily(start: string, end: string) {
  return rows<{ provider_id: string; date: string; weekly_active: number; monthly_active: number }>(
    `select * from public.patient_app_usage_daily('${start}', '${end}')`,
  );
}

const byOffice = (list: OfficeRow[]) => Object.fromEntries(list.map((row) => [row.provider_id, row]));

describe.skipIf(!POSTGRES_AVAILABLE)("patient app presence + usage aggregates (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "au-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    // Only the timezone helper is needed from the earlier migration.
    const tzSource = readFileSync(TIMEZONE_MIGRATION, "utf8");
    const tzStart = tzSource.indexOf("create or replace function public.patient_effective_timezone");
    const tzEnd = tzSource.indexOf("create or replace function public.provider_patient_activity_summary");
    const tzFile = path.join(dir, "tz.sql");
    writeFileSync(tzFile, tzSource.slice(tzStart, tzEnd));
    for (const file of [schemaFile, tzFile, MIGRATION]) {
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

  it("applies the canonical migration verbatim and installs the identity write guard on the presence table", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("patient_app_usage_offices");
    expect(rows("select proname from pg_proc where proname like 'patient_app_%' order by 1")).toEqual([
      { proname: "patient_app_activity_days" },
      { proname: "patient_app_presence_touch" },
      { proname: "patient_app_usage_daily" },
      { proname: "patient_app_usage_offices" },
    ]);
    expect(
      rows("select tgname from pg_trigger where tgrelid = 'public.patient_app_presence'::regclass and not tgisinternal"),
    ).toEqual([{ tgname: "patient_identity_write_guard" }]);
  });

  it("is service-role only", () => {
    resetData();
    insertPatient(1, "office-a");
    for (const role of ["anon", "authenticated"]) {
      expect(() => rows("select * from public.patient_app_usage_offices('2026-09-01', '2026-09-18', now())", role))
        .toThrow(/service role required/);
      expect(() => rows("select * from public.patient_app_usage_daily('2026-09-01', '2026-09-18')", role))
        .toThrow(/service role required/);
      expect(() => rows(`select * from public.patient_app_presence_touch('${uuid(1)}', 'ios', now())`, role))
        .toThrow(/service role required/);
    }
    const grants = rows<{ fn: string; role: string; can: boolean }>(
      `select f.fn, r.role, has_function_privilege(r.role, f.fn, 'execute') as can
         from (values ('public.patient_app_usage_offices(date, date, timestamptz)'),
                      ('public.patient_app_usage_daily(date, date)'),
                      ('public.patient_app_presence_touch(uuid, text, timestamptz)'),
                      ('public.patient_app_activity_days(date, date)')) f(fn)
         cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
         order by 1, 2`,
    );
    for (const grant of grants) expect(grant.can, `${grant.role} on ${grant.fn}`).toBe(grant.role === "service_role");
    expect(rows("select relrowsecurity from pg_class where oid = 'public.patient_app_presence'::regclass"))
      .toEqual([{ relrowsecurity: true }]);
  });

  it("records presence once per LOCAL day and merges repeated touches", () => {
    resetData();
    insertPatient(1, "office-a", { timezone: "America/New_York" });
    // 03:30Z on the 18th is still the evening of the 17th in New York.
    expect(touch(1, "2026-09-18T03:30:00Z")).toEqual({ local_day: "2026-09-17", first_touch_today: true });
    expect(touch(1, "2026-09-18T02:00:00Z", "android")).toEqual({ local_day: "2026-09-17", first_touch_today: false });
    expect(touch(1, "2026-09-18T12:00:00Z", "bogus")).toEqual({ local_day: "2026-09-18", first_touch_today: true });
    expect(rows("select day, first_seen_at, last_seen_at, platform, touches from public.patient_app_presence order by day")).toEqual([
      { day: "2026-09-17", first_seen_at: "2026-09-18T02:00:00+00:00", last_seen_at: "2026-09-18T03:30:00+00:00", platform: "android", touches: 2 },
      { day: "2026-09-18", first_seen_at: "2026-09-18T12:00:00+00:00", last_seen_at: "2026-09-18T12:00:00+00:00", platform: "unknown", touches: 1 },
    ]);
    insertPatient(2, "office-a", { archived: true });
    expect(() => touch(2, "2026-09-18T12:00:00Z")).toThrow(/unknown patient/);
    expect(() => touch(99, "2026-09-18T12:00:00Z")).toThrow(/unknown patient/);
  });

  it("counts each patient once across the 7- and 30-day windows, presence-only days included", () => {
    resetData();
    const at = "2026-09-18T15:00:00Z";
    // p1: presence only, active today and several times this week.
    insertPatient(1, "office-a");
    touch(1, "2026-09-18T14:50:00Z");
    touch(1, "2026-09-16T09:00:00Z");
    touch(1, "2026-09-12T09:00:00Z");
    // p2: logged meals 20 days ago only → monthly, not weekly.
    insertPatient(2, "office-a");
    insertDiary(2, ["2026-08-29", "2026-08-30"]);
    // p3: a coach message 3 days ago → weekly (assistant replies never count).
    insertPatient(3, "office-a");
    insertCoachMessage(3, "2026-09-15T10:00:00Z");
    insertCoachMessage(3, "2026-09-18T10:00:00Z", "assistant");
    // p4: activity 45 days ago → outside every window.
    insertPatient(4, "office-a");
    insertDiary(4, ["2026-08-01"]);
    // p5: invited (no auth user) with a diary row somehow → never counts.
    insertPatient(5, "office-a", { real: false, status: "invited" });
    insertDiary(5, ["2026-09-18"]);
    // p6: archived patient whose old rows remain → never counts.
    insertPatient(6, "office-a", { archived: true });
    psql(`alter table public.patient_diary_entries disable trigger patient_identity_write_guard`);
    insertDiary(6, ["2026-09-18"]);
    psql(`alter table public.patient_diary_entries enable trigger patient_identity_write_guard`);
    // p7: real patient in the disabled office → excluded with the office.
    insertPatient(7, "office-off");
    touch(7, "2026-09-18T14:55:00Z");
    // Beta clinic: one patient active 10 minutes ago (now + today + weekly +
    // monthly for the live figures). In Kiritimati (UTC+14) that instant is
    // already the 19th, which lies past the range end, so the range-anchored
    // figures do not see it.
    insertPatient(8, "office-b", { timezone: "Pacific/Kiritimati" });
    touch(8, "2026-09-18T14:50:00Z");

    const result = byOffice(offices("2026-08-20", "2026-09-18", at));
    expect(Object.keys(result).sort()).toEqual(["office-a", "office-b"]);
    expect(result["office-a"]).toMatchObject({
      first_patient_date: "2026-01-01",
      activated_patients: 4, // p1-p4 (p5 invited, p6 archived)
      activated_patients_now: 4,
      active_now: 1,
      active_today: 1,
      weekly_active_today: 2, // p1, p3
      monthly_active_today: 3, // p1, p2, p3
      weekly_active: 2,
      monthly_active: 3,
    });
    expect(result["office-b"]).toMatchObject({
      active_now: 1,
      active_today: 1,
      weekly_active_today: 1,
      monthly_active_today: 1,
      weekly_active: 0,
      monthly_active: 0,
    });
    // p1 (3 days) + p2 (2) + p3 (1) + p4 (1); p8's local day is the 19th.
    expect(rows("select count(*)::int as n from public.patient_app_activity_days('2026-08-01', '2026-09-18')"))
      .toEqual([{ n: 3 + 2 + 1 + 1 }]);
    expect(rows("select count(*)::int as n from public.patient_app_activity_days('2026-08-01', '2026-09-19')"))
      .toEqual([{ n: 3 + 2 + 1 + 1 + 1 }]);
  });

  it("anchors the range-end figures on the range end while the now-figures follow each patient's local today", () => {
    resetData();
    insertPatient(1, "office-a", { timezone: "Pacific/Kiritimati" });
    insertPatient(2, "office-a", { timezone: "America/Los_Angeles" });
    insertDiary(1, ["2026-09-10"]);
    insertDiary(2, ["2026-09-01"]);
    // Late UTC evening: already the 19th in Kiritimati, still the 18th in LA.
    const at = "2026-09-18T23:30:00Z";
    const [a] = offices("2026-09-01", "2026-09-10", at);
    // Range end 2026-09-10: p1 logged that day (weekly), p2 logged 9 days
    // earlier (monthly only).
    expect(a).toMatchObject({ weekly_active: 1, monthly_active: 2, active_today: 0 });
    // Today for p1 is the 19th → the 10th is 9 days back (monthly only);
    // today for p2 is the 18th → the 1st is 17 days back (monthly).
    expect(a).toMatchObject({ weekly_active_today: 0, monthly_active_today: 2 });
    insertDiary(1, ["2026-09-19"]);
    expect(offices("2026-09-01", "2026-09-10", at)[0]).toMatchObject({ active_today: 1, weekly_active_today: 1 });
  });

  it("returns no first_patient_date for an office without patients and counts activated patients as of the range end", () => {
    resetData();
    insertPatient(1, "office-a", { createdAt: "2026-09-10T00:00:00Z" });
    insertPatient(2, "office-a", { createdAt: "2026-09-16T00:00:00Z" });
    insertPatient(3, "office-a", { createdAt: "2026-09-17T00:00:00Z", status: "invited", real: false });
    const result = byOffice(offices("2026-09-01", "2026-09-12", "2026-09-18T12:00:00Z"));
    expect(result["office-b"]).toMatchObject({ first_patient_date: null, activated_patients: 0, weekly_active: 0, monthly_active: 0 });
    expect(result["office-a"]).toMatchObject({ first_patient_date: "2026-09-10", activated_patients: 1, activated_patients_now: 2 });
  });

  it("builds a rolling daily series whose last point equals the range-end figures", () => {
    resetData();
    insertPatient(1, "office-a");
    insertPatient(2, "office-a");
    insertPatient(3, "office-a");
    insertDiary(1, ["2026-09-01", "2026-09-05"]);
    touch(2, "2026-09-05T12:00:00Z");
    touch(2, "2026-09-06T12:00:00Z");
    insertDiary(3, ["2026-08-10"]);
    const series = daily("2026-09-01", "2026-09-08").filter((row) => row.provider_id === "office-a");
    expect(series.map((row) => [row.date, row.weekly_active, row.monthly_active])).toEqual([
      ["2026-09-01", 1, 2], // p1 today; p3 on 8/10 is 22 days back
      ["2026-09-02", 1, 2],
      ["2026-09-03", 1, 2],
      ["2026-09-04", 1, 2],
      ["2026-09-05", 2, 3], // p1 + p2 today; p3 is 26 days back
      ["2026-09-06", 2, 3],
      ["2026-09-07", 2, 3],
      ["2026-09-08", 2, 3], // p1's 9/1 has rolled out of the week; 9/5 keeps them; p3 29 days back
    ]);
    const [end] = offices("2026-09-01", "2026-09-08", "2026-09-18T12:00:00Z");
    expect([end.weekly_active, end.monthly_active]).toEqual([2, 3]);
    expect(daily("2026-09-01", "2026-09-08").filter((row) => row.provider_id === "office-b").every((row) => row.weekly_active === 0 && row.monthly_active === 0)).toBe(true);
    expect(() => daily("2026-09-08", "2026-09-01")).toThrow(/invalid range/);
    expect(() => daily("2024-01-01", "2026-09-01")).toThrow(/invalid range/);
  });
});
