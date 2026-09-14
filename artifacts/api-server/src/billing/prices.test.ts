import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRecurringPrices } from "./prices";
import { __setStripeForTests } from "./stripe-client";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});
const originalFetch = global.fetch;
let officePrice: Record<string, any>;
let events: string[];
let stripe: any;
function response(json: unknown, status = 200) {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}
beforeEach(() => {
  officePrice = {
    provider_id: "office-1", product_id: "product-1", sell_price_cents: 6999,
    subscription_enabled: true, stripe_product_id: "prod_1", stripe_price_id: "price_old",
    stripe_shipping_price_id: "ship_old",
  };
  events = [];
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const table = url.pathname.split("/").at(-1);
    if ((init?.method ?? "GET") === "PATCH") {
      Object.assign(officePrice, JSON.parse(String(init?.body)));
      return response([officePrice]);
    }
    if (table === "billing_office_prices") return response([officePrice]);
    if (table === "billing_products") return response([{ id: "product-1", name: "Control" }]);
    if (table === "billing_connected_accounts") return response([{ provider_id: "office-1", stripe_account_id: "acct_1" }]);
    if (table === "billing_settings") return response([{ id: 1, shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30 }]);
    return response([]);
  }) as typeof fetch;
  stripe = {
    prices: {
      retrieve: vi.fn(async (id: string) => ({
        id, active: true, unit_amount: id === "ship_old" ? 1000 : 6999,
      })),
      create: vi.fn(async (params: any) => {
        events.push(`create:${params.unit_amount}`);
        return { id: params.unit_amount === 1000 ? "ship_new" : "price_new" };
      }),
      update: vi.fn(async (id: string) => { events.push(`archive:${id}`); return {}; }),
    },
    products: {
      retrieve: vi.fn(async (id: string) => ({ id })),
      create: vi.fn(async (params: any) => ({ id: params.name === "Shipping" ? "shipping_product" : "prod_new" })),
    },
  };
  __setStripeForTests(stripe);
});
afterAll(() => {
  global.fetch = originalFetch;
  __setStripeForTests(null);
});
describe("recurring Stripe price mirrors", () => {
  it("reuses active product and shipping prices when amounts match", async () => {
    const result = await ensureRecurringPrices("office-1", "product-1");
    expect(result).toMatchObject({ stripe_price_id: "price_old", stripe_shipping_price_id: "ship_old" });
    expect(stripe.prices.create).not.toHaveBeenCalled();
    expect(stripe.prices.update).not.toHaveBeenCalled();
  });

  it("creates replacements before archiving changed prices", async () => {
    stripe.prices.retrieve.mockImplementation(async (id: string) => ({
      id, active: true, unit_amount: id === "ship_old" ? 900 : 6500,
    }));
    await ensureRecurringPrices("office-1", "product-1");
    expect(events).toEqual(["create:6999", "archive:price_old", "create:1000", "archive:ship_old"]);
    expect(officePrice).toMatchObject({ stripe_price_id: "price_new", stripe_shipping_price_id: "ship_new" });
    const keys = stripe.prices.create.mock.calls.map((call: any[]) => call[1].idempotencyKey);
    expect(keys).toEqual([
      "price:office-1:product-1:6999:price_old:acct_1",
      "shipping-price:office-1:1000:ship_old:acct_1",
    ]);
  });

  it("rebuilds product and prices on a newly connected account without touching the old account's objects", async () => {
    const missing = new Stripe.errors.StripeInvalidRequestError({ message: "No such product", code: "resource_missing", type: "invalid_request_error" });
    stripe.products.retrieve.mockRejectedValue(missing);
    stripe.prices.retrieve.mockRejectedValue(missing);
    await ensureRecurringPrices("office-1", "product-1");
    expect(events).toEqual(["create:6999", "create:1000"]);
    expect(stripe.prices.update).not.toHaveBeenCalled();
    expect(stripe.products.create.mock.calls[0][0]).toMatchObject({ name: "Control" });
    expect(stripe.prices.create.mock.calls[0][0]).toMatchObject({ product: "prod_new" });
    expect(officePrice).toMatchObject({ stripe_product_id: "prod_new", stripe_price_id: "price_new", stripe_shipping_price_id: "ship_new" });
    const keys = stripe.prices.create.mock.calls.map((call: any[]) => call[1].idempotencyKey);
    expect(keys).toEqual(["price:office-1:product-1:6999:initial:acct_1", "shipping-price:office-1:1000:initial:acct_1"]);
  });

  it("surfaces transient Stripe failures instead of rebuilding duplicate objects", async () => {
    const outage = new Stripe.errors.StripeAPIError({ message: "Stripe is down", type: "api_error" });
    stripe.products.retrieve.mockRejectedValue(outage);
    await expect(ensureRecurringPrices("office-1", "product-1")).rejects.toBe(outage);
    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).not.toHaveBeenCalled();
  });
});