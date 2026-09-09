/**
 * Real PostgreSQL coverage for the diary/library snapshot migration. The
 * route's PostgREST fake cannot execute jsonb_to_recordset or prove that the
 * replaced atomic RPCs retained their ownership and media-ledger behavior.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  here,
  "../../../../supabase/migrations/20261004010000_food_nutrition_snapshots.sql",
);

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("patient-data.sql.test: PostgreSQL binaries not on PATH — snapshot RPC suite skipped");
}

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.patients (id uuid primary key);
create table public.patient_diary_entries (
  patient_id uuid not null references public.patients(id) on delete cascade,
  entry_id text not null, date_key date not null, meal text not null, kind text not null,
  ref_id text, name text not null, detail text not null default '', quantity numeric not null,
  calories numeric not null, protein numeric not null, carbs numeric not null, fat numeric not null,
  adjustments jsonb, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), primary key (patient_id, entry_id));
create table public.patient_water_days (
  patient_id uuid not null references public.patients(id), date_key date not null, oz numeric not null,
  primary key (patient_id, date_key));
create table public.patient_food_prefs (
  patient_id uuid primary key references public.patients(id) on delete cascade,
  favorites jsonb not null default '[]', recents jsonb not null default '[]',
  updated_at timestamptz not null default now());
create table public.patient_custom_foods (
  patient_id uuid not null references public.patients(id) on delete cascade,
  food_id text not null, name text not null, brand text, serving text not null,
  calories numeric not null, protein numeric not null, carbs numeric not null, fat numeric not null,
  photo_path text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), primary key (patient_id, food_id));
create table public.patient_saved_recipes (
  patient_id uuid not null references public.patients(id) on delete cascade,
  recipe_id text not null, name text not null, meal text not null, mode text not null,
  tags jsonb not null default '[]', minutes integer not null, servings numeric not null,
  calories numeric not null, protein numeric not null, carbs numeric not null, fat numeric not null,
  description text not null default '', ingredients jsonb not null default '[]',
  steps jsonb not null default '[]', grocery_list jsonb, saved_at text not null, photo_path text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (patient_id, recipe_id));
create table public.patient_media (
  object_path text primary key, patient_id uuid not null references public.patients(id) on delete cascade,
  kind text not null);
`;

const PATIENT_A = "00000000-0000-4000-8000-000000000001";
const PATIENT_B = "00000000-0000-4000-8000-000000000002";
const SNAPSHOT = {
  version: 1,
  source: { provider: "usda", recordId: "171077", revision: "sha256:exact" },
  basis: { amount: 100, unit: "g", label: "100 g", grams: 100 },
  nutrients: [
    { id: "energy", name: "Energy", unit: "kcal", amount: 155.123456 },
    { id: "protein", name: "Protein", unit: "g", amount: 12.58 },
    { id: "carbohydrate", name: "Carbohydrate", unit: "g", amount: 1.12 },
    { id: "fat", name: "Fat", unit: "g", amount: 10.61 },
  ],
  portions: [{
    id: "egg", label: "1 large egg", unit: "egg", dimension: "count",
    basisMultiplier: 0.5, grams: 50, evidence: "USDA portion",
  }],
  selected: { amount: 2, unitId: "egg", scale: 1 },
  provenance: "generic_source",
};

let dir = "";
let dataDir = "";
const PORT = 55_400 + (process.pid % 1000);

function psql(sql: string): string {
  return execFileSync(
    "psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: "" } },
  );
}

function json(value: unknown): string {
  return `$json$${JSON.stringify(value)}$json$::jsonb`;
}

function scalar(sql: string): unknown {
  const out = psql(`select to_jsonb(v) from (${sql}) q(v)`).trim();
  return out ? JSON.parse(out) : null;
}

describe.skipIf(!POSTGRES_AVAILABLE)("patient snapshot RPCs (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "patient-snapshot-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION]) {
      execFileSync(
        "psql",
        ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file],
        { stdio: "pipe", encoding: "utf8" },
      );
    }
    psql(`insert into public.patients(id) values ('${PATIENT_A}'), ('${PATIENT_B}')`);
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips an exact diary snapshot and takes identity only from the RPC argument", () => {
    const entry = {
      patient_id: PATIENT_B,
      entry_id: "entry-exact",
      date_key: "2026-10-04",
      meal: "breakfast",
      kind: "food",
      name: "Egg",
      detail: "2 eggs",
      quantity: 2,
      calories: 155.123456,
      protein: 12.58,
      carbs: 1.12,
      fat: 10.61,
      nutrition_snapshot: SNAPSHOT,
    };
    psql(`select public.patient_diary_apply('${PATIENT_A}', ${json([entry])}, array[]::text[], ${json(["egg"])})`);
    expect(scalar(`select nutrition_snapshot from public.patient_diary_entries where patient_id='${PATIENT_A}' and entry_id='entry-exact'`))
      .toEqual(SNAPSHOT);
    expect(scalar(`select count(*) from public.patient_diary_entries where patient_id='${PATIENT_B}'`)).toBe(0);
    expect(scalar(`select recents from public.patient_food_prefs where patient_id='${PATIENT_A}'`)).toEqual(["egg"]);

    psql(`select public.patient_diary_apply('${PATIENT_A}', '[]', array['entry-exact'], null)`);
    expect(scalar(`select count(*) from public.patient_diary_entries where patient_id='${PATIENT_A}'`)).toBe(0);
  });

  it("round-trips private catalog metadata and retains atomic media cleanup/prefs semantics", () => {
    const first = {
      patient_id: PATIENT_B,
      food_id: "cfg-exact",
      name: "Egg",
      serving: "2 eggs",
      calories: 155.123456,
      protein: 12.58,
      carbs: 1.12,
      fat: 10.61,
      photo_path: `${PATIENT_A}/food/old.jpg`,
      nutrition_snapshot: SNAPSHOT,
      catalog_shared: true,
      catalog_metadata: { catalogLookupId: "usda:171077", catalogApproved: true },
    };
    psql(`select public.patient_library_apply(
      '${PATIENT_A}', ${json([first])}, array[]::text[], '[]', array[]::text[],
      ${json(["cfg-exact"])}, ${json(["cfg-exact"])}
    )`);
    expect(scalar(`select nutrition_snapshot from public.patient_custom_foods where patient_id='${PATIENT_A}' and food_id='cfg-exact'`))
      .toEqual(SNAPSHOT);
    expect(scalar(`select catalog_metadata from public.patient_custom_foods where patient_id='${PATIENT_A}' and food_id='cfg-exact'`))
      .toEqual({ catalogLookupId: "usda:171077", catalogApproved: true });
    expect(scalar(`select count(*) from public.patient_custom_foods where patient_id='${PATIENT_B}'`)).toBe(0);
    expect(scalar(`select count(*) from public.patient_media where object_path='${PATIENT_A}/food/old.jpg'`)).toBe(1);

    const replacement = { ...first, photo_path: `${PATIENT_A}/food/new.jpg` };
    psql(`select public.patient_library_apply(
      '${PATIENT_A}', ${json([replacement])}, array[]::text[], '[]', array[]::text[], null, ${json(["cfg-exact", "egg"])}
    )`);
    expect(scalar(`select count(*) from public.patient_media where object_path='${PATIENT_A}/food/old.jpg'`)).toBe(0);
    expect(scalar(`select count(*) from public.patient_media where object_path='${PATIENT_A}/food/new.jpg'`)).toBe(1);
    expect(scalar(`select favorites from public.patient_food_prefs where patient_id='${PATIENT_A}'`)).toEqual(["cfg-exact"]);
    expect(scalar(`select recents from public.patient_food_prefs where patient_id='${PATIENT_A}'`)).toEqual(["cfg-exact", "egg"]);

    psql(`select public.patient_library_apply(
      '${PATIENT_A}', '[]', array['cfg-exact'], '[]', array[]::text[], ${json([])}, ${json([])}
    )`);
    expect(scalar(`select count(*) from public.patient_custom_foods where patient_id='${PATIENT_A}'`)).toBe(0);
    expect(scalar(`select count(*) from public.patient_media where patient_id='${PATIENT_A}'`)).toBe(0);
  });

  it("keeps both RPCs service-role only", () => {
    expect(scalar("select has_function_privilege('anon', 'public.patient_diary_apply(uuid,jsonb,text[],jsonb)', 'EXECUTE')")).toBe(false);
    expect(scalar("select has_function_privilege('authenticated', 'public.patient_library_apply(uuid,jsonb,text[],jsonb,text[],jsonb,jsonb)', 'EXECUTE')")).toBe(false);
    expect(scalar("select has_function_privilege('service_role', 'public.patient_diary_apply(uuid,jsonb,text[],jsonb)', 'EXECUTE')")).toBe(true);
  });
});