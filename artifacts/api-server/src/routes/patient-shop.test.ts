import crypto from "node:crypto";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";

/**
 * Patient shop routes against a PostgREST-shaped fake and a scripted Stripe.
 * Covers the storefront rule, mixed-cart pricing, checkout (rows before
 * charges, honest partial failures, idempotent replay), saved cards, order
 * history + shipments, subscription self-service, and that a patient can
 * never read or move another patient's or office's data.
 */
const SUPABASE = "http://patient-shop.supabase.test";
type Row = Record<string, any>;
const PRODUCT = "11111111-1111-4111-8111-111111111111";
const ADDON = "22222222-2222-4222-8222-222222222222";
const ADDRESS = { name: "Pat Patient", line1: "1 Main St", line2: null, city: "Austin", state: "TX", postal_code: "78701", country: "US", phone: null };

vi.mock("../billing/prices", async (original) => ({
  ...(await original<typeof import("../billing/prices")>()),
  ensureRecurringPrices: vi.fn(async (_providerId: string, productId: string) => ({
    provider_id: "office-1", product_id: productId, sell_price_cents: 6999, subscription_enabled: true,
    stripe_product_id: "prod_1", stripe_price_id: "price_legacy", stripe_shipping_price_id: "price_ship_legacy",
    stripe_cadence_prices: {
      "4": { price_id: "price_4w", shipping_price_id: "price_ship_4w", unit_amount_cents: 6299, interval_count: 4 },
      "8": { price_id: "price_8w", shipping_price_id: "price_ship_8w", unit_amount_cents: 6299, interval_count: 8 },
    },
  })),
}));

function missing(message: string): Error {
  return new Stripe.errors.StripeInvalidRequestError({ message, code: "resource_missing", type: "invalid_request_error" });
}
function declined(message: string): Error {
  return new Stripe.errors.StripeCardError({ message, code: "card_declined", decline_code: "generic_decline", type: "card_error" });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

class Backend {
  tables: Record<string, Row[]> = {};
  tokens = new Map<string, string>();
  inserts: string[] = [];
  seq = 0;

  reset() {
    this.tables = {
      patients: [], patient_consents: [], providers: [], billing_connected_accounts: [], billing_settings: [],
      billing_products: [], billing_product_images: [], billing_office_prices: [], billing_orders: [],
      billing_order_items: [], billing_refunds: [], billing_subscriptions: [], billing_payment_links: [],
      billing_payers: [], billing_shipments: [], billing_ledger: [], billing_carts: [],
    };
    this.tokens.clear();
    this.inserts = [];
    this.seq = 0;
  }

  signedIn(token: string, providerId: string) {
    const userId = crypto.randomUUID();
    const patientId = crypto.randomUUID();
    this.tokens.set(token, userId);
    this.tables.patients.push({ id: patientId, auth_user_id: userId, provider_id: providerId, first_name: "Pat", last_name: "Patient", email: `${token}@example.com`, phone: null });
    this.tables.patient_consents.push({
      id: crypto.randomUUID(), patient_id: patientId, policy_version: CONSENT_POLICY_VERSION,
      terms_accepted: true, privacy_accepted: true, health_data_accepted: true, photo_analysis_accepted: true,
      recorded_at: "2026-09-01T00:00:00.000Z",
    });
    return { userId, patientId, providerId };
  }

  private parse(raw: string): [string, string] {
    const dot = raw.indexOf(".");
    return [raw.slice(0, dot), raw.slice(dot + 1)];
  }

  private matches(row: Row, column: string, operation: string, raw: string): boolean {
    if (column === "or") {
      return raw.replace(/^\(|\)$/g, "").split(",").some((clause) => {
        const [col, rest] = [clause.slice(0, clause.indexOf(".")), clause.slice(clause.indexOf(".") + 1)];
        const [op, value] = this.parse(rest);
        return this.matches(row, col, op, value);
      });
    }
    const value = row[column];
    if (operation === "eq") return String(value ?? "") === raw;
    if (operation === "neq") return String(value ?? "") !== raw;
    if (operation === "is" && raw === "null") return value == null;
    if (operation === "lt") return String(value) < raw;
    if (operation === "gt") return String(value) > raw;
    if (operation === "gte") return String(value) >= raw;
    if (operation === "lte") return String(value) <= raw;
    if (operation === "in") return raw.replace(/^\(|\)$/g, "").split(",").includes(String(value));
    throw new Error(`Unsupported fake filter: ${column} ${operation} ${raw}`);
  }

  private select(url: URL, rows: Row[]): Row[] {
    const filters: Array<[string, string, string]> = [];
    url.searchParams.forEach((raw, key) => {
      if (["select", "order", "limit", "on_conflict"].includes(key)) return;
      if (key === "or") { filters.push(["or", "", raw]); return; }
      const [op, value] = this.parse(raw);
      filters.push([key, op, value]);
    });
    return rows.filter((row) => filters.every(([column, op, raw]) => this.matches(row, column, op, raw)));
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
    if (method === "GET") {
      let selected = this.select(url, rows);
      const order = url.searchParams.get("order");
      if (order) {
        const keys = order.split(",").map((part) => part.split("."));
        selected = [...selected].sort((a, b) => {
          for (const [column, direction] of keys) {
            const cmp = String(a[column]).localeCompare(String(b[column]));
            if (cmp) return direction === "desc" ? -cmp : cmp;
          }
          return 0;
        });
      }
      const limit = Number(url.searchParams.get("limit"));
      if (limit) selected = selected.slice(0, limit);
      return json(200, selected);
    }
    if (method === "POST") {
      const incoming = JSON.parse(String(init?.body ?? "{}"));
      const prefer = new Headers(init?.headers).get("prefer") ?? "";
      const unique = table === "billing_shipments" ? (row: Row) => row.order_id === incoming.order_id
        : table === "billing_ledger" ? (row: Row) => row.kind === incoming.kind && row.stripe_ref === incoming.stripe_ref
        : table === "billing_payers" && incoming.patient_id ? (row: Row) => row.provider_id === incoming.provider_id && row.patient_id === incoming.patient_id
        : (row: Row) => Boolean(incoming.id) && row.id === incoming.id;
      if (rows.some(unique)) {
        const constraint = table === "billing_shipments" ? "billing_shipments_order_id_key"
          : table === "billing_ledger" ? "billing_ledger_kind_stripe_ref_unique"
          : table === "billing_payers" && incoming.patient_id ? "billing_payers_provider_patient_key" : `${table}_pkey`;
        if (prefer.includes("ignore-duplicates")) return json(409, { code: "23505", message: `duplicate key value violates unique constraint "${constraint}"` });
        return json(409, { code: "23505", message: `duplicate key value violates unique constraint "${constraint}"` });
      }
      this.seq += 1;
      const stamp = new Date(Date.UTC(2026, 8, 20, 0, 0, this.seq)).toISOString();
      const row = { id: incoming.id ?? crypto.randomUUID(), created_at: stamp, updated_at: stamp, ...incoming };
      rows.push(row);
      this.inserts.push(table);
      if (table === "billing_orders") {
        // Mirrors the after-insert trigger: every order starts with a processing shipment.
        this.tables.billing_shipments.push({
          id: crypto.randomUUID(), order_id: row.id, provider_id: row.provider_id, status: "processing", carrier: null,
          tracking_number: null, tracking_url: null, source: "staff", external_id: null, label_created_at: null,
          shipped_at: null, delivered_at: null, canceled_at: null, canceled_reason: null, events: [], updated_by: null,
          created_at: stamp, updated_at: stamp,
        });
      }
      return json(201, [row]);
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body ?? "{}"));
      const changed = this.select(url, rows);
      changed.forEach((row) => Object.assign(row, patch, { updated_at: new Date(Date.UTC(2026, 8, 21, 0, 0, ++this.seq)).toISOString() }));
      return json(200, changed);
    }
    if (method === "DELETE") {
      const doomed = new Set(this.select(url, rows));
      this.tables[table] = rows.filter((row) => !doomed.has(row));
      return json(204, []);
    }
    return json(405, { message: "Unsupported fake method" });
  }
}

const backend = new Backend();
let server: http.Server;
let base = "";

