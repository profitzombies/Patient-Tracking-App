import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../shipping/fixtures/warehousecraft-rates-nashville.json";
import { parseRateResponse, WarehouseCraftError } from "../shipping/warehousecraft";
import { clearRateCache, DEFAULT_PICK_PACK_SCHEDULE } from "../shipping/rating";

const ADDRESS = { name: "Pat", line1: "1 Music Square W", line2: null, city: "Nashville", state: "TN", postal_code: "37203", country: "US", phone: null };
const state = vi.hoisted(() => ({
  subscriptions: [] as any[], products: [] as any[], orders: [] as any[], items: [] as any[], officeSettings: [] as any[],
  updates: [] as Array<{ table: string; patch: any }>, invoiceItems: [] as any[], invoiceUpdates: [] as any[],
  handlers: new Map<string, (event: any, ctx: any) => Promise<void>>(),
  settings: {} as Record<string, unknown>,
  fetcher: vi.fn(),
}));

vi.mock("../shipping/warehousecraft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shipping/warehousecraft")>();
  return { ...actual, fetchShippingRates: (request: unknown) => state.fetcher(request) };
});
vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  const matches = (row: any, query: string) => {
    for (const match of query.matchAll(/(?:^|&)(id|provider_id|product_id|stripe_subscription_id|subscription_id|order_id)=eq\.([^&]+)/g)) {
      if (String(row[match[1]]) !== decodeURIComponent(match[2])) return false;
    }
    return true;
  };
  const rows = (table: string) => table === "billing_subscriptions" ? state.subscriptions
    : table === "billing_products" ? state.products
    : table === "billing_orders" ? state.orders
    : table === "billing_order_items" ? state.items
    : table === "billing_office_settings" ? state.officeSettings
    : table === "billing_connected_accounts" ? [{ provider_id: "office-1", stripe_account_id: "acct_1", charges_enabled: true, disconnected_at: null }]
    : [];
  return {
    ...actual,
    selectOne: vi.fn(async (table: string, query: string) => rows(table).find((row) => matches(row, query)) ?? null),
    selectMany: vi.fn(async (table: string, query: string) => rows(table).filter((row) => matches(row, query))),
    update: vi.fn(async (table: string, query: string, patch: any) => {
      state.updates.push({ table, patch });
      const row = rows(table).find((candidate) => matches(candidate, query));
      if (row) Object.assign(row, patch);
      return row ?? null;
    }),
    insert: vi.fn(async (_table: string, row: any) => row), insertIgnore: vi.fn(async (_table: string, row: any) => row),
  };
});
vi.mock("./catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalog")>();
  return { ...actual, getSettings: vi.fn(async () => state.settings) };
});
vi.mock("./stripe-client", () => ({
  connectedOpts: (account: string, key?: string) => ({ stripeAccount: account, ...(key ? { idempotencyKey: key } : {}) }),
  getPublishableKey: vi.fn(), isSandbox: vi.fn(),
  getStripe: vi.fn(async () => ({
    invoiceItems: { create: vi.fn(async (params: any, opts: any) => { state.invoiceItems.push({ params, opts }); return { id: "ii_1" }; }) },
    invoices: { update: vi.fn(async (id: string, patch: any) => { state.invoiceUpdates.push({ id, patch }); return { id }; }) },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  })),
}));
vi.mock("./webhooks", () => ({
  onStripeEvent: (type: string, handler: (event: any, ctx: any) => Promise<void>) => state.handlers.set(type, handler),
}));
vi.mock("./prices", () => ({ ensureRecurringPrices: vi.fn() }));
vi.mock("./orders", () => ({ BillingOrderError: class extends Error {}, markOrderPaidFromInvoice: vi.fn(), quoteOrder: vi.fn() }));
vi.mock("./customers", () => ({ ensureCustomer: vi.fn() }));
vi.mock("./links", () => ({ resolvePayer: vi.fn(), touchLinkUse: vi.fn() }));
vi.mock("./receipts", () => ({ sendCancellationNotice: vi.fn(), sendPaymentFailed: vi.fn() }));
vi.mock("./customer-emails", () => ({ notifySubscriptionEvent: vi.fn(), notifySubscriptionStarted: vi.fn(), planLabel: vi.fn() }));
vi.mock("./patient-notices", () => ({ notifySubscriptionPaymentFailed: vi.fn() }));
vi.mock("./store-orders", () => ({ getOrderBundle: vi.fn(), getProvider: vi.fn(), officeName: vi.fn() }));

import { invoiceShippingLineAmount, quoteRenewalShipping, subscriptionThinnrShare } from "./renewal-shipping";
import { registerSubscriptionWebhookHandlers } from "./subscriptions";

// Live standard for the fixture shipment (3 × 8 oz to Nashville) = 807; fee = 495 + 3 × 25 = 570; packaging 0 by default.
const LIVE_STANDARD = 807;
const PICK_PACK = 570;

function invoice(shippingAmount = 900, over: Record<string, unknown> = {}) {
  return {
    id: "in_renewal", customer: "cus_1", subscription: "sub_stripe", billing_reason: "subscription_cycle", total: 6000 + shippingAmount,
    lines: { data: [
      { id: "il_1", type: "subscription", amount: 6000, price: { id: "price_old" } },
      { id: "il_2", type: "subscription", amount: shippingAmount, price: { id: "ship_inline" } },
    ] },
    ...over,
  };
}
async function fire(inv: any = invoice()) {
  state.handlers.clear();
  registerSubscriptionWebhookHandlers();
  await state.handlers.get("invoice.created")!({ data: { object: inv } }, { kind: "connect", account: "acct_1" });
}

beforeEach(() => {
  clearRateCache();
  state.fetcher.mockReset().mockImplementation(async () => parseRateResponse(fixture));
  state.settings = {
    shipping_charge_cents: 1000, shipping_cost_cents: 800, card_fee_bps: 290, card_fee_fixed_cents: 30,
    free_shipping_over_cents: null, pick_pack_tier: "under_50", pick_pack_schedule: DEFAULT_PICK_PACK_SCHEDULE,
    pick_pack_pass_through_default: true, expedited_enabled: true,
  };
  state.subscriptions = [{
    id: "sub-local", provider_id: "office-1", payer_id: "payer-1", patient_id: "pat-1", product_id: "product-old",
    stripe_subscription_id: "sub_stripe", status: "active", unit_price_cents: 2000, quantity: 3, cadence_weeks: 4,
    shipping_charge_cents: 900, shipping_cost_cents: 800, application_fee_cents: 3600 + 800, shipping_address: ADDRESS,
    shipping_method: "standard", shipping_source: "fallback", stripe_price_id: "price_old", stripe_shipping_price_id: "ship_old",
    pending_product_id: null, pending_unit_price_cents: null, pending_application_fee_cents: null,
    pending_shipping_charge_cents: null, pending_stripe_price_id: null, livemode: false,
  }];
  state.products = [{ id: "product-old", name: "SlimCell", active: true, status: "active", floor_price_cents: 2000, hard_cost_cents: 500,
    warehousecraft_sku: "Test01", shipping_weight_oz: 8, oversized: false, package_length_in: null, package_width_in: null, package_height_in: null }];
  state.orders = [{ id: "order-initial", subscription_id: "sub-local", kind: "subscription_initial", created_at: "2026-09-01T00:00:00.000Z" }];
  state.items = [{ order_id: "order-initial", thinnr_share_cents: 3600 }];
  state.officeSettings = [];
  state.updates = []; state.invoiceItems = []; state.invoiceUpdates = [];
});

describe("renewal shipping re-quote", () => {
  it("takes THINNR's share from the initial order items and finds the invoice's shipping line", async () => {
    expect(await subscriptionThinnrShare(state.subscriptions[0])).toBe(3600);
    state.items = [];
    expect(await subscriptionThinnrShare(state.subscriptions[0])).toBe(4400 - 900);
    expect(invoiceShippingLineAmount(invoice(950), ["price_old", null])).toBe(950);
    expect(invoiceShippingLineAmount({ lines: { data: [{ type: "subscription", amount: 6000, price: "price_old" }] } }, ["price_old"])).toBeNull();
    // an earlier adjustment item never counts as the base line
    const adjusted = invoice(950);
    adjusted.lines.data.unshift({ id: "il_0", type: "invoiceitem", amount: -50, price: { id: "ii_price" } });
    expect(invoiceShippingLineAmount(adjusted, ["price_old"])).toBe(950);
  });

  it("quotes the subscription's current address with the office's pass-through and the plan's own share", async () => {
    const requote = await quoteRenewalShipping(state.subscriptions[0], false);
    expect(requote).toMatchObject({
      share_cents: 3600, quantity: 3, unit_price_cents: 2000, application_fee_cents: 3600 + LIVE_STANDARD + PICK_PACK,
      quote: { source: "live", method: "standard", patient_amount_cents: LIVE_STANDARD + PICK_PACK, carrier_cost_cents: LIVE_STANDARD, pick_pack_passed_through: true },
    });
    expect(state.fetcher.mock.calls[0][0]).toMatchObject({ Rate: { destination: { postal_code: "37203" }, items: [{ sku: "Test01", quantity: 3, lbs: 0.5 }] } });
    state.officeSettings = [{ provider_id: "office-1", pick_pack_pass_through: false, version: 1 }];
    state.subscriptions[0].shipping_method = "expedited";
    const absorbed = await quoteRenewalShipping(state.subscriptions[0], false);
    expect(absorbed?.quote).toMatchObject({ method: "expedited", patient_amount_cents: 1671, pick_pack_passed_through: false, thinnr_shipping_cost_cents: 1671 + PICK_PACK });
  });

  it("adjusts the renewal invoice's shipping line to the live quote, re-derives the platform fee, and locks the terms on the row", async () => {
    await fire(invoice(900));
    expect(state.invoiceItems).toHaveLength(1);
    expect(state.invoiceItems[0].params).toMatchObject({
      customer: "cus_1", invoice: "in_renewal", amount: LIVE_STANDARD + PICK_PACK - 900, description: "Shipping & handling adjustment",
      metadata: { thinnr_shipping_source: "live" },
    });
    expect(state.invoiceItems[0].opts).toMatchObject({ stripeAccount: "acct_1", idempotencyKey: "renewal:in_renewal:shipping" });
    expect(state.invoiceUpdates).toEqual([{ id: "in_renewal", patch: { application_fee_amount: 3600 + LIVE_STANDARD + PICK_PACK } }]);
    const row = state.subscriptions[0];
    expect(row).toMatchObject({
      shipping_charge_cents: LIVE_STANDARD + PICK_PACK, shipping_cost_cents: LIVE_STANDARD, application_fee_cents: 3600 + LIVE_STANDARD + PICK_PACK,
      shipping_source: "live", shipping_method: "standard", carrier_service_name: "USPS Ground Advantage",
      pick_pack_fee_cents: PICK_PACK, pick_pack_passed_through: true, delivery_window_start: "2026-09-22",
    });
    expect(typeof row.shipping_requoted_at).toBe("string");
  });

  it("leaves the invoice alone when the fresh quote equals what the recurring line already bills", async () => {
    await fire(invoice(LIVE_STANDARD + PICK_PACK));
    expect(state.invoiceItems).toHaveLength(0);
    expect(state.invoiceUpdates[0].patch.application_fee_amount).toBe(3600 + LIVE_STANDARD + PICK_PACK);
  });

  it("falls back to the flat charge when the carrier fails or the address cannot be rated, and still recovers the fee", async () => {
    state.fetcher.mockImplementation(async () => { throw new WarehouseCraftError("upstream 503", "transient", 503); });
    await fire(invoice(900));
    expect(state.invoiceItems[0].params).toMatchObject({ amount: 1000 - 900, metadata: { thinnr_shipping_source: "fallback" } });
    expect(state.invoiceUpdates[0].patch.application_fee_amount).toBe(3600 + 800 + PICK_PACK);
    expect(state.subscriptions[0]).toMatchObject({ shipping_charge_cents: 1000, shipping_cost_cents: 800, shipping_source: "fallback", delivery_window_start: null });

    state.invoiceItems = []; state.invoiceUpdates = [];
    state.fetcher.mockImplementation(async () => { throw new WarehouseCraftError("400", "bad_address", 400); });
    state.subscriptions[0].shipping_charge_cents = 900;
    await fire(invoice(900));
    expect(state.invoiceItems[0].params).toMatchObject({ amount: 100, metadata: { thinnr_shipping_source: "fallback" } });
  });

  it("re-quotes a pending plan change on the pending product and keeps the fee update even when nothing can be quoted", async () => {
    state.products.push({ id: "product-new", name: "New", active: true, status: "active", floor_price_cents: 3000, hard_cost_cents: 700,
      warehousecraft_sku: "Test02", shipping_weight_oz: 16, oversized: false, package_length_in: null, package_width_in: null, package_height_in: null });
    Object.assign(state.subscriptions[0], {
      pending_product_id: "product-new", pending_unit_price_cents: 3000, pending_application_fee_cents: 1800 + 1000,
      pending_shipping_charge_cents: 1000, pending_stripe_price_id: "price_new",
    });
    const inv = invoice(1000);
    inv.lines.data[0].price = { id: "price_new" };
    await fire(inv);
    expect(state.fetcher.mock.calls[0][0]).toMatchObject({ Rate: { items: [{ sku: "Test02", quantity: 3, lbs: 1 }] } });
    const row = state.subscriptions[0];
    // 3 × 16 oz = 3 lb → the fixture's 3 lb standard rate; the pending fields carry the requote until the invoice pays.
    expect(row.pending_shipping_charge_cents).toBe(row.shipping_cost_cents + PICK_PACK);
    expect(row.pending_application_fee_cents).toBe(1800 + row.shipping_cost_cents + PICK_PACK);
    expect(row.shipping_charge_cents).toBe(900);

    state.invoiceItems = []; state.invoiceUpdates = [];
    state.products = [];
    row.pending_application_fee_cents = 2800;
    await fire(inv);
    expect(state.invoiceItems).toHaveLength(0);
    expect(state.invoiceUpdates).toEqual([{ id: "in_renewal", patch: { application_fee_amount: 2800 } }]);
  });
});
