/**
 * The HQ patient-retention aggregate, run for real.
 *
 * Boots a throwaway PostgreSQL cluster, applies the presence/usage migration
 * (the activity-day source) and then the retention migration verbatim on top
 * of a minimal mirror of the patient + billing tables, seeds fixtures, and
 * asserts:
 *
 *  - onboarded = real-account, activated, not archived, claimed/created on or
 *    before the as-of date (later claims are not counted yet);
 *  - active = an activity day in the trailing 30 days; inactive is the exact
 *    complement, tiered by days since the last activity day (or since
 *    onboarding when there has never been one);
 *  - buying = a paid order in the trailing 90 days OR a subscription active on
 *    the as-of date (canceled / not-yet-created subscriptions don't count,
 *    refunded orders don't count); subscribed is reported on its own;
 *  - several as-of dates come back per office and each is evaluated
 *    independently (a patient active in May is inactive by September);
 *  - disabled offices are excluded, offices without patients still get a row
 *    with first_patient_date = null;
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
const PRESENCE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261026000000_patient_app_presence.sql");
const TIMEZONE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260925138000_patient_activity_summary.sql");
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261030000000_patient_retention.sql");

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
  auth_user_id uuid, activation_status text not null default 'activated', archived_at timestamptz,
  claimed_at timestamptz, last_log_date date, last_login_at timestamptz, created_at timestamptz not null default now());
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
create table public.billing_orders (
  id uuid primary key, provider_id text not null, patient_id uuid references public.patients(id),
  status text not null, paid_at timestamptz);
create table public.billing_subscriptions (
  id uuid primary key, provider_id text not null, patient_id uuid references public.patients(id),
  status text not null, created_at timestamptz not null, canceled_at timestamptz, current_period_end timestamptz);
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
  real?: boolean;
  archived?: boolean;
  status?: string;
  createdAt?: string;
  claimedAt?: string | null;
}

function insertPatient(n: number, provider: string, options: PatientOptions = {}) {
  const real = options.real ?? true;
  psql(
    `insert into public.patients (id, provider_id, timezone, auth_user_id, activation_status, archived_at, claimed_at, created_at) values (
      '${uuid(n)}', '${provider}', 'UTC',
      ${real ? `'${uuid(1000 + n)}'` : "null"}, '${options.status ?? "activated"}',
      ${options.archived ? "now()" : "null"},
      ${options.claimedAt ? `'${options.claimedAt}'` : "null"},
      '${options.createdAt ?? "2026-01-01T00:00:00Z"}')`,
  );
}

function insertDiary(n: number, days: string[]) {
  const values = days.map((day) => `('${uuid(n)}', 'e-${n}-${day}', '${day}', 100)`).join(",");
  psql(`insert into public.patient_diary_entries (patient_id, entry_id, date_key, calories) values ${values}`);
}

let orderSeq = 0;
function insertOrder(n: number, paidAt: string, status = "paid") {
  orderSeq += 1;
  psql(`insert into public.billing_orders (id, provider_id, patient_id, status, paid_at) values ('${uuid(7000 + orderSeq)}', 'x', '${uuid(n)}', '${status}', '${paidAt}'::timestamptz)`);
}

let subSeq = 0;
function insertSubscription(n: number, createdAt: string, status = "active", canceledAt: string | null = null, periodEnd: string | null = null) {
  subSeq += 1;
  const ts = (value: string | null) => (value ? `'${value}'::timestamptz` : "null");
  psql(`insert into public.billing_subscriptions (id, provider_id, patient_id, status, created_at, canceled_at, current_period_end) values ('${uuid(8000 + subSeq)}', 'x', '${uuid(n)}', '${status}', '${createdAt}'::timestamptz, ${ts(canceledAt)}, ${ts(periodEnd)})`);
}

function resetData() {
  psql(
    "truncate public.billing_orders, public.billing_subscriptions, public.patient_chat_messages, public.patient_chat_conversations, public.patient_app_presence, public.patient_diary_entries, public.patient_water_days, public.patient_check_ins, public.patient_health_measurements, public.patient_progress_photos, public.patients, public.providers",
  );
  psql(
    "insert into public.providers (provider_id, office_name, provider_name, access_disabled) values ('office-a', 'Alpha Clinic', 'Dr. Alpha', false), ('office-b', 'Beta Clinic', 'Dr. Beta', false), ('office-off', 'Disabled Clinic', 'Dr. Off', true)",
  );
}

interface RetentionRow {
  provider_id: string;
  first_patient_date: string | null;
  as_of: string;
  onboarded: number;
  active: number;
  buying: number;
  subscribed: number;
  inactive_under_30: number;
  inactive_30_60: number;
  inactive_60_90: number;
  inactive_90_plus: number;
}

function retention(dates: string[]) {
  return rows<RetentionRow>(
    `select * from public.patient_retention_offices(array[${dates.map((d) => `'${d}'`).join(",")}]::date[])`,
  );
}

const find = (list: RetentionRow[], office: string, asOf: string) => list.find((row) => row.provider_id === office && row.as_of === asOf);

describe.skipIf(!POSTGRES_AVAILABLE)("patient retention aggregate (real PostgreSQL)", () => {
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

  it("is service-role only and granted accordingly", () => {
    resetData();
    expect(() => rows("select * from public.patient_retention_offices(array['2026-09-01']::date[])", "authenticated")).toThrow(/service role required/);
    expect(() => rows("select * from public.patient_retention_offices(array['2026-09-01']::date[])", "anon")).toThrow(/service role required/);
    expect(() => rows("select * from public.patient_retention_offices(array[]::date[])")).toThrow(/invalid dates/);
    const grants = rows<{ grantee: string }>(
      "select grantee from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'patient_retention_offices' and privilege_type = 'EXECUTE'",
    ).map((row) => row.grantee);
    expect(grants).toContain("service_role");
    expect(grants).not.toContain("anon");
    expect(grants).not.toContain("authenticated");
    expect(grants).not.toContain("PUBLIC");
  });

  it("counts onboarded, active, buying and the inactive tiers as of each date", () => {
    resetData();
    const AS_OF = "2026-09-15";
    // 1: active this week, bought last month → active + buying
    insertPatient(1, "office-a", { claimedAt: "2026-03-01T00:00:00Z" });
    insertDiary(1, ["2026-09-12"]);
    insertOrder(1, "2026-08-20T12:00:00Z");
    // 2: last activity 45 days ago, subscription active → inactive 30–60 + buying (subscribed)
    insertPatient(2, "office-a", { claimedAt: "2026-03-01T00:00:00Z" });
    insertDiary(2, ["2026-08-01"]);
    insertSubscription(2, "2026-07-01T00:00:00Z");
    // 3: last activity 75 days ago, order refunded → inactive 60–90, not buying
    insertPatient(3, "office-a", { claimedAt: "2026-03-01T00:00:00Z" });
    insertDiary(3, ["2026-07-02"]);
    insertOrder(3, "2026-08-20T12:00:00Z", "refunded");
    // 4: last activity in May, order 100 days ago, subscription canceled in August → inactive 90+, not buying
    insertPatient(4, "office-a", { claimedAt: "2026-03-01T00:00:00Z" });
    insertDiary(4, ["2026-05-10"]);
    insertOrder(4, "2026-06-07T12:00:00Z");
    insertSubscription(4, "2026-05-01T00:00:00Z", "canceled", "2026-08-10T00:00:00Z");
    // 5: claimed 10 days ago, never opened, partially refunded order → inactive under 30, buying
    insertPatient(5, "office-a", { claimedAt: "2026-09-05T00:00:00Z" });
    insertOrder(5, "2026-09-06T12:00:00Z", "partially_refunded");
    // 6: claimed AFTER the as-of date → not onboarded yet
    insertPatient(6, "office-a", { claimedAt: "2026-09-20T00:00:00Z" });
    insertDiary(6, ["2026-09-14"]);
    // 7: staff-created row without an auth user → never counts
    insertPatient(7, "office-a", { real: false });
    insertDiary(7, ["2026-09-14"]);
    // 8: archived → never counts
    insertPatient(8, "office-a", { archived: true, claimedAt: "2026-03-01T00:00:00Z" });
    // 9: discharged → never counts
    insertPatient(9, "office-a", { status: "discharged", claimedAt: "2026-03-01T00:00:00Z" });
    // 10: no claim date (self-created account) — creation date is the onboarding date; active via presence
    insertPatient(10, "office-b", { createdAt: "2026-08-30T00:00:00Z" });
    rows(`select * from public.patient_app_presence_touch('${uuid(10)}', 'ios', '2026-09-14T10:00:00Z'::timestamptz)`);
    // 11: disabled office → office excluded entirely
    insertPatient(11, "office-off", { claimedAt: "2026-03-01T00:00:00Z" });

    const list = retention([AS_OF]);
    expect(list.map((row) => row.provider_id).sort()).toEqual(["office-a", "office-b"]);
    const a = find(list, "office-a", AS_OF)!;
    expect(a).toMatchObject({
      first_patient_date: "2026-01-01",
      onboarded: 5, active: 1, buying: 3, subscribed: 1,
      inactive_under_30: 1, inactive_30_60: 1, inactive_60_90: 1, inactive_90_plus: 1,
    });
    expect(a.active + a.inactive_under_30 + a.inactive_30_60 + a.inactive_60_90 + a.inactive_90_plus).toBe(a.onboarded);
    const b = find(list, "office-b", AS_OF)!;
    expect(b).toMatchObject({ onboarded: 1, active: 1, buying: 0, subscribed: 0, inactive_under_30: 0, inactive_30_60: 0, inactive_60_90: 0, inactive_90_plus: 0 });
  });

  it("evaluates every requested as-of date independently, oldest first", () => {
    resetData();
    insertPatient(1, "office-a", { claimedAt: "2026-04-01T00:00:00Z" });
    insertDiary(1, ["2026-05-10"]);
    insertOrder(1, "2026-05-12T12:00:00Z");
    insertSubscription(1, "2026-06-01T00:00:00Z", "active", null);
    const list = retention(["2026-09-30", "2026-03-31", "2026-05-31", "2026-07-31"]);
    const a = list.filter((row) => row.provider_id === "office-a");
    expect(a.map((row) => row.as_of)).toEqual(["2026-03-31", "2026-05-31", "2026-07-31", "2026-09-30"]);
    // March: not yet claimed.
    expect(a[0]).toMatchObject({ onboarded: 0, active: 0, buying: 0 });
    // May: active (May 10), bought May 12 → buying; subscription not created yet.
    expect(a[1]).toMatchObject({ onboarded: 1, active: 1, buying: 1, subscribed: 0 });
    // July: 82 days quiet → inactive 60–90; order 80 days old still counts + subscription active.
    expect(a[2]).toMatchObject({ onboarded: 1, active: 0, inactive_60_90: 1, buying: 1, subscribed: 1 });
    // September: 143 days quiet → 90+; order too old, but the subscription keeps them buying.
    expect(a[3]).toMatchObject({ onboarded: 1, active: 0, inactive_90_plus: 1, buying: 1, subscribed: 1 });
  });

  it("judges subscriptions by their lifetime on the date, not by today's status", () => {
    resetData();
    // 1: subscribed Apr 1, canceled Aug 10 (status is canceled TODAY) — still buying on earlier dates.
    insertPatient(1, "office-a", { claimedAt: "2026-03-01T00:00:00Z" });
    insertSubscription(1, "2026-04-01T00:00:00Z", "canceled", "2026-08-10T00:00:00Z");
    // 2: checkout never completed — an incomplete subscription that was later canceled never counts.
    insertPatient(2, "office-a", { claimedAt: "2026-03-01T00:00:00Z" });
    insertSubscription(2, "2026-04-01T00:00:00Z", "incomplete", null);
    // 3: went unpaid; the last paid period ended Jul 15 — buying through Jul 14, not after.
    insertPatient(3, "office-a", { claimedAt: "2026-03-01T00:00:00Z" });
    insertSubscription(3, "2026-04-01T00:00:00Z", "unpaid", null, "2026-07-15T00:00:00Z");
    // 4: past due but not canceled — still counts as subscribed.
    insertPatient(4, "office-a", { claimedAt: "2026-03-01T00:00:00Z" });
    insertSubscription(4, "2026-04-01T00:00:00Z", "past_due", null);
    const list = retention(["2026-03-15", "2026-05-31", "2026-07-14", "2026-07-31", "2026-08-09", "2026-08-10", "2026-09-15"]);
    const a = list.filter((row) => row.provider_id === "office-a");
    // Mid March: nobody has subscribed yet.
    expect(a[0]).toMatchObject({ onboarded: 4, subscribed: 0, buying: 0 });
    // End of May: 1 (later canceled), 3 (later unpaid) and 4 are all active; 2 never was.
    expect(a[1]).toMatchObject({ subscribed: 3, buying: 3 });
    // Jul 14: the unpaid one is still inside its last paid period.
    expect(a[2]).toMatchObject({ subscribed: 3 });
    // Jul 31: the unpaid one has lapsed.
    expect(a[3]).toMatchObject({ subscribed: 2 });
    // Aug 9 vs Aug 10: the cancellation date itself is the first day off.
    expect(a[4]).toMatchObject({ subscribed: 2 });
    expect(a[5]).toMatchObject({ subscribed: 1 });
    expect(a[6]).toMatchObject({ subscribed: 1, buying: 1 });
  });

  it("returns a row per date for an office with no patients (first_patient_date null)", () => {
    resetData();
    const list = retention(["2026-09-01", "2026-09-15"]);
    const b = list.filter((row) => row.provider_id === "office-b");
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ first_patient_date: null, onboarded: 0, active: 0, buying: 0 });
  });
});