/** Scripted Stripe: records calls, answers with plausible objects, and lets a test force a decline. */
const stripe = {
  declineNext: null as null | { message: string },
  customers: {
    // Stripe replays an idempotency key with the original object; a racing second
    // create for the same payer must come back as the SAME customer.
    create: vi.fn(async (params: any, opts?: any) => {
      const key = opts?.idempotencyKey;
      if (key && stripe.customerKeys.has(key)) return stripe.customerKeys.get(key);
      const customer = { id: `cus_${crypto.randomUUID().slice(0, 8)}`, ...params };
      if (key) stripe.customerKeys.set(key, customer);
      return customer;
    }),
    update: vi.fn(async (id: string, params: any) => {
      const next = params?.invoice_settings?.default_payment_method;
      if (typeof next === "string") stripe.defaults.set(id, next);
      return { id, ...params };
    }),
    retrieve: vi.fn(async (id: string) => ({ id, invoice_settings: { default_payment_method: stripe.defaults.get(id) ?? null } })),
  },
  defaults: new Map<string, string>(),
  methods: new Map<string, any>(),
  paymentMethods: {
    retrieve: vi.fn(async (id: string) => {
      const method = stripe.methods.get(id);
      if (!method) throw missing("No such payment method");
      return method;
    }),
    attach: vi.fn(async (id: string, params: any) => { stripe.methods.get(id).customer = params.customer; return stripe.methods.get(id); }),
    detach: vi.fn(async (id: string) => { stripe.methods.get(id).customer = null; return stripe.methods.get(id); }),
    list: vi.fn(async (params: any) => ({ data: [...stripe.methods.values()].filter((method) => method.customer === params.customer) })),
  },
  setupIntents: { create: vi.fn(async (params: any) => ({ id: "seti_1", client_secret: "seti_secret", ...params })) },
  invoices: {
    create: vi.fn(async (params: any) => ({ id: `in_${crypto.randomUUID().slice(0, 8)}`, status: "draft", ...params })),
    finalizeInvoice: vi.fn(async (id: string) => ({ id, status: "open", total: stripe.invoiceTotals.get(id) ?? 0, payment_intent: `pi_${id}` })),
    pay: vi.fn(async (id: string) => {
      if (stripe.declineNext) {
        const decline = stripe.declineNext;
        stripe.declineNext = null;
        throw declined(decline.message);
      }
      return { id, status: "paid", total: stripe.invoiceTotals.get(id) ?? 0, amount_paid: stripe.invoiceTotals.get(id) ?? 0,
        payment_intent: `pi_${id}`, ...(stripe.invoiceSubscriptions.get(id) ? { subscription: stripe.invoiceSubscriptions.get(id), billing_reason: "subscription_create" } : {}) };
    }),
    retrieve: vi.fn(async (id: string) => ({ id, status: "open", total: stripe.invoiceTotals.get(id) ?? 0, payment_intent: `pi_${id}`, subscription: stripe.invoiceSubscriptions.get(id) ?? null })),
    voidInvoice: vi.fn(async (id: string) => ({ id, status: "void" })),
    del: vi.fn(async (id: string) => ({ id, deleted: true })),
  },
  invoiceTotals: new Map<string, number>(),
  customerKeys: new Map<string, any>(),
  invoiceSubscriptions: new Map<string, string>(),
  cycleResets: [] as string[],
  invoiceItems: {
    create: vi.fn(async (params: any) => {
      const total = (stripe.invoiceTotals.get(params.invoice) ?? 0) + Number(params.unit_amount_decimal) * params.quantity;
      stripe.invoiceTotals.set(params.invoice, total);
      return { id: `ii_${total}`, ...params };
    }),
  },
  subscriptions: {
    create: vi.fn(async (params: any) => {
      const id = `sub_${crypto.randomUUID().slice(0, 8)}`;
      const invoiceId = `in_first_${id}`;
      const total = params.items.reduce((sum: number, item: any) => sum + (item.price === "price_ship_4w" || item.price === "price_ship_8w" ? 1000 : 6299 * (item.quantity ?? 1)), 0);
      stripe.invoiceTotals.set(invoiceId, total);
      stripe.invoiceSubscriptions.set(invoiceId, id);
      stripe.live.set(id, { id, status: "incomplete", latest_invoice: invoiceId, current_period_end: 1_790_000_000, items: { data: params.items.map((item: any, index: number) => ({ id: `si_${index}_${id}`, price: { id: item.price, product: "prod_1" }, quantity: item.quantity ?? 1 })) }, default_payment_method: params.default_payment_method, customer: params.customer });
      return stripe.live.get(id);
    }),
    update: vi.fn(async (id: string, params: any) => {
      const current = stripe.live.get(id) ?? { id, status: "active", current_period_end: 1_790_000_000, items: { data: [] } };
      const next = { ...current, ...params };
      // Stripe semantics: swapping to a price with a different recurring interval resets the
      // billing-cycle anchor to now and invoices immediately, unless billing_cycle_anchor is "unchanged".
      const intervalOf = (priceId: string) => (priceId.match(/_(\d+)w$/)?.[1] ?? "4");
      const currentInterval = intervalOf(current.items?.data?.[0]?.price?.id ?? "");
      const nextInterval = params.items ? intervalOf(params.items[0]?.price ?? "") : currentInterval;
      if (params.items && nextInterval !== currentInterval && params.billing_cycle_anchor !== "unchanged") {
        next.current_period_end = Math.floor(Date.now() / 1000) + Number(nextInterval) * 7 * 86400;
        next.latest_invoice = `in_cycle_reset_${id}`;
        stripe.cycleResets.push(id);
      }
      if (params.trial_end) { next.status = "trialing"; next.trial_end = params.trial_end; next.current_period_end = params.trial_end; }
      if (params.pause_collection === "") next.pause_collection = null;
      stripe.live.set(id, next);
      return next;
    }),
    retrieve: vi.fn(async (id: string) => {
      const current = stripe.live.get(id);
      if (!current) throw missing("No such subscription");
      const pm = current.default_payment_method ? stripe.methods.get(current.default_payment_method) ?? { id: current.default_payment_method } : null;
      return { ...current, default_payment_method: pm, customer: { id: current.customer, invoice_settings: { default_payment_method: null } } };
    }),
    cancel: vi.fn(),
  },
  live: new Map<string, any>(),
  paymentIntents: {
    retrieve: vi.fn(async (id: string) => ({ id, status: "succeeded", latest_charge: { id: `ch_${id}`, application_fee_amount: 1000, balance_transaction: { id: `txn_${id}`, fee: 1300, fee_details: [{ type: "stripe_fee", amount: 300 }, { type: "application_fee", amount: 1000 }] } } })),
  },
  charges: { retrieve: vi.fn(async (id: string) => ({ id, receipt_url: `https://receipts.test/${id}` })) },
};

function resetStripe() {
  stripe.declineNext = null;
  stripe.defaults.clear(); stripe.methods.clear(); stripe.invoiceTotals.clear(); stripe.customerKeys.clear(); stripe.invoiceSubscriptions.clear(); stripe.live.clear(); stripe.cycleResets.length = 0;
  stripe.methods.set("pm_visa", { id: "pm_visa", customer: null, card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } });
  stripe.methods.set("pm_amex", { id: "pm_amex", customer: null, card: { brand: "amex", last4: "0005", exp_month: 1, exp_year: 2031 } });
  stripe.methods.set("pm_other", { id: "pm_other", customer: "cus_someone_else", card: { brand: "mastercard", last4: "4444", exp_month: 6, exp_year: 2029 } });
}

async function api(method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: await response.json() as Row };
}

function seedOffice(providerId: string, options: { connected?: boolean; charges?: boolean; priced?: boolean } = {}) {
  backend.tables.providers.push({ provider_id: providerId, office_name: `Office ${providerId}`, provider_name: "Dr. Beacon", email: "office@example.com", phone: null, city: "Austin", state: "TX" });
  if (!backend.tables.billing_settings.length) {
    backend.tables.billing_settings.push({
      id: 1, shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, version: 1,
      subscribe_save_enabled: true, subscribe_save_percent: 10,
    });
  }
  if (!backend.tables.billing_products.length) {
    backend.tables.billing_products.push(
      { id: PRODUCT, name: "Control", slug: "control", active: true, status: "active", floor_price_cents: 5999, hard_cost_cents: 433, stripe_tax_code: null, offered_cadences_weeks: [4, 8], default_cadence_weeks: 4, created_at: "2026-01-01T00:00:00.000Z" },
      { id: ADDON, name: "Boost", slug: "boost", active: true, status: "active", floor_price_cents: 2999, hard_cost_cents: 200, stripe_tax_code: null, offered_cadences_weeks: [4], default_cadence_weeks: 4, created_at: "2026-01-02T00:00:00.000Z" },
    );
    backend.tables.billing_product_images.push({ id: crypto.randomUUID(), product_id: PRODUCT, sort_order: 1, is_default: true, created_at: "2026-01-01T00:00:00.000Z" });
  }
  if (options.connected !== false) {
    backend.tables.billing_connected_accounts.push({
      provider_id: providerId, stripe_account_id: `acct_${providerId}`, charges_enabled: options.charges !== false, disconnected_at: null, tax_enabled: false,
    });
  }
  if (options.priced !== false) {
    backend.tables.billing_office_prices.push({
      provider_id: providerId, product_id: PRODUCT, sell_price_cents: 6999, subscription_enabled: true,
      stripe_product_id: "prod_1", stripe_price_id: "price_legacy", stripe_shipping_price_id: "price_ship_legacy",
      stripe_cadence_prices: {},
    });
  }
}

function seedSubscription(patientId: string, providerId: string, overrides: Row = {}): Row {
  const payer = backend.tables.billing_payers.find((row) => row.patient_id === patientId)
    ?? backend.tables.billing_payers[backend.tables.billing_payers.push({ id: crypto.randomUUID(), provider_id: providerId, patient_id: patientId, name: "Pat Patient", email: "pat@example.com", phone: null, stripe_customer_id: "cus_pat" }) - 1];
  const row = {
    id: crypto.randomUUID(), provider_id: providerId, payer_id: payer.id, patient_id: patientId, product_id: PRODUCT,
    stripe_subscription_id: `sub_${crypto.randomUUID().slice(0, 6)}`, stripe_customer_id: "cus_pat", status: "active",
    unit_price_cents: 6299, shipping_charge_cents: 1000, shipping_cost_cents: 1000, application_fee_cents: 4599,
    shipping_address: ADDRESS, current_period_end: "2026-10-20T00:00:00.000Z", next_shipment_at: "2026-10-20T00:00:00.000Z",
    cancel_at_period_end: false, canceled_at: null, cancel_token: "tok", livemode: false, paused_at: null,
    cadence_weeks: 4, quantity: 1, stripe_price_id: "price_4w", stripe_shipping_price_id: "price_ship_4w",
    pending_product_id: null, last_failure_message: null, last_hosted_invoice_url: null, payment_failure_count: 0,
    created_at: "2026-09-19T00:00:00.000Z", ...overrides,
  };
  backend.tables.billing_subscriptions.push(row);
  stripe.live.set(row.stripe_subscription_id, {
    id: row.stripe_subscription_id, status: "active", current_period_end: 1_792_000_000, customer: "cus_pat", default_payment_method: "pm_visa",
    items: { data: [{ id: "si_prod", price: { id: "price_4w", product: "prod_1" }, quantity: 1 }, { id: "si_ship", price: { id: "price_ship_4w", product: "prod_ship" }, quantity: 1 }] },
  });
  return row;
}

beforeAll(async () => {
  process.env.SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
  process.env.BILLING_PUBLIC_ORIGIN = "https://pay.thinnr.test";
  delete process.env.RESEND_API_KEY;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).hostname === "patient-shop.supabase.test" ? Promise.resolve(backend.handle(href, init)) : nativeFetch(input as string, init);
  });
  const { __setStripeForTests, __setCredentialsForTests } = await import("../billing/stripe-client");
  __setStripeForTests(stripe as any);
  __setCredentialsForTests({ secret: "sk_test_x", publishable: "pk_test_x", account_id: "acct_platform" });
  const { default: shop } = await import("./patient-shop");
  const { default: billing } = await import("./patient-billing");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }; next(); });
  app.use("/api", billing);
  app.use("/api", shop);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  const client = await import("../billing/stripe-client");
  client.__setStripeForTests(null);
  client.__setCredentialsForTests(null);
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  backend.reset();
  resetStripe();
  vi.clearAllMocks();
});

