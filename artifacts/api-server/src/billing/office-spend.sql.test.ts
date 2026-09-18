/**
 * The office roster's lifetime-spend aggregate, run for real.
 *
 * Boots a throwaway PostgreSQL cluster (unix socket only), applies the
 * canonical spend migration verbatim on top of a minimal mirror of the
 * billing tables, and asserts the totals match the per-patient purchases
 * summary rules: paid / partially refunded / refunded orders count as paid,
 * only succeeded refunds subtract, last paid is paid_at falling back to
 * created_at, scope is the requested office only, unpaid and guest orders
 * never count, and the function is service-role only.
 *
 * Skips (loudly) when no PostgreSQL binaries are available.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261028000000_billing_office_patient_spend.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("office-spend.sql.test: PostgreSQL binaries not on PATH — SQL aggregate suite skipped");
}

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create table public.providers (provider_id text primary key);
create table public.patients (id uuid primary key, provider_id text not null references public.providers(provider_id));
create table public.billing_orders (
  id uuid primary key, provider_id text not null references public.providers(provider_id),
  patient_id uuid references public.patients(id) on delete set null,
  status text not null, total_cents integer not null, paid_at timestamptz,
  created_at timestamptz not null default now());
create table public.billing_refunds (
  id uuid primary key, order_id uuid not null references public.billing_orders(id),
  amount_cents integer not null, status text not null);
`;

let dir = "";
let dataDir = "";
const PORT = 54_400 + (process.pid % 1000);

function psql(sql: string): string {
  return execFileSync(
    "psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: "" } },
  );
}

function rows<T = Record<string, unknown>>(sql: string, role = "service_role"): T[] {
  const out = psql(`set test.role = '${role}'; select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

interface SpendRow {
  patient_id: string;
  paid_cents: number;
  refunded_cents: number;
  last_paid_at: string | null;
}

function spend(office: string): SpendRow[] {
  return rows<SpendRow>(`select * from public.billing_office_patient_spend('${office}') order by patient_id`);
}

let orderSeq = 100;
function insertOrder(office: string, patient: number | null, status: string, total: number, paidAt: string | null, createdAt: string): string {
  const id = uuid(++orderSeq);
  psql(
    `insert into public.billing_orders (id, provider_id, patient_id, status, total_cents, paid_at, created_at) values ('${id}', '${office}', ${patient == null ? "null" : `'${uuid(patient)}'`}, '${status}', ${total}, ${paidAt ? `'${paidAt}'` : "null"}, '${createdAt}')`,
  );
  return id;
}

function insertRefund(orderId: string, amount: number, status: string) {
  psql(`insert into public.billing_refunds (id, order_id, amount_cents, status) values ('${uuid(++orderSeq)}', '${orderId}', ${amount}, '${status}')`);
}

describe.skipIf(!POSTGRES_AVAILABLE)("billing_office_patient_spend (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "spend-"));
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
    psql("insert into public.providers (provider_id) values ('office-a'), ('office-b')");
    psql(`insert into public.patients (id, provider_id) values ('${uuid(1)}', 'office-a'), ('${uuid(2)}', 'office-a'), ('${uuid(3)}', 'office-b'), ('${uuid(4)}', 'office-a')`);
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies the canonical migration verbatim and is service-role only", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("billing_office_patient_spend");
    for (const role of ["anon", "authenticated"]) {
      expect(() => spend("office-a")).not.toThrow();
      expect(() => rows("select * from public.billing_office_patient_spend('office-a')", role)).toThrow(/service role required/);
    }
    const grants = rows<{ role: string; can: boolean }>(
      `select r.role, has_function_privilege(r.role, 'public.billing_office_patient_spend(text)', 'execute') as can
       from (values ('anon'), ('authenticated'), ('service_role')) as r(role)`,
    );
    expect(grants).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: true },
    ]);
  });

  it("returns no rows for an office without paid orders", () => {
    expect(spend("office-a")).toEqual([]);
  });

  it("sums paid orders net of succeeded refunds per patient, scoped to the office", () => {
    // Patient 1: two paid orders, one partially refunded (succeeded + a pending refund that must not count).
    const first = insertOrder("office-a", 1, "paid", 20_000, "2026-09-01T10:00:00Z", "2026-09-01T09:00:00Z");
    const second = insertOrder("office-a", 1, "partially_refunded", 30_000, null, "2026-09-10T09:00:00Z");
    insertRefund(second, 5_000, "succeeded");
    insertRefund(second, 1_000, "pending");
    insertRefund(first, 2_000, "failed");
    // Unpaid / failed / pending orders never count.
    insertOrder("office-a", 1, "pending", 99_000, null, "2026-09-12T09:00:00Z");
    insertOrder("office-a", 1, "failed", 99_000, null, "2026-09-13T09:00:00Z");
    // Patient 2: fully refunded order stays "paid" with the refund subtracted (net zero, still a row).
    const refunded = insertOrder("office-a", 2, "refunded", 12_000, "2026-08-20T10:00:00Z", "2026-08-20T09:00:00Z");
    insertRefund(refunded, 12_000, "succeeded");
    // Guest (no patient) orders and the other office's orders are invisible here.
    insertOrder("office-a", null, "paid", 7_000, "2026-09-05T10:00:00Z", "2026-09-05T09:00:00Z");
    insertOrder("office-b", 3, "paid", 9_900, "2026-09-11T10:00:00Z", "2026-09-11T09:00:00Z");
    // Patient 4 at office-a has an order recorded at office-b (moved practice): not office-a spend.
    insertOrder("office-b", 4, "paid", 5_000, "2026-09-11T10:00:00Z", "2026-09-11T09:00:00Z");

    expect(spend("office-a")).toEqual([
      // last paid = created_at of the later order because its paid_at is null.
      { patient_id: uuid(1), paid_cents: 50_000, refunded_cents: 5_000, last_paid_at: "2026-09-10T09:00:00+00:00" },
      { patient_id: uuid(2), paid_cents: 12_000, refunded_cents: 12_000, last_paid_at: "2026-08-20T10:00:00+00:00" },
    ]);
    expect(spend("office-b")).toEqual([
      { patient_id: uuid(3), paid_cents: 9_900, refunded_cents: 0, last_paid_at: "2026-09-11T10:00:00+00:00" },
      { patient_id: uuid(4), paid_cents: 5_000, refunded_cents: 0, last_paid_at: "2026-09-11T10:00:00+00:00" },
    ]);
  });

  it("does not multiply order totals when a patient has several refunds", () => {
    const order = insertOrder("office-a", 2, "partially_refunded", 40_000, "2026-09-14T10:00:00Z", "2026-09-14T09:00:00Z");
    insertRefund(order, 1_000, "succeeded");
    insertRefund(order, 2_000, "succeeded");
    insertRefund(order, 3_000, "succeeded");
    const row = spend("office-a").find((item) => item.patient_id === uuid(2));
    expect(row).toEqual({ patient_id: uuid(2), paid_cents: 52_000, refunded_cents: 18_000, last_paid_at: "2026-09-14T10:00:00+00:00" });
  });
});
