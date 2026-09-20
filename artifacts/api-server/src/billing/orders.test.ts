import { beforeEach, afterAll, describe, expect, vi } from "vitest";
import { it } from "./testing/context";
import { __setCredentialsForTests, __setStripeForTests } from "./stripe-client";
import {
  BillingOrderError, createOneTimeOrder, quoteOrder, refundOrder, registerOrderWebhookHandlers,
} from "./orders";
import {
  createSubscriptionOrder, markSubscriptionInvoiceFailed, markSubscriptionInvoicePaid,
  registerSubscriptionWebhookHandlers, retrySubscriptionPayment,
} from "./subscriptions";
import { dispatchStripeEvent, resetStripeEventHandlers } from "./webhooks";
import { mirrorPayout } from "./payouts";
import { BillingStoreError, insertIgnore } from "./store";

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
let raceInvoiceId: string | null;

function result(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "on_conflict"].includes(key)) continue;
    if (key === "or") {
      const clauses = raw.slice(1, -1).split(",");
      if (!clauses.some((clause) => {
        const [field, operator, ...rest] = clause.split(".");
        const value = rest.join(".");
        if (operator === "is" && value === "null") return row[field] == null;
        if (operator === "eq") return String(row[field]) === decodeURIComponent(value);
        if (operator === "neq") return row[field] != null && String(row[field]) !== decodeURIComponent(value);
        return false;
      })) return false;
      continue;
    }
    if (raw === "is.null") { if (row[key] != null) return false; continue; }
    if (raw.startsWith("eq.") && String(row[key]) !== decodeURIComponent(raw.slice(3))) return false;
    if (raw.startsWith("neq.") && (row[key] == null || String(row[key]) === decodeURIComponent(raw.slice(4)))) return false;
    if (raw.startsWith("in.(") && !raw.slice(4, -1).split(",").includes(String(row[key]))) return false;
  }
  return true;
}
function installFetch() {
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const table = url.pathname.split("/").at(-1)!;
    const rows = tables[table] ?? (tables[table] = []);
    // Historical test fixtures model known Test records, not quarantined data.
    for (const row of rows) {
      if (!("stripe_mode" in row)) row.stripe_mode = "test";
      if (!("stripe_platform_account_id" in row)) row.stripe_platform_account_id = "acct_platform";
    }
    const method = init?.method ?? "GET";
    if (method === "GET") return result(rows.filter((row) => matches(row, url.searchParams)));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "POST" && url.pathname.includes("/rpc/")) {
      sequence.push(`rpc:${table}`);
      if (table === "billing_claim_payment_link_use") {
        const link = (tables.billing_payment_links ?? []).find((row) => row.id === body.p_link_id);
        const claimable = !link || (link.active !== false && (link.max_uses == null || (link.uses ?? 0) < link.max_uses));
        if (link && claimable) link.uses = (link.uses ?? 0) + 1;
        return result(claimable, 200);
      }
      if (table === "billing_release_payment_link_use") {
        const link = (tables.billing_payment_links ?? []).find((row) => row.id === body.p_link_id);
        if (link && link.uses > 0) link.uses -= 1;
        return result(true, 200);
      }
      return result(null, 404);
    }
    if (method === "POST") {
      sequence.push(`db:${table}`);
      const prefer = String(new Headers(init?.headers).get("Prefer") ?? "");
      if (body.provider_id === "missing-fk") {
        return result({
          code: "23503", message: "insert or update violates foreign key constraint",
          details: "Key (provider_id)=(missing-fk) is not present.",
        }, 409);
      }
      if (table === "billing_orders" && body.stripe_invoice_id === raceInvoiceId) {
        rows.push({ ...body, id: "order-race-winner" });
        raceInvoiceId = null;
        return result([], 201);
      }
      if (prefer.includes("resolution=ignore-duplicates")) {
        const duplicate = table === "billing_orders"
          ? rows.some((row) => body.stripe_invoice_id != null && row.stripe_invoice_id === body.stripe_invoice_id)
          : table === "billing_ledger"
            ? rows.some((row) => body.stripe_ref != null && row.kind === body.kind && row.stripe_ref === body.stripe_ref)
            : false;
        if (duplicate) return result([], 201);
      }
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
    billing_refunds: [], billing_disputes: [], billing_subscriptions: [], billing_payouts: [], billing_payment_links: [link],
    providers: [{ provider_id: "office-1", office_name: "Harbor Health" }],
  };
  sequence = [];
  raceInvoiceId = null;
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
      pay: vi.fn(async () => ({ id: "in_retry", status: "paid" })),
    },
    invoiceItems: { create: vi.fn(async () => ({})) },
    paymentIntents: { retrieve: vi.fn(async () => ({
      latest_charge: { id: "ch_1", application_fee_amount: 120, balance_transaction: { id: "txn_1", fee: 250, fee_details: [{ type: "stripe_fee", amount: 130 }, { type: "application_fee", amount: 120 }] } },
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
    // The connected account's balance transaction fee includes our application
    // fee; only Stripe's own processing line counts as the Stripe fee.
    expect(tables.billing_orders[0].office_net_cents).toBe(750);
    expect(tables.billing_orders[0].stripe_fee_cents).toBe(130);
    expect(tables.billing_orders[0].stripe_charge_id).toBe("ch_1");
    expect(tables.billing_ledger).toHaveLength(1);
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledOnce();
  });

  it("finds the charge through the stored payment intent when the webhook invoice carries none", async () => {
    tables.billing_payers.push({ id: "payer-1", provider_id: "office-1", name: "Pat", email: null, patient_id: null, phone: null });
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", payer_id: "payer-1", order_number: "TH-ABC123",
      status: "pending", total_cents: 1000, application_fee_cents: 100, subscription_id: null,
      stripe_payment_intent_id: "pi_stored", metadata: {}, shipping_address: {}, hard_cost_cents: 0, shipping_cost_cents: 0,
    });
    tables.billing_order_items.push({ id: "item-1", order_id: "order-1", product_name_snapshot: "Control", quantity: 1 });
    // Current API versions: no `payment_intent`, no `payments` on the event payload.
    const invoice = { id: "in_paid", amount_paid: 1000, metadata: { thinnr_order_id: "order-1" }, status_transitions: { paid_at: 1_800_000_000 } };
    resetStripeEventHandlers();
    registerOrderWebhookHandlers();
    await dispatchStripeEvent({ type: "invoice.paid", data: { object: invoice } } as any, { kind: "connect", account: "acct_1", livemode: false });
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_stored", expect.anything(), expect.objectContaining({ stripeAccount: "acct_1" }));
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
    expect(tables.billing_orders[0]).toMatchObject({ status: "paid", stripe_charge_id: "ch_1", stripe_balance_transaction_id: "txn_1", stripe_fee_cents: 130 });
  });

  it("leaves the Stripe fee and office net unknown when no charge can be resolved", async () => {
    tables.billing_payers.push({ id: "payer-1", provider_id: "office-1", name: "Pat", email: null, patient_id: null, phone: null });
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", payer_id: "payer-1", order_number: "TH-ABC123",
      status: "pending", total_cents: 1000, application_fee_cents: 100, subscription_id: null,
      stripe_payment_intent_id: null, metadata: {}, shipping_address: {}, hard_cost_cents: 0, shipping_cost_cents: 0,
    });
    tables.billing_order_items.push({ id: "item-1", order_id: "order-1", product_name_snapshot: "Control", quantity: 1 });
    stripe.invoices.retrieve.mockResolvedValueOnce({ id: "in_paid", payments: { data: [] } });
    const invoice = { id: "in_paid", amount_paid: 1000, metadata: { thinnr_order_id: "order-1" }, status_transitions: { paid_at: 1_800_000_000 } };
    resetStripeEventHandlers();
    registerOrderWebhookHandlers();
    await dispatchStripeEvent({ type: "invoice.paid", data: { object: invoice } } as any, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_orders[0]).toMatchObject({ status: "paid", stripe_charge_id: null, stripe_fee_cents: null, office_net_cents: null });
    // The sale line never assumes a $0 fee silently: it is the pre-fee office share, flagged pending.
    expect(tables.billing_ledger).toHaveLength(1);
    expect(tables.billing_ledger[0]).toMatchObject({ kind: "sale", amount_cents: 900, detail: { total_cents: 1000, stripe_fee_cents: null, fee_pending: true } });

    // A replayed invoice.paid that can now resolve the charge finalizes the fee,
    // the office net and the SAME ledger line — no second sale is posted.
    stripe.invoices.retrieve.mockResolvedValueOnce({ id: "in_paid", payments: { data: [{ payment: { payment_intent: "pi_1" } }] } });
    await dispatchStripeEvent({ type: "invoice.paid", data: { object: invoice } } as any, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_orders[0]).toMatchObject({ status: "paid", stripe_charge_id: "ch_1", stripe_balance_transaction_id: "txn_1", stripe_fee_cents: 130, application_fee_collected_cents: 120, office_net_cents: 750 });
    expect(tables.billing_ledger).toHaveLength(1);
    expect(tables.billing_ledger[0]).toMatchObject({ kind: "sale", amount_cents: 750, application_fee_cents: 120, detail: { total_cents: 1000, stripe_fee_cents: 130, fee_pending: false } });

    // A further duplicate delivery changes nothing.
    const paymentIntentCalls = stripe.paymentIntents.retrieve.mock.calls.length;
    await dispatchStripeEvent({ type: "invoice.paid", data: { object: invoice } } as any, { kind: "connect", account: "acct_1", livemode: false });
    expect(stripe.paymentIntents.retrieve.mock.calls.length).toBe(paymentIntentCalls);
    expect(tables.billing_ledger).toHaveLength(1);
    expect(tables.billing_orders[0].office_net_cents).toBe(750);
  });

  it("converges a pending sale line on the next replay when the ledger write failed after the order update", async () => {
    tables.billing_payers.push({ id: "payer-1", provider_id: "office-1", name: "Pat", email: null, patient_id: null, phone: null });
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", payer_id: "payer-1", order_number: "TH-ABC123",
      status: "pending", total_cents: 1000, application_fee_cents: 100, subscription_id: null,
      stripe_payment_intent_id: null, metadata: {}, shipping_address: {}, hard_cost_cents: 0, shipping_cost_cents: 0,
    });
    tables.billing_order_items.push({ id: "item-1", order_id: "order-1", product_name_snapshot: "Control", quantity: 1 });
    stripe.invoices.retrieve.mockResolvedValueOnce({ id: "in_paid", payments: { data: [] } });
    const invoice = { id: "in_paid", amount_paid: 1000, metadata: { thinnr_order_id: "order-1" }, status_transitions: { paid_at: 1_800_000_000 } };
    resetStripeEventHandlers();
    registerOrderWebhookHandlers();
    await dispatchStripeEvent({ type: "invoice.paid", data: { object: invoice } } as any, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_ledger[0]).toMatchObject({ amount_cents: 900, detail: { fee_pending: true } });

    // Replay: the order update lands, then the ledger PATCH blows up.
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
      if (init?.method === "PATCH" && url.includes("/billing_ledger")) throw new Error("ledger unavailable");
      return realFetch(input, init);
    }) as typeof fetch;
    stripe.invoices.retrieve.mockResolvedValueOnce({ id: "in_paid", payments: { data: [{ payment: { payment_intent: "pi_1" } }] } });
    await expect(dispatchStripeEvent({ type: "invoice.paid", data: { object: invoice } } as any, { kind: "connect", account: "acct_1", livemode: false })).rejects.toThrow("ledger unavailable");
    global.fetch = realFetch;
    expect(tables.billing_orders[0]).toMatchObject({ stripe_fee_cents: 130, office_net_cents: 750 });
    expect(tables.billing_ledger[0]).toMatchObject({ amount_cents: 900, detail: { fee_pending: true } });

    // Next duplicate delivery finalizes the line from stored order values, with no Stripe lookup.
    const paymentIntentCalls = stripe.paymentIntents.retrieve.mock.calls.length;
    await dispatchStripeEvent({ type: "invoice.paid", data: { object: invoice } } as any, { kind: "connect", account: "acct_1", livemode: false });
    expect(stripe.paymentIntents.retrieve.mock.calls.length).toBe(paymentIntentCalls);
    expect(tables.billing_ledger).toHaveLength(1);
    expect(tables.billing_ledger[0]).toMatchObject({ amount_cents: 750, application_fee_cents: 120, detail: { total_cents: 1000, stripe_fee_cents: 130, fee_pending: false } });
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
      application_fee_collected_cents: 100, office_net_cents: 770, hq_profit_cents: 70,
    });
    expect(tables.billing_subscriptions[0]).toMatchObject({
      payment_failure_count: 0, last_failed_invoice_id: null, last_failure_message: null,
    });
    expect(tables.billing_ledger.filter((row) => row.kind === "application_fee_adjustment")).toHaveLength(1);
  });

  it("records a failed renewal order and sends only one email per invoice", async () => {
    process.env.RESEND_API_KEY = "test";
    process.env.CLAIM_EMAIL_FROM = "billing@example.com";
    tables.billing_payers.push({ id: "payer-1", provider_id: "office-1", name: "Pat Patient", email: "pat@example.com" });
    tables.billing_subscriptions.push({
      id: "sub-1", provider_id: "office-1", payer_id: "payer-1", patient_id: null,
      product_id: tables.billing_products[0].id, stripe_subscription_id: "sub_stripe", status: "active",
      unit_price_cents: 6999, shipping_charge_cents: 1000, shipping_cost_cents: 1000,
      application_fee_cents: 4599, shipping_address: {}, livemode: false, cancel_token: "cancel",
      payment_failure_count: 0, last_failed_invoice_id: null, last_payment_failed_at: null,
      last_hosted_invoice_url: null, last_failure_message: null, payment_failure_email_sent_invoice_id: null,
    });
    const invoice = {
      object: "invoice", id: "in_failed", billing_reason: "subscription_cycle", subscription: "sub_stripe",
      total: 7999, hosted_invoice_url: "https://invoice.stripe.test/pay",
      payments: { data: [{ payment: { payment_intent: { id: "pi_failed", last_payment_error: { message: "Card declined." } } } }] },
    };
    await markSubscriptionInvoiceFailed(invoice, { kind: "connect", account: "acct_1", livemode: false });
    await markSubscriptionInvoiceFailed(invoice, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_subscriptions[0]).toMatchObject({
      status: "past_due", payment_failure_count: 1, last_failed_invoice_id: "in_failed",
      payment_failure_email_sent_invoice_id: "in_failed", last_failure_message: "Card declined.",
    });
    expect(tables.billing_orders).toHaveLength(1);
    expect(tables.billing_orders[0]).toMatchObject({ kind: "subscription_renewal", status: "failed", paid_at: null });
    expect(sequence.filter((entry) => entry === "db:emails")).toHaveLength(1);
    delete process.env.RESEND_API_KEY;
    delete process.env.CLAIM_EMAIL_FROM;
  });

  it("returns the competing renewal order without inserting its item", async () => {
    tables.billing_subscriptions.push({
      id: "sub-1", provider_id: "office-1", payer_id: "payer-1", patient_id: null,
      product_id: tables.billing_products[0].id, stripe_subscription_id: "sub_stripe", status: "active",
      unit_price_cents: 6999, shipping_charge_cents: 1000, shipping_cost_cents: 1000,
      application_fee_cents: 4599, shipping_address: {}, livemode: false, payment_failure_count: 0,
      last_failed_invoice_id: null, payment_failure_email_sent_invoice_id: null,
    });
    raceInvoiceId = "in_race";
    await markSubscriptionInvoiceFailed({
      id: "in_race", billing_reason: "subscription_cycle", subscription: "sub_stripe", total: 7999,
    }, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_orders).toHaveLength(1);
    expect(tables.billing_orders[0]).toMatchObject({ id: "order-race-winner", status: "failed" });
    expect(tables.billing_order_items).toHaveLength(0);
  });

  it("does not regress a paid renewal after a failure event", async () => {
    tables.billing_subscriptions.push({
      id: "sub-1", provider_id: "office-1", stripe_subscription_id: "sub_stripe", status: "active",
      payment_failure_count: 0, last_failed_invoice_id: null,
    });
    tables.billing_orders.push({
      id: "order-paid", provider_id: "office-1", subscription_id: "sub-1",
      stripe_invoice_id: "in_paid_then_failed", status: "paid",
    });
    await markSubscriptionInvoiceFailed({
      id: "in_paid_then_failed", subscription: "sub_stripe",
    }, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_orders[0].status).toBe("paid");
    expect(tables.billing_subscriptions[0].status).toBe("active");
  });

  it("keeps paid dunning state when the same invoice fails late", async () => {
    tables.billing_payers.push({ id: "payer-1", provider_id: "office-1", name: "Pat", email: "pat@example.com" });
    tables.billing_subscriptions.push({
      id: "sub-1", provider_id: "office-1", payer_id: "payer-1", product_id: tables.billing_products[0].id,
      stripe_subscription_id: "sub_stripe", status: "active", payment_failure_count: 1,
      last_failed_invoice_id: "in_interleave", last_paid_invoice_id: null,
      payment_failure_email_sent_invoice_id: null,
    });
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", payer_id: "payer-1", subscription_id: "sub-1",
      stripe_invoice_id: "in_interleave", status: "pending", total_cents: 1000,
      application_fee_cents: 100, metadata: {}, shipping_address: {},
    });
    tables.billing_order_items.push({ id: "item-1", order_id: "order-1", product_name_snapshot: "Control", quantity: 1 });
    const invoice = {
      id: "in_interleave", subscription: "sub_stripe", billing_reason: "subscription_cycle",
      amount_paid: 1000, hosted_invoice_url: "https://invoice.stripe.test/pay",
      payments: { data: [{ payment: { payment_intent: "pi_interleave" } }] },
    };
    await markSubscriptionInvoicePaid(invoice, { kind: "connect", account: "acct_1", livemode: false });
    await markSubscriptionInvoiceFailed(invoice, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_orders[0].status).toBe("paid");
    expect(tables.billing_subscriptions[0]).toMatchObject({
      status: "active", payment_failure_count: 0, last_failed_invoice_id: null,
      last_paid_invoice_id: "in_interleave",
    });
    expect(sequence.filter((entry) => entry === "db:emails")).toHaveLength(0);
  });

  it("does not swallow non-unique PostgREST conflicts", async () => {
    await expect(insertIgnore("billing_ledger", {
      provider_id: "missing-fk", kind: "sale", stripe_ref: "ch_missing",
    }, "billing_ledger_kind_stripe_ref_unique")).rejects.toMatchObject({
      status: 409,
    } satisfies Partial<BillingStoreError>);
  });

  it("keeps one-time failure handling on the order and stores the short message", async () => {
    tables.billing_orders.push({ id: "order-1", provider_id: "office-1", status: "pending", stripe_payment_intent_id: "pi_failed" });
    resetStripeEventHandlers();
    registerOrderWebhookHandlers();
    await dispatchStripeEvent({ type: "payment_intent.payment_failed", data: { object: {
      object: "payment_intent", id: "pi_failed", last_payment_error: { message: "The card was declined." },
    } } } as any, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_orders[0]).toMatchObject({ status: "failed", failure_message: "The card was declined." });
    expect(tables.billing_subscriptions).toHaveLength(0);
  });

  it("retries the last failed invoice with a stable connected-account key", async () => {
    tables.billing_subscriptions.push({
      id: "sub-1", provider_id: "office-1", last_failed_invoice_id: "in_failed", payment_failure_count: 2,
    });
    await retrySubscriptionPayment("sub-1");
    expect(stripe.invoices.pay).toHaveBeenCalledWith(
      "in_failed", {}, { stripeAccount: "acct_1", idempotencyKey: "retry:sub-1:in_failed:2" },
    );
    tables.billing_subscriptions[0].last_failed_invoice_id = null;
    await expect(retrySubscriptionPayment("sub-1")).rejects.toMatchObject({ status: 409 });
  });

  it("surfaces a short card error from a manual retry", async () => {
    tables.billing_subscriptions.push({
      id: "sub-1", provider_id: "office-1", last_failed_invoice_id: "in_failed", payment_failure_count: 1,
    });
    stripe.invoices.pay.mockRejectedValueOnce({ type: "StripeCardError", message: "Your card was declined." });
    await expect(retrySubscriptionPayment("sub-1")).rejects.toMatchObject({
      status: 402, message: "Your card was declined.",
    });
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

  it("does not book a pending refund", async () => {
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", status: "paid", total_cents: 1000,
      stripe_payment_intent_id: "pi_1", application_fee_cents: 100,
    });
    stripe.refunds.create.mockResolvedValueOnce({ id: "re_pending", amount: 100, status: "pending" });
    await refundOrder("order-1", { amount_cents: 100, reason: "Requested" }, "actor");
    expect(tables.billing_orders[0].status).toBe("paid");
    expect(tables.billing_ledger).toHaveLength(0);
  });

  it("reverses a failed refund only when its succeeded debit exists", async () => {
    tables.billing_orders.push({ id: "order-1", provider_id: "office-1", status: "partially_refunded", total_cents: 1000 });
    tables.billing_refunds.push({ id: "refund-1", order_id: "order-1", stripe_refund_id: "re_failed", amount_cents: 100, status: "succeeded" });
    resetStripeEventHandlers();
    registerOrderWebhookHandlers();
    const event = { type: "refund.updated", data: { object: { id: "re_failed", status: "failed" } } } as any;
    await dispatchStripeEvent(event, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_ledger).toHaveLength(0);
    tables.billing_refunds[0].status = "succeeded";
    tables.billing_ledger.push({ kind: "refund", stripe_ref: "re_failed", amount_cents: -100 });
    await dispatchStripeEvent(event, { kind: "connect", account: "acct_1", livemode: false });
    expect(tables.billing_ledger).toContainEqual(expect.objectContaining({
      kind: "refund", stripe_ref: "re_failed:reversal", amount_cents: 100,
    }));
  });

  it("does not debit a failed payout", async () => {
    await mirrorPayout("office-1", { id: "po_failed", amount: 500, status: "failed", created: 1_800_000_000 });
    expect(tables.billing_ledger).toHaveLength(0);
  });
});
describe("charge.refunded reconciliation", () => {
  it("lists refunds on the connected account when the webhook charge carries none", async () => {
    tables.billing_payers.push({ id: "payer-1", provider_id: "office-1", name: "Pat", email: null, patient_id: null, phone: null });
    tables.billing_orders.push({
      id: "order-1", provider_id: "office-1", payer_id: "payer-1", order_number: "TH-ABC123", subscription_id: null,
      status: "paid", total_cents: 1000, application_fee_cents: 100, stripe_charge_id: "ch_1", metadata: {}, shipping_address: {},
    });
    (stripe as any).refunds.list = vi.fn(async () => ({ data: [{ id: "re_hook", amount: 400, status: "succeeded", reason: "requested_by_customer", metadata: { requested_reason: "One item returned" } }] }));
    resetStripeEventHandlers();
    registerOrderWebhookHandlers();
    const charge = { id: "ch_1", amount: 1000, amount_refunded: 400 }; // no `refunds` list on current API versions
    await dispatchStripeEvent({ type: "charge.refunded", data: { object: charge } } as any, { kind: "connect", account: "acct_1", livemode: false });
    expect((stripe as any).refunds.list).toHaveBeenCalledWith({ charge: "ch_1", limit: 100 }, expect.objectContaining({ stripeAccount: "acct_1" }));
    expect(tables.billing_refunds).toEqual([expect.objectContaining({ order_id: "order-1", stripe_refund_id: "re_hook", amount_cents: 400, status: "succeeded", reason: "One item returned" })]);
    expect(tables.billing_ledger).toEqual([expect.objectContaining({ kind: "refund", amount_cents: -400, stripe_ref: "re_hook" })]);
    expect(tables.billing_orders[0].status).toBe("partially_refunded");
  });
});
