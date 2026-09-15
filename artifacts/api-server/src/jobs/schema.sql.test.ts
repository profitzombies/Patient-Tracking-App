/**
 * The job framework and storage-hygiene SQL, run for real.
 *
 * Lease exclusivity, backoff folding, dry-run neutrality, the cross-ledger
 * reference union, paged ledger listing, missing flags, and the three
 * retention functions (including the audit append-only carve-out) are the
 * pieces a fake cannot prove. This suite boots a throwaway PostgreSQL
 * cluster, applies the canonical migration verbatim over a minimal mirror of
 * the tables it references, and asserts behaviour. Skips loudly without
 * PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20260929000000_system_jobs_and_storage_hygiene.sql");
const STAFF_ALERTS_PRIVACY_MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261014000000_staff_attention_alerts_privacy.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("jobs/schema.sql.test: PostgreSQL binaries not on PATH — suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.patients (id uuid primary key, provider_id text);
create table public.patient_chat_conversations (
  id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id) on delete cascade,
  thread text not null default 'coach', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.patient_chat_messages (
  conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade,
  client_id text not null, seq bigint generated always as identity, role text not null default 'user', text text not null default '',
  photo jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (conversation_id, client_id));
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
create table public.patient_media (
  object_path text primary key, patient_id uuid not null references public.patients(id) on delete cascade,
  kind text not null, content_type text, size_bytes bigint, created_at timestamptz not null default now());
create table public.patient_progress_photos (patient_id uuid not null, photo_id text not null, object_path text not null, primary key (patient_id, photo_id));
create table public.patient_custom_foods (patient_id uuid not null, food_id text not null, photo_path text, primary key (patient_id, food_id));
create table public.patient_saved_recipes (patient_id uuid not null, recipe_id text not null, photo_path text, primary key (patient_id, recipe_id));
create table public.hq_private_files (id uuid primary key, name text, object_path text not null unique, created_at timestamptz default now());
create table public.knowledge_documents (id uuid primary key default gen_random_uuid(), title text, object_path text not null, status text default 'ready');
create table public.training_videos (id uuid primary key default gen_random_uuid(), title text, attachments jsonb not null default '[]'::jsonb, video_source text, thumbnail_source text);
create table public.training_media_cleanup (id uuid primary key default gen_random_uuid(), object_path text not null unique, video_id uuid, reason text default 'displaced', created_at timestamptz default now());
create table public.data_exports (id uuid primary key default gen_random_uuid(), status text default 'ready', object_path text unique, expires_at timestamptz);
create table public.patient_data_exports (id uuid primary key default gen_random_uuid(), patient_id uuid, status text default 'ready', object_path text unique, expires_at timestamptz);
create table public.patient_notifications (
  id uuid primary key default gen_random_uuid(), patient_id uuid not null references public.patients(id) on delete cascade,
  kind text not null default 'coach_outreach', status text not null default 'queued', created_at timestamptz not null default now());
create table public.patient_notification_attempts (
  id uuid primary key default gen_random_uuid(), notification_id uuid not null references public.patient_notifications(id) on delete cascade, attempt integer default 1);
create table public.patient_deletion_requests (id uuid primary key default gen_random_uuid(), patient_id uuid not null, status text not null default 'pending');
create table public.office_attention_digests (
  id uuid primary key default gen_random_uuid(), provider_id text not null, digest_date date not null,
  generated_at timestamptz not null default now(), time_zone text not null default 'UTC',
  flagged_count integer not null, items jsonb not null default '[]'::jsonb);
create table public.staff_notifications (
  id uuid primary key default gen_random_uuid(), provider_id text not null, auth_user_id uuid not null,
  channel text not null, status text not null default 'queued', data jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz not null default now(), finalized_at timestamptz, updated_at timestamptz not null default now());
create table public.analytics_events (id bigint generated always as identity primary key, patient_id uuid, kind text);
create table public.admin_audit_events (
  id bigint generated always as identity primary key, occurred_at timestamptz not null default now(), action text not null,
  actor_user_id uuid, actor_kind text not null, provider_id text, target_kind text, target_id text, request_id text,
  metadata jsonb not null default '{}'::jsonb);
create function public.reject_operational_event_mutation() returns trigger language plpgsql as $$
begin raise exception 'operational event tables are append-only'; end; $$;
create trigger analytics_events_append_only before update or delete on public.analytics_events
  for each row execute function public.reject_operational_event_mutation();
create trigger admin_audit_events_append_only before update or delete on public.admin_audit_events
  for each row execute function public.reject_operational_event_mutation();
`;

let dir = "";
let dataDir = "";
const PORT = 55_300 + (process.pid % 1000);
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
function fails(sql: string): string {
  try {
    psql(sql);
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = uuid(1);
const P2 = uuid(2);

describe.skipIf(!POSTGRES_AVAILABLE)("system jobs + storage hygiene SQL (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sj-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION, STAFF_ALERTS_PRIVACY_MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
    psql(`insert into public.patients (id, provider_id) values ('${P1}', 'prov'), ('${P2}', 'prov')`);
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps every new table and function service-role only", () => {
    const tables = ["system_job_leases", "system_job_runs", "system_job_item_failures", "storage_upload_intents", "admin_audit_event_archives"];
    const grants = rows<{ grantee: string; table_name: string }>(
      `select grantee, table_name from information_schema.role_table_grants
       where table_schema = 'public' and table_name in (${tables.map((t) => `'${t}'`).join(",")}) and grantee in ('anon','authenticated')`,
    );
    expect(grants).toEqual([]);
    const rls = rows<{ relname: string; rls: boolean }>(
      `select relname, relrowsecurity as rls from pg_class where relname in (${tables.map((t) => `'${t}'`).join(",")})`,
    );
    expect(rls).toHaveLength(tables.length);
    expect(rls.every((r) => r.rls)).toBe(true);
    for (const sig of [
      "public.acquire_system_job_lease(text,text,integer)",
      "public.renew_system_job_lease(text,text,integer)",
      "public.release_system_job_lease(text,text)",
      "public.finish_system_job_run(uuid,text,jsonb,integer,text,integer)",
      "public.storage_referenced_paths(text[])",
      "public.storage_ledger_paths(text,text,integer)",
      "public.storage_mark_object_missing(text[],boolean)",
      "public.retention_trim_chat_transcripts(timestamptz,integer,boolean)",
      "public.retention_trim_notifications(timestamptz,integer,boolean)",
      "public.retention_archive_audit_events(timestamptz,integer,boolean)",
    ]) {
      expect(scalar<boolean>(`has_function_privilege('anon', '${sig}', 'execute')`)).toBe(false);
      expect(scalar<boolean>(`has_function_privilege('service_role', '${sig}', 'execute')`)).toBe(true);
    }
  });

  describe("job leases and run state", () => {
    it("grants the lease to one owner, refuses a live rival, and reclaims after expiry", () => {
      expect(scalar<boolean>(`public.acquire_system_job_lease('sweep', 'a', 600)`)).toBe(true);
      expect(scalar<boolean>(`public.acquire_system_job_lease('sweep', 'b', 600)`)).toBe(false);
      // The holder may renew.
      expect(scalar<boolean>(`public.acquire_system_job_lease('sweep', 'a', 600)`)).toBe(true);
      psql(`update public.system_job_leases set lease_until = now() - interval '1 second' where job_name = 'sweep'`);
      expect(scalar<boolean>(`public.acquire_system_job_lease('sweep', 'b', 600)`)).toBe(true);
      psql(`select public.release_system_job_lease('sweep', 'a')`); // not the holder: no-op
      expect(scalar<string>(`lease_owner from public.system_job_leases where job_name = 'sweep'`)).toBe("b");
      psql(`select public.release_system_job_lease('sweep', 'b')`);
      expect(scalar<string | null>(`lease_owner from public.system_job_leases where job_name = 'sweep'`)).toBeNull();
    });

    it("renews only a live lease for its holder, extending lease_until without moving last_started_at", () => {
      expect(scalar<boolean>(`public.acquire_system_job_lease('beat', 'a', 60)`)).toBe(true);
      psql(`update public.system_job_leases set last_started_at = now() - interval '10 minutes', lease_until = now() + interval '10 seconds' where job_name = 'beat'`);
      const before = scalar<string>(`last_started_at::text from public.system_job_leases where job_name = 'beat'`);
      expect(scalar<boolean>(`public.renew_system_job_lease('beat', 'b', 600)`)).toBe(false); // not the holder
      expect(scalar<boolean>(`public.renew_system_job_lease('beat', 'a', 600)`)).toBe(true);
      expect(scalar<boolean>(`lease_until > now() + interval '5 minutes' from public.system_job_leases where job_name = 'beat'`)).toBe(true);
      expect(scalar<string>(`last_started_at::text from public.system_job_leases where job_name = 'beat'`)).toBe(before);
      // Still held long after the original 60 s would have lapsed: a rival cannot take it.
      expect(scalar<boolean>(`public.acquire_system_job_lease('beat', 'b', 60)`)).toBe(false);
      // Once lapsed, renewal never revives it, and a rival may take over.
      psql(`update public.system_job_leases set lease_until = now() - interval '1 second' where job_name = 'beat'`);
      expect(scalar<boolean>(`public.renew_system_job_lease('beat', 'a', 600)`)).toBe(false);
      expect(scalar<boolean>(`public.acquire_system_job_lease('beat', 'b', 60)`)).toBe(true);
      expect(scalar<boolean>(`public.renew_system_job_lease('beat', 'a', 600)`)).toBe(false);
      expect(scalar<boolean>(`public.renew_system_job_lease('beat', 'b', 600)`)).toBe(true);
      expect(scalar<boolean>(`public.renew_system_job_lease('nope', 'b', 600)`)).toBe(false); // unknown job: nothing to renew
    });

    it("folds run outcomes into the state row with capped backoff, resets on success, and ignores dry runs", () => {
      psql(`delete from public.system_job_runs; delete from public.system_job_leases`);
      const run = (dry: boolean) =>
        psql(`insert into public.system_job_runs (job_name, trigger, dry_run, owner) values ('trim', 'schedule', ${dry}, 'o1') returning id`).trim();
      expect(scalar<boolean>(`public.acquire_system_job_lease('trim', 'o1', 600)`)).toBe(true);
      const r1 = run(false);
      psql(`select public.finish_system_job_run('${r1}', 'failed', '{}'::jsonb, 2, 'boom', 300)`);
      let state = rows<{ consecutive_failures: number; next_eligible_at: string | null; last_error: string; lease_owner: string | null; last_success_at: string | null }>(
        `select consecutive_failures, next_eligible_at, last_error, lease_owner, last_success_at from public.system_job_leases where job_name = 'trim'`,
      )[0];
      expect(state.consecutive_failures).toBe(1);
      expect(state.last_error).toBe("boom");
      expect(state.lease_owner).toBeNull();
      expect(state.last_success_at).toBeNull();
      const first = scalar<number>(`extract(epoch from next_eligible_at - now()) from public.system_job_leases where job_name = 'trim'`);
      expect(first).toBeGreaterThan(290);
      expect(first).toBeLessThanOrEqual(300);
      const r2 = run(false);
      psql(`select public.finish_system_job_run('${r2}', 'failed', '{}'::jsonb, 0, 'boom again', 300)`);
      const second = scalar<number>(`extract(epoch from next_eligible_at - now()) from public.system_job_leases where job_name = 'trim'`);
      expect(second).toBeGreaterThan(590);
      // Many failures: capped at six hours.
      for (let i = 0; i < 12; i += 1) {
        psql(`select public.finish_system_job_run('${run(false)}', 'failed', '{}'::jsonb, 0, 'x', 300)`);
      }
      expect(scalar<number>(`extract(epoch from next_eligible_at - now()) from public.system_job_leases where job_name = 'trim'`)).toBeLessThanOrEqual(21_600);
      expect(scalar<number>(`consecutive_failures from public.system_job_leases where job_name = 'trim'`)).toBe(14);
      // A dry run changes nothing.
      const dry = run(true);
      psql(`select public.finish_system_job_run('${dry}', 'succeeded', '{"x":1}'::jsonb, 0, null, 300)`);
      state = rows(`select consecutive_failures, next_eligible_at, last_error, lease_owner, last_success_at from public.system_job_leases where job_name = 'trim'`)[0] as typeof state;
      expect(state.consecutive_failures).toBe(14);
      expect(state.last_success_at).toBeNull();
      expect(scalar<string>(`status from public.system_job_runs where id = '${dry}'`)).toBe("succeeded");
      // A real success resets.
      const ok = run(false);
      psql(`select public.finish_system_job_run('${ok}', 'succeeded', '{"deleted":3}'::jsonb, 0, null, 300)`);
      state = rows(`select consecutive_failures, next_eligible_at, last_error, lease_owner, last_success_at from public.system_job_leases where job_name = 'trim'`)[0] as typeof state;
      expect(state.consecutive_failures).toBe(0);
      expect(state.next_eligible_at).toBeNull();
      expect(state.last_success_at).not.toBeNull();
      expect(scalar<string>(`last_success_counts->>'deleted' from public.system_job_leases where job_name = 'trim'`)).toBe("3");
      expect(fails(`select public.finish_system_job_run('${ok}', 'weird', '{}'::jsonb, 0, null, 300)`)).toContain("status must be");
    });
  });

  describe("storage reference union and ledger listing", () => {
    beforeAll(() => {
      psql(`
        insert into public.patient_media (object_path, patient_id, kind) values
          ('/objects/patient-media/${P1}/food-1', '${P1}', 'food'),
          ('/objects/patient-media/${P1}/chat-1', '${P1}', 'chat');
        insert into public.patient_progress_photos values ('${P1}', 'ph1', '/objects/patient-media/${P1}/progress-1');
        insert into public.patient_custom_foods values ('${P1}', 'f1', '/objects/patient-media/${P1}/food-2');
        insert into public.patient_saved_recipes values ('${P1}', 'r1', '/objects/patient-media/${P1}/recipe-1');
        insert into public.hq_private_files (id, name, object_path) values ('${uuid(10)}', 'a.pdf', '/objects/hq-files/${uuid(10)}/file-${uuid(11)}');
        insert into public.knowledge_documents (title, object_path) values ('doc', '/objects/knowledge-docs/${uuid(12)}/doc-1');
        insert into public.training_videos (id, title, video_source, thumbnail_source, attachments) values
          ('${uuid(13)}', 'v', '/objects/training-videos/${uuid(13)}/video-1', '/objects/training-videos/${uuid(13)}/thumb-1',
           '[{"source":"/objects/training-attachments/${uuid(13)}/file-1","name":"n"}]'::jsonb);
        insert into public.data_exports (object_path) values ('/objects/exports/${uuid(14)}/export-1.csv');
        insert into public.patient_data_exports (patient_id, object_path) values ('${P1}', '/objects/patient-media/${P1}/export-${uuid(15)}.zip');
        insert into public.training_media_cleanup (object_path) values ('/objects/training-videos/${uuid(13)}/video-old');
      `);
    });

    it("recognises a path referenced by ANY ledger and nothing else", () => {
      const probe = [
        `/objects/patient-media/${P1}/food-1`, `/objects/patient-media/${P1}/chat-1`, `/objects/patient-media/${P1}/progress-1`,
        `/objects/patient-media/${P1}/food-2`, `/objects/patient-media/${P1}/recipe-1`,
        `/objects/hq-files/${uuid(10)}/file-${uuid(11)}`, `/objects/knowledge-docs/${uuid(12)}/doc-1`,
        `/objects/training-videos/${uuid(13)}/video-1`, `/objects/training-videos/${uuid(13)}/thumb-1`,
        `/objects/training-attachments/${uuid(13)}/file-1`, `/objects/exports/${uuid(14)}/export-1.csv`,
        `/objects/patient-media/${P1}/export-${uuid(15)}.zip`, `/objects/training-videos/${uuid(13)}/video-old`,
        `/objects/patient-media/${P1}/food-orphan`, `/objects/hq-files/${uuid(10)}/file-orphan`,
      ];
      const arr = `array[${probe.map((p) => `'${p}'`).join(",")}]::text[]`;
      const found = rows<{ p: string }>(`select p from public.storage_referenced_paths(${arr}) as p`).map((r) => r.p).sort();
      expect(found).toEqual(probe.slice(0, 13).sort());
      expect(found).not.toContain(`/objects/patient-media/${P1}/food-orphan`);
    });

    it("chat message photos count as references even without a ledger row", () => {
      psql(`insert into public.patient_chat_conversations (id, patient_id) values ('${uuid(20)}', '${P1}')`);
      psql(`insert into public.patient_chat_messages (conversation_id, client_id, photo) values ('${uuid(20)}', 'm1', '{"path":"/objects/patient-media/${P1}/chat-msgonly","width":1,"height":1}'::jsonb)`);
      expect(rows(`select p from public.storage_referenced_paths(array['/objects/patient-media/${P1}/chat-msgonly']) p`)).toHaveLength(1);
      psql(`delete from public.patient_chat_conversations where id = '${uuid(20)}'`);
    });

    it("lists ledger paths under a prefix in pages, with source and missing flag", () => {
      const page1 = rows<{ object_path: string; source: string; missing: boolean }>(
        `select * from public.storage_ledger_paths('/objects/patient-media/', null, 3)`,
      );
      expect(page1).toHaveLength(3);
      expect(page1.map((r) => r.object_path)).toEqual([...page1.map((r) => r.object_path)].sort());
      const page2 = rows<{ object_path: string; source: string }>(
        `select * from public.storage_ledger_paths('/objects/patient-media/', '${page1[2].object_path}', 100)`,
      );
      const all = [...page1, ...page2].map((r) => r.object_path);
      expect(new Set(all).size).toBe(all.length);
      expect(all).toHaveLength(6);
      expect(all.every((p) => p.startsWith(`/objects/patient-media/${P1}/`))).toBe(true);
      expect(page1.every((r) => r.missing === false)).toBe(true);
      const training = rows<{ source: string }>(`select * from public.storage_ledger_paths('/objects/training-', null, 100)`).map((r) => r.source).sort();
      expect(training).toEqual(["training_attachment", "training_media_cleanup", "training_thumbnail", "training_video"]);
    });

    it("sets and clears missing flags idempotently across every flaggable ledger", () => {
      const paths = `array['/objects/patient-media/${P1}/food-1','/objects/hq-files/${uuid(10)}/file-${uuid(11)}','/objects/knowledge-docs/${uuid(12)}/doc-1','/objects/training-videos/${uuid(13)}/video-1','/objects/training-videos/${uuid(13)}/thumb-1','/objects/exports/${uuid(14)}/export-1.csv','/objects/patient-media/${P1}/export-${uuid(15)}.zip']::text[]`;
      expect(scalar<number>(`public.storage_mark_object_missing(${paths}, true)`)).toBe(7);
      expect(scalar<number>(`public.storage_mark_object_missing(${paths}, true)`)).toBe(0);
      const flagged = rows<{ object_path: string; missing: boolean }>(
        `select object_path, missing from public.storage_ledger_paths('/objects/', null, 100) where missing`,
      );
      expect(flagged).toHaveLength(7);
      expect(scalar<boolean>(`video_missing_at is not null and thumbnail_missing_at is not null from public.training_videos where id = '${uuid(13)}'`)).toBe(true);
      expect(scalar<number>(`public.storage_mark_object_missing(${paths}, false)`)).toBe(7);
      expect(scalar<number>(`public.storage_mark_object_missing(${paths}, false)`)).toBe(0);
      expect(rows(`select 1 from public.storage_ledger_paths('/objects/', null, 100) where missing`)).toHaveLength(0);
      expect(scalar<number>(`public.storage_mark_object_missing(array[]::text[], true)`)).toBe(0);
    });
  });

  describe("retention: chat transcripts", () => {
    const C1 = uuid(30);
    const C2 = uuid(31);
    const C3 = uuid(32);
    beforeAll(() => {
      psql(`
        insert into public.patient_chat_conversations (id, patient_id, thread, created_at, updated_at) values
          ('${C1}', '${P1}', 'coach', now() - interval '900 days', now() - interval '800 days'),
          ('${C2}', '${P2}', 'coach', now() - interval '900 days', now() - interval '800 days'),
          ('${C3}', '${P1}', 'care_team', now() - interval '900 days', now() - interval '800 days');
        insert into public.patient_chat_messages (conversation_id, client_id, photo, created_at) values
          ('${C1}', 'old-1', '{"path":"/objects/patient-media/${P1}/chat-old"}'::jsonb, now() - interval '800 days'),
          ('${C1}', 'old-2', '{"path":"/objects/patient-media/${P1}/chat-shared"}'::jsonb, now() - interval '790 days'),
          ('${C1}', 'new-1', '{"path":"/objects/patient-media/${P1}/chat-shared"}'::jsonb, now() - interval '10 days'),
          ('${C2}', 'held-1', null, now() - interval '800 days'),
          ('${C3}', 'human-old-1', null, now() - interval '780 days');
        insert into public.patient_chat_read_markers values ('${C3}', '${uuid(300)}', 1);
        insert into public.patient_chat_patient_read_markers values ('${C3}', '${P1}', 1);
        insert into public.patient_chat_notes (conversation_id, body) values ('${C3}', 'internal note');
        insert into public.patient_media (object_path, patient_id, kind) values
          ('/objects/patient-media/${P1}/chat-old', '${P1}', 'chat'),
          ('/objects/patient-media/${P1}/chat-shared', '${P1}', 'chat');
        insert into public.patient_deletion_requests (patient_id, status) values ('${P2}', 'pending');
      `);
    });

    it("dry run reports what would go without deleting", () => {
      const r = rows<{ messages_deleted: number; conversations_deleted: number; media_paths: string[] }>(
        `select * from public.retention_trim_chat_transcripts(now() - interval '730 days', 1000, true)`,
      )[0];
      expect(r.messages_deleted).toBe(3);
      expect(r.conversations_deleted).toBe(1);
      expect(r.media_paths).toEqual([`/objects/patient-media/${P1}/chat-old`]);
      expect(scalar<number>(`count(*) from public.patient_chat_messages`)).toBe(5);
    });

    it("deletes old messages oldest-first within the limit, frees only unreferenced chat media, and skips pending-deletion patients", () => {
      const first = rows<{ messages_deleted: number; media_paths: string[] }>(
        `select * from public.retention_trim_chat_transcripts(now() - interval '730 days', 1, false)`,
      )[0];
      expect(first.messages_deleted).toBe(1);
      expect(first.media_paths).toEqual([`/objects/patient-media/${P1}/chat-old`]);
      expect(scalar<number>(`count(*) from public.patient_chat_messages where client_id = 'old-1'`)).toBe(0);
      const second = rows<{ messages_deleted: number; conversations_deleted: number; media_paths: string[] }>(
        `select * from public.retention_trim_chat_transcripts(now() - interval '730 days', 1000, false)`,
      )[0];
      expect(second.messages_deleted).toBe(2);
      // chat-shared is still referenced by the recent message: ledger row stays.
      expect(second.media_paths).toEqual([]);
      expect(scalar<number>(`count(*) from public.patient_media where object_path = '/objects/patient-media/${P1}/chat-shared'`)).toBe(1);
      expect(second.conversations_deleted).toBe(1);
      // Human care-team rows use the same policy. Once its transcript is
      // empty, workflow notes and both read-marker kinds disappear by cascade.
      expect(scalar<number>(`count(*) from public.patient_chat_conversations where id = '${C3}'`)).toBe(0);
      expect(scalar<number>(`count(*) from public.patient_chat_notes`)).toBe(0);
      expect(scalar<number>(`count(*) from public.patient_chat_read_markers`)).toBe(0);
      expect(scalar<number>(`count(*) from public.patient_chat_patient_read_markers`)).toBe(0);
      // The patient with a pending deletion request keeps every message.
      expect(scalar<number>(`count(*) from public.patient_chat_messages where conversation_id = '${C2}'`)).toBe(1);
      // Re-running is a no-op.
      expect(rows<{ messages_deleted: number }>(`select * from public.retention_trim_chat_transcripts(now() - interval '730 days', 1000, false)`)[0].messages_deleted).toBe(0);
    });

    it("removes an emptied conversation once its last message ages out, never a held one", () => {
      psql(`delete from public.patient_chat_messages where conversation_id = '${C1}'`);
      const r = rows<{ conversations_deleted: number }>(`select * from public.retention_trim_chat_transcripts(now() - interval '730 days', 1000, false)`)[0];
      expect(r.conversations_deleted).toBe(1);
      expect(scalar<number>(`count(*) from public.patient_chat_conversations where id = '${C1}'`)).toBe(0);
      psql(`delete from public.patient_chat_messages where conversation_id = '${C2}'`);
      expect(rows<{ conversations_deleted: number }>(`select * from public.retention_trim_chat_transcripts(now() - interval '730 days', 1000, false)`)[0].conversations_deleted).toBe(0);
    });
  });

  describe("retention: notification history", () => {
    it("trims only terminal rows past the cutoff, oldest first, cascading attempts", () => {
      psql(`
        insert into public.patient_notifications (id, patient_id, status, created_at) values
          ('${uuid(40)}', '${P1}', 'sent', now() - interval '200 days'),
          ('${uuid(41)}', '${P1}', 'failed', now() - interval '190 days'),
          ('${uuid(42)}', '${P1}', 'queued', now() - interval '300 days'),
          ('${uuid(43)}', '${P1}', 'sent', now() - interval '10 days');
        insert into public.patient_notification_attempts (notification_id) values ('${uuid(40)}');
      `);
      expect(scalar<number>(`public.retention_trim_notifications(now() - interval '180 days', 1000, true)`)).toBe(2);
      expect(scalar<number>(`count(*) from public.patient_notifications`)).toBe(4);
      expect(scalar<number>(`public.retention_trim_notifications(now() - interval '180 days', 1, false)`)).toBe(1);
      expect(scalar<number>(`count(*) from public.patient_notifications where id = '${uuid(40)}'`)).toBe(0);
      expect(scalar<number>(`count(*) from public.patient_notification_attempts`)).toBe(0);
      expect(scalar<number>(`public.retention_trim_notifications(now() - interval '180 days', 1000, false)`)).toBe(1);
      expect(rows<{ id: string }>(`select id from public.patient_notifications order by created_at`).map((r) => r.id)).toEqual([uuid(42), uuid(43)]);
    });

    it("trims terminal staff notifications and digests while queued rows survive", () => {
      psql(`
        insert into public.staff_notifications (id, provider_id, auth_user_id, channel, status, scheduled_at, finalized_at) values
          ('${uuid(44)}', 'office-1', '${uuid(90)}', 'email', 'sent', now() - interval '210 days', now() - interval '200 days'),
          ('${uuid(45)}', 'office-1', '${uuid(90)}', 'push', 'queued', now() - interval '300 days', null),
          ('${uuid(46)}', 'office-1', '${uuid(90)}', 'push', 'failed', now() - interval '10 days', now() - interval '10 days');
        insert into public.office_attention_digests (id, provider_id, digest_date, generated_at, flagged_count)
          values ('${uuid(47)}', 'office-1', current_date - 200, now() - interval '200 days', 0);
      `);
      expect(scalar<number>(`public.retention_trim_staff_alerts(now() - interval '180 days', 1000, true)`)).toBe(2);
      expect(scalar<number>(`count(*) from public.staff_notifications`)).toBe(3);
      expect(scalar<number>(`count(*) from public.office_attention_digests`)).toBe(1);
      expect(scalar<number>(`public.retention_trim_staff_alerts(now() - interval '180 days', 1000, false)`)).toBe(2);
      expect(rows<{ id: string }>(`select id from public.staff_notifications order by id`).map((row) => row.id)).toEqual([uuid(45), uuid(46)]);
      expect(scalar<number>(`count(*) from public.office_attention_digests`)).toBe(0);
    });
  });

  describe("retention: audit events", () => {
    beforeAll(() => {
      psql(`
        insert into public.admin_audit_events (occurred_at, action, actor_kind, provider_id, target_kind) values
          ('2019-01-03T10:00:00Z', 'settings.update', 'staff', null, 'settings'),
          ('2019-01-20T10:00:00Z', 'settings.update', 'staff', null, 'settings'),
          ('2019-02-01T10:00:00Z', 'patient.edit', 'staff', 'prov', 'patient'),
          (now() - interval '1 day', 'settings.update', 'staff', null, 'settings');
      `);
    });

    it("stays append-only outside the retention function", () => {
      expect(fails(`delete from public.admin_audit_events where action = 'patient.edit'`)).toContain("append-only");
      expect(fails(`update public.admin_audit_events set action = 'x'`)).toContain("append-only");
      // Setting the switch by hand in a session that is not the function still works only for DELETE
      // inside a transaction; a plain session never sets it, so this stays refused.
      expect(scalar<number>(`count(*) from public.admin_audit_events`)).toBe(4);
    });

    it("dry run counts events and summary rows without writing", () => {
      const r = rows<{ events_archived: number; summaries_touched: number }>(
        `select * from public.retention_archive_audit_events(now() - interval '2555 days', 5000, true)`,
      )[0];
      expect(r).toEqual({ events_archived: 3, summaries_touched: 2 });
      expect(scalar<number>(`count(*) from public.admin_audit_event_archives`)).toBe(0);
      expect(scalar<number>(`count(*) from public.admin_audit_events`)).toBe(4);
    });

    it("archives a compact monthly summary then deletes, in batches, merging into existing summaries", () => {
      const first = rows<{ events_archived: number; summaries_touched: number }>(
        `select * from public.retention_archive_audit_events(now() - interval '2555 days', 1, false)`,
      )[0];
      expect(first).toEqual({ events_archived: 1, summaries_touched: 1 });
      const second = rows<{ events_archived: number; summaries_touched: number }>(
        `select * from public.retention_archive_audit_events(now() - interval '2555 days', 5000, false)`,
      )[0];
      expect(second).toEqual({ events_archived: 2, summaries_touched: 2 });
      const archives = rows<{ period_start: string; action: string; provider_id: string; event_count: number; first_at: string; last_at: string }>(
        `select period_start, action, provider_id, event_count, first_at, last_at from public.admin_audit_event_archives order by period_start, action`,
      );
      expect(archives).toHaveLength(2);
      expect(archives[0].action).toBe("settings.update");
      expect(archives[0].event_count).toBe(2);
      expect(archives[0].first_at.startsWith("2019-01-03")).toBe(true);
      expect(archives[0].last_at.startsWith("2019-01-20")).toBe(true);
      expect(archives[1]).toMatchObject({ action: "patient.edit", provider_id: "prov", event_count: 1 });
      expect(scalar<number>(`count(*) from public.admin_audit_events`)).toBe(1);
      // The guard closed again after the function returned.
      expect(fails(`delete from public.admin_audit_events`)).toContain("append-only");
      expect(rows<{ events_archived: number }>(`select * from public.retention_archive_audit_events(now() - interval '2555 days', 5000, false)`)[0].events_archived).toBe(0);
    });
  });
});
