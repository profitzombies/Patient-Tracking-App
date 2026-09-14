import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  "../../../../supabase/migrations/20261011000000_billing_connect.sql",
  "../../../../supabase/migrations/20261013020000_billing_webhook_retry_count.sql",
  "../../../../supabase/migrations/20261013030000_billing_subscription_dunning.sql",
].map((migration) => path.resolve(here, migration));

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}

const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) {
  console.warn(
    "billing/billing.sql.test: PostgreSQL binaries not on PATH — suite skipped",
  );
}

let dir = "";
let dataDir = "";
const PORT = 54_400 + (process.pid % 1000);
const PSQL_ARGS = () => [
  "-h",
  dir,
  "-p",
  String(PORT),
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-X",
  "-q",
  "-At",
  "-v",
  "ON_ERROR_STOP=1",
];

function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function rows<T = Record<string, unknown>>(sql: string): T[] {
  const output = psql(
    `select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`,
  );
  return JSON.parse(output.trim() || "[]") as T[];
}

function scalar<T = unknown>(sql: string): T {
  return rows<{ value: T }>(`select (select ${sql}) as value`)[0].value;
}

function fails(sql: string): string {
  try {
    psql(sql);
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}

const TABLES = [
  "billing_settings",
  "billing_products",
  "billing_catalog_changes",
  "billing_connected_accounts",
  "billing_account_events",
  "billing_office_prices",
  "billing_payment_links",
  "billing_payers",
  "billing_orders",
  "billing_order_items",
  "billing_subscriptions",
  "billing_ledger",
  "billing_refunds",
  "billing_disputes",
  "billing_payouts",
  "billing_webhook_endpoints",
  "billing_webhook_events",
];

describe.skipIf(!POSTGRES_AVAILABLE)(
  "billing Connect SQL (real PostgreSQL)",
  () => {
    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), "billing-sql-"));
      dataDir = path.join(dir, "data");
      execFileSync(
        "initdb",
        ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"],
        { stdio: "ignore" },
      );
      execFileSync(
        "pg_ctl",
        [
          "-D",
          dataDir,
          "-w",
          "-o",
          `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`,
          "-l",
          path.join(dir, "log"),
          "start",
        ],
        { stdio: "ignore" },
      );
      psql(`
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
        create table public.providers (provider_id text primary key);
        create table public.patients (
          id uuid primary key,
          provider_id text references public.providers(provider_id)
        );
      `);
      for (let pass = 0; pass < 2; pass += 1) {
        for (const migration of MIGRATIONS) {
          execFileSync(
            "psql",
            [...PSQL_ARGS().filter((argument) => argument !== "-At"), "-f", migration],
            { stdio: "pipe", encoding: "utf8" },
          );
        }
      }
      psql(`insert into public.providers (provider_id) values ('provider-1')`);
    }, 60_000);

    afterAll(() => {
      if (dataDir) {
        spawnSync(
          "pg_ctl",
          ["-D", dataDir, "-m", "immediate", "stop"],
          { stdio: "ignore" },
        );
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("seeds the catalog and singleton settings defaults", () => {
      expect(scalar<number>("count(*) from public.billing_products")).toBe(10);
      expect(
        rows<{
          shipping_charge_cents: number;
          shipping_cost_cents: number;
          card_fee_bps: number;
          card_fee_fixed_cents: number;
        }>(`
          select shipping_charge_cents, shipping_cost_cents,
            card_fee_bps, card_fee_fixed_cents
          from public.billing_settings
        `),
      ).toEqual([
        {
          shipping_charge_cents: 1000,
          shipping_cost_cents: 1000,
          card_fee_bps: 290,
          card_fee_fixed_cents: 30,
        },
      ]);
    });

    it("uses the Stripe event id as an idempotency key", () => {
      const insert = `
        insert into public.billing_webhook_events
          (stripe_event_id, kind, type, livemode, payload)
        values ('evt_once', 'connect', 'invoice.paid', false, '{}'::jsonb)
        on conflict do nothing
        returning stripe_event_id
      `;
      expect(psql(insert).trim()).toBe("evt_once");
      expect(psql(insert).trim()).toBe("");
    });

    it("advances updated_at on office price updates", () => {
      const productId = scalar<string>(
        "id::text from public.billing_products order by sort_order limit 1",
      );
      psql(`
        insert into public.billing_office_prices
          (provider_id, product_id, sell_price_cents)
        values ('provider-1', '${productId}', 6000)
      `);
      const before = scalar<string>(
        `updated_at::text from public.billing_office_prices
         where provider_id = 'provider-1' and product_id = '${productId}'`,
      );
      psql(`
        update public.billing_office_prices
        set sell_price_cents = 6100
        where provider_id = 'provider-1' and product_id = '${productId}'
      `);
      const after = scalar<string>(
        `updated_at::text from public.billing_office_prices
         where provider_id = 'provider-1' and product_id = '${productId}'`,
      );
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    });

    it("rejects a second settings row", () => {
      expect(
        fails("insert into public.billing_settings (id) values (2)"),
      ).toContain("billing_settings_id_check");
    });

    it("adds constrained subscription dunning state and order failure detail", () => {
      expect(scalar<string>("column_default from information_schema.columns where table_schema='public' and table_name='billing_subscriptions' and column_name='payment_failure_count'")).toContain("0");
      expect(scalar<number>("count(*) from information_schema.columns where table_schema='public' and table_name='billing_orders' and column_name='failure_message'")).toBe(1);
      expect(scalar<number>("count(*) from pg_constraint where conname='billing_subscriptions_payment_failure_count_check'")).toBe(1);
    });

    it("rejects an order with an invalid status", () => {
      const payerId = psql(`
        insert into public.billing_payers (provider_id, name, email)
        values ('provider-1', 'Patient', 'patient@example.com')
        returning id
      `).trim();
      expect(
        fails(`
          insert into public.billing_orders (
            order_number, provider_id, payer_id, kind, status,
            subtotal_cents, shipping_charge_cents, tax_cents, total_cents,
            application_fee_cents, hard_cost_cents, shipping_cost_cents,
            shipping_address, livemode
          ) values (
            'TH-BAD001', 'provider-1', '${payerId}', 'one_time', 'unknown',
            1000, 1000, 0, 2000, 1600, 100, 1000, '{}'::jsonb, false
          )
        `),
      ).toContain("billing_orders_status_check");
    });

    it("enables RLS on all billing tables", () => {
      const tableList = TABLES.map((table) => `'${table}'`).join(",");
      const rls = rows<{ relname: string; enabled: boolean }>(`
        select relname, relrowsecurity as enabled
        from pg_class
        where relnamespace = 'public'::regnamespace
          and relname in (${tableList})
      `);
      expect(rls).toHaveLength(TABLES.length);
      expect(rls.every((table) => table.enabled)).toBe(true);
    });
  },
);