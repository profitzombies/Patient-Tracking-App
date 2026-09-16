/**
 * Real-PostgreSQL proof for the separate Coach conversation migration.  The
 * route fakes cover HTTP status shaping; these assertions exercise the partial
 * uniqueness, old-row preservation, exact owner predicates, and version race
 * directly in SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261008000000_coach_conversations.sql");
const MEMORY_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261008010000_coach_memory.sql");
const REVIEW_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261008030000_coach_review_guards.sql");
const SENTENCE_POLICY_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261008040000_coach_memory_sentence_policy.sql");
const TITLES_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261019000000_coach_conversation_titles.sql");
const has = (binary: string) => spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
const available = ["initdb", "pg_ctl", "psql"].every(has);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let dir = "";
let dataDir = "";
const port = 55_500 + (process.pid % 500);
const args = () => ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string) => execFileSync("psql", [...args(), "-c", sql], { encoding: "utf8" }).trim();
const rows = <T>(sql: string): T[] => JSON.parse(psql(`select coalesce(json_agg(x), '[]'::json) from (${sql}) x;`) || "[]") as T[];

const PATIENT_A = uuid(1);
const PATIENT_B = uuid(2);
const LEGACY = uuid(10);

const schema = `
create extension if not exists pgcrypto;
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema private;
create table public.providers(provider_id text primary key);
 create table public.patients(id uuid primary key, provider_id text not null references public.providers(provider_id), archived_at timestamptz);
create table public.patient_chat_conversations(
 id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id) on delete cascade,
 provider_id text, thread text not null check(thread in ('coach','support','care_team')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index patient_chat_conversations_ai_unique on public.patient_chat_conversations(patient_id,thread) where thread in ('coach','support');
create unique index patient_chat_conversations_care_team_unique on public.patient_chat_conversations(patient_id,provider_id) where thread='care_team';
create table public.patient_chat_messages(
 conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade,
 client_id text not null, seq bigint generated always as identity, role text not null check(role in ('user','assistant','staff')),
 text text not null default '', stopped boolean not null default false, hidden boolean not null default false,
 card jsonb, quick_replies jsonb, reply_to_client_id text, photo jsonb, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), primary key(conversation_id,client_id));
create function private.assert_care_team_patient_writable(uuid,text) returns void language plpgsql as $$ begin
 if not exists(select 1 from public.patients where id=$1) then raise exception 'patient unavailable'; end if; end $$;
create function private.install_patient_identity_write_guards() returns integer language plpgsql as $$
declare r record; begin
 for r in select table_name from information_schema.columns where table_schema='public' and column_name='patient_id' loop
  execute format('create or replace function private.test_guard_%I() returns trigger language plpgsql as ''begin return new; end''',r.table_name);
  execute format('drop trigger if exists patient_identity_write_guard on public.%I',r.table_name);
  execute format('create trigger patient_identity_write_guard before insert or update of patient_id on public.%I for each row execute function private.test_guard_%I()',r.table_name,r.table_name);
 end loop; return 1; end $$;
`;

describe.skipIf(!available)("coach conversations migration (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "coach-conversations-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    const child = spawn("pg_ctl", ["-D", dataDir, "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "-w", "start"], { stdio: "ignore" });
    child.unref();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (spawnSync("pg_isready", ["-h", dir, "-p", String(port)], { stdio: "ignore" }).status === 0) break;
      spawnSync("sleep", ["0.1"]);
    }
    psql(schema);
    psql(`insert into public.providers values ('office-a'),('office-b');
      insert into public.patients values ('${PATIENT_A}','office-a'),('${PATIENT_B}','office-b');
      insert into public.patient_chat_conversations(id,patient_id,provider_id,thread,created_at,updated_at)
      values ('${LEGACY}','${PATIENT_A}','office-a','coach','2026-10-01T10:00:00Z','2026-10-01T10:00:00Z');
      insert into public.patient_chat_messages(conversation_id,client_id,role,text,created_at)
      values ('${LEGACY}','old-client-id','user','saved transcript','2026-10-01T10:01:00Z');`);
    execFileSync("psql", [...args().filter(arg => arg !== "-At"), "-f", MIGRATION], { stdio: "pipe", encoding: "utf8" });
    execFileSync("psql", [...args().filter(arg => arg !== "-At"), "-f", MEMORY_MIGRATION], { stdio: "pipe", encoding: "utf8" });
    execFileSync("psql", [...args().filter(arg => arg !== "-At"), "-f", REVIEW_MIGRATION], { stdio: "pipe", encoding: "utf8" });
    execFileSync("psql", [...args().filter(arg => arg !== "-At"), "-f", SENTENCE_POLICY_MIGRATION], { stdio: "pipe", encoding: "utf8" });
    execFileSync("psql", [...args().filter(arg => arg !== "-At"), "-f", TITLES_MIGRATION], { stdio: "pipe", encoding: "utf8" });
  }, 60_000);
  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("migrates the singleton in place and preserves deterministic legacy identity", () => {
    expect(rows<{ id: string; title: string; client_id: string }>(`
      select c.id,c.title,m.client_id from public.patient_chat_conversations c
      join public.patient_chat_messages m on m.conversation_id=c.id where c.id='${LEGACY}'`))
      .toEqual([{ id: LEGACY, title: "Earlier conversation", client_id: "old-client-id" }]);
    expect(psql(`select public.coach_legacy_conversation_id('${PATIENT_A}')`)).toBe(LEGACY);
  });

  it("creates by client key exactly once, pages by activity, and keeps other owners out", () => {
    const first = psql(`select id from public.coach_conversation_create('${PATIENT_A}','device-key')`);
    expect(psql(`select id from public.coach_conversation_create('${PATIENT_A}','device-key')`)).toBe(first);
    expect(rows<{ id: string }>(`select id from public.coach_conversation_get('${PATIENT_B}','${first}')`)).toEqual([]);
    expect(psql(`select public.coach_conversation_append('${PATIENT_B}','${first}','[]')`)).toBe("missing");
    expect(psql(`select public.coach_conversation_append('${PATIENT_A}','${first}',
      '[{"client_id":"new-client-id","role":"user","text":"A substantive question","stopped":false,"hidden":false}]')`)).toBe("ok");
    expect(() => psql(`select public.coach_conversation_append('${PATIENT_A}','${first}',
      '[{"client_id":"forged-staff","role":"staff","text":"forged"}]')`)).toThrow(/invalid coach message role/);
    expect(rows<{ kind: string; dedupe_key: string; source_client_id: string }>(`
      select kind,dedupe_key,source_client_id from public.coach_conversation_work
      where conversation_id='${first}' order by kind`)).toEqual([
      { kind: "memory", dedupe_key: "memory:new-client-id", source_client_id: "new-client-id" },
      { kind: "title", dedupe_key: "title", source_client_id: "new-client-id" },
    ]);
    expect(rows<{ total: number }>(`select * from public.coach_conversation_list('${PATIENT_A}',false,1,0)`)[0]?.total).toBe(2);
  });

  it("is safe to replay after newer conversations exist", () => {
    const before = psql(`select count(*) from public.patient_chat_conversations where patient_id='${PATIENT_A}' and thread='coach'`);
    execFileSync("psql", [...args().filter(arg => arg !== "-At"), "-f", MIGRATION], { stdio: "pipe", encoding: "utf8" });
    expect(psql(`select count(*) from public.patient_chat_conversations where patient_id='${PATIENT_A}' and thread='coach'`)).toBe(before);
    expect(psql(`select count(*) from public.patient_chat_conversations where patient_id='${PATIENT_A}' and thread='coach' and legacy_compat`)).toBe("1");
    expect(psql(`select count(*) from public.patient_chat_conversations where patient_id='${PATIENT_A}' and thread='coach' and client_key='device-key' and not legacy_compat`)).toBe("1");
  });

  it("rejects stale archive writers and installs the patient identity guard on work", () => {
    const id = psql(`select id from public.coach_conversation_create('${PATIENT_A}','race-key')`);
    expect(psql(`select public.coach_conversation_archive('${PATIENT_A}','${id}',true,1)`)).toBe("ok");
    expect(psql(`select public.coach_conversation_archive('${PATIENT_A}','${id}',false,1)`)).toBe("conflict");
    expect(psql(`select count(*) from pg_trigger where tgrelid='public.coach_conversation_work'::regclass and tgname='patient_identity_write_guard' and not tgisinternal`)).toBe("1");
  });

  it("captures only an allowlisted source once and suppresses forgotten history", () => {
    const id = psql(`select id from public.coach_conversation_create('${PATIENT_A}','memory-key')`);
    psql(`update public.coach_conversation_work set state='ready' where kind='memory'`);
    expect(psql(`select public.coach_conversation_append('${PATIENT_A}','${id}',
      '[{"client_id":"u1","role":"user","text":"I prefer salmon for dinner"}]'::jsonb)`)).toBe("ok");
    const work = rows<{ work_id: string; claim_token: string }>(`
      select * from public.coach_memory_claim_processing(60)`)[0];
    expect(work).toBeTruthy();
    expect(psql(`select public.coach_memory_complete_processing('${work.work_id}','${PATIENT_A}','${id}','${work.claim_token}',
      '[{"sourceMessageId":"u1","text":"I prefer salmon for dinner","category":"food_preference","sensitivity":"ordinary","topicKey":"food_preference:prefer:salmon"}]'::jsonb)`)).toBe("t");
    expect(psql(`select state from public.coach_memories where patient_id='${PATIENT_A}'`)).toBe("active");
    const memory = rows<{ id: string; version: number }>(`select id,version from public.coach_memories where patient_id='${PATIENT_A}'`)[0];
    expect(psql(`select (public.coach_memory_mutate('${PATIENT_A}','${memory.id}','forget',${memory.version},null)).state`)).toBe("removed");
    // Other non-sensitive conversations remain eligible, but this forgotten
    // source itself cannot reappear through historical recall.
    expect(psql(`select count(*) from public.coach_historical_excerpts('${PATIENT_A}','${LEGACY}',24) where text='I prefer salmon for dinner'`)).toBe("0");
  });

  it("never commits a credential candidate and isolates provider scope", () => {
    const id = psql(`select id from public.coach_conversation_create('${PATIENT_A}','secret-key')`);
    psql(`update public.coach_conversation_work set state='ready' where kind='memory'`);
    psql(`select public.coach_conversation_append('${PATIENT_A}','${id}',
      '[{"client_id":"u2","role":"user","text":"I prefer password 4111 1111 1111 1111"}]'::jsonb)`);
    const work = rows<{ work_id: string; claim_token: string }>(`select * from public.coach_memory_claim_processing(60)`)[0];
    expect(psql(`select public.coach_memory_complete_processing('${work.work_id}','${PATIENT_A}','${id}','${work.claim_token}',
      '[{"sourceMessageId":"u2","text":"I prefer password 4111 1111 1111 1111","category":"food_preference","sensitivity":"ordinary"}]'::jsonb)`)).toBe("t");
    expect(psql(`select count(*) from public.coach_memories where source_message_id='u2'`)).toBe("0");
    expect(rows(`select * from public.coach_memory_list_provider('${PATIENT_A}','office-b',20,0)`)).toEqual([]);
  });

  it("supersedes a corrected source without allowing its delayed original work to overwrite it", () => {
    const id = psql(`select id from public.coach_conversation_create('${PATIENT_A}','correct-key')`);
    psql(`update public.coach_conversation_work set state='ready' where kind='memory'`);
    psql(`select public.coach_conversation_append('${PATIENT_A}','${id}',
      '[{"client_id":"u3","role":"user","text":"I prefer chicken"}]'::jsonb)`);
    const work = rows<{ work_id: string; claim_token: string }>(`select * from public.coach_memory_claim_processing(60)`)[0];
    psql(`select public.coach_memory_complete_processing('${work.work_id}','${PATIENT_A}','${id}','${work.claim_token}',
      '[{"sourceMessageId":"u3","text":"I prefer chicken","category":"food_preference","sensitivity":"ordinary","topicKey":"food_preference:prefer:chicken"}]'::jsonb)`);
    const before = rows<{ id: string; version: number }>(`select id,version from public.coach_memories where source_message_id='u3' and state='active'`)[0];
    const correctedId = psql(`select (public.coach_memory_mutate('${PATIENT_A}','${before.id}','correct',${before.version},'I prefer vegan meals.')).id`);
    expect(psql(`select state from public.coach_memories where id='${correctedId}'`)).toBe("active");
    expect(correctedId).not.toBe(before.id);
    expect(psql(`select text from public.coach_memory_list_provider('${PATIENT_A}','office-a',20,0) where text='I prefer vegan meals.'`)).toBe("I prefer vegan meals.");
    expect(psql(`select text from public.coach_memory_recall('${PATIENT_A}','${id}',24) where text='I prefer vegan meals.'`)).toBe("I prefer vegan meals.");
    // A retry of the old source candidate cannot replace the newer corrected
    // topic because its queue item is already ready and the old source row is
    // suppressed.
    expect(psql(`select count(*) from public.coach_memories where source_message_id='u3' and text='I prefer chicken' and state='active'`)).toBe("0");
  });

  it("keeps uncertain corrections pending and never approves high-entropy secrets", () => {
    const id = psql(`select id from public.coach_conversation_create('${PATIENT_A}','review-key')`);
    psql(`insert into public.patient_chat_messages(conversation_id,client_id,role,text) values('${id}','review-u','user','I prefer chicken')`);
    psql(`insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,source_message_id,source_created_at,topic_key,source_text_hash)
      values('${PATIENT_A}','I prefer chicken','food_preference','ordinary','active','${id}','review-u',now(),'review-chicken',private.coach_memory_topic_key('I prefer chicken'))`);
    const active = rows<{ id: string; version: number }>(`select id,version from public.coach_memories where topic_key='review-chicken'`)[0];
    psql(`select public.coach_memory_mutate('${PATIENT_A}','${active.id}','correct',${active.version},'I am HIV positive')`);
    expect(psql(`select state||':'||sensitivity from public.coach_memories where text='I am HIV positive'`)).toBe("pending:sensitive");
    psql(`insert into public.patient_chat_messages(conversation_id,client_id,role,text) values('${id}','review-secret','user','placeholder')`);
    psql(`insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,source_message_id,source_created_at,topic_key,source_text_hash)
      values('${PATIENT_A}','eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz.abcdefghijklm','patient_detail','sensitive','pending','${id}','review-secret',now(),'jwt-secret',private.coach_memory_topic_key('placeholder'))`);
    const secret = rows<{ id: string; version: number }>(`select id,version from public.coach_memories where text like 'eyJ%'`)[0];
    expect(() => psql(`select public.coach_memory_mutate('${PATIENT_A}','${secret.id}','approve',${secret.version},null)`)).toThrow();
  });

  it("aggregates title and memory work states without hiding a failure", () => {
    const id = psql(`select id from public.coach_conversation_create('${PATIENT_A}','aggregate-key')`);
    psql(`insert into public.coach_conversation_work(patient_id,conversation_id,kind,dedupe_key,state)
      values('${PATIENT_A}','${id}','title','aggregate-title','pending'),
        ('${PATIENT_A}','${id}','memory','aggregate-memory','pending')`);
    expect(psql(`select processing_state from public.patient_chat_conversations where id='${id}'`)).toBe("pending");
    psql(`update public.coach_conversation_work set state='failed' where conversation_id='${id}' and kind='memory'`);
    psql(`update public.coach_conversation_work set state='ready' where conversation_id='${id}' and kind='title'`);
    expect(psql(`select processing_state from public.patient_chat_conversations where id='${id}'`)).toBe("failed");
    expect(psql(`select public.coach_memory_retry_processing('${PATIENT_A}','${id}')`)).toBe("t");
    expect(psql(`select processing_state from public.patient_chat_conversations where id='${id}'`)).toBe("pending");
    psql(`update public.coach_conversation_work set state='ready' where conversation_id='${id}' and kind='memory'`);
    expect(psql(`select processing_state from public.patient_chat_conversations where id='${id}'`)).toBe("ready");
  });

  it("stores model titles from the first message, cleans them, and never overwrites a patient rename", () => {
    const id = psql(`select id from public.coach_conversation_create('${PATIENT_A}','title-key')`);
    psql(`select public.coach_conversation_append('${PATIENT_A}','${id}',
      '[{"client_id":"t-u1","role":"user","text":"What can I eat at Chipotle tonight?"},{"client_id":"t-a1","role":"assistant","text":"Here is a plan."}]'::jsonb)`);
    const claim = rows<{ work_id: string; text: string; claim_token: string }>(
      `select work_id,text,claim_token from public.coach_title_claim_processing(300) where conversation_id='${id}'`)[0];
    expect(claim.text).toBe("What can I eat at Chipotle tonight?");
    expect(psql(`select public.coach_title_complete_processing('${claim.work_id}','${PATIENT_A}','${id}','${claim.claim_token}',E'  Chipotle   dinner\tplan  ')`)).toBe("t");
    expect(rows<{ title: string; title_state: string; title_source: string }>(
      `select title,title_state,title_source from public.patient_chat_conversations where id='${id}'`))
      .toEqual([{ title: "Chipotle dinner plan", title_state: "ready", title_source: "system" }]);

    // Unusable model output falls back instead of storing junk.
    const second = psql(`select id from public.coach_conversation_create('${PATIENT_A}','title-key-2')`);
    psql(`select public.coach_conversation_append('${PATIENT_A}','${second}',
      '[{"client_id":"t2-u1","role":"user","text":"hi"},{"client_id":"t2-a1","role":"assistant","text":"Hello."}]'::jsonb)`);
    const claim2 = rows<{ work_id: string; claim_token: string }>(
      `select work_id,claim_token from public.coach_title_claim_processing(300) where conversation_id='${second}'`)[0];
    expect(psql(`select public.coach_title_complete_processing('${claim2.work_id}','${PATIENT_A}','${second}','${claim2.claim_token}','${"x".repeat(41)}')`)).toBe("t");
    expect(psql(`select title from public.patient_chat_conversations where id='${second}'`)).toBe("Coach conversation");

    // Patient rename: version race, validation, owner scope, and precedence over the job.
    const version = Number(psql(`select version from public.patient_chat_conversations where id='${id}'`));
    expect(psql(`select public.coach_conversation_rename('${PATIENT_A}','${id}','   ',${version})`)).toBe("invalid");
    expect(psql(`select public.coach_conversation_rename('${PATIENT_A}','${id}','Burrito night',${version + 5})`)).toBe("conflict");
    expect(psql(`select public.coach_conversation_rename('${PATIENT_B}','${id}','Burrito night',${version})`)).toBe("missing");
    expect(psql(`select public.coach_conversation_rename('${PATIENT_A}','${id}','  Burrito   night ',${version})`)).toBe("ok");
    expect(rows<{ title: string; title_source: string; version: number }>(
      `select title,title_source,version from public.patient_chat_conversations where id='${id}'`))
      .toEqual([{ title: "Burrito night", title_source: "patient", version: version + 1 }]);
    psql(`update public.coach_conversation_work set state='pending' where conversation_id='${id}' and kind='title'`);
    const again = rows<{ work_id: string; claim_token: string }>(
      `select work_id,claim_token from public.coach_title_claim_processing(300) where conversation_id='${id}'`)[0];
    expect(psql(`select public.coach_title_complete_processing('${again.work_id}','${PATIENT_A}','${id}','${again.claim_token}','Model title')`)).toBe("t");
    expect(psql(`select title from public.patient_chat_conversations where id='${id}'`)).toBe("Burrito night");
    expect(psql(`select state from public.coach_conversation_work where id='${again.work_id}'`)).toBe("ready");
    // Leave no memory work behind for the extraction cases below to claim.
    psql(`delete from public.coach_conversation_work where kind='memory' and conversation_id in ('${id}','${second}')`);
  });

  it("never returns pending or pre-extraction sensitive text as historical excerpts", () => {
    const old = psql(`select id from public.coach_conversation_create('${PATIENT_A}','excerpt-old')`);
    const current = psql(`select id from public.coach_conversation_create('${PATIENT_A}','excerpt-current')`);
    psql(`insert into public.patient_chat_messages(conversation_id,client_id,role,text) values
      ('${old}','hiv-source','user','I have HIV'),
      ('${old}','safe-source','user','I prefer salmon')`);
    psql(`insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,source_message_id,source_created_at,topic_key,source_text_hash)
      values('${PATIENT_A}','I prefer salmon','food_preference','sensitive','pending','${old}','safe-source',now(),'pending-salmon',private.coach_memory_topic_key('I prefer salmon'))`);
    expect(psql(`select count(*) from public.coach_historical_excerpts_v2('${PATIENT_A}','${current}',array['hiv'],24)`)).toBe("0");
    expect(psql(`select count(*) from public.coach_historical_excerpts_v2('${PATIENT_A}','${current}',array['salmon'],24)`)).toBe("0");
  });

  it("never stores a 24-character opaque candidate from worker completion", () => {
    const id = psql(`select id from public.coach_conversation_create('${PATIENT_A}','opaque-worker')`);
    const token = "A".repeat(24);
    psql(`select public.coach_conversation_append('${PATIENT_A}','${id}',
      '[{"client_id":"opaque-source","role":"user","text":"${token}"}]'::jsonb)`);
    const work = rows<{ work_id: string; claim_token: string }>(`select * from public.coach_memory_claim_processing(60)`)[0];
    psql(`select public.coach_memory_complete_processing('${work.work_id}','${PATIENT_A}','${id}','${work.claim_token}',
      '[{"sourceMessageId":"opaque-source","text":"${token}","category":"patient_detail","sensitivity":"sensitive","topicKey":"opaque"}]'::jsonb)`);
    expect(psql(`select count(*) from public.coach_memories where text='${token}'`)).toBe("0");
  });

  it("commits an exact ordinary sentence preference from worker extraction", () => {
    const id = psql(`select id from public.coach_conversation_create('${PATIENT_A}','sentence-worker')`);
    psql(`select public.coach_conversation_append('${PATIENT_A}','${id}',
      '[{"client_id":"quick-source","role":"user","text":"I prefer quick meals."}]'::jsonb)`);
    const work = rows<{ work_id: string; claim_token: string }>(`select * from public.coach_memory_claim_processing(60)`)[0];
    psql(`select public.coach_memory_complete_processing('${work.work_id}','${PATIENT_A}','${id}','${work.claim_token}',
      '[{"sourceMessageId":"quick-source","text":"I prefer quick meals.","category":"food_preference","sensitivity":"ordinary","topicKey":"food_preference:prefer:quick-meals"}]'::jsonb)`);
    expect(psql(`select state from public.coach_memories where text='I prefer quick meals.'`)).toBe("active");
  });

  it("keeps suppressed raw sources blocked while intentional active versions remain recallable", () => {
    const sourceConversation = psql(`select id from public.coach_conversation_create('${PATIENT_A}','restore-source')`);
    const currentConversation = psql(`select id from public.coach_conversation_create('${PATIENT_A}','restore-current')`);
    psql(`insert into public.patient_chat_messages(conversation_id,client_id,role,text) values
      ('${sourceConversation}','restore-source','user','I prefer salmon')`);
    psql(`insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,source_message_id,source_created_at,topic_key,source_text_hash)
      values('${PATIENT_A}','I prefer salmon','food_preference','ordinary','active','${sourceConversation}','restore-source',now(),'restore-salmon',private.coach_memory_topic_key('I prefer salmon'))`);
    const original = rows<{ id: string; version: number }>(`select id,version from public.coach_memories where topic_key='restore-salmon'`)[0];
    expect(psql(`select (public.coach_memory_mutate('${PATIENT_A}','${original.id}','forget',${original.version},null)).state`)).toBe("removed");
    expect(psql(`select count(*) from public.coach_memory_recall('${PATIENT_A}','${currentConversation}',24) where text='I prefer salmon'`)).toBe("0");
    expect(psql(`select count(*) from public.coach_historical_excerpts_v2('${PATIENT_A}','${currentConversation}',array['salmon'],24)`)).toBe("0");
    const removed = rows<{ version: number }>(`select version from public.coach_memories where id='${original.id}'`)[0];
    expect(psql(`select (public.coach_memory_mutate('${PATIENT_A}','${original.id}','approve',${removed.version},null)).state`)).toBe("active");
    expect(psql(`select count(*) from public.coach_memory_recall('${PATIENT_A}','${currentConversation}',24) where id='${original.id}'`)).toBe("1");
    expect(psql(`select count(*) from public.coach_historical_excerpts_v2('${PATIENT_A}','${currentConversation}',array['salmon'],24)`)).toBe("0");
    const restored = rows<{ version: number }>(`select version from public.coach_memories where id='${original.id}'`)[0];
    const replacementId = psql(`select (public.coach_memory_mutate('${PATIENT_A}','${original.id}','correct',${restored.version},'I prefer simple meals.')).id`);
    expect(psql(`select count(*) from public.coach_memory_recall('${PATIENT_A}','${currentConversation}',24) where id='${original.id}'`)).toBe("0");
    expect(psql(`select count(*) from public.coach_memory_recall('${PATIENT_A}','${currentConversation}',24) where id='${replacementId}' and text='I prefer simple meals.'`)).toBe("1");
    expect(psql(`select count(*) from public.coach_historical_excerpts_v2('${PATIENT_A}','${currentConversation}',array['salmon'],24)`)).toBe("0");
  });
});