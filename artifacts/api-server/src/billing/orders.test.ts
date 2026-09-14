import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { __setCredentialsForTests, __setStripeForTests } from "./stripe-client";
import {
  BillingOrderError, createOneTimeOrder, quoteOrder, refundOrder, registerOrderWebhookHandlers,
} from "./orders";
import {
  createSubscriptionOrder, markSubscriptionInvoicePaid, registerSubscriptionWebhookHandlers,
} from "./subscriptions";
import { dispatchStripeEvent, resetStripeEventHandlers } from "./webhooks";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  delete process.env.RESEND_API_KEY;
});

type Row = Record<string, any>;
const originalFetch = global.fetch;
let tables: Record<string, Row[]>;
let sequence: string[];
let stripe: any;

function result(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "on_conflict"].includes(key)) continue;
    if (raw === "is.null") { if (row[key] != null) return false; continue; }
    if (raw.startsWith("eq.") && String(row[key]) !== decodeURIComponent(raw.slice(3))) return false;
  }
  return true;
}
function installFetch() {
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const table = url.pathname.split("/").at(-1)!;
    const rows = tables[table] ?? (tables[table] = []);
    const method = init?.method ?? "GET";
    if (method === "GET") return result(rows.filter((row) => matches(row, url.searchParams)));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "POST") {
      sequence.push(`db:${table}`);
      const existing = url.searchParams.get("on_conflict")
        ? rows.find((row) => url.searchParams.get("on_conflict")!.split(",").every((key) => row[key] === body[key]))
        : null;
      const saved = existing
        ? Object.assign(existing, body)
        : { id: body.id ?? `${table}-${rows.length + 1}`, created_at: body.created_at ?? "2026-01-01T00:00:00Z", ...body };
      if (!existing) rows.push(saved);
      return result([saved], 201);
    }
    if (method === "PATCH") {
      const selected = rows.filter((row) => matches(row, url.searchParams));
      selected.forEach((row) => Object.assign(row, body));
      return result(selected);
    }
    return result(null, 204);
  }) as typeof fetch;
}
const link = {
  id: "link-1", token: "token", provider_id: "office-1", patient_id: null,
  created_by: "actor", label: null, active: true, expires_at: null, uses: 0,
  last_used_at: null, created_at: "2026-01-01T00:00:00Z",
};
const address = {
  name: "Pat Patient", line1: "1 Main", line2: null, city: "Austin", state: "TX",
  postal_code: "78701", country: "US", phone: null,
};
function seed() {
  tables = {
    billing_settings: [{ id: 1, shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, version: 1 }],
    billing_products: [{ id: "11111111-1111-4111-8111-111111111111", name: "Control", slug: "control", active: true, floor_price_cents: 5999, hard_cost_cents: 433, stripe_tax_code: null }],
    billing_office_prices: [{ provider_id: "office-1", product_id: "11111111-1111-4111-8111-111111111111", sell_price_cents: 6999, subscription_enabled: true,
      stripe_product_id: "prod_1", stripe_price_id: "price_1", stripe_shipping_price_id: "price_ship" }],
    billing_connected_accounts: [{ provider_id: "office-1", stripe_account_id: "acct_1", disconnected_at: null, charges_enabled: true, tax_enabled: false }],
    billing_payers: [], billing_orders: [], billing_order_items: [], billing_ledger: [],
    billing_refunds: [], billing_disputes: [], billing_subscriptions: [], billing_payment_links: [link],
    providers: [{ provider_id: "office-1", office_name: "Harbor Health" }],
  };
  sequence = [];
  stripe = {
    customers: {
      create: vi.fn(async () => { sequence.push("stripe:customer"); return { id: "cus_1" }; }),
      update: vi.fn(async () => ({ id: "cus_1" })),
    },
    invoices: {
      create: vi.fn(async () => ({ id: "in_1" })),
      finalizeInvoice: vi.fn(async () => ({ id: "in_1", total: 7999, total_taxes: [], payments: { data: [] } })),
      retrieve: vi.fn(async (id: string) => id === "in_sub_new"
        ? { id, total: 7999, total_taxes: [], payments: { data: [{ payment: { payment_intent: { id: "pi_sub_new", client_secret: "secret_sub" } } }] } }
        : { id: "in_1", total: 7999, total_taxes: [], payments: { data: [{ payment: { payment_intent: { id: "pi_1", client_secret: "secret_1" } } }] } }),
      update: vi.fn(async () => ({})),
    },
    invoiceItems: { create: vi.fn(async () => ({})) },
    paymentIntents: { retrieve: vi.fn(async () => ({
      latest_charge: { id: "ch_1", application_fee_amount: 120, balance_transaction: { id: "txn_1", fee: 250 } },
    })) },
    charges: { retrieve: vi.fn(async () => ({ id: "ch_1", application_fee: { id: "fee_1" } })) },
    refunds: { create: vi.fn(async () => ({ id: "re_1", amount: 100, status: "succeeded" })) },
    applicationFees: { createRefund: vi.fn(async () => ({ id: "fr_1" })) },
    products: {
      retrieve: vi.fn(async (id: string) => { sequence.push("stripe:product-retrieve"); return { id }; }),
      create: vi.fn(async () => { sequence.push("stripe:product"); return { id: "prod_new" }; }),
    },
    prices: {
      retrieve: vi.fn(async (id: string) => { sequence.push("stripe:price-retrieve"); return { id, active: true, unit_amount: id === "price_ship" ? 1000 : 6999 }; }),
      create: vi.fn(async () => { sequence.push("stripe:price-create"); return { id: "price_new" }; }),
      update: vi.fn(async () => { sequence.push("stripe:price-update"); return {}; }),
    },
    subscriptions: {
      create: vi.fn(async () => {
        sequence.push("stripe:subscription");
        // Stripe refuses >4 expansion levels, so latest_invoice comes back unexpanded.
        return { id: "sub_stripe", current_period_end: 1_800_000_000, latest_invoice: "in_sub_new" };
      }),
    },
  };
  installFetch();
  __setStripeForTests(stripe);
  __setCredentialsForTests({ secret: "sk_test_x", publishable: "pk_test_x", account_id: "acct_platform" });
}
beforeEach(seed);
afterAll(() => {
  global.fetch = originalFetch;
  __setStripeForTests(null);
  __setCredentialsForTests(null);
});

