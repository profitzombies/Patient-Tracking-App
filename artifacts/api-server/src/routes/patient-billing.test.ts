import crypto from "node:crypto";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";

const SUPABASE = "http://patient-billing.supabase.test";
type Row = Record<string, any>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

class Backend {
  tables: Record<string, Row[]> = {};
  tokens = new Map<string, string>();
  inserts: string[] = [];

  reset() {
    this.tables = {
      patients: [], patient_consents: [], providers: [], billing_connected_accounts: [],
      billing_settings: [], billing_products: [], billing_product_images: [], billing_office_prices: [], billing_office_settings: [],
      billing_orders: [], billing_order_items: [], billing_refunds: [], billing_subscriptions: [],
      billing_payment_links: [], billing_payers: [], billing_shipments: [],
    };
    this.tokens.clear();
    this.inserts = [];
  }

  signedIn(token = "patient-token", linked = true) {
    const userId = crypto.randomUUID();
    const patientId = crypto.randomUUID();
    const providerId = crypto.randomUUID();
    this.tokens.set(token, userId);
    if (linked) {
      this.tables.patients.push({ id: patientId, auth_user_id: userId, provider_id: providerId });
      this.tables.patient_consents.push({
        id: crypto.randomUUID(), patient_id: patientId, policy_version: CONSENT_POLICY_VERSION,
        terms_accepted: true, privacy_accepted: true, health_data_accepted: true,
        photo_analysis_accepted: true, recorded_at: "2026-09-01T00:00:00.000Z",
      });
    }
    return { userId, patientId, providerId };
  }

  private filters(url: URL): Array<[string, string, string]> {
    const result: Array<[string, string, string]> = [];
    url.searchParams.forEach((raw, key) => {
      if (["select", "order", "limit", "on_conflict"].includes(key)) return;
      const dot = raw.indexOf(".");
      result.push([key, raw.slice(0, dot), raw.slice(dot + 1)]);
    });
    return result;
  }

  private matches(row: Row, [column, operation, raw]: [string, string, string]): boolean {
    if (operation === "eq") return String(row[column] ?? "") === raw;
    if (operation === "is" && raw === "null") return row[column] == null;
    if (operation === "in") {
      return raw.replace(/^\(|\)$/g, "").split(",").includes(String(row[column]));
    }
    throw new Error(`Unsupported fake filter: ${column} ${operation} ${raw}`);
  }

  handle(href: string, init?: RequestInit): Response {
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/auth/v1/user") {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /i, "") ?? "";
      const id = this.tokens.get(token);
      return id ? json(200, { id }) : json(401, { message: "invalid token" });
    }
    const match = url.pathname.match(/^\/rest\/v1\/([^/]+)$/);
    if (!match) return json(404, { message: `Unhandled fake path ${url.pathname}` });
    const table = match[1];
    const rows = this.tables[table];
    if (!rows) return json(404, { message: `Unknown fake table ${table}` });
    const matching = () => rows.filter((row) => this.filters(url).every((filter) => this.matches(row, filter)));
    if (method === "GET") {
      let selected = matching();
      const order = url.searchParams.get("order");
      if (order) {
        const [column, direction] = order.split(".");
        selected = [...selected].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (direction === "desc" ? -1 : 1));
      }
      const limit = Number(url.searchParams.get("limit"));
      if (limit) selected = selected.slice(0, limit);
      return json(200, selected);
    }
    if (method === "POST") {
      const incoming = JSON.parse(String(init?.body ?? "{}"));
      const row = { id: incoming.id ?? crypto.randomUUID(), created_at: "2026-09-20T00:00:00.000Z", ...incoming };
      rows.push(row);
      this.inserts.push(table);
      return json(201, [row]);
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body ?? "{}"));
      const changed = matching();
      changed.forEach((row) => Object.assign(row, patch));
      return json(200, changed);
    }
    return json(405, { message: "Unsupported fake method" });
  }
}

const backend = new Backend();
let server: http.Server;
let base = "";
const chargeRetrieve = vi.fn();
const intentRetrieve = vi.fn();
const invoiceRetrieve = vi.fn();
const subscriptionUpdate = vi.fn();

async function api(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: await response.json() as Row };
}