const CART = {
  lines: [
    { product_id: PRODUCT, quantity: 2, purchase: "one_time" },
    { product_id: ADDON, quantity: 1, purchase: "one_time" },
    { product_id: PRODUCT, quantity: 1, purchase: "subscription", cadence_weeks: 8 },
  ],
};

async function checkout(token: string, key = crypto.randomUUID(), body: Row = {}) {
  return api("POST", "/api/patient-data/billing/cart/checkout", {
    token, headers: { "Idempotency-Key": key },
    body: { ...CART, shipping_address: ADDRESS, payment_method_id: "pm_visa", ...body },
  });
}

describe("storefront", () => {
  it("requires a session and hides the shop for an unconnected office", async () => {
    expect((await api("GET", "/api/patient-data/billing/shop")).status).toBe(401);
    seedOffice("office-1", { connected: false });
    backend.signedIn("pat", "office-1");
    const { status, json } = await api("GET", "/api/patient-data/billing/shop", { token: "pat" });
    expect(status).toBe(200);
    expect(json).toMatchObject({ available: false, unavailable_reason: "not_connected", products: [], stripe_account_id: null, publishable_key: null });
    expect(json.office.payments_available).toBe(false);
  });

  it("treats a connected account without charges as unavailable", async () => {
    seedOffice("office-1", { charges: false });
    backend.signedIn("pat", "office-1");
    const { json } = await api("GET", "/api/patient-data/billing/shop", { token: "pat" });
    expect(json.available).toBe(false);
    expect(json.unavailable_reason).toBe("not_connected");
    expect((await api("POST", "/api/patient-data/billing/cart/quote", { token: "pat", body: CART })).status).toBe(409);
  });

  it("returns office prices, floor-priced defaults, cadences, and the subscribe-and-save percent", async () => {
    seedOffice("office-1");
    const { patientId } = backend.signedIn("pat", "office-1");
    backend.tables.billing_orders.push({ id: crypto.randomUUID(), provider_id: "office-1", patient_id: patientId, payer_id: "p", status: "paid", kind: "one_time", shipping_address: ADDRESS, created_at: "2026-09-01T00:00:00.000Z", subtotal_cents: 0, shipping_charge_cents: 0, tax_cents: 0, total_cents: 0, fulfillment_status: "to_ship", order_number: "TH-OLD" });
    const { json } = await api("GET", "/api/patient-data/billing/shop", { token: "pat" });
    expect(json).toMatchObject({ available: true, unavailable_reason: null, subscribe_save_percent: 10, shipping_charge_cents: 1000, stripe_account_id: "acct_office-1", publishable_key: "pk_test_x", default_address: ADDRESS });
    const control = json.products.find((product: Row) => product.product_id === PRODUCT);
    const boost = json.products.find((product: Row) => product.product_id === ADDON);
    expect(control).toMatchObject({ unit_price_cents: 6999, subscription_available: true, subscription_cadences_weeks: [4, 8] });
    expect(boost).toMatchObject({ unit_price_cents: 2999, subscription_available: false });
  });
});

describe("cart quote", () => {
  beforeEach(() => { seedOffice("office-1"); backend.signedIn("pat", "office-1"); });

  it("prices one-time lines as one shipment and each subscription line as its own", async () => {
    const { status, json } = await api("POST", "/api/patient-data/billing/cart/quote", { token: "pat", body: CART });
    expect(status).toBe(200);
    expect(json.lines).toHaveLength(3);
    expect(json.lines[2]).toMatchObject({ purchase: "subscription", cadence_weeks: 8, unit_price_cents: 6299, list_price_cents: 6999, discount_cents: 700 });
    expect(json.groups).toEqual([
      expect.objectContaining({ kind: "one_time", subtotal_cents: 6999 * 2 + 2999, shipping_charge_cents: 1000, quantity: 3 }),
      expect.objectContaining({ kind: "subscription", product_id: PRODUCT, cadence_weeks: 8, subtotal_cents: 6299, shipping_charge_cents: 1000 }),
    ]);
    expect(json).toMatchObject({ subtotal_cents: 16997 + 6299, discount_cents: 700, shipping_charge_cents: 2000, total_cents: 16997 + 6299 + 2000 });
  });

  it("rejects bad quantities, unoffered cadences, duplicate lines, and subscriptions the office does not price", async () => {
    const quote = (lines: Row[]) => api("POST", "/api/patient-data/billing/cart/quote", { token: "pat", body: { lines } });
    expect((await quote([{ product_id: PRODUCT, quantity: 11, purchase: "one_time" }])).status).toBe(400);
    expect((await quote([{ product_id: PRODUCT, quantity: 1, purchase: "subscription", cadence_weeks: 6 }])).json.error).toContain("not offered every 6 weeks");
    expect((await quote([{ product_id: PRODUCT, quantity: 1, purchase: "one_time" }, { product_id: PRODUCT, quantity: 2, purchase: "one_time" }])).status).toBe(400);
    expect((await quote([{ product_id: ADDON, quantity: 1, purchase: "subscription" }])).json.error).toContain("not available as a subscription");
    expect((await quote([{ product_id: crypto.randomUUID(), quantity: 1, purchase: "one_time" }])).status).toBe(400);
  });

  it("refuses a subscription whose discounted unit price falls below break-even", async () => {
    backend.signedIn("pat", "office-1");
    // Break-even for a 5999 floor is 3767; 4000 clears it one-time but not after the 10% subscribe-and-save.
    backend.tables.billing_office_prices.find((row) => row.product_id === PRODUCT)!.sell_price_cents = 4000;
    const oneTime = await api("POST", "/api/patient-data/billing/cart/quote", { token: "pat", body: { lines: [{ product_id: PRODUCT, quantity: 1, purchase: "one_time" }] } });
    expect(oneTime.status).toBe(200);
    const subscribed = await api("POST", "/api/patient-data/billing/cart/quote", { token: "pat", body: { lines: [{ product_id: PRODUCT, quantity: 1, purchase: "subscription", cadence_weeks: 4 }] } });
    expect(subscribed.status).toBe(409);
    expect(subscribed.json.error).toMatch(/discount/);
  });

  it("uses only the patient's own office prices", async () => {
    seedOffice("office-2");
    backend.tables.billing_office_prices.find((row) => row.provider_id === "office-2")!.sell_price_cents = 9999;
    const { json } = await api("POST", "/api/patient-data/billing/cart/quote", { token: "pat", body: { lines: [{ product_id: PRODUCT, quantity: 1, purchase: "one_time" }] } });
    expect(json.total_cents).toBe(6999 + 1000);
  });
});

