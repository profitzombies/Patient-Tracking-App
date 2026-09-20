import { beforeEach, describe, expect, vi } from "vitest";
import { it } from "./testing/context";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});
vi.mock("./stripe-client", () => ({
  connectedOpts: () => ({}), getStripe: async () => { throw new Error("stripe not needed"); }, isStripeMissing: () => false,
}));
import { setOfficePrice } from "./prices";

type Row = Record<string, unknown>;
let prices: Row[];
let changes: Row[];
const product: Row = {
  id: "product-1", slug: "control", name: "Control", description: "", floor_price_cents: 5999, hard_cost_cents: 433,
  active: true, status: "active", retired_at: null, archived_at: null, sort_order: 1, created_at: "2026-01-01T00:00:00Z",
};
const settings: Row = { id: 1, shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, version: 1 };
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
beforeEach(() => {
  prices = [];
  changes = [];
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Row : {};
    if (url.pathname === "/rest/v1/billing_settings") return response([settings]);
    if (url.pathname === "/rest/v1/billing_products") return response([product]);
    if (url.pathname === "/rest/v1/billing_product_images") return response([]);
    if (url.pathname === "/rest/v1/billing_office_prices") {
      if (method === "GET") return response(prices);
      if (method === "POST") { prices = [{ ...body }]; return response(prices, 201); }
      if (method === "DELETE") { prices = []; return response([]); }
    }
    if (url.pathname === "/rest/v1/billing_catalog_changes" && method === "POST") { changes.push(body); return response([body], 201); }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
});

describe("office price audit", () => {
  it("records who changed an office price, with the office and the before/after values", async () => {
    await setOfficePrice("live-office", "product-1", { sell_price_cents: 8999, subscription_enabled: false }, "staff-1");
    await setOfficePrice("live-office", "product-1", { sell_price_cents: 9999, subscription_enabled: false }, "staff-2");
    await setOfficePrice("live-office", "product-1", { sell_price_cents: null, subscription_enabled: false }, "staff-2");
    expect(changes).toEqual([
      expect.objectContaining({ kind: "office_price_updated", provider_id: "live-office", product_id: "product-1", actor_user_id: "staff-1", before: null, after: { sell_price_cents: 8999, subscription_enabled: false } }),
      expect.objectContaining({ actor_user_id: "staff-2", before: { sell_price_cents: 8999, subscription_enabled: false }, after: { sell_price_cents: 9999, subscription_enabled: false } }),
      expect.objectContaining({ before: { sell_price_cents: 9999, subscription_enabled: false }, after: null }),
    ]);
  });
  it("does not write an audit row when nothing changed", async () => {
    await setOfficePrice("live-office", "product-1", { sell_price_cents: 8999, subscription_enabled: false }, "staff-1");
    await setOfficePrice("live-office", "product-1", { sell_price_cents: 8999, subscription_enabled: false }, "staff-1");
    expect(changes).toHaveLength(1);
  });
  it("still rejects prices under the break-even minimum before touching the audit trail", async () => {
    await expect(setOfficePrice("live-office", "product-1", { sell_price_cents: 100, subscription_enabled: false }, "staff-1")).rejects.toMatchObject({ status: 400 });
    expect(changes).toHaveLength(0);
  });
});
