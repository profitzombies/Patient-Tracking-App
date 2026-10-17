/**
 * The app-access migration, applied for real on a temporary PostgreSQL
 * cluster over a minimal mirror of the tables it extends.
 *
 * Proven here, because the server trusts the database for each of them:
 *   - exactly one app-access product, inactive and draft (out of every
 *     storefront/price/launch query), re-applying the migration is a no-op;
 *   - the office settings checks (Stripe's 50¢ floor, cadence, trial bounds,
 *     "on" requires a price);
 *   - the per-identity Stripe price mirror: identity-guarded, one row per
 *     office per identity, closed to clients;
 *   - at most ONE open app-access subscription per patient per identity
 *     (closed rows and product subscriptions never collide);
 *   - a `not_required` order creates no shipment row and queues no warehouse
 *     submission when paid, while a physical order still does both.
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
const MIGRATION = path.resolve(here, "../../../../../supabase/migrations/20261210000000_app_access_subscriptions.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("app-access migration.sql.test: PostgreSQL binaries not on PATH — SQL suite skipped");

const IDENTITY = "'test', 'acct_platform'";
const PATIENT = "00000000-0000-4000-8000-000000000001";
const OTHER_PATIENT = "00000000-0000-4000-8000-000000000002";

/** Just enough of the billing schema (as the earlier migrations leave it) for this one to apply. */
const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create function public.guard_billing_identity() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.stripe_mode is null or new.stripe_platform_account_id is null then raise exception 'Billing identity is required'; end if;
  if tg_op = 'UPDATE' and (new.stripe_mode is distinct from old.stripe_mode
    or new.stripe_platform_account_id is distinct from old.stripe_platform_account_id) then raise exception 'Billing identity is immutable'; end if;
  return new;
end $$;
create function public.billing_touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create table public.billing_products (
  id uuid primary key default gen_random_uuid(), slug text not null unique, name text not null, description text not null default '',
  category text not null default 'supplement', floor_price_cents integer not null, hard_cost_cents integer not null,
  active boolean not null default true, status text not null default 'active', sort_order integer not null default 0,
  tagline text not null default '', format text not null default '', benefits jsonb not null default '[]'::jsonb,
  how_to_take text not null default '', facts_title text not null default '', facts jsonb not null default '[]'::jsonb,
  faqs jsonb not null default '[]'::jsonb, disclaimer text not null default '',
  constraint billing_products_category_check check (category in ('drops', 'supplement', 'bundle'))
);
insert into public.billing_products (slug, name, floor_price_cents, hard_cost_cents) values ('slimcell', 'SlimCell', 2000, 500);
create table public.billing_catalog_changes (
  id uuid primary key default gen_random_uuid(), kind text not null,
  constraint billing_catalog_changes_kind_check check (kind in ('product_created', 'settings_updated'))
);
create table public.billing_office_settings (
  provider_id text primary key, pick_pack_pass_through boolean, version integer not null default 1,
  updated_at timestamptz not null default now()
);
create table public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(), provider_id text not null, patient_id uuid, status text not null,
  stripe_mode text not null, stripe_platform_account_id text not null
);
create table public.billing_orders (
  id uuid primary key default gen_random_uuid(), provider_id text not null, patient_id uuid, status text not null default 'pending',
  fulfillment_status text not null default 'to_ship', stripe_mode text not null, stripe_platform_account_id text not null,
  constraint billing_orders_fulfillment_status_check check (fulfillment_status in ('to_ship', 'shipped', 'canceled'))
);
create table public.billing_shipments (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.billing_orders(id), provider_id text not null,
  status text not null, stripe_mode text not null, stripe_platform_account_id text not null,
  unique (order_id, stripe_mode, stripe_platform_account_id)
);
create table public.billing_warehouse_submissions (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.billing_orders(id), provider_id text not null,
  patient_id uuid, stripe_mode text not null, stripe_platform_account_id text not null,
  unique (order_id, stripe_mode, stripe_platform_account_id)
);
create function public.billing_order_create_shipment() returns trigger language plpgsql as $$ begin return new; end $$;
create function public.billing_order_queue_warehouse() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger billing_orders_create_shipment after insert on public.billing_orders for each row execute function public.billing_order_create_shipment();
create trigger billing_orders_queue_warehouse after insert or update of status on public.billing_orders for each row execute function public.billing_order_queue_warehouse();
`;

let dir = "";
let dataDir = "";
const PORT = 54_700 + (process.pid % 1000);

function psql(sql: string, options: { role?: string } = {}): string {
  const prefix = options.role ? `set role ${options.role}; ` : "";
  return execFileSync("psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", prefix + sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PGPASSWORD: "" } }).trim();
}
function applyMigration(): void {
  execFileSync("psql",
    ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", MIGRATION],
    { stdio: "pipe", env: { ...process.env, PGPASSWORD: "" } });
}
function subscription(input: { patient?: string | null; status: string; kind?: string; mode?: string }): string {
  return psql(`insert into public.billing_subscriptions (provider_id, patient_id, status, kind, stripe_mode, stripe_platform_account_id)
    values ('office-1', ${input.patient === null ? "null" : `'${input.patient ?? PATIENT}'`}, '${input.status}', '${input.kind ?? "app_access"}', '${input.mode ?? "test"}', 'acct_platform') returning id`);
}

beforeAll(() => {
  if (!POSTGRES_AVAILABLE) return;
  dir = mkdtempSync(path.join(tmpdir(), "app-access-sql-"));
  dataDir = path.join(dir, "data");
  execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"], { stdio: "ignore" });
  execFileSync("pg_ctl", ["-D", dataDir, "-o", `-p ${PORT} -k ${dir} -c listen_addresses=`, "-w", "start"], { stdio: "ignore" });
  psql(SCHEMA);
  applyMigration();
  applyMigration(); // idempotent: re-running the canonical file changes nothing
}, 120_000);

afterAll(() => {
  if (!dataDir) return;
  spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!POSTGRES_AVAILABLE)("app-access migration", () => {
  it("seeds exactly one inactive, draft app-access product and refuses a second", () => {
    expect(psql("select id || '|' || kind || '|' || category || '|' || active || '|' || status || '|' || floor_price_cents from public.billing_products where kind = 'app_access'"))
      .toBe("a99acce5-0000-4000-8000-000000000001|app_access|app_access|false|draft|0");
    expect(psql("select count(*) from public.billing_products")).toBe("2");
    expect(psql("select kind from public.billing_products where slug = 'slimcell'")).toBe("physical");
    expect(() => psql("insert into public.billing_products (slug, name, kind, category, floor_price_cents, hard_cost_cents) values ('app-2', 'Another', 'app_access', 'app_access', 0, 0)"))
      .toThrow(/billing_products_app_access_single_idx/);
    expect(() => psql("insert into public.billing_products (slug, name, kind, floor_price_cents, hard_cost_cents) values ('odd', 'Odd', 'digital', 0, 0)"))
      .toThrow(/billing_products_kind_check/);
  });

  it("starts every office off, monthly, with a 7-day trial, and checks the settings", () => {
    psql("insert into public.billing_office_settings (provider_id) values ('office-1')");
    expect(psql("select app_access_enabled || '|' || coalesce(app_access_price_cents::text, 'null') || '|' || app_access_cadence || '|' || app_access_trial_days from public.billing_office_settings where provider_id = 'office-1'"))
      .toBe("false|null|monthly|7");
    expect(() => psql("update public.billing_office_settings set app_access_enabled = true where provider_id = 'office-1'")).toThrow(/enabled_price_check/);
    expect(() => psql("update public.billing_office_settings set app_access_price_cents = 49 where provider_id = 'office-1'")).toThrow(/app_access_price_check/);
    expect(() => psql("update public.billing_office_settings set app_access_cadence = 'weekly' where provider_id = 'office-1'")).toThrow(/cadence_check/);
    expect(() => psql("update public.billing_office_settings set app_access_trial_days = 366 where provider_id = 'office-1'")).toThrow(/trial_check/);
    expect(() => psql("update public.billing_office_settings set app_access_trial_days = -1 where provider_id = 'office-1'")).toThrow(/trial_check/);
    psql("update public.billing_office_settings set app_access_enabled = true, app_access_price_cents = 699, app_access_cadence = '2_weeks', app_access_trial_days = 0 where provider_id = 'office-1'");
    expect(psql("select app_access_enabled || '|' || app_access_price_cents || '|' || app_access_cadence from public.billing_office_settings where provider_id = 'office-1'")).toBe("true|699|2_weeks");
    expect(psql("select count(*) from pg_constraint where conname = 'billing_catalog_changes_kind_check' and pg_get_constraintdef(oid) like '%office_app_access_settings_updated%'")).toBe("1");
  });

  it("keeps the Stripe price mirror per identity, guarded, and closed to clients", () => {
    psql(`insert into public.billing_app_access_prices (provider_id, price_cents, cadence, stripe_product_id, stripe_price_id, stripe_mode, stripe_platform_account_id)
      values ('office-1', 699, '2_weeks', 'prod_a', 'price_a', ${IDENTITY})`);
    // Same office, other mode: a separate mirror.
    psql(`insert into public.billing_app_access_prices (provider_id, price_cents, cadence, stripe_mode, stripe_platform_account_id)
      values ('office-1', 699, '2_weeks', 'live', 'acct_platform')`);
    expect(() => psql(`insert into public.billing_app_access_prices (provider_id, price_cents, cadence, stripe_mode, stripe_platform_account_id)
      values ('office-1', 999, 'monthly', ${IDENTITY})`)).toThrow(/billing_app_access_prices_provider_key/);
    expect(() => psql(`insert into public.billing_app_access_prices (provider_id, price_cents, cadence, stripe_mode, stripe_platform_account_id)
      values ('office-2', 49, 'monthly', ${IDENTITY})`)).toThrow(/price_cents_check/);
    expect(() => psql("update public.billing_app_access_prices set stripe_mode = 'live' where provider_id = 'office-1' and stripe_mode = 'test'")).toThrow(/immutable/);
    const before = psql("select updated_at from public.billing_app_access_prices where stripe_price_id = 'price_a'");
    psql("select pg_sleep(0.01); update public.billing_app_access_prices set price_cents = 799 where stripe_price_id = 'price_a'");
    expect(psql("select updated_at > $$" + before + "$$::timestamptz from public.billing_app_access_prices where stripe_price_id = 'price_a'")).toBe("t");
    for (const role of ["anon", "authenticated"]) {
      expect(() => psql("select count(*) from public.billing_app_access_prices", { role })).toThrow(/permission denied/i);
    }
    expect(psql("select relrowsecurity from pg_class where oid = 'public.billing_app_access_prices'::regclass")).toBe("t");
  });

  it("allows at most one open app-access subscription per patient per identity", () => {
    expect(psql("select count(*) from public.billing_subscriptions")).toBe("0");
    const first = subscription({ status: "incomplete" });
    expect(() => subscription({ status: "active" })).toThrow(/billing_subscriptions_app_access_open_idx/);
    // Closing the first frees the slot; closed rows pile up harmlessly.
    psql(`update public.billing_subscriptions set status = 'canceled' where id = '${first}'`);
    subscription({ status: "canceled" });
    const second = subscription({ status: "active" });
    expect(() => subscription({ status: "past_due" })).toThrow(/open_idx/);
    // Other patients, other identities and product subscriptions never collide.
    subscription({ status: "active", patient: OTHER_PATIENT });
    subscription({ status: "active", mode: "live" });
    subscription({ status: "active", kind: "product" });
    subscription({ status: "active", kind: "product" });
    subscription({ status: "active", patient: null });
    subscription({ status: "active", patient: null });
    expect(() => subscription({ status: "active", kind: "digital" })).toThrow(/billing_subscriptions_kind_check/);
    expect(psql(`select kind from public.billing_subscriptions where id = '${second}'`)).toBe("app_access");
    expect(psql("select count(*) from public.billing_subscriptions where kind = 'product'")).toBe("2");
  });

  it("creates no shipment and queues no warehouse order for a not_required order", () => {
    const app = psql(`insert into public.billing_orders (provider_id, patient_id, status, fulfillment_status, stripe_mode, stripe_platform_account_id)
      values ('office-1', '${PATIENT}', 'pending', 'not_required', ${IDENTITY}) returning id`);
    const physical = psql(`insert into public.billing_orders (provider_id, patient_id, status, stripe_mode, stripe_platform_account_id)
      values ('office-1', '${PATIENT}', 'pending', ${IDENTITY}) returning id`);
    expect(psql(`select count(*) from public.billing_shipments where order_id = '${app}'`)).toBe("0");
    expect(psql(`select status || '|' || stripe_mode from public.billing_shipments where order_id = '${physical}'`)).toBe("processing|test");
    psql(`update public.billing_orders set status = 'paid' where id in ('${app}', '${physical}')`);
    expect(psql(`select count(*) from public.billing_warehouse_submissions where order_id = '${app}'`)).toBe("0");
    expect(psql(`select provider_id || '|' || patient_id from public.billing_warehouse_submissions where order_id = '${physical}'`)).toBe(`office-1|${PATIENT}`);
    // A paid app-access order that is later re-saved still queues nothing.
    psql(`update public.billing_orders set status = 'pending' where id = '${app}'`);
    psql(`update public.billing_orders set status = 'paid' where id = '${app}'`);
    expect(psql(`select count(*) from public.billing_warehouse_submissions where order_id = '${app}'`)).toBe("0");
    expect(() => psql(`update public.billing_orders set fulfillment_status = 'digital' where id = '${app}'`)).toThrow(/fulfillment_status_check/);
  });
});
