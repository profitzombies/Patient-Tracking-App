/**
 * The account-deletion SQL, run for real.
 *
 * `patient_purge_rows` is the piece a fake cannot prove: it must delete from
 * EVERY public table that carries patient_id (enumerated live, so a table
 * added later is covered), detach the append-only analytics rows, leave a
 * PII-free tombstone, and be safe to run twice. This suite boots a throwaway
 * PostgreSQL cluster, applies the canonical migration verbatim over a
 * mirror of the tables it touches, and asserts the lifecycle RPCs (request,
 * cancel, leased claim, purge, finish), the purge's completeness and
 * idempotency, the tombstone shape, foreign-key ordering between
 * patient-owned tables, and the service-role-only grants. Skips loudly
 * without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260928000000_patient_privacy_lifecycle.sql");
const BILLING_PRIVACY_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261013010000_billing_privacy_retention.sql");
const STAFF_ALERTS_PRIVACY_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261014000000_staff_attention_alerts_privacy.sql");
const BILLING_CARTS_PRIVACY_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261022000200_billing_carts_privacy.sql");
const LEGAL_HOLDS_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261107000000_legal_holds.sql");
const ACCOUNT_CLOSURE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261108000000_account_closure.sql");
const PATIENT_GROUPS_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261201000000_patient_groups.sql");
const CHAT_FLAGS_CLOSURE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261201000001_coach_chat_flags_closure.sql");
const REWARDS_CLOSURE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261201000002_patient_rewards_closure.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("purge.sql.test: PostgreSQL binaries not on PATH — purge SQL suite skipped");

// Minimal mirror of the live schema the migration builds on: the roles, the
// auth.role() shim, the ORIGINAL identity write guard + installer (the
// migration redefines the guard), the append-only analytics trigger in its
// original form, and one representative of every patient-owned table shape
// (cascade FK, provider FK, child table without patient_id, legacy NO ACTION
// chain between two patient-owned tables).
const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
alter database postgres set test.role = 'service_role';

create table public.providers (provider_id text primary key);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  auth_user_id uuid, first_name text, last_name text, email text, phone text,
  activation_status text not null default 'activated', program_id text, program_start_date date,
  archived_at timestamptz, archived_into_patient_id uuid references public.patients(id),
  created_at timestamptz not null default now());

create function private.guard_patient_dependency_write() returns trigger language plpgsql security definer set search_path = '' as $$
declare target_archived_at timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.patient_id::text, 40421001));
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

create table public.analytics_events (
  id bigint generated always as identity primary key, occurred_at timestamptz not null default now(),
  kind text not null, patient_id uuid references public.patients(id) on delete set null, provider_id text);
create function public.reject_operational_event_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'operational event tables are append-only'; end; $$;
create trigger analytics_events_append_only before update or delete on public.analytics_events for each row execute function public.reject_operational_event_mutation();

create table public.patient_notifications (
  id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id) on delete cascade,
  kind text not null, category text not null check (category in ('coach_outreach', 'check_in_reminders', 'office_reminders')),
  title text not null, body text not null, created_at timestamptz not null default now());
create table public.patient_push_tokens (id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id) on delete cascade, token text not null);
create table public.office_attention_digests (
  id uuid primary key default gen_random_uuid(), provider_id text not null, digest_date date not null,
  generated_at timestamptz not null default now(), time_zone text not null default 'UTC',
  flagged_count integer not null, items jsonb not null default '[]'::jsonb);
create table public.staff_notifications (
  id uuid primary key default gen_random_uuid(), provider_id text not null, auth_user_id uuid not null,
  channel text not null, status text not null default 'queued', data jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz not null default now(), finalized_at timestamptz, updated_at timestamptz not null default now());
create table public.patient_flags (patient_id uuid primary key references public.patients(id) on delete cascade, onboarding_answers jsonb);
create table public.patient_diary_entries (entry_id text primary key, patient_id uuid not null references public.patients(id) on delete cascade, name text);
create table public.patient_media (object_path text primary key, patient_id uuid not null references public.patients(id) on delete cascade);
create table public.patient_chat_conversations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  thread text not null default 'coach',
  provider_id text references public.providers(provider_id) on delete restrict);
create table public.patient_chat_messages (conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade, client_id text not null, text text, primary key (conversation_id, client_id));
create table public.patient_chat_read_markers (
  conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade,
  staff_user_id uuid not null, last_read_seq bigint not null default 0,
  primary key (conversation_id, staff_user_id));
create table public.patient_chat_patient_read_markers (
  conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  last_read_seq bigint not null default 0, primary key (conversation_id, patient_id));
create table public.patient_chat_notes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade,
  body text not null);
create table public.patient_body_measurements (visit_id text primary key, patient_id uuid not null references public.patients(id) on delete cascade, provider_id text not null references public.providers(provider_id) on delete cascade);
create table public.patient_medications (id uuid primary key, patient_id uuid not null references public.patients(id) on delete cascade, name text not null);
create table public.patient_medication_dose_logs (id uuid primary key, patient_id uuid not null references public.patients(id) on delete cascade, medication_id uuid not null references public.patient_medications(id) on delete cascade, status text not null);
create table public.patient_edit_history (id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id) on delete cascade, change_id uuid not null, family text not null, record_id text not null, field text not null, old_value jsonb, new_value jsonb, created_at timestamptz not null default now());
-- Real billing ownership and NO ACTION financial FK shapes.
create table public.billing_products (id uuid primary key, name text not null);
create table public.billing_payment_links (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  patient_id uuid references public.patients(id) on delete set null, active boolean not null default true);
create table public.billing_payers (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  patient_id uuid references public.patients(id) on delete set null, name text not null,
  email text not null, phone text, stripe_customer_id text);
create table public.billing_subscriptions (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  payer_id uuid not null references public.billing_payers(id), patient_id uuid references public.patients(id) on delete set null,
  product_id uuid not null references public.billing_products(id), shipping_address jsonb not null);
create table public.billing_orders (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  payer_id uuid not null references public.billing_payers(id), patient_id uuid references public.patients(id) on delete set null,
  shipping_address jsonb not null, metadata jsonb not null default '{}'::jsonb);
create table public.billing_order_items (
  id uuid primary key, order_id uuid not null references public.billing_orders(id) on delete cascade,
  product_id uuid not null references public.billing_products(id));
create table public.billing_ledger (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  order_id uuid references public.billing_orders(id), subscription_id uuid references public.billing_subscriptions(id));
create table public.billing_refunds (id uuid primary key, order_id uuid not null references public.billing_orders(id));
create table public.billing_disputes (id uuid primary key, order_id uuid not null references public.billing_orders(id));
create table public.billing_webhook_events (
  stripe_event_id text primary key, payload jsonb not null, processed_at timestamptz);
-- Mirrors 20261022000100_billing_carts.sql before the carts privacy migration adds the patient FK.
create table public.billing_carts (
  id uuid primary key, provider_id text not null references public.providers(provider_id), patient_id uuid not null,
  status text not null default 'staging', quote jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
-- Bloodwork has composite, NO ACTION relationships across four patient-owned
-- tables; the dynamic purge must still find a children-first order.
create table public.patient_bloodwork_reports (
  id uuid primary key, patient_id uuid not null references public.patients(id) on delete cascade,
  unique (id, patient_id));
create table public.patient_bloodwork_files (
  id uuid primary key, patient_id uuid not null, report_id uuid not null,
  staging_object_path text not null, object_path text,
  unique (id, patient_id),
  foreign key (report_id, patient_id) references public.patient_bloodwork_reports(id, patient_id) on delete cascade);
create table public.patient_bloodwork_results (
  id uuid primary key, patient_id uuid not null, report_id uuid not null, source_file_id uuid not null,
  unique (id, patient_id),
  foreign key (report_id, patient_id) references public.patient_bloodwork_reports(id, patient_id) on delete cascade,
  foreign key (source_file_id, patient_id) references public.patient_bloodwork_files(id, patient_id) on delete cascade);
create table public.patient_bloodwork_corrections (
  id uuid primary key, patient_id uuid not null, report_id uuid not null, result_id uuid not null,
  foreign key (report_id, patient_id) references public.patient_bloodwork_reports(id, patient_id) on delete cascade,
  foreign key (result_id, patient_id) references public.patient_bloodwork_results(id, patient_id) on delete cascade);
select private.install_patient_identity_write_guards();
`;

let dir = "";
let dataDir = "";
const PORT = 54_900 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];

function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: "pipe" });
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}
function scalar<T = unknown>(sql: string): T {
  return rows<{ v: T }>(`select (${sql}) as v`)[0].v;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PATIENT = uuid(1);
const OTHER = uuid(2);
const AUTH_USER = uuid(901);

function seedPatients() {
  psql(`
    truncate public.patient_bloodwork_corrections, public.patient_bloodwork_results, public.patient_bloodwork_files,
      public.patient_bloodwork_reports, public.billing_disputes, public.billing_refunds, public.billing_ledger,
      public.billing_order_items, public.billing_orders, public.billing_subscriptions, public.billing_payers,
      public.billing_payment_links, public.billing_carts, public.billing_products, public.patient_medication_dose_logs, public.patient_medications, public.patient_edit_history,
      public.patient_body_measurements, public.patient_chat_notes, public.patient_chat_patient_read_markers,
      public.patient_chat_read_markers, public.patient_chat_messages,
      public.patient_chat_conversations, public.patient_media, public.patient_diary_entries, public.patient_flags,
      public.patient_push_tokens, public.patient_notifications, public.office_attention_digests, public.staff_notifications,
      public.patient_consents, public.patient_data_exports, public.patient_group_members, public.patient_groups,
      public.patient_deletion_requests, public.patient_tombstones, public.analytics_events, public.patients cascade;
    insert into public.providers (provider_id) values ('office-1') on conflict do nothing;
    insert into public.billing_products (id, name) values ('${uuid(800)}', 'Product');
    insert into public.patient_groups (id, provider_id, name) values ('${uuid(850)}', 'office-1', 'MJH');
    insert into public.patients (id, provider_id, auth_user_id, first_name, last_name, email, activation_status, program_id, program_start_date, created_at)
      values ('${PATIENT}', 'office-1', '${AUTH_USER}', 'Pat', 'Example', 'pat@example.com', 'activated', 'thinnr', '2026-06-01', '2026-05-20'),
             ('${OTHER}', 'office-1', null, 'Other', 'Person', 'other@example.com', 'invited', 'glp', null, now());
  `);
}

/** One row in every patient-owned table for both patients, plus analytics. */
function seedEverything() {
  seedPatients();
  for (const pid of [PATIENT, OTHER]) {
    const tag = pid === PATIENT ? "p" : "o";
    psql(`
      insert into public.patient_flags (patient_id, onboarding_answers) values ('${pid}', '{"goal":"x"}');
      insert into public.patient_diary_entries (entry_id, patient_id, name) values ('${tag}-e1', '${pid}', 'Eggs'), ('${tag}-e2', '${pid}', 'Toast');
      insert into public.patient_media (object_path, patient_id) values ('/objects/patient-media/${pid}/a.jpg', '${pid}');
      insert into public.patient_push_tokens (patient_id, token) values ('${pid}', 'ExponentPushToken[${tag}]');
      insert into public.patient_notifications (patient_id, kind, category, title, body) values ('${pid}', 'coach_outreach', 'coach_outreach', 't', 'b');
      insert into public.patient_chat_conversations (id, patient_id, thread, provider_id)
        values ('${uuid(pid === PATIENT ? 501 : 502)}', '${pid}', 'care_team', 'office-1');
      insert into public.patient_chat_messages (conversation_id, client_id, text) values ('${uuid(pid === PATIENT ? 501 : 502)}', 'm1', 'hi');
      insert into public.patient_chat_read_markers values ('${uuid(pid === PATIENT ? 501 : 502)}', '${uuid(pid === PATIENT ? 551 : 552)}', 1);
      insert into public.patient_chat_patient_read_markers values ('${uuid(pid === PATIENT ? 501 : 502)}', '${pid}', 1);
      insert into public.patient_chat_notes (conversation_id, body) values ('${uuid(pid === PATIENT ? 501 : 502)}', 'internal');
      insert into public.patient_body_measurements (visit_id, patient_id, provider_id) values ('${tag}-v1', '${pid}', 'office-1');
      insert into public.patient_medications (id, patient_id, name) values ('${uuid(pid === PATIENT ? 701 : 702)}', '${pid}', 'Protocol drops');
      insert into public.patient_medication_dose_logs (id, patient_id, medication_id, status) values ('${uuid(pid === PATIENT ? 711 : 712)}', '${pid}', '${uuid(pid === PATIENT ? 701 : 702)}', 'taken');
      insert into public.patient_edit_history (patient_id, change_id, family, record_id, field, old_value, new_value)
        values ('${pid}', '${uuid(pid === PATIENT ? 721 : 722)}', 'weight', '${tag}-w1', 'weight', '182.4'::jsonb, '181.6'::jsonb);
      insert into public.billing_payment_links (id, provider_id, patient_id) values ('${uuid(pid === PATIENT ? 601 : 602)}', 'office-1', '${pid}');
      insert into public.billing_payers (id, provider_id, patient_id, name, email, phone, stripe_customer_id)
        values ('${uuid(pid === PATIENT ? 611 : 612)}', 'office-1', '${pid}', '${tag} payer', '${tag}@example.com', '555', 'cus_${tag}');
      insert into public.billing_subscriptions (id, provider_id, payer_id, patient_id, product_id, shipping_address)
        values ('${uuid(pid === PATIENT ? 621 : 622)}', 'office-1', '${uuid(pid === PATIENT ? 611 : 612)}', '${pid}', '${uuid(800)}',
          '{"line1":"secret","city":"Austin","state":"TX","postal_code":"78701","country":"US"}');
      insert into public.billing_orders (id, provider_id, payer_id, patient_id, shipping_address, metadata)
        values ('${uuid(pid === PATIENT ? 631 : 632)}', 'office-1', '${uuid(pid === PATIENT ? 611 : 612)}', '${pid}',
          '{"line1":"secret","city":"Austin","state":"TX","postal_code":"78701","country":"US"}', '{"payer":{"email":"secret"},"safe":true}');
      insert into public.billing_order_items (id, order_id, product_id)
        values ('${uuid(pid === PATIENT ? 641 : 642)}', '${uuid(pid === PATIENT ? 631 : 632)}', '${uuid(800)}');
      insert into public.billing_ledger (id, provider_id, order_id, subscription_id)
        values ('${uuid(pid === PATIENT ? 651 : 652)}', 'office-1', '${uuid(pid === PATIENT ? 631 : 632)}', '${uuid(pid === PATIENT ? 621 : 622)}');
      insert into public.billing_refunds (id, order_id) values ('${uuid(pid === PATIENT ? 661 : 662)}', '${uuid(pid === PATIENT ? 631 : 632)}');
      insert into public.billing_disputes (id, order_id) values ('${uuid(pid === PATIENT ? 671 : 672)}', '${uuid(pid === PATIENT ? 631 : 632)}');
      insert into public.billing_carts (id, provider_id, patient_id, status, quote)
        values ('${uuid(pid === PATIENT ? 681 : 682)}', 'office-1', '${pid}', 'ready', '{"fingerprint":"abc","lines":[{"name":"Control"}]}');
      insert into public.patient_bloodwork_reports (id, patient_id) values ('${uuid(pid === PATIENT ? 801 : 811)}', '${pid}');
      insert into public.patient_bloodwork_files (id, patient_id, report_id, staging_object_path, object_path)
        values ('${uuid(pid === PATIENT ? 802 : 812)}', '${pid}', '${uuid(pid === PATIENT ? 801 : 811)}',
          '/objects/patients/${pid}/bloodwork/staging/r/f', '/objects/patients/${pid}/bloodwork/reports/r/f');
      insert into public.patient_bloodwork_results (id, patient_id, report_id, source_file_id)
        values ('${uuid(pid === PATIENT ? 803 : 813)}', '${pid}', '${uuid(pid === PATIENT ? 801 : 811)}', '${uuid(pid === PATIENT ? 802 : 812)}');
      insert into public.patient_bloodwork_corrections (id, patient_id, report_id, result_id)
        values ('${uuid(pid === PATIENT ? 804 : 814)}', '${pid}', '${uuid(pid === PATIENT ? 801 : 811)}', '${uuid(pid === PATIENT ? 803 : 813)}');
      insert into public.patient_consents (patient_id, policy_version, terms_accepted, privacy_accepted, health_data_accepted, photo_analysis_accepted)
        values ('${pid}', '2026-09-01', true, true, true, false);
      insert into public.patient_data_exports (patient_id, status, expires_at) values ('${pid}', 'ready', now() + interval '1 day');
      insert into public.patient_group_members (group_id, patient_id, provider_id) values ('${uuid(850)}', '${pid}', 'office-1');
      insert into public.analytics_events (kind, patient_id, provider_id) values ('diary_logged', '${pid}', 'office-1'), ('check_in', '${pid}', 'office-1');
    `);
  }
}

const patientIdTables = () =>
  rows<{ table_name: string }>(
    `select c.table_name from information_schema.columns c join information_schema.tables t
       on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'patient_id' order by 1`,
  ).map((r) => r.table_name);

const countFor = (table: string, pid: string) => Number(scalar<string>(`select count(*) from public.${table} where patient_id = '${pid}'`));

const request = (pid = PATIENT, grace = 604800) =>
  rows<{ id: string; status: string; purge_after: string; requested_at: string; provider_id: string; auth_user_id: string | null }>(
    `select id, status, purge_after, requested_at, provider_id, auth_user_id from public.patient_deletion_request('${pid}', ${grace})`,
  )[0];
const claim = (owner = "worker-a", limit = 5, lease = 600) =>
  rows<{ id: string; patient_id: string; status: string; attempts: number; lease_owner: string; lease_until: string }>(
    `select id, patient_id, status, attempts, lease_owner, lease_until from public.claim_due_patient_deletions('${owner}', ${limit}, ${lease})`,
  );
const purge = (requestId: string) => scalar<Record<string, unknown>>(`select public.patient_purge_rows('${requestId}')`);
const finish = (requestId: string, status: string, error: string | null = null, retry: number | null = null) =>
  rows<{ id: string; status: string; purged_at: string | null; next_attempt_at: string | null; last_error: string | null; lease_owner: string | null }>(
    `select id, status, purged_at, next_attempt_at, last_error, lease_owner from public.patient_deletion_finish('${requestId}', '${status}', ${error === null ? "null" : `'${error}'`}, '{"storage":{"ok":true}}'::jsonb, ${retry === null ? "null" : retry})`,
  );

describe.skipIf(!POSTGRES_AVAILABLE)("patient deletion lifecycle SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pp-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION, BILLING_PRIVACY_MIGRATION, STAFF_ALERTS_PRIVACY_MIGRATION, BILLING_CARTS_PRIVACY_MIGRATION, PATIENT_GROUPS_MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies the canonical migration verbatim and keeps every new table and RPC service-role only", () => {
    expect(readFileSync(BILLING_PRIVACY_MIGRATION, "utf8")).toContain("patient_purge_rows");
    const tables = ["patient_consents", "patient_data_exports", "patient_deletion_requests", "patient_tombstones"];
    const grants = rows<{ grantee: string }>(
      `select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name in (${tables.map((t) => `'${t}'`).join(",")}) and grantee in ('anon','authenticated')`,
    );
    expect(grants).toEqual([]);
    const rls = rows<{ relname: string; rls: boolean }>(`select relname, relrowsecurity as rls from pg_class where relname in (${tables.map((t) => `'${t}'`).join(",")})`);
    expect(rls).toHaveLength(4);
    expect(rls.every((r) => r.rls)).toBe(true);
    for (const fn of [
      "public.patient_deletion_request(uuid,integer)",
      "public.patient_deletion_cancel(uuid)",
      "public.claim_due_patient_deletions(text,integer,integer)",
      "public.patient_purge_rows(uuid)",
      "public.patient_deletion_finish(uuid,text,text,jsonb,integer)",
      "public.claim_next_patient_data_export()",
    ]) {
      expect(scalar<boolean>(`select has_function_privilege('anon', '${fn}', 'execute')`), fn).toBe(false);
      expect(scalar<boolean>(`select has_function_privilege('authenticated', '${fn}', 'execute')`), fn).toBe(false);
      expect(scalar<boolean>(`select has_function_privilege('service_role', '${fn}', 'execute')`), fn).toBe(true);
    }
    // Even with execute, a non-service caller is refused inside the body.
    expect(() => psql(`begin; select set_config('test.role', 'authenticated', true); select public.patient_purge_rows('${uuid(1)}'); commit;`)).toThrow(/service role required/);
    // Every patient_id table (new ones included) carries the identity write guard.
    const unguarded = rows<{ table_name: string }>(
      `select c.table_name from information_schema.columns c join pg_class k on k.relname = c.table_name join pg_namespace n on n.oid = k.relnamespace and n.nspname = c.table_schema
       where c.table_schema = 'public' and c.column_name = 'patient_id'
         and not exists (select 1 from pg_trigger t where t.tgrelid = k.oid and t.tgname = 'patient_identity_write_guard' and not t.tgisinternal)`,
    );
    expect(unguarded).toEqual([]);
    // The tombstone carries no PII columns at all.
    const tombstoneColumns = rows<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'patient_tombstones' order by ordinal_position`).map((r) => r.column_name);
    expect(tombstoneColumns).toEqual(["id", "provider_id", "requested_at", "purged_at", "was_activated", "program_id", "enrolled_on"]);
  });

  it("records consent once per policy version and refuses records missing a required agreement", () => {
    seedPatients();
    psql(`insert into public.patient_consents (patient_id, policy_version, terms_accepted, privacy_accepted, health_data_accepted, photo_analysis_accepted) values ('${PATIENT}', '2026-09-01', true, true, true, true)`);
    expect(() => psql(`insert into public.patient_consents (patient_id, policy_version, terms_accepted, privacy_accepted, health_data_accepted) values ('${PATIENT}', '2026-09-01', true, true, true)`)).toThrow(/unique|duplicate/);
    expect(() => psql(`insert into public.patient_consents (patient_id, policy_version, terms_accepted, privacy_accepted, health_data_accepted) values ('${PATIENT}', '2026-10-01', true, false, true)`)).toThrow(/check/);
    psql(`insert into public.patient_consents (patient_id, policy_version, terms_accepted, privacy_accepted, health_data_accepted) values ('${PATIENT}', '2026-10-01', true, true, true)`);
    expect(countFor("patient_consents", PATIENT)).toBe(2);
  });

  it("requests are idempotent, stamp the patient, and cancel only while pending", () => {
    seedPatients();
    const first = request(PATIENT, 3600);
    expect(first.status).toBe("pending");
    expect(first.provider_id).toBe("office-1");
    expect(first.auth_user_id).toBe(AUTH_USER);
    const graceSeconds = scalar<number>(`select extract(epoch from (purge_after - requested_at))::int from public.patient_deletion_requests where id = '${first.id}'`);
    expect(graceSeconds).toBe(3600);
    expect(scalar<string | null>(`select deletion_requested_at::text from public.patients where id = '${PATIENT}'`)).not.toBeNull();
    // Asking again returns the same open request rather than a second one.
    expect(request(PATIENT, 10).id).toBe(first.id);
    expect(countFor("patient_deletion_requests", PATIENT)).toBe(1);
    // Unknown or archived patients cannot be scheduled.
    expect(() => request(uuid(77))).toThrow(/unknown patient/);
    // Cancel clears the stamp; a second cancel is a no-op false.
    expect(scalar<boolean>(`select public.patient_deletion_cancel('${PATIENT}')`)).toBe(true);
    expect(scalar<string | null>(`select deletion_requested_at::text from public.patients where id = '${PATIENT}'`)).toBeNull();
    expect(scalar<string>(`select status from public.patient_deletion_requests where id = '${first.id}'`)).toBe("cancelled");
    expect(scalar<boolean>(`select public.patient_deletion_cancel('${PATIENT}')`)).toBe(false);
    // A fresh request after a cancel opens a new row.
    expect(request(PATIENT, 60).id).not.toBe(first.id);
    // Once claimed (purging) it can no longer be cancelled.
    psql(`update public.patient_deletion_requests set purge_after = now() - interval '1 second' where patient_id = '${PATIENT}' and status = 'pending'`);
    expect(claim()).toHaveLength(1);
    expect(scalar<boolean>(`select public.patient_deletion_cancel('${PATIENT}')`)).toBe(false);
  });

  it("claims only due requests, leases them, and reclaims lapsed leases and due retries", () => {
    seedPatients();
    const pending = request(PATIENT, 3600);
    request(OTHER, 0);
    // Only the zero-grace request is due.
    const first = claim("worker-a");
    expect(first.map((r) => r.patient_id)).toEqual([OTHER]);
    expect(first[0]).toMatchObject({ status: "purging", attempts: 1, lease_owner: "worker-a" });
    expect(claim("worker-b")).toEqual([]);
    // Lease lapses: another worker takes it over, attempts advance.
    psql(`update public.patient_deletion_requests set lease_until = now() - interval '1 second' where id = '${first[0].id}'`);
    const reclaimed = claim("worker-b");
    expect(reclaimed.map((r) => r.id)).toEqual([first[0].id]);
    expect(reclaimed[0]).toMatchObject({ attempts: 2, lease_owner: "worker-b" });
    // A failed request with a future retry is not due; once due it is.
    const failed = finish(first[0].id, "failed", "storage: boom", 3600);
    expect(failed[0]).toMatchObject({ status: "failed", last_error: "storage: boom", lease_owner: null });
    expect(failed[0].next_attempt_at).not.toBeNull();
    expect(claim("worker-c")).toEqual([]);
    psql(`update public.patient_deletion_requests set next_attempt_at = now() - interval '1 second' where id = '${first[0].id}'`);
    expect(claim("worker-c").map((r) => r.id)).toEqual([first[0].id]);
    // A failed request with NO retry time waits for HQ.
    finish(first[0].id, "failed", "auth: nope", null);
    expect(scalar<string | null>(`select next_attempt_at::text from public.patient_deletion_requests where id = '${first[0].id}'`)).toBeNull();
    expect(claim("worker-d")).toEqual([]);
    // Still-pending request untouched throughout.
    expect(scalar<string>(`select status from public.patient_deletion_requests where id = '${pending.id}'`)).toBe("pending");
    expect(() => claim("")).toThrow(/lease owner is required/);
  });

  it("purges every patient_id table, detaches analytics, tombstones without PII, spares other patients, and re-runs cleanly", () => {
    seedEverything();
    const tables = patientIdTables();
    // The mirror must include the shapes that matter, or the enumeration proves nothing.
    expect(tables).toEqual(expect.arrayContaining([
      "patient_consents", "patient_data_exports", "patient_deletion_requests", "patient_push_tokens", "patient_notifications",
      "patient_chat_conversations", "patient_media", "patient_flags", "billing_orders", "billing_subscriptions",
      "billing_payers", "billing_payment_links", "billing_carts", "analytics_events",
      "patient_bloodwork_reports", "patient_bloodwork_files", "patient_bloodwork_results", "patient_bloodwork_corrections",
      "patient_edit_history", "patient_group_members",
    ]));
    for (const table of tables) expect(countFor(table, PATIENT), table).toBeGreaterThanOrEqual(table === "patient_deletion_requests" ? 0 : 1);

    const req = request(PATIENT, 0);
    expect(claim("worker-a").map((r) => r.id)).toEqual([req.id]);
    const summary = purge(req.id);
    expect(summary.patientRowDeleted).toBe(true);
    expect(summary.tombstone).toBe(true);
    expect(summary.analyticsDetached).toBe(2);
    expect(summary.authUserId).toBe(AUTH_USER);
    const purgedTables = summary.tables as Record<string, number>;
    const billingAllowlist = ["billing_orders", "billing_payment_links", "billing_payers", "billing_subscriptions"];
    // Transient billing rows with no accounting value are deleted outright, not anonymized.
    const billingDeleted = ["billing_carts"];
    // Every billing patient_id table must be explicitly classified here.
    expect(tables.filter((table) => table.startsWith("billing_")).sort()).toEqual([...billingAllowlist, ...billingDeleted].sort());
    const deletedTables = tables.filter((t) => t !== "patient_deletion_requests" && t !== "analytics_events" && !billingAllowlist.includes(t));
    expect(Object.keys(purgedTables).filter((key) => !key.endsWith("_anonymized")).sort()).toEqual(deletedTables.sort());
    expect(purgedTables.patient_diary_entries).toBe(2);
    // Prior-value history is patient-owned clinical data: it goes with the record.
    expect(purgedTables.patient_edit_history).toBe(1);
    // Office-defined group memberships go with the patient; the group itself stays for the office.
    expect(purgedTables.patient_group_members).toBe(1);
    expect(Number(scalar<string>(`select count(*) from public.patient_groups where id = '${uuid(850)}'`))).toBe(1);
    expect(purgedTables.billing_orders_anonymized).toBe(1);
    expect(purgedTables.billing_payers_anonymized).toBe(1);
    expect(purgedTables.billing_carts).toBe(1);
    expect(rows(`select id from public.billing_carts`).map((row) => row.id)).toEqual([uuid(682)]);

    // Nothing owned by the patient remains anywhere — including child tables reached by cascade.
    for (const table of tables) {
      if (table === "patient_deletion_requests") continue;
      if (!billingAllowlist.includes(table)) expect(countFor(table, PATIENT), table).toBe(0);
    }
    expect(rows(`select patient_id, shipping_address, metadata from public.billing_orders where id = '${uuid(631)}'`)[0]).toMatchObject({
      patient_id: null,
      shipping_address: { city: "Austin", state: "TX", postal_code: "78701", country: "US" },
      metadata: { safe: true },
    });
    expect(rows(`select patient_id, name, email, phone from public.billing_payers where id = '${uuid(611)}'`)[0]).toMatchObject({
      patient_id: null, name: "Deleted patient", email: `deleted+${uuid(611)}@invalid.thinnr`, phone: null,
    });
    expect(Number(scalar<string>(`select count(*) from public.billing_ledger where order_id = '${uuid(631)}'`))).toBe(1);
    expect(Number(scalar<string>(`select count(*) from public.billing_refunds where order_id = '${uuid(631)}'`))).toBe(1);
    expect(scalar<string>(`select name from public.billing_payers where id = '${uuid(612)}'`)).toBe("o payer");
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_messages where conversation_id = '${uuid(501)}'`))).toBe(0);
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_notes where conversation_id = '${uuid(501)}'`))).toBe(0);
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_read_markers where conversation_id = '${uuid(501)}'`))).toBe(0);
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_patient_read_markers where conversation_id = '${uuid(501)}'`))).toBe(0);
    expect(Number(scalar<string>(`select count(*) from public.patients where id = '${PATIENT}'`))).toBe(0);
    // Analytics rows survive, detached: office counts stay whole, the reference is gone.
    expect(Number(scalar<string>(`select count(*) from public.analytics_events where provider_id = 'office-1' and patient_id is null`))).toBe(2);
    expect(Number(scalar<string>(`select count(*) from public.analytics_events`))).toBe(4);
    // The other patient is untouched, in every table.
    for (const table of tables) {
      if (table === "patient_deletion_requests") continue;
      expect(countFor(table, OTHER), table).toBeGreaterThanOrEqual(1);
    }
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_messages where conversation_id = '${uuid(502)}'`))).toBe(1);
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_notes where conversation_id = '${uuid(502)}'`))).toBe(1);
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_read_markers where conversation_id = '${uuid(502)}'`))).toBe(1);
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_patient_read_markers where conversation_id = '${uuid(502)}'`))).toBe(1);
    // The tombstone: ids, office, program, dates — nothing else.
    const tombstone = rows(`select * from public.patient_tombstones`);
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0]).toMatchObject({ id: PATIENT, provider_id: "office-1", was_activated: true, program_id: "thinnr", enrolled_on: "2026-06-01" });
    expect(tombstone[0].requested_at).toBe(rows<{ requested_at: string }>(`select requested_at from public.patient_deletion_requests where id = '${req.id}'`)[0].requested_at);
    expect(JSON.stringify(tombstone)).not.toMatch(/Pat|Example|example\.com|00000000-0000-4000-8000-000000000901/);
    // The lifecycle row survives the purge and records the outcome.
    const done = finish(req.id, "purged");
    expect(done[0]).toMatchObject({ status: "purged", lease_owner: null });
    expect(done[0].purged_at).not.toBeNull();
    // Finishing twice is a no-op (only a purging row can finish).
    expect(finish(req.id, "purged")).toEqual([]);

    // Idempotent re-run: reclaim via a stale lease and purge again — nothing to do, nothing breaks.
    psql(`update public.patient_deletion_requests set status = 'purging', lease_until = now() - interval '1 second' where id = '${req.id}'`);
    expect(claim("worker-b").map((r) => r.id)).toEqual([req.id]);
    const again = purge(req.id);
    expect(again.patientRowDeleted).toBe(false);
    expect(again.tombstone).toBe(true);
    expect(again.analyticsDetached).toBe(0);
    expect(Object.values(again.tables as Record<string, number>).every((n) => n === 0)).toBe(true);
    expect(Number(scalar<string>(`select count(*) from public.patient_tombstones`))).toBe(1);
    expect(finish(req.id, "purged")[0].status).toBe("purged");
  });

  it("scrubs patient identity from digest and delivery snapshots when the patient row is purged", () => {
    seedPatients();
    const snapshot = JSON.stringify([
      { patientId: PATIENT, name: "Pat Example", reasons: [{ code: "no_meals", label: "No meals logged", days: 3 }] },
      { patientId: OTHER, name: "Other Person", reasons: [{ code: "no_water", label: "No water logged", days: 4 }] },
    ]).replaceAll("'", "''");
    psql(`
      insert into public.office_attention_digests (provider_id, digest_date, flagged_count, items)
      values ('office-1', current_date, 2, '${snapshot}'::jsonb);
      insert into public.staff_notifications (provider_id, auth_user_id, channel, status, data)
      values ('office-1', '${AUTH_USER}', 'email', 'sent', jsonb_build_object('patients', '${snapshot}'::jsonb));
    `);
    const req = request(PATIENT, 0);
    claim("worker-a");
    purge(req.id);

    const digest = rows<{ flagged_count: number; items: Record<string, unknown>[] }>(`select flagged_count, items from public.office_attention_digests`)[0]!;
    const delivery = rows<{ patients: Record<string, unknown>[] }>(`select data->'patients' as patients from public.staff_notifications`)[0]!;
    expect(digest.flagged_count).toBe(1);
    expect(digest.items).toEqual([{ patientId: OTHER, name: "Other Person", reasons: [{ code: "no_water", label: "No water logged", days: 4 }] }]);
    expect(delivery.patients).toEqual(digest.items);
    expect(JSON.stringify([digest, delivery])).not.toContain("Pat Example");
    expect(JSON.stringify([digest, delivery])).not.toContain(PATIENT);
  });

  it("refuses to purge a request that is not being purged, and a purged patient cannot receive new data", () => {
    seedEverything();
    const req = request(PATIENT, 3600);
    expect(() => purge(req.id)).toThrow(/not being purged/);
    expect(() => purge(uuid(4242))).toThrow(/unknown deletion request/);
    psql(`update public.patient_deletion_requests set purge_after = now() - interval '1 second' where id = '${req.id}'`);
    claim();
    purge(req.id);
    // Late writes (a device that was offline) are rejected by the identity guard.
    expect(() => psql(`insert into public.patient_diary_entries (entry_id, patient_id, name) values ('late', '${PATIENT}', 'Late')`)).toThrow(/unknown patient/);
    // The append-only analytics guard still rejects every other mutation.
    expect(() => psql(`update public.analytics_events set kind = 'x' where provider_id = 'office-1'`)).toThrow(/append-only/);
    expect(() => psql(`delete from public.analytics_events where provider_id = 'office-1'`)).toThrow(/append-only/);
  });

  it("claims queued exports one at a time and hides them from a second claimant", () => {
    seedPatients();
    psql(`insert into public.patient_data_exports (id, patient_id, status, expires_at, created_at) values ('${uuid(701)}', '${PATIENT}', 'queued', now() + interval '1 day', now() - interval '2 minutes'), ('${uuid(702)}', '${OTHER}', 'queued', now() + interval '1 day', now() - interval '1 minute')`);
    const first = rows<{ id: string; status: string; attempts: number }>(`select id, status, attempts from public.claim_next_patient_data_export()`);
    expect(first).toEqual([{ id: uuid(701), status: "running", attempts: 1 }]);
    const second = rows<{ id: string }>(`select id from public.claim_next_patient_data_export()`);
    expect(second).toEqual([{ id: uuid(702) }]);
    expect(rows(`select id from public.claim_next_patient_data_export()`)).toEqual([]);
    // Only the patient's own prefix is an acceptable archive path.
    expect(() => psql(`update public.patient_data_exports set object_path = '/objects/patient-media/${OTHER}/export-${uuid(9)}.zip' where id = '${uuid(701)}'`)).toThrow(/check/);
    psql(`update public.patient_data_exports set object_path = '/objects/patient-media/${PATIENT}/export-${uuid(9)}.zip', status = 'ready' where id = '${uuid(701)}'`);
    // The account category is accepted by the notification outbox now.
    psql(`insert into public.patient_notifications (patient_id, kind, category, title, body) values ('${PATIENT}', 'data_export_ready', 'account', 't', 'b')`);
  });

  it("closes personal data, seals clinical data, and later purges the unchanged tombstone", () => {
    psql(`
      create table public.hq_organization_settings (
        singleton boolean primary key default true,
        retention_audit_days integer not null default 2190,
        retention_clinical_record_days integer not null default 2555
      );
      insert into public.hq_organization_settings (singleton, retention_audit_days, retention_clinical_record_days)
      values (true, 2190, 1825);
      create table public.ai_usage_events (
        id bigint generated always as identity primary key,
        patient_id uuid references public.patients(id) on delete set null
      );
      create table public.auth_sign_ins (id uuid primary key default gen_random_uuid(), user_id uuid not null, realm text not null);
      create table public.account_security_state (user_id uuid primary key);
      alter table public.patient_media add column kind text not null default 'progress';
      alter table public.providers
        add column provider_name text,
        add column office_name text,
        add column email text,
        add column auth_user_id uuid,
        add column access_disabled boolean default false;
      alter table public.patients
        add column name text,
        add column date_of_birth date;
      create table public.team_members (
        id uuid primary key,
        name text,
        email text,
        auth_user_id uuid,
        activation_status text
      );
    `);
    for (const file of [LEGAL_HOLDS_MIGRATION, ACCOUNT_CLOSURE_MIGRATION, CHAT_FLAGS_CLOSURE_MIGRATION, REWARDS_CLOSURE_MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((arg) => arg !== "-At"), "-f", file], {
        stdio: "pipe",
        encoding: "utf8",
      });
    }

    seedEverything();
    psql(`
      -- The live identity fences: one active row per phone / email / auth user.
      create unique index patients_phone_normalized_unique_idx
        on public.patients (right(regexp_replace(phone, '\\D', '', 'g'), 10))
        where archived_at is null and length(regexp_replace(coalesce(phone, ''), '\\D', '', 'g')) >= 10;
      create unique index patients_active_auth_user_id_unique_idx
        on public.patients (auth_user_id) where archived_at is null and auth_user_id is not null;
      update public.patients set phone = '+1 (512) 555-0199' where id = '${PATIENT}';
      update public.patient_media set kind = 'progress' where patient_id = '${PATIENT}';
      insert into public.patient_media (object_path, patient_id, kind)
      values ('/objects/patient-media/${PATIENT}/food-private', '${PATIENT}', 'food');
      insert into public.patient_chat_conversations (id, patient_id, thread, provider_id)
      values ('${uuid(503)}', '${PATIENT}', 'coach', 'office-1');
      insert into public.patient_chat_messages (conversation_id, client_id, text)
      values ('${uuid(503)}', 'private', 'private coach text');
      insert into public.ai_usage_events (patient_id) values ('${PATIENT}');
      -- A coach safety flag quotes the patient; it is personal and leaves at closure.
      create table public.coach_chat_flags (
        id uuid primary key default gen_random_uuid(),
        patient_id uuid not null references public.patients(id) on delete cascade,
        message_excerpt text not null
      );
      insert into public.coach_chat_flags (patient_id, message_excerpt) values ('${PATIENT}', 'private words');
      -- Rewards are engagement data; they leave at closure too.
      create table public.patient_reward_events (
        patient_id uuid not null references public.patients(id) on delete cascade,
        event_key text not null, primary key (patient_id, event_key)
      );
      insert into public.patient_reward_events (patient_id, event_key) values ('${PATIENT}', 'daily:food');
      insert into public.auth_sign_ins (user_id, realm) values ('${AUTH_USER}', 'patient');
      insert into public.account_security_state (user_id) values ('${AUTH_USER}');
    `);

    // Before closure the phone and the auth user are taken.
    expect(() => psql(`insert into public.patients (id, provider_id, phone) values ('${uuid(3)}', 'office-1', '+1 512 555 0199')`)).toThrow(/patients_phone_normalized_unique_idx/);
    expect(() => psql(`insert into public.patients (id, provider_id, auth_user_id) values ('${uuid(3)}', 'office-1', '${AUTH_USER}')`)).toThrow(/patients_active_auth_user_id_unique_idx/);

    const req = request(PATIENT, 0);
    const claimed = claim("closure-worker");
    expect(claimed).toEqual([expect.objectContaining({ id: req.id, status: "closing" })]);
    const closed = scalar<Record<string, unknown>>(`select public.patient_close_rows('${req.id}')`);
    expect(closed.alreadyClosed).toBe(false);
    expect(closed.authUserId).toBe(AUTH_USER);
    expect(closed.mediaPaths).toEqual([`/objects/patient-media/${PATIENT}/food-private`]);

    expect(countFor("patient_diary_entries", PATIENT)).toBe(0);
    expect(countFor("patient_flags", PATIENT)).toBe(0);
    expect(countFor("coach_chat_flags", PATIENT)).toBe(0);
    expect((closed.tables as Record<string, number>).coach_chat_flags).toBe(1);
    expect(countFor("patient_reward_events", PATIENT)).toBe(0);
    expect((closed.tables as Record<string, number>).patient_reward_events).toBe(1);
    expect(countFor("patient_body_measurements", PATIENT)).toBe(1);
    expect(countFor("patient_medications", PATIENT)).toBe(1);
    expect(countFor("patient_bloodwork_reports", PATIENT)).toBe(1);
    // Prior values of chart edits are part of the sealed record, not personal data.
    expect(countFor("patient_edit_history", PATIENT)).toBe(1);
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_conversations where patient_id = '${PATIENT}' and thread = 'care_team'`))).toBe(1);
    expect(Number(scalar<string>(`select count(*) from public.patient_chat_conversations where patient_id = '${PATIENT}' and thread = 'coach'`))).toBe(0);
    expect(Number(scalar<string>(`select count(*) from public.patient_media where patient_id = '${PATIENT}' and kind = 'progress'`))).toBe(1);
    expect(rows(`select auth_user_id, email, phone, closed_at, archived_at, record_retain_until from public.patients where id = '${PATIENT}'`)[0]).toMatchObject({
      auth_user_id: null,
      email: null,
      phone: null,
    });
    expect(Number(scalar<string>(`select extract(day from (record_retain_until - closed_at)) from public.patients where id = '${PATIENT}'`))).toBe(1825);
    expect(countFor("ai_usage_events", PATIENT)).toBe(0);
    expect(Number(scalar<string>(`select count(*) from public.auth_sign_ins where user_id = '${AUTH_USER}'`))).toBe(0);
    expect(() => psql(`insert into public.patient_diary_entries (entry_id, patient_id, name) values ('sealed-late', '${PATIENT}', 'Late')`)).toThrow(/archived patient/);
    // A re-signup with the same phone (and a fresh GoTrue user) is a brand-new
    // patient: the sealed row holds neither the phone nor the auth link.
    expect(() => psql(`insert into public.patients (id, provider_id, phone, auth_user_id) values ('${uuid(3)}', 'office-1', '+1 512 555 0199', '${AUTH_USER}')`)).not.toThrow();
    expect(rows(`select id from public.patients where phone is not null and right(regexp_replace(phone, '\\D', '', 'g'), 10) = '5125550199' and archived_at is null`)).toEqual([{ id: uuid(3) }]);
    expect(scalar<string>(`select public.claim_find_candidates('phone', '+1 512 555 0199')::text`)).not.toContain(PATIENT);
    expect(countFor("patient_diary_entries", uuid(3))).toBe(0);

    const again = scalar<Record<string, unknown>>(`select public.patient_close_rows('${req.id}')`);
    expect(again.alreadyClosed).toBe(true);
    finish(req.id, "closed");
    expect(rows(`select status, purge_after = retain_until as due_at_retention from public.patient_deletion_requests where id = '${req.id}'`)[0])
      .toMatchObject({ status: "closed", due_at_retention: true });
    // Not due until the retention window closes, and never while a legal hold covers the chart.
    expect(claim("purge-worker")).toEqual([]);
    psql(`update public.patient_deletion_requests set retain_until = now() - interval '1 second', purge_after = now() - interval '1 second' where id = '${req.id}'`);
    psql(`insert into public.legal_holds (target_kind, target_id, reason) values ('patient', '${PATIENT}', 'litigation hold')`);
    expect(claim("purge-worker")).toEqual([]);
    expect(scalar<string>(`select status from public.patient_deletion_requests where id = '${req.id}'`)).toBe("closed");
    psql(`update public.legal_holds set lifted_at = now(), lift_reason = 'resolved' where target_id = '${PATIENT}'`);
    expect(claim("purge-worker")).toEqual([expect.objectContaining({ id: req.id, status: "purging" })]);
    const final = purge(req.id);
    expect(final.tombstone).toBe(true);
    expect(rows(`select id, provider_id, was_activated, program_id, enrolled_on from public.patient_tombstones where id = '${PATIENT}'`)[0])
      .toMatchObject({ id: PATIENT, provider_id: "office-1", was_activated: true, program_id: "thinnr", enrolled_on: "2026-06-01" });
  });
});
