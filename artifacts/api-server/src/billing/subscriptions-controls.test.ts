import { beforeEach, describe, expect, vi } from "vitest";
import { it } from "./testing/context";

const state = vi.hoisted(() => ({
  subscriptions: [] as any[],
  products: [] as any[],
  prices: [] as any[],
  orders: [] as any[],
  insertedItems: [] as any[],
  stripeUpdates: [] as any[],
  emailClaims: [] as any[],
  webhookFirstPause: false,
  handlers: new Map<string, (event: any, ctx: any) => Promise<void>>(),
}));

vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  const matches = (row: any, query: string) => {
    for (const match of query.matchAll(/(?:^|&)(id|provider_id|product_id|stripe_subscription_id)=eq\.([^&]+)/g)) {
      if (String(row[match[1]]) !== decodeURIComponent(match[2])) return false;
    }
    if (query.includes("disconnected_at=is.null") && row.disconnected_at != null) return false;
    return true;
  };
  const rows = (table: string) => table === "billing_subscriptions" ? state.subscriptions
    : table === "billing_products" ? state.products
    : table === "billing_office_prices" ? state.prices
    : table === "billing_orders" ? state.orders
    : table === "billing_connected_accounts" ? [{
      provider_id: "office-1", stripe_account_id: "acct_1", charges_enabled: true, disconnected_at: null,
    }] : table === "billing_payers" ? [] : [];
  return {
    shipmentTerms: actual.shipmentTerms, shipmentColumns: actual.shipmentColumns,
    nowIso: () => "2026-10-13T12:00:00.000Z",
    selectOne: vi.fn(async (table: string, query: string) => rows(table).find((row: any) => matches(row, query)) ?? null),
    selectMany: vi.fn(async () => []),
    update: vi.fn(async (table: string, query: string, patch: any) => {
      const row = rows(table).find((candidate: any) => matches(candidate, query));
      if (!row) return null;
      if (query.includes("paused_at=is.null") && row.paused_at !== null) return null;
      if (query.includes("paused_at=eq.") && !query.includes(`paused_at=eq.${encodeURIComponent(row.paused_at)}`)) return null;
      Object.assign(row, patch);
      return row;
    }),
    insertIgnore: vi.fn(async (table: string, row: any) => {
      if (table === "billing_orders") state.orders.push(row);
      if (table === "billing_customer_emails") {
        if (state.emailClaims.some((claim: any) => claim.dedupe_key === row.dedupe_key)) return null;
        state.emailClaims.push({ id: `claim-${state.emailClaims.length + 1}`, ...row });
      }
      return row;
    }),
    insert: vi.fn(async (table: string, row: any) => {
      if (table === "billing_order_items") state.insertedItems.push(row);
      return row;
    }),
  };
});
vi.mock("./catalog", () => ({
  getSettings: vi.fn(async () => ({
    shipping_charge_cents: 1000, shipping_cost_cents: 800, card_fee_bps: 290, card_fee_fixed_cents: 30,
  })),
}));
vi.mock("./prices", () => ({
  ensureRecurringPrices: vi.fn(async () => ({ stripe_price_id: "price_new", stripe_shipping_price_id: "ship_new" })),
}));
vi.mock("./stripe-client", () => ({
  connectedOpts: (account: string) => ({ stripeAccount: account }),
  getPublishableKey: vi.fn(), isSandbox: vi.fn(),
  getStripe: vi.fn(async () => ({
    subscriptions: {
      retrieve: vi.fn(async () => ({ items: { data: [
        { id: "si_product", price: { id: "price_old" } },
        { id: "si_shipping", price: { id: "ship_old" } },
      ] } })),
      update: vi.fn(async (id: string, patch: any) => {
        state.stripeUpdates.push({ id, patch });
        if (state.webhookFirstPause && patch.pause_collection?.behavior === "void") {
          state.subscriptions[0].paused_at = "2026-10-13T12:00:00.000Z";
        }
        return { id, ...patch };
      }),
    },
    invoices: { update: vi.fn() },
  })),
}));
vi.mock("./webhooks", () => ({
  onStripeEvent: (type: string, handler: (event: any, ctx: any) => Promise<void>) => state.handlers.set(type, handler),
}));
vi.mock("./orders", () => ({
  BillingOrderError: class extends Error {},
  markOrderPaidFromInvoice: vi.fn(), quoteOrder: vi.fn(),
}));
vi.mock("./customers", () => ({ ensureCustomer: vi.fn() }));
vi.mock("./links", () => ({ resolvePayer: vi.fn(), touchLinkUse: vi.fn() }));
vi.mock("./receipts", () => ({
  sendCancellationNotice: vi.fn(), sendPaymentFailed: vi.fn(),
}));
vi.mock("./store-orders", () => ({
  getOrderBundle: vi.fn(), getProvider: vi.fn(), officeName: vi.fn(),
}));

import {
  BillingSubscriptionError, cancelSubscription, changeSubscription, markSubscriptionInvoicePaid, pauseSubscription,
  quoteSubscriptionChange, registerSubscriptionWebhookHandlers, resumeSubscription,
} from "./subscriptions";

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-local", provider_id: "office-1", payer_id: "payer-1", patient_id: null,
    product_id: "product-old", stripe_subscription_id: "sub_stripe", status: "active",
    unit_price_cents: 6000, shipping_charge_cents: 900, shipping_cost_cents: 800,
    application_fee_cents: 3900, shipping_address: {}, current_period_end: "2026-11-10T00:00:00.000Z",
    cancel_at_period_end: false, canceled_at: null, paused_at: null, livemode: false,
    pending_product_id: null, pending_unit_price_cents: null, pending_application_fee_cents: null,
    pending_effective_at: null, pending_shipping_charge_cents: null, pending_stripe_price_id: null, ...overrides,
  };
}

beforeEach(() => {
  state.subscriptions = [subscription()];
  state.products = [
    { id: "product-old", name: "Old", active: true, status: "active", floor_price_cents: 5000, hard_cost_cents: 500 },
    { id: "product-new", name: "New", active: true, status: "active", floor_price_cents: 7000, hard_cost_cents: 700 },
  ];
  state.prices = [
    { provider_id: "office-1", product_id: "product-old", sell_price_cents: 6000, subscription_enabled: true, stripe_price_id: "price_old", stripe_shipping_price_id: "ship_old" },
    { provider_id: "office-1", product_id: "product-new", sell_price_cents: 9000, subscription_enabled: true, stripe_price_id: "price_new", stripe_shipping_price_id: "ship_new" },
  ];
  state.orders = []; state.insertedItems = []; state.stripeUpdates = []; state.emailClaims = []; state.handlers.clear();
  state.webhookFirstPause = false;
});

describe("subscription controls", () => {
  it("pauses and resumes through Stripe and mirrors dashboard pause updates", async () => {
    expect((await pauseSubscription("sub-local")).paused_at).toBe("2026-10-13T12:00:00.000Z");
    expect(state.stripeUpdates[0].patch.pause_collection).toEqual({ behavior: "void" });
    expect((await resumeSubscription("sub-local")).paused_at).toBeNull();
    expect(state.stripeUpdates[1].patch.pause_collection).toBe("");

    registerSubscriptionWebhookHandlers();
    await state.handlers.get("customer.subscription.updated")!(
      { data: { object: { id: "sub_stripe", status: "active", pause_collection: { behavior: "void" } } } },
      { kind: "connect", account: "acct_1" },
    );
    expect(state.subscriptions[0].paused_at).toBe("2026-10-13T12:00:00.000Z");
  });

  it("rejects pausing a canceled subscription", async () => {
    state.subscriptions[0].status = "canceled";
    await expect(pauseSubscription("sub-local")).rejects.toMatchObject({ status: 409 });
  });

  it("rejects pausing a past-due subscription", async () => {
    state.subscriptions[0].status = "past_due";
    await expect(pauseSubscription("sub-local")).rejects.toMatchObject({
      status: 409,
      message: "Bring the subscription current or cancel it; past-due subscriptions can't be paused.",
    });
  });

  it("accepts a webhook-first pause as successful convergence", async () => {
    state.webhookFirstPause = true;
    await expect(pauseSubscription("sub-local")).resolves.toMatchObject({
      paused_at: "2026-10-13T12:00:00.000Z",
    });
  });

  it("quotes fee math, rejects the same product, and stores a replacement pending change", async () => {
    const quote = await quoteSubscriptionChange("sub-local", "product-new");
    expect(quote.next).toEqual({
      product_id: "product-new", product_name: "New", unit_price_cents: 9000,
      shipping_charge_cents: 1000, application_fee_cents: 5200,
    });
    await expect(changeSubscription("sub-local", "product-old")).rejects.toMatchObject({ status: 409 });
    const changed = await changeSubscription("sub-local", "product-new");
    expect(changed.pending_product_id).toBe("product-new");
    expect(changed.pending_unit_price_cents).toBe(9000);
    expect(changed.pending_stripe_price_id).toBe("price_new");
    expect(state.stripeUpdates.at(-1).patch).toMatchObject({
      items: [
        { id: "si_product", price: "price_new", quantity: 1 },
        { id: "si_shipping", price: "ship_new", quantity: 1 },
      ],
      application_fee_percent: 52,
      proration_behavior: "none",
      billing_cycle_anchor: "unchanged",
    });
  });

  it("does not promote a pending change for a retried old invoice", async () => {
    Object.assign(state.subscriptions[0], {
      pending_product_id: "product-new", pending_unit_price_cents: 9000,
      pending_application_fee_cents: 5200, pending_shipping_charge_cents: 1000,
      pending_effective_at: "2026-11-10T00:00:00.000Z", pending_stripe_price_id: "price_new",
    });
    await markSubscriptionInvoicePaid({
      id: "in_old", subscription: "sub_stripe", billing_reason: "subscription_cycle",
      total: 6900, payment_intent: "pi_old", lines: { data: [{ price: { id: "price_old" } }] },
    }, { kind: "connect", account: "acct_1", livemode: false });
    expect(state.subscriptions[0]).toMatchObject({
      product_id: "product-old", unit_price_cents: 6000, pending_product_id: "product-new",
    });
    expect(state.orders[0]).toMatchObject({ subtotal_cents: 6000, application_fee_cents: 3900 });
  });

  it("promotes a matching cycle price before snapshotting the paid renewal", async () => {
    Object.assign(state.subscriptions[0], {
      pending_product_id: "product-new", pending_unit_price_cents: 9000,
      pending_application_fee_cents: 5200, pending_shipping_charge_cents: 1000,
      pending_effective_at: "2026-11-10T00:00:00.000Z", pending_stripe_price_id: "price_new",
    });
    await markSubscriptionInvoicePaid({
      id: "in_renewal", subscription: "sub_stripe", billing_reason: "subscription_cycle",
      total: 10000, payment_intent: "pi_1",
      lines: { data: [{ pricing: { price_details: { price: "price_new" } } }] },
    }, { kind: "connect", account: "acct_1", livemode: false });
    expect(state.subscriptions[0]).toMatchObject({
      product_id: "product-new", unit_price_cents: 9000, application_fee_cents: 5200,
      pending_product_id: null,
    });
    expect(state.orders[0]).toMatchObject({ subtotal_cents: 9000, application_fee_cents: 5200 });
    expect(state.insertedItems[0]).toMatchObject({ product_id: "product-new", unit_price_cents: 9000 });
  });

  it("cancels at period end once: a repeat request writes nothing to Stripe and claims no second email", async () => {
    const first = await cancelSubscription("sub-local", { at_period_end: true });
    expect(first.cancel_at_period_end).toBe(true);
    expect(state.stripeUpdates.filter((entry) => entry.patch.cancel_at_period_end)).toHaveLength(1);
    const claims = () => state.emailClaims.filter((claim) => claim.template_id === "subscription-cancelled");
    expect(claims()).toHaveLength(0); // Test mode never queues real customer emails.

    const again = await cancelSubscription("sub-local", { at_period_end: true });
    expect(again.cancel_at_period_end).toBe(true);
    expect(state.stripeUpdates.filter((entry) => entry.patch.cancel_at_period_end)).toHaveLength(1);
    expect(claims()).toHaveLength(0);
  });
});
