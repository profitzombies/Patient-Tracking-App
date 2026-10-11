/**
 * Diet facts RPCs for the staff surfaces, run on real PostgreSQL.
 *
 * The office roster's "% fits diet" and the HQ Diets & restrictions report
 * both ride SQL that the route fakes cannot execute: the diary apply RPC
 * must persist the per-entry fit verdict (an earlier version silently
 * dropped it, so the roster could never leave Unknown), the roster facts RPC
 * must count verdicts inside the 14-day window only, and the HQ rollup must
 * key diet changes by the roles the selection rows actually persist, keep
 * tracking-only patients distinguishable from framework diets, and count
 * patients of ENABLED practices only — also network-wide. Boots a throwaway
 * cluster over a mirror of the dependent tables, applies the canonical
 * migrations, and feeds the real RPC output through the report assembler.
 * Skips loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIET_LIBRARY_SEED_MIGRATION } from "@workspace/diet-programs";
import { assembleDietRestrictions, dietFactsPayload } from "./restrictions-report";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../../../supabase/migrations");
const FILES = [
  DIET_LIBRARY_SEED_MIGRATION,
  "20261206000001_patient_diet.sql",
  "20261108000000_diary_apply_reports_new_entries.sql",
  "20261207000000_diet_roster_facts.sql",
  "20261207200000_diet_facts_fixes.sql",
].map((name) => path.join(MIGRATIONS, name));
const available = ["initdb", "pg_ctl", "psql"].every((name) => spawnSync("which", [name], { stdio: "ignore" }).status === 0);
if (!available) console.warn("diet-facts.sql.test: PostgreSQL binaries unavailable — skipped");

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P_ON_DIET = uuid(1);      // enabled office, mediterranean, staff-set
const P_TRACKING = uuid(2);     // enabled office, just_tracking, patient-set
const P_NO_DIET = uuid(3);      // enabled office, nothing chosen
const P_DISABLED = uuid(4);     // DISABLED office, keto — must never be counted
const P_PENDING = uuid(5);      // enabled office, not activated — not live
const STAFF = uuid(9);

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema private;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
alter database postgres set test.role = 'service_role';
create table public.providers (provider_id text primary key, provider_name text, office_name text, access_disabled boolean not null default false);
create table public.patients (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  program_id text not null default 'thinnr', program_start_date date, archived_at timestamptz, closed_at timestamptz,
  activation_status text not null default 'activated', created_at timestamptz not null default '2026-09-01T00:00:00Z',
  record_retain_until timestamptz, auth_user_id uuid, email text, phone text, deletion_requested_at timestamptz,
  archived_into_patient_id uuid);
create table public.patient_flags (patient_id uuid primary key references public.patients(id) on delete cascade, onboarding_answers jsonb);
create table public.patient_edit_history (id uuid primary key default gen_random_uuid(), patient_id uuid references public.patients(id),
  family text not null check (family in ('profile', 'status', 'weight', 'measurement', 'medication', 'note')));
create table public.staff_notifications (id uuid primary key default gen_random_uuid(), kind text not null, provider_id text,
  constraint staff_notifications_kind_check check (kind in ('staff_attention_digest', 'system_threshold')),
  constraint staff_notifications_scope_check check (kind is not null));
create table public.hq_organization_settings (singleton boolean primary key, retention_clinical_record_days integer);
create table public.patient_diary_entries (
  patient_id uuid not null references public.patients(id) on delete cascade,
  entry_id text not null, date_key date not null, meal text not null, kind text not null,
  ref_id text, name text not null, detail text not null default '', quantity numeric not null,
  calories numeric not null, protein numeric not null, carbs numeric not null, fat numeric not null,
  adjustments jsonb, nutrition_snapshot jsonb, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), primary key (patient_id, entry_id));
create table public.patient_food_prefs (
  patient_id uuid primary key references public.patients(id) on delete cascade,
  favorites jsonb not null default '[]', recents jsonb not null default '[]', updated_at timestamptz not null default now());
create function private.guard_patient_dependency_write() returns trigger language plpgsql security definer set search_path = '' as $$
begin return new; end; $$;
create function private.install_patient_identity_write_guards() returns integer language plpgsql security definer set search_path = '' as $$
begin return 0; end; $$;
insert into public.providers (provider_id, provider_name, office_name, access_disabled) values
  ('office-a', 'Dr Alpha', 'Alpha Clinic', false),
  ('office-z', 'Dr Zulu', 'Zulu Clinic (disabled)', true);
insert into public.patients (id, provider_id, program_start_date, activation_status) values
  ('${P_ON_DIET}', 'office-a', '2026-10-01', 'activated'),
  ('${P_TRACKING}', 'office-a', '2026-08-01', 'activated'),
  ('${P_NO_DIET}', 'office-a', '2026-09-20', 'activated'),
  ('${P_DISABLED}', 'office-z', '2026-09-01', 'activated'),
  ('${P_PENDING}', 'office-a', null, 'pending');
`;

let dir = "";
let dataDir = "";
const PORT = 57_400 + (process.pid % 500);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  return JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`) || "[]") as T[];
}
const json = (value: unknown) => `$json$${JSON.stringify(value)}$json$::jsonb`;
const entry = (id: string, dateKey: string, verdict: string | null | undefined) => ({
  entry_id: id, date_key: dateKey, meal: "lunch", kind: "food", name: "Salmon", quantity: 1,
  calories: 200, protein: 20, carbs: 0, fat: 12, ...(verdict === undefined ? {} : { fit_verdict: verdict }),
});
const NOW = "2026-10-10T15:00:00Z";
const facts = (providerId: string) => rows<{ patient_id: string; fit_count: number; fit_total: number; diet_slug: string | null; pending_block_id: string | null }>(
  `select patient_id, fit_count, fit_total, diet_slug, pending_block_id from public.provider_patient_diet_facts('${providerId}', '${NOW}') order by patient_id`,
);

describe.skipIf(!available)("diet facts SQL (real PostgreSQL)", { timeout: 60_000 }, () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pgdf-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"], { stdio: "ignore" });
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, ...FILES]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
    // Selections as the API writes them: role is the persisted enum value.
    psql(`insert into public.patient_diet_selections (patient_id, diet_slug, status, selected_by_role, selected_by, started_at) values
      ('${P_ON_DIET}', 'dash', 'superseded', 'patient', null, '2026-09-15T10:00:00Z'),
      ('${P_ON_DIET}', 'mediterranean', 'active', 'staff', '${STAFF}', '2026-10-02T10:00:00Z'),
      ('${P_TRACKING}', 'just_tracking', 'active', 'patient', null, '2026-10-03T10:00:00Z'),
      ('${P_DISABLED}', 'keto', 'active', 'system', null, '2026-10-04T10:00:00Z'),
      ('${P_PENDING}', 'keto', 'active', 'patient', null, '2026-10-05T10:00:00Z')`);
    psql(`insert into public.patient_preference_items (patient_id, list, item_key, label, severity, entered_by_role) values
      ('${P_ON_DIET}', 'allergy', 'peanut', 'Peanut', 'severe', 'staff'),
      ('${P_DISABLED}', 'allergy', 'shellfish', 'Shellfish', 'severe', 'patient')`);
  }, 90_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("persists the fit verdict through patient_diary_apply and counts it in the roster window", () => {
    const upsert = [
      entry("e-fit-1", "2026-10-09", "fits"),
      entry("e-fit-2", "2026-10-08", "fits"),
      entry("e-miss", "2026-10-07", "does_not_fit"),
      entry("e-unknown", "2026-10-06", "unknown"),  // looked, could not tell: not in the denominator
      entry("e-none", "2026-10-05", undefined),     // older app, no verdict: null
      entry("e-old", "2026-09-20", "does_not_fit"), // outside the 14-day window
    ];
    expect(JSON.parse(psql(`select to_jsonb(public.patient_diary_apply('${P_ON_DIET}', ${json(upsert)}, array[]::text[], null))`))).toHaveLength(6);
    expect(rows(`select entry_id, fit_verdict from public.patient_diary_entries where patient_id = '${P_ON_DIET}' order by entry_id`)).toEqual([
      { entry_id: "e-fit-1", fit_verdict: "fits" }, { entry_id: "e-fit-2", fit_verdict: "fits" }, { entry_id: "e-miss", fit_verdict: "does_not_fit" },
      { entry_id: "e-none", fit_verdict: null }, { entry_id: "e-old", fit_verdict: "does_not_fit" }, { entry_id: "e-unknown", fit_verdict: "unknown" },
    ]);
    // 2 fits of 3 decided verdicts inside the window; the roster renders 67 %.
    expect(facts("office-a").find((row) => row.patient_id === P_ON_DIET)).toMatchObject({ fit_count: 2, fit_total: 3, diet_slug: "mediterranean" });

    // An edit re-sends the row and the verdict follows the edit (the food changed).
    psql(`select public.patient_diary_apply('${P_ON_DIET}', ${json([entry("e-fit-1", "2026-10-09", "does_not_fit")])}, array[]::text[], null)`);
    expect(facts("office-a").find((row) => row.patient_id === P_ON_DIET)).toMatchObject({ fit_count: 1, fit_total: 3 });
    // A verdict outside the allowed set is refused, not stored as something else.
    expect(() => psql(`select public.patient_diary_apply('${P_ON_DIET}', ${json([entry("e-bad", "2026-10-09", "maybe")])}, array[]::text[], null)`)).toThrow(/fit_verdict/);
  });

  it("reports no verdicts as 0 of 0 (unknown), never as a percentage", () => {
    // The tracking-only patient has a selection but no verdict-bearing entries.
    expect(facts("office-a").find((row) => row.patient_id === P_TRACKING)).toMatchObject({ fit_count: 0, fit_total: 0, diet_slug: "just_tracking" });
    // No selection, no block, no severe allergy, no verdicts: no row at all (roster = no facts).
    expect(facts("office-a").some((row) => row.patient_id === P_NO_DIET)).toBe(false);
  });

  it("keys diet changes by the persisted roles and keeps tracking-only apart from frameworks", () => {
    const raw = JSON.parse(psql(`select public.hq_diet_restrictions_facts('2026-09-11', '2026-10-10', null)`));
    const payload = dietFactsPayload(raw);
    // A staff-made change is counted under its real key: no "provider"/"hq" bucket exists.
    expect(payload.changes).toEqual({ patient: 2, staff: 1 });
    const report = assembleDietRestrictions({ range: { start: "2026-09-11", end: "2026-10-10" }, asOf: NOW, todayKey: "2026-10-10", office: null, payload });
    expect(report.counts).toMatchObject({
      patients: 3, onDiet: 1, justTracking: 1, noDiet: 1,
      changes: { total: 3, byPatient: 2, byStaff: 1, bySystem: 0 },
      severeAllergyPatients: 1,
    });
    expect(report.counts?.byFramework.map((row) => [row.slug, row.patients]).sort()).toEqual([
      ["just_tracking", 1], ["mediterranean", 1], ["none", 1],
    ]);
  });

  it("counts patients of enabled practices only, network-wide as well as per office", () => {
    const network = dietFactsPayload(JSON.parse(psql(`select public.hq_diet_restrictions_facts('2026-09-11', '2026-10-10', null)`)));
    // The disabled office's patient (keto, severe shellfish allergy, system change) and the
    // not-yet-activated patient leave no trace in any section.
    expect(network.patients.map((row) => row.patientId).sort()).toEqual([P_ON_DIET, P_TRACKING, P_NO_DIET].sort());
    expect(network.patients.some((row) => row.dietSlug === "keto")).toBe(false);
    expect(network.items.map((row) => row.key)).toEqual(["peanut"]);
    expect(network.offices.map((row) => row.providerId)).toEqual(["office-a"]);
    expect(network.changes.system).toBeUndefined();
    // Asking for the disabled office explicitly returns nothing to count (the route 404s before this).
    const disabled = dietFactsPayload(JSON.parse(psql(`select public.hq_diet_restrictions_facts('2026-09-11', '2026-10-10', 'office-z')`)));
    expect(disabled.patients).toEqual([]);
    expect(assembleDietRestrictions({ range: { start: "2026-09-11", end: "2026-10-10" }, asOf: NOW, todayKey: "2026-10-10", office: { id: "office-z", name: "Zulu" }, payload: disabled }).available).toBe(false);
  });
});
