/**
 * The outbox lease RPC, run for real.
 *
 * claim_patient_notifications is the piece a fake cannot prove: two API
 * processes must never claim the same row. This suite boots a throwaway
 * PostgreSQL cluster (unix socket only), applies the canonical migration
 * verbatim over a minimal mirror of the tables it references, and asserts
 * lease exclusivity, expired-lease reclaim, ordering/limits, grants, and the
 * roster state projection. Skips loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260927000000_push_notifications.sql");
const CAP_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260928100000_outreach_daily_cap.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("claim.sql.test: PostgreSQL binaries not on PATH — lease RPC suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create function private.install_patient_identity_write_guards() returns integer language sql as $$ select 0 $$;
create table public.patients (
  id uuid primary key, provider_id text not null, timezone text, first_name text, name text,
  starting_weight numeric, activation_status text default 'activated', archived_at timestamptz, created_at timestamptz default now());
create table public.patient_flags (
  patient_id uuid primary key references public.patients(id), nudge_opt_out boolean default false,
  nudge_engaged boolean default false, nudge_last_sent_key date, nudge_last_crossing_key date);
`;

let dir = "";
let dataDir = "";
const PORT = 54_800 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];

function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8" });
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function seedNotifications(count: number, patient = 1) {
  psql(`insert into public.patients (id, provider_id) values ('${uuid(patient)}', 'prov') on conflict do nothing`);
  for (let i = 1; i <= count; i++) {
    psql(
      `insert into public.patient_notifications (id, patient_id, kind, category, title, body, next_attempt_at, created_at)
       values ('${uuid(100 + i)}', '${uuid(patient)}', 'coach_outreach', 'coach_outreach', 't', 'b', now() - interval '${count - i + 1} minutes', now() - interval '${count - i + 1} minutes')`,
    );
  }
}
const claim = (owner: string, limit = 25, lease = 120) =>
  rows<{ id: string; status: string; lease_owner: string; lease_until: string }>(
    `select id, status, lease_owner, lease_until from public.claim_patient_notifications('${owner}', ${limit}, ${lease}) order by created_at`,
  );

describe.skipIf(!POSTGRES_AVAILABLE)("claim_patient_notifications (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pn-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION, CAP_MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies the canonical migration verbatim and keeps everything service-role only", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("claim_patient_notifications");
    const grants = rows<{ grantee: string; table_name: string }>(
      `select grantee, table_name from information_schema.role_table_grants
       where table_schema = 'public' and table_name in ('patient_push_tokens','patient_notifications','patient_notification_attempts','patient_outreach_state')
         and grantee in ('anon','authenticated')`,
    );
    expect(grants).toEqual([]);
    const rls = rows<{ relname: string; rls: boolean }>(
      `select relname, relrowsecurity as rls from pg_class where relname in ('patient_push_tokens','patient_notifications','patient_notification_attempts','patient_outreach_state')`,
    );
    expect(rls.every((r) => r.rls)).toBe(true);
    const fn = rows<{ ok: boolean }>(`select has_function_privilege('anon', 'public.claim_patient_notifications(text,integer,integer)', 'execute') as ok`);
    expect(fn[0].ok).toBe(false);
    expect(rows<{ ok: boolean }>(`select has_function_privilege('service_role', 'public.claim_patient_notifications(text,integer,integer)', 'execute') as ok`)[0].ok).toBe(true);
  });

  it("claims due rows oldest-first, leases them, and hides them from later claimants until the lease lapses", () => {
    psql("truncate public.patient_notifications cascade");
    seedNotifications(3);
    // A future row is not due.
    psql(`insert into public.patient_notifications (id, patient_id, kind, category, title, body, next_attempt_at)
          values ('${uuid(199)}', '${uuid(1)}', 'coach_outreach', 'coach_outreach', 't', 'b', now() + interval '1 hour')`);
    const first = claim("worker-a", 2);
    expect(first.map((r) => r.id)).toEqual([uuid(101), uuid(102)]);
    expect(first.every((r) => r.status === "sending" && r.lease_owner === "worker-a")).toBe(true);
    const second = claim("worker-b", 10);
    expect(second.map((r) => r.id)).toEqual([uuid(103)]);
    expect(claim("worker-c")).toEqual([]);
    // Expire A's lease: B reclaims those rows, and only those.
    psql(`update public.patient_notifications set lease_until = now() - interval '1 second' where lease_owner = 'worker-a'`);
    const reclaimed = claim("worker-b", 10);
    expect(reclaimed.map((r) => r.id)).toEqual([uuid(101), uuid(102)]);
    expect(reclaimed.every((r) => r.lease_owner === "worker-b")).toBe(true);
    // Terminal rows are never claimed even when due.
    psql(`update public.patient_notifications set status = 'sent', lease_owner = null, lease_until = null where id = '${uuid(103)}'`);
    psql(`update public.patient_notifications set lease_until = now() - interval '1 second'`);
    expect(claim("worker-d", 10).map((r) => r.id)).toEqual([uuid(101), uuid(102)]);
  });

  it("clamps the limit and lease and requires an owner", () => {
    psql("truncate public.patient_notifications cascade");
    seedNotifications(2);
    const [row] = claim("worker-a", 0, 1);
    expect(row.id).toBe(uuid(101));
    const secs = rows<{ secs: number }>(`select extract(epoch from (lease_until - now())) as secs from public.patient_notifications where id = '${uuid(101)}'`)[0].secs;
    expect(Number(secs)).toBeGreaterThan(8);
    expect(() => psql(`select * from public.claim_patient_notifications('', 1, 10)`)).toThrow(/lease owner is required/);
  });

  it("never hands the same row to two concurrent claimants (SKIP LOCKED)", async () => {
    psql("truncate public.patient_notifications cascade");
    seedNotifications(2);
    // Worker A claims inside an open transaction and holds it for a moment.
    const holder = spawn("psql", [...PSQL_ARGS(), "-c", `begin; select id from public.claim_patient_notifications('worker-a', 1, 120); select pg_sleep(1.5); commit;`]);
    let holderOut = "";
    holder.stdout.on("data", (chunk) => (holderOut += String(chunk)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Worker B, concurrently: must skip the locked row and take the other.
    const b = claim("worker-b", 10);
    await new Promise<void>((resolve) => holder.on("close", () => resolve()));
    const aId = holderOut.trim().split("\n").find((line) => line.startsWith("00000000"));
    expect(aId).toBe(uuid(101));
    expect(b.map((r) => r.id)).toEqual([uuid(102)]);
    const owners = rows<{ id: string; lease_owner: string }>(`select id, lease_owner from public.patient_notifications order by id`);
    expect(owners).toEqual([
      { id: uuid(101), lease_owner: "worker-a" },
      { id: uuid(102), lease_owner: "worker-b" },
    ]);
  }, 20_000);

  describe("enqueue_outreach_capped", () => {
    const CAP_FN = "public.enqueue_outreach_capped(uuid,text,text,text,text,jsonb,text,timestamptz,timestamptz,integer,timestamptz)";
    const reserveSql = (patient: number, key: string, cap: number, since = "date_trunc('day', now())") =>
      `select public.enqueue_outreach_capped('${uuid(patient)}', 'coach_outreach', 'coach_outreach', 'Coach', 'body', '{"route":"/coach-chat"}'::jsonb, '${key}', now(), null, ${cap}, ${since})`;
    const reserve = (patient: number, key: string, cap: number, since?: string) =>
      JSON.parse(psql(reserveSql(patient, key, cap, since)).trim()) as { outcome: string; row: { id: string; dedupe_key: string } | null; sent?: number };

    it("is service-role only", () => {
      expect(rows<{ ok: boolean }>(`select has_function_privilege('anon', '${CAP_FN}', 'execute') as ok`)[0].ok).toBe(false);
      expect(rows<{ ok: boolean }>(`select has_function_privilege('authenticated', '${CAP_FN}', 'execute') as ok`)[0].ok).toBe(false);
      expect(rows<{ ok: boolean }>(`select has_function_privilege('service_role', '${CAP_FN}', 'execute') as ok`)[0].ok).toBe(true);
    });

    it("reserves up to the cap, dedupes without taking a slot, and resets with the window", () => {
      psql("truncate public.patient_notifications cascade");
      psql(`insert into public.patients (id, provider_id) values ('${uuid(11)}', 'prov'), ('${uuid(12)}', 'prov'), ('${uuid(13)}', 'prov') on conflict do nothing`);
      const first = reserve(11, "coach_outreach:p1:2026-06-20", 2);
      expect(first.outcome).toBe("created");
      expect(first.row?.dedupe_key).toBe("coach_outreach:p1:2026-06-20");
      // Same key again: the existing row, no second slot consumed.
      const again = reserve(11, "coach_outreach:p1:2026-06-20", 2);
      expect(again.outcome).toBe("existing");
      expect(again.row?.id).toBe(first.row?.id);
      expect(reserve(12, "coach_outreach:p2:2026-06-20", 2).outcome).toBe("created");
      const capped = reserve(13, "coach_outreach:p3:2026-06-20", 2);
      expect(capped).toMatchObject({ outcome: "capped", row: null, sent: 2 });
      expect(rows(`select id from public.patient_notifications`)).toHaveLength(2);
      // A window that starts after those rows sees a fresh cap.
      expect(reserve(13, "coach_outreach:p3:2026-06-20", 2, "now() + interval '1 minute'").outcome).toBe("created");
      // Only rows of the same kind count.
      psql(`insert into public.patient_notifications (patient_id, kind, category, title, body) values ('${uuid(11)}', 'check_in_reminder', 'check_in_reminders', 't', 'b')`);
      expect(reserve(12, "coach_outreach:p2:2026-06-21", 4).outcome).toBe("created");
      expect(() => psql(reserveSql(11, "", 2))).toThrow(/dedupe key is required/);
      expect(() => psql(reserveSql(11, "k", 0))).toThrow(/daily cap must be at least 1/);
    });

    it("serializes concurrent workers so two processes cannot both take the last slot", async () => {
      psql("truncate public.patient_notifications cascade");
      psql(`insert into public.patients (id, provider_id) values ('${uuid(11)}', 'prov'), ('${uuid(12)}', 'prov') on conflict do nothing`);
      // Worker A reserves the only slot inside an open transaction and lingers
      // before committing — the window in which a count-then-insert worker
      // would also see zero rows.
      const holder = spawn("psql", [
        ...PSQL_ARGS(),
        "-c",
        `begin; ${reserveSql(11, "coach_outreach:p1:2026-06-20", 1)}; select pg_sleep(1.5); commit;`,
      ]);
      let holderOut = "";
      holder.stdout.on("data", (chunk) => (holderOut += String(chunk)));
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Worker B, concurrently: blocks on the reservation lock until A commits,
      // then counts A's committed row and is capped.
      const startedAt = Date.now();
      const b = reserve(12, "coach_outreach:p2:2026-06-20", 1);
      const waitedMs = Date.now() - startedAt;
      await new Promise<void>((resolve) => holder.on("close", () => resolve()));
      expect(holderOut).toContain('"outcome": "created"');
      expect(b).toMatchObject({ outcome: "capped", row: null, sent: 1 });
      expect(waitedMs).toBeGreaterThan(500);
      expect(rows(`select id from public.patient_notifications`)).toHaveLength(1);
    }, 20_000);
  });

  it("projects the office outreach state for the roster chip", () => {
    psql("truncate public.patient_notifications, public.patient_outreach_state, public.patient_flags cascade");
    psql(`insert into public.patients (id, provider_id) values ('${uuid(2)}', 'prov'), ('${uuid(3)}', 'other') on conflict do nothing`);
    psql(`insert into public.patient_flags (patient_id, nudge_last_sent_key, nudge_last_crossing_key) values ('${uuid(1)}', '2026-06-21', '2026-06-20')`);
    psql(`insert into public.patient_outreach_state (patient_id, provider_id, evaluated_at, as_of_date, eligible, crossed_on_key, decision)
          values ('${uuid(1)}', 'prov', now(), '2026-06-21', true, '2026-06-20', 'send'), ('${uuid(3)}', 'other', now(), '2026-06-21', true, '2026-06-20', 'send')`);
    psql(`insert into public.patient_notifications (patient_id, kind, category, title, body, status, created_at) values
          ('${uuid(1)}', 'coach_outreach', 'coach_outreach', 't', 'old', 'failed', now() - interval '2 days'),
          ('${uuid(1)}', 'coach_outreach', 'coach_outreach', 't', 'new', 'delivered', now() - interval '1 day'),
          ('${uuid(1)}', 'check_in_reminder', 'check_in_reminders', 't', 'other kind', 'sent', now())`);
    const states = rows(`select patient_id, eligible, crossed_on_key, decision, nudge_last_sent_key, notification_status from public.provider_outreach_states('prov') order by patient_id`);
    // Patient 2 has no state at all and is omitted; patient 3 belongs to another office.
    expect(states).toEqual([
      { patient_id: uuid(1), eligible: true, crossed_on_key: "2026-06-20", decision: "send", nudge_last_sent_key: "2026-06-21", notification_status: "delivered" },
    ]);
  });
});
