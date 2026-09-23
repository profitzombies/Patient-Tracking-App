/**
 * claim_office_access_charge, run for real.
 *
 * This is the guard that stops an office being charged twice for one period,
 * so it is proven against a real PostgreSQL cluster rather than a stand-in:
 * the canonical migration is applied on top of a minimal mirror of the tables
 * it depends on, and the claim is exercised through every state a period can
 * be in — nothing yet, a debit in flight, a failed attempt, a settled one, and
 * a named recovery cycle that already ran.
 *
 * Skips (loudly) when no PostgreSQL binaries are available.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../../supabase/migrations/20261125000000_office_access_subscriptions.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn("office-access claim.sql.test: PostgreSQL binaries not on PATH — SQL suite skipped");
}

/**
 * Just enough of the surrounding schema for the migration to apply: the HQ
 * settings row it extends, and a stand-in for the billing identity guard the
 * mode-isolation migration installs (non-null and immutable; the cross-table
 * reference check it also performs is proven where that migration lives).
 */
const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.hq_organization_settings (id uuid primary key default gen_random_uuid());
create function public.guard_billing_identity() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.stripe_mode is null or new.stripe_platform_account_id is null then
    raise exception 'Billing identity is required';
  end if;
  if tg_op = 'UPDATE' and (
    new.stripe_mode is distinct from old.stripe_mode or
    new.stripe_platform_account_id is distinct from old.stripe_platform_account_id
  ) then raise exception 'Billing identity is immutable'; end if;
  return new;
end $$;
`;

let dir = "";
let dataDir = "";
const PORT = 54_600 + (process.pid % 1000);

function psql(sql: string, options: { role?: string } = {}): string {
  const prefix = options.role ? `set role ${options.role}; ` : "";
  return execFileSync(
    "psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", prefix + sql],
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: "" } },
  ).trim();
}

const MODE = "test";
const ACCOUNT = "acct_platform";
const PERIOD = "2026-05-01T00:00:00Z";
const OTHER_PERIOD = "2026-06-01T00:00:00Z";
let subscriptionId = "";

/** What the server would call before it talks to Stripe. */
function claim(period = PERIOD, cycle: number | null = null): number | null {
  const out = psql(
    `select coalesce(public.claim_office_access_charge('${subscriptionId}'::uuid, '${period}'::timestamptz, ${cycle ?? "null"})::text, '')`,
  );
  return out === "" ? null : Number(out);
}

function attempt(input: { cycle: number; slot: string; status: string; period?: string }): void {
  psql(
    `insert into public.billing_office_access_attempts
       (subscription_id, provider_id, period_start, period_end, cycle, slot, plan, amount_cents, status, stripe_mode, stripe_platform_account_id)
     values ('${subscriptionId}', 'office-1', '${input.period ?? PERIOD}'::timestamptz, '2026-06-01T00:00:00Z'::timestamptz,
             ${input.cycle}, '${input.slot}', 'monthly', 20000, '${input.status}', '${MODE}', '${ACCOUNT}')`,
  );
}

function reset(): void {
  psql(`delete from public.billing_office_access_attempts where subscription_id = '${subscriptionId}'`);
}

beforeAll(() => {
  if (!POSTGRES_AVAILABLE) return;
  dir = mkdtempSync(path.join(tmpdir(), "office-access-sql-"));
  dataDir = path.join(dir, "data");
  execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"], { stdio: "ignore" });
  execFileSync("pg_ctl", ["-D", dataDir, "-o", `-p ${PORT} -k ${dir} -c listen_addresses=`, "-w", "start"], { stdio: "ignore" });
  psql(SCHEMA);
  execFileSync(
    "psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", MIGRATION],
    { stdio: "pipe", env: { ...process.env, PGPASSWORD: "" } },
  );
  subscriptionId = psql(
    `insert into public.billing_office_access_subscriptions (provider_id, stripe_mode, stripe_platform_account_id)
     values ('office-1', '${MODE}', '${ACCOUNT}') returning id`,
  );
}, 120_000);

afterAll(() => {
  if (!dataDir) return;
  spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!POSTGRES_AVAILABLE)("claim_office_access_charge", () => {
  it("hands out the first cycle for an unbilled period", () => {
    reset();
    expect(claim()).toBe(1);
    // Claiming is not a write: it stays 1 until an attempt is recorded.
    expect(claim()).toBe(1);
  });

  it("refuses while a debit is still in flight", () => {
    reset();
    attempt({ cycle: 1, slot: "bank", status: "processing" });
    expect(claim()).toBeNull();
    // ...and only for that period; other periods are unaffected.
    expect(claim(OTHER_PERIOD)).toBe(1);
  });

  it("hands out the next cycle once an attempt has failed", () => {
    reset();
    attempt({ cycle: 1, slot: "bank", status: "failed" });
    attempt({ cycle: 1, slot: "card_primary", status: "failed" });
    expect(claim()).toBe(2);
  });

  it("never claims a period that has already been collected", () => {
    reset();
    attempt({ cycle: 1, slot: "bank", status: "failed" });
    attempt({ cycle: 1, slot: "card_primary", status: "succeeded" });
    expect(claim()).toBeNull();
    expect(claim(PERIOD, 2)).toBeNull();
    expect(claim(PERIOD, 7)).toBeNull();
  });

  it("treats a named recovery cycle that already ran as a replay", () => {
    reset();
    attempt({ cycle: 1, slot: "bank", status: "failed" });
    attempt({ cycle: 2, slot: "bank", status: "failed" });
    expect(claim(PERIOD, 2)).toBeNull();
    expect(claim(PERIOD, 3)).toBe(3);
  });

  it("refuses a duplicate attempt row for one cycle and slot", () => {
    reset();
    attempt({ cycle: 1, slot: "bank", status: "failed" });
    expect(() => attempt({ cycle: 1, slot: "bank", status: "failed" })).toThrow(/duplicate key|unique/i);
  });

  it("requires the period, and is reachable only by the server", () => {
    expect(() => psql(`select public.claim_office_access_charge('${subscriptionId}'::uuid, null, null)`)).toThrow(/required/i);
    expect(() => psql(`select public.claim_office_access_charge('${subscriptionId}'::uuid, '${PERIOD}'::timestamptz, null)`, { role: "anon" }))
      .toThrow(/permission denied/i);
    expect(() => psql(`select public.claim_office_access_charge('${subscriptionId}'::uuid, '${PERIOD}'::timestamptz, null)`, { role: "authenticated" }))
      .toThrow(/permission denied/i);
    expect(Number(psql(`select public.claim_office_access_charge('${subscriptionId}'::uuid, '${OTHER_PERIOD}'::timestamptz, null)`, { role: "service_role" }))).toBeGreaterThan(0);
  });

  it("keeps the access tables closed to clients", () => {
    for (const table of [
      "billing_office_access_subscriptions", "billing_office_access_instruments",
      "billing_office_access_attempts", "billing_office_access_events",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        expect(() => psql(`select count(*) from public.${table}`, { role })).toThrow(/permission denied/i);
      }
      expect(psql(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).toBe("t");
    }
  });
});
