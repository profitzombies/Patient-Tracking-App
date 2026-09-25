/**
 * One-time reset: every existing office price for an active catalog product
 * becomes that product's Retail MSRP (billing_products.floor_price_cents).
 *
 *   tsx scripts/reset-office-prices-to-msrp.mts --actor <hq-user-uuid>           # dry run (default)
 *   tsx scripts/reset-office-prices-to-msrp.mts --actor <hq-user-uuid> --apply   # writes
 *
 * Each change goes through setOfficePrice, the same code path as an office
 * price edit: it writes the office_price_updated audit row (old → new) and
 * refreshes the office's Stripe recurring prices when subscriptions are on.
 * Payment links read the office price at checkout, so they follow at once.
 * Patient subscriptions are never touched: existing Stripe subscriptions keep
 * the price they were created with.
 *
 * Every payment identity (Test/Live platform account) that holds office prices
 * is covered by pinning the billing identity per group. Rows already at MSRP
 * are skipped, so a re-run makes no further changes. Each run writes a JSON
 * report to .local/state/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { thinnrSharePerUnit } from "../src/billing/fees";
import { setOfficePrice } from "../src/billing/prices";
import { getPlatformAccountId } from "../src/billing/stripe-client";
import { runWithBillingIdentity, type StripeMode } from "../src/billing/stripe-environment";
import { supabaseAdmin } from "../src/lib/supabase-admin";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const actor = args[args.indexOf("--actor") + 1];
if (!args.includes("--actor") || !actor || !/^[0-9a-f-]{36}$/i.test(actor)) {
  console.error("Pass --actor <HQ user uuid> (recorded on every audit row).");
  process.exit(2);
}

interface PriceRow {
  provider_id: string; product_id: string; sell_price_cents: number; subscription_enabled: boolean;
  enabled: boolean | null; stripe_mode: StripeMode; stripe_platform_account_id: string;
}
interface ProductRow { id: string; name: string; floor_price_cents: number; active: boolean; status: string }
interface ChangeLine {
  mode: StripeMode; platform_account_id: string; provider_id: string; office_name: string;
  product_id: string; product: string; old_cents: number; new_cents: number;
  looks_custom: boolean; subscription_enabled: boolean; result?: string;
}

async function rest<T>(path: string): Promise<T[]> {
  const response = await supabaseAdmin("GET", path);
  if (response.status >= 300 || !Array.isArray(response.json)) throw new Error(`Read failed: ${path} (${response.status})`);
  return response.json as T[];
}
/** The retired default was 2 × THINNR's 60% share, truncated to cents. */
const oldDefault = (floor: number) => 2 * thinnrSharePerUnit(floor);

const [rows, products, providers] = await Promise.all([
  rest<PriceRow>("/rest/v1/billing_office_prices?select=provider_id,product_id,sell_price_cents,subscription_enabled,enabled,stripe_mode,stripe_platform_account_id"),
  rest<ProductRow>("/rest/v1/billing_products?select=id,name,floor_price_cents,active,status"),
  rest<{ provider_id: string; office_name: string | null }>("/rest/v1/providers?select=provider_id,office_name"),
]);
const productById = new Map(products.map((product) => [product.id, product]));
const officeName = new Map(providers.map((provider) => [provider.provider_id, provider.office_name ?? provider.provider_id]));

const planned: ChangeLine[] = [];
const skipped: Array<{ provider_id: string; product_id: string; reason: string }> = [];
let alreadyAtMsrp = 0;
for (const row of rows) {
  const product = productById.get(row.product_id);
  if (!product || !product.active || product.status !== "active") {
    skipped.push({ provider_id: row.provider_id, product_id: row.product_id, reason: `product ${product?.status ?? "missing"} (not sold)` });
    continue;
  }
  if (row.sell_price_cents === product.floor_price_cents) { alreadyAtMsrp += 1; continue; }
  planned.push({
    mode: row.stripe_mode, platform_account_id: row.stripe_platform_account_id,
    provider_id: row.provider_id, office_name: officeName.get(row.provider_id) ?? row.provider_id,
    product_id: product.id, product: product.name, old_cents: row.sell_price_cents, new_cents: product.floor_price_cents,
    looks_custom: row.sell_price_cents !== oldDefault(product.floor_price_cents),
    subscription_enabled: row.subscription_enabled,
  });
}
planned.sort((a, b) => a.mode.localeCompare(b.mode) || a.office_name.localeCompare(b.office_name) || a.product.localeCompare(b.product));

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
console.log(`${apply ? "APPLY" : "DRY RUN"} — ${planned.length} price(s) to change, ${alreadyAtMsrp} already at Retail MSRP, ${skipped.length} skipped.`);
for (const line of planned) {
  console.log(`  [${line.mode}] ${line.office_name} · ${line.product}: ${dollars(line.old_cents)} → ${dollars(line.new_cents)}${line.looks_custom ? "  (custom price, not the old default)" : ""}`);
}
for (const skip of skipped) console.log(`  skipped ${skip.provider_id} / ${skip.product_id}: ${skip.reason}`);

let failures = 0;
if (apply) {
  const platformByMode = new Map<StripeMode, string>();
  for (const line of planned) {
    const byMode = platformByMode.get(line.mode) ?? await getPlatformAccountId(line.mode);
    platformByMode.set(line.mode, byMode);
    if (byMode !== line.platform_account_id) {
      line.result = `skipped: prices belong to platform ${line.platform_account_id}, configured ${line.mode} platform is ${byMode}`;
      failures += 1;
      continue;
    }
    try {
      const result = await runWithBillingIdentity({ mode: line.mode, platformAccountId: line.platform_account_id }, () =>
        setOfficePrice(line.provider_id, line.product_id, {
          sell_price_cents: line.new_cents, subscription_enabled: line.subscription_enabled,
        }, actor));
      line.result = result.stripe_mirror === "failed" ? "saved; Stripe mirror failed" : "saved";
      if (result.stripe_mirror === "failed") failures += 1;
    } catch (error) {
      line.result = `failed: ${error instanceof Error ? error.message : String(error)}`;
      failures += 1;
    }
    console.log(`  ${line.office_name} · ${line.product}: ${line.result}`);
  }
}

const dir = resolve(process.cwd(), "../../.local/state");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `msrp-price-reset-${apply ? "apply" : "dry-run"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ apply, actor, planned, alreadyAtMsrp, skipped }, null, 2));
console.log(`Report: ${file}`);
process.exit(failures ? 1 : 0);
