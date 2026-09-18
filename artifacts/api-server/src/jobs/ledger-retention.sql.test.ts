/**
 * The ledger retention SQL (job runs, sign-ins, webhook event rows), run for
 * real. The keep-latest-N floor, the "never an account's latest active
 * session" guard, the live-session and report-token guards, cascading item
 * failures, the final-only webhook rule, dry-run neutrality, and batch
 * bounds are the pieces a PostgREST fake cannot prove. Boots a throwaway
 * PostgreSQL cluster, applies the canonical migration verbatim over minimal
 * mirrors of the tables it touches, and asserts behaviour. Skips loudly
 * without PostgreSQL binaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261027000000_ledger_retention.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("jobs/ledger-retention.sql.test: PostgreSQL binaries not on PATH — suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table auth.users (id uuid primary key);
create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade);
create table public.hq_organization_settings (singleton boolean primary key default true, version integer not null default 1);
insert into public.hq_organization_settings default values;
create table public.system_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  trigger text not null default 'schedule',
  dry_run boolean not null default false,
  status text not null default 'succeeded',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  failure_count integer not null default 0,
  error text);
create table public.system_job_item_failures (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.system_job_runs(id) on delete cascade,
  job_name text not null, item text not null, error text not null,
  occurred_at timestamptz not null default now());
create table public.auth_sign_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  realm text not null default 'patient', method text not null default 'email_code', platform text not null default 'web',
  device_fingerprint text not null default 'fingerprint-1', new_device boolean not null default false,
  session_id uuid,
  created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  revoked_at timestamptz, revoked_reason text, reported_at timestamptz,
  report_token_hash text, report_token_expires_at timestamptz);
create unique index auth_sign_ins_session_key on public.auth_sign_ins(session_id) where session_id is not null;
create table public.billing_webhook_events (
  stripe_event_id text primary key, kind text not null default 'connect', type text not null default 'x', livemode boolean not null default false,
  received_at timestamptz not null default now(), processed_at timestamptz, error text, payload jsonb, payload_pruned_at timestamptz,
  claimed_at timestamptz, retry_count integer not null default 0);
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
function scalar<T = unknown>(sql: string): T {
  return rows<{ v: T }>(`select (select ${sql}) as v`)[0].v;
}
/** Run `sql` as the service role (the sign-in trim refuses anyone else). */
function asService<T = unknown>(sql: string): T {
  return rows<{ v: T }>(`select set_config('test.role', 'service_role', true), (select ${sql}) as v`)[0].v;
}
function fails(sql: string): string {
  try {
    psql(sql);
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-09-07T12:00:00Z";
const daysAgo = (days: number) => `timestamptz '${NOW}' - interval '${days} days'`;
const CUTOFF_180 = daysAgo(180);
const CUTOFF_90 = daysAgo(90);
const CUTOFF_365 = daysAgo(365);

describe.skipIf(!POSTGRES_AVAILABLE)("ledger retention SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lr-"));
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
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("adds the three policy columns with their defaults and bounds, and keeps the functions service-role only", () => {
    expect(rows(`select retention_job_run_days, retention_sign_in_days, retention_webhook_event_days from public.hq_organization_settings`)).toEqual([
      { retention_job_run_days: 90, retention_sign_in_days: 180, retention_webhook_event_days: 365 },
    ]);
    expect(fails(`update public.hq_organization_settings set retention_job_run_days = 6`)).toContain("check");
    expect(fails(`update public.hq_organization_settings set retention_sign_in_days = 29`)).toContain("check");
    expect(fails(`update public.hq_organization_settings set retention_webhook_event_days = 3651`)).toContain("check");
    for (const sig of [
      "public.retention_trim_job_runs(timestamptz,integer,integer,boolean)",
      "public.retention_trim_sign_ins(timestamptz,timestamptz,integer,boolean)",
      "public.retention_trim_billing_webhook_events(timestamptz,integer,boolean)",
    ]) {
      expect(scalar<boolean>(`has_function_privilege('anon', '${sig}', 'execute')`)).toBe(false);
      expect(scalar<boolean>(`has_function_privilege('authenticated', '${sig}', 'execute')`)).toBe(false);
      expect(scalar<boolean>(`has_function_privilege('service_role', '${sig}', 'execute')`)).toBe(true);
    }
  });

  describe("job run ledger", () => {
    beforeEach(() => {
      psql(`delete from public.system_job_runs`);
    });

    /** `count` runs for `job`, evenly spaced from `oldestDays` ago up to 1 day ago (newest first = smallest age). */
    function seedRuns(job: string, count: number, oldestDays: number) {
      psql(
        `insert into public.system_job_runs (job_name, started_at)
         select '${job}', ${daysAgo(0)} - (interval '1 day' * (1 + (${oldestDays - 1}) * (g - 1) / greatest(${count} - 1, 1)))
           from generate_series(1, ${count}) g`,
      );
    }

    it("deletes runs older than the cutoff but always keeps the latest N per job, cascading item failures", () => {
      seedRuns("busy", 80, 400); // 80 runs spread over 400 days: ~62 older than 90 days
      seedRuns("quiet", 10, 400); // 10 runs, most ancient — all inside the keep floor
      const oldest = scalar<string>(`id::text from public.system_job_runs where job_name = 'busy' order by started_at asc limit 1`);
      psql(`insert into public.system_job_item_failures (run_id, job_name, item, error) values ('${oldest}', 'busy', 'a', 'x'), ('${oldest}', 'busy', 'b', 'y')`);
      const busyOld = scalar<number>(`count(*) from public.system_job_runs where job_name = 'busy' and started_at < ${CUTOFF_90}`);
      expect(busyOld).toBeGreaterThan(50);

      const dry = rows<{ runs_deleted: number; item_failures_deleted: number }>(
        `select * from public.retention_trim_job_runs(${CUTOFF_90}, 50, 1000, true)`,
      )[0];
      expect(dry).toEqual({ runs_deleted: 80 - 50, item_failures_deleted: 2 });
      expect(scalar<number>(`count(*) from public.system_job_runs`)).toBe(90);
      expect(scalar<number>(`count(*) from public.system_job_item_failures`)).toBe(2);

      const live = rows<{ runs_deleted: number; item_failures_deleted: number }>(
        `select * from public.retention_trim_job_runs(${CUTOFF_90}, 50, 1000, false)`,
      )[0];
      expect(live).toEqual({ runs_deleted: 30, item_failures_deleted: 2 });
      expect(scalar<number>(`count(*) from public.system_job_runs where job_name = 'busy'`)).toBe(50);
      expect(scalar<number>(`count(*) from public.system_job_runs where job_name = 'quiet'`)).toBe(10);
      expect(scalar<number>(`count(*) from public.system_job_item_failures`)).toBe(0);
      // The survivors are exactly the newest 50.
      expect(scalar<boolean>(`bool_and(rn <= 50) from (select row_number() over (order by started_at desc) rn from public.system_job_runs where job_name = 'busy') r`)).toBe(true);
      // A second pass finds nothing.
      expect(rows(`select * from public.retention_trim_job_runs(${CUTOFF_90}, 50, 1000, false)`)[0]).toEqual({ runs_deleted: 0, item_failures_deleted: 0 });
    });

    it("keeps the newest N even when every run is ancient, and a keep of 0 trims to the cutoff alone", () => {
      seedRuns("archive", 60, 800);
      // Push every run past the cutoff: the newest is now ~401 days old.
      psql(`update public.system_job_runs set started_at = started_at - interval '400 days' where job_name = 'archive'`);
      expect(scalar<number>(`count(*) from public.system_job_runs where started_at >= ${CUTOFF_90}`)).toBe(0);
      expect(rows(`select * from public.retention_trim_job_runs(${CUTOFF_90}, 50, 1000, false)`)[0]).toEqual({ runs_deleted: 10, item_failures_deleted: 0 });
      expect(scalar<number>(`count(*) from public.system_job_runs`)).toBe(50);
      expect(rows(`select * from public.retention_trim_job_runs(${CUTOFF_90}, 0, 1000, false)`)[0]).toEqual({ runs_deleted: 50, item_failures_deleted: 0 });
      expect(scalar<number>(`count(*) from public.system_job_runs`)).toBe(0);
    });

    it("honours the batch limit oldest-first and refuses a null cutoff", () => {
      seedRuns("paged", 70, 400);
      psql(`update public.system_job_runs set started_at = started_at - interval '400 days'`);
      const first = rows<{ runs_deleted: number }>(`select * from public.retention_trim_job_runs(${CUTOFF_90}, 50, 5, false)`)[0];
      expect(first.runs_deleted).toBe(5);
      expect(scalar<number>(`count(*) from public.system_job_runs`)).toBe(65);
      // The five oldest went first: the survivor floor is now the 65 newest.
      expect(scalar<boolean>(`min(started_at) > ${daysAgo(800)} - interval '1 day' from public.system_job_runs`)).toBe(true);
      expect(fails(`select * from public.retention_trim_job_runs(null, 50, 5, false)`)).toContain("cutoff is required");
    });
  });

  describe("sign-in ledger", () => {
    const U1 = uuid(11);
    const U2 = uuid(12);
    const S = (n: number) => uuid(100 + n);

    beforeEach(() => {
      psql(`delete from public.auth_sign_ins; delete from auth.sessions; delete from auth.users;
            insert into auth.users (id) values ('${U1}'), ('${U2}')`);
    });

    function signIn(opts: { user: string; ageDays: number; session?: string | null; revoked?: boolean; tokenDaysLeft?: number | null; label: string }) {
      const session = opts.session ? `'${opts.session}'` : "null";
      const revoked = opts.revoked ? `${daysAgo(opts.ageDays - 1)}` : "null";
      const tokenExpires = opts.tokenDaysLeft === undefined || opts.tokenDaysLeft === null
        ? "null"
        : `${daysAgo(0)} + interval '${opts.tokenDaysLeft} days'`;
      const tokenHash = opts.tokenDaysLeft === undefined || opts.tokenDaysLeft === null ? "null" : `'${opts.label.padEnd(64, "0")}'`;
      psql(
        `insert into public.auth_sign_ins (user_id, session_id, created_at, last_seen_at, revoked_at, revoked_reason, report_token_hash, report_token_expires_at, device_fingerprint)
         values ('${opts.user}', ${session}, ${daysAgo(opts.ageDays)}, ${daysAgo(opts.ageDays)}, ${revoked}, ${opts.revoked ? "'signed_out_others'" : "null"}, ${tokenHash}, ${tokenExpires}, '${opts.label}-fp')`,
      );
    }
    const labels = () => rows<{ l: string }>(`select device_fingerprint as l from public.auth_sign_ins order by created_at`).map((r) => r.l.replace(/-fp$/, ""));

    it("refuses anyone but the service role and requires both instants", () => {
      expect(fails(`select public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)}, 500, true)`)).toContain("service role required");
      expect(fails(`select set_config('test.role', 'service_role', true), public.retention_trim_sign_ins(null, ${daysAgo(0)}, 500, true)`)).toContain("required");
      expect(fails(`select set_config('test.role', 'service_role', true), public.retention_trim_sign_ins(${CUTOFF_180}, null, 500, true)`)).toContain("required");
    });

    it("keeps each account's latest active session however old it is, and deletes the rest past the cutoff", () => {
      // U1: an old attached, unrevoked row (their only session — must survive), an older revoked row (goes),
      // and an old row that never attached a session (goes).
      signIn({ user: U1, ageDays: 300, session: S(1), label: "u1-latest-active" });
      signIn({ user: U1, ageDays: 320, session: S(2), revoked: true, label: "u1-old-revoked" });
      signIn({ user: U1, ageDays: 340, session: null, label: "u1-unattached" });
      // U2: a recent active session, so the old active one is no longer "latest" and goes.
      signIn({ user: U2, ageDays: 10, session: S(3), label: "u2-recent" });
      signIn({ user: U2, ageDays: 200, session: S(4), label: "u2-old-active" });
      // Fresh row inside the window: untouched regardless.
      signIn({ user: U2, ageDays: 5, session: null, label: "u2-fresh" });

      expect(asService<number>(`public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)}, 500, true)`)).toBe(3);
      expect(labels()).toHaveLength(6); // dry run: nothing moved
      expect(asService<number>(`public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)}, 500, false)`)).toBe(3);
      expect(labels()).toEqual(["u1-latest-active", "u2-recent", "u2-fresh"]);
      expect(asService<number>(`public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)}, 500, false)`)).toBe(0);
    });

    it("a revoked row is never 'the latest active session': the next attached, unrevoked row is protected instead", () => {
      signIn({ user: U1, ageDays: 190, session: S(1), revoked: true, label: "revoked-newest" });
      signIn({ user: U1, ageDays: 250, session: S(2), label: "active-older" });
      signIn({ user: U1, ageDays: 260, session: S(3), label: "active-oldest" });
      expect(asService<number>(`public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)}, 500, false)`)).toBe(2);
      expect(labels()).toEqual(["active-older"]);
    });

    it("keeps rows that still back a live GoTrue session, and rows whose report token has not expired", () => {
      psql(`insert into auth.sessions (id, user_id) values ('${S(5)}', '${U1}')`);
      signIn({ user: U1, ageDays: 30, session: S(9), label: "u1-newest-active" });
      signIn({ user: U1, ageDays: 400, session: S(5), label: "u1-live-session" }); // superseded but still live in GoTrue
      signIn({ user: U1, ageDays: 401, session: S(6), label: "u1-dead-session" });
      signIn({ user: U1, ageDays: 402, session: null, tokenDaysLeft: 2, label: "u1-token-live" });
      signIn({ user: U1, ageDays: 403, session: null, tokenDaysLeft: -2, label: "u1-token-expired" });
      expect(asService<number>(`public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)}, 500, false)`)).toBe(2);
      expect(labels()).toEqual(["u1-token-live", "u1-live-session", "u1-newest-active"]);
      // Once the session is gone and the token has lapsed, both go on the next pass.
      psql(`delete from auth.sessions where id = '${S(5)}'`);
      expect(asService<number>(`public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)} + interval '3 days', 500, false)`)).toBe(2);
      expect(labels()).toEqual(["u1-newest-active"]);
    });

    it("walks oldest-first within the batch limit and never lets a batch reach the protected row", () => {
      signIn({ user: U1, ageDays: 500, session: S(1), label: "protected-latest-active" });
      for (let i = 0; i < 7; i += 1) signIn({ user: U1, ageDays: 510 + i, session: null, label: `old-${i}` });
      expect(asService<number>(`public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)}, 3, false)`)).toBe(3);
      expect(labels()).toEqual(["old-3", "old-2", "old-1", "old-0", "protected-latest-active"]);
      expect(asService<number>(`public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)}, 3, false)`)).toBe(3);
      expect(asService<number>(`public.retention_trim_sign_ins(${CUTOFF_180}, ${daysAgo(0)}, 3, false)`)).toBe(1);
      expect(labels()).toEqual(["protected-latest-active"]);
    });
  });

  describe("billing webhook event rows", () => {
    beforeEach(() => {
      psql(`delete from public.billing_webhook_events`);
    });

    function event(id: string, opts: { processedDaysAgo?: number | null; error?: string | null }) {
      const processed = opts.processedDaysAgo === undefined || opts.processedDaysAgo === null ? "null" : daysAgo(opts.processedDaysAgo);
      const error = opts.error ? `'${opts.error}'` : "null";
      psql(`insert into public.billing_webhook_events (stripe_event_id, received_at, processed_at, error) values ('${id}', ${daysAgo(opts.processedDaysAgo ?? 400)}, ${processed}, ${error})`);
    }
    const ids = () => rows<{ id: string }>(`select stripe_event_id as id from public.billing_webhook_events order by stripe_event_id`).map((r) => r.id);

    it("deletes only final rows past the cutoff; unprocessed, failed, and recent rows stay", () => {
      event("evt_final_old", { processedDaysAgo: 400 });
      event("evt_final_older", { processedDaysAgo: 500 });
      event("evt_final_recent", { processedDaysAgo: 30 });
      event("evt_unprocessed", { processedDaysAgo: null });
      event("evt_failed", { processedDaysAgo: null, error: "handler threw" });
      event("evt_processed_with_error", { processedDaysAgo: 400, error: "odd" });
      expect(scalar<number>(`public.retention_trim_billing_webhook_events(${CUTOFF_365}, 500, true)`)).toBe(2);
      expect(ids()).toHaveLength(6);
      expect(scalar<number>(`public.retention_trim_billing_webhook_events(${CUTOFF_365}, 500, false)`)).toBe(2);
      expect(ids()).toEqual(["evt_failed", "evt_final_recent", "evt_processed_with_error", "evt_unprocessed"]);
    });

    it("pages oldest-first by the batch limit and refuses a null cutoff", () => {
      for (let i = 0; i < 5; i += 1) event(`evt_${i}`, { processedDaysAgo: 400 + i });
      expect(scalar<number>(`public.retention_trim_billing_webhook_events(${CUTOFF_365}, 2, false)`)).toBe(2);
      expect(ids()).toEqual(["evt_0", "evt_1", "evt_2"]);
      expect(scalar<number>(`public.retention_trim_billing_webhook_events(${CUTOFF_365}, 2, false)`)).toBe(2);
      expect(scalar<number>(`public.retention_trim_billing_webhook_events(${CUTOFF_365}, 2, false)`)).toBe(1);
      expect(ids()).toEqual([]);
      expect(fails(`select public.retention_trim_billing_webhook_events(null, 2, false)`)).toContain("cutoff is required");
    });
  });
});