describe("billing orders", () => {
  it("writes the order before Stripe and follows the invoice PaymentIntent fallback", async () => {
    const response = await createOneTimeOrder({
      link, payerInput: { name: "Pat Patient", email: "pat@example.com", phone: "" },
      shipping_address: address, items: [{ product_id: "11111111-1111-4111-8111-111111111111", quantity: 1 }],
    });
    expect(sequence.indexOf("db:billing_orders")).toBeLessThan(sequence.indexOf("stripe:customer"));
    expect(stripe.invoices.retrieve).toHaveBeenCalledOnce();
    expect(response.client_secret).toBe("secret_1");
    expect(response.order_id).toBe(tables.billing_orders[0].id);
    // Invoice items carry inline amounts; price_data.product_data is not a
    // valid invoice-item parameter and needs a pre-created Stripe product.
    const items = stripe.invoiceItems.create.mock.calls.map((call: any[]) => call[0]);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).not.toHaveProperty("price_data");
      expect(item).toMatchObject({ currency: "usd", quantity: expect.any(Number), unit_amount_decimal: expect.stringMatching(/^\d+$/), description: expect.any(String) });
    }
    expect(items.at(-1)).toMatchObject({ description: "Shipping", unit_amount_decimal: "1000" });
  });

  it("marks an invoice paid once and computes net from the balance transaction", async () => {
    tables.billing_payers.push({ id: "payer-1", provider_id: "office-1", name: "Pat", email: null, patient_id: null, phone: null });
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", payer_id: "payer-1", order_number: "TH-ABC123",
      status: "pending", total_cents: 1000, application_fee_cents: 100, subscription_id: null,
      metadata: {}, shipping_address: {}, hard_cost_cents: 0, shipping_cost_cents: 0,
    });
    tables.billing_order_items.push({ id: "item-1", order_id: "order-1", product_name_snapshot: "Control", quantity: 1 });
    const invoice = { id: "in_paid", amount_paid: 1000, metadata: { thinnr_order_id: "order-1" },
      payments: { data: [{ payment: { payment_intent: "pi_paid" } }] }, status_transitions: { paid_at: 1_800_000_000 } };
    resetStripeEventHandlers();
    registerOrderWebhookHandlers();
    const event = { type: "invoice.paid", data: { object: invoice } } as any;
    await dispatchStripeEvent(event, { kind: "connect", account: "acct_1", livemode: false });
    await dispatchStripeEvent(event, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_orders[0].office_net_cents).toBe(630);
    expect(tables.billing_orders[0].stripe_fee_cents).toBe(250);
    expect(tables.billing_ledger).toHaveLength(1);
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledOnce();
  });

  it("ignores an invoice from a different connected account", async () => {
    tables.billing_payers.push({ id: "payer-1", provider_id: "office-1", name: "Pat", email: null, patient_id: null, phone: null });
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", payer_id: "payer-1", order_number: "TH-ABC123",
      status: "pending", total_cents: 1000, application_fee_cents: 100, metadata: {}, shipping_address: {},
    });
    resetStripeEventHandlers();
    registerOrderWebhookHandlers();
    await dispatchStripeEvent({ type: "invoice.paid", data: { object: {
      id: "in_bad", amount_paid: 1000, metadata: { thinnr_order_id: "order-1" },
      payments: { data: [{ payment: { payment_intent: "pi_bad" } }] },
    } } } as any, { kind: "connect", account: "acct_other", livemode: false });
    expect(tables.billing_orders[0].status).toBe("pending");
    expect(tables.billing_ledger).toHaveLength(0);
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    await dispatchStripeEvent({ type: "invoice.paid", data: { object: {
      id: "in_platform", amount_paid: 1000, metadata: { thinnr_order_id: "order-1" },
      payments: { data: [{ payment: { payment_intent: "pi_platform" } }] },
    } } } as any, { kind: "platform", account: null, livemode: false });
    expect(tables.billing_orders[0].status).toBe("pending");
  });

  it("ignores subscription updates from another connected account", async () => {
    tables.billing_subscriptions.push({
      id: "sub-1", provider_id: "office-1", stripe_subscription_id: "sub_stripe",
      status: "active", current_period_end: null, cancel_at_period_end: false,
    });
    resetStripeEventHandlers();
    registerSubscriptionWebhookHandlers();
    await dispatchStripeEvent({ type: "customer.subscription.updated", data: { object: {
      id: "sub_stripe", status: "canceled", cancel_at_period_end: true, canceled_at: 1_800_000_000,
    } } } as any, { kind: "connect", account: "acct_other", livemode: false });
    expect(tables.billing_subscriptions[0]).toMatchObject({ status: "active", cancel_at_period_end: false });
  });

  it("writes incomplete subscription rows before the first Stripe call", async () => {
    const response = await createSubscriptionOrder({
      link, payerInput: { name: "Pat Patient", email: "pat@example.com", phone: "" },
      shipping_address: address, product_id: "11111111-1111-4111-8111-111111111111",
    });
    const firstStripe = sequence.findIndex((value) => value.startsWith("stripe:"));
    expect(sequence.indexOf("db:billing_subscriptions")).toBeLessThan(firstStripe);
    expect(sequence.indexOf("db:billing_orders")).toBeLessThan(firstStripe);
    expect(response.client_secret).toBe("secret_sub");
    expect(tables.billing_subscriptions[0]).toMatchObject({
      stripe_subscription_id: "sub_stripe", stripe_customer_id: "cus_1", shipping_cost_cents: 1000,
    });
  });

  it("rejects an offered price below the current break-even minimum", async () => {
    tables.billing_office_prices[0].sell_price_cents = 1;
    await expect(quoteOrder(link, [{ product_id: "11111111-1111-4111-8111-111111111111", quantity: 1 }], "one_time"))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("Control") });
  });

  it("refunds first-invoice application fee over-collection exactly", async () => {
    tables.billing_payers.push({ id: "payer-1", provider_id: "office-1", name: "Pat", email: null, patient_id: null, phone: null });
    tables.billing_subscriptions.push({ id: "sub-1", provider_id: "office-1", payer_id: "payer-1", product_id: tables.billing_products[0].id,
      stripe_subscription_id: "sub_stripe", application_fee_cents: 100 });
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", payer_id: "payer-1", order_number: "TH-ABC123",
      subscription_id: "sub-1", kind: "subscription_initial", stripe_invoice_id: "in_sub",
      status: "pending", total_cents: 1000, application_fee_cents: 100, metadata: {}, shipping_address: {},
      hard_cost_cents: 10, shipping_cost_cents: 20, hq_profit_cents: 70,
    });
    tables.billing_order_items.push({ id: "item-1", order_id: "order-1", product_name_snapshot: "Control", quantity: 1 });
    const invoice = { id: "in_sub", billing_reason: "subscription_create", amount_paid: 1000,
      payments: { data: [{ payment: { payment_intent: "pi_sub" } }] } };
    await markSubscriptionInvoicePaid(invoice, { kind: "connect", account: "acct_1", livemode: false });
    await markSubscriptionInvoicePaid(invoice, { kind: "connect", account: "acct_1", livemode: false });
    expect(stripe.applicationFees.createRefund).toHaveBeenCalledWith(
      "fee_1", { amount: 20 }, { idempotencyKey: "subscription:sub-1:fee-adjustment" },
    );
    expect(stripe.applicationFees.createRefund).toHaveBeenCalledOnce();
    expect(tables.billing_orders[0]).toMatchObject({
      application_fee_collected_cents: 100, office_net_cents: 650, hq_profit_cents: 70,
    });
    expect(tables.billing_ledger.filter((row) => row.kind === "application_fee_adjustment")).toHaveLength(1);
  });

  it("sets the exact renewal application fee on invoice.created", async () => {
    tables.billing_subscriptions.push({ id: "sub-1", provider_id: "office-1", stripe_subscription_id: "sub_stripe", application_fee_cents: 777 });
    resetStripeEventHandlers();
    registerSubscriptionWebhookHandlers();
    await dispatchStripeEvent({ type: "invoice.created", data: { object: {
      id: "in_renew", billing_reason: "subscription_cycle", subscription: "sub_stripe", total: 8000,
    } } } as any, { kind: "connect", account: "acct_1", livemode: false });
    expect(stripe.invoices.update).toHaveBeenCalledWith(
      "in_renew", { application_fee_amount: 777 }, { stripeAccount: "acct_1" },
    );
  });

  it("rejects a refund larger than the remaining balance", async () => {
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", status: "paid", total_cents: 1000,
      stripe_payment_intent_id: "pi_1", application_fee_cents: 100,
    });
    tables.billing_refunds.push({ id: "refund-1", order_id: "order-1", amount_cents: 700, status: "succeeded" });
    await expect(refundOrder("order-1", { amount_cents: 301, reason: "Requested" }, "actor"))
      .rejects.toMatchObject({ status: 400, field: "amount_cents" } satisfies Partial<BillingOrderError>);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
});