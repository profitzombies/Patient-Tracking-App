/**
 * Diet programs SQL, run for real.
 *
 * Boots a throwaway PostgreSQL cluster, applies the three canonical diet
 * migrations over a mirror of the tables they depend on, and proves what the
 * API relies on the database for: the seed lands all 27 library entries
 * (26 draft diets + published just_tracking) and matches the renderer byte
 * for byte, every edit bumps the version and snapshots history, the
 * backfill opens episode 1 from program_start_date, a provider restart closes
 * the open episode and starts the next from day one without deleting
 * anything, the start-date mirror stays in step both ways, one active and
 * one pending selection per patient, allergy severity rules, legacy
 * onboarding answers become restrictions, every new table carries the
 * identity write guard, and the closure function removes only the personal
 * diet tables. Skips loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIET_CATALOG, DIET_LIBRARY_SEED_MIGRATION, renderDietLibrarySeedMigration } from "@workspace/diet-programs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../../../supabase/migrations");
const LIBRARY = path.join(MIGRATIONS, DIET_LIBRARY_SEED_MIGRATION);
const PATIENT_DIET = path.join(MIGRATIONS, "20261206000001_patient_diet.sql");
const CLOSURE = path.join(MIGRATIONS, "20261206000002_patient_diet_closure.sql");
const available = ["initdb", "pg_ctl", "psql"].every((name) => spawnSync("which", [name], { stdio: "ignore" }).status === 0);
if (!available) console.warn("diet.sql.test: PostgreSQL binaries unavailable — skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
alter database postgres set test.role = 'service_role';
create table public.providers (provider_id text primary key);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  program_id text not null default 'thinnr', program_start_date date, archived_at timestamptz, closed_at timestamptz,
  record_retain_until timestamptz, auth_user_id uuid, email text, phone text, deletion_requested_at timestamptz,
  archived_into_patient_id uuid);
create table public.patient_flags (patient_id uuid primary key references public.patients(id) on delete cascade, onboarding_answers jsonb);
create table public.patient_edit_history (id uuid primary key default gen_random_uuid(), patient_id uuid references public.patients(id),
  family text not null check (family in ('profile', 'status', 'weight', 'measurement', 'medication', 'note')));
create table public.staff_notifications (id uuid primary key default gen_random_uuid(), kind text not null, provider_id text,
  constraint staff_notifications_kind_check check (kind in ('staff_attention_digest', 'system_threshold')),
  constraint staff_notifications_scope_check check (kind is not null));
create table public.hq_organization_settings (singleton boolean primary key, retention_clinical_record_days integer);
create table public.patient_deletion_requests (id uuid primary key, patient_id uuid references public.patients(id), status text, auth_user_id uuid, closed_at timestamptz, retain_until timestamptz);
create table public.patient_media (object_path text primary key, patient_id uuid references public.patients(id), kind text);
create table public.patient_data_exports (id uuid primary key default gen_random_uuid(), patient_id uuid references public.patients(id), object_path text);
create table public.patient_chat_conversations (id uuid primary key, patient_id uuid references public.patients(id), thread text);
create table public.ai_usage_events (id bigint generated always as identity primary key, patient_id uuid);
create table public.auth_sign_ins (user_id uuid, realm text);
create table public.account_security_state (user_id uuid primary key);
create table public.patient_diary_entries (id uuid primary key default gen_random_uuid(), patient_id uuid references public.patients(id));
create function private.guard_patient_dependency_write() returns trigger language plpgsql security definer set search_path = '' as $$
declare target_archived_at timestamptz;
begin
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
insert into public.providers values ('office-1');
insert into public.patients (id, provider_id, program_start_date) values
  ('00000000-0000-4000-8000-000000000001', 'office-1', '2026-08-01'),
  ('00000000-0000-4000-8000-000000000002', 'office-1', null),
  ('00000000-0000-4000-8000-000000000003', 'office-1', '2026-09-01');
insert into public.patient_flags (patient_id, onboarding_answers) values
  ('00000000-0000-4000-8000-000000000001', '{"diets":["vegan","gluten-free","keto"]}'),
  ('00000000-0000-4000-8000-000000000002', '{"diets":"oops"}'),
  ('00000000-0000-4000-8000-000000000003', '{}');
`;

let dir = "";
let dataDir = "";
const PORT = 56_900 + (process.pid % 500);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  return JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`) || "[]") as T[];
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = uuid(1);
const P2 = uuid(2);
const P3 = uuid(3);
const STAFF = uuid(9);
const count = (table: string, where = "true") => Number(psql(`select count(*) from public.${table} where ${where}`));

const NEW_TABLES = [
  "patient_protocol_episodes", "patient_diet_selections", "patient_diet_blocks", "patient_preference_items",
  "patient_screening_answers", "patient_activity_levels", "patient_target_snapshots",
];

// Real-PostgreSQL work runs several times slower when the completion gate
// starts every suite at once; budget it like the other SQL suites.
describe.skipIf(!available)("diet programs SQL (real PostgreSQL)", { timeout: 60_000 }, () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pgd-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"], { stdio: "ignore" });
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, LIBRARY, PATIENT_DIET, CLOSURE]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 90_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("commits the seed migration exactly as the catalog renders it", () => {
    expect(readFileSync(LIBRARY, "utf8")).toBe(renderDietLibrarySeedMigration());
  });

  it("seeds 26 draft diets plus the published tracking-only option, each with one version row", () => {
    expect(count("diet_library_entries")).toBe(DIET_CATALOG.length);
    expect(count("diet_library_entries")).toBe(27);
    expect(count("diet_library_entries", "review_status = 'published'")).toBe(1);
    expect(psql(`select slug from public.diet_library_entries where review_status = 'published'`)).toBe("just_tracking");
    expect(count("diet_library_entries", "review_status = 'draft'")).toBe(26);
    expect(count("diet_library_versions")).toBe(27);
    const keto = rows<{ pregnancy_blocked: boolean; screening_questions: string[]; fit_rules: { mode: string } }>(
      `select pregnancy_blocked, screening_questions, fit_rules from public.diet_library_entries where slug = 'keto'`,
    )[0];
    expect(keto.pregnancy_blocked).toBe(true);
    expect(keto.screening_questions).toContain("medication");
    expect(keto.fit_rules.mode).toBe("exclude");
    expect(count("diet_library_settings")).toBe(1);
    // Re-running the seed is a no-op (HQ edits are never clobbered).
    execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", LIBRARY], { stdio: "pipe", encoding: "utf8" });
    expect(count("diet_library_versions")).toBe(27);
  });

  it("bumps the version and snapshots prior content on every edit; publishing stamps published_at", () => {
    psql(`update public.diet_library_entries set summary = 'Edited by HQ', updated_by = '${STAFF}' where slug = 'dash'`);
    const row = rows<{ version: number; published_at: string | null }>(`select version, published_at from public.diet_library_entries where slug = 'dash'`)[0];
    expect(row.version).toBe(2);
    expect(row.published_at).toBeNull();
    const versions = rows<{ version: number; summary: string; changed_by: string | null }>(
      `select v.version, v.snapshot->>'summary' as summary, v.changed_by from public.diet_library_versions v join public.diet_library_entries e on e.id = v.entry_id where e.slug = 'dash' order by v.version`,
    );
    expect(versions).toHaveLength(2);
    expect(versions[0].summary).not.toBe("Edited by HQ");
    expect(versions[1]).toMatchObject({ version: 2, summary: "Edited by HQ", changed_by: STAFF });
    // A no-op update neither bumps nor snapshots.
    psql(`update public.diet_library_entries set summary = 'Edited by HQ' where slug = 'dash'`);
    expect(Number(psql(`select version from public.diet_library_entries where slug = 'dash'`))).toBe(2);
    psql(`update public.diet_library_entries set review_status = 'published' where slug = 'dash'`);
    const published = rows<{ version: number; published_at: string | null }>(`select version, published_at from public.diet_library_entries where slug = 'dash'`)[0];
    expect(published.version).toBe(3);
    expect(published.published_at).not.toBeNull();
    expect(() => psql(`update public.diet_library_entries set review_status = 'live' where slug = 'dash'`)).toThrow(/review_status_check/);
  });

  it("backfills episode 1 from program_start_date and mirrors later start-date edits onto the open episode", () => {
    expect(rows(`select episode_number, started_on, reason from public.patient_protocol_episodes where patient_id = '${P1}'`)).toEqual([
      { episode_number: 1, started_on: "2026-08-01", reason: "backfill" },
    ]);
    expect(count("patient_protocol_episodes", `patient_id = '${P2}'`)).toBe(0);
    // Onboarding sets the start date later: an enrollment episode opens.
    psql(`update public.patients set program_start_date = '2026-10-01' where id = '${P2}'`);
    expect(rows(`select episode_number, started_on, reason from public.patient_protocol_episodes where patient_id = '${P2}'`)).toEqual([
      { episode_number: 1, started_on: "2026-10-01", reason: "enrollment" },
    ]);
    // A correction moves the current episode rather than opening another.
    psql(`update public.patients set program_start_date = '2026-10-03' where id = '${P2}'`);
    expect(rows(`select episode_number, started_on from public.patient_protocol_episodes where patient_id = '${P2}'`)).toEqual([
      { episode_number: 1, started_on: "2026-10-03" },
    ]);
  });

  it("restarts the protocol as a new episode from day one, keeps the old one, and mirrors the date", () => {
    const restarted = rows<{ episode_number: number; started_on: string; reason: string; started_by: string; note: string | null }>(
      `select episode_number, started_on, reason, started_by, note from public.patient_protocol_restart('${P1}', '2026-10-10', '${STAFF}', 'Second round') `,
    )[0];
    expect(restarted).toMatchObject({ episode_number: 2, started_on: "2026-10-10", reason: "provider_restart", started_by: STAFF, note: "Second round" });
    expect(rows(`select episode_number, started_on, ended_on from public.patient_protocol_episodes where patient_id = '${P1}' order by episode_number`)).toEqual([
      { episode_number: 1, started_on: "2026-08-01", ended_on: "2026-10-09" },
      { episode_number: 2, started_on: "2026-10-10", ended_on: null },
    ]);
    expect(psql(`select program_start_date from public.patients where id = '${P1}'`)).toBe("2026-10-10");
    // The mirror update inside the RPC does not open a third episode.
    expect(count("patient_protocol_episodes", `patient_id = '${P1}'`)).toBe(2);
    // Tracking-only patients join the protocol; GLP-1 patients keep their program.
    psql(`update public.patients set program_id = 'none' where id = '${P3}'`);
    psql(`select public.patient_protocol_restart('${P3}', '2026-10-10', '${STAFF}')`);
    expect(psql(`select program_id from public.patients where id = '${P3}'`)).toBe("thinnr");
    psql(`update public.patients set program_id = 'glp1' where id = '${P3}'`);
    psql(`select public.patient_protocol_restart('${P3}', '2026-10-11', '${STAFF}')`);
    expect(psql(`select program_id from public.patients where id = '${P3}'`)).toBe("glp1");
    expect(count("patient_protocol_episodes", `patient_id = '${P3}'`)).toBe(3);
    expect(() => psql(`begin; select set_config('test.role', 'authenticated', true); select public.patient_protocol_restart('${P1}', '2026-10-10', '${STAFF}'); commit;`)).toThrow(/service role required/);
    expect(() => psql(`select public.patient_protocol_restart('${uuid(77)}', '2026-10-10', '${STAFF}')`)).toThrow(/unknown patient/);
  });

  it("allows one active and one pending selection per patient and only library slugs", () => {
    const insert = (slug: string, status: string) =>
      psql(`insert into public.patient_diet_selections (patient_id, diet_slug, status, selected_by_role) values ('${P1}', '${slug}', '${status}', 'patient')`);
    insert("mediterranean", "active");
    expect(() => insert("dash", "active")).toThrow(/patient_diet_selections_active_idx/);
    insert("keto", "pending_review");
    expect(() => insert("carnivore", "pending_review")).toThrow(/patient_diet_selections_pending_idx/);
    insert("dash", "superseded");
    expect(() => insert("atkins", "superseded")).toThrow(/foreign key/);
    const sel = psql(`select id from public.patient_diet_selections where patient_id = '${P1}' and status = 'pending_review'`);
    psql(`insert into public.patient_diet_blocks (patient_id, selection_id, diet_slug, questions) values ('${P1}', '${sel}', 'keto', '["medication"]')`);
    expect(() => psql(`update public.patient_diet_blocks set status = 'overridden' where selection_id = '${sel}'`)).toThrow(/review_consistent/);
    psql(`update public.patient_diet_blocks set status = 'overridden', reviewed_at = now(), reviewed_by = '${STAFF}' where selection_id = '${sel}'`);
  });

  it("migrates legacy onboarding diets into restrictions and enforces list rules", () => {
    expect(rows(`select item_key, label, entered_by_role, is_custom from public.patient_preference_items where patient_id = '${P1}' order by item_key`)).toEqual([
      { item_key: "gluten_free", label: "Gluten-free", entered_by_role: "migration", is_custom: false },
      { item_key: "vegan", label: "Vegan", entered_by_role: "migration", is_custom: false },
    ]);
    expect(count("patient_preference_items", `patient_id in ('${P2}', '${P3}')`)).toBe(0);
    const add = (list: string, key: string, severity: string | null, custom = false) =>
      psql(`insert into public.patient_preference_items (patient_id, list, item_key, label, is_custom, severity, entered_by_role) values ('${P2}', '${list}', '${key}', 'Label', ${custom}, ${severity ? `'${severity}'` : "null"}, 'patient')`);
    expect(() => add("allergy", "peanut", null)).toThrow(/severity_list_check/);
    expect(() => add("dislike", "custom:okra", "mild", true)).toThrow(/severity_list_check/);
    expect(() => add("dislike", "okra", null, true)).toThrow(/custom_key_check/);
    expect(() => add("dislike", "custom:okra", null, false)).toThrow(/custom_key_check/);
    add("allergy", "peanut", "severe");
    expect(() => add("allergy", "peanut", "mild")).toThrow(/patient_preference_items_live_idx/);
    psql(`update public.patient_preference_items set removed_at = now(), removed_by_role = 'patient' where patient_id = '${P2}' and item_key = 'peanut'`);
    add("allergy", "peanut", "mild");
    expect(count("patient_preference_items", `patient_id = '${P2}' and item_key = 'peanut'`)).toBe(2);
  });

  it("widens the edit-history family and staff outbox kind checks", () => {
    psql(`insert into public.patient_edit_history (patient_id, family) values ('${P1}', 'diet')`);
    for (const kind of ["diet_change", "diet_safety", "diet_allergy_severe"]) {
      psql(`insert into public.staff_notifications (kind, provider_id) values ('${kind}', 'office-1')`);
      expect(() => psql(`insert into public.staff_notifications (kind, provider_id) values ('${kind}', null)`)).toThrow(/scope_check/);
    }
    expect(() => psql(`insert into public.staff_notifications (kind, provider_id) values ('diet_other', 'office-1')`)).toThrow(/kind_check/);
  });

  it("guards every new table with the identity write barrier and keeps them service-role only", () => {
    for (const table of NEW_TABLES) {
      expect(psql(`select count(*) from pg_trigger where tgrelid = 'public.${table}'::regclass and tgname = 'patient_identity_write_guard' and not tgisinternal`), table).toBe("1");
      expect(psql(`select relrowsecurity from pg_class where relname = '${table}'`), table).toBe("t");
      expect(psql(`select has_table_privilege('anon', 'public.${table}', 'SELECT') or has_table_privilege('authenticated', 'public.${table}', 'SELECT')`), table).toBe("f");
    }
    for (const table of ["diet_library_entries", "diet_library_versions", "diet_library_settings"]) {
      expect(psql(`select has_table_privilege('anon', 'public.${table}', 'SELECT') or has_table_privilege('authenticated', 'public.${table}', 'SELECT')`), table).toBe("f");
    }
    expect(() => psql(`insert into public.patient_activity_levels (patient_id, level, source, recorded_on) values ('${uuid(88)}', 'light', 'check_in', '2026-10-10')`)).toThrow(/unknown patient/);
  });

  it("accepts every activity source the API writes, including the route default", () => {
    // The patient route defaults to "settings"; a pick writes diet_selection,
    // staff writes staff, a weekly check-in writes check_in.
    for (const source of ["settings", "diet_selection", "staff", "check_in"]) {
      psql(`insert into public.patient_activity_levels (patient_id, level, source, recorded_on) values ('${P1}', 'moderate', '${source}', '2026-10-09')`);
    }
    expect(count("patient_activity_levels", `patient_id = '${P1}' and recorded_on = '2026-10-09'`)).toBe(4);
    expect(() => psql(`insert into public.patient_activity_levels (patient_id, level, source, recorded_on) values ('${P1}', 'moderate', 'account', '2026-10-09')`)).toThrow(/check/i);
    psql(`delete from public.patient_activity_levels where patient_id = '${P1}' and recorded_on = '2026-10-09'`);
  });

  it("removes only the personal diet tables at account closure", () => {
    psql(`insert into public.patient_activity_levels (patient_id, level, source, recorded_on) values ('${P1}', 'light', 'check_in', '2026-10-10')`);
    psql(`insert into public.patient_target_snapshots (patient_id, date_key, phase, program_day, inputs, calculated, effective) values ('${P1}', '2026-10-10', 'protocol', 1, '{}', '{}', '{}')`);
    psql(`insert into public.patient_screening_answers (patient_id, question, answer, answered_by_role) values ('${P1}', 'medication', 'no', 'patient')`);
    psql(`insert into public.patient_deletion_requests (id, patient_id, status) values ('${uuid(500)}', '${P1}', 'closing')`);
    const closed = JSON.parse(psql(`select public.patient_close_rows('${uuid(500)}')`)) as { tables: Record<string, number> };
    expect(closed.tables.patient_activity_levels).toBe(1);
    expect(closed.tables.patient_target_snapshots).toBe(1);
    expect(count("patient_activity_levels", `patient_id = '${P1}'`)).toBe(0);
    expect(count("patient_target_snapshots", `patient_id = '${P1}'`)).toBe(0);
    expect(count("patient_screening_answers", `patient_id = '${P1}'`)).toBe(1);
    expect(count("patient_diet_selections", `patient_id = '${P1}'`)).toBe(3);
    expect(count("patient_protocol_episodes", `patient_id = '${P1}'`)).toBe(2);
    expect(count("patient_preference_items", `patient_id = '${P1}'`)).toBe(2);
  });
});
