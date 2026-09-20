import { beforeEach, describe, expect, vi } from "vitest";
import { it } from "./testing/context";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

type Row = Record<string, any>;
type FakePrice = { id: string; product: string; active: boolean; unit_amount: number; recurring: { interval: string; interval_count: number } };
const stripeState = vi.hoisted(() => ({
  prices: new Map<string, FakePrice>(),
  products: new Set<string>(),
  created: [] as { key: string; unit_amount: number; weeks: number; product: string }[],
  archived: [] as string[],
  counter: 0,
}));
class MissingError extends Error { code = "resource_missing"; }
vi.mock("./stripe-client", () => ({
  connectedOpts: (acct: string, key?: string) => ({ stripeAccount: acct, ...(key ? { idempotencyKey: key } : {}) }),
  isStripeMissing: (error: unknown) => error instanceof MissingError,
  getStripe: async () => ({
    products: {
      retrieve: async (id: string) => { if (!stripeState.products.has(id)) throw new MissingError(id); return { id }; },
      create: async (_body: Row, opts: { idempotencyKey: string }) => {
        const id = `prod_${opts.idempotencyKey.replace(/[^a-z0-9]/gi, "").slice(0, 12)}_${++stripeState.counter}`;
        stripeState.products.add(id);
        return { id };
      },
    },
    prices: {
      retrieve: async (id: string) => { const price = stripeState.prices.get(id); if (!price) throw new MissingError(id); return price; },
      create: async (body: Row, opts: { idempotencyKey: string }) => {
        const id = `price_${++stripeState.counter}`;
        const price: FakePrice = { id, product: body.product, active: true, unit_amount: body.unit_amount, recurring: body.recurring };
        stripeState.prices.set(id, price);
        stripeState.created.push({ key: opts.idempotencyKey, unit_amount: body.unit_amount, weeks: body.recurring.interval_count, product: body.product });
        return price;
      },
      update: async (id: string, body: Row) => {
        const price = stripeState.prices.get(id);
        if (!price) throw new MissingError(id);
        if (body.active === false) { price.active = false; stripeState.archived.push(id); }
        return price;
      },
    },
  }),
}));
import { ensureRecurringPrices } from "./prices";

let priceRow: Row;
let product: Row;
let settings: Row;
const account: Row = { provider_id: "office-1", stripe_account_id: "acct_1", disconnected_at: null };
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function seedStripe(id: string, product: string, unit_amount: number, weeks: number) {
  stripeState.products.add(product);
  stripeState.prices.set(id, { id, product, active: true, unit_amount, recurring: { interval: "week", interval_count: weeks } });
}
beforeEach(() => {
  stripeState.prices.clear(); stripeState.products.clear();
  stripeState.created = []; stripeState.archived = []; stripeState.counter = 0;
  product = {
    id: "product-1", slug: "control", name: "Control", floor_price_cents: 5999, hard_cost_cents: 433, active: true, status: "active",
    offered_cadences_weeks: [4], default_cadence_weeks: 4,
  };
  settings = { id: 1, shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, version: 1, subscribe_save_enabled: false, subscribe_save_percent: 10 };
  // An office that mirrored its 4-week price before cadences existed.
  priceRow = {
    provider_id: "office-1", product_id: "product-1", sell_price_cents: 6999, subscription_enabled: true,
    stripe_product_id: "prod_legacy", stripe_price_id: "price_legacy", stripe_shipping_price_id: "price_ship_legacy", stripe_cadence_prices: {},
  };
  seedStripe("price_legacy", "prod_legacy", 6999, 4);
  seedStripe("price_ship_legacy", "prod_ship", 1000, 4);
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    if (url.pathname === "/rest/v1/billing_settings") return response([settings]);
    if (url.pathname === "/rest/v1/billing_products") return response([product]);
    if (url.pathname === "/rest/v1/billing_connected_accounts") return response([account]);
    if (url.pathname === "/rest/v1/billing_office_prices") {
      if (method === "GET") return response([priceRow]);
      if (method === "PATCH") { priceRow = { ...priceRow, ...JSON.parse(String(init?.body)) }; return response([priceRow]); }
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
});

describe("cadence-aware recurring price mirror", () => {
  it("recognizes the legacy 4-week price as the 4-week cadence and creates nothing new", async () => {
    await ensureRecurringPrices("office-1", "product-1");
    expect(stripeState.created).toEqual([]);
    expect(priceRow.stripe_price_id).toBe("price_legacy");
    expect(priceRow.stripe_cadence_prices).toEqual({
      "4": { price_id: "price_legacy", unit_amount_cents: 6999, shipping_price_id: "price_ship_legacy" },
    });
  });

  it("creates one recurring price and one shipping price per offered cadence, keyed by cadence and amount", async () => {
    product.offered_cadences_weeks = [2, 4, 8];
    await ensureRecurringPrices("office-1", "product-1");
    const products = stripeState.created.map((entry) => `${entry.weeks}w:${entry.unit_amount}:${entry.product}`).sort();
    expect(products).toEqual(["2w:1000:prod_ship", "2w:6999:prod_legacy", "8w:1000:prod_ship", "8w:6999:prod_legacy"]);
    expect(stripeState.created.map((entry) => entry.key).sort()).toEqual([
      "price:office-1:product-1:2w:6999:initial:acct_1",
      "price:office-1:product-1:8w:6999:initial:acct_1",
      "shipping-price:office-1:2w:1000:initial:acct_1",
      "shipping-price:office-1:8w:1000:initial:acct_1",
    ]);
    const mirror = priceRow.stripe_cadence_prices as Record<string, Row>;
    expect(Object.keys(mirror).sort()).toEqual(["2", "4", "8"]);
    expect(mirror["4"].price_id).toBe("price_legacy");
    expect(stripeState.prices.get(mirror["2"].price_id)?.recurring.interval_count).toBe(2);
    expect(stripeState.prices.get(mirror["8"].shipping_price_id)?.recurring.interval_count).toBe(8);
    // Nothing is touched on a second pass with the same inputs.
    stripeState.created = [];
    await ensureRecurringPrices("office-1", "product-1");
    expect(stripeState.created).toEqual([]);
  });

  it("quotes subscribe-and-save as a discounted recurring price and leaves the legacy full-price 4-week price alone", async () => {
    product.offered_cadences_weeks = [4, 6];
    settings.subscribe_save_enabled = true;
    settings.subscribe_save_percent = 15;
    await ensureRecurringPrices("office-1", "product-1");
    // 6999 - round(1049.85) = 5949
    const created = stripeState.created.filter((entry) => entry.product === "prod_legacy");
    expect(created.map((entry) => `${entry.weeks}w:${entry.unit_amount}`).sort()).toEqual(["4w:5949", "6w:5949"]);
    expect(created.every((entry) => entry.key.includes(":5949:"))).toBe(true);
    expect(priceRow.stripe_price_id).toBe("price_legacy");
    expect(stripeState.prices.get("price_legacy")?.active).toBe(true);
    expect(stripeState.archived).toEqual([]);
    const mirror = priceRow.stripe_cadence_prices as Record<string, Row>;
    expect(mirror["4"].unit_amount_cents).toBe(5949);
    expect(mirror["4"].price_id).not.toBe("price_legacy");
    // Existing subscriptions keep renewing on the untouched legacy price; the
    // 4-week shipping price still matches and is reused.
    expect(mirror["4"].shipping_price_id).toBe("price_ship_legacy");
  });

  it("switching the discount off replaces the discounted prices under versioned keys and archives them", async () => {
    product.offered_cadences_weeks = [4, 6];
    settings.subscribe_save_enabled = true;
    settings.subscribe_save_percent = 15;
    await ensureRecurringPrices("office-1", "product-1");
    const discounted = { ...(priceRow.stripe_cadence_prices as Record<string, Row>) };
    stripeState.created = [];
    settings.subscribe_save_enabled = false;
    await ensureRecurringPrices("office-1", "product-1");
    const mirror = priceRow.stripe_cadence_prices as Record<string, Row>;
    // 4 weeks at full price is the legacy price again; 6 weeks needs a fresh price
    // whose key names the id it replaces, and the replaced price is archived.
    expect(mirror["4"].price_id).toBe("price_legacy");
    expect(mirror["6"].unit_amount_cents).toBe(6999);
    expect(stripeState.created.map((entry) => entry.key)).toEqual([
      `price:office-1:product-1:6w:6999:${discounted["6"].price_id}:acct_1`,
    ]);
    expect(stripeState.archived).toEqual([discounted["6"].price_id]);
    expect(stripeState.prices.get(discounted["4"].price_id)?.active).toBe(true);
  });

  it("rebuilds cadence prices that vanished from the connected account without archiving anything", async () => {
    product.offered_cadences_weeks = [4, 12];
    await ensureRecurringPrices("office-1", "product-1");
    const before = { ...(priceRow.stripe_cadence_prices as Record<string, Row>) };
    stripeState.prices.delete(before["12"].price_id);
    stripeState.created = [];
    await ensureRecurringPrices("office-1", "product-1");
    const mirror = priceRow.stripe_cadence_prices as Record<string, Row>;
    expect(mirror["12"].price_id).not.toBe(before["12"].price_id);
    expect(mirror["12"].shipping_price_id).toBe(before["12"].shipping_price_id);
    expect(stripeState.created.map((entry) => entry.key)).toEqual([
      `price:office-1:product-1:12w:6999:${before["12"].price_id}:acct_1`,
    ]);
    expect(stripeState.archived).toEqual([]);
  });

  it("keeps mirrors for cadences HQ stops offering but no longer refreshes them", async () => {
    product.offered_cadences_weeks = [4, 10];
    await ensureRecurringPrices("office-1", "product-1");
    const tenWeek = (priceRow.stripe_cadence_prices as Record<string, Row>)["10"];
    product.offered_cadences_weeks = [4];
    settings.subscribe_save_enabled = true;
    stripeState.created = [];
    await ensureRecurringPrices("office-1", "product-1");
    const mirror = priceRow.stripe_cadence_prices as Record<string, Row>;
    expect(mirror["10"]).toEqual(tenWeek);
    expect(stripeState.created.map((entry) => entry.weeks)).toEqual([4]);
  });
});