describe("checkout", () => {
  beforeEach(() => { seedOffice("office-1"); });

  it("needs an idempotency key and a valid body", async () => {
    backend.signedIn("pat", "office-1");
    const missing = await api("POST", "/api/patient-data/billing/cart/checkout", { token: "pat", body: { ...CART, shipping_address: ADDRESS, payment_method_id: "pm_visa" } });
    expect(missing.status).toBe(400);
    expect(missing.json.field).toBe("idempotency_key");
    const bad = await checkout("pat", crypto.randomUUID(), { shipping_address: { name: "x" } });
    expect(bad.status).toBe(400);
    expect(bad.json.field).toBe("shipping_address");
    expect(backend.tables.billing_orders).toHaveLength(0);
  });

  it("creates one one-time order plus one subscription per line under one card, and saves the card", async () => {
    const { patientId } = backend.signedIn("pat", "office-1");
    const key = crypto.randomUUID();
    const { status, json } = await checkout("pat", key);
    expect(status).toBe(200);
    expect(json.status).toBe("paid");
    expect(json.cart_id).toBe(key);
    expect(json.items).toHaveLength(2);
    expect(json.items[0]).toMatchObject({ kind: "one_time", status: "paid", subscription_id: null, total_cents: 6999 * 2 + 2999 + 1000 });
    expect(json.items[1]).toMatchObject({ kind: "subscription", status: "paid", total_cents: 6299 + 1000 });
    expect(json.items[1].subscription_id).toBeTruthy();

    const orders = backend.tables.billing_orders;
    expect(orders).toHaveLength(2);
    expect(orders.every((row) => row.patient_id === patientId && row.provider_id === "office-1" && row.cart_id === key && row.status === "paid")).toBe(true);
    expect(orders.map((row) => row.kind).sort()).toEqual(["one_time", "subscription_initial"]);
    expect(orders[0].metadata.source).toBe("patient_app");
    expect(orders[0].metadata.cart.lines).toHaveLength(3);
    expect(backend.tables.billing_order_items.filter((row) => row.order_id === orders[0].id)).toHaveLength(2);
    expect(backend.tables.billing_ledger.filter((row) => row.kind === "sale")).toHaveLength(2);

    const subscription = backend.tables.billing_subscriptions[0];
    expect(subscription).toMatchObject({ patient_id: patientId, status: "active", cadence_weeks: 8, quantity: 1, unit_price_cents: 6299, stripe_price_id: "price_8w", stripe_shipping_price_id: "price_ship_8w" });
    expect(subscription.next_shipment_at).toBeTruthy();
    expect(subscription.stripe_subscription_id).toMatch(/^sub_/);

    // Card attached to the patient's customer on the office account and made default.
    const customerId = backend.tables.billing_payers[0].stripe_customer_id;
    expect(stripe.methods.get("pm_visa").customer).toBe(customerId);
    expect(stripe.customers.update).toHaveBeenCalledWith(customerId, { invoice_settings: { default_payment_method: "pm_visa" } }, expect.objectContaining({ stripeAccount: "acct_office-1" }));
    expect(stripe.subscriptions.create.mock.calls[0][0]).toMatchObject({
      items: [{ price: "price_8w", quantity: 1 }, { price: "price_ship_8w", quantity: 1 }], default_payment_method: "pm_visa",
    });
    expect((stripe.subscriptions.create.mock.calls[0] as unknown[])[1]).toMatchObject({ stripeAccount: "acct_office-1" });
    // Every shipment starts as processing.
    expect(backend.tables.billing_shipments.map((row) => row.status)).toEqual(["processing", "processing"]);
  });

  it("replays a retried checkout instead of charging twice", async () => {
    backend.signedIn("pat", "office-1");
    const key = crypto.randomUUID();
    const first = await checkout("pat", key);
    const inserts = backend.inserts.length;
    const payCalls = stripe.invoices.pay.mock.calls.length;
    const second = await checkout("pat", key);
    expect(second.status).toBe(200);
    expect(second.json.items.map((item: Row) => item.order_id)).toEqual(first.json.items.map((item: Row) => item.order_id));
    expect(second.json.status).toBe("paid");
    expect(backend.inserts.length).toBe(inserts);
    expect(stripe.invoices.pay.mock.calls.length).toBe(payCalls);
  });

  it("claims the cart key atomically: a racing duplicate is refused while the first attempt is in flight", async () => {
    backend.signedIn("pat", "office-1");
    const key = crypto.randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = stripe.invoices.pay.getMockImplementation()!;
    stripe.invoices.pay.mockImplementationOnce(async (id: string) => { await gate; return original(id); });
    const first = checkout("pat", key);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let second: { status: number; json: Row };
    try { second = await checkout("pat", key); } finally { release(); }
    expect(second.status).toBe(409);
    expect(second.json.field).toBe("idempotency_key");
    const done = await first;
    expect(done.status).toBe(200);
    expect(backend.tables.billing_carts).toHaveLength(1);
    expect(backend.tables.billing_orders).toHaveLength(2);
    expect(stripe.invoices.pay.mock.calls.length).toBe(2);
    // Once the first attempt is done the same key replays it.
    const third = await checkout("pat", key);
    expect(third.status).toBe(200);
    expect(third.json.items.map((item: Row) => item.order_id)).toEqual(done.json.items.map((item: Row) => item.order_id));
  });

  it("binds the cart key to the first attempt's exact request, and resumes on the plan it persisted even after prices drift", async () => {
    const { patientId } = backend.signedIn("pat", "office-1");
    const { cartOrderId } = await import("../billing/cart");
    const key = crypto.randomUUID();
    // Stage the cart exactly as a first attempt would, then kill it before the second row.
    let calls = 0;
    const originalFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (init?.method === "POST" && url.includes("/rest/v1/billing_orders") && ++calls === 2) throw new Error("db connection lost");
      return originalFetch(input, init);
    });
    const died = await checkout("pat", key);
    spy.mockRestore();
    expect(died.status).toBe(503);
    expect(backend.tables.billing_orders.map((row) => row.id)).toEqual([cartOrderId(key, 0)]);
    expect(backend.tables.billing_carts[0]).toMatchObject({ status: "staging", patient_id: patientId });
    backend.tables.billing_carts[0].updated_at = "2026-01-01T00:00:00.000Z";
    const payBefore = stripe.invoices.pay.mock.calls.length;
    // Same key, reordered / changed lines → refused, nothing charged, no new rows.
    const changed = await checkout("pat", key, { lines: [CART.lines[2], CART.lines[0]] });
    expect(changed.status).toBe(409);
    expect(changed.json.error).toMatch(/cart changed/);
    // A different address or card under the same key is also a different cart.
    expect((await checkout("pat", key, { payment_method_id: "pm_amex" })).status).toBe(409);
    expect((await checkout("pat", key, { shipping_address: { ...ADDRESS, line1: "2 Other St" } })).status).toBe(409);
    expect(backend.tables.billing_orders).toHaveLength(1);
    expect(stripe.invoices.pay.mock.calls.length).toBe(payBefore);
    // The office price drifts underneath the key. The identical request still
    // resumes (Stripe may already hold objects for these rows) and it runs on
    // the plan the first attempt persisted: nothing is re-priced at 7999.
    backend.tables.billing_office_prices.find((row) => row.product_id === PRODUCT)!.sell_price_cents = 7999;
    const quotedTotal = backend.tables.billing_orders[0].total_cents;
    const resumed = await checkout("pat", key);
    backend.tables.billing_office_prices.find((row) => row.product_id === PRODUCT)!.sell_price_cents = 6999;
    expect(resumed.status).toBe(200);
    expect(resumed.json.status).toBe("paid");
    expect(backend.tables.billing_orders.map((row) => row.id).sort()).toEqual([cartOrderId(key, 0), cartOrderId(key, 1)].sort());
    expect(backend.tables.billing_orders.find((row) => row.id === cartOrderId(key, 0))!.total_cents).toBe(quotedTotal);
    expect(backend.tables.billing_order_items.every((row) => row.unit_price_cents !== 7999)).toBe(true);
    expect(stripe.invoiceItems.create.mock.calls.every(([params]: any[]) => params.unit_amount_decimal !== "7999")).toBe(true);
  });

  it("resumes a cart that died between order items by filling in exactly the missing item", async () => {
    backend.signedIn("pat", "office-1");
    const { cartOrderId, cartItemId } = await import("../billing/cart");
    const key = crypto.randomUUID();
    let itemPosts = 0;
    const originalFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (init?.method === "POST" && url.includes("/rest/v1/billing_order_items") && ++itemPosts === 2) throw new Error("db connection lost");
      return originalFetch(input, init);
    });
    expect((await checkout("pat", key)).status).toBe(503);
    spy.mockRestore();
    const oneTime = cartOrderId(key, 0);
    expect(backend.tables.billing_order_items.filter((row) => row.order_id === oneTime).map((row) => row.id)).toEqual([cartItemId(key, 0, 0)]);
    expect(stripe.invoices.pay).not.toHaveBeenCalled();
    backend.tables.billing_carts[0].updated_at = "2026-01-01T00:00:00.000Z";
    const resumed = await checkout("pat", key);
    expect(resumed.status).toBe(200);
    expect(resumed.json.status).toBe("paid");
    // Both lines are present exactly once: the survivor was kept, the missing one was added, nothing duplicated.
    expect(backend.tables.billing_order_items.filter((row) => row.order_id === oneTime).map((row) => row.id).sort())
      .toEqual([cartItemId(key, 0, 0), cartItemId(key, 0, 1)].sort());
    expect(backend.tables.billing_order_items.filter((row) => row.order_id === oneTime).map((row) => row.product_id).sort()).toEqual([ADDON, PRODUCT].sort());
  });

  it("records a first subscription invoice Stripe already settled instead of paying or failing it again", async () => {
    backend.signedIn("pat", "office-1");
    const retrieveImpl = stripe.invoices.retrieve.getMockImplementation()!;
    stripe.invoices.retrieve.mockImplementation(async (id: string) => {
      const invoice = await retrieveImpl(id);
      return id.startsWith("in_first_") ? { ...invoice, status: "paid", amount_paid: invoice.total, billing_reason: "subscription_create" } : invoice;
    });
    const payBefore = stripe.invoices.pay.mock.calls.length;
    const { status, json } = await checkout("pat", crypto.randomUUID(), { lines: [CART.lines[2]] });
    stripe.invoices.retrieve.mockImplementation(retrieveImpl);
    expect(status).toBe(200);
    expect(json.status).toBe("paid");
    expect(stripe.invoices.pay.mock.calls.length).toBe(payBefore);
    expect(backend.tables.billing_orders[0].status).toBe("paid");
    expect(backend.tables.billing_subscriptions[0].status).toBe("active");
    // And a pay call that comes back "already paid" is read back as paid, not reported as a decline.
    const payImpl = stripe.invoices.pay.getMockImplementation()!;
    stripe.invoices.pay.mockImplementationOnce(async () => { throw Object.assign(new Error("Invoice is already paid"), { type: "StripeInvalidRequestError", code: "invoice_already_paid" }); });
    stripe.invoices.retrieve.mockImplementationOnce(async (id: string) => ({ ...(await retrieveImpl(id)), status: "paid", amount_paid: stripe.invoiceTotals.get(id) ?? 0 }));
    const second = await checkout("pat", crypto.randomUUID(), { lines: [CART.lines[0]] });
    stripe.invoices.pay.mockImplementation(payImpl);
    expect(second.status).toBe(200);
    expect(second.json.items[0].status).toBe("paid");
  });

  it("keeps an order pending and the cart resumable when Stripe's answer is unknown, and fails it only on a definite refusal", async () => {
    backend.signedIn("pat", "office-1");
    const key = crypto.randomUUID();
    const createImpl = stripe.subscriptions.create.getMockImplementation()!;
    stripe.subscriptions.create.mockImplementationOnce(async () => { throw Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }); });
    const unknown = await checkout("pat", key);
    expect(unknown.status).toBeGreaterThanOrEqual(500);
    const subscriptionOrder = backend.tables.billing_orders.find((row) => row.kind === "subscription_initial")!;
    expect(subscriptionOrder.status).toBe("pending");
    expect(backend.tables.billing_carts[0].status).toBe("staging");
    // The retry (same key, same body) resumes: the paid one-time order replays and the subscription is created now.
    backend.tables.billing_carts[0].updated_at = "2026-01-01T00:00:00.000Z";
    const payBefore = stripe.invoices.pay.mock.calls.length;
    const resumed = await checkout("pat", key);
    expect(resumed.status).toBe(200);
    expect(resumed.json.status).toBe("paid");
    expect(resumed.json.items.map((item: Row) => item.status)).toEqual(["paid", "paid"]);
    expect(stripe.invoices.pay.mock.calls.length).toBe(payBefore + 1);
    expect(backend.tables.billing_ledger.filter((row) => row.kind === "sale")).toHaveLength(2);
    // A definite Stripe refusal still fails the line honestly.
    stripe.subscriptions.create.mockImplementationOnce(async () => { throw Object.assign(new Error("No such price"), { type: "StripeInvalidRequestError" }); });
    const refused = await checkout("pat", crypto.randomUUID(), { lines: [CART.lines[2]] });
    stripe.subscriptions.create.mockImplementation(createImpl);
    expect(refused.status).toBe(402);
    expect(backend.tables.billing_orders.find((row) => row.kind === "subscription_initial" && row.status === "failed")).toBeTruthy();
  });

  it("replays a finished cart and resumes a stranded one even after the offering or the office changed underneath the key", async () => {
    const { patientId } = backend.signedIn("pat", "office-1");
    const { cartOrderId } = await import("../billing/cart");
    const ensure = (await import("../billing/prices")).ensureRecurringPrices as unknown as ReturnType<typeof vi.fn>;
    const office = () => backend.tables.billing_office_prices.find((row) => row.product_id === PRODUCT)!;
    const account = () => backend.tables.billing_connected_accounts.find((row) => row.provider_id === "office-1")!;
    const product = () => backend.tables.billing_products.find((row) => row.id === PRODUCT)!;
    const drift = () => {
      product().active = false; product().status = "archived";
      office().subscription_enabled = false; office().sell_price_cents = 4000; // below break-even after the discount
      account().disconnected_at = "2026-09-16T00:00:00.000Z"; account().charges_enabled = false;
    };
    const restore = () => {
      product().active = true; product().status = "active";
      office().subscription_enabled = true; office().sell_price_cents = 6999;
      account().disconnected_at = null; account().charges_enabled = true;
    };
    // 1. A finished cart replays after every kind of drift: same rows, no new charge, no re-pricing.
    const finishedKey = crypto.randomUUID();
    const first = await checkout("pat", finishedKey);
    expect(first.status).toBe(200);
    const payAfterFirst = stripe.invoices.pay.mock.calls.length;
    drift();
    // Sanity: the same body under a NEW key is refused now (the offering is gone) and nothing is charged.
    const freshKey = await checkout("pat", crypto.randomUUID());
    expect(freshKey.status).toBe(409);
    expect(backend.tables.billing_carts.map((row) => row.id)).toEqual([finishedKey]);
    const replay = await checkout("pat", finishedKey);
    expect(replay.status).toBe(200);
    expect(replay.json.status).toBe("paid");
    expect(replay.json.items.map((item: Row) => item.order_id)).toEqual(first.json.items.map((item: Row) => item.order_id));
    expect(stripe.invoices.pay.mock.calls.length).toBe(payAfterFirst);
    restore();
    // 2. A cart that died between inserts resumes on its stored plan after the same drift.
    const strandedKey = crypto.randomUUID();
    let calls = 0;
    const originalFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (init?.method === "POST" && url.includes("/rest/v1/billing_orders") && ++calls === 2) throw new Error("db connection lost");
      return originalFetch(input, init);
    });
    expect((await checkout("pat", strandedKey)).status).toBe(503);
    spy.mockRestore();
    const staged = backend.tables.billing_carts.find((row) => row.id === strandedKey)!;
    expect(staged).toMatchObject({ status: "staging", patient_id: patientId });
    staged.updated_at = "2026-01-01T00:00:00.000Z";
    drift();
    const ensureCalls = ensure.mock.calls.length;
    const createsBefore = stripe.subscriptions.create.mock.calls.length;
    const resumed = await checkout("pat", strandedKey);
    restore();
    expect(resumed.status).toBe(200);
    // The one-time group replays on the pinned account at the stored prices. The
    // subscription row was never pinned to Stripe prices (so no Stripe subscription
    // can exist) and the office is no longer live: that line fails for real instead
    // of mirroring prices onto a disconnected account, and the cart still completes.
    expect(resumed.json.status).toBe("partial");
    const orders = backend.tables.billing_orders.filter((row) => row.cart_id === strandedKey);
    expect(orders.map((row) => row.id).sort()).toEqual([cartOrderId(strandedKey, 0), cartOrderId(strandedKey, 1)].sort());
    expect(orders.find((row) => row.id === cartOrderId(strandedKey, 0))!.status).toBe("paid");
    expect(orders.find((row) => row.id === cartOrderId(strandedKey, 1))!.status).toBe("failed");
    expect(resumed.json.items.find((item: Row) => item.kind === "subscription").error).toMatch(/payment account changed/);
    expect(ensure.mock.calls.length).toBe(ensureCalls);
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(createsBefore);
    expect(backend.tables.billing_order_items.filter((row) => orders.some((order) => order.id === row.order_id)).every((row) => row.unit_price_cents !== 4000)).toBe(true);
    expect(backend.tables.billing_carts.find((row) => row.id === strandedKey)!.status).toBe("ready");
  });

  it("never charges a stranded cart once the office reconnected a different Stripe account: it voids on the pinned account, fails the rows, and a new key charges the new account", async () => {
    backend.signedIn("pat", "office-1");
    const { cartOrderId } = await import("../billing/cart");
    const account = () => backend.tables.billing_connected_accounts.find((row) => row.provider_id === "office-1")!;
    const stripeAccounts = (calls: any[][]) => calls.map((call) => call.at(-1)?.stripeAccount);
    // 1. Stranded after the one-time invoice was finalized but before payment (Stripe holds an open invoice on acct_office-1)
    //    and after the subscription row was inserted but never pinned or created.
    const key = crypto.randomUUID();
    const payImpl = stripe.invoices.pay.getMockImplementation()!;
    stripe.invoices.pay.mockImplementationOnce(async () => { throw new Stripe.errors.StripeConnectionError({ message: "socket hang up", type: "api_connection_error" } as any); });
    const died = await checkout("pat", key);
    expect(died.status).toBe(503);
    stripe.invoices.pay.mockImplementation(payImpl);
    const staged = backend.tables.billing_carts.find((row) => row.id === key)!;
    expect(staged.quote.stripe_account_id).toBe("acct_office-1");
    staged.updated_at = "2026-01-01T00:00:00.000Z";
    const oneTime = () => backend.tables.billing_orders.find((row) => row.id === cartOrderId(key, 0))!;
    const openInvoice = oneTime().stripe_invoice_id;
    expect(openInvoice).toBeTruthy();
    // 2. The office disconnects and reconnects a different Stripe account, then the patient retries.
    account().stripe_account_id = "acct_replacement"; account().disconnected_at = null; account().charges_enabled = true;
    const paysBefore = stripe.invoices.pay.mock.calls.length;
    const createsBefore = stripe.invoices.create.mock.calls.length;
    const resumed = await checkout("pat", key);
    expect(resumed.status).toBe(402);
    expect(resumed.json.status).toBe("failed");
    expect(resumed.json.items.map((item: Row) => item.status)).toEqual(["failed", "failed"]);
    expect(resumed.json.items.every((item: Row) => /payment account changed/.test(item.error))).toBe(true);
    // Nothing was charged anywhere: no pay and no new invoice on either account; the open invoice was voided on the pinned account.
    expect(stripe.invoices.pay.mock.calls.length).toBe(paysBefore);
    expect(stripe.invoices.create.mock.calls.length).toBe(createsBefore);
    expect(stripe.subscriptions.create).not.toHaveBeenCalled();
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(1);
    expect(stripe.invoices.voidInvoice.mock.calls[0][0]).toBe(openInvoice);
    expect(stripeAccounts(stripe.invoices.voidInvoice.mock.calls)).toEqual(["acct_office-1"]);
    expect(stripeAccounts(stripe.invoices.retrieve.mock.calls.slice(-1))).toEqual(["acct_office-1"]);
    expect(oneTime().status).toBe("failed");
    expect(backend.tables.billing_orders.find((row) => row.id === cartOrderId(key, 1))!.status).toBe("failed");
    expect(backend.tables.billing_carts.find((row) => row.id === key)!.status).toBe("ready");
    // 3. A replay of the same key stays a replay (no second void, no charge).
    const replay = await checkout("pat", key);
    expect(replay.status).toBe(402);
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(1);
    expect(stripe.invoices.pay.mock.calls.length).toBe(paysBefore);
    // 4. A brand-new key charges the replacement account as normal.
    const fresh = await checkout("pat", crypto.randomUUID());
    expect(fresh.status).toBe(200);
    expect(fresh.json.status).toBe("paid");
    expect(fresh.json.stripe_account_id).toBe("acct_replacement");
    expect(new Set(stripeAccounts(stripe.invoices.pay.mock.calls.slice(paysBefore)))).toEqual(new Set(["acct_replacement"]));
  });

  it("refuses to touch a stranded cart whose invoice already paid on the replaced account, leaving it pending for staff", async () => {
    backend.signedIn("pat", "office-1");
    const { cartOrderId } = await import("../billing/cart");
    const account = () => backend.tables.billing_connected_accounts.find((row) => row.provider_id === "office-1")!;
    const key = crypto.randomUUID();
    // Pay succeeded at Stripe but the response was lost.
    const payImpl = stripe.invoices.pay.getMockImplementation()!;
    stripe.invoices.pay.mockImplementationOnce((async (id: string) => { await payImpl(id); throw new Stripe.errors.StripeConnectionError({ message: "socket hang up", type: "api_connection_error" } as any); }) as any);
    expect((await checkout("pat", key)).status).toBe(503);
    stripe.invoices.pay.mockImplementation(payImpl);
    backend.tables.billing_carts.find((row) => row.id === key)!.updated_at = "2026-01-01T00:00:00.000Z";
    const paidInvoice = backend.tables.billing_orders.find((row) => row.id === cartOrderId(key, 0))!.stripe_invoice_id;
    const retrieveImpl = stripe.invoices.retrieve.getMockImplementation()!;
    stripe.invoices.retrieve.mockImplementation(async (id: string) => ({ ...(await retrieveImpl(id)), status: id === paidInvoice ? "paid" : "open" }));
    account().stripe_account_id = "acct_replacement";
    const paysBefore = stripe.invoices.pay.mock.calls.length;
    const resumed = await checkout("pat", key);
    stripe.invoices.retrieve.mockImplementation(retrieveImpl);
    expect(resumed.status).toBe(409);
    expect(resumed.json.error).toMatch(/previous account/);
    expect(stripe.invoices.pay.mock.calls.length).toBe(paysBefore);
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
    expect(backend.tables.billing_orders.find((row) => row.id === cartOrderId(key, 0))!.status).toBe("pending");
    expect(backend.tables.billing_carts.find((row) => row.id === key)!.status).toBe("staging");
  });

  it("treats a transient price-mirroring failure and any error after Stripe answered as unknown, not as a refusal", async () => {
    backend.signedIn("pat", "office-1");
    const prices = await import("../billing/prices");
    const ensure = prices.ensureRecurringPrices as unknown as ReturnType<typeof vi.fn>;
    const ensureImpl = ensure.getMockImplementation()!;
    // 1. Mirroring the cadence prices hit a Stripe outage: the line is not refused; the cart stays resumable.
    ensure.mockImplementationOnce(async () => { throw Object.assign(new Error("gateway timeout"), { type: "StripeAPIError" }); });
    const key = crypto.randomUUID();
    expect((await checkout("pat", key)).status).toBeGreaterThanOrEqual(500);
    expect(backend.tables.billing_orders.find((row) => row.kind === "subscription_initial")!.status).toBe("pending");
    expect(backend.tables.billing_carts[0].status).toBe("staging");
    // 2. The subscription was created at Stripe, then reading its first invoice failed with a definite-looking error:
    //    a Stripe object exists, so the order still may not be marked failed.
    backend.tables.billing_carts[0].updated_at = "2026-01-01T00:00:00.000Z";
    stripe.invoices.retrieve.mockImplementationOnce(async () => { throw missing("No such invoice"); });
    expect((await checkout("pat", key)).status).toBeGreaterThanOrEqual(500);
    expect(backend.tables.billing_orders.find((row) => row.kind === "subscription_initial")!.status).toBe("pending");
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    // 3. Prices and settings move while the cart is stranded; the retry still
    //    resumes the same rows on the persisted plan and reuses the cadence
    //    prices already pinned to the subscription row (no re-mirroring, and the
    //    Stripe create replays under its idempotency key rather than repeating).
    backend.tables.billing_carts[0].updated_at = "2026-01-01T00:00:00.000Z";
    backend.tables.billing_office_prices.find((row) => row.product_id === PRODUCT)!.sell_price_cents = 7999;
    backend.tables.billing_settings[0].shipping_charge_cents = 1500;
    const ensureCalls = ensure.mock.calls.length;
    const resumed = await checkout("pat", key);
    backend.tables.billing_office_prices.find((row) => row.product_id === PRODUCT)!.sell_price_cents = 6999;
    backend.tables.billing_settings[0].shipping_charge_cents = 1000;
    expect(resumed.status).toBe(200);
    expect(resumed.json.status).toBe("paid");
    expect(ensure.mock.calls.length).toBe(ensureCalls);
    // The fake has no idempotency layer, so the create is called again here; what matters is
    // that it is byte-for-byte the same request (same key, prices, quantity, fee) Stripe would replay.
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.create.mock.calls[1]).toEqual(stripe.subscriptions.create.mock.calls[0]);
    expect(backend.tables.billing_subscriptions[0]).toMatchObject({ stripe_price_id: "price_8w", stripe_shipping_price_id: "price_ship_8w", status: "active" });
    expect(backend.tables.billing_orders.every((row) => row.shipping_charge_cents === 1000)).toBe(true);
    // 4. The office genuinely no longer sells the cadence at the quoted price: that IS a refusal of the line.
    ensure.mockImplementationOnce(async (providerId: string, productId: string) => {
      const mirrored: Row = await (ensureImpl as (a: string, b: string) => Promise<Row>)(providerId, productId);
      return { ...mirrored, stripe_cadence_prices: { "8": { ...mirrored.stripe_cadence_prices["8"], unit_amount_cents: 7999 } } };
    });
    const repriced = await checkout("pat", crypto.randomUUID(), { lines: [CART.lines[2]] });
    expect(repriced.status).toBe(402);
    expect(repriced.json.items[0].error).toMatch(/pricing changed/i);
    // 5. The one-time invoice exists at Stripe, then finalize fails: same rule, order stays pending.
    stripe.invoices.finalizeInvoice.mockImplementationOnce(async () => { throw missing("No such invoice"); });
    const oneTimeKey = crypto.randomUUID();
    expect((await checkout("pat", oneTimeKey, { lines: [CART.lines[0]] })).status).toBeGreaterThanOrEqual(500);
    const oneTime = backend.tables.billing_orders.find((row) => row.cart_id === oneTimeKey)!;
    expect(oneTime.status).toBe("pending");
  });

  it("scopes order and subscription reads to the patient's current office, not only the patient id", async () => {
    const { patientId } = backend.signedIn("pat", "office-1");
    await checkout("pat");
    // The same person's rows from another office (a patient moved between practices) are invisible here.
    const foreignOrder: Row = { ...backend.tables.billing_orders[0], id: crypto.randomUUID(), order_number: "THN-999999", provider_id: "office-2", cart_id: null };
    backend.tables.billing_orders.push(foreignOrder);
    const foreignSubscription = { ...backend.tables.billing_subscriptions[0], id: crypto.randomUUID(), provider_id: "office-2" };
    backend.tables.billing_subscriptions.push(foreignSubscription);
    // office-2 is itself a live Stripe office, so nothing below can 404 for lack of an account.
    backend.tables.billing_connected_accounts.push({ provider_id: "office-2", stripe_account_id: "acct_office-2", charges_enabled: true, disconnected_at: null, tax_enabled: false });
    expect(foreignOrder.patient_id).toBe(patientId);
    const orders = await api("GET", "/api/patient-data/billing/orders", { token: "pat" });
    expect(orders.json.items.map((row: Row) => row.id)).not.toContain(foreignOrder.id);
    expect((await api("GET", `/api/patient-data/billing/orders/${foreignOrder.id}`, { token: "pat" })).status).toBe(404);
    const subscriptions = await api("GET", "/api/patient-data/billing/subscriptions", { token: "pat" });
    expect(subscriptions.json.items.map((row: Row) => row.id)).not.toContain(foreignSubscription.id);
    expect((await api("GET", `/api/patient-data/billing/subscriptions/${foreignSubscription.id}`, { token: "pat" })).status).toBe(404);
    // The legacy overview, receipt, and cancel routes apply the same boundary.
    const overview = await api("GET", "/api/patient-data/billing/overview", { token: "pat" });
    expect(overview.status).toBe(200);
    expect(overview.json.orders.map((row: Row) => row.id)).not.toContain(foreignOrder.id);
    expect(overview.json.subscriptions.map((row: Row) => row.id)).not.toContain(foreignSubscription.id);
    expect((await api("GET", `/api/patient-data/billing/orders/${foreignOrder.id}/receipt`, { token: "pat" })).status).toBe(404);
    expect((await api("GET", `/api/patient-data/billing/orders/${backend.tables.billing_orders[0].id}/receipt`, { token: "pat" })).status).toBe(200);
    expect((await api("POST", `/api/patient-data/billing/subscriptions/${foreignSubscription.id}/cancel`, { token: "pat" })).status).toBe(404);
    for (const action of ["pause", "skip-next", "cancel"]) {
      expect((await api("POST", `/api/patient-data/billing/subscriptions/${foreignSubscription.id}/${action}`, { token: "pat" })).status).toBe(404);
    }
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("replays a lost 3DS response with the live payment intent and its client secret", async () => {
    backend.signedIn("pat", "office-1");
    const key = crypto.randomUUID();
    const payImpl = stripe.invoices.pay.getMockImplementation()!;
    const retrieveImpl = stripe.paymentIntents.retrieve.getMockImplementation()!;
    stripe.invoices.pay.mockImplementation((async (id: string) => ({
      id, status: "open", total: stripe.invoiceTotals.get(id) ?? 0, amount_paid: 0,
      payment_intent: { id: `pi_${id}`, status: "requires_action", client_secret: `secret_${id}` },
    })) as any);
    const first = await checkout("pat", key);
    stripe.invoices.pay.mockImplementation(payImpl);
    stripe.invoices.pay.mockClear();
    expect(first.status).toBe(200);
    expect(first.json.status).toBe("requires_action");
    expect(first.json.items.every((item: Row) => typeof item.client_secret === "string")).toBe(true);
    const secrets = new Map<string, string>();
    stripe.paymentIntents.retrieve.mockImplementation(async (id: string) => {
      if (id.endsWith(backend.tables.billing_orders[0].stripe_invoice_id)) return { id, status: "requires_action", client_secret: secrets.get(id) ?? `live_${id}` } as any;
      return { id, status: "succeeded" } as any;
    });
    const replay = await checkout("pat", key);
    expect(replay.status).toBe(200);
    expect(replay.json.items).toHaveLength(2);
    const [oneTime, subscribed] = replay.json.items as Row[];
    expect(oneTime).toMatchObject({ status: "requires_action", client_secret: `live_${backend.tables.billing_orders[0].stripe_payment_intent_id}` });
    expect(subscribed).toMatchObject({ status: "paid", client_secret: null });
    expect(replay.json.status).toBe("requires_action");
    expect(stripe.invoices.pay).not.toHaveBeenCalled();
    stripe.paymentIntents.retrieve.mockImplementation(retrieveImpl);
  });

  it("refuses a cart key that belongs to another patient", async () => {
    backend.signedIn("pat", "office-1");
    backend.signedIn("other", "office-1");
    const key = crypto.randomUUID();
    expect((await checkout("pat", key)).status).toBe(200);
    const stolen = await checkout("other", key);
    expect(stolen.status).toBe(409);
    expect(backend.tables.billing_orders.every((row) => row.patient_id === backend.tables.billing_carts[0].patient_id)).toBe(true);
  });

  it("reports a declined subscription honestly while keeping the paid one-time order", async () => {
    backend.signedIn("pat", "office-1");
    stripe.invoices.pay.mockImplementationOnce(async (id: string) => ({ id, status: "paid", total: stripe.invoiceTotals.get(id) ?? 0, amount_paid: stripe.invoiceTotals.get(id) ?? 0, payment_intent: `pi_${id}` }));
    stripe.invoices.pay.mockImplementationOnce(async () => { throw declined("Your card was declined."); });
    const { status, json } = await checkout("pat");
    expect(status).toBe(200);
    expect(json.status).toBe("partial");
    expect(json.items[0].status).toBe("paid");
    expect(json.items[1]).toMatchObject({ status: "failed", error: "Your card was declined." });
    const failed = backend.tables.billing_orders.find((row) => row.kind === "subscription_initial")!;
    expect(failed.status).toBe("failed");
    expect(failed.failure_message).toBe("Your card was declined.");
    expect(backend.tables.billing_subscriptions[0]).toMatchObject({ status: "incomplete", last_failure_message: "Your card was declined." });
    expect(backend.tables.billing_ledger.filter((row) => row.kind === "sale")).toHaveLength(1);
  });

  it("inserts every order before any charge and never charges without an order", async () => {
    backend.signedIn("pat", "office-1");
    const payImpl = stripe.invoices.pay.getMockImplementation()!;
    stripe.invoices.pay.mockImplementation(async () => {
      expect(backend.tables.billing_orders).toHaveLength(2);
      throw declined("Card declined.");
    });
    const { status, json } = await checkout("pat");
    expect(status).toBe(402);
    expect(json.status).toBe("failed");
    expect(backend.tables.billing_orders.every((row) => row.status === "failed")).toBe(true);
    expect(backend.tables.billing_ledger).toHaveLength(0);
    stripe.invoices.pay.mockImplementation(payImpl);
  });

  it("keeps one payer and one Stripe customer per patient per office when two checkouts race with different keys", async () => {
    const { patientId } = backend.signedIn("pat", "office-1");
    expect(backend.tables.billing_payers.filter((row) => row.patient_id === patientId)).toHaveLength(0);
    // Force the worst interleaving: both attempts read "no payer yet" before either inserts.
    const originalFetch = globalThis.fetch;
    let waiting: Array<() => void> = [];
    let gated = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if ((init?.method ?? "GET") === "GET" && url.includes("/rest/v1/billing_payers?") && url.includes("patient_id=eq.") && gated++ < 2) {
        await new Promise<void>((resolve) => { waiting.push(resolve); if (waiting.length === 2) { waiting.forEach((go) => go()); waiting = []; } });
      }
      return originalFetch(input, init);
    });
    const [first, second] = await Promise.all([checkout("pat", crypto.randomUUID()), checkout("pat", crypto.randomUUID())]);
    spy.mockRestore();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The partial unique index is the arbiter: the loser of the insert re-reads the
    // winner instead of creating a second payer, and Stripe sees one customer.
    const payers = backend.tables.billing_payers.filter((row) => row.patient_id === patientId && row.provider_id === "office-1");
    expect(payers).toHaveLength(1);
    // Both attempts may call create, but on one payer id they share one idempotency
    // key, so Stripe hands back one customer and the row ends up pointing at it.
    const customers = new Set((await Promise.all(stripe.customers.create.mock.results.map((result) => result.value))).map((customer: any) => customer.id));
    expect(customers.size).toBe(1);
    expect(new Set(stripe.customers.create.mock.calls.map((call) => call[1]?.idempotencyKey)).size).toBe(1);
    expect(payers[0].stripe_customer_id).toBe([...customers][0]);
    const orders = backend.tables.billing_orders.filter((row) => row.patient_id === patientId);
    expect(orders).toHaveLength(4);
    expect(new Set(orders.map((row) => row.payer_id))).toEqual(new Set([payers[0].id]));
    const subscriptions = backend.tables.billing_subscriptions.filter((row) => row.patient_id === patientId);
    expect(new Set(subscriptions.map((row) => row.payer_id))).toEqual(new Set([payers[0].id]));
  });

  it("refuses a card that belongs to a different customer", async () => {
    backend.signedIn("pat", "office-1");
    const { status, json } = await checkout("pat", crypto.randomUUID(), { payment_method_id: "pm_other" });
    expect(status).toBe(403);
    expect(json.field).toBe("payment_method_id");
    expect(backend.tables.billing_orders).toHaveLength(0);
  });
});

