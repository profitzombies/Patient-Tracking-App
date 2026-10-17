/**
 * App-access subscriptions through the Stripe webhook lifecycle, with the
 * store and Stripe replaced by scripted stand-ins:
 *
 *   - invoice.created (renewal): no shipping re-quote and no invoice items;
 *     the platform fee on the invoice is the flat 30% of the charge;
 *   - invoice.paid (renewal): a `subscription_renewal` order with the flat
 *     share snapshotted, nothing to ship (fulfillment `not_required`), no
 *     warehouse columns, and the first-period start email is NOT a product
 *     "started" notice;
 *   - invoice.payment_failed: past_due is reached through the shared dunning
 *     path (the entitlement treats past_due as still covered);
 *   - customer.subscription.updated/deleted: status + period end land on the
 *     row with next_shipment_at pinned null, and the pure rule then reads
 *     active → available, canceled-but-paid-through → available, lapsed →
 *     locked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  subscriptions: [] as any[], products: [] as any[], orders: [] as any[], items: [] as any[],
  updates: [] as Array<{ table: string; query: string; patch: any }>, inserts: [] as Array<{ table: string; row: any }>,
  invoiceItems: [] as any[], invoiceUpdates: [] as any[],
  handlers: new Map<string, (event: any, ctx: any) => Promise<void>>(),
  paidFromInvoice: [] as any[], paymentFailed: [] as any[], started: [] as any[],
}));

vi.mock("../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store")>();
  const matches = (row: any, query: string) => {
    for (const match of query.matchAll(/(?:^|&)(id|provider_id|product_id|stripe_subscription_id|subscription_id|order_id|stripe_invoice_id|pending_product_id)=eq\.([^&]+)/g)) {
      if (String(row[match[1]]) !== decodeURIComponent(match[2])) return false;
    }
    const statusIn = query.match(/(?:^|&)status=in\.\(([^)]+)\)/);
    if (statusIn && !statusIn[1].split(",").includes(String(row.status))) return false;
    return true;
  };
  const rows = (table: string) => table === "billing_subscriptions" ? state.subscriptions
    : table === "billing_products" ? state.products
    : table === "billing_orders" ? state.orders
    : table === "billing_order_items" ? state.items
    : table === "billing_connected_accounts" ? [{ provider_id: "office-1", stripe_account_id: "acct_1", charges_enabled: true, disconnected_at: null }]
    : [];
  const insert = async (table: string, row: any) => {
    state.inserts.push({ table, row });
    if (table === "billing_orders") state.orders.push(row);
    if (table === "billing_order_items") state.items.push(row);
    return row;
  };
  return {
    ...actual,
    selectOne: vi.fn(async (table: string, query: string) => rows(table).find((row) => matches(row, query)) ?? null),
    selectMany: vi.fn(async (table: string, query: string) => rows(table).filter((row) => matches(row, query))),
    update: vi.fn(async (table: string, query: string, patch: any) => {
      state.updates.push({ table, query, patch });
      const row = rows(table).find((candidate) => matches(candidate, query));
      if (row) Object.assign(row, patch);
      return row ?? null;
    }),
    insert: vi.fn(insert), insertIgnore: vi.fn(insert),
  };
});
vi.mock("../stripe-client", () => ({
  connectedOpts: (account: string, key?: string) => ({ stripeAccount: account, ...(key ? { idempotencyKey: key } : {}) }),
  getPublishableKey: vi.fn(), isSandbox: vi.fn(),
  getStripe: vi.fn(async () => ({
    invoiceItems: { create: vi.fn(async (params: any, opts: any) => { state.invoiceItems.push({ params, opts }); return { id: "ii_1" }; }) },
    invoices: { update: vi.fn(async (id: string, patch: any, opts: any) => { state.invoiceUpdates.push({ id, patch, opts }); return { id }; }) },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  })),
}));
vi.mock("../webhooks", () => ({
  onStripeEvent: (type: string, handler: (event: any, ctx: any) => Promise<void>) => state.handlers.set(type, handler),
}));
vi.mock("../office-share", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../office-share")>();
  return { ...actual, officeThinnrSharePercent: vi.fn(async () => { throw new Error("app access must not consult the office share"); }) };
});
vi.mock("../renewal-shipping", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renewal-shipping")>();
  return { ...actual, quoteRenewalShipping: vi.fn(async () => { throw new Error("app access must not re-quote shipping"); }) };
});
vi.mock("../prices", () => ({ ensureRecurringPrices: vi.fn() }));
vi.mock("../orders", () => ({
  BillingOrderError: class extends Error {},
  markOrderPaidFromInvoice: vi.fn(async (invoice: any) => { state.paidFromInvoice.push({ orderId: invoice.metadata?.thinnr_order_id, invoiceId: invoice.id }); return { status: "paid" }; }),
  quoteOrder: vi.fn(),
}));
vi.mock("../customers", () => ({ ensureCustomer: vi.fn() }));
vi.mock("../links", () => ({ resolvePayer: vi.fn(), touchLinkUse: vi.fn() }));
vi.mock("../receipts", () => ({ sendCancellationNotice: vi.fn(), sendPaymentFailed: vi.fn() }));
vi.mock("../customer-emails", () => ({
  notifySubscriptionEvent: vi.fn(), planLabel: vi.fn(),
  notifySubscriptionStarted: vi.fn(async (row: any) => { state.started.push(row); }),
}));
vi.mock("../patient-notices", () => ({
  notifySubscriptionPaymentFailed: vi.fn(async (input: any) => { state.paymentFailed.push(input); }),
}));
vi.mock("../store-orders", () => ({ getOrderBundle: vi.fn(), getProvider: vi.fn(), officeName: vi.fn() }));

import { APP_ACCESS_THINNR_SHARE_PERCENT } from "../fees";
import { markSubscriptionInvoiceFailed, markSubscriptionInvoicePaid, registerSubscriptionWebhookHandlers } from "../subscriptions";
import { APP_ACCESS_PRODUCT_ID } from "./catalog";
import { evaluateAppAccess } from "./entitlement";
import { subscriptionFacts } from "./subscription";

const CTX = { kind: "connect", account: "acct_1", livemode: false } as const;
const PERIOD_END = 1_790_000_000; // 2026-09-20T12:53:20Z

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: "in_app_renewal", customer: "cus_1", subscription: "sub_app", billing_reason: "subscription_cycle", total: 699,
    payment_intent: { id: "pi_app" }, lines: { data: [{ id: "il_1", type: "subscription", amount: 699, price: { id: "price_app" } }] },
    ...over,
  };
}
async function fire(type: string, object: any) {
  state.handlers.clear();
  registerSubscriptionWebhookHandlers();
  await state.handlers.get(type)!({ data: { object } }, CTX);
}
const row = () => state.subscriptions[0];
/** The pure rule on the webhook's result: a post-trial non-THINNR patient at a charging office. */
function entitlement(now = new Date("2026-09-01T00:00:00Z")) {
  return evaluateAppAccess({
    todayKey: "2026-09-01", now, programId: "mediterranean", episodeStartedOn: "2026-06-01",
    activatedAt: "2026-06-01T00:00:00Z", timeZone: "UTC",
    office: { enabled: true, price_cents: 699, cadence: "2_weeks", trial_days: 7 },
    subscription: subscriptionFacts(row()),
  });
}

beforeEach(() => {
  state.subscriptions = [{
    id: "sub-local", provider_id: "office-1", payer_id: "payer-1", patient_id: "pat-1", product_id: APP_ACCESS_PRODUCT_ID, kind: "app_access",
    stripe_subscription_id: "sub_app", status: "active", unit_price_cents: 699, quantity: 1, cadence_weeks: 2,
    shipping_charge_cents: 0, shipping_cost_cents: 0, application_fee_cents: 209, shipping_address: {},
    stripe_price_id: "price_app", stripe_shipping_price_id: null, current_period_end: "2026-09-15T00:00:00.000Z",
    cancel_at_period_end: false, canceled_at: null, paused_at: null, last_paid_invoice_id: null,
    pending_product_id: null, pending_unit_price_cents: null, pending_application_fee_cents: null,
    pending_shipping_charge_cents: null, pending_stripe_price_id: null, livemode: false,
  }];
  state.products = [{ id: APP_ACCESS_PRODUCT_ID, name: "App access", active: false, status: "draft", floor_price_cents: 0, hard_cost_cents: 0, warehousecraft_sku: null, shipping_weight_oz: null }];
  state.orders = [{ id: "order-initial", subscription_id: "sub-local", kind: "subscription_initial", status: "paid", stripe_invoice_id: "in_first", created_at: "2026-08-01T00:00:00.000Z" }];
  state.items = [{ order_id: "order-initial", product_id: APP_ACCESS_PRODUCT_ID, thinnr_share_cents: 209, floor_price_cents_snapshot: 0, quantity: 1 }];
  state.updates = []; state.inserts = []; state.invoiceItems = []; state.invoiceUpdates = [];
  state.paidFromInvoice = []; state.paymentFailed = []; state.started = [];
});

describe("app-access renewal invoices", () => {
  it("sets the flat share as the platform fee and never touches shipping", async () => {
    await fire("invoice.created", invoice());
    expect(state.invoiceItems).toEqual([]);
    expect(state.invoiceUpdates).toEqual([{ id: "in_app_renewal", patch: { application_fee_amount: 209 }, opts: { stripeAccount: "acct_1" } }]);
    // No shipping terms were written to the row.
    expect(state.updates.filter((u) => u.table === "billing_subscriptions")).toEqual([]);
  });

  it("records a renewal order with nothing to ship and the 30% share snapshotted, then marks it paid", async () => {
    await markSubscriptionInvoicePaid(invoice(), CTX);
    const order = state.orders.find((o) => o.stripe_invoice_id === "in_app_renewal")!;
    expect(order).toMatchObject({
      kind: "subscription_renewal", subscription_id: "sub-local", provider_id: "office-1", patient_id: "pat-1", status: "pending",
      subtotal_cents: 699, shipping_charge_cents: 0, total_cents: 699, application_fee_cents: 209, thinnr_share_percent: APP_ACCESS_THINNR_SHARE_PERCENT,
      hard_cost_cents: 0, shipping_cost_cents: 0, hq_profit_cents: 209, fulfillment_status: "not_required",
      stripe_payment_intent_id: "pi_app", metadata: { app_access: { cadence_weeks: 2 } },
    });
    expect(order.shipping_method).toBeUndefined();
    expect(order.warehousecraft_sku_snapshot).toBeUndefined();
    const item = state.items.find((i) => i.order_id === order.id)!;
    expect(item).toMatchObject({ product_id: APP_ACCESS_PRODUCT_ID, quantity: 1, unit_price_cents: 699, floor_price_cents_snapshot: 0, thinnr_share_cents: 209, hard_cost_cents_snapshot: 0 });
    expect(item.warehousecraft_sku_snapshot).toBeUndefined();
    expect(state.paidFromInvoice).toEqual([{ orderId: order.id, invoiceId: "in_app_renewal" }]);
    // A replayed invoice.paid reuses the order instead of minting another.
    await markSubscriptionInvoicePaid(invoice(), CTX);
    expect(state.orders.filter((o) => o.stripe_invoice_id === "in_app_renewal")).toHaveLength(1);
  });

  it("does not send the product 'subscription started' notice for the first app-access invoice", async () => {
    state.orders[0] = { ...state.orders[0], status: "pending", provider_id: "office-1", application_fee_cents: 209 };
    await markSubscriptionInvoicePaid(invoice({ id: "in_first", billing_reason: "subscription_create" }), CTX);
    expect(state.paidFromInvoice).toEqual([{ orderId: "order-initial", invoiceId: "in_first" }]);
    expect(state.started).toEqual([]);
  });

  it("ignores an invoice delivered on another office's connected account", async () => {
    await markSubscriptionInvoicePaid(invoice(), { kind: "connect", account: "acct_other", livemode: false });
    expect(state.orders.filter((o) => o.stripe_invoice_id === "in_app_renewal")).toHaveLength(0);
    expect(state.paidFromInvoice).toEqual([]);
  });
});

describe("app-access dunning and status sync", () => {
  it("takes a failed renewal to past_due through the shared dunning path, which still covers the patient", async () => {
    await markSubscriptionInvoiceFailed(invoice({ last_finalization_error: { message: "Your card was declined." } }), CTX);
    expect(row().status).toBe("past_due");
    const failed = state.orders.find((o) => o.stripe_invoice_id === "in_app_renewal")!;
    expect(failed).toMatchObject({ status: "failed", fulfillment_status: "not_required" });
    expect(state.paymentFailed).toHaveLength(1);
    expect(state.paymentFailed[0]).toMatchObject({ subscription: { id: "sub-local", status: "past_due" }, invoiceId: "in_app_renewal", appAccess: true, message: expect.any(String) });
    expect(entitlement()).toMatchObject({ available: true, reason: "subscribed", subscription: { state: "past_due" } });
  });

  it("mirrors Stripe's status and period end with next_shipment_at pinned null", async () => {
    await fire("customer.subscription.updated", { id: "sub_app", status: "active", current_period_end: PERIOD_END, cancel_at_period_end: true, canceled_at: null, pause_collection: null });
    expect(row()).toMatchObject({ status: "active", current_period_end: new Date(PERIOD_END * 1000).toISOString(), next_shipment_at: null, cancel_at_period_end: true, canceled_at: null });
    expect(entitlement()).toMatchObject({ available: true, reason: "subscribed", subscription: { state: "active", cancel_at_period_end: true } });
  });

  it("keeps a cancelled subscription available until the paid period ends, then locks", async () => {
    await fire("customer.subscription.deleted", { id: "sub_app", status: "canceled", current_period_end: PERIOD_END, cancel_at_period_end: false, canceled_at: 1_756_000_000 });
    expect(row()).toMatchObject({ status: "canceled", next_shipment_at: null, canceled_at: new Date(1_756_000_000 * 1000).toISOString() });
    expect(entitlement(new Date("2026-09-01T00:00:00Z"))).toMatchObject({ available: true, reason: "subscribed", subscription: { state: "canceled" } });
    expect(entitlement(new Date("2026-10-01T00:00:00Z"))).toMatchObject({ available: false, reason: "locked", subscription: { state: "canceled" } });
  });

  it("locks when Stripe reports the subscription unpaid past its period, and ignores other offices' events", async () => {
    await fire("customer.subscription.updated", { id: "sub_app", status: "incomplete_expired", current_period_end: PERIOD_END, cancel_at_period_end: false, canceled_at: null });
    expect(row().status).toBe("canceled");
    state.updates = [];
    state.handlers.clear();
    registerSubscriptionWebhookHandlers();
    await state.handlers.get("customer.subscription.updated")!({ data: { object: { id: "sub_app", status: "active", current_period_end: PERIOD_END } } }, { kind: "connect", account: "acct_other", livemode: false });
    expect(state.updates).toEqual([]);
    expect(row().status).toBe("canceled");
  });
});
