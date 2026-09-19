/**
 * Coach data is patient-owned data, not an application-only convention.
 * This starts PostgreSQL, applies the canonical Coach migrations, and proves
 * their rows participate in the same identity, retention, archive, and purge
 * barriers as the rest of the patient record.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationNames = [
  "20260914000000_patient_chat.sql",
  "20260921000000_patient_identity_reconciliation.sql",
  "20260921010000_patient_identity_reconciliation_write_guard.sql",
  "20260928000000_staff_inbox.sql",
  "20260928200000_staff_inbox_auto_close.sql",
  "20260928000000_patient_privacy_lifecycle.sql",
  "20261007000000_business_care_team_messaging.sql",
  "20261008000000_coach_conversations.sql",
  "20261008010000_coach_memory.sql",
  "20261008020000_coach_privacy.sql",
  "20261008030000_coach_review_guards.sql",
  "20261008040000_coach_memory_sentence_policy.sql",
];
const migrations = migrationNames.map((name) =>
  path.resolve(here, "../../../../supabase/migrations", name),
);
const available = ["initdb", "pg_ctl", "psql"].every(
  (name) => spawnSync("which", [name], { stdio: "ignore" }).status === 0,
);
if (!available) console.warn("coach-lifecycle.sql.test: PostgreSQL binaries unavailable — skipped");

// This is only the pre-Coach production surface required by the canonical
// migrations. Coach tables/functions are never mirrored here.
const SCHEMA = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema private;
  create table auth.users(id uuid primary key, phone text, raw_app_meta_data jsonb default '{}');
  create function auth.role() returns text language sql stable as $$select current_setting('test.role', true)$$;
  alter database postgres set test.role = 'service_role';
  create table public.providers(
    provider_id text primary key, provider_name text, office_name text, auth_user_id uuid,
    access_disabled boolean not null default false
  );
  create table public.patients(
    id uuid primary key, provider_id text not null references public.providers(provider_id),
    auth_user_id uuid, first_name text, last_name text, name text, email text, phone text,
    activation_status text not null, claimed_at timestamptz, invited_at timestamptz,
    created_at timestamptz not null default now(), archived_at timestamptz,
    archived_into_patient_id uuid references public.patients(id), identity_reconciliation_id uuid,
    program_id text, program_start_date date
  );
  create table public.profiles(id uuid primary key, role text);
  create table public.patient_media(
    object_path text primary key, patient_id uuid not null references public.patients(id) on delete cascade,
    kind text not null default 'food'
  );
  create table public.patient_progress_photos(
    patient_id uuid not null references public.patients(id) on delete cascade, photo_id text,
    object_path text, primary key(patient_id, photo_id)
  );
  create table public.patient_custom_foods(
    patient_id uuid not null references public.patients(id) on delete cascade, food_id text,
    photo_path text, primary key(patient_id, food_id)
  );
  create table public.patient_saved_recipes(
    patient_id uuid not null references public.patients(id) on delete cascade, recipe_id text,
    photo_path text, primary key(patient_id, recipe_id)
  );
  create table public.analytics_events(
    id bigint generated always as identity primary key,
    patient_id uuid references public.patients(id) on delete set null, provider_id text, kind text
  );
  create function public.reject_operational_event_mutation() returns trigger language plpgsql as
    $$begin raise exception 'operational event tables are append-only'; end$$;
  create trigger analytics_events_append_only before update or delete on public.analytics_events
    for each row execute function public.reject_operational_event_mutation();
  create table public.patient_notifications(
    id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id) on delete cascade,
    kind text, category text check(category in ('coach_outreach','check_in_reminders','office_reminders')),
    title text, body text, data jsonb, dedupe_key text unique, scheduled_at timestamptz default now(),
    expires_at timestamptz default now() + interval '3 day', status text default 'queued',
    attempts integer default 0, next_attempt_at timestamptz default now(),
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.provider_account_locks(account_id text primary key);
  create table public.team_members(id uuid default gen_random_uuid(), provider_id text, auth_user_id uuid, activation_status text);
  create table public.hq_memberships(id uuid default gen_random_uuid(), auth_user_id uuid, status text);
  create function private.provider_account_is_locked(text) returns boolean language sql as
    $$select exists(select 1 from public.provider_account_locks where regexp_replace(account_id,'^acct-','')=$1)$$;
`;

let dir = "";
let data = "";
const port = 56_100 + (process.pid % 500);
const args = () => ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const sql = (statement: string) => execFileSync("psql", [...args(), "-c", statement], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
function rows<T = Record<string, unknown>>(statement: string): T[] {
  return JSON.parse(sql(`select coalesce(json_agg(row_data), '[]'::json) from (${statement}) row_data;`) || "[]") as T[];
}
const scalar = <T>(statement: string): T => rows<{ value: T }>(`select (${statement}) as value`)[0].value;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PATIENT = id(1);
const OTHER = id(2);
const DUPLICATE = id(3);
const AUTH = id(900);

function insertPatient(patientId: string, activation = "activated", authUser: string | null = null, email = `${patientId}@example.test`) {
  sql(`insert into public.patients(id,provider_id,auth_user_id,first_name,last_name,email,phone,activation_status,program_id,program_start_date)
    values('${patientId}','a',${authUser ? `'${authUser}'` : "null"},'Pat','${patientId.slice(-4)}',
      '${email}','+15550001234','${activation}','thinnr','2026-06-01')`);
}
function consent(patientId: string) {
  sql(`insert into public.patient_consents(patient_id,policy_version,terms_accepted,privacy_accepted,health_data_accepted)
    values('${patientId}','2026-09-01',true,true,true)`);
}
function reset() {
  sql(`truncate public.coach_memory_source_suppressions, public.coach_memories, public.coach_conversation_work,
    public.patient_chat_patient_read_markers, public.patient_chat_read_markers, public.patient_chat_messages,
    public.patient_chat_conversations, public.patient_deletion_requests, public.patient_tombstones,
    public.patient_consents, public.analytics_events, public.patients cascade;
    insert into auth.users(id) values('${AUTH}') on conflict do nothing;`);
  insertPatient(PATIENT, "activated", AUTH, "patient@example.test");
  insertPatient(OTHER, "activated", null, "other@example.test");
  consent(PATIENT);
  consent(OTHER);
}
function createCoach(patientId: string, key: string): string {
  return rows<{ id: string }>(`select id from public.coach_conversation_create('${patientId}','${key}')`)[0].id;
}
function append(patientId: string, conversationId: string, clientId: string, text: string) {
  return scalar<string>(`public.coach_conversation_append('${patientId}','${conversationId}',
    '[{"client_id":"${clientId}","role":"user","text":"${text}"}]'::jsonb)`);
}
function claimMemory() {
  return rows<{ work_id: string; conversation_id: string; patient_id: string; source_client_id: string; claim_token: string }>(
    "select * from public.coach_memory_claim_processing(300)",
  )[0];
}
function complete(work: { work_id: string; patient_id: string; conversation_id: string; claim_token: string }, clientId: string, text: string, sensitivity = "ordinary") {
  return scalar<boolean>(`public.coach_memory_complete_processing('${work.work_id}','${work.patient_id}',
    '${work.conversation_id}','${work.claim_token}',
    '[{"sourceMessageId":"${clientId}","text":"${text}","category":"food_preference","sensitivity":"${sensitivity}"}]'::jsonb)`);
}

describe.skipIf(!available)("Coach lifecycle migrations on real PostgreSQL", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "coach-lifecycle-pg-"));
    data = path.join(dir, "data");
    execFileSync("initdb", ["-D", data, "-A", "trust", "-U", "postgres"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", data, "-o", `-k ${dir} -p ${port} -F`, "-w", "start"], { stdio: "ignore" });
    sql(SCHEMA);
    sql(`insert into public.providers(provider_id,provider_name,office_name,access_disabled)
      values('a','Dr A','Office A',false)`);
    for (const migration of migrations) {
      execFileSync("psql", [...args(), "-f", migration], { stdio: ["ignore", "ignore", "pipe"] });
    }
    // The canonical reconciliation migration correctly refuses collision
    // fixtures. This isolated proof creates those fixtures only after it has
    // installed the actual reconciliation implementation.
    sql("drop index patients_email_normalized_unique_idx; drop index patients_phone_normalized_unique_idx;");
  }, 60_000);

  afterAll(() => {
    if (data) spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("installs canonical Coach tables under identity guards and service-only RPC grants", () => {
    const tables = ["coach_conversation_work", "coach_memories", "coach_memory_source_suppressions"];
    const unguarded = rows<{ table_name: string }>(`select c.table_name
      from information_schema.columns c join pg_class k on k.relname=c.table_name
      join pg_namespace n on n.oid=k.relnamespace and n.nspname=c.table_schema
      where c.table_schema='public' and c.table_name in (${tables.map((name) => `'${name}'`).join(",")})
        and c.column_name='patient_id' and not exists (
          select 1 from pg_trigger t where t.tgrelid=k.oid and t.tgname='patient_identity_write_guard' and not t.tgisinternal
        )`);
    expect(unguarded).toEqual([]);
    for (const fn of [
      "public.coach_memory_claim_processing(integer)",
      "public.coach_memory_complete_processing(uuid,uuid,uuid,text,jsonb)",
    ]) {
      expect(scalar<boolean>(`has_function_privilege('anon','${fn}','execute')`), fn).toBe(false);
      expect(scalar<boolean>(`has_function_privilege('authenticated','${fn}','execute')`), fn).toBe(false);
      expect(scalar<boolean>(`has_function_privilege('service_role','${fn}','execute')`), fn).toBe(true);
    }
  });

  it("archives a conversation, cancels pending and leased work, and refuses a delayed fact", () => {
    reset();
    const conversation = createCoach(PATIENT, "archive-proof");
    // Archive is not a blanket memory deletion: an already approved fact
    // remains available under the memory owner's retention policy.
    expect(append(PATIENT, conversation, "approved-source", "I like eggs")).toBe("ok");
    expect(complete(claimMemory(), "approved-source", "I like eggs")).toBe(true);
    expect(scalar<number>(`(select count(*) from public.coach_memories where patient_id='${PATIENT}' and state='active')`)).toBe(1);
    expect(append(PATIENT, conversation, "archive-message", "I like chicken")).toBe("ok");
    const leased = claimMemory();
    expect(leased.conversation_id).toBe(conversation);
    expect(scalar<string>(`public.coach_conversation_archive('${PATIENT}','${conversation}',true,1)`)).toBe("ok");
    expect(scalar<number>(`(select count(*) from public.coach_conversation_work where conversation_id='${conversation}' and state='ready')`)).toBe(3);
    expect(scalar<number>(`(select count(*) from public.coach_conversation_work
      where conversation_id='${conversation}' and state in ('pending','running','failed'))`)).toBe(0);
    expect(scalar<string>(`(select processing_state from public.patient_chat_conversations where id='${conversation}')`)).toBe("ready");
    expect(complete(leased, "archive-message", "I like chicken")).toBe(false);
    expect(scalar<number>(`(select count(*) from public.coach_memories where patient_id='${PATIENT}' and state='active')`)).toBe(1);
    expect(append(PATIENT, conversation, "late-message", "Late write")).toBe("archived");
  });

  it("retention cascades an aged Coach source and its memory/work, while retaining Care Team history", () => {
    reset();
    const coach = createCoach(PATIENT, "retention-proof");
    expect(append(PATIENT, coach, "old-source", "I like eggs")).toBe("ok");
    expect(complete(claimMemory(), "old-source", "I like eggs")).toBe(true);
    const care = (scalar<Record<string, unknown>>(`public.care_team_start('${PATIENT}','a')`).conversationId as string);
    sql(`select public.care_team_send('${care}','${PATIENT}','a','care-old','Human history','user',null,null,false);
      update public.patient_chat_messages set created_at=now()-interval '800 days'
        where conversation_id in ('${coach}','${care}');
      update public.patient_chat_conversations set updated_at=now()-interval '800 days'
        where id in ('${coach}','${care}')`);
    const result = rows<{ messages_deleted: number; conversations_deleted: number }>(
      "select messages_deleted, conversations_deleted from public.retention_trim_chat_transcripts(now()-interval '730 days',100,false)",
    )[0];
    expect(result).toMatchObject({ messages_deleted: 1, conversations_deleted: 1 });
    expect(scalar<number>(`(select count(*) from public.patient_chat_conversations where id='${coach}')`)).toBe(0);
    expect(scalar<number>(`(select count(*) from public.coach_memories where patient_id='${PATIENT}')`)).toBe(0);
    expect(scalar<number>(`(select count(*) from public.coach_conversation_work where patient_id='${PATIENT}' and conversation_id='${coach}')`)).toBe(0);
    expect(scalar<number>(`(select count(*) from public.patient_chat_conversations where id='${care}' and thread='care_team')`)).toBe(1);
    expect(scalar<number>(`(select count(*) from public.patient_chat_messages where conversation_id='${care}')`)).toBe(1);
  });

  // The chat transcript timer is an AI-transcript timer. Staff-patient (care
  // team) messages are part of the clinical record and ride the clinical
  // record retention setting instead; this proof pins the RPC's thread
  // allow-list so widening it to 'care_team' fails here before it ships.
  it("the chat transcript trim deletes coach and support messages past the cutoff but never care-team messages of the same age", () => {
    reset();
    const coach = createCoach(PATIENT, "timer-coach");
    expect(append(PATIENT, coach, "coach-old", "Coach transcript")).toBe("ok");
    const support = id(801);
    sql(`insert into public.patient_chat_conversations(id,patient_id,thread)
      values('${support}','${PATIENT}','support');
      insert into public.patient_chat_messages(conversation_id,client_id,role,text)
      values('${support}','support-old','user','Support transcript')`);
    const care = (scalar<Record<string, unknown>>(`public.care_team_start('${PATIENT}','a')`).conversationId as string);
    // One message each way: the patient's and a staff reply from the office owner.
    sql(`update public.providers set auth_user_id='${id(900)}' where provider_id='a';
      select public.care_team_send('${care}','${PATIENT}','a','care-old-1','Patient to nurse','user',null,null,false);
      select public.care_team_send('${care}','${PATIENT}','a','care-old-2','Nurse to patient','staff','${id(900)}','Nurse Kim',false)`);
    // Every message and conversation is the same age, well past the cutoff.
    sql(`update public.patient_chat_messages set created_at=now()-interval '800 days'
        where conversation_id in ('${coach}','${support}','${care}');
      update public.patient_chat_conversations set updated_at=now()-interval '800 days'
        where id in ('${coach}','${support}','${care}')`);
    const threads = () => rows<{ thread: string; messages: number }>(
      `select c.thread, count(m.*)::int as messages from public.patient_chat_conversations c
        left join public.patient_chat_messages m on m.conversation_id=c.id
        where c.patient_id='${PATIENT}' group by c.thread order by c.thread`,
    );
    expect(threads()).toEqual([
      { thread: "care_team", messages: 2 }, { thread: "coach", messages: 1 }, { thread: "support", messages: 1 },
    ]);

    const call = (dryRun: boolean) => rows<{ messages_deleted: number; conversations_deleted: number }>(
      `select messages_deleted, conversations_deleted from public.retention_trim_chat_transcripts(now()-interval '730 days',100,${dryRun})`,
    )[0];
    // The dry run reports only the AI threads as due.
    expect(call(true)).toMatchObject({ messages_deleted: 2, conversations_deleted: 2 });
    expect(threads()).toEqual([
      { thread: "care_team", messages: 2 }, { thread: "coach", messages: 1 }, { thread: "support", messages: 1 },
    ]);
    // The real run removes exactly the coach and support rows.
    expect(call(false)).toMatchObject({ messages_deleted: 2, conversations_deleted: 2 });
    expect(threads()).toEqual([{ thread: "care_team", messages: 2 }]);
    expect(rows<{ client_id: string }>(`select client_id from public.patient_chat_messages where conversation_id='${care}' order by client_id`))
      .toEqual([{ client_id: "care-old-1" }, { client_id: "care-old-2" }]);
    expect(scalar<number>(`(select count(*) from public.patient_chat_conversations where id='${care}' and thread='care_team')`)).toBe(1);
    // A second pass finds nothing left on the timer: the care-team thread is not merely "not yet due".
    expect(call(false)).toMatchObject({ messages_deleted: 0, conversations_deleted: 0 });
    expect(threads()).toEqual([{ thread: "care_team", messages: 2 }]);
  });

  it("purges archived conversations, messages, active/pending/removed facts, suppressions and queued work without touching another patient", () => {
    reset();
    const removable = createCoach(PATIENT, "remove-proof");
    expect(append(PATIENT, removable, "remove-source", "I like eggs")).toBe("ok");
    expect(complete(claimMemory(), "remove-source", "I like eggs")).toBe(true);
    const memory = rows<{ id: string; version: number }>(`select id,version from public.coach_memories
      where patient_id='${PATIENT}' and source_message_id='remove-source'`)[0];
    sql(`select public.coach_memory_mutate('${PATIENT}','${memory.id}','forget',${memory.version},null)`);
    // A retry that was delayed until after "forget" sees the durable source
    // tombstone inside its completion transaction and cannot resurrect a fact.
    sql(`update public.coach_conversation_work set state='pending', lease_owner=null, lease_until=null
      where patient_id='${PATIENT}' and conversation_id='${removable}' and kind='memory'`);
    expect(complete(claimMemory(), "remove-source", "I like eggs")).toBe(true);
    expect(scalar<number>(`(select count(*) from public.coach_memories where patient_id='${PATIENT}'
      and source_message_id='remove-source')`)).toBe(1);
    const pending = createCoach(PATIENT, "pending-proof");
    expect(append(PATIENT, pending, "pending-source", "I take medication")).toBe("ok");
    expect(complete(claimMemory(), "pending-source", "I take medication", "sensitive")).toBe(true);
    const archived = createCoach(PATIENT, "archived-proof");
    expect(append(PATIENT, archived, "archived-source", "Old conversation")).toBe("ok");
    sql(`select public.coach_conversation_archive('${PATIENT}','${archived}',true,1)`);
    expect(scalar<string | null>(`(select archived_at::text from public.patient_chat_conversations where id='${archived}')`)).not.toBeNull();
    expect(scalar<number>(`(select count(*) from public.patient_chat_messages where conversation_id='${archived}')`)).toBe(1);
    const otherCoach = createCoach(OTHER, "other-proof");
    expect(append(OTHER, otherCoach, "other-source", "I like pears")).toBe("ok");

    expect(scalar<number>(`(select count(*) from public.coach_memories where patient_id='${PATIENT}' and state='pending')`)).toBe(1);
    expect(scalar<number>(`(select count(*) from public.coach_memories where patient_id='${PATIENT}' and state='removed')`)).toBe(1);
    expect(scalar<number>(`(select count(*) from public.coach_memory_source_suppressions where patient_id='${PATIENT}')`)).toBe(1);
    const request = rows<{ id: string }>(`select id from public.patient_deletion_request('${PATIENT}',0)`)[0];
    expect(rows<{ id: string }>(`select id from public.claim_due_patient_deletions('coach-purge',1,300)`)[0].id).toBe(request.id);
    expect(scalar<Record<string, unknown>>(`public.patient_purge_rows('${request.id}')`).patientRowDeleted).toBe(true);
    for (const table of ["coach_memories", "coach_memory_source_suppressions", "coach_conversation_work", "patient_chat_conversations"]) {
      expect(scalar<number>(`(select count(*) from public.${table} where patient_id='${PATIENT}')`), table).toBe(0);
    }
    expect(scalar<number>(`(select count(*) from public.patient_chat_messages m join public.patient_chat_conversations c on c.id=m.conversation_id where c.patient_id='${PATIENT}')`)).toBe(0);
    expect(scalar<number>(`(select count(*) from public.coach_conversation_work where patient_id='${OTHER}')`)).toBeGreaterThan(0);
    expect(() => sql(`insert into public.coach_conversation_work(patient_id,conversation_id,kind,dedupe_key)
      values('${PATIENT}','${archived}','memory','late-queue')`)).toThrow(/unknown patient/);
    expect(() => sql(`insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,
      source_message_id,source_created_at,topic_key,source_text_hash) values('${PATIENT}','late','routine','ordinary','active',
      '${archived}','archived-source',now(),'late','late')`)).toThrow(/unknown patient/);
  });

  it("reconciles Coach sources, facts, suppressions and work atomically with their patient identity", () => {
    reset();
    insertPatient(DUPLICATE, "invited", null, "patient@example.test");
    // The reviewed reconciliation path intentionally permits an unlinked
    // invitation without consent. Seed its already-persisted Coach rows at
    // the storage boundary rather than invoking the patient write RPC.
    const source = id(777);
    sql(`insert into public.patient_chat_conversations(id,patient_id,provider_id,thread,client_key)
      values('${source}','${DUPLICATE}','a','coach','duplicate-source');
      insert into public.patient_chat_messages(conversation_id,client_id,role,text)
      values('${source}','duplicate-message','user','I like carrots');
      insert into public.coach_conversation_work(patient_id,conversation_id,kind,dedupe_key,source_client_id)
      values('${DUPLICATE}','${source}','memory','memory:duplicate-message','duplicate-message');
      insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,
        source_message_id,source_created_at,topic_key,source_text_hash,confirmed_at)
      values('${DUPLICATE}','I like carrots','food_preference','ordinary','active','${source}',
        'duplicate-message',now(),private.coach_memory_topic_key('I like carrots'),
        private.coach_memory_topic_key('I like carrots'),now())`);
    const fact = rows<{ id: string; version: number }>(`select id,version from public.coach_memories where patient_id='${DUPLICATE}'`)[0];
    sql(`select public.coach_memory_mutate('${DUPLICATE}','${fact.id}','forget',${fact.version},null)`);
    const audit = scalar<string>(`private.reconcile_invited_patient_duplicate('${PATIENT}','${DUPLICATE}',
      'reviewed Coach duplicate',null)`);
    expect(audit).toMatch(/[0-9a-f-]{36}/);
    for (const table of ["coach_memories", "coach_memory_source_suppressions", "coach_conversation_work", "patient_chat_conversations"]) {
      expect(scalar<number>(`(select count(*) from public.${table} where patient_id='${DUPLICATE}')`), table).toBe(0);
    }
    expect(scalar<number>(`(select count(*) from public.coach_memories where patient_id='${PATIENT}' and source_conversation_id='${source}')`)).toBe(1);
    expect(scalar<number>(`(select count(*) from public.coach_memory_source_suppressions where patient_id='${PATIENT}')`)).toBe(1);
    expect(scalar<string | null>(`(select archived_into_patient_id::text from public.patients where id='${DUPLICATE}')`)).toBe(PATIENT);
    expect(scalar<number>(`(select count(*) from public.patient_chat_messages where conversation_id='${source}' and client_id='duplicate-message')`)).toBe(1);
  });
});