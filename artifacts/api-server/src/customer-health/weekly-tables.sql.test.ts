/**
 * The weekly Customer health tables, applied for real.
 *
 * Boots a throwaway PostgreSQL cluster (unix socket only), mirrors the
 * handful of tables the migration references (auth.users, providers, the
 * staff outbox with its pre-migration kind / scope constraints), applies the
 * canonical weekly-customer-health migration verbatim and asserts:
 *
 *  - preferences: one row per member per kind (an upsert on the key flips
 *    `enabled` instead of duplicating), unknown kinds are rejected, the row
 *    dies with the login (cascade);
 *  - snapshots: one row per office per ISO week (the job's upsert re-writes
 *    the same week), malformed weeks / out-of-range scores / unknown bands
 *    and buckets are rejected, the row dies with the office (cascade), the
 *    per-office history index exists;
 *  - runs: one row per ISO week, same week format check;
 *  - the staff outbox admits `weekly_customer_health` only with a null
 *    provider_id while the office-scoped kinds still require one;
 *  - all three tables are service-role only (RLS on, no grants to anon /
 *    authenticated).
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
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261205000000_weekly_customer_health.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("weekly-tables.sql.test: PostgreSQL binaries not on PATH — weekly customer health table suite skipped");
}

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key, email text);
create table public.providers (
  provider_id text primary key, office_name text, provider_name text, access_disabled boolean default false,
  offboarding_status text not null default 'active', created_at timestamptz not null default now());
-- The staff outbox as the earlier migrations left it (provider_id nullable, three kinds).
create table public.staff_notifications (
  id uuid primary key default gen_random_uuid(),
  provider_id text references public.providers(provider_id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('push', 'email')),
  email text,
  kind text not null default 'staff_attention_digest',
  category text not null default 'staff_alerts' check (category = 'staff_alerts'),
  title text not null, body text not null,
  data jsonb not null default '{}'::jsonb,
  dedupe_key text not null unique,
  scheduled_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 days',
  status text not null default 'queued',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint staff_notifications_kind_check check (kind in ('staff_attention_digest', 'system_threshold', 'office_access_restricted', 'coach_chat_flag')),
  constraint staff_notifications_scope_check check (
    (kind in ('system_threshold', 'office_access_restricted') and provider_id is null)
    or (kind not in ('system_threshold', 'office_access_restricted') and provider_id is not null))
);
`;

let dir = "";
let dataDir = "";
const PORT = 54_800 + (process.pid % 1000);

function psql(sql: string): string {
  return execFileSync(
    "psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8", stdio: "pipe", env: { ...process.env, PGPASSWORD: "" } },
  );
}

function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}

const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";

const SNAPSHOT_COLUMNS =
  "iso_week, provider_id, as_of_date, office_name, rank, score, band, bucket, is_new, last_paid_order_at, active_subscribers, cancelling_subscriptions, app_users, active_app_users_30d, active_app_users_prior_30d, staff_enrolled, flags";
function snapshotValues(week: string, office: string, score: number, overrides: Partial<Record<string, string>> = {}) {
  const v = {
    rank: "1", band: "'healthy'", bucket: "'active'", isNew: "false", lastPaid: "'2026-10-01T12:00:00Z'",
    subs: "3", cancelling: "0", appUsers: "10", active30: "4", prior30: "5", staff: "2", flags: "'[]'::jsonb",
    ...overrides,
  };
  return `('${week}', '${office}', '2026-10-05', 'Office ${office}', ${v.rank}, ${score}, ${v.band}, ${v.bucket}, ${v.isNew}, ${v.lastPaid}, ${v.subs}, ${v.cancelling}, ${v.appUsers}, ${v.active30}, ${v.prior30}, ${v.staff}, ${v.flags})`;
}

function reset() {
  psql(`truncate public.staff_notifications, public.hq_member_notification_preferences, public.office_customer_health_weekly_snapshots, public.customer_health_weekly_runs, public.providers, auth.users cascade;
    insert into auth.users (id, email) values ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test');
    insert into public.providers (provider_id, office_name, provider_name) values ('office-a', 'Harbor Clinic', 'Dr A'), ('office-b', 'Summit Health', 'Dr B');`);
}

describe.skipIf(!POSTGRES_AVAILABLE)("weekly customer health tables (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wch-"));
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

  it("applies the canonical migration verbatim: three tables, RLS on, service-role only", () => {
    const source = readFileSync(MIGRATION, "utf8");
    expect(source).toContain("create table if not exists public.hq_member_notification_preferences");
    const tables = rows<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and c.relname in ('hq_member_notification_preferences', 'office_customer_health_weekly_snapshots', 'customer_health_weekly_runs')
        order by 1`,
    );
    expect(tables).toEqual([
      { relname: "customer_health_weekly_runs", relrowsecurity: true },
      { relname: "hq_member_notification_preferences", relrowsecurity: true },
      { relname: "office_customer_health_weekly_snapshots", relrowsecurity: true },
    ]);
    const grants = rows<{ table_name: string; role: string; can: boolean }>(
      `select t.table_name, r.role, has_table_privilege(r.role, 'public.' || t.table_name, 'SELECT') as can
         from (values ('hq_member_notification_preferences'), ('office_customer_health_weekly_snapshots'), ('customer_health_weekly_runs')) t(table_name)
         cross join (values ('anon'), ('authenticated'), ('service_role')) r(role) order by 1, 2`,
    );
    expect(grants).toHaveLength(9);
    for (const grant of grants) expect(grant.can, `${grant.table_name}/${grant.role}`).toBe(grant.role === "service_role");
    expect(rows("select indexname from pg_indexes where indexname = 'office_customer_health_weekly_snapshots_office_idx'")).toHaveLength(1);
  });

  it("preferences: one row per member per kind, upsert flips enabled, unknown kinds rejected, cascade with the login", () => {
    reset();
    const upsert = (user: string, enabled: boolean) =>
      psql(`insert into public.hq_member_notification_preferences (auth_user_id, kind, enabled) values ('${user}', 'weekly_customer_health_email', ${enabled})
        on conflict (auth_user_id, kind) do update set enabled = excluded.enabled, updated_at = now()`);
    upsert(USER_A, true);
    upsert(USER_A, false);
    upsert(USER_A, true);
    upsert(USER_B, true);
    expect(rows<{ auth_user_id: string; enabled: boolean }>("select auth_user_id, enabled from public.hq_member_notification_preferences order by 1")).toEqual([
      { auth_user_id: USER_A, enabled: true },
      { auth_user_id: USER_B, enabled: true },
    ]);
    expect(() => psql(`insert into public.hq_member_notification_preferences (auth_user_id, kind, enabled) values ('${USER_A}', 'weekly_customer_health_email', true)`)).toThrow(/duplicate key/);
    expect(() => psql(`insert into public.hq_member_notification_preferences (auth_user_id, kind, enabled) values ('${USER_B}', 'daily_digest', true)`)).toThrow(/kind_check/);
    expect(() => psql(`insert into public.hq_member_notification_preferences (auth_user_id, kind, enabled) values ('00000000-0000-4000-8000-0000000000ff', 'weekly_customer_health_email', true)`)).toThrow(/foreign key/);
    psql(`delete from auth.users where id = '${USER_B}'`);
    expect(rows("select auth_user_id from public.hq_member_notification_preferences")).toEqual([{ auth_user_id: USER_A }]);
  });

  it("snapshots: one row per office per ISO week, re-running a week rewrites it, checks hold, cascade with the office", () => {
    reset();
    const insert = (values: string) =>
      psql(`insert into public.office_customer_health_weekly_snapshots (${SNAPSHOT_COLUMNS}) values ${values}
        on conflict (iso_week, provider_id) do update set score = excluded.score, band = excluded.band, bucket = excluded.bucket, rank = excluded.rank, flags = excluded.flags, captured_at = now()`);
    insert(`${snapshotValues("2026-W40", "office-a", 88)}, ${snapshotValues("2026-W40", "office-b", 65, { rank: "2", band: "'watch'" })}`);
    insert(snapshotValues("2026-W41", "office-a", 92));
    // The same week again (a restart that re-ran the job) rewrites rather than duplicates.
    insert(snapshotValues("2026-W41", "office-a", 90, { flags: `'[{"kind":"leavingActive","reason":"Last order 75 days ago"}]'::jsonb` }));
    expect(rows<{ iso_week: string; provider_id: string; score: number; flags: unknown[] }>(
      "select iso_week, provider_id, score, flags from public.office_customer_health_weekly_snapshots order by 1, 2",
    )).toEqual([
      { iso_week: "2026-W40", provider_id: "office-a", score: 88, flags: [] },
      { iso_week: "2026-W40", provider_id: "office-b", score: 65, flags: [] },
      { iso_week: "2026-W41", provider_id: "office-a", score: 90, flags: [{ kind: "leavingActive", reason: "Last order 75 days ago" }] },
    ]);
    // The page's "prior week" read: latest row per office before a given week.
    expect(rows<{ provider_id: string; score: number }>(
      "select provider_id, score from public.office_customer_health_weekly_snapshots where iso_week = '2026-W40' order by 1",
    )).toEqual([{ provider_id: "office-a", score: 88 }, { provider_id: "office-b", score: 65 }]);

    expect(() => insert(snapshotValues("2026-41", "office-a", 50))).toThrow(/iso_week_check/);
    expect(() => insert(snapshotValues("2026-W42", "office-a", 101))).toThrow(/score_check/);
    expect(() => insert(snapshotValues("2026-W42", "office-a", -1))).toThrow(/score_check/);
    expect(() => insert(snapshotValues("2026-W42", "office-a", 50, { band: "'great'" }))).toThrow(/band_check/);
    expect(() => insert(snapshotValues("2026-W42", "office-a", 50, { bucket: "'dormant'" }))).toThrow(/bucket_check/);
    expect(() => insert(snapshotValues("2026-W42", "office-a", 50, { rank: "0" }))).toThrow(/rank_check/);
    expect(() => insert(snapshotValues("2026-W42", "office-a", 50, { subs: "-1" }))).toThrow(/active_subscribers_check/);
    expect(() => insert(snapshotValues("2026-W42", "office-zzz", 50))).toThrow(/foreign key/);

    psql("delete from public.providers where provider_id = 'office-b'");
    expect(rows("select distinct provider_id from public.office_customer_health_weekly_snapshots")).toEqual([{ provider_id: "office-a" }]);
  });

  it("runs: one row per ISO week with the same week format check", () => {
    reset();
    psql("insert into public.customer_health_weekly_runs (iso_week, time_zone, office_count, attention_count, recipients_queued) values ('2026-W41', 'America/New_York', 2, 1, 1)");
    expect(() => psql("insert into public.customer_health_weekly_runs (iso_week, time_zone) values ('2026-W41', 'America/New_York')")).toThrow(/duplicate key/);
    expect(() => psql("insert into public.customer_health_weekly_runs (iso_week, time_zone) values ('week 41', 'America/New_York')")).toThrow(/iso_week_check/);
    expect(() => psql("insert into public.customer_health_weekly_runs (iso_week, time_zone, recipients_queued) values ('2026-W42', 'America/New_York', -1)")).toThrow(/recipients_queued_check/);
    expect(rows<{ iso_week: string; recipients_queued: number }>("select iso_week, recipients_queued from public.customer_health_weekly_runs")).toEqual([{ iso_week: "2026-W41", recipients_queued: 1 }]);
  });

  it("staff outbox: weekly_customer_health is HQ-addressed (provider_id null) and the office kinds still need an office", () => {
    reset();
    const queue = (kind: string, provider: string | null, key: string) =>
      psql(`insert into public.staff_notifications (provider_id, auth_user_id, channel, email, kind, title, body, dedupe_key)
        values (${provider ? `'${provider}'` : "null"}, '${USER_A}', 'email', 'a@example.test', '${kind}', 'Customer health — week of 5 Oct', 'Summary', '${key}')`);
    queue("weekly_customer_health", null, "weekly_customer_health:2026-W41:a:email");
    expect(() => queue("weekly_customer_health", null, "weekly_customer_health:2026-W41:a:email")).toThrow(/duplicate key/);
    expect(() => queue("weekly_customer_health", "office-a", "weekly_customer_health:2026-W41:a:office")).toThrow(/scope_check/);
    expect(() => queue("staff_attention_digest", null, "digest:a")).toThrow(/scope_check/);
    queue("staff_attention_digest", "office-a", "digest:a");
    queue("system_threshold", null, "threshold:a");
    expect(() => queue("weekly_office_health", null, "other:a")).toThrow(/kind_check/);
    expect(rows<{ kind: string; provider_id: string | null }>("select kind, provider_id from public.staff_notifications order by 1")).toEqual([
      { kind: "staff_attention_digest", provider_id: "office-a" },
      { kind: "system_threshold", provider_id: null },
      { kind: "weekly_customer_health", provider_id: null },
    ]);
  });
});
