/**
 * The HQ customer-health office aggregate, run for real.
 *
 * Boots a throwaway PostgreSQL cluster (unix socket only), applies the
 * canonical presence migration (the shared activity-day source) and the
 * customer-health migration verbatim on top of a minimal mirror of the
 * provider, patient, team and billing tables, seeds fixtures, and asserts:
 *
 *  - one row per enabled office (disabled offices never appear; offboarding
 *    offices DO appear with their status so the API can drop them);
 *  - last paid order = latest live-mode order owned by the office with a paid
 *    timestamp; refunded / disputed still count, pending / failed / test-mode
 *    never do, and an order placed by another office's patient belongs to the
 *    office on the order;
 *  - active subscribers count people (two active rows for one patient = 1),
 *    cancelling counts active rows set to cancel at period end;
 *  - app users = the retention "onboarded" rule; active 30d / prior 30d use
 *    the activity-day feed and never count non-app-users;
 *  - staff enrolled = linked, non-disabled team members + the linked provider
 *    account holder;
 *  - an empty office reports honest zeros and a null last order;
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
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261204000000_office_customer_health.sql");
const PRESENCE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261026000000_patient_app_presence.sql");
const TIMEZONE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260925138000_patient_activity_summary.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("office-customer-health.sql.test: PostgreSQL binaries not on PATH — SQL aggregate suite skipped");
}

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.providers (
  provider_id text primary key, office_name text, provider_name text, access_disabled boolean default false,
  offboarding_status text not null default 'active', auth_user_id uuid, created_at timestamptz not null default now());
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id), timezone text,
  auth_user_id uuid, activation_status text not null default 'activated', archived_at timestamptz, claimed_at timestamptz,
  last_log_date date, last_login_at timestamptz, created_at timestamptz not null default now());
create table public.team_members (
  id uuid primary key default gen_random_uuid(), provider_id text not null references public.providers(provider_id),
  name text, email text, activation_status text not null default 'pending', auth_user_id uuid, office_role text);
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
  cancel_at_period_end boolean not null default false, livemode boolean not null default false,
  created_at timestamptz not null default now());
create table public.billing_orders (
  id uuid primary key default gen_random_uuid(), provider_id text not null references public.providers(provider_id),
  patient_id uuid references public.patients(id), status text not null, paid_at timestamptz,
  livemode boolean not null default false, created_at timestamptz not null default now());
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
const PORT = 54_700 + (process.pid % 1000);

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
}

function insertPatient(n: number, provider: string, options: PatientOptions = {}) {
  const real = options.real ?? true;
  psql(
    `insert into public.patients (id, provider_id, timezone, auth_user_id, activation_status, archived_at, claimed_at, created_at) values (
      '${uuid(n)}', '${provider}', 'UTC', ${real ? `'${uuid(1000 + n)}'` : "null"}, '${options.status ?? "activated"}',
      ${options.archived ? "now()" : "null"}, '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
}

function touch(n: number, at: string) {
  rows(`select * from public.patient_app_presence_touch('${uuid(n)}', 'ios', '${at}'::timestamptz)`);
}

function insertDiary(n: number, days: string[]) {
  const values = days.map((day) => `('${uuid(n)}', 'e-${n}-${day}', '${day}', 100)`).join(",");
  psql(`insert into public.patient_diary_entries (patient_id, entry_id, date_key, calories) values ${values}`);
}

function insertOrder(n: number, provider: string, status: string, paidAt: string | null, livemode = true) {
  psql(
    `insert into public.billing_orders (provider_id, patient_id, status, paid_at, livemode) values ('${provider}', '${uuid(n)}', '${status}', ${paidAt ? `'${paidAt}'` : "null"}, ${livemode})`,
  );
}

function insertSubscription(n: number, provider: string, status: string, cancelAtPeriodEnd = false) {
  psql(
    `insert into public.billing_subscriptions (provider_id, patient_id, status, cancel_at_period_end) values ('${provider}', '${uuid(n)}', '${status}', ${cancelAtPeriodEnd})`,
  );
}

function insertMember(provider: string, status: string, linked: boolean) {
  psql(
    `insert into public.team_members (provider_id, name, email, activation_status, auth_user_id, office_role) values ('${provider}', 'Staff', 'staff@example.com', '${status}', ${linked ? "gen_random_uuid()" : "null"}, 'staff')`,
  );
}

function resetData() {
  psql(
    "truncate public.billing_orders, public.billing_subscriptions, public.team_members, public.patient_chat_messages, public.patient_chat_conversations, public.patient_app_presence, public.patient_diary_entries, public.patient_water_days, public.patient_check_ins, public.patient_health_measurements, public.patient_progress_photos, public.patients, public.providers",
  );
  psql(
    `insert into public.providers (provider_id, office_name, provider_name, access_disabled, offboarding_status, auth_user_id, created_at) values
      ('office-a', 'Alpha Clinic', 'Dr. Alpha', false, 'active', '${uuid(9001)}', '2025-06-01T00:00:00Z'),
      ('office-b', 'Beta Clinic', 'Dr. Beta', false, 'active', null, '2026-09-01T00:00:00Z'),
      ('office-leaving', 'Gamma Clinic', 'Dr. Gamma', false, 'offboarding', '${uuid(9003)}', '2025-01-01T00:00:00Z'),
      ('office-off', 'Disabled Clinic', 'Dr. Off', true, 'active', '${uuid(9004)}', '2025-01-01T00:00:00Z')`,
  );
}

interface HealthRow {
  provider_id: string;
  office_name: string;
  provider_name: string;
  access_disabled: boolean;
  offboarding_status: string;
  created_at: string;
  last_paid_order_at: string | null;
  active_subscribers: number;
  cancelling_subscriptions: number;
  app_users: number;
  active_app_users_30d: number;
  active_app_users_prior_30d: number;
  staff_enrolled: number;
}

const AS_OF = "2026-09-18";

function health(asOf = AS_OF) {
  return rows<HealthRow>(`select * from public.office_customer_health('${asOf}')`);
}
const byOffice = (list: HealthRow[]) => Object.fromEntries(list.map((row) => [row.provider_id, row]));

describe.skipIf(!POSTGRES_AVAILABLE)("office customer health aggregate (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "och-"));
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
    expect(rows("select proname from pg_proc where proname = 'office_customer_health'")).toEqual([{ proname: "office_customer_health" }]);
    resetData();
    for (const role of ["anon", "authenticated"]) {
      expect(() => rows("select * from public.office_customer_health()", role)).toThrow(/service role required/);
    }
    const grants = rows<{ role: string; can: boolean }>(
      `select r.role, has_function_privilege(r.role, 'public.office_customer_health(date)', 'execute') as can
         from (values ('anon'), ('authenticated'), ('service_role')) r(role) order by 1`,
    );
    for (const grant of grants) expect(grant.can, grant.role).toBe(grant.role === "service_role");
    expect(() => rows("select * from public.office_customer_health(null)")).toThrow(/invalid date/);
  });

  it("lists every enabled office (offboarding included with its status, disabled dropped) with honest zeros", () => {
    resetData();
    const list = health();
    expect(list.map((row) => row.provider_id)).toEqual(["office-a", "office-b", "office-leaving"]);
    const offices = byOffice(list);
    expect(offices["office-leaving"].offboarding_status).toBe("offboarding");
    expect(offices["office-b"]).toMatchObject({
      office_name: "Beta Clinic",
      provider_name: "Dr. Beta",
      access_disabled: false,
      offboarding_status: "active",
      last_paid_order_at: null,
      active_subscribers: 0,
      cancelling_subscriptions: 0,
      app_users: 0,
      active_app_users_30d: 0,
      active_app_users_prior_30d: 0,
      staff_enrolled: 0,
    });
    expect(offices["office-b"].created_at.startsWith("2026-09-01")).toBe(true);
    // The provider account holder counts as enrolled staff once their sign-in is linked.
    expect(offices["office-a"].staff_enrolled).toBe(1);
  });

  it("takes the latest paid live-mode order owned by the office, whoever the patient is", () => {
    resetData();
    insertPatient(1, "office-a");
    insertPatient(2, "office-b");
    insertOrder(1, "office-a", "paid", "2026-07-01T10:00:00Z");
    insertOrder(1, "office-a", "refunded", "2026-08-15T10:00:00Z");
    insertOrder(1, "office-a", "paid", "2026-09-10T10:00:00Z", false); // sandbox: never counts
    insertOrder(1, "office-a", "pending", null);
    insertOrder(1, "office-a", "failed", "2026-09-12T10:00:00Z");
    // A Beta patient's order owned by Alpha belongs to Alpha; Beta keeps "no orders".
    insertOrder(2, "office-a", "disputed", "2026-09-01T10:00:00Z");
    const offices = byOffice(health());
    expect(offices["office-a"].last_paid_order_at?.startsWith("2026-09-01")).toBe(true);
    expect(offices["office-b"].last_paid_order_at).toBeNull();
  });

  it("counts subscribers as people and cancelling as active rows set to end", () => {
    resetData();
    insertPatient(1, "office-a");
    insertPatient(2, "office-a");
    insertPatient(3, "office-a");
    insertSubscription(1, "office-a", "active");
    insertSubscription(1, "office-a", "active", true); // same person twice
    insertSubscription(2, "office-a", "active", true);
    insertSubscription(3, "office-a", "canceled", true); // not active: neither count
    insertSubscription(3, "office-a", "past_due");
    const offices = byOffice(health());
    expect(offices["office-a"].active_subscribers).toBe(2);
    expect(offices["office-a"].cancelling_subscriptions).toBe(2);
    expect(offices["office-b"].active_subscribers).toBe(0);
  });

  it("app users follow the retention onboarded rule; actives split into the two 30-day windows", () => {
    resetData();
    insertPatient(1, "office-a"); // active this window (presence)
    insertPatient(2, "office-a"); // active prior window only (diary)
    insertPatient(3, "office-a"); // active in both windows
    insertPatient(4, "office-a"); // onboarded, never active
    insertPatient(5, "office-a", { real: false }); // unclaimed: not an app user
    insertPatient(6, "office-a", { archived: true }); // archived: not an app user
    insertPatient(7, "office-a", { status: "pending" }); // not activated: not an app user even with activity
    insertPatient(8, "office-b");
    touch(1, "2026-09-18T08:00:00Z");
    insertDiary(2, ["2026-08-19"]); // as-of - 30: prior window
    insertDiary(3, ["2026-07-21", "2026-08-20"]); // -59 (prior edge) and -29 (current edge)
    insertDiary(7, ["2026-09-17"]);
    insertDiary(8, ["2026-07-20"]); // -60: outside both windows
    const offices = byOffice(health());
    expect(offices["office-a"]).toMatchObject({ app_users: 4, active_app_users_30d: 2, active_app_users_prior_30d: 2 });
    expect(offices["office-b"]).toMatchObject({ app_users: 1, active_app_users_30d: 0, active_app_users_prior_30d: 0 });
  });

  it("staff enrolled = linked, non-disabled team members plus the linked account holder", () => {
    resetData();
    insertMember("office-a", "activated", true);
    insertMember("office-a", "activated", true);
    insertMember("office-a", "disabled", true); // disabled: never
    insertMember("office-a", "pending", false); // invited, not linked: never
    insertMember("office-b", "activated", true);
    const offices = byOffice(health());
    expect(offices["office-a"].staff_enrolled).toBe(3); // 2 members + Dr. Alpha
    expect(offices["office-b"].staff_enrolled).toBe(1); // Dr. Beta has no linked sign-in yet
  });
});
