/**
 * Legal holds, run against real PostgreSQL.
 *
 * The pieces a PostgREST fake cannot prove: the hold predicate resolves a
 * patient hold AND an office hold through the patient's provider; the
 * deletion request parks in `held` when a hold lands and resumes with its
 * REMAINING grace when the hold lifts; the purge claim never selects a held
 * request; and every retention trim (chat, notifications, audit compaction,
 * staff alerts, job ledger, sign-ins, webhook events) skips held rows while
 * still trimming everyone else in the same batch. Boots a throwaway cluster,
 * applies the lifecycle migration and the canonical legal-hold migration
 * verbatim over minimal mirrors of the tables they touch. Skips loudly
 * without PostgreSQL binaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIFECYCLE = path.resolve(here, "../../../../supabase/migrations/20260928000000_patient_privacy_lifecycle.sql");
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261107000000_legal_holds.sql");
const OFFBOARDING = path.resolve(here, "../../../../supabase/migrations/20261109000000_office_offboarding.sql");
const REACTIVATION = path.resolve(here, "../../../../supabase/migrations/20261110000000_office_reactivation.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("legal-holds.sql.test: PostgreSQL binaries not on PATH — suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
alter database postgres set test.role = 'service_role';
create table auth.users (id uuid primary key);
create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade);
create table public.providers (provider_id text primary key);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  auth_user_id uuid, first_name text, last_name text, email text, phone text,
  activation_status text not null default 'activated', program_id text, program_start_date date,
  archived_at timestamptz, created_at timestamptz not null default now(), record_retain_until timestamptz, closed_at timestamptz);
create function private.guard_patient_dependency_write() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.patients p where p.id = new.patient_id) then raise exception 'cannot attach data to an unknown patient'; end if;
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
create table public.analytics_events (id bigint generated always as identity primary key, kind text not null, patient_id uuid, provider_id text);
create function public.reject_operational_event_mutation() returns trigger language plpgsql as $$ begin return null; end $$;
create table public.patient_chat_conversations (
  id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id) on delete cascade,
  thread text not null default 'coach', updated_at timestamptz not null default now());
create table public.patient_chat_messages (
  conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade, client_id text not null,
  text text, photo jsonb, created_at timestamptz not null default now(), primary key (conversation_id, client_id));
create table public.patient_media (object_path text primary key, patient_id uuid not null references public.patients(id) on delete cascade, kind text not null default 'chat');
create table public.patient_notifications (
  id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id) on delete cascade,
  status text not null default 'delivered', category text not null default 'account', created_at timestamptz not null default now());
create table public.admin_audit_events (
  id bigint generated always as identity primary key, occurred_at timestamptz not null default now(), action text not null,
  actor_kind text not null default 'staff', provider_id text, target_kind text, target_id text);
create table public.admin_audit_event_archives (
  period_start date not null, action text not null, actor_kind text not null, target_kind text not null, provider_id text not null,
  event_count bigint not null, first_at timestamptz not null, last_at timestamptz not null, archived_at timestamptz not null,
  primary key (period_start, action, actor_kind, target_kind, provider_id));
create table public.staff_notifications (
  id uuid primary key default gen_random_uuid(), provider_id text not null, status text not null default 'sent',
  data jsonb not null default '{}'::jsonb, scheduled_at timestamptz not null default now(), finalized_at timestamptz);
create table public.office_attention_digests (
  id uuid primary key default gen_random_uuid(), provider_id text not null, generated_at timestamptz not null default now(),
  items jsonb not null default '[]'::jsonb);
create table public.system_job_runs (id uuid primary key default gen_random_uuid(), job_name text not null, started_at timestamptz not null default now());
create table public.system_job_item_failures (
  id bigint generated always as identity primary key, run_id uuid not null references public.system_job_runs(id) on delete cascade,
  job_name text not null, item text not null, error text not null default 'x');
create table public.auth_sign_ins (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid, created_at timestamptz not null default now(), revoked_at timestamptz, report_token_expires_at timestamptz);
create table public.billing_connected_accounts (provider_id text primary key references public.providers(provider_id), stripe_account_id text not null unique);
create table public.billing_payers (id uuid primary key default gen_random_uuid(), provider_id text not null, patient_id uuid references public.patients(id) on delete set null, stripe_customer_id text);
create table public.billing_webhook_events (
  stripe_event_id text primary key, account text, processed_at timestamptz, error text, payload jsonb not null default '{}'::jsonb);
select private.install_patient_identity_write_guards();
`;

let dir = "";
let dataDir = "";
const PORT = 55_700 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];

function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}
function scalar<T = unknown>(sql: string): T {
  return rows<{ v: T }>(`select (${sql}) as v`)[0].v;
}
const count = (table: string, where = "true") => scalar<number>(`select count(*)::int from public.${table} where ${where}`);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HELD = uuid(1); // direct patient hold, office-1
const FREE = uuid(2); // no hold, office-1
const OFFICE_HELD = uuid(3); // office-2 is held
const USER_HELD = uuid(901);
const USER_FREE = uuid(902);
const OLD = "'2020-01-01T00:00:00Z'";
const CUTOFF = "'2025-01-01T00:00:00Z'";

const held = (kind: string, id: string, reason = "Subpoena 24-CV-118") =>
  rows<{ id: string }>(`select id from public.legal_hold_place('${kind}', '${id}', '${reason}', '${uuid(500)}')`)[0].id;
const lift = (id: string) => psql(`select public.legal_hold_lift('${id}', 'Matter closed', '${uuid(501)}')`);

function seed() {
  psql(`
    truncate public.legal_holds, public.provider_offboardings, public.patient_deletion_requests, public.patient_chat_messages, public.patient_chat_conversations,
      public.patient_media, public.patient_notifications, public.admin_audit_events, public.admin_audit_event_archives,
      public.staff_notifications, public.office_attention_digests, public.system_job_item_failures, public.system_job_runs,
      public.auth_sign_ins, public.billing_webhook_events, public.billing_payers, public.billing_connected_accounts,
      public.patients cascade;
    delete from auth.sessions; delete from auth.users;
    insert into public.providers values ('office-1'), ('office-2') on conflict do nothing;
    insert into auth.users values ('${USER_HELD}'), ('${USER_FREE}');
    insert into public.patients (id, provider_id, auth_user_id) values
      ('${HELD}', 'office-1', '${USER_HELD}'), ('${FREE}', 'office-1', '${USER_FREE}'), ('${OFFICE_HELD}', 'office-2', null);
  `);
}

describe.skipIf(!POSTGRES_AVAILABLE)("legal holds SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lh-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    // Account closure adds the closed_at / retain columns the offboarding RPCs read.
    writeFileSync(path.join(dir, "closure-columns.sql"), [
      "alter table public.patient_deletion_requests add column if not exists closed_at timestamptz, add column if not exists retain_until timestamptz;",
      "alter table public.patient_deletion_requests drop constraint if exists patient_deletion_requests_status_check;",
      "alter table public.patient_deletion_requests add constraint patient_deletion_requests_status_check check (status in ('pending', 'held', 'closing', 'closed', 'cancelled', 'purging', 'purged', 'failed'));",
    ].join("\n"));
    for (const file of [schemaFile, LIFECYCLE, MIGRATION, path.join(dir, "closure-columns.sql"), OFFBOARDING, REACTIVATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(seed);

  it("keeps the ledger and every RPC service-role only, and refuses bad targets", () => {
    for (const grantee of ["anon", "authenticated"]) {
      expect(rows(`select 1 from information_schema.role_table_grants where table_name = 'legal_holds' and grantee = '${grantee}'`)).toEqual([]);
      for (const fn of [
        "public.legal_hold_active(uuid)", "public.legal_hold_office_active(text)", "public.legal_hold_patient_ids()",
        "public.legal_hold_place(text,text,text,uuid)", "public.legal_hold_lift(uuid,text,uuid)",
      ]) {
        expect(scalar<boolean>(`select has_function_privilege('${grantee}', '${fn}', 'execute')`), `${grantee} ${fn}`).toBe(false);
      }
    }
    expect(scalar<boolean>(`select relrowsecurity from pg_class where relname = 'legal_holds'`)).toBe(true);
    expect(scalar<boolean>(`select prosecdef from pg_proc where proname = 'retention_trim_sign_ins'`)).toBe(true);
    expect(() => held("patient", uuid(99))).toThrow(/unknown patient/);
    expect(() => held("provider", "office-9")).toThrow(/unknown office/);
    expect(() => held("staff", uuid(1))).toThrow(/invalid hold target kind/);
    expect(() => held("patient", HELD, "no")).toThrow(/legal_holds_reason_check/);
    expect(() => psql(`begin; select set_config('test.role', 'authenticated', true); select public.legal_hold_place('patient', '${HELD}', 'Subpoena', null); commit;`)).toThrow(/service role required/);
  });

  it("resolves a hold directly and through the patient's office, once per target, and lifting is a second step", () => {
    const first = held("patient", HELD);
    expect(held("patient", HELD)).toBe(first);
    const office = held("provider", "office-2");
    const active = (id: string) => scalar<boolean>(`select public.legal_hold_active('${id}')`);
    expect([active(HELD), active(FREE), active(OFFICE_HELD)]).toEqual([true, false, true]);
    expect(scalar<boolean>(`select p.legal_hold from public.patients p where p.id = '${OFFICE_HELD}'`)).toBe(true);
    expect(rows<{ id: string }>(`select id from public.legal_hold_patient_ids() id order by 1`).map((r) => r.id)).toEqual([HELD, OFFICE_HELD]);
    // A patient moving into a held office is covered from that moment.
    psql(`update public.patients set provider_id = 'office-2' where id = '${FREE}'`);
    expect(active(FREE)).toBe(true);
    lift(office);
    expect([active(FREE), active(OFFICE_HELD), active(HELD)]).toEqual([false, false, true]);
    expect(() => lift(office)).toThrow(/hold not active/);
    expect(rows(`select lifted_by, lift_reason from public.legal_holds where id = '${office}'`)).toEqual([{ lifted_by: uuid(501), lift_reason: "Matter closed" }]);
    // A fresh hold on the same target is a new row; history stays.
    expect(held("provider", "office-2")).not.toBe(office);
    expect(count("legal_holds")).toBe(3);
  });

  it("parks pending deletion requests as held, keeps them off the claim, and resumes the remaining grace on lift", () => {
    psql(`select public.patient_deletion_request('${HELD}', 0); select public.patient_deletion_request('${FREE}', 0);
          select public.patient_deletion_request('${OFFICE_HELD}', 3600);`);
    const hold = held("patient", HELD);
    const officeHold = held("provider", "office-2");
    const status = (id: string) => rows<{ status: string; held_at: string | null; purge_after: string }>(
      `select status, held_at, purge_after from public.patient_deletion_requests where patient_id = '${id}' and status <> 'cancelled'`)[0];
    expect(status(HELD).status).toBe("held");
    expect(status(HELD).held_at).not.toBeNull();
    expect(status(OFFICE_HELD).status).toBe("held");
    expect(status(FREE).status).toBe("pending");
    // Only the free patient is claimable.
    expect(rows<{ patient_id: string }>(`select patient_id from public.claim_due_patient_deletions('w', 10, 60)`).map((r) => r.patient_id)).toEqual([FREE]);
    // A hold placed AFTER the request but without a status flip still blocks the claim (predicate in the claim itself).
    psql(`update public.patient_deletion_requests set status = 'pending' where patient_id = '${HELD}'`);
    expect(rows(`select 1 from public.claim_due_patient_deletions('w', 10, 60)`)).toEqual([]);
    psql(`update public.patient_deletion_requests set status = 'held' where patient_id = '${HELD}'`);
    // A request made while held starts held; the patient can still cancel it.
    expect(scalar<boolean>(`select public.patient_deletion_cancel('${OFFICE_HELD}')`)).toBe(true);
    psql(`select public.patient_deletion_request('${OFFICE_HELD}', 0)`);
    expect(status(OFFICE_HELD).status).toBe("held");
    // Lift: the office request resumes as due (it had no grace left), and the
    // direct patient hold still parks the other one.
    lift(officeHold);
    expect(status(OFFICE_HELD).status).toBe("pending");
    expect(status(HELD).status).toBe("held");
    expect(rows<{ patient_id: string }>(`select patient_id from public.claim_due_patient_deletions('w', 10, 60)`).map((r) => r.patient_id)).toEqual([OFFICE_HELD]);
    // Remaining grace is preserved: 1h left when held → ~1h left after the lift, not a fresh window and not immediate.
    psql(`update public.patient_deletion_requests set purge_after = held_at + interval '1 hour' where patient_id = '${HELD}'`);
    psql(`update public.patient_deletion_requests set held_at = now() - interval '3 days' , purge_after = now() - interval '3 days' + interval '1 hour' where patient_id = '${HELD}'`);
    lift(hold);
    const resumed = status(HELD);
    expect(resumed.status).toBe("pending");
    expect(resumed.held_at).toBeNull();
    const secondsLeft = scalar<number>(`select extract(epoch from (purge_after - now()))::int from public.patient_deletion_requests where patient_id = '${HELD}'`);
    expect(secondsLeft).toBeGreaterThan(3500);
    expect(secondsLeft).toBeLessThanOrEqual(3600);
  });

  it("chat and notification trims skip held patients (direct and via office) while trimming everyone else", () => {
    for (const [pid, n] of [[HELD, 11], [FREE, 12], [OFFICE_HELD, 13]] as const) {
      psql(`insert into public.patient_chat_conversations (id, patient_id, thread, updated_at) values ('${uuid(n)}', '${pid}', 'coach', ${OLD});
            insert into public.patient_chat_messages (conversation_id, client_id, text, created_at) values ('${uuid(n)}', 'm1', 'old', ${OLD});
            insert into public.patient_notifications (patient_id, created_at) values ('${pid}', ${OLD});`);
    }
    held("patient", HELD);
    held("provider", "office-2");
    const trim = rows<{ messages_deleted: number; conversations_deleted: number }>(`select * from public.retention_trim_chat_transcripts(${CUTOFF}, 100, false)`)[0];
    expect(trim).toMatchObject({ messages_deleted: 1, conversations_deleted: 1 });
    expect(rows<{ patient_id: string }>(`select patient_id from public.patient_chat_conversations order by 1`).map((r) => r.patient_id)).toEqual([HELD, OFFICE_HELD]);
    expect(scalar<number>(`select public.retention_trim_notifications(${CUTOFF}, 100, false)`)).toBe(1);
    expect(rows<{ patient_id: string }>(`select patient_id from public.patient_notifications order by 1`).map((r) => r.patient_id)).toEqual([HELD, OFFICE_HELD]);
    // Dry run counts what a live run would touch: still only the free patient.
    expect(scalar<number>(`select public.retention_trim_notifications(${CUTOFF}, 100, true)`)).toBe(0);
  });

  it("audit compaction and staff alert trims skip a held office's rows and rows about a held patient", () => {
    psql(`insert into public.admin_audit_events (occurred_at, action, provider_id, target_kind, target_id) values
            (${OLD}, 'a', 'office-1', 'patient', '${HELD}'), (${OLD}, 'a', 'office-1', 'patient', '${FREE}'),
            (${OLD}, 'a', 'office-2', null, null), (${OLD}, 'a', null, 'hq_setting', 'x');
          insert into public.staff_notifications (provider_id, data, scheduled_at) values
            ('office-1', '{"patientId":"${HELD}"}', ${OLD}), ('office-1', '{"patientId":"${FREE}"}', ${OLD}), ('office-2', '{}', ${OLD});
          insert into public.office_attention_digests (provider_id, generated_at, items) values
            ('office-1', ${OLD}, '[{"patientId":"${HELD}"}]'), ('office-1', ${OLD}, '[{"patientId":"${FREE}"}]'), ('office-2', ${OLD}, '[]');`);
    held("patient", HELD);
    held("provider", "office-2");
    expect(rows(`select * from public.retention_archive_audit_events(${CUTOFF}, 100, false)`)[0]).toMatchObject({ events_archived: 2 });
    expect(rows<{ target_id: string | null; provider_id: string | null }>(`select target_id, provider_id from public.admin_audit_events order by id`)).toEqual([
      { target_id: HELD, provider_id: "office-1" }, { target_id: null, provider_id: "office-2" },
    ]);
    expect(scalar<number>(`select public.retention_trim_staff_alerts(${CUTOFF}, 100, false)`)).toBe(2);
    expect(rows<{ provider_id: string; data: { patientId?: string } }>(`select provider_id, data from public.staff_notifications order by provider_id`)).toEqual([
      { provider_id: "office-1", data: { patientId: HELD } }, { provider_id: "office-2", data: {} },
    ]);
    expect(count("office_attention_digests")).toBe(2);
    expect(count("office_attention_digests", `items::text like '%${FREE}%'`)).toBe(0);
  });

  it("job ledger, sign-in, and webhook trims keep rows tied to a held patient or office", () => {
    psql(`insert into public.system_job_runs (id, job_name, started_at) values ('${uuid(31)}', 'j', ${OLD}), ('${uuid(32)}', 'j', ${OLD}), ('${uuid(33)}', 'j', ${OLD}), ('${uuid(34)}', 'j', now());
          insert into public.system_job_item_failures (run_id, job_name, item) values
            ('${uuid(31)}', 'j', '/objects/patient-media/${HELD}/photo.jpg'), ('${uuid(32)}', 'j', 'office:office-2'), ('${uuid(33)}', 'j', '/objects/patient-media/${FREE}/photo.jpg');
          insert into public.auth_sign_ins (user_id, created_at) values ('${USER_HELD}', ${OLD}), ('${USER_HELD}', ${OLD}), ('${USER_FREE}', ${OLD}), ('${USER_FREE}', ${OLD});
          insert into public.billing_connected_accounts values ('office-1', 'acct_1'), ('office-2', 'acct_2');
          insert into public.billing_payers (provider_id, patient_id, stripe_customer_id) values ('office-1', '${HELD}', 'cus_held'), ('office-1', '${FREE}', 'cus_free');
          insert into public.billing_webhook_events (stripe_event_id, account, processed_at, payload) values
            ('evt_office_held', 'acct_2', ${OLD}, '{}'), ('evt_patient_held', 'acct_1', ${OLD}, '{"data":{"object":{"customer":"cus_held"}}}'),
            ('evt_free', 'acct_1', ${OLD}, '{"data":{"object":{"customer":"cus_free"}}}'), ('evt_plain', 'acct_1', ${OLD}, '{}');`);
    held("patient", HELD);
    held("provider", "office-2");
    expect(rows(`select * from public.retention_trim_job_runs(${CUTOFF}, 0, 100, false)`)[0]).toMatchObject({ runs_deleted: 1, item_failures_deleted: 1 });
    expect(rows<{ id: string }>(`select id from public.system_job_runs order by id`).map((r) => r.id)).toEqual([uuid(31), uuid(32), uuid(34)]);
    expect(scalar<number>(`select public.retention_trim_sign_ins(${CUTOFF}, now(), 100, false)`)).toBe(2);
    expect(count("auth_sign_ins", `user_id = '${USER_FREE}'`)).toBe(0);
    expect(count("auth_sign_ins", `user_id = '${USER_HELD}'`)).toBe(2);
    expect(scalar<number>(`select public.retention_trim_billing_webhook_events(${CUTOFF}, 100, false)`)).toBe(2);
    expect(rows<{ id: string }>(`select stripe_event_id as id from public.billing_webhook_events order by 1`).map((r) => r.id)).toEqual(["evt_office_held", "evt_patient_held"]);
  });
  it("office offboarding: seal batch respects office and patient holds, is idempotent, pins retain-until, and the claim RPC leases only that office", () => {
    const seal = (retain = "null") => scalar<number>(`select public.office_offboarding_seal_batch('office-1', ${retain}, 200)`);
    for (const grantee of ["anon", "authenticated"]) {
      for (const fn of ["public.office_offboarding_patients(text)", "public.office_offboarding_seal_batch(text,timestamptz,integer)",
        "public.office_offboarding_progress(text)", "public.claim_office_patient_deletions(text,text,integer,integer)"]) {
        expect(scalar<boolean>(`select has_function_privilege('${grantee}', '${fn}', 'execute')`), `${grantee} ${fn}`).toBe(false);
      }
      expect(rows(`select 1 from information_schema.role_table_grants where table_name = 'provider_offboardings' and grantee = '${grantee}'`)).toEqual([]);
    }
    const officeHold = held("provider", "office-1");
    expect(() => seal()).toThrow(/legal hold/);
    expect(count("patient_deletion_requests")).toBe(0);
    lift(officeHold);
    held("patient", HELD);
    expect(seal("'2026-12-01T00:00:00Z'")).toBe(2);
    expect(seal("'2026-12-01T00:00:00Z'")).toBe(0);
    expect(count("patient_deletion_requests")).toBe(2);
    expect(rows<{ status: string }>(`select status from public.patient_deletion_requests where patient_id = '${HELD}'`)[0].status).toBe("held");
    expect(rows<{ status: string }>(`select status from public.patient_deletion_requests where patient_id = '${FREE}'`)[0].status).toBe("pending");
    expect(rows<{ n: number }>(`select count(*)::int as n from public.patients where provider_id = 'office-1' and record_retain_until = '2026-12-01T00:00:00Z'`)[0].n).toBe(2);
    expect(rows<{ patient_id: string; held: boolean }>(`select patient_id, held from public.office_offboarding_patients('office-1')`)).toEqual(
      expect.arrayContaining([{ patient_id: HELD, held: true }, { patient_id: FREE, held: false }]));
    const progress = rows<Record<string, number>>(`select * from public.office_offboarding_progress('office-1')`)[0];
    expect({ ...progress }).toMatchObject({ total: 2, sealed: 0, held: 1, pending: 1, failed: 0, destroyed: 0 });
    // Only office-1's due request is leased; a second claimant gets nothing while the lease holds.
    const claimed = rows<{ patient_id: string; status: string; lease_owner: string }>(`select patient_id, status, lease_owner from public.claim_office_patient_deletions('office-1', 'worker-a', 10, 600)`);
    expect(claimed).toEqual([{ patient_id: FREE, status: "closing", lease_owner: "worker-a" }]);
    expect(rows(`select 1 from public.claim_office_patient_deletions('office-1', 'worker-b', 10, 600)`)).toEqual([]);
    expect(rows(`select 1 from public.claim_office_patient_deletions('office-2', 'worker-b', 10, 600)`)).toEqual([]);
    expect(() => psql(`select public.claim_office_patient_deletions('office-1', '', 10, 600)`)).toThrow(/lease owner/);
  });

  it("office reactivation: reopens only the charts the offboarding sealed, all or nothing, and refuses once one was destroyed or lapsed", () => {
    for (const grantee of ["anon", "authenticated"]) {
      for (const fn of ["public.office_reactivation_preview(text,timestamptz)", "public.office_reactivate_charts(text,timestamptz)"]) {
        expect(scalar<boolean>(`select has_function_privilege('${grantee}', '${fn}', 'execute')`), `${grantee} ${fn}`).toBe(false);
      }
    }
    const SINCE = "'2026-06-01T00:00:00Z'";
    const preview = () => rows<Record<string, unknown>>(`select * from public.office_reactivation_preview('office-1', ${SINCE})`)[0];
    const reactivate = () => rows<Record<string, number>>(`select * from public.office_reactivate_charts('office-1', ${SINCE})`)[0];
    // Requests land before the charts archive: the identity write guard refuses new rows on an archived patient.
    // A patient-initiated closure from BEFORE the seal is neither reopened nor counted.
    psql(`insert into public.patients (id, provider_id) values ('${uuid(4)}', 'office-1')`);
    psql(`insert into public.patient_deletion_requests (patient_id, provider_id, purge_after, status, closed_at, retain_until) values ('${uuid(4)}', 'office-1', '2026-01-01T00:00:00Z', 'closed', '2026-01-01T00:00:00Z', '2033-01-01T00:00:00Z')`);
    psql(`update public.patients set closed_at = '2026-01-01T00:00:00Z', archived_at = '2026-01-01T00:00:00Z', record_retain_until = '2033-01-01T00:00:00Z' where id = '${uuid(4)}'`);
    // An old tombstone from before the seal does not block either.
    psql(`insert into public.patient_tombstones (id, provider_id, requested_at, purged_at) values ('${uuid(5)}', 'office-1', '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z')`);
    // Both live charts sealed by the offboarding (closed_at after the seal start).
    psql(`insert into public.patient_deletion_requests (patient_id, provider_id, auth_user_id, purge_after, status, closed_at, retain_until, lease_owner, lease_until) values
      ('${HELD}', 'office-1', '${USER_HELD}', '2026-07-01T00:00:00Z', 'closed', '2026-07-01T00:00:00Z', '2033-07-01T00:00:00Z', null, null),
      ('${FREE}', 'office-1', '${USER_FREE}', '2026-07-01T00:00:00Z', 'closed', '2026-07-01T00:00:00Z', '2033-07-01T00:00:00Z', 'worker-x', now() + interval '1 hour')`);
    psql(`update public.patients set closed_at = '2026-07-01T00:00:00Z', archived_at = '2026-07-01T00:00:00Z', record_retain_until = '2033-07-01T00:00:00Z', auth_user_id = null, deletion_requested_at = '2026-07-01T00:00:00Z' where id in ('${HELD}', '${FREE}')`);
    expect(preview()).toMatchObject({ reopenable: 2, lapsed: 0, destroyed: 0, earliest_retain_until: "2033-07-01T00:00:00+00:00" });
    // One lapsed chart refuses the whole office and reopens nothing.
    psql(`update public.patients set record_retain_until = '2020-01-01T00:00:00Z' where id = '${FREE}'`);
    expect(preview()).toMatchObject({ reopenable: 1, lapsed: 1, destroyed: 0 });
    expect(reactivate()).toEqual({ reopened: 0, lapsed: 1, destroyed: 0 });
    expect(count("patients", "closed_at is not null")).toBe(3);
    psql(`update public.patients set record_retain_until = '2033-07-01T00:00:00Z' where id = '${FREE}'`);
    // A purge already claimed on one chart refuses too (counted as lapsed).
    psql(`update public.patient_deletion_requests set status = 'purging' where patient_id = '${FREE}'`);
    expect(reactivate()).toEqual({ reopened: 0, lapsed: 1, destroyed: 0 });
    psql(`update public.patient_deletion_requests set status = 'closed' where patient_id = '${FREE}'`);
    // A tombstone dated from the seal refuses even with every remaining chart intact.
    psql(`insert into public.patient_tombstones (id, provider_id, requested_at, purged_at) values ('${uuid(6)}', 'office-1', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')`);
    expect(preview()).toMatchObject({ reopenable: 2, lapsed: 0, destroyed: 1 });
    expect(reactivate()).toEqual({ reopened: 0, lapsed: 0, destroyed: 1 });
    psql(`delete from public.patient_tombstones where id = '${uuid(6)}'`);
    // Clean: both sealed charts reopen, their requests become cancelled rows that keep closed_at, the old closure is untouched.
    expect(reactivate()).toEqual({ reopened: 2, lapsed: 0, destroyed: 0 });
    expect(rows<{ id: string }>(`select id from public.patients where provider_id = 'office-1' and closed_at is null and archived_at is null and record_retain_until is null and deletion_requested_at is null and reopened_at is not null order by 1`).map((r) => r.id)).toEqual([HELD, FREE]);
    expect(rows<{ status: string; lease_owner: string | null; closed: boolean }>(`select status, lease_owner, closed_at is not null as closed from public.patient_deletion_requests where patient_id in ('${HELD}', '${FREE}') order by patient_id`))
      .toEqual([{ status: "cancelled", lease_owner: null, closed: true }, { status: "cancelled", lease_owner: null, closed: true }]);
    expect(rows<{ status: string }>(`select status from public.patient_deletion_requests where patient_id = '${uuid(4)}'`)[0].status).toBe("closed");
    expect(scalar<boolean>(`select closed_at is not null from public.patients where id = '${uuid(4)}'`)).toBe(true);
    // Reopened charts are open charts again: nothing left to reopen, the seal batch would pick them up, and the purge claim ignores the cancelled rows.
    expect(preview()).toMatchObject({ reopenable: 0, lapsed: 0, destroyed: 0 });
    expect(reactivate()).toEqual({ reopened: 0, lapsed: 0, destroyed: 0 });
    expect(rows(`select 1 from public.claim_due_patient_deletions('worker-y', 10, 600)`)).toEqual([]);
    expect(rows<{ patient_id: string }>(`select patient_id from public.office_offboarding_patients('office-1')`).map((r) => r.patient_id).sort()).toEqual([HELD, FREE].sort());
    expect(() => psql(`begin; select set_config('test.role', 'authenticated', true); select public.office_reactivate_charts('office-1', ${SINCE}); commit;`)).toThrow(/service role required/);
    expect(() => psql(`select public.office_reactivate_charts('office-9', ${SINCE})`)).toThrow(/unknown office/);
  });
});