function billingRow(overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(), order_number: "TH-100", provider_id: crypto.randomUUID(),
    payer_id: crypto.randomUUID(), patient_id: crypto.randomUUID(), link_id: null, kind: "one_time",
    subscription_id: null, status: "paid", currency: "usd", subtotal_cents: 5000,
    shipping_charge_cents: 700, tax_cents: 0, total_cents: 5700, application_fee_cents: 500,
    application_fee_collected_cents: null, stripe_fee_cents: null, office_net_cents: null,
    hard_cost_cents: 1000, shipping_cost_cents: 200, hq_profit_cents: 300,
    shipping_address: {}, stripe_invoice_id: null, stripe_payment_intent_id: null,
    stripe_charge_id: "ch_1", stripe_balance_transaction_id: null, livemode: false,
    paid_at: "2026-09-19T00:00:00.000Z", fulfillment_status: "unfulfilled",
    tracking_number: null, carrier: null, shipped_at: null, shipped_by: null,
    canceled_reason: null, metadata: {}, failure_message: null,
    created_at: "2026-09-19T00:00:00.000Z", ...overrides,
  };
}

function subscriptionRow(overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(), provider_id: crypto.randomUUID(), payer_id: crypto.randomUUID(),
    patient_id: crypto.randomUUID(), product_id: crypto.randomUUID(), stripe_subscription_id: "sub_1",
    stripe_customer_id: "cus_1", status: "active", unit_price_cents: 5000,
    shipping_charge_cents: 700, shipping_cost_cents: 200, application_fee_cents: 500,
    shipping_address: {}, current_period_end: "2026-10-20T00:00:00.000Z",
    cancel_at_period_end: false, canceled_at: null, cancel_token: "cancel-token", livemode: false,
    last_payment_failed_at: null, payment_failure_count: 0, last_failed_invoice_id: null,
    last_hosted_invoice_url: null, last_failure_message: null,
    payment_failure_email_sent_invoice_id: null, last_paid_invoice_id: null, paused_at: null,
    pending_product_id: null, pending_unit_price_cents: null, pending_application_fee_cents: null,
    pending_effective_at: null, pending_shipping_charge_cents: null, pending_stripe_price_id: null,
    created_at: "2026-09-19T00:00:00.000Z", ...overrides,
  };
}

function seedOffice(providerId: string, options: { available?: boolean } = {}) {
  backend.tables.providers.push({ provider_id: providerId, office_name: "Beacon Health", provider_name: "Beacon" });
  backend.tables.billing_settings.push({ id: 1, shipping_charge_cents: 700, shipping_cost_cents: 200 });
  backend.tables.billing_connected_accounts.push({
    provider_id: providerId, stripe_account_id: "acct_patient", charges_enabled: options.available !== false,
    disconnected_at: null, tax_enabled: false,
  });
  const product = {
    id: crypto.randomUUID(), name: "Control", description: "Daily support", active: true,
    status: "active", created_at: "2026-01-01T00:00:00.000Z",
  };
  backend.tables.billing_products.push(product);
  backend.tables.billing_office_prices.push({
    provider_id: providerId, product_id: product.id, sell_price_cents: 5000, subscription_enabled: true,
  });
  backend.tables.billing_product_images.push({
    id: crypto.randomUUID(), product_id: product.id, sort_order: 1, is_default: true,
    created_at: "2026-01-01T00:00:00.000Z",
  });
  return product;
}

beforeAll(async () => {
  process.env.SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
  process.env.BILLING_PUBLIC_ORIGIN = "https://pay.thinnr.test";
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).hostname === "patient-billing.supabase.test"
      ? Promise.resolve(backend.handle(href, init))
      : nativeFetch(input as string, init);
  });
  const { __setStripeForTests } = await import("../billing/stripe-client");
  __setStripeForTests({
    charges: { retrieve: chargeRetrieve },
    paymentIntents: { retrieve: intentRetrieve },
    invoices: { retrieve: invoiceRetrieve },
    subscriptions: { update: subscriptionUpdate },
  } as any);
  const { default: patientBilling } = await import("./patient-billing");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error: vi.fn(), info: vi.fn() };
    next();
  });
  app.use("/api", patientBilling);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  (await import("../billing/stripe-client")).__setStripeForTests(null);
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  backend.reset();
  vi.clearAllMocks();
});

