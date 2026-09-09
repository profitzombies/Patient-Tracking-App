import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  "20261007010000_care_team_read_metrics.sql",
  "20261007020000_care_team_workflow_guards.sql",
  "20261007030000_care_team_workflow_lock_order.sql",
];
const migrations = migrationNames.map((name) =>
  path.resolve(here, "../../../../supabase/migrations", name),
);
const available = ["initdb", "pg_ctl", "psql"].every(
  (name) => spawnSync("which", [name], { stdio: "ignore" }).status === 0,
);
if (!available) console.warn("care-team.sql.test: PostgreSQL binaries unavailable — skipped");

let dir = "";
let data = "";
const port = 55_400 + (process.pid % 500);
const args = () => [
  "-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
  "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1",
];
const sql = (statement: string) =>
  execFileSync("psql", [...args(), "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PATIENT = id(1);
const STAFF = id(2);
const TEAM_STAFF = id(3);
const HQ_STAFF = id(4);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function concurrentSql(applicationName: string, statement: string) {
  const child = spawn("psql", [...args(), "-c", `set application_name='${applicationName}'; ${statement}`], {
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
  return { child, done };
}

async function waitForActivity(applicationName: string, waitEventType?: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const condition = waitEventType ? `and wait_event_type='${waitEventType}'` : "";
    if (sql(`select count(*) from pg_stat_activity where application_name='${applicationName}' ${condition}`) === "1") return;
    await sleep(20);
  }
  throw new Error(`${applicationName} never reached ${waitEventType ?? "pg_stat_activity"}`);
}

function patientValues(patientId: string, provider = "a", activation = "activated", auth: string | null = null) {
  const suffix = patientId.slice(-4);
  return `('${patientId}','${provider}',${auth ? `'${auth}'` : "null"},'Pat','${suffix}',null,
    'person-${suffix}@example.test','+1555000${suffix}','${activation}',null,null,now(),null,null,null,
    'thinnr','2026-06-01')`;
}

function consent(patientId: string) {
  sql(`insert into patient_consents(patient_id,policy_version,terms_accepted,privacy_accepted,health_data_accepted)
    values('${patientId}','2026-09-01',true,true,true)`);
}

describe.skipIf(!available)("business care-team migration on PostgreSQL", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "care-team-pg-"));
    data = path.join(dir, "data");
    execFileSync("initdb", ["-D", data, "-A", "trust", "-U", "postgres"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", data, "-o", `-k ${dir} -p ${port} -F`, "-w", "start"],
      { stdio: "ignore" },
    );
    sql(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema private;
      create table auth.users(id uuid primary key,phone text,raw_app_meta_data jsonb default '{}');
      create function auth.role() returns text language sql stable as
        $$select current_setting('test.role',true)$$;
      alter database postgres set test.role='service_role';
      create table providers(provider_id text primary key,provider_name text,office_name text,
        auth_user_id uuid,access_disabled boolean default false);
      create table patients(
        id uuid primary key,provider_id text not null references providers,
        auth_user_id uuid,first_name text,last_name text,name text,email text,phone text,
        activation_status text,claimed_at timestamptz,invited_at timestamptz,
        created_at timestamptz default now(),archived_at timestamptz,
        archived_into_patient_id uuid references patients,identity_reconciliation_id uuid,
        program_id text,program_start_date date);
      create table profiles(id uuid primary key,role text);
      create table patient_media(object_path text primary key,patient_id uuid not null references patients on delete cascade,
        kind text not null default 'food');
      create table patient_progress_photos(patient_id uuid not null references patients on delete cascade,
        photo_id text,object_path text,primary key(patient_id,photo_id));
      create table patient_custom_foods(patient_id uuid not null references patients on delete cascade,
        food_id text,photo_path text,primary key(patient_id,food_id));
      create table patient_saved_recipes(patient_id uuid not null references patients on delete cascade,
        recipe_id text,photo_path text,primary key(patient_id,recipe_id));
      create table analytics_events(id bigint generated always as identity primary key,
        patient_id uuid references patients on delete set null,provider_id text,kind text);
      create function public.reject_operational_event_mutation() returns trigger language plpgsql as
        $$begin raise exception 'operational event tables are append-only'; end$$;
      create trigger analytics_events_append_only before update or delete on analytics_events
        for each row execute function reject_operational_event_mutation();
      create table patient_notifications(
        id uuid primary key default gen_random_uuid(),patient_id uuid not null references patients on delete cascade,
        kind text,category text constraint patient_notifications_category_check
          check(category in('coach_outreach','check_in_reminders','office_reminders')),
        title text,body text,data jsonb,dedupe_key text unique,scheduled_at timestamptz default now(),
        expires_at timestamptz default now()+interval '3 day',status text default 'queued',attempts int default 0,
        next_attempt_at timestamptz default now(),created_at timestamptz default now(),updated_at timestamptz default now());
      create table provider_account_locks(account_id text primary key);
      create table team_members(id uuid default gen_random_uuid(),provider_id text,
        auth_user_id uuid,activation_status text);
      create table hq_memberships(id uuid default gen_random_uuid(),auth_user_id uuid,status text);
      create function private.provider_account_is_locked(text) returns boolean language sql as
        $$select exists(select 1 from public.provider_account_locks where regexp_replace(account_id,'^acct-','')=$1)$$;
      insert into providers values
        ('a','Dr A','Office A','${STAFF}',false),('b','Dr B','Office B',null,false);
      insert into team_members(provider_id,auth_user_id,activation_status)
        values('a','${TEAM_STAFF}','active');
      insert into hq_memberships(auth_user_id,status) values('${HQ_STAFF}','active');
      insert into patients values ${patientValues(PATIENT, "a", "activated", id(900))};
    `);
    sql(`insert into auth.users(id) values('${id(900)}')`);
    for (const migration of migrations) {
      execFileSync("psql", [...args(), "-f", migration], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    }
    consent(PATIENT);
    // Reconciliation is an exceptional reviewed operation. Drop only the
    // admission indexes so this suite can create collision fixtures after the
    // canonical migrations have installed the real reconciliation functions.
    sql(`drop index patients_email_normalized_unique_idx;
      drop index patients_phone_normalized_unique_idx;`);
  }, 60_000);

  afterAll(() => {
    if (data) spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("serializes truly concurrent patient/office starts to one conversation", async () => {
    const holder = concurrentSql("care-start-holder",
      `begin; select care_team_start('${PATIENT}','a'); select pg_sleep(1); commit;`);
    await waitForActivity("care-start-holder", "Timeout");
    const rival = concurrentSql("care-start-rival", `select care_team_start('${PATIENT}','a')`);
    await waitForActivity("care-start-rival", "Lock");
    const [first, second] = await Promise.all([holder.done, rival.done]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const results = [first.stdout, second.stdout].map((output) =>
      JSON.parse(output.split("\n").find((line) => line.startsWith("{"))!),
    );
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.conversationId)).size).toBe(1);
    expect(sql(`select count(*) from patient_chat_conversations
      where patient_id='${PATIENT}' and thread='care_team'`)).toBe("1");
  });

  it("serializes a concurrent same-client conflict and commits exactly one body", async () => {
    const conversation = sql(`select id from patient_chat_conversations
      where patient_id='${PATIENT}' and thread='care_team'`);
    const holder = concurrentSql("care-send-holder", `begin;
      select care_team_send('${conversation}','${PATIENT}','a','concurrent-client','first','user',null,null,false);
      select pg_sleep(1); commit;`);
    await waitForActivity("care-send-holder", "Timeout");
    const rival = concurrentSql("care-send-rival",
      `select care_team_send('${conversation}','${PATIENT}','a','concurrent-client','different','user',null,null,false)`);
    await waitForActivity("care-send-rival", "Lock");
    const [first, second] = await Promise.all([holder.done, rival.done]);
    expect(first.status).toBe(0);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/client id payload conflict/);
    expect(sql(`select count(*)||'|'||min(text) from patient_chat_messages
      where conversation_id='${conversation}' and client_id='concurrent-client'`)).toBe("1|first");
  });

  it("keeps patient_chat_apply executable after replacing full uniqueness with partial indexes", () => {
    sql(`select patient_chat_apply('${PATIENT}','coach',
      '[{"client_id":"ai-user","role":"user","text":"kept"}]')`);
    sql(`select patient_chat_apply('${PATIENT}','coach',
      '[{"client_id":"ai-user","role":"user","text":"updated"}]')`);
    expect(sql(`select count(*)||'|'||min(text) from patient_chat_messages where client_id='ai-user'`))
      .toBe("1|updated");
    expect(() => sql(`select patient_chat_apply('${PATIENT}','care_team','[]')`)).toThrow(/invalid thread/);
    sql(`insert into provider_account_locks(account_id) values('acct-a')`);
    expect(() => sql(`select patient_chat_apply('${PATIENT}','coach','[]')`)).toThrow(/office locked/);
    sql(`delete from provider_account_locks where account_id='acct-a'`);
    sql(`update patients set deletion_requested_at=now() where id='${PATIENT}'`);
    expect(() => sql(`select patient_chat_apply('${PATIENT}','coach','[]')`)).toThrow(/patient unavailable/);
    sql(`update patients set deletion_requested_at=null where id='${PATIENT}'`);
  });

  it("preserves workflow assignment, reopens on a new patient seq, and keeps explicit read high-water marks", () => {
    const conversation = sql(`select id from patient_chat_conversations
      where patient_id='${PATIENT}' and thread='care_team'`);
    const staff = JSON.parse(sql(`select care_team_send('${conversation}','${PATIENT}','a',
      'workflow-staff','reply','staff','${STAFF}','Internal Name',false)`));
    sql(`select patient_chat_workflow_mutate('${conversation}','a','${STAFF}','office',
      'assign','{"assigneeUserId":"${STAFF}","assigneeLabel":"Assigned"}');
      select patient_chat_workflow_mutate('${conversation}','a','${STAFF}','office',
      'status','{"status":"closed"}')`);
    expect(JSON.parse(sql(`select care_team_staff_read('${conversation}','${STAFF}',${staff.seq})`)))
      .toMatchObject({ changed: true, lastReadSeq: staff.seq });
    const patient = JSON.parse(sql(`select care_team_send('${conversation}','${PATIENT}','a',
      'workflow-patient','new question','user',null,null,false)`));
    expect(sql(`select status||'|'||assignee_user_id||'|'||last_patient_seq
      from patient_chat_conversations where id='${conversation}'`))
      .toBe(`open|${STAFF}|${patient.seq}`);
    expect(sql(`select last_read_seq from patient_chat_read_markers
      where conversation_id='${conversation}' and staff_user_id='${STAFF}'`)).toBe(String(staff.seq));
    expect(sql(`select unread::text from patient_chat_inbox_list(
      'a','${STAFF}',array['care_team']) where id='${conversation}'`)).toBe("true");
  });

  it("orders overlapping workflow and send locks so both complete without deadlock", async () => {
    const conversation = sql(`select id from patient_chat_conversations
      where patient_id='${PATIENT}' and thread='care_team'`);
    const send = concurrentSql("care-order-send", `begin;
      select care_team_send('${conversation}','${PATIENT}','a',
        'lock-order-message','ordered','user',null,null,false);
      select pg_sleep(1); commit;`);
    await waitForActivity("care-order-send", "Timeout");
    const workflow = concurrentSql("care-order-workflow",
      `select patient_chat_workflow_mutate('${conversation}','a','${STAFF}','office',
        'status','{"status":"closed"}')`);
    await waitForActivity("care-order-workflow", "Lock");
    const [sent, mutated] = await Promise.all([send.done, workflow.done]);
    expect(sent.status).toBe(0);
    expect(mutated.status).toBe(0);
    expect(mutated.stderr).not.toMatch(/deadlock/i);
    expect(sql(`select count(*) from patient_chat_messages
      where conversation_id='${conversation}' and client_id='lock-order-message'`)).toBe("1");
    expect(sql(`select status from patient_chat_conversations where id='${conversation}'`)).toBe("closed");
  });

  it("takes the patient barrier before the conversation row used by send", async () => {
    const conversation = sql(`select id from patient_chat_conversations
      where patient_id='${PATIENT}' and thread='care_team'`);
    const identityHolder = concurrentSql("care-identity-order-holder", `begin;
      select pg_advisory_xact_lock(hashtextextended('${PATIENT}',40421001));
      select pg_sleep(1); commit;`);
    await waitForActivity("care-identity-order-holder", "Timeout");
    const workflow = concurrentSql("care-identity-order-workflow",
      `select patient_chat_workflow_mutate('${conversation}','a','${STAFF}','office',
        'status','{"status":"open"}')`);
    await waitForActivity("care-identity-order-workflow", "Lock");
    // A workflow waiting on the shared patient barrier must not already hold
    // the conversation row, otherwise it inverts care_team_send's lock order.
    expect(() => sql(`begin; select 1 from patient_chat_conversations
      where id='${conversation}' for update nowait; rollback`)).not.toThrow();
    const [identity, mutation] = await Promise.all([identityHolder.done, workflow.done]);
    expect(identity.status).toBe(0);
    expect(mutation.status).toBe(0);
    expect(mutation.stderr).not.toMatch(/deadlock/i);
  });

  it("holds the office advisory lock while waiting on actor authorization", async () => {
    const conversation = sql(`select id from patient_chat_conversations
      where patient_id='${PATIENT}' and thread='care_team'`);
    const actorHolder = concurrentSql("care-actor-holder", `begin;
      select 1 from team_members where provider_id='a' and auth_user_id='${TEAM_STAFF}' for update;
      select pg_sleep(1); commit;`);
    await waitForActivity("care-actor-holder", "Timeout");
    const workflow = concurrentSql("care-actor-workflow",
      `select patient_chat_workflow_mutate('${conversation}','a','${TEAM_STAFF}','office',
        'status','{"status":"open"}')`);
    await waitForActivity("care-actor-workflow", "Lock");
    const officeLock = concurrentSql("care-office-lock",
      `insert into provider_account_locks(account_id) values('acct-a')`);
    // The workflow must already own the office advisory lock even though its
    // actor row is blocked, so a lock activation cannot commit underneath it.
    let officeWasBlocked = true;
    try {
      await waitForActivity("care-office-lock", "Lock");
    } catch {
      officeWasBlocked = false;
    }
    const [actor, mutation, locked] = await Promise.all([
      actorHolder.done, workflow.done, officeLock.done,
    ]);
    sql(`delete from provider_account_locks where account_id='acct-a'`);
    expect(officeWasBlocked).toBe(true);
    expect(actor.status).toBe(0);
    expect(mutation.status).toBe(0);
    expect(locked.status).toBe(0);
    expect(sql(`select status from patient_chat_conversations where id='${conversation}'`)).toBe("open");
    expect(locked.stderr).toBe("");
  });

  it("allows HQ to self-assign AI workflow but keeps human workflow read-only", () => {
    const aiConversation = sql(`select id from patient_chat_conversations
      where patient_id='${PATIENT}' and thread='coach'`);
    const humanConversation = sql(`select id from patient_chat_conversations
      where patient_id='${PATIENT}' and thread='care_team'`);
    expect(JSON.parse(sql(`select patient_chat_workflow_mutate(
      '${aiConversation}','a','${HQ_STAFF}','hq','assign',
      '{"assigneeUserId":"${HQ_STAFF}","assigneeLabel":"HQ reviewer"}')`)))
      .toEqual({ ok: true });
    expect(sql(`select assignee_user_id||'|'||assignee_label
      from patient_chat_conversations where id='${aiConversation}'`))
      .toBe(`${HQ_STAFF}|HQ reviewer`);
    expect(() => sql(`select patient_chat_workflow_mutate(
      '${humanConversation}','a','${HQ_STAFF}','hq','assign',
      '{"assigneeUserId":"${HQ_STAFF}","assigneeLabel":"HQ reviewer"}')`))
      .toThrow(/HQ human workflow is read only/);
  });

  it("serializes first reads, reports one change, stays monotonic, and clamps to committed seq", async () => {
    const readerPatient = id(40);
    sql(`insert into patients values ${patientValues(readerPatient)};
      insert into patient_consents(patient_id,policy_version,terms_accepted,privacy_accepted,health_data_accepted)
        values('${readerPatient}','2026-09-01',true,true,true);
      select care_team_start('${readerPatient}','a')`);
    const conversation = sql(`select id from patient_chat_conversations
      where patient_id='${readerPatient}' and thread='care_team'`);
    sql(`insert into patient_chat_messages(conversation_id,client_id,role,text)
      select '${conversation}','read-'||g,'user','m'||g from generate_series(1,120) g`);
    const committedMax = Number(sql(`select max(seq) from patient_chat_messages
      where conversation_id='${conversation}'`));
    const sameSeq = 100;
    expect(committedMax).toBeGreaterThan(100);

    const holder = concurrentSql("care-read-holder", `begin;
      select care_team_patient_read('${conversation}','${readerPatient}',${sameSeq});
      select pg_sleep(1); commit;`);
    await waitForActivity("care-read-holder", "Timeout");
    const rival = concurrentSql("care-read-rival",
      `select care_team_patient_read('${conversation}','${readerPatient}',${sameSeq})`);
    await waitForActivity("care-read-rival", "Lock");
    const [first, second] = await Promise.all([holder.done, rival.done]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const reads = [first.stdout, second.stdout].map((output) =>
      JSON.parse(output.split("\n").find((line) => line.startsWith("{"))!),
    );
    expect(reads.filter((read) => read.changed)).toHaveLength(1);
    expect(reads.every((read) => read.lastReadSeq === sameSeq)).toBe(true);

    const backwards = JSON.parse(sql(`select care_team_patient_read(
      '${conversation}','${readerPatient}',50)`));
    const clamped = JSON.parse(sql(`select care_team_patient_read(
      '${conversation}','${readerPatient}',9223372036854775807)`));
    expect(backwards).toEqual({ changed: false, lastReadSeq: 100 });
    expect(clamped).toEqual({ changed: true, lastReadSeq: committedMax });
    expect(sql(`select last_read_seq from patient_chat_patient_read_markers
      where conversation_id='${conversation}' and patient_id='${readerPatient}'`))
      .toBe(String(committedMax));

    const staffHolder = concurrentSql("care-staff-read-holder", `begin;
      select care_team_staff_read('${conversation}','${STAFF}',100);
      select pg_sleep(1); commit;`);
    await waitForActivity("care-staff-read-holder", "Timeout");
    const staffRival = concurrentSql("care-staff-read-rival",
      `select care_team_staff_read('${conversation}','${STAFF}',100)`);
    await waitForActivity("care-staff-read-rival", "Lock");
    const staffResults = await Promise.all([staffHolder.done, staffRival.done]);
    expect(staffResults.every((result) => result.status === 0)).toBe(true);
    const staffReads = staffResults.map((result) =>
      JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("{"))!),
    );
    expect(staffReads.filter((read) => read.changed)).toHaveLength(1);
    expect(staffReads.every((read) => read.lastReadSeq === 100)).toBe(true);
  });

  it("executes public RPCs as service_role without private-schema or table grants", () => {
    const body = sql(`set role service_role;
      select (care_team_patient_bootstrap('${PATIENT}')).office_name;
      select (patient_chat_inbox_metrics('a',null,array['care_team'])).open_threads;
      reset role`);
    expect(body).toMatch(/Office A/);
    expect(body).toMatch(/\d/);
  });

  it("keeps care-team metrics with the old owner while AI metrics follow a transfer", () => {
    const transferred = id(50);
    const total = (provider: string, threads: string) =>
      Number(sql(`select open_threads+waiting_threads+closed_threads
        from patient_chat_inbox_metrics('${provider}',null,array[${threads}])`));
    const before = {
      aCare: total("a", "'care_team'"),
      bCare: total("b", "'care_team'"),
      aAi: total("a", "'coach','support'"),
      bAi: total("b", "'coach','support'"),
    };
    sql(`insert into patients values ${patientValues(transferred)};
      insert into patient_consents(patient_id,policy_version,terms_accepted,privacy_accepted,health_data_accepted)
        values('${transferred}','2026-09-01',true,true,true);
      select care_team_start('${transferred}','a');
      select patient_chat_apply('${transferred}','coach','[]');
      update patients set provider_id='b' where id='${transferred}'`);
    expect(total("a", "'care_team'")).toBe(before.aCare + 1);
    expect(total("b", "'care_team'")).toBe(before.bCare);
    expect(total("a", "'coach','support'")).toBe(before.aAi);
    expect(total("b", "'coach','support'")).toBe(before.bAi + 1);
  });

  it("rolls back a same-office reconciliation collision without changing either owner or transcript", () => {
    const canonical = id(10);
    const duplicate = id(11);
    sql(`insert into patients values
      ${patientValues(canonical, "a", "activated", id(910))},
      ${patientValues(duplicate, "a", "invited")};
      update patients set email='collision@example.test',phone='+15551234567'
        where id in('${canonical}','${duplicate}');
      insert into patient_consents(patient_id,policy_version,terms_accepted,privacy_accepted,health_data_accepted)
        select id,'2026-09-01',true,true,true from patients where id in('${canonical}','${duplicate}');
      select care_team_start('${canonical}','a'); select care_team_start('${duplicate}','a');
      delete from patient_consents where patient_id='${duplicate}';`);
    const before = sql(`select string_agg(id||':'||patient_id||':'||provider_id,',' order by patient_id)
      from patient_chat_conversations where patient_id in('${canonical}','${duplicate}') and thread='care_team'`);
    expect(() => sql(`select private.reconcile_invited_patient_duplicate(
      '${canonical}','${duplicate}','reviewed duplicate identity',null)`)).toThrow(/unique|duplicate/i);
    expect(sql(`select string_agg(id||':'||patient_id||':'||provider_id,',' order by patient_id)
      from patient_chat_conversations where patient_id in('${canonical}','${duplicate}') and thread='care_team'`)).toBe(before);
    expect(sql(`select activation_status||'|'||(archived_at is null)::text
      from patients where id='${duplicate}'`)).toBe("invited|true");
    expect(sql(`select count(*) from private.patient_identity_reconciliation_audit
      where archived_patient_id='${duplicate}'`)).toBe("0");
  });

  it("uses the real identity lock during reconciliation and retains a non-colliding human transcript", async () => {
    const canonical = id(20);
    const duplicate = id(21);
    sql(`insert into patients values
      ${patientValues(canonical, "a", "activated", id(920))},
      ${patientValues(duplicate, "a", "invited")};
      update patients set email='retained@example.test',phone='+15557654321'
        where id in('${canonical}','${duplicate}');
      insert into patient_consents(patient_id,policy_version,terms_accepted,privacy_accepted,health_data_accepted)
        select id,'2026-09-01',true,true,true from patients where id in('${canonical}','${duplicate}');
      select care_team_start('${duplicate}','a');`);
    const conversation = sql(`select id from patient_chat_conversations
      where patient_id='${duplicate}' and thread='care_team'`);
    sql(`select care_team_send('${conversation}','${duplicate}','a',
      'retained-message','history','user',null,null,false);
      delete from patient_consents where patient_id='${duplicate}'`);

    const reconciliation = concurrentSql("care-reconcile-holder", `begin;
      select private.reconcile_invited_patient_duplicate(
        '${canonical}','${duplicate}','reviewed duplicate identity',null);
      select pg_sleep(1); commit;`);
    await waitForActivity("care-reconcile-holder", "Timeout");
    const lateStart = concurrentSql("care-reconcile-writer",
      `select care_team_start('${duplicate}','a')`);
    await waitForActivity("care-reconcile-writer", "Lock");
    const [reconciled, writer] = await Promise.all([reconciliation.done, lateStart.done]);
    expect(reconciled.status).toBe(0);
    expect(writer.status).not.toBe(0);
    expect(writer.stderr).toMatch(/patient unavailable/);
    expect(sql(`select patient_id||'|'||provider_id from patient_chat_conversations
      where id='${conversation}'`)).toBe(`${canonical}|a`);
    expect(sql(`select count(*)||'|'||min(text) from patient_chat_messages
      where conversation_id='${conversation}'`)).toBe("1|history");
    expect(sql(`select activation_status||'|'||(archived_into_patient_id='${canonical}')::text
      from patients where id='${duplicate}'`)).toBe("disabled|true");
  });

  it("uses the same identity barrier during purge and rejects a waiting dependent write", async () => {
    const purgePatient = id(30);
    sql(`insert into patients values ${patientValues(purgePatient, "a", "activated", id(930))}`);
    consent(purgePatient);
    const request = sql(`select id from patient_deletion_request('${purgePatient}',0)`);
    sql(`select id from claim_due_patient_deletions('care-team-test',5,600)
      where id='${request}'`);
    const purge = concurrentSql("care-purge-holder",
      `begin; select patient_purge_rows('${request}'); select pg_sleep(1); commit;`);
    await waitForActivity("care-purge-holder", "Timeout");
    const lateWrite = concurrentSql("care-purge-writer",
      `insert into patient_consents(patient_id,policy_version,terms_accepted,privacy_accepted,health_data_accepted)
       values('${purgePatient}','late',true,true,true)`);
    await waitForActivity("care-purge-writer", "Lock");
    const [purged, writer] = await Promise.all([purge.done, lateWrite.done]);
    expect(purged.status).toBe(0);
    expect(writer.status).not.toBe(0);
    expect(writer.stderr).toMatch(/unknown patient/);
    expect(sql(`select count(*) from patients where id='${purgePatient}'`)).toBe("0");
    expect(sql(`select count(*) from patient_consents where patient_id='${purgePatient}'`)).toBe("0");
    expect(sql(`select count(*) from patient_tombstones where id='${purgePatient}'`)).toBe("1");
  });
});