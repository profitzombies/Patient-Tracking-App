/**
 * hq_testing_hard_delete on real PostgreSQL: one office (or one patient) is
 * erased from every table — patient_id tables, provider_id tables, and the
 * text-keyed / append-only ones — while a second office and other patients
 * stay untouched; HQ members keep their login and HQ profile; the append-only
 * guard is back on afterwards; a blocked delete rolls back completely.
 *
 * The mirror schema carries every table the function names statically plus
 * representative keyed tables (uuid and text patient_id, a NO ACTION chain
 * between two patient tables, a cascade child without patient_id) and copies
 * of the live guard triggers it has to pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261129000000_hq_testing_hard_delete.sql");

const hasBinary = (name: string) => spawnSync("which", [name], { stdio: "ignore" }).status === 0;
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("hard-delete.sql.test: PostgreSQL binaries not on PATH — suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
alter database postgres set test.role = 'service_role';
create table auth.users (id uuid primary key, email text, phone text);

create table public.providers (provider_id text primary key, office_name text, provider_name text, auth_user_id uuid, email text, phone text);
create table public.patients (id uuid primary key, provider_id text references public.providers(provider_id), auth_user_id uuid,
  first_name text, last_name text, email text, phone text, archived_into_patient_id uuid references public.patients(id));
create table public.team_members (id uuid primary key, provider_id text references public.providers(provider_id), auth_user_id uuid, name text, email text);
create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, email text, role text, provider_account_code text);
create table public.staff_role_assignments (email text primary key, provider_account_code text, role text);
create table public.role_assignments (id serial primary key, provider_account_code text);
create type public.hq_membership_status as enum ('invited', 'active', 'revoked');
create table public.hq_memberships (auth_user_id uuid primary key, status public.hq_membership_status, role text, updated_at timestamptz default now());

create table public.data_exports (id uuid primary key, provider_id text, params jsonb default '{}', requested_by uuid, object_path text);
create table public.patient_media (object_path text primary key, patient_id uuid references public.patients(id));
create table public.patient_custom_foods (id serial primary key, patient_id uuid, photo_path text);
create table public.patient_saved_recipes (id serial primary key, patient_id uuid, photo_path text);
create table public.patient_progress_photos (id serial primary key, patient_id uuid, object_path text);
create table public.patient_data_exports (id serial primary key, patient_id uuid, object_path text);
create table public.patient_bloodwork_files (id uuid primary key, patient_id uuid, object_path text, staging_object_path text);
-- NO ACTION chain: results sort after files, so the first pass is blocked.
create table public.patient_bloodwork_results (id serial primary key, patient_id uuid, source_file_id uuid references public.patient_bloodwork_files(id));
create table public.patient_diary_entries (id serial primary key, patient_id uuid references public.patients(id), name text);
create table public.patient_chat_conversations (id uuid primary key, patient_id uuid references public.patients(id), provider_id text);
create table public.patient_chat_messages (id serial primary key, conversation_id uuid references public.patient_chat_conversations(id) on delete cascade, text text);
create table public.ai_usage_events (id serial primary key, patient_id text, provider_id text);
create table public.office_settings (provider_id text primary key references public.providers(provider_id), value text);

create table public.billing_orders (id uuid primary key, patient_id uuid, provider_id text);
create table public.billing_subscriptions (id uuid primary key, patient_id uuid, provider_id text);
create table public.billing_payers (id uuid primary key, patient_id uuid, provider_id text);
create table public.billing_notification_contacts (id uuid primary key, payer_id uuid, provider_id text);
create table public.billing_connected_accounts (provider_id text primary key, stripe_account_id text);
create table public.billing_connect_archive (id serial primary key, provider_id text, account_snapshot jsonb);
create table public.billing_office_access_subscriptions (id serial primary key, provider_id text, stripe_customer_id text);
create table public.billing_customer_emails (id uuid primary key, provider_id text, order_id uuid, subscription_id uuid, payer_id uuid,
  contact_id uuid, parent_id uuid references public.billing_customer_emails(id), vendor_message_id text);
create table public.email_vendor_events (id serial primary key, email_id uuid references public.billing_customer_emails(id) on delete set null, vendor_message_id text);
create table public.billing_customer_email_events (id serial primary key, email_id uuid references public.billing_customer_emails(id));
create table public.billing_refunds (id serial primary key, order_id uuid references public.billing_orders(id));
create table public.billing_disputes (id serial primary key, order_id uuid references public.billing_orders(id));
create table public.billing_ledger (id serial primary key, provider_id text, order_id uuid references public.billing_orders(id), subscription_id uuid);
create table public.billing_shipments (id serial primary key, order_id uuid references public.billing_orders(id));
create table public.billing_webhook_events (id serial primary key, account text, payload jsonb);

create table public.admin_audit_events (id serial primary key, provider_id text, target_id text, metadata jsonb default '{}', actor_user_id uuid);
create table public.admin_audit_event_archives (id serial primary key, provider_id text);
create table public.admin_audit_read_windows (id serial primary key, actor_user_id uuid);
create table public.analytics_events (id serial primary key, kind text, patient_id uuid, provider_id text, actor_user_id uuid);
create table public.legal_holds (id serial primary key, target_id text);
create table public.patient_tombstones (id uuid primary key, provider_id text);
create table private.patient_identity_reconciliation_audit (id serial primary key, canonical_patient_id uuid, archived_patient_id uuid);
create table public.claim_verifications (id serial primary key, resolved_ref text, auth_user_id uuid, identifier text);
create table public.staff_second_factors (id serial primary key, staff_ref text);
create table public.coach_conversations (id serial primary key, patient_ref text, provider_account_code text);
create table public.coach_usage_daily (id serial primary key, scope text);
create table public.coach_usage_leases (id serial primary key, scope text, office text);
create table public.storage_upload_intents (id serial primary key, owner_id text, object_path text);
create table public.auth_session_revocations (id serial primary key, user_id uuid);
create table public.training_viewers (id uuid primary key, account_id text, auth_user_id uuid, staff_of_viewer_id uuid references public.training_viewers(id));
create table public.provider_account_locks (account_id text primary key);

-- Live guard triggers the routine has to pass (copied / reduced).
create function public.reject_operational_event_mutation() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and tg_table_name = 'admin_audit_events'
     and coalesce(current_setting('app.audit_retention_run', true), '') = 'on' then return old; end if;
  raise exception 'operational event tables are append-only';
end $$;
create trigger admin_audit_events_append_only before update or delete on public.admin_audit_events
  for each row execute function public.reject_operational_event_mutation();
create trigger analytics_events_append_only before update or delete on public.analytics_events
  for each row execute function public.reject_operational_event_mutation();
create function public.protect_connect_identity() returns trigger language plpgsql as $$
begin
  if current_setting('thinnr.connect_mutation', true) = 'allowed' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'DELETE' then raise exception 'Connection deletion requires safe restart.' using errcode = '40001'; end if;
  return new;
end $$;
create trigger protect_connect_identity before insert or update or delete on public.billing_connected_accounts
  for each row execute function public.protect_connect_identity();
create function public.sync_staff_role_assignment() returns trigger language plpgsql as $$
begin
  update public.profiles set role = 'patient', provider_account_code = null where lower(email) = lower(old.email);
  return old;
end $$;
create trigger sync_thinnr_staff_role_assignment after delete on public.staff_role_assignments
  for each row execute function public.sync_staff_role_assignment();
create function public.sync_hq_membership() returns trigger language plpgsql as $$
begin
  update public.profiles set role = new.role where id = new.auth_user_id and new.status <> 'revoked'::public.hq_membership_status;
  return new;
end $$;
create trigger sync_hq_membership after insert or update on public.hq_memberships
  for each row execute function public.sync_hq_membership();
`;

let dir = "";
let dataDir = "";
const PORT = 55_900 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string) => execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: "pipe" });
const scalar = <T = unknown>(sql: string): T => JSON.parse(psql(`select coalesce(to_json((${sql})), 'null'::json)`).trim()) as T;
const count = (sql: string) => Number(scalar<number>(`select count(*) from ${sql}`));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Office A (target) and office B (bystander).
const PA1 = uuid(1), PA2 = uuid(2), PA_ARCHIVED = uuid(3), PB1 = uuid(4);
const OWNER_A = uuid(101), STAFF_A = uuid(102), HQ_STAFF_A = uuid(103), SHARED_STAFF = uuid(104);
const PA1_USER = uuid(105), OWNER_B = uuid(106), PB1_USER = uuid(107);
const TEAM_A = uuid(201), TEAM_HQ_A = uuid(202), TEAM_SHARED_A = uuid(203), TEAM_SHARED_B = uuid(204);

function seed(): void {
  const tables = scalar<string[]>(`select array_agg(format('%I.%I', table_schema, table_name)) from information_schema.tables
    where table_schema in ('public','private','auth') and table_type = 'BASE TABLE'`);
  psql(`truncate ${tables.join(", ")} restart identity cascade;`);
  const users: Array<[string, string, string | null]> = [
    [OWNER_A, "owner@a.test", "+15550000001"], [STAFF_A, "staff@a.test", "+15550000002"], [HQ_STAFF_A, "hq@thinnr.test", null],
    [SHARED_STAFF, "shared@both.test", null], [PA1_USER, "pat1@a.test", "+15550000005"], [OWNER_B, "owner@b.test", null], [PB1_USER, "pat@b.test", null],
  ];
  psql(users.map(([id, email, phone]) => `insert into auth.users values ('${id}', '${email}', ${phone ? `'${phone}'` : "null"});
    insert into public.profiles values ('${id}', '${email}', 'provider', null);`).join("\n"));
  const perPatient = (pid: string, office: string, n: number) => `
    insert into public.patient_media values ('/objects/patient-media/${pid}/a.jpg', '${pid}');
    insert into public.patient_custom_foods (patient_id, photo_path) values ('${pid}', '/objects/patient-media/${pid}/food.jpg');
    insert into public.patient_saved_recipes (patient_id, photo_path) values ('${pid}', 'https://cdn.example/recipe.png');
    insert into public.patient_progress_photos (patient_id, object_path) values ('${pid}', '/objects/patient-media/${pid}/front.jpg');
    insert into public.patient_data_exports (patient_id, object_path) values ('${pid}', '/objects/patient-exports/${pid}.zip');
    insert into public.patient_bloodwork_files values ('${uuid(300 + n)}', '${pid}', '/objects/patients/${pid}/bloodwork/r.pdf', '/objects/patients/${pid}/bloodwork/staging.pdf');
    insert into public.patient_bloodwork_results (patient_id, source_file_id) values ('${pid}', '${uuid(300 + n)}');
    insert into public.patient_diary_entries (patient_id, name) values ('${pid}', 'Eggs');
    insert into public.patient_chat_conversations values ('${uuid(400 + n)}', '${pid}', '${office}');
    insert into public.patient_chat_messages (conversation_id, text) values ('${uuid(400 + n)}', 'hi');
    insert into public.ai_usage_events (patient_id, provider_id) values ('${pid}', '${office}');
    insert into public.billing_orders values ('${uuid(500 + n)}', '${pid}', '${office}');
    insert into public.billing_subscriptions values ('${uuid(520 + n)}', '${pid}', '${office}');
    insert into public.billing_payers values ('${uuid(540 + n)}', '${pid}', '${office}');
    insert into public.billing_notification_contacts values ('${uuid(560 + n)}', '${uuid(540 + n)}', null);
    insert into public.billing_customer_emails values ('${uuid(580 + n)}', null, '${uuid(500 + n)}', null, null, null, null, 'msg-${n}');
    insert into public.billing_customer_emails values ('${uuid(600 + n)}', null, null, null, null, '${uuid(560 + n)}', '${uuid(580 + n)}', null);
    insert into public.email_vendor_events (email_id, vendor_message_id) values ('${uuid(580 + n)}', 'msg-${n}'), (null, 'msg-${n}');
    insert into public.billing_customer_email_events (email_id) values ('${uuid(600 + n)}');
    insert into public.billing_refunds (order_id) values ('${uuid(500 + n)}');
    insert into public.billing_disputes (order_id) values ('${uuid(500 + n)}');
    insert into public.billing_ledger (provider_id, order_id, subscription_id) values (null, '${uuid(500 + n)}', '${uuid(520 + n)}');
    insert into public.billing_shipments (order_id) values ('${uuid(500 + n)}');
    insert into public.admin_audit_events (target_id, metadata) values ('${pid}', '{}'), (null, '{"patientId":"${pid}"}');
    insert into public.analytics_events (kind, patient_id, provider_id) values ('diary', '${pid}', '${office}');
    insert into public.legal_holds (target_id) values ('${pid}');
    insert into public.claim_verifications (resolved_ref, identifier) values ('${pid}', 'x');
    insert into public.coach_conversations (patient_ref) values ('${pid}');
    insert into public.coach_usage_daily (scope) values ('account:${pid}');
    insert into public.coach_usage_leases (scope) values ('account:${pid}');
    insert into public.storage_upload_intents (owner_id, object_path) values ('${pid}', '/objects/patient-media/${pid}/pending.jpg');
    insert into private.patient_identity_reconciliation_audit (canonical_patient_id) values ('${pid}');
    insert into public.data_exports values ('${uuid(700 + n)}', null, '{"patientId":"${pid}"}', null, '/objects/exports/${uuid(700 + n)}/record.zip');
  `;
  psql(`
    insert into public.providers values ('office-a', 'Harbor Test Spa', 'Dr. A', '${OWNER_A}', 'owner@a.test', '+15550000001'),
                                        ('office-b', 'Bystander Spa', 'Dr. B', '${OWNER_B}', 'owner@b.test', null);
    insert into public.patients (id, provider_id, auth_user_id, first_name, last_name, email, phone) values
      ('${PA1}', 'office-a', '${PA1_USER}', 'Pat', 'One', 'pat1@a.test', '+15550000005'),
      ('${PA2}', 'office-a', null, 'Pat', 'Two', 'pat2@a.test', null),
      ('${PB1}', 'office-b', '${PB1_USER}', 'Bea', 'One', 'pat@b.test', null);
    insert into public.patients (id, provider_id, first_name, archived_into_patient_id) values ('${PA_ARCHIVED}', 'office-a', 'Pat', '${PA1}');
    insert into public.team_members values ('${TEAM_A}', 'office-a', '${STAFF_A}', 'Sam Staff', 'staff@a.test'),
      ('${TEAM_HQ_A}', 'office-a', '${HQ_STAFF_A}', 'Hana HQ', 'hq@thinnr.test'),
      ('${TEAM_SHARED_A}', 'office-a', '${SHARED_STAFF}', 'Shay', 'shared@both.test'),
      ('${TEAM_SHARED_B}', 'office-b', '${SHARED_STAFF}', 'Shay', 'shared@both.test');
    update public.profiles set provider_account_code = 'office-a' where id in ('${OWNER_A}', '${STAFF_A}', '${HQ_STAFF_A}');
    update public.profiles set provider_account_code = 'office-b' where id in ('${OWNER_B}', '${SHARED_STAFF}');
    insert into public.staff_role_assignments values ('staff@a.test', 'office-a', 'staff'), ('hq@thinnr.test', 'office-a', 'staff'),
      ('shared@both.test', 'office-b', 'staff'), ('owner@b.test', 'office-b', 'owner');
    insert into public.role_assignments (provider_account_code) values ('office-a'), ('office-b');
    insert into public.hq_memberships values ('${HQ_STAFF_A}', 'active', 'hq_admin');
    update public.profiles set role = 'staff' where id = '${HQ_STAFF_A}';
    insert into public.office_settings values ('office-a', 'x'), ('office-b', 'y');
    insert into public.billing_connected_accounts values ('office-a', 'acct_a'), ('office-b', 'acct_b');
    insert into public.billing_connect_archive (provider_id, account_snapshot) values ('office-a', '{"stripe_account_id":"acct_a_old"}');
    insert into public.billing_office_access_subscriptions (provider_id, stripe_customer_id) values ('office-a', 'cus_a'), ('office-b', 'cus_b');
    insert into public.billing_customer_emails values ('${uuid(650)}', 'office-a', null, null, null, null, null, null);
    insert into public.billing_webhook_events (account, payload) values ('acct_a', '{}'), ('acct_a_old', '{}'), (null, '{"data":{"object":{"customer":"cus_a"}}}'),
      ('acct_b', '{}'), (null, '{"data":{"object":{"customer":"cus_b"}}}');
    insert into public.admin_audit_events (provider_id, target_id, actor_user_id) values
      ('office-a', null, null), (null, 'office-a', null), (null, '${TEAM_A}', null), (null, 'x', '${STAFF_A}'),
      (null, 'y', '${HQ_STAFF_A}'), ('office-b', 'office-b', null);
    insert into public.admin_audit_event_archives (provider_id) values ('office-a'), ('office-b');
    insert into public.admin_audit_read_windows (actor_user_id) values ('${STAFF_A}'), ('${HQ_STAFF_A}'), ('${OWNER_B}');
    insert into public.analytics_events (kind, actor_user_id) values ('login', '${OWNER_A}'), ('login', '${HQ_STAFF_A}'), ('login', '${OWNER_B}');
    insert into public.legal_holds (target_id) values ('office-a'), ('office-b');
    insert into public.patient_tombstones values ('${uuid(900)}', 'office-a'), ('${uuid(901)}', 'office-b');
    insert into public.claim_verifications (resolved_ref, auth_user_id, identifier) values
      ('office-a', null, 'a'), ('${TEAM_A}', null, 'b'), (null, '${OWNER_A}', 'c'), (null, null, 'OWNER@A.TEST'), (null, null, '+15550000005'),
      (null, null, 'hq@thinnr.test'), ('office-b', null, 'owner@b.test');
    insert into public.staff_second_factors (staff_ref) values ('office-a'), ('${TEAM_A}'), ('office-b');
    insert into public.coach_conversations (provider_account_code) values ('office-a'), ('office-b');
    insert into public.coach_usage_leases (office) values ('office-a'), ('office-b');
    insert into public.auth_session_revocations (user_id) values ('${STAFF_A}'), ('${HQ_STAFF_A}'), ('${OWNER_B}');
    insert into public.training_viewers values ('${uuid(950)}', 'acct-office-a', null, null), ('${uuid(951)}', null, '${STAFF_A}', '${uuid(950)}'),
      ('${uuid(952)}', 'acct-office-b', null, null), ('${uuid(953)}', null, '${HQ_STAFF_A}', null);
    insert into public.provider_account_locks values ('office-a'), ('acct-office-a'), ('office-b');
    insert into public.data_exports values ('${uuid(760)}', 'office-a', '{}', null, '/objects/exports/${uuid(760)}/bundle.zip'),
      ('${uuid(761)}', null, '{}', '${STAFF_A}', null), ('${uuid(762)}', null, '{}', '${HQ_STAFF_A}', null), ('${uuid(763)}', 'office-b', '{}', null, null);
    ${perPatient(PA1, "office-a", 1)}
    ${perPatient(PA2, "office-a", 2)}
    ${perPatient(PA_ARCHIVED, "office-a", 3)}
    ${perPatient(PB1, "office-b", 4)}
  `);
}

interface Summary {
  providerId: string | null; patientIds: string[]; authUserIds: string[]; preservedUserIds: string[];
  objectPaths: string[]; exportIds: string[]; tables: Record<string, number>;
}
const run = (provider: string | null, patient: string | null) => scalar<Summary>(
  `public.hq_testing_hard_delete(${provider ? `'${provider}'` : "null"}, ${patient ? `'${patient}'::uuid` : "null"})`);

/** Every table with the column; counts rows matching the given values. */
function keyedLeftovers(column: "patient_id" | "provider_id", values: string[]): Record<string, number> {
  const tables = scalar<string[]>(`select coalesce(array_agg(c.table_name::text order by 1), '{}') from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = '${column}'`);
  const out: Record<string, number> = {};
  for (const table of tables) {
    const n = count(`public.${table} where ${column}::text = any(array[${values.map((v) => `'${v}'`).join(",")}])`);
    if (n > 0) out[table] = n;
  }
  return out;
}

describe.skipIf(!POSTGRES_AVAILABLE)("hq_testing_hard_delete (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hd-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"], { stdio: "ignore" });
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
  beforeEach(() => seed());

  it("erases the office, its patients, and every keyed row while the other office is untouched", () => {
    const bystanderBefore = { p: keyedLeftovers("patient_id", [PB1]), o: keyedLeftovers("provider_id", ["office-b"]) };
    const summary = run("office-a", null);

    expect(keyedLeftovers("patient_id", [PA1, PA2, PA_ARCHIVED])).toEqual({});
    expect(keyedLeftovers("provider_id", ["office-a"])).toEqual({});
    expect(count(`public.providers where provider_id = 'office-a'`)).toBe(0);
    expect(count(`public.patients where provider_id = 'office-a'`)).toBe(0);
    expect(count(`public.team_members where provider_id = 'office-a'`)).toBe(0);
    // Text-keyed, append-only and child tables.
    expect(count(`public.admin_audit_events where target_id is distinct from 'office-b' and coalesce(provider_id, '') <> 'office-b'
      and actor_user_id is distinct from '${HQ_STAFF_A}' and target_id is distinct from '${PB1}' and metadata->>'patientId' is distinct from '${PB1}'`)).toBe(0);
    expect(count(`public.admin_audit_events where actor_user_id = '${HQ_STAFF_A}'`)).toBe(1);
    expect(count(`public.analytics_events where actor_user_id = '${OWNER_A}'`)).toBe(0);
    expect(count(`public.analytics_events where actor_user_id = '${HQ_STAFF_A}'`)).toBe(1);
    expect(count(`public.legal_holds`)).toBe(2); // office-b + PB1
    expect(count(`public.claim_verifications`)).toBe(3); // hq address, office-b, PB1
    expect(count(`public.claim_verifications where identifier = 'hq@thinnr.test'`)).toBe(1);
    expect(count(`public.staff_second_factors`)).toBe(1);
    expect(count(`public.coach_conversations where coalesce(patient_ref, '') <> '${PB1}' and coalesce(provider_account_code, '') <> 'office-b'`)).toBe(0);
    expect(count(`public.coach_usage_leases where coalesce(office, '') = 'office-a' or scope like 'account:${PA1}'`)).toBe(0);
    expect(count(`public.coach_usage_daily`)).toBe(1);
    expect(count(`public.storage_upload_intents`)).toBe(1);
    expect(count(`private.patient_identity_reconciliation_audit`)).toBe(1);
    expect(count(`public.billing_customer_emails`)).toBe(2);
    expect(count(`public.email_vendor_events`)).toBe(2);
    expect(count(`public.billing_customer_email_events`)).toBe(1);
    expect(count(`public.billing_refunds`) + count(`public.billing_disputes`) + count(`public.billing_shipments`)).toBe(3);
    expect(count(`public.billing_ledger`)).toBe(1);
    expect(count(`public.billing_notification_contacts`)).toBe(1);
    expect(count(`public.billing_webhook_events`)).toBe(2);
    expect(count(`public.billing_connect_archive`)).toBe(0);
    expect(count(`public.patient_chat_messages`)).toBe(1);
    expect(count(`public.admin_audit_event_archives`)).toBe(1);
    expect(count(`public.admin_audit_read_windows`)).toBe(2);
    expect(count(`public.patient_tombstones`)).toBe(1);
    expect(count(`public.auth_session_revocations`)).toBe(2);
    expect(count(`public.training_viewers`)).toBe(2);
    expect(count(`public.provider_account_locks`)).toBe(1);
    expect(count(`public.staff_role_assignments where provider_account_code = 'office-a'`)).toBe(0);
    expect(count(`public.role_assignments`)).toBe(1);
    expect(count(`public.data_exports`)).toBe(3); // HQ member's, office-b's, PB1's

    // The bystander office keeps every row.
    expect(keyedLeftovers("patient_id", [PB1])).toEqual(bystanderBefore.p);
    expect(keyedLeftovers("provider_id", ["office-b"])).toEqual(bystanderBefore.o);

    // Logins: HQ member preserved; a staff login still used by office-b kept.
    expect(summary.preservedUserIds).toEqual([HQ_STAFF_A]);
    expect(new Set(summary.authUserIds)).toEqual(new Set([OWNER_A, STAFF_A, PA1_USER]));
    expect(scalar(`select role from public.profiles where id = '${HQ_STAFF_A}'`)).toBe("hq_admin");
    expect(scalar(`select provider_account_code from public.profiles where id = '${HQ_STAFF_A}'`)).toBeNull();
    expect(scalar(`select provider_account_code from public.profiles where id = '${SHARED_STAFF}'`)).toBe("office-b");

    // Files: stored objects only (external URLs ignored), plus export ids.
    expect(summary.objectPaths).toEqual(expect.arrayContaining([
      `/objects/patient-media/${PA1}/a.jpg`, `/objects/patients/${PA2}/bloodwork/staging.pdf`,
      `/objects/exports/${uuid(760)}/bundle.zip`, `/objects/patient-exports/${PA_ARCHIVED}.zip`,
    ]));
    expect(summary.objectPaths.some((p) => p.includes(PB1) || p.startsWith("https:"))).toBe(false);
    expect(new Set(summary.exportIds)).toEqual(new Set([uuid(701), uuid(702), uuid(703), uuid(760), uuid(761)]));
    expect(summary.tables.providers).toBe(1);
    expect(summary.tables.patients).toBe(3);

    // The append-only guard is back on.
    expect(scalar(`select tgenabled from pg_trigger where tgname = 'analytics_events_append_only'`)).toBe("O");
    expect(() => psql(`delete from public.analytics_events`)).toThrow(/append-only/);
    expect(() => psql(`delete from public.admin_audit_events`)).toThrow(/append-only/);
    expect(() => psql(`delete from public.billing_connected_accounts`)).toThrow(/safe restart/);
  });

  it("erases one patient (and their archived duplicate) and nothing else", () => {
    const summary = run(null, PA1);
    expect(keyedLeftovers("patient_id", [PA1, PA_ARCHIVED])).toEqual({});
    expect(count(`public.patients`)).toBe(2);
    expect(Object.keys(keyedLeftovers("patient_id", [PA2]))).toContain("patient_media");
    expect(count(`public.providers`)).toBe(2);
    expect(count(`public.office_settings`)).toBe(2);
    expect(count(`public.billing_connected_accounts`)).toBe(2);
    expect(count(`public.team_members`)).toBe(4);
    expect(count(`public.admin_audit_events where target_id = '${PA1}' or metadata->>'patientId' = '${PA1}'`)).toBe(0);
    expect(count(`public.admin_audit_events where target_id = '${PA2}'`)).toBe(1);
    expect(count(`public.legal_holds where target_id = '${PA1}'`)).toBe(0);
    expect(count(`public.legal_holds where target_id = 'office-a'`)).toBe(1);
    expect(count(`public.claim_verifications where identifier = '+15550000005'`)).toBe(0);
    expect(count(`public.billing_orders where id = '${uuid(501)}'`)).toBe(0);
    expect(count(`public.billing_refunds`)).toBe(2);
    expect(count(`public.data_exports where params->>'patientId' = '${PA1}'`)).toBe(0);
    expect(summary.authUserIds).toEqual([PA1_USER]);
    expect(new Set(summary.patientIds)).toEqual(new Set([PA1, PA_ARCHIVED]));
    expect(summary.preservedUserIds).toEqual([]);
  });

  it("keeps an HQ member's login when the patient is also on the HQ team", () => {
    psql(`insert into public.hq_memberships values ('${PA1_USER}', 'active', 'hq_admin')`);
    const summary = run(null, PA1);
    expect(summary.authUserIds).toEqual([]);
    expect(summary.preservedUserIds).toEqual([PA1_USER]);
    expect(count(`public.patients where id = '${PA1}'`)).toBe(0);
  });

  it("refuses non-service callers and bad arguments", () => {
    expect(() => psql(`begin; select set_config('test.role', 'authenticated', true); select public.hq_testing_hard_delete('office-a', null); commit;`)).toThrow(/service role required/);
    expect(() => run(null, null)).toThrow(/exactly one/);
    expect(() => run("office-a", PA1)).toThrow(/exactly one/);
    expect(() => run("office-missing", null)).toThrow(/unknown office/);
    expect(() => run(null, uuid(999))).toThrow(/unknown patient/);
    expect(count(`public.providers`)).toBe(2);
  });

  it("rolls back everything when a delete is blocked", () => {
    psql(`create table public.blocker (ref uuid references public.patients(id)); insert into public.blocker values ('${PA2}');`);
    try {
      expect(() => run("office-a", null)).toThrow();
      expect(count(`public.providers where provider_id = 'office-a'`)).toBe(1);
      expect(count(`public.patient_media where patient_id = '${PA1}'`)).toBe(1);
      expect(count(`public.admin_audit_events where provider_id = 'office-a'`)).toBe(1);
      expect(count(`public.billing_connected_accounts where provider_id = 'office-a'`)).toBe(1);
      expect(scalar(`select tgenabled from pg_trigger where tgname = 'analytics_events_append_only'`)).toBe("O");
    } finally {
      psql(`drop table public.blocker`);
    }
  });
});