describe("patient billing authentication and overview", () => {
  it("returns 401 without a bearer session and 403 for an unlinked session", async () => {
    expect((await api("GET", "/api/patient-data/billing/overview")).status).toBe(401);
    backend.signedIn("staff-token", false);
    expect((await api("GET", "/api/patient-data/billing/overview", { token: "staff-token" })).status).toBe(403);
  });

  it("returns the shared offering plus bulk-computed orders and subscriptions", async () => {
    const patient = backend.signedIn();
    const product = seedOffice(patient.providerId);
    const order = billingRow({ provider_id: patient.providerId, patient_id: patient.patientId });
    backend.tables.billing_orders.push(order);
    backend.tables.billing_order_items.push({
      id: crypto.randomUUID(), order_id: order.id, product_id: product.id,
      product_name_snapshot: "Control", quantity: 2, unit_price_cents: 5000,
      floor_price_cents_snapshot: 3000, thinnr_share_cents: 100, hard_cost_cents_snapshot: 500,
    });
    backend.tables.billing_refunds.push({ id: crypto.randomUUID(), order_id: order.id, amount_cents: 1250, status: "succeeded" });
    backend.tables.billing_refunds.push({ id: crypto.randomUUID(), order_id: order.id, amount_cents: 800, status: "failed" });
    backend.tables.billing_subscriptions.push(subscriptionRow({
      provider_id: patient.providerId, patient_id: patient.patientId, product_id: product.id,
      paused_at: "2026-09-20T00:00:00.000Z",
    }));
    const response = await api("GET", "/api/patient-data/billing/overview", { token: "patient-token" });
    expect(response.status).toBe(200);
    const { officeOffering } = await import("../billing/catalog");
    expect(response.json.products).toEqual(await officeOffering(patient.providerId));
    expect(response.json.office).toEqual({
      provider_id: patient.providerId, office_name: "Beacon Health", payments_available: true,
    });
    expect(response.json.orders[0]).toMatchObject({
      items_label: "Control × 2", item_count: 2, refunded_cents: 1250, receipt_available: true,
    });
    expect(response.json.subscriptions[0]).toMatchObject({ product_name: "Control", paused: true });
  });
});

describe("patient checkout links", () => {
  it("returns 409 when the office cannot accept payments", async () => {
    const patient = backend.signedIn();
    seedOffice(patient.providerId, { available: false });
    expect((await api("POST", "/api/patient-data/billing/checkout-link", {
      token: "patient-token", body: {},
    })).status).toBe(409);
  });

  it("reuses a matching app link without inserting and creates one when absent", async () => {
    const patient = backend.signedIn();
    seedOffice(patient.providerId);
    backend.tables.billing_payment_links.push({
      id: crypto.randomUUID(), token: "existing-token", provider_id: patient.providerId,
      patient_id: patient.patientId, created_by: patient.userId, label: "Patient app", active: true,
      expires_at: null, max_uses: null, product_id: null, uses: 0, created_at: "2026-01-01T00:00:00.000Z",
    });
    const first = await api("POST", "/api/patient-data/billing/checkout-link", { token: "patient-token", body: {} });
    const second = await api("POST", "/api/patient-data/billing/checkout-link", { token: "patient-token", body: {} });
    expect(first.json.token).toBe("existing-token");
    expect(second.json.token).toBe("existing-token");
    expect(backend.inserts.filter((table) => table === "billing_payment_links")).toHaveLength(0);

    backend.tables.billing_payment_links = [];
    const created = await api("POST", "/api/patient-data/billing/checkout-link", { token: "patient-token", body: {} });
    expect(created.status).toBe(200);
    expect(created.json.url).toMatch(/^https:\/\/pay\.thinnr\.test\/pay\/.+\?source=app$/);
    expect(backend.inserts.filter((table) => table === "billing_payment_links")).toHaveLength(1);
  });

  it("rejects a product outside the office offering", async () => {
    const patient = backend.signedIn();
    seedOffice(patient.providerId);
    const response = await api("POST", "/api/patient-data/billing/checkout-link", {
      token: "patient-token", body: { product_id: crypto.randomUUID() },
    });
    expect(response.status).toBe(400);
  });
});

describe("patient receipts", () => {
  function receiptSetup(overrides: Row = {}) {
    const patient = backend.signedIn();
    seedOffice(patient.providerId);
    const order = billingRow({ provider_id: patient.providerId, patient_id: patient.patientId, ...overrides });
    backend.tables.billing_orders.push(order);
    return { patient, order };
  }

  it("loads a one-time charge receipt on the connected account", async () => {
    const { order } = receiptSetup();
    chargeRetrieve.mockResolvedValue({ receipt_url: "https://stripe.test/charge" });
    const response = await api("GET", `/api/patient-data/billing/orders/${order.id}/receipt`, { token: "patient-token" });
    expect(response.json).toMatchObject({ order_number: "TH-100", receipt_url: "https://stripe.test/charge" });
    expect(chargeRetrieve).toHaveBeenCalledWith("ch_1", {}, { stripeAccount: "acct_patient" });
  });

  it("expands a payment intent latest charge", async () => {
    const { order } = receiptSetup({ stripe_charge_id: null, stripe_payment_intent_id: "pi_1" });
    intentRetrieve.mockResolvedValue({ latest_charge: { receipt_url: "https://stripe.test/intent" } });
    const response = await api("GET", `/api/patient-data/billing/orders/${order.id}/receipt`, { token: "patient-token" });
    expect(response.json.receipt_url).toBe("https://stripe.test/intent");
    expect(intentRetrieve).toHaveBeenCalledWith("pi_1", { expand: ["latest_charge"] }, { stripeAccount: "acct_patient" });
  });

  it("returns the hosted invoice and PDF for a subscription order", async () => {
    const { order } = receiptSetup({
      kind: "subscription_renewal", stripe_charge_id: null, stripe_invoice_id: "in_1",
    });
    invoiceRetrieve.mockResolvedValue({ hosted_invoice_url: "https://stripe.test/invoice", invoice_pdf: "https://stripe.test/invoice.pdf" });
    const response = await api("GET", `/api/patient-data/billing/orders/${order.id}/receipt`, { token: "patient-token" });
    expect(response.json).toMatchObject({
      receipt_url: null, invoice_url: "https://stripe.test/invoice",
      invoice_pdf_url: "https://stripe.test/invoice.pdf",
    });
  });

  it("does not expose another patient's or a pending order's receipt", async () => {
    const { order } = receiptSetup({ patient_id: crypto.randomUUID() });
    expect((await api("GET", `/api/patient-data/billing/orders/${order.id}/receipt`, { token: "patient-token" })).status).toBe(404);
    order.patient_id = backend.tables.patients[0].id;
    order.status = "pending";
    expect((await api("GET", `/api/patient-data/billing/orders/${order.id}/receipt`, { token: "patient-token" })).status).toBe(404);
    expect(chargeRetrieve).not.toHaveBeenCalled();
  });
});

describe("patient subscription cancellation", () => {
  function cancelSetup(overrides: Row = {}) {
    const patient = backend.signedIn();
    const product = seedOffice(patient.providerId);
    const payer = { id: crypto.randomUUID(), provider_id: patient.providerId, patient_id: patient.patientId, name: "Patient", email: null, phone: null };
    backend.tables.billing_payers.push(payer);
    const subscription = subscriptionRow({
      provider_id: patient.providerId, patient_id: patient.patientId, product_id: product.id,
      payer_id: payer.id, ...overrides,
    });
    backend.tables.billing_subscriptions.push(subscription);
    return { patient, subscription };
  }

  it("returns 404 for another patient's subscription and 409 when already canceled", async () => {
    const { subscription } = cancelSetup({ patient_id: crypto.randomUUID() });
    expect((await api("POST", `/api/patient-data/billing/subscriptions/${subscription.id}/cancel`, { token: "patient-token" })).status).toBe(404);
    subscription.patient_id = backend.tables.patients[0].id;
    subscription.cancel_at_period_end = true;
    expect((await api("POST", `/api/patient-data/billing/subscriptions/${subscription.id}/cancel`, { token: "patient-token" })).status).toBe(409);
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  it("cancels at period end and returns the patient subscription shape", async () => {
    const { subscription } = cancelSetup();
    subscriptionUpdate.mockResolvedValue({
      status: "active", cancel_at_period_end: true, current_period_end: 1792454400, canceled_at: null,
    });
    const response = await api("POST", `/api/patient-data/billing/subscriptions/${subscription.id}/cancel`, { token: "patient-token" });
    expect(response.status).toBe(200);
    expect(subscriptionUpdate).toHaveBeenCalledWith(
      "sub_1", { cancel_at_period_end: true }, { stripeAccount: "acct_patient" },
    );
    expect(response.json).toMatchObject({ product_name: "Control", cancel_at_period_end: true, paused: false });
  });
});