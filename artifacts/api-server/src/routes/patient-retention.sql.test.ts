/**
 * The HQ patient-retention aggregates, run for real.
 *
 * Boots a throwaway PostgreSQL cluster (unix socket only), applies the
 * canonical presence migration (for the shared activity-day source) and the
 * retention migration verbatim on top of a minimal mirror of the patient and
 * billing tables, seeds fixtures, and asserts:
 *
 *  - onboarded = linked + activated + not archived + onboarding day <= as-of
 *    (claimed_at wins over created_at; staff-only and pending rows never count);
 *  - every onboarded patient is in exactly one of active / inactive;
 *  - active = any activity day in the trailing 30 days (presence counts like
 *    a logged action); the inactive tiers follow the last activity day, and a
 *    never-active patient is quiet since onboarding;
 *  - buying = a paid order in the trailing 90 days (pending / failed never
 *    count) or a subscription active on the as-of date (canceled / expired
 *    never count);
 *  - per-office rows are zero-filled for every requested date, offices with no
 *    onboarded patient report first_onboarded_on = null, the office filter
 *    narrows every figure, and disabled offices never appear;
 *  - service-role gating and grants on both functions.
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
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261102000000_patient_retention.sql");
const PRESENCE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261026000000_patient_app_presence.sql");
const TIMEZONE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260925138000_patient_activity_summary.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("patient-retention.sql.test: PostgreSQL binaries not on PATH — SQL aggregate suite skipped");
}

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.providers (provider_id text primary key, office_name text, provider_name text, access_disabled boolean default false);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id), timezone text,
  auth_user_id uuid, activation_status text not null default 'activated', archived_at timestamptz, claimed_at timestamptz,
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
create table public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(), provider_id text not null references public.providers(provider_id),
  patient_id uuid references public.patients(id), status text not null, current_period_end timestamptz,
  created_at timestamptz not null default now());
create table public.billing_orders (
  id uuid primary key default gen_random_uuid(), provider_id text not null references public.providers(provider_id),
  patient_id uuid references public.patients(id), status text not null, paid_at timestamptz,
  created_at timestamptz not null default now());
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

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

interface PatientOptions {
  timezone?: string | null;
  real?: boolean;
  archived?: boolean;
  status?: string;
  createdAt?: string;
  claimedAt?: string | null;
}

function insertPatient(n: number, provider: string, options: PatientOptions = {}) {
  const timezone = options.timezone === undefined ? "UTC" : options.timezone;
  const real = options.real ?? true;
  const claimed = options.claimedAt === undefined ? null : options.claimedAt;
  psql(
    `insert into public.patients (id, provider_id, timezone, auth_user_id, activation_status, archived_at, claimed_at, created_at) values (
      '${uuid(n)}', '${provider}', ${timezone === null ? "null" : `'${timezone}'`},
      ${real ? `'${uuid(1000 + n)}'` : "null"}, '${options.status ?? "activated"}',
      ${options.archived ? "now()" : "null"}, ${claimed === null ? "null" : `'${claimed}'`}, '${options.createdAt ?? "2026-01-01T00:00:00Z"}')`,
  );
}

function touch(n: number, at: string) {
  rows(`select * from public.patient_app_presence_touch('${uuid(n)}', 'ios', '${at}'::timestamptz)`);
}

function insertDiary(n: number, days: string[]) {
  const values = days.map((day) => `('${uuid(n)}', 'e-${n}-${day}', '${day}', 100)`).join(",");
  psql(`insert into public.patient_diary_entries (patient_id, entry_id, date_key, calories) values ${values}`);
}

function insertOrder(n: number, provider: string, status: string, paidAt: string | null) {
  psql(
    `insert into public.billing_orders (provider_id, patient_id, status, paid_at) values ('${provider}', '${uuid(n)}', '${status}', ${paidAt ? `'${paidAt}'` : "null"})`,
  );
}

function insertSubscription(n: number, provider: string, status: string, periodEnd: string | null, createdAt = "2026-01-01T00:00:00Z") {
  psql(
    `insert into public.billing_subscriptions (provider_id, patient_id, status, current_period_end, created_at) values ('${provider}', '${uuid(n)}', '${status}', ${periodEnd ? `'${periodEnd}'` : "null"}, '${createdAt}')`,
  );
}

function resetData() {
  psql(
    "truncate public.billing_orders, public.billing_subscriptions, public.patient_chat_messages, public.patient_chat_conversations, public.patient_app_presence, public.patient_diary_entries, public.patient_water_days, public.patient_check_ins, public.patient_health_measurements, public.patient_progress_photos, public.patients, public.providers",
  );
  psql(
    "insert into public.providers (provider_id, office_name, provider_name, access_disabled) values ('office-a', 'Alpha Clinic', 'Dr. Alpha', false), ('office-b', 'Beta Clinic', 'Dr. Beta', false), ('office-off', 'Disabled Clinic', 'Dr. Off', true)",
  );
}

interface StatusRow {
  patient_id: string;
  provider_id: string;
  onboarded_on: string;
  is_active: boolean;
  is_buying: boolean;
  quiet_days: number;
}

interface PointRow {
  provider_id: string;
  office_name: string;
  first_onboarded_on: string | null;
  as_of: string;
  onboarded: number;
  active: number;
  buying: number;
  inactive: number;
  inactive_30_60: number;
  inactive_60_90: number;
  inactive_90_plus: number;
}

function status(asOf: string, provider: string | null = null) {
  return rows<StatusRow>(
    `select * from public.patient_retention_status('${asOf}', ${provider ? `'${provider}'` : "null"}) order by patient_id`,
  );
}

function points(dates: string[], provider: string | null = null) {
  return rows<PointRow>(
    `select * from public.patient_retention_points(array[${dates.map((d) => `'${d}'`).join(",")}]::date[], ${provider ? `'${provider}'` : "null"})`,
  );
}

const byPatient = (list: StatusRow[]) => Object.fromEntries(list.map((row) => [row.patient_id, row]));

describe.skipIf(!POSTGRES_AVAILABLE)("patient retention aggregates (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pr-"));
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
    for (const file of [schemaFile, tzFile, PRESENCE_MIGRATION, MIGRATION]) {
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

  it("applies the canonical migration verbatim and is service-role only", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("security definer");
    expect(rows("select proname from pg_proc where proname like 'patient_retention_%' order by 1")).toEqual([
      { proname: "patient_retention_points" },
      { proname: "patient_retention_status" },
    ]);
    resetData();
    for (const role of ["anon", "authenticated"]) {
      expect(() => rows("select * from public.patient_retention_status('2026-09-18', null)", role)).toThrow(/service role required/);
      expect(() => rows("select * from public.patient_retention_points(array['2026-09-18']::date[], null)", role)).toThrow(/service role required/);
    }
    const grants = rows<{ fn: string; role: string; can: boolean }>(
      `select f.fn, r.role, has_function_privilege(r.role, f.fn, 'execute') as can
         from (values ('public.patient_retention_status(date, text)'), ('public.patient_retention_points(date[], text)')) f(fn)
         cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
         order by 1, 2`,
    );
    for (const grant of grants) expect(grant.can, `${grant.role} on ${grant.fn}`).toBe(grant.role === "service_role");
    expect(() => rows("select * from public.patient_retention_points(array[]::date[], null)")).toThrow(/invalid dates/);
    expect(() => rows("select * from public.patient_retention_points(array['2026-09-18', null]::date[], null)")).toThrow(/invalid dates/);
  });

  it("counts only linked, activated, unarchived patients onboarded by the as-of date (claimed_at wins over created_at)", () => {
    resetData();
    insertPatient(1, "office-a", { createdAt: "2026-01-01T00:00:00Z", claimedAt: "2026-06-10T15:00:00Z" });
    insertPatient(2, "office-a", { createdAt: "2026-03-01T00:00:00Z" });
    insertPatient(3, "office-a", { real: false });
    insertPatient(4, "office-a", { status: "pending" });
    insertPatient(5, "office-a", { archived: true });
    insertPatient(6, "office-a", { claimedAt: "2026-09-19T00:00:00Z" });
    insertPatient(7, "office-off");
    const asOf = byPatient(status("2026-09-18"));
    expect(Object.keys(asOf).sort()).toEqual([uuid(1), uuid(2)]);
    expect(asOf[uuid(1)].onboarded_on).toBe("2026-06-10");
    expect(asOf[uuid(2)].onboarded_on).toBe("2026-03-01");
    // Before patient 1 claimed, only patient 2 was onboarded.
    expect(status("2026-06-09").map((row) => row.patient_id)).toEqual([uuid(2)]);
  });

  it("puts every onboarded patient in exactly one of active / inactive and tiers the quiet ones by last activity", () => {
    resetData();
    // Active via presence (day 18) and via a logged meal (day 25 of 30).
    insertPatient(1, "office-a");
    touch(1, "2026-09-18T10:00:00Z");
    insertPatient(2, "office-a");
    insertDiary(2, ["2026-08-20"]);
    // Last seen 30 days ago → inactive, 30-60 tier.
    insertPatient(3, "office-a");
    insertDiary(3, ["2026-08-19"]);
    // Last seen 60 days ago → 60-90 tier.
    insertPatient(4, "office-a");
    insertDiary(4, ["2026-07-20"]);
    // Last seen 89 days ago → still 60-90; 90 days ago → 90+.
    insertPatient(5, "office-a");
    insertDiary(5, ["2026-06-21"]);
    insertPatient(6, "office-a");
    insertDiary(6, ["2026-06-20"]);
    // Never opened the app: quiet since onboarding (12 days → first tier; onboarded a year ago → 90+).
    insertPatient(7, "office-a", { claimedAt: "2026-09-06T00:00:00Z" });
    insertPatient(8, "office-a", { createdAt: "2025-09-01T00:00:00Z" });
    const asOf = byPatient(status("2026-09-18"));
    expect(asOf[uuid(1)]).toMatchObject({ is_active: true, quiet_days: 0 });
    expect(asOf[uuid(2)]).toMatchObject({ is_active: true, quiet_days: 29 });
    expect(asOf[uuid(3)]).toMatchObject({ is_active: false, quiet_days: 30 });
    expect(asOf[uuid(4)]).toMatchObject({ is_active: false, quiet_days: 60 });
    expect(asOf[uuid(5)]).toMatchObject({ is_active: false, quiet_days: 89 });
    expect(asOf[uuid(6)]).toMatchObject({ is_active: false, quiet_days: 90 });
    expect(asOf[uuid(7)]).toMatchObject({ is_active: false, quiet_days: 12 });
    expect(asOf[uuid(8)]).toMatchObject({ is_active: false, quiet_days: 90 });
    const [alpha] = points(["2026-09-18"], "office-a");
    expect(alpha).toMatchObject({
      provider_id: "office-a", as_of: "2026-09-18", onboarded: 8, active: 2, inactive: 6,
      inactive_30_60: 2, inactive_60_90: 2, inactive_90_plus: 2,
    });
    expect(alpha.active + alpha.inactive).toBe(alpha.onboarded);
    expect(alpha.inactive_30_60 + alpha.inactive_60_90 + alpha.inactive_90_plus).toBe(alpha.inactive);
    // The same patients re-classified as of an earlier date: patient 4 was active on Aug 1.
    const earlier = byPatient(status("2026-08-01"));
    expect(earlier[uuid(4)].is_active).toBe(true);
    expect(earlier[uuid(3)].is_active).toBe(false);
    expect(earlier[uuid(7)]).toBeUndefined();
  });

  it("marks buying from a paid order in the trailing 90 days or a subscription active on the as-of date", () => {
    resetData();
    insertPatient(1, "office-a");
    insertOrder(1, "office-a", "paid", "2026-09-01T12:00:00Z");
    insertPatient(2, "office-a");
    insertOrder(2, "office-a", "paid", "2026-06-20T12:00:00Z"); // 90 days before → outside the window
    insertPatient(3, "office-a");
    insertOrder(3, "office-a", "partially_refunded", "2026-06-21T12:00:00Z"); // 89 days before → inside
    insertPatient(4, "office-a");
    insertOrder(4, "office-a", "pending", null);
    insertOrder(4, "office-a", "failed", "2026-09-10T12:00:00Z");
    insertPatient(5, "office-a");
    insertSubscription(5, "office-a", "active", "2026-10-01T00:00:00Z");
    insertPatient(6, "office-a");
    insertSubscription(6, "office-a", "canceled", "2026-10-01T00:00:00Z");
    insertPatient(7, "office-a");
    insertSubscription(7, "office-a", "active", "2026-09-17T00:00:00Z"); // period already over
    insertPatient(8, "office-a");
    insertSubscription(8, "office-a", "active", null, "2026-09-19T00:00:00Z"); // starts after the as-of date
    insertPatient(9, "office-a", { timezone: "America/Los_Angeles" });
    // 03:00Z on Jun 21 is still Jun 20 in Los Angeles → outside the window for that patient.
    insertOrder(9, "office-a", "paid", "2026-06-21T03:00:00Z");
    const asOf = byPatient(status("2026-09-18"));
    expect(Object.fromEntries(Object.values(asOf).map((row) => [row.patient_id, row.is_buying]))).toEqual({
      [uuid(1)]: true, [uuid(2)]: false, [uuid(3)]: true, [uuid(4)]: false, [uuid(5)]: true,
      [uuid(6)]: false, [uuid(7)]: false, [uuid(8)]: false, [uuid(9)]: false,
    });
    const [alpha] = points(["2026-09-18"], "office-a");
    expect(alpha).toMatchObject({ onboarded: 9, buying: 3 });
    // Subscription 8 counts once it has started.
    expect(byPatient(status("2026-09-19"))[uuid(8)].is_buying).toBe(true);
  });

  it("returns zero-filled rows per office per date, reports empty offices as unavailable, hides disabled offices, and honours the office filter", () => {
    resetData();
    insertPatient(1, "office-a", { claimedAt: "2026-04-05T00:00:00Z" });
    insertDiary(1, ["2026-09-10"]);
    insertPatient(2, "office-b", { createdAt: "2026-08-01T00:00:00Z" });
    insertPatient(3, "office-off");
    insertOrder(2, "office-b", "paid", "2026-08-02T00:00:00Z");
    const all = points(["2026-07-31", "2026-09-18"]);
    expect(all.map((row) => [row.provider_id, row.as_of])).toEqual([
      ["office-a", "2026-07-31"], ["office-a", "2026-09-18"], ["office-b", "2026-07-31"], ["office-b", "2026-09-18"],
    ]);
    // Quiet since onboarding on Apr 5 → 117 days by Jul 31 → 90+ tier.
    expect(all[0]).toMatchObject({ first_onboarded_on: "2026-04-05", onboarded: 1, active: 0, buying: 0, inactive: 1, inactive_30_60: 0, inactive_60_90: 0, inactive_90_plus: 1 });
    expect(all[1]).toMatchObject({ onboarded: 1, active: 1, buying: 0, inactive: 0 });
    expect(all[2]).toMatchObject({ first_onboarded_on: "2026-08-01", onboarded: 0, active: 0, buying: 0, inactive: 0 });
    expect(all[3]).toMatchObject({ onboarded: 1, active: 0, buying: 1, inactive: 1, inactive_30_60: 1 });
    const only = points(["2026-09-18"], "office-b");
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ provider_id: "office-b", onboarded: 1, buying: 1 });
    expect(points(["2026-09-18"], "office-off")).toEqual([]);
    expect(points(["2026-09-18"], "nope")).toEqual([]);
    // An office with no onboarded patient still returns a row with a null first date.
    psql(`delete from public.billing_orders; delete from public.patients where id = '${uuid(2)}'`);
    const empty = points(["2026-09-18"], "office-b");
    expect(empty[0]).toMatchObject({ first_onboarded_on: null, onboarded: 0, active: 0 });
  });
});