describe("saved cards", () => {
  beforeEach(() => { seedOffice("office-1"); });

  it("creates the patient's customer on the office account, then lists, adds, defaults, and removes cards", async () => {
    backend.signedIn("pat", "office-1");
    const empty = await api("GET", "/api/patient-data/billing/cards", { token: "pat" });
    expect(empty.json).toEqual({ cards: [], default_payment_method_id: null });
    expect((stripe.customers.create.mock.calls[0] as unknown[])[1]).toMatchObject({ stripeAccount: "acct_office-1" });
    const customerId = backend.tables.billing_payers[0].stripe_customer_id;
    expect(customerId).toMatch(/^cus_/);

    const setup = await api("POST", "/api/patient-data/billing/cards/setup", { token: "pat" });
    expect(setup.json).toMatchObject({ client_secret: "seti_secret", stripe_account_id: "acct_office-1", publishable_key: "pk_test_x" });

    const added = await api("POST", "/api/patient-data/billing/cards", { token: "pat", body: { payment_method_id: "pm_visa" } });
    expect(added.json.cards).toEqual([{ id: "pm_visa", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030, is_default: true }]);
    await api("POST", "/api/patient-data/billing/cards", { token: "pat", body: { payment_method_id: "pm_amex" } });
    const defaulted = await api("POST", "/api/patient-data/billing/cards/pm_amex/default", { token: "pat" });
    expect(stripe.customers.update).toHaveBeenLastCalledWith(customerId, { invoice_settings: { default_payment_method: "pm_amex" } }, expect.anything());
    expect(defaulted.status).toBe(200);
    expect(defaulted.json.default_payment_method_id).toBe("pm_amex");

    const other = await api("POST", "/api/patient-data/billing/cards", { token: "pat", body: { payment_method_id: "pm_other" } });
    expect(other.status).toBe(403);
    expect((await api("POST", "/api/patient-data/billing/cards/pm_other/default", { token: "pat" })).status).toBe(404);
    expect((await api("DELETE", "/api/patient-data/billing/cards/pm_other", { token: "pat" })).status).toBe(404);

    const removed = await api("DELETE", "/api/patient-data/billing/cards/pm_visa", { token: "pat" });
    expect(removed.json.cards.map((card: Row) => card.id)).toEqual(["pm_amex"]);
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_visa", {}, expect.anything());
  });

  it("keeps the last card while a subscription still renews and re-points subscriptions off a removed default", async () => {
    const { patientId } = backend.signedIn("pat", "office-1");
    backend.tables.billing_payers.push({ id: crypto.randomUUID(), provider_id: "office-1", patient_id: patientId, name: "Pat", email: "pat@example.com", phone: null, stripe_customer_id: "cus_pat" });
    const row = seedSubscription(patientId, "office-1");
    stripe.methods.get("pm_visa").customer = "cus_pat";
    stripe.defaults.set("cus_pat", "pm_visa");
    const blocked = await api("DELETE", "/api/patient-data/billing/cards/pm_visa", { token: "pat" });
    expect(blocked.status).toBe(409);
    stripe.methods.get("pm_amex").customer = "cus_pat";
    const removed = await api("DELETE", "/api/patient-data/billing/cards/pm_visa", { token: "pat" });
    expect(removed.status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(row.stripe_subscription_id, { default_payment_method: "pm_amex" }, expect.anything());
  });

  it("re-points a subscription that names the removed card even when it is not the customer default", async () => {
    const { patientId } = backend.signedIn("pat", "office-1");
    backend.tables.billing_payers.push({ id: crypto.randomUUID(), provider_id: "office-1", patient_id: patientId, name: "Pat", email: "pat@example.com", phone: null, stripe_customer_id: "cus_pat" });
    const row = seedSubscription(patientId, "office-1");
    stripe.methods.get("pm_visa").customer = "cus_pat";
    stripe.methods.get("pm_amex").customer = "cus_pat";
    stripe.defaults.set("cus_pat", "pm_visa");
    stripe.live.get(row.stripe_subscription_id)!.default_payment_method = "pm_amex";
    const order: string[] = [];
    stripe.subscriptions.update.mockImplementationOnce(async (id: string, params: any) => { order.push("repoint"); const cur = stripe.live.get(id); stripe.live.set(id, { ...cur, ...params }); return stripe.live.get(id); });
    stripe.paymentMethods.detach.mockImplementationOnce(async (id: string) => { order.push("detach"); stripe.methods.get(id).customer = null; return { id }; });
    const removed = await api("DELETE", "/api/patient-data/billing/cards/pm_amex", { token: "pat" });
    expect(removed.status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(row.stripe_subscription_id, { default_payment_method: "pm_visa" }, expect.anything());
    expect(order).toEqual(["repoint", "detach"]);
    // The customer default was not the removed card, so it stays put.
    expect(stripe.defaults.get("cus_pat")).toBe("pm_visa");
  });
});

describe("orders and shipments", () => {
  it("lists only the patient's orders with cursor pages and shows shipment state", async () => {
    seedOffice("office-1");
    const { patientId } = backend.signedIn("pat", "office-1");
    const stranger = backend.signedIn("other", "office-1");
    for (let index = 0; index < 3; index += 1) {
      backend.tables.billing_orders.push({ id: crypto.randomUUID(), order_number: `TH-${index}`, provider_id: "office-1", payer_id: "p", patient_id: patientId, kind: "one_time", status: "paid", subtotal_cents: 100, shipping_charge_cents: 10, tax_cents: 0, total_cents: 110, shipping_address: ADDRESS, fulfillment_status: "to_ship", stripe_charge_id: "ch_1", created_at: `2026-09-1${index}T00:00:00.000Z`, paid_at: `2026-09-1${index}T00:00:00.000Z`, subscription_id: null, cart_id: null });
    }
    backend.tables.billing_orders.push({ id: crypto.randomUUID(), order_number: "TH-X", provider_id: "office-1", payer_id: "q", patient_id: stranger.patientId, kind: "one_time", status: "paid", subtotal_cents: 100, shipping_charge_cents: 10, tax_cents: 0, total_cents: 110, shipping_address: ADDRESS, fulfillment_status: "shipped", created_at: "2026-09-15T00:00:00.000Z" });
    const first = await api("GET", "/api/patient-data/billing/orders?limit=2", { token: "pat" });
    expect(first.json.items.map((row: Row) => row.order_number)).toEqual(["TH-2", "TH-1"]);
    expect(first.json.next_cursor).toBeTruthy();
    expect(first.json.items[0].shipment).toMatchObject({ status: "processing", tracking_url: null });
    const second = await api("GET", `/api/patient-data/billing/orders?limit=2&cursor=${first.json.next_cursor}`, { token: "pat" });
    expect(second.json.items.map((row: Row) => row.order_number)).toEqual(["TH-0"]);
    expect(second.json.next_cursor).toBeNull();
  });

  it("returns order detail with items, money, refunds, and a shipment fed by staff fulfillment", async () => {
    seedOffice("office-1");
    const { patientId } = backend.signedIn("pat", "office-1");
    const stranger = backend.signedIn("other", "office-1");
    const orderId = crypto.randomUUID();
    backend.tables.billing_orders.push({ id: orderId, order_number: "TH-D", provider_id: "office-1", payer_id: "p", patient_id: patientId, kind: "one_time", status: "partially_refunded", subtotal_cents: 6999, shipping_charge_cents: 1000, tax_cents: 0, total_cents: 7999, shipping_address: ADDRESS, fulfillment_status: "to_ship", stripe_charge_id: "ch_1", created_at: "2026-09-10T00:00:00.000Z", paid_at: "2026-09-10T00:00:00.000Z", subscription_id: null, cart_id: null, carrier: null, tracking_number: null, shipped_at: null, shipped_by: null, canceled_reason: null, updated_at: "2026-09-10T00:00:00.000Z" });
    backend.tables.billing_order_items.push({ id: crypto.randomUUID(), order_id: orderId, product_id: PRODUCT, product_name_snapshot: "Control", quantity: 1, unit_price_cents: 6999 });
    backend.tables.billing_refunds.push({ id: crypto.randomUUID(), order_id: orderId, amount_cents: 500, status: "succeeded", created_at: "2026-09-11T00:00:00.000Z" });
    backend.tables.billing_refunds.push({ id: crypto.randomUUID(), order_id: orderId, amount_cents: 900, status: "failed", created_at: "2026-09-12T00:00:00.000Z" });

    const detail = await api("GET", `/api/patient-data/billing/orders/${orderId}`, { token: "pat" });
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({
      order_number: "TH-D", total_cents: 7999, refunded_cents: 500, receipt_available: true, subtotal_cents: 6999, shipping_charge_cents: 1000,
      items: [{ product_id: PRODUCT, name: "Control", quantity: 1, unit_price_cents: 6999, line_total_cents: 6999 }],
      refunds: [{ amount_cents: 500, status: "succeeded" }], shipping_address: ADDRESS,
      shipment: { status: "processing", carrier: null, tracking_number: null, tracking_url: null, shipped_at: null },
    });
    expect((await api("GET", `/api/patient-data/billing/orders/${orderId}`, { token: "other" })).status).toBe(404);
    expect(stranger.patientId).not.toBe(patientId);

    // Staff record a carrier + tracking number through the shared shipment writer.
    const { recordShipment } = await import("../billing/shipments");
    const order = backend.tables.billing_orders.find((row) => row.id === orderId)!;
    await recordShipment(order as any, { status: "shipped", carrier: "usps", tracking_number: "9400111899223", updated_by: "staff-1" });
    const shipped = await api("GET", `/api/patient-data/billing/orders/${orderId}`, { token: "pat" });
    expect(shipped.json.shipment).toMatchObject({ status: "shipped", carrier: "usps", tracking_number: "9400111899223" });
    expect(shipped.json.shipment.tracking_url).toContain("9400111899223");
    expect(shipped.json.shipment.shipped_at).toBeTruthy();
    expect(shipped.json.fulfillment_status).toBe("shipped");
    expect(order).toMatchObject({ fulfillment_status: "shipped", carrier: "usps", tracking_number: "9400111899223", shipped_by: "staff-1" });

    // A provider callback can later mark it delivered without changing the contract.
    await recordShipment(order as any, { status: "delivered", source: "provider", external_id: "shp_1", event: { code: "DELIVERED" } });
    const delivered = await api("GET", `/api/patient-data/billing/orders/${orderId}`, { token: "pat" });
    expect(delivered.json.shipment.status).toBe("delivered");
    expect(delivered.json.shipment.delivered_at).toBeTruthy();
    expect(backend.tables.billing_shipments[0]).toMatchObject({ source: "provider", external_id: "shp_1" });
    expect(backend.tables.billing_shipments[0].events).toHaveLength(1);
    expect(order.fulfillment_status).toBe("shipped");
  });
});

describe("subscription self-service", () => {
  let patientId = "";
  let row: Row;
  beforeEach(() => {
    seedOffice("office-1");
    ({ patientId } = backend.signedIn("pat", "office-1"));
    backend.tables.billing_payers.push({ id: crypto.randomUUID(), provider_id: "office-1", patient_id: patientId, name: "Pat", email: "pat@example.com", phone: null, stripe_customer_id: "cus_pat" });
    row = seedSubscription(patientId, "office-1");
    stripe.methods.get("pm_visa").customer = "cus_pat";
  });

  it("returns detail with the renewal card and hides other patients' subscriptions", async () => {
    backend.signedIn("other", "office-1");
    const detail = await api("GET", `/api/patient-data/billing/subscriptions/${row.id}`, { token: "pat" });
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ product_name: "Control", cadence_weeks: 4, quantity: 1, next_shipment_at: "2026-10-20T00:00:00.000Z", offered_cadences_weeks: [4, 8], shipping_address: ADDRESS, card: { id: "pm_visa", last4: "4242" } });
    expect((await api("GET", `/api/patient-data/billing/subscriptions/${row.id}`, { token: "other" })).status).toBe(404);
    expect((await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/pause`, { token: "other" })).status).toBe(404);
    expect((await api("GET", `/api/patient-data/billing/subscriptions/not-a-uuid`, { token: "pat" })).status).toBe(404);
    const list = await api("GET", "/api/patient-data/billing/subscriptions", { token: "pat" });
    expect(list.json.items.map((item: Row) => item.id)).toEqual([row.id]);
    // The list carries the same detail shape the app declares (card + cadences), not a slimmer row.
    expect(list.json.items[0]).toMatchObject({ offered_cadences_weeks: [4, 8], product_name: "Control", next_shipment_at: "2026-10-20T00:00:00.000Z" });
    expect(list.json.items[0]).toHaveProperty("card");
    expect(list.json.items[0].card).toEqual(detail.json.card);
  });

  it("moves the next shipment to a chosen day and mirrors it on the row", async () => {
    const bad = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/move-next`, { token: "pat", body: { next_shipment_at: "2020-01-01" } });
    expect(bad.status).toBe(400);
    const target = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const moved = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/move-next`, { token: "pat", body: { next_shipment_at: target } });
    expect(moved.status).toBe(200);
    expect(moved.json.status).toBe("active");
    expect(moved.json.next_shipment_at.slice(0, 10)).toBe(target);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(row.stripe_subscription_id, expect.objectContaining({ trial_end: expect.any(Number), proration_behavior: "none" }), expect.objectContaining({ stripeAccount: "acct_office-1" }));
    expect(backend.tables.billing_subscriptions[0].next_shipment_at.slice(0, 10)).toBe(target);
  });

  it("skips one shipment by pushing the next date out one cadence", async () => {
    const skipped = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/skip-next`, { token: "pat" });
    expect(skipped.status).toBe(200);
    expect(skipped.json.next_shipment_at.slice(0, 10)).toBe("2026-11-17");
  });

  it("refuses scheduling changes on paused or ending subscriptions", async () => {
    const paused = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/pause`, { token: "pat" });
    expect(paused.json.paused).toBe(true);
    expect((await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/skip-next`, { token: "pat" })).status).toBe(409);
    const resumed = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/resume`, { token: "pat" });
    expect(resumed.json.paused).toBe(false);
    const canceled = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/cancel`, { token: "pat" });
    expect(canceled.json.cancel_at_period_end).toBe(true);
    expect((await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/move-next`, { token: "pat", body: { next_shipment_at: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) } })).status).toBe(409);
  });

  it("changes the shipping address on the row and the Stripe customer", async () => {
    const next = { ...ADDRESS, line1: "9 Oak Ave", postal_code: "78702" };
    const changed = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/address`, { token: "pat", body: { shipping_address: next } });
    expect(changed.status).toBe(200);
    expect(changed.json.shipping_address).toEqual(next);
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_pat", { shipping: expect.objectContaining({ address: expect.objectContaining({ line1: "9 Oak Ave" }) }) }, expect.anything());
    expect((await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/address`, { token: "pat", body: { shipping_address: { name: "" } } })).status).toBe(400);
  });

  it("changes cadence and quantity in place without proration and re-derives the fee", async () => {
    const same = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/plan`, { token: "pat", body: { cadence_weeks: 4, quantity: 1 } });
    expect(same.status).toBe(409);
    expect((await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/plan`, { token: "pat", body: { cadence_weeks: 6 } })).status).toBe(400);
    const changed = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/plan`, { token: "pat", body: { cadence_weeks: 8, quantity: 2 } });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ cadence_weeks: 8, quantity: 2, unit_price_cents: 6299 });
    const call = stripe.subscriptions.update.mock.calls.find(([id]) => id === row.stripe_subscription_id)!;
    expect(call[1]).toMatchObject({
      proration_behavior: "none", billing_cycle_anchor: "unchanged",
      items: [{ id: "si_prod", price: "price_8w", quantity: 2 }, { id: "si_ship", price: "price_ship_8w", quantity: 1 }],
    });
    expect(call[1].application_fee_percent).toBeGreaterThan(0);
    // Effective behavior, not just request shape: the 4w→8w interval change kept the current
    // period (no anchor reset, no immediate invoice); the new cadence starts at the next renewal.
    expect(stripe.cycleResets).toEqual([]);
    expect(stripe.live.get(row.stripe_subscription_id).current_period_end).toBe(1_792_000_000);
    const keptPeriodEnd = new Date(1_792_000_000 * 1000).toISOString();
    expect(backend.tables.billing_subscriptions[0].current_period_end).toBe(keptPeriodEnd);
    expect(changed.json.current_period_end).toBe(keptPeriodEnd);
    expect(backend.tables.billing_subscriptions[0]).toMatchObject({ cadence_weeks: 8, quantity: 2, stripe_price_id: "price_8w", stripe_shipping_price_id: "price_ship_8w", application_fee_cents: 3599 * 2 + 1000 });
  });

  it("updates the renewal card to one the patient owns", async () => {
    const other = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/card`, { token: "pat", body: { payment_method_id: "pm_other" } });
    expect(other.status).toBe(403);
    const missing = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/card`, { token: "pat", body: { payment_method_id: "pm_nope" } });
    expect(missing.status).toBe(404);
    const updated = await api("POST", `/api/patient-data/billing/subscriptions/${row.id}/card`, { token: "pat", body: { payment_method_id: "pm_amex" } });
    expect(updated.status).toBe(200);
    expect(stripe.methods.get("pm_amex").customer).toBe("cus_pat");
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(row.stripe_subscription_id, { default_payment_method: "pm_amex" }, expect.anything());
  });
});
