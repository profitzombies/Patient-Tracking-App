import crypto from "node:crypto";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});
vi.mock("../lib/staff-auth", async () => {
  const actual = await vi.importActual<typeof import("../lib/staff-auth")>("../lib/staff-auth");
  return {
    ...actual,
    requireHqPermission: () => (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.locals.staff = { userId: "hq-user", role: "hq_admin", departmentRole: "admin" };
      next();
    },
  };
});
vi.mock("../billing/auth", async () => {
  const actual = await vi.importActual<typeof import("../billing/auth")>("../billing/auth");
  return {
    ...actual,
    // The office router sees whichever office the test names; "office-2" owns nothing here.
    requireOfficeBillingScope: async (req: express.Request) => ({
      providerId: typeof req.query.office === "string" ? req.query.office : "office-1", officeName: "Harbor Health",
      actorUserId: "owner-1", isHq: false, officeRole: "owner", canManage: true,
    }),
  };
});
vi.mock("../billing/receipts", async (original) => ({
  ...(await original<typeof import("../billing/receipts")>()),
  sendReceipt: vi.fn(async () => undefined),
  sendCancellationNotice: vi.fn(async () => undefined),
  sendPaymentFailed: vi.fn(async () => undefined),
  sendShippedNotice: vi.fn(async () => undefined),
}));
vi.mock("../lib/admin-audit", async (original) => {
  const actual = await original<typeof import("../lib/admin-audit")>();
  return { ...actual, recordAdminAuditEvent: vi.fn(async () => undefined) };
});

import hqRouter from "./billing-hq-orders";
import officeRouter from "./billing-office-orders";
import publicRouter from "./billing-public";
import { __setCustomerEmailTransportForTests } from "../billing/customer-emails";
import { __setCredentialsForTests, __setStripeForTests } from "../billing/stripe-client";
import { recordAdminAuditEvent } from "../lib/admin-audit";

type Row = Record<string, any>;
const originalFetch = global.fetch;
let server: http.Server;
let baseUrl = "";
let tables: Record<string, Row[]>;

function response(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit"].includes(key)) continue;
    if (raw === "is.null") { if (row[key] != null) return false; continue; }
    if (raw.startsWith("eq.") && String(row[key]) !== decodeURIComponent(raw.slice(3))) return false;
    if (raw.startsWith("in.(") && !raw.slice(4, -1).split(",").map((value) => value.replace(/^"|"$/g, "")).includes(String(row[key]))) return false;
    const bound = /^(gte|gt|lte|lt)\.(.*)$/.exec(raw);
    if (bound) {
      const value = row[key];
      if (value == null) return false;
      const compare = String(value).localeCompare(decodeURIComponent(bound[2]));
      if (bound[1] === "gte" ? compare < 0 : bound[1] === "gt" ? compare <= 0 : bound[1] === "lte" ? compare > 0 : compare >= 0) return false;
    }
  }
  return true;
}
async function call(method: string, path: string, body?: unknown) {
  const res = await originalFetch(`${baseUrl}${path}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, any> };
}
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(hqRouter);
  app.use(officeRouter);
  app.use(publicRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
const customerEmails = vi.fn(async (_input: { to: string; subject: string; html: string; text: string }) => undefined);
afterAll(async () => {
  global.fetch = originalFetch;
  __setCredentialsForTests(null);
  __setStripeForTests(null);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  __setCredentialsForTests({ secret: "sk_test_x", publishable: "pk_test_x", account_id: "acct_platform" });
  customerEmails.mockClear();
  __setCustomerEmailTransportForTests(customerEmails);
  tables = {
    billing_orders: [{
      id: "0a1b2c3d-0000-4000-8000-000000000001", order_number: "TH-ABC123", provider_id: "office-1", payer_id: "payer-1",
      patient_id: null, link_id: "link-good", kind: "one_time", subscription_id: null,
      status: "paid", currency: "usd", subtotal_cents: 6000, shipping_charge_cents: 1000,
      tax_cents: 0, total_cents: 7000, application_fee_cents: 4500,
      application_fee_collected_cents: 4500, stripe_fee_cents: 233, office_net_cents: 2267,
      hard_cost_cents: 433, shipping_cost_cents: 1000, hq_profit_cents: 3067,
      shipping_address: { name: "Pat", line1: "1 Main", line2: null, city: "Austin", state: "TX", postal_code: "78701", country: "US", phone: null },
      fulfillment_status: "to_ship", tracking_number: null, carrier: null, shipped_at: null,
      shipped_by: null, canceled_reason: null, livemode: false, metadata: {},
      created_at: "2026-01-01T00:00:00Z", paid_at: "2026-01-01T00:01:00Z",
    }],
    billing_order_items: [{
      id: "item-1", order_id: "0a1b2c3d-0000-4000-8000-000000000001", product_id: "product-1", product_name_snapshot: "Control",
      quantity: 1, unit_price_cents: 6000, floor_price_cents_snapshot: 5999,
      thinnr_share_cents: 3599, hard_cost_cents_snapshot: 433, created_at: "2026-01-01T00:00:00Z",
    }],
    billing_payers: [{ id: "payer-1", provider_id: "office-1", name: "Pat", email: "pat@example.com", phone: null, patient_id: null }],
    billing_payment_links: [
      { id: "link-good", token: "good-token", active: true },
      { id: "link-other", token: "other-token", active: true },
    ],
    billing_connected_accounts: [{ provider_id: "office-1", stripe_account_id: "acct_1", disconnected_at: null, charges_enabled: true }],
    billing_refunds: [], billing_disputes: [], billing_ledger: [], billing_subscriptions: [],
    providers: [{ provider_id: "office-1", office_name: "Harbor Health", provider_name: "Dr. Harbor", email: "office@example.com" }],
  };
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const table = url.pathname.split("/").at(-1)!;
    const rows = tables[table] ?? (tables[table] = []);
    const method = init?.method ?? "GET";
    if (method === "GET") return response(rows.filter((row) => matches(row, url.searchParams)));
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const selected = rows.filter((row) => matches(row, url.searchParams));
      selected.forEach((row) => Object.assign(row, body));
      return response(selected);
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...body };
      rows.push(row);
      return response([row], 201);
    }
    return response([], 201);
  }) as typeof fetch;
  __setStripeForTests({ invoices: { pay: vi.fn(async () => ({ id: "in_failed" })) } } as never);
});

describe("subscription payment recovery routes", () => {
  it("returns 409 from all four actions when there is no failed invoice", async () => {
    tables.billing_subscriptions.push({ id: "sub-1", provider_id: "office-1", last_failed_invoice_id: null, last_hosted_invoice_url: null });
    for (const path of [
      "/billing/hq/subscriptions/sub-1/retry-payment",
      "/billing/hq/subscriptions/sub-1/resend-payment-email",
      "/billing/office/subscriptions/sub-1/retry-payment",
      "/billing/office/subscriptions/sub-1/resend-payment-email",
    ]) {
      expect((await call("POST", path)).status).toBe(409);
    }
  });

  it("returns 402 when Stripe declines a manual retry", async () => {
    tables.billing_subscriptions.push({
      id: "sub-1", provider_id: "office-1", last_failed_invoice_id: "in_failed",
      last_hosted_invoice_url: "https://invoice.stripe.test/pay", payment_failure_count: 2,
    });
    __setStripeForTests({ invoices: { pay: vi.fn(async () => {
      throw { type: "StripeCardError", message: "The card was declined." };
    }) } } as never);
    expect((await call("POST", "/billing/hq/subscriptions/sub-1/retry-payment")).status).toBe(402);
    expect((await call("POST", "/billing/office/subscriptions/sub-1/retry-payment")).status).toBe(402);
  });
});

describe("HQ overview and activity feed", () => {
  const today = new Date().toISOString().slice(0, 10);
  beforeEach(() => {
    tables.billing_orders[0].paid_at = `${today}T10:00:00Z`;
    tables.billing_orders[0].created_at = `${today}T09:59:00Z`;
    tables.billing_refunds = [{ id: "refund-1", order_id: tables.billing_orders[0].id, amount_cents: 1500, created_at: `${today}T12:00:00Z` }];
    tables.billing_ledger = [
      { id: "ledger-2", provider_id: "office-1", order_id: tables.billing_orders[0].id, kind: "refund", amount_cents: -1500, application_fee_cents: 0,
        detail: {}, occurred_at: `${today}T12:00:00Z`, created_at: `${today}T12:00:00Z` },
      { id: "ledger-1", provider_id: "office-1", order_id: tables.billing_orders[0].id, kind: "sale", amount_cents: 2267, application_fee_cents: 4500,
        detail: { total_cents: 7000 }, occurred_at: `${today}T10:00:00Z`, created_at: `${today}T10:00:00Z` },
    ];
  });
  it("buckets payments and refunds into the daily series", async () => {
    const result = await call("GET", "/billing/hq/overview");
    expect(result.status).toBe(200);
    expect(result.json.series).toHaveLength(30);
    const point = result.json.series.find((row: Row) => row.date === today);
    expect(point).toMatchObject({ collected_cents: 7000, fee_cents: 4500, refunded_cents: 1500, orders: 1 });
    expect(result.json.series.filter((row: Row) => row.date !== today).every((row: Row) => row.collected_cents === 0 && row.orders === 0)).toBe(true);
  });
  it("buckets today's payments and refunds by local clock hour", async () => {
    const result = await call("GET", "/billing/hq/overview/today?tz=UTC");
    expect(result.status).toBe(200);
    expect(result.json.time_zone).toBe("UTC");
    expect(result.json.date).toBe(today);
    expect(result.json.hours).toHaveLength(24);
    expect(result.json.hours[10]).toMatchObject({ hour: 10, collected_cents: 7000, fee_cents: 4500, net_cents: 7000, orders: 1 });
    expect(result.json.hours[12]).toMatchObject({ hour: 12, collected_cents: 0, refunded_cents: 1500, net_cents: -1500 });
    expect(result.json).toMatchObject({ collected_cents: 7000, refunded_cents: 1500, net_cents: 5500, fee_cents: 4500, orders: 1 });
    expect(result.json.hours.filter((row: Row) => ![10, 12].includes(row.hour as number)).every((row: Row) => row.collected_cents === 0 && row.refunded_cents === 0)).toBe(true);
  });
  it("rejects an unknown time zone and defaults to New York when none is given", async () => {
    const bad = await call("GET", "/billing/hq/overview/today?tz=Mars%2FOlympus");
    expect(bad.status).toBe(400);
    const dflt = await call("GET", "/billing/hq/overview/today");
    expect(dflt.status).toBe(200);
    expect(dflt.json.time_zone).toBe("America/New_York");
  });
  it("labels recent activity with the office name, order number and gross sale amount", async () => {
    const result = await call("GET", "/billing/hq/overview");
    expect(result.json.recent).toEqual([
      expect.objectContaining({ kind: "refund", label: "Refund issued", office_name: "Harbor Health", order_number: "TH-ABC123", amount_cents: -1500 }),
      expect.objectContaining({ kind: "sale", label: "Payment received", office_name: "Harbor Health", order_number: "TH-ABC123", amount_cents: 7000 }),
    ]);
  });
  it("pages the activity feed newest first and filters by kind", async () => {
    const page = await call("GET", "/billing/hq/activity?limit=1");
    expect(page.status).toBe(200);
    expect(page.json.items.map((row: Row) => row.id)).toEqual(["ledger-2"]);
    expect(page.json.next_cursor).toEqual(expect.any(String));
    const sales = await call("GET", "/billing/hq/activity?kind=sale");
    expect(sales.json.items.map((row: Row) => row.id)).toEqual(["ledger-1"]);
    expect(sales.json.next_cursor).toBeNull();
    const bad = await call("GET", "/billing/hq/activity?from=2026-09-20&to=2026-09-01");
    expect(bad.status).toBe(400);
  });
});

describe("office overview, activity, refunds and fulfillment status", () => {
  const today = new Date().toISOString().slice(0, 10);
  beforeEach(() => {
    tables.billing_orders[0].paid_at = `${today}T10:00:00Z`;
    tables.billing_orders[0].created_at = `${today}T09:59:00Z`;
    tables.billing_orders[0].status = "partially_refunded";
    tables.billing_refunds = [{ id: "refund-1", order_id: tables.billing_orders[0].id, amount_cents: 1500, status: "succeeded", reason: "requested_by_customer", created_at: `${today}T12:00:00Z` }];
    tables.billing_disputes = [{ id: "dispute-1", order_id: tables.billing_orders[0].id, amount_cents: 7000, status: "needs_response", reason: "fraudulent", evidence_due_by: `${today}T23:00:00Z`, closed_at: null, created_at: `${today}T13:00:00Z` }];
    tables.billing_ledger = [
      { id: "ledger-2", provider_id: "office-1", order_id: tables.billing_orders[0].id, kind: "refund", amount_cents: -1500, application_fee_cents: 0,
        detail: {}, occurred_at: `${today}T12:00:00Z`, created_at: `${today}T12:00:00Z` },
      { id: "ledger-1", provider_id: "office-1", order_id: tables.billing_orders[0].id, kind: "sale", amount_cents: 2267, application_fee_cents: 4500,
        detail: { total_cents: 7000 }, occurred_at: `${today}T10:00:00Z`, created_at: `${today}T10:00:00Z` },
      { id: "ledger-9", provider_id: "office-2", order_id: null, kind: "payout", amount_cents: -9000, application_fee_cents: 0,
        detail: {}, occurred_at: `${today}T14:00:00Z`, created_at: `${today}T14:00:00Z` },
    ];
  });
  it("buckets today's office payments by hour with the office net as the profit line", async () => {
    const result = await call("GET", "/billing/office/overview/today?tz=UTC");
    expect(result.status).toBe(200);
    const ten = result.json.hours.find((row: Row) => row.hour === 10);
    expect(ten).toMatchObject({ collected_cents: 7000, fee_cents: 4500, profit_cents: 2267, orders: 1 });
    expect(result.json.hours.find((row: Row) => row.hour === 12)).toMatchObject({ refunded_cents: 1500, net_cents: -1500 });
    expect(result.json).toMatchObject({ collected_cents: 7000, refunded_cents: 1500, net_cents: 5500, profit_cents: 2267 });
    const other = await call("GET", "/billing/office/overview/today?tz=UTC&office=office-2");
    expect(other.json).toMatchObject({ collected_cents: 0, refunded_cents: 0, orders: 0 });
    const bad = await call("GET", "/billing/office/overview/today?tz=Mars/Olympus");
    expect(bad.status).toBe(400);
  });
  it("counts today's refunds of older own orders and ignores other offices' refunds", async () => {
    tables.billing_orders.push(
      { ...tables.billing_orders[0], id: "order-old", order_number: "TH-OLD0001", paid_at: "2026-01-05T10:00:00Z", created_at: "2026-01-05T09:59:00Z" },
      { ...tables.billing_orders[0], id: "order-other", order_number: "TH-OTHER1", provider_id: "office-2" },
    );
    tables.billing_refunds.push(
      { id: "refund-old", order_id: "order-old", amount_cents: 2000, status: "succeeded", reason: null, created_at: `${today}T15:00:00Z` },
      { id: "refund-other", order_id: "order-other", amount_cents: 9999, status: "succeeded", reason: null, created_at: `${today}T15:30:00Z` },
    );
    const result = await call("GET", "/billing/office/overview/today?tz=UTC");
    expect(result.json.hours.find((row: Row) => row.hour === 15)).toMatchObject({ refunded_cents: 2000 });
    expect(result.json).toMatchObject({ collected_cents: 7000, refunded_cents: 3500, orders: 1 });
    const refunds = await call("GET", "/billing/office/refunds?kind=refund");
    expect(refunds.json.items.map((row: Row) => row.id)).toEqual(["refund-old", "refund-1"]);
    expect(refunds.json.items[0]).toMatchObject({ order_number: "TH-OLD0001", payer_name: "Pat" });
  });
  it("pins the activity feed to the office even when a provider filter is passed", async () => {
    const result = await call("GET", "/billing/office/activity?provider_id=office-2");
    expect(result.status).toBe(200);
    expect(result.json.items.map((row: Row) => row.id)).toEqual(["ledger-2", "ledger-1"]);
    const refunds = await call("GET", "/billing/office/activity?kind=refund");
    expect(refunds.json.items.map((row: Row) => row.id)).toEqual(["ledger-2"]);
  });
  it("lists refunds and disputes newest first with the order and payer, and filters by kind", async () => {
    const result = await call("GET", "/billing/office/refunds");
    expect(result.status).toBe(200);
    expect(result.json.items).toEqual([
      expect.objectContaining({ id: "dispute-1", kind: "dispute", order_number: "TH-ABC123", payer_name: "Pat", amount_cents: 7000, status: "needs_response", evidence_due_by: `${today}T23:00:00Z` }),
      expect.objectContaining({ id: "refund-1", kind: "refund", order_number: "TH-ABC123", payer_name: "Pat", amount_cents: 1500, reason: "requested_by_customer" }),
    ]);
    const onlyRefunds = await call("GET", "/billing/office/refunds?kind=refund");
    expect(onlyRefunds.json.items.map((row: Row) => row.id)).toEqual(["refund-1"]);
    const other = await call("GET", "/billing/office/refunds?office=office-2");
    expect(other.json.items).toEqual([]);
  });
  it("shows the office its own shipping status as detail rows without HQ profit", async () => {
    tables.billing_orders.push({ ...tables.billing_orders[0], id: "order-other", order_number: "TH-OTHER1", provider_id: "office-2" });
    const result = await call("GET", "/billing/office/fulfillment");
    expect(result.status).toBe(200);
    expect(result.json.items.map((row: Row) => row.id)).toEqual(["0a1b2c3d-0000-4000-8000-000000000001"]);
    expect(result.json.items[0].profit).toBeUndefined();
    expect(result.json.items[0].shipping_address).toMatchObject({ city: "Austin" });
    const shipped = await call("GET", "/billing/office/fulfillment?status=shipped");
    expect(shipped.json.items).toEqual([]);
  });
});

describe("per-patient purchases summary", () => {
  const PATIENT = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const OTHER_PATIENT = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e";
  const FIRST = "0a1b2c3d-0000-4000-8000-000000000001";
  function seedPatientPurchases() {
    tables.patients = [
      { id: PATIENT, provider_id: "office-1" },
      { id: OTHER_PATIENT, provider_id: "office-2" },
    ];
    const first = tables.billing_orders[0];
    first.patient_id = PATIENT;
    tables.billing_orders.push(
      // Renewal, partially refunded and shipped through the shipments table.
      { ...first, id: "0a1b2c3d-0000-4000-8000-000000000002", order_number: "TH-REN001", kind: "subscription_renewal", subscription_id: "sub-p1",
        status: "partially_refunded", total_cents: 7000, fulfillment_status: "shipped", created_at: "2026-02-01T00:00:00Z", paid_at: "2026-02-01T00:01:00Z" },
      // Failed renewal: never paid, so it counts for the payment problem but not the totals.
      { ...first, id: "0a1b2c3d-0000-4000-8000-000000000003", order_number: "TH-FAIL01", kind: "subscription_renewal", subscription_id: "sub-p1",
        status: "failed", total_cents: 7000, created_at: "2026-03-01T00:00:00Z", paid_at: null, failure_message: "Card declined", canceled_reason: null, updated_at: "2026-03-01T00:02:00Z" },
      // Same patient at ANOTHER office: never part of office-1's summary.
      { ...first, id: "0a1b2c3d-0000-4000-8000-000000000004", order_number: "TH-ELSE01", provider_id: "office-2", total_cents: 99_000, created_at: "2026-03-02T00:00:00Z" },
      // Another patient at this office.
      { ...first, id: "0a1b2c3d-0000-4000-8000-000000000005", order_number: "TH-OTHR01", patient_id: OTHER_PATIENT, total_cents: 5000, created_at: "2026-03-03T00:00:00Z" },
    );
    tables.billing_order_items.push({ ...tables.billing_order_items[0], id: "item-2", order_id: "0a1b2c3d-0000-4000-8000-000000000002", product_name_snapshot: "Control", quantity: 2 });
    tables.billing_refunds.push({ id: "ref-1", order_id: "0a1b2c3d-0000-4000-8000-000000000002", amount_cents: 1500, status: "succeeded", created_at: "2026-02-05T00:00:00Z" });
    tables.billing_shipments = [{ id: "ship-1", order_id: "0a1b2c3d-0000-4000-8000-000000000002", status: "shipped", carrier: "usps", tracking_number: "9400111", tracking_url: null,
      shipped_at: "2026-02-02T00:00:00Z", delivered_at: null, canceled_at: null, created_at: "2026-02-02T00:00:00Z" }];
    tables.billing_products = [{ id: "product-1", name: "Control" }];
    tables.billing_subscriptions.push(
      { id: "sub-p1", provider_id: "office-1", patient_id: PATIENT, product_id: "product-1", status: "past_due", paused_at: null,
        unit_price_cents: 6000, shipping_charge_cents: 1000, cadence_weeks: 4, quantity: 1, current_period_end: "2026-04-01T00:00:00Z",
        next_shipment_at: "2026-03-29T00:00:00Z", cancel_at_period_end: false, payment_failure_count: 1, last_payment_failed_at: "2026-03-05T00:00:00Z",
        last_failure_message: "Your card was declined.", last_hosted_invoice_url: "https://invoice.stripe.test/pay", shipping_address: first.shipping_address, created_at: "2026-01-15T00:00:00Z" },
      // Canceled while dunning: immediate cancellation leaves the failure count
      // and timestamp in place, so this row must NOT surface as a live problem
      // even though its failure is the newest of all.
      { id: "sub-p0", provider_id: "office-1", patient_id: PATIENT, product_id: "product-1", status: "canceled", paused_at: null,
        unit_price_cents: 6000, shipping_charge_cents: 1000, cadence_weeks: 4, quantity: 1, current_period_end: "2026-01-01T00:00:00Z",
        next_shipment_at: null, cancel_at_period_end: false, payment_failure_count: 3, last_payment_failed_at: "2026-03-20T00:00:00Z",
        last_failure_message: "old", last_hosted_invoice_url: "https://invoice.stripe.test/old", shipping_address: first.shipping_address, created_at: "2025-11-01T00:00:00Z" },
      { id: "sub-else", provider_id: "office-2", patient_id: PATIENT, product_id: "product-1", status: "active", paused_at: null,
        unit_price_cents: 6000, shipping_charge_cents: 1000, cadence_weeks: 4, quantity: 1, current_period_end: "2026-04-01T00:00:00Z",
        next_shipment_at: null, cancel_at_period_end: false, payment_failure_count: 0, last_payment_failed_at: null,
        last_failure_message: null, last_hosted_invoice_url: null, shipping_address: first.shipping_address, created_at: "2026-02-01T00:00:00Z" },
    );
  }

  it("summarizes one patient's subscriptions, recent orders, totals and last payment problem for the office only", async () => {
    seedPatientPurchases();
    const result = await call("GET", `/billing/office/patients/${PATIENT}/summary`);
    expect(result.status).toBe(200);
    expect(result.json.patient_id).toBe(PATIENT);
    // Office-2's subscription for the same patient never appears; newest first.
    expect(result.json.subscriptions.map((row: Row) => [row.id, row.status, row.product_name, row.cadence_weeks, row.next_shipment_at])).toEqual([
      ["sub-p1", "past_due", "Control", 4, "2026-03-29T00:00:00Z"],
      ["sub-p0", "canceled", "Control", 4, "2026-01-01T00:00:00Z"],
    ]);
    expect(result.json.orders.map((row: Row) => row.order_number)).toEqual(["TH-FAIL01", "TH-REN001", "TH-ABC123"]);
    const renewal = result.json.orders.find((row: Row) => row.order_number === "TH-REN001");
    expect(renewal).toMatchObject({ status: "partially_refunded", refunded_cents: 1500, items_label: "Control × 2", item_count: 2, subscription_id: "sub-p1" });
    expect(renewal.shipment).toMatchObject({ status: "shipped", carrier: "usps", tracking_number: "9400111" });
    expect(result.json.orders.find((row: Row) => row.order_number === "TH-ABC123").shipment.status).toBe("processing");
    // Paid + partially refunded count; the failed renewal and other-office order do not.
    expect(result.json.totals).toEqual({
      order_count: 3, lifetime_paid_cents: 14_000, lifetime_refunded_cents: 1500, lifetime_net_cents: 12_500,
      last_paid_at: "2026-02-01T00:01:00Z", active_subscription_count: 1,
    });
    // The dunning subscription (Mar 5) outranks the failed order (Mar 1); the canceled one's newer failure (Mar 20) is ignored.
    expect(result.json.last_payment_problem).toEqual({
      source: "subscription", subscription_id: "sub-p1", order_id: null, order_number: null, at: "2026-03-05T00:00:00Z",
      message: "Your card was declined.", hosted_invoice_url: "https://invoice.stripe.test/pay",
    });
    // No Stripe customer on the payer row: no card, and Stripe was never asked.
    expect(result.json.saved_card).toEqual({ state: "none", brand: null, last4: null, exp_month: null, exp_year: null });
  });

  it("falls back to the failed order when no subscription is dunning, and reports the card on file", async () => {
    seedPatientPurchases();
    // A paid retry flips the status back to active; the historical failure
    // count and timestamp stay behind exactly as the webhook leaves them.
    Object.assign(tables.billing_subscriptions.find((row) => row.id === "sub-p1")!, { status: "active" });
    tables.billing_payers[0].patient_id = PATIENT;
    tables.billing_payers[0].stripe_customer_id = "cus_1";
    __setStripeForTests({
      paymentMethods: { list: vi.fn(async () => ({ data: [
        { id: "pm_old", card: { brand: "visa", last4: "1111", exp_month: 1, exp_year: 2027 } },
        { id: "pm_default", card: { brand: "mastercard", last4: "4444", exp_month: 6, exp_year: 2029 } },
      ] })) },
      customers: { retrieve: vi.fn(async () => ({ invoice_settings: { default_payment_method: "pm_default" } })) },
    } as never);
    const result = await call("GET", `/billing/office/patients/${PATIENT}/summary`);
    expect(result.status).toBe(200);
    expect(result.json.last_payment_problem).toMatchObject({ source: "order", order_id: FIRST.replace(/1$/, "3"), order_number: "TH-FAIL01", message: "Card declined" });
    expect(result.json.saved_card).toEqual({ state: "on_file", brand: "mastercard", last4: "4444", exp_month: 6, exp_year: 2029 });
    expect(result.json.totals.active_subscription_count).toBe(1);
  });

  it("degrades the card to unknown when Stripe fails instead of failing the summary", async () => {
    seedPatientPurchases();
    tables.billing_payers[0].patient_id = PATIENT;
    tables.billing_payers[0].stripe_customer_id = "cus_1";
    __setStripeForTests({
      paymentMethods: { list: vi.fn(async () => { throw new Error("stripe down"); }) },
      customers: { retrieve: vi.fn(async () => ({})) },
    } as never);
    const result = await call("GET", `/billing/office/patients/${PATIENT}/summary`);
    expect(result.status).toBe(200);
    expect(result.json.saved_card.state).toBe("unknown");
    expect(result.json.totals.lifetime_net_cents).toBe(12_500);
  });

  it("returns 404 for another office's patient, a foreign office scope, and a non-UUID id", async () => {
    seedPatientPurchases();
    expect((await call("GET", `/billing/office/patients/${OTHER_PATIENT}/summary`)).status).toBe(404);
    // HQ drilled into office-2 cannot read office-1's patient even though office-2 has rows for them.
    expect((await call("GET", `/billing/office/patients/${PATIENT}/summary?office=office-2`)).status).toBe(404);
    expect((await call("GET", "/billing/office/patients/not-a-uuid/summary")).status).toBe(404);
    // A patient with no purchases at all still gets an empty, well-formed summary.
    tables.patients.push({ id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6f", provider_id: "office-1" });
    const empty = await call("GET", "/billing/office/patients/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6f/summary");
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ subscriptions: [], orders: [], last_payment_problem: null, totals: { order_count: 0, lifetime_net_cents: 0, active_subscription_count: 0 } });
  });
});

describe("billing order routes", () => {
  it("lists the shipping queue as paid detail rows with items and address", async () => {
    tables.billing_orders.push({
      ...tables.billing_orders[0], id: "order-failed", order_number: "TH-FAIL01", status: "failed", paid_at: null,
      stripe_payment_intent_id: null, created_at: "2026-01-02T00:00:00Z",
    });
    const result = await call("GET", "/billing/hq/fulfillment?status=to_ship");
    expect(result.status).toBe(200);
    expect(result.json.items.map((row: any) => row.id)).toEqual(["0a1b2c3d-0000-4000-8000-000000000001"]);
    expect(result.json.items[0].items).toEqual([expect.objectContaining({ product_name: "Control", quantity: 1 })]);
    expect(result.json.items[0].shipping_address).toMatchObject({ line1: "1 Main", city: "Austin" });
    expect(result.json.items[0].office_name).toBe("Harbor Health");
  });

  it("requires tracking details before shipping", async () => {
    const missing = await call("PUT", "/billing/hq/fulfillment/0a1b2c3d-0000-4000-8000-000000000001", { status: "shipped" });
    expect(missing.status).toBe(400);
    expect(missing.json.field).toBe("tracking_number");
    expect(customerEmails).not.toHaveBeenCalled();

    const shipped = await call("PUT", "/billing/hq/fulfillment/0a1b2c3d-0000-4000-8000-000000000001", {
      status: "shipped", carrier: "UPS", tracking_number: "1Z999",
    });
    expect(shipped.status).toBe(200);
    // The shipped email fires from the shipment transition itself, once.
    expect(customerEmails).toHaveBeenCalledOnce();
    expect(customerEmails.mock.calls[0][0].subject).toContain("has shipped");
    expect(tables.billing_customer_emails.map((row) => [row.template_id, row.status])).toEqual([["order-shipped", "sent"]]);
    expect(tables.billing_orders[0].fulfillment_status).toBe("shipped");
    // The shipment record is written first and the legacy columns mirror it.
    expect(tables.billing_shipments).toHaveLength(1);
    expect(tables.billing_shipments[0]).toMatchObject({
      order_id: tables.billing_orders[0].id, status: "shipped", carrier: "UPS", tracking_number: "1Z999",
      tracking_url: "https://www.ups.com/track?tracknum=1Z999", source: "staff",
    });
    expect(tables.billing_orders[0]).toMatchObject({ carrier: "UPS", tracking_number: "1Z999" });
    expect(recordAdminAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "billing_order_fulfillment_updated",
      providerId: "office-1",
      metadata: { order_id: tables.billing_orders[0].id, fulfillment_status: "shipped", has_tracking: true },
    }));
  });

  it("ships a partially refunded order but never an unpaid one", async () => {
    tables.billing_orders[0].status = "partially_refunded";
    const shipped = await call("PUT", "/billing/hq/fulfillment/0a1b2c3d-0000-4000-8000-000000000001", {
      status: "shipped", carrier: "UPS", tracking_number: "1Z999",
    });
    expect(shipped.status).toBe(200);
    tables.billing_orders[0].status = "failed";
    tables.billing_orders[0].fulfillment_status = "to_ship";
    const blocked = await call("PUT", "/billing/hq/fulfillment/0a1b2c3d-0000-4000-8000-000000000001", {
      status: "shipped", carrier: "UPS", tracking_number: "1Z999",
    });
    expect(blocked.status).toBe(409);
  });

  it("never moves a shipment backwards: a shipped or delivered order refuses processing with a 409 and no email", async () => {
    const shipped = await call("PUT", "/billing/hq/fulfillment/0a1b2c3d-0000-4000-8000-000000000001", { status: "shipped", carrier: "UPS", tracking_number: "1Z999" });
    expect(shipped.status).toBe(200);
    const back = await call("PUT", "/billing/hq/fulfillment/0a1b2c3d-0000-4000-8000-000000000001", { status: "to_ship" });
    expect(back.status).toBe(409);
    expect(back.json.error).toBe("A shipped order cannot go back to processing.");
    expect(tables.billing_shipments[0]).toMatchObject({ status: "shipped", tracking_number: "1Z999" });
    const delivered = await call("PUT", "/billing/hq/fulfillment/0a1b2c3d-0000-4000-8000-000000000001", { status: "delivered" });
    expect(delivered.status).toBe(200);
    expect(delivered.json.order.shipment).toMatchObject({ status: "delivered", delivered_at: expect.any(String), warehouse_status: null, back_ordered: false });
    const reship = await call("PUT", "/billing/hq/fulfillment/0a1b2c3d-0000-4000-8000-000000000001", { status: "shipped", carrier: "UPS", tracking_number: "1Z999" });
    expect(reship.status).toBe(409);
    expect(customerEmails).toHaveBeenCalledTimes(2);
    expect(tables.billing_shipments[0].status).toBe("delivered");
  });

  it("treats a non-UUID order id as not found instead of a server error", async () => {
    const result = await call("GET", "/billing/public/orders/TH-ABC123/status?token=good-token");
    expect(result.status).toBe(404);
    expect(result.json.error).toBe("Order not found.");
  });

  it("does not reveal an order to a mismatched payment-link token", async () => {
    const result = await call("GET", "/billing/public/orders/0a1b2c3d-0000-4000-8000-000000000001/status?token=other-token");
    expect(result.status).toBe(404);
    expect(result.json.error).toBe("Order not found.");
    const matching = await call("GET", "/billing/public/orders/0a1b2c3d-0000-4000-8000-000000000001/status?token=good-token");
    expect(matching.status).toBe(200);
    expect(matching.json.payer_email).toBe("p***@example.com");
    expect(JSON.stringify(matching.json)).not.toContain("pat@example.com");
  });

  it("rate limits repeated public reads", async () => {
    let limited: Awaited<ReturnType<typeof call>> | null = null;
    for (let index = 0; index < 125; index += 1) {
      const result = await call("GET", "/billing/public/config");
      if (result.status === 429) { limited = result; break; }
    }
    expect(limited?.status).toBe(429);
    expect(limited?.json.error).toContain("Too many");
  });
});