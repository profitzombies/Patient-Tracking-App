import { beforeEach, describe, expect, vi } from "vitest";
import { it } from "./testing/context";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});
vi.mock("./stripe-client", () => ({
  connectedOpts: () => ({}), getStripe: async () => { throw new Error("stripe not needed"); }, isStripeMissing: () => false,
}));
import { officeOffering, subscriptionUnitPrice } from "./catalog";
import { quoteOrder } from "./orders";
import { listOfficePrices } from "./prices";
import type { BillingPaymentLinkRow } from "./store";

type Row = Record<string, any>;
let settings: Row;
let products: Row[];
let prices: Row[];
const page = {
  category: "supplement", tagline: "Metabolic & Appetite Support", format: "Dietary Supplement · 60 Vegetarian Capsules",
  benefits: ["Helps support healthy appetite**"], how_to_take: "Take as directed on the label and by your THINNR provider.",
  facts_title: "Key Ingredients", facts: [{ name: "African Mango", detail: "Helps support healthy appetite and metabolic function.**" }],
  faqs: [{ question: "Where can I get Control?", answer: "Available through certified THINNR healthcare providers." }],
  disclaimer: "**These statements have not been evaluated by the US FDA.",
};
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
beforeEach(() => {
  settings = { id: 1, shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, version: 1, subscribe_save_enabled: false, subscribe_save_percent: 10 };
  products = [
    { id: "control", slug: "control", name: "Control", description: "Control copy", floor_price_cents: 5999, hard_cost_cents: 433, active: true, status: "active", sort_order: 1, stripe_tax_code: null, ...page, offered_cadences_weeks: [2, 4, 8], default_cadence_weeks: 4 },
    { id: "fiber", slug: "fiber", name: "Fiber", description: "", floor_price_cents: 2999, hard_cost_cents: 427, active: true, status: "active", sort_order: 2, stripe_tax_code: null, offered_cadences_weeks: [4, 6], default_cadence_weeks: 6 },
    { id: "boost", slug: "boost", name: "Boost", description: "", floor_price_cents: 11999, hard_cost_cents: 990, active: false, status: "draft", sort_order: 3, stripe_tax_code: null },
  ];
  prices = [{ provider_id: "office-1", product_id: "control", sell_price_cents: 6999, subscription_enabled: true, stripe_cadence_prices: {} }];
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    if (url.pathname === "/rest/v1/billing_settings") return response([settings]);
    if (url.pathname === "/rest/v1/billing_products") {
      return response(url.searchParams.get("active") === "eq.true" ? products.filter((row) => row.active) : products);
    }
    if (url.pathname === "/rest/v1/billing_product_images") return response([]);
    if (url.pathname === "/rest/v1/billing_office_prices" && method === "GET") return response(prices);
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
});

describe("payer-facing offering", () => {
  it("lists priced products first, then unpriced active products at the floor price, with page content and no discount while off", async () => {
    const offering = await officeOffering("office-1");
    expect(offering.map((item) => [item.product_id, item.unit_price_cents, item.office_priced])).toEqual([
      ["control", 6999, true], ["fiber", 2999, false],
    ]);
    expect(offering[0]).toMatchObject({
      ...page, subscription_available: true, subscription_cadences_weeks: [2, 4, 8], default_cadence_weeks: 4,
      subscribe_save_percent: 0, subscription_unit_price_cents: 6999,
    });
    // Unpriced products cannot be subscribed to (there is no office price to mirror).
    expect(offering[1]).toMatchObject({
      category: "supplement", tagline: "", benefits: [], facts: [], faqs: [],
      subscription_available: false, subscription_cadences_weeks: [], default_cadence_weeks: 6,
      subscribe_save_percent: 0, subscription_unit_price_cents: null,
    });
  });
  it("quotes the subscribe-and-save price only while the HQ switch is on", async () => {
    settings.subscribe_save_enabled = true;
    settings.subscribe_save_percent = 15;
    const [control, fiber] = await officeOffering("office-1");
    expect(control).toMatchObject({ unit_price_cents: 6999, subscribe_save_percent: 15, subscription_unit_price_cents: 5949 });
    expect(fiber).toMatchObject({ subscribe_save_percent: 0, subscription_unit_price_cents: null });
    expect(subscriptionUnitPrice(6999, 15)).toBe(5949);
    expect(subscriptionUnitPrice(6999, 0)).toBe(6999);
  });
  it("sells an unpriced product one-time at the floor price but never as a subscription", async () => {
    const link = { provider_id: "office-1" } as BillingPaymentLinkRow;
    const quote = await quoteOrder(link, [{ product_id: "fiber", quantity: 2 }], "one_time");
    expect(quote.lines[0]).toMatchObject({ unit_price_cents: 2999, floor_price_cents: 2999 });
    expect(quote.subtotal_cents).toBe(5998);
    await expect(quoteOrder(link, [{ product_id: "fiber", quantity: 1 }], "subscription")).rejects.toMatchObject({ status: 400, field: "items" });
    await expect(quoteOrder(link, [{ product_id: "boost", quantity: 1 }], "one_time")).rejects.toMatchObject({ status: 400 });
  });
  it("still prefers the office's own price and rejects one that fell under the minimum", async () => {
    const link = { provider_id: "office-1" } as BillingPaymentLinkRow;
    const quote = await quoteOrder(link, [{ product_id: "control", quantity: 1 }], "subscription");
    expect(quote.lines[0].unit_price_cents).toBe(6999);
    prices[0].sell_price_cents = 100;
    await expect(quoteOrder(link, [{ product_id: "control", quantity: 1 }], "one_time")).rejects.toMatchObject({ status: 409 });
  });
});

describe("office price list", () => {
  it("shows cadences, tagline, and the subscription price per product, and the subscribe-and-save setting", async () => {
    const listed = await listOfficePrices("office-1");
    expect(listed.settings).toMatchObject({ subscribe_save_enabled: false, subscribe_save_percent: 10 });
    expect(listed.products.map((row) => row.slug)).toEqual(["control", "fiber"]);
    expect(listed.products[0]).toMatchObject({
      tagline: page.tagline, category: "supplement", offered_cadences_weeks: [2, 4, 8], default_cadence_weeks: 4,
      sell_price_cents: 6999, subscription_enabled: true, subscribe_save_percent: 0, subscription_price_cents: 6999,
    });
    expect(listed.products[1]).toMatchObject({ offered: false, sell_price_cents: null, subscription_price_cents: null, subscribe_save_percent: 0 });
    settings.subscribe_save_enabled = true;
    const discounted = await listOfficePrices("office-1");
    expect(discounted.products[0]).toMatchObject({ subscribe_save_percent: 10, subscription_price_cents: 6299 });
  });
});
