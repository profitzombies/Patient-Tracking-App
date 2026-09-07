/**
 * The staff-inbox migration, run for real.
 *
 * The workflow trigger (patient message → open + awaiting, staff reply →
 * waiting_patient + response accumulators), the inbox list RPC (filters,
 * unread per staff member, search escaping, sorts, window total) and the
 * metrics RPC are SQL a mock cannot prove. This suite boots a throwaway
 * PostgreSQL cluster, applies the canonical migration verbatim over a
 * minimal mirror of the chat tables, and asserts the contract the API
 * routes and the operations inbox rely on. Skips loudly without binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260928000000_staff_inbox.sql");
const AUTO_CLOSE_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260928200000_staff_inbox_auto_close.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("staff-inbox.sql.test: PostgreSQL binaries not on PATH — suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.providers (provider_id text primary key, access_disabled boolean default false);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  first_name text, last_name text, name text);
create table public.patient_chat_conversations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  thread text not null check (thread in ('coach', 'support')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (patient_id, thread));
create table public.patient_chat_messages (
  conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade,
  client_id text not null,
  seq bigint generated always as identity,
  role text not null check (role in ('user', 'assistant')),
  text text not null default '',
  stopped boolean not null default false,
  hidden boolean not null default false,
  card jsonb, quick_replies jsonb, reply_to_client_id text, photo jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, client_id));
`;

let dir = "";
let dataDir = "";
const PORT = 54_900 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];

function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8" });
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STAFF_A = uuid(901);
const STAFF_B = uuid(902);
const T0 = "2026-09-01 10:00:00+00";

function addMessage(conversationId: string, clientId: string, role: string, text: string, at: string, sender?: string) {
  const senderCols = sender ? `, sender_user_id, sender_label` : "";
  const senderVals = sender ? `, '${STAFF_A}', '${sender}'` : "";
  psql(
    `insert into public.patient_chat_messages (conversation_id, client_id, role, text, created_at, updated_at${senderCols})
     values ('${conversationId}', '${clientId}', '${role}', '${text.replace(/'/g, "''")}', '${at}', '${at}'${senderVals})`,
  );
}
function conversation(id: string) {
  return rows<{
    status: string; awaiting_since: string | null; last_patient_seq: number | null;
    response_ms_total: number; response_count: number; last_staff_reply_at: string | null;
  }>(`select status, awaiting_since, last_patient_seq, response_ms_total, response_count, last_staff_reply_at
      from public.patient_chat_conversations where id = '${id}'`)[0];
}
type InboxRow = { id: string; patient_name: string; thread: string; status: string; auto_closed: boolean; unread: boolean; preview: string; total: number; note_count: number; open_escalation_department: string | null };
function inbox(args: string): InboxRow[] {
  return rows<InboxRow>(`select * from public.patient_chat_inbox_list(${args})`);
}
type Metrics = { open_threads: number; waiting_threads: number; closed_threads: number; unanswered_threads: number; avg_response_minutes: string | null; open_escalations: number };
const metrics = (provider: string | null, extra = "") =>
  rows<Metrics>(`select * from public.patient_chat_inbox_metrics(${provider === null ? "null" : `'${provider}'`}${extra})`)[0];

const CONV_ANNA = uuid(1);
const CONV_ANNA_SUPPORT = uuid(2);
const CONV_BEN = uuid(3);
const CONV_OTHER = uuid(4);

describe.skipIf(!POSTGRES_AVAILABLE)("staff inbox migration (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "inbox-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    const child = spawn("pg_ctl", ["-D", dataDir, "-o", `-p ${PORT} -k ${dir} -c listen_addresses=''`, "-w", "start"], { stdio: "ignore" });
    const started = spawnSync("bash", ["-c", `for i in $(seq 1 60); do pg_isready -h ${dir} -p ${PORT} -q && exit 0; sleep 0.25; done; exit 1`]);
    child.unref();
    if (started.status !== 0) throw new Error("temporary PostgreSQL did not start");
    psql(SCHEMA);
    // Pre-migration transcript to prove the backfill.
    psql(`insert into public.providers (provider_id) values ('office-a'), ('office-b'), ('office-off')`);
    psql(`update public.providers set access_disabled = true where provider_id = 'office-off'`);
    psql(`insert into public.patients (id, provider_id, first_name, last_name) values
      ('${uuid(11)}', 'office-a', 'Anna', 'O''Neil'),
      ('${uuid(12)}', 'office-a', 'Ben', 'Reyes'),
      ('${uuid(13)}', 'office-b', 'Cara', 'Diaz')`);
    psql(`insert into public.patient_chat_conversations (id, patient_id, thread, created_at, updated_at) values
      ('${CONV_ANNA}', '${uuid(11)}', 'coach', '${T0}', '${T0}')`);
    addMessage(CONV_ANNA, "greeting", "assistant", "Welcome back Anna", "2026-09-01 10:00:00+00");
    addMessage(CONV_ANNA, "u1", "user", "Can I have 100% pasta tonight?", "2026-09-01 10:05:00+00");
    execFileSync("psql", [...PSQL_ARGS(), "-f", MIGRATION], { encoding: "utf8" });
    execFileSync("psql", [...PSQL_ARGS(), "-f", AUTO_CLOSE_MIGRATION], { encoding: "utf8" });
  });

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies verbatim, backfills existing transcripts, and locks the objects to the service role", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("patient_chat_inbox_list");
    const c = conversation(CONV_ANNA);
    expect(c.status).toBe("open");
    expect(c.last_patient_seq).toBe(2);
    expect(c.awaiting_since).not.toBeNull();
    for (const fn of ["patient_chat_inbox_list", "patient_chat_inbox_metrics"]) {
      const grants = rows<{ grantee: string }>(
        `select grantee from information_schema.routine_privileges where routine_name = '${fn}' and privilege_type = 'EXECUTE'`,
      ).map((r) => r.grantee);
      expect(grants).toContain("service_role");
      expect(grants).not.toContain("anon");
      expect(grants).not.toContain("authenticated");
    }
    for (const table of ["patient_chat_read_markers", "patient_chat_notes", "patient_chat_escalations"]) {
      expect(rows<{ rls: boolean }>(`select relrowsecurity rls from pg_class where relname = '${table}'`)[0].rls).toBe(true);
      expect(rows(`select 1 from information_schema.table_privileges where table_name = '${table}' and grantee in ('anon','authenticated')`)).toEqual([]);
    }
  });

  it("runs the state machine from the message trigger and accumulates response time", () => {
    // Staff reply 10 minutes after the patient's open question.
    addMessage(CONV_ANNA, "staff-1", "staff", "Pasta is not on plan this phase, try the zucchini option.", "2026-09-01 10:15:00+00", "Dr. Ellis");
    let c = conversation(CONV_ANNA);
    expect(c.status).toBe("waiting_patient");
    expect(c.awaiting_since).toBeNull();
    expect(c.response_count).toBe(1);
    expect(c.response_ms_total).toBe(10 * 60_000);
    expect(c.last_staff_reply_at).not.toBeNull();
    // The coach AI answering changes nothing.
    addMessage(CONV_ANNA, "a2", "assistant", "Here is a zucchini recipe.", "2026-09-01 10:16:00+00");
    expect(conversation(CONV_ANNA).status).toBe("waiting_patient");
    // Patient answers: back to open, awaiting stretch restarts at THIS message.
    addMessage(CONV_ANNA, "u2", "user", "Thanks, will do", "2026-09-01 11:00:00+00");
    c = conversation(CONV_ANNA);
    expect(c.status).toBe("open");
    expect(c.awaiting_since).toBe("2026-09-01T11:00:00+00:00");
    expect(c.last_patient_seq).toBe(5);
    // A second patient message keeps the ORIGINAL awaiting start.
    addMessage(CONV_ANNA, "u3", "user", "Also can I swap lunch?", "2026-09-01 11:30:00+00");
    expect(conversation(CONV_ANNA).awaiting_since).toBe("2026-09-01T11:00:00+00:00");
    // Closed by staff, then the patient writes again: reopened.
    psql(`update public.patient_chat_conversations set status = 'closed' where id = '${CONV_ANNA}'`);
    addMessage(CONV_ANNA, "u4", "user", "One more thing", "2026-09-01 12:00:00+00");
    expect(conversation(CONV_ANNA).status).toBe("open");
    // Staff reply on a closed thread moves it to waiting_patient too (60 min stretch).
    psql(`update public.patient_chat_conversations set status = 'closed' where id = '${CONV_ANNA}'`);
    addMessage(CONV_ANNA, "staff-2", "staff", "Yes, swap lunch for the salad.", "2026-09-01 12:00:00+00", "Dr. Ellis");
    c = conversation(CONV_ANNA);
    expect(c.status).toBe("waiting_patient");
    expect(c.response_count).toBe(2);
    expect(c.response_ms_total).toBe(70 * 60_000);
    // Re-upserting an existing row (outbox retry) does not fire the insert trigger.
    psql(`insert into public.patient_chat_messages (conversation_id, client_id, role, text) values ('${CONV_ANNA}', 'u4', 'user', 'One more thing (edited)')
          on conflict (conversation_id, client_id) do update set text = excluded.text`);
    expect(conversation(CONV_ANNA).status).toBe("waiting_patient");
  });

  it("rejects staff rows without a sender", () => {
    expect(() => addMessage(CONV_ANNA, "staff-bad", "staff", "anonymous", "2026-09-01 13:00:00+00")).toThrow();
  });

  it("lists the office inbox with per-staff unread state, filters, search, and sorting", () => {
    psql(`insert into public.patient_chat_conversations (id, patient_id, thread, created_at, updated_at) values
      ('${CONV_ANNA_SUPPORT}', '${uuid(11)}', 'support', '2026-09-02 09:00:00+00', '2026-09-02 09:00:00+00'),
      ('${CONV_BEN}', '${uuid(12)}', 'coach', '2026-09-03 09:00:00+00', '2026-09-03 09:00:00+00'),
      ('${CONV_OTHER}', '${uuid(13)}', 'coach', '2026-09-03 09:00:00+00', '2026-09-03 09:00:00+00')`);
    addMessage(CONV_ANNA_SUPPORT, "s-u1", "user", "The app logged me out", "2026-09-02 09:01:00+00");
    addMessage(CONV_BEN, "b-u1", "user", "Is 50_percent yogurt allowed", "2026-09-03 09:01:00+00");
    addMessage(CONV_BEN, "b-a1", "assistant", "Plain yogurt is on the approved list.", "2026-09-03 09:02:00+00");
    addMessage(CONV_OTHER, "o-u1", "user", "pasta question from another office", "2026-09-03 09:05:00+00");

    const all = inbox(`'office-a', '${STAFF_A}'`);
    expect(all.map((r) => r.id)).toEqual([CONV_BEN, CONV_ANNA_SUPPORT, CONV_ANNA]);
    expect(all[0].total).toBe(3);
    expect(all.find((r) => r.id === CONV_OTHER)).toBeUndefined();
    expect(all[0].patient_name).toBe("Ben Reyes");
    expect(all[0].preview).toBe("Plain yogurt is on the approved list.");
    expect(all.every((r) => r.unread)).toBe(true);

    // Staff A reads Ben's thread: unread clears for A only.
    psql(`insert into public.patient_chat_read_markers (conversation_id, staff_user_id, last_read_seq) values ('${CONV_BEN}', '${STAFF_A}', 999)`);
    expect(inbox(`'office-a', '${STAFF_A}'`).find((r) => r.id === CONV_BEN)?.unread).toBe(false);
    expect(inbox(`'office-a', '${STAFF_B}'`).find((r) => r.id === CONV_BEN)?.unread).toBe(true);
    const unreadOnly = inbox(`'office-a', '${STAFF_A}', p_unread_only => true`);
    expect(unreadOnly.map((r) => r.id)).toEqual([CONV_ANNA_SUPPORT, CONV_ANNA]);
    expect(unreadOnly[0].total).toBe(2);
    expect(inbox(`'office-a', '${STAFF_A}', p_sort => 'unread_first'`).map((r) => r.id)).toEqual([CONV_ANNA_SUPPORT, CONV_ANNA, CONV_BEN]);

    // Thread and status filters.
    expect(inbox(`'office-a', '${STAFF_A}', array['support']`).map((r) => r.id)).toEqual([CONV_ANNA_SUPPORT]);
    expect(inbox(`'office-a', '${STAFF_A}', p_status => 'waiting_patient'`).map((r) => r.id)).toEqual([CONV_ANNA]);
    expect(() => inbox(`'office-a', '${STAFF_A}', p_status => 'bogus'`)).toThrow();

    // Assignment filters.
    psql(`update public.patient_chat_conversations set assignee_user_id = '${STAFF_B}', assignee_label = 'Nurse Kim' where id = '${CONV_BEN}'`);
    expect(inbox(`'office-a', '${STAFF_A}', p_assignee => '${STAFF_B}'`).map((r) => r.id)).toEqual([CONV_BEN]);
    expect(inbox(`'office-a', '${STAFF_A}', p_assignee => 'unassigned'`).map((r) => r.id)).toEqual([CONV_ANNA_SUPPORT, CONV_ANNA]);

    // Search: patient name (apostrophe), message text, escaped wildcards.
    expect(inbox(`'office-a', '${STAFF_A}', p_q => 'o''neil'`).map((r) => r.id)).toEqual([CONV_ANNA_SUPPORT, CONV_ANNA]);
    expect(inbox(`'office-a', '${STAFF_A}', p_q => 'logged me out'`).map((r) => r.id)).toEqual([CONV_ANNA_SUPPORT]);
    expect(inbox(`'office-a', '${STAFF_A}', p_q => '100%'`).map((r) => r.id)).toEqual([CONV_ANNA]);
    expect(inbox(`'office-a', '${STAFF_A}', p_q => '50_percent'`).map((r) => r.id)).toEqual([CONV_BEN]);
    expect(inbox(`'office-a', '${STAFF_A}', p_q => '5%percent'`)).toEqual([]);
    expect(inbox(`'office-a', '${STAFF_A}', p_q => 'another office'`)).toEqual([]);

    // Sorts and paging.
    expect(inbox(`'office-a', '${STAFF_A}', p_sort => 'oldest'`).map((r) => r.id)).toEqual([CONV_ANNA, CONV_ANNA_SUPPORT, CONV_BEN]);
    expect(inbox(`'office-a', '${STAFF_A}', p_sort => 'waiting_longest'`).map((r) => r.id)).toEqual([CONV_ANNA_SUPPORT, CONV_BEN, CONV_ANNA]);
    const page = inbox(`'office-a', '${STAFF_A}', p_limit => 1, p_offset => 1`);
    expect(page.map((r) => r.id)).toEqual([CONV_ANNA_SUPPORT]);
    expect(page[0].total).toBe(3);
    // Single-conversation lookup rides the same function and the same scope.
    expect(inbox(`'office-a', '${STAFF_A}', p_conversation_id => '${CONV_BEN}'`).map((r) => r.id)).toEqual([CONV_BEN]);
    expect(inbox(`'office-a', '${STAFF_A}', p_conversation_id => '${CONV_OTHER}'`)).toEqual([]);

    // Notes and open escalations surface on the row.
    psql(`insert into public.patient_chat_notes (conversation_id, provider_id, author_user_id, author_label, body) values ('${CONV_BEN}', 'office-a', '${STAFF_A}', 'Dr. Ellis', 'Called the patient')`);
    psql(`insert into public.patient_chat_escalations (conversation_id, provider_id, department, reason, created_by, created_by_label) values ('${CONV_BEN}', 'office-a', 'clinical', 'Reports dizziness', '${STAFF_A}', 'Dr. Ellis')`);
    const ben = inbox(`'office-a', '${STAFF_A}'`).find((r) => r.id === CONV_BEN)!;
    expect(ben.note_count).toBe(1);
    expect(ben.open_escalation_department).toBe("clinical");
    // Only one open escalation per conversation.
    expect(() => psql(`insert into public.patient_chat_escalations (conversation_id, provider_id, department, reason, created_by, created_by_label) values ('${CONV_BEN}', 'office-a', 'support', 'dup', '${STAFF_A}', 'Dr. Ellis')`)).toThrow();
  });

  it("files idle threads as closed against the caller's auto-close cutoff without writing to the row", () => {
    // Anna's coach thread last moved on 2026-09-01; Ben's and the support
    // thread on 2026-09-02/03. A cutoff of 2026-09-02 00:00 closes only Anna.
    const cutoff = `p_auto_close_before => '2026-09-02 00:00:00+00'`;
    const all = inbox(`'office-a', '${STAFF_A}', ${cutoff}`);
    const anna = all.find((r) => r.id === CONV_ANNA)!;
    expect(anna.status).toBe("closed");
    expect(anna.auto_closed).toBe(true);
    expect(all.filter((r) => r.auto_closed).map((r) => r.id)).toEqual([CONV_ANNA]);
    expect(inbox(`'office-a', '${STAFF_A}', p_status => 'closed', ${cutoff}`).map((r) => r.id)).toEqual([CONV_ANNA]);
    expect(inbox(`'office-a', '${STAFF_A}', p_status => 'waiting_patient', ${cutoff}`)).toEqual([]);
    expect(conversation(CONV_ANNA).status).toBe("waiting_patient");
    // Without a cutoff (or a cutoff older than every thread) nothing changes.
    expect(inbox(`'office-a', '${STAFF_A}'`).some((r) => r.auto_closed)).toBe(false);
    expect(inbox(`'office-a', '${STAFF_A}', p_auto_close_before => '2026-08-01 00:00:00+00'`).some((r) => r.auto_closed)).toBe(false);
    // A deliberate staff reopen counts as activity: bumping updated_at keeps it open.
    psql(`update public.patient_chat_conversations set status = 'open', updated_at = '2026-09-05 00:00:00+00' where id = '${CONV_ANNA}'`);
    expect(inbox(`'office-a', '${STAFF_A}', ${cutoff}`).find((r) => r.id === CONV_ANNA)!.auto_closed).toBe(false);
    psql(`update public.patient_chat_conversations set status = 'waiting_patient', updated_at = '2026-09-01 10:20:00+00' where id = '${CONV_ANNA}'`);
    // Metrics honor the same cutoff.
    const closed = metrics("office-a", `, ${cutoff}`);
    expect(closed.closed_threads).toBe(1);
    expect(closed.waiting_threads).toBe(0);
    expect(metrics("office-a").closed_threads).toBe(0);
  });

  it("computes office and fleet metrics, excluding disabled offices", () => {
    const office = metrics("office-a");
    expect(office.open_threads).toBe(2);
    expect(office.waiting_threads).toBe(1);
    expect(office.closed_threads).toBe(0);
    expect(office.unanswered_threads).toBe(2);
    expect(Number(office.avg_response_minutes)).toBe(35);
    expect(office.open_escalations).toBe(1);
    const fleet = metrics(null);
    expect(fleet.open_threads).toBe(3);
    expect(fleet.unanswered_threads).toBe(3);
    // A disabled office drops out of the fleet numbers.
    psql(`update public.providers set access_disabled = true where provider_id = 'office-b'`);
    expect(metrics(null).open_threads).toBe(2);
    expect(metrics("office-b").open_threads).toBe(0);
    const empty = metrics("office-off");
    expect(empty.avg_response_minutes).toBeNull();
    expect(empty.open_escalations).toBe(0);
  });
});
