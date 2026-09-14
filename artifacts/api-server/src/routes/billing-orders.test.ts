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
vi.mock("../billing/receipts", () => ({
  sendReceipt: vi.fn(async () => undefined),
  sendCancellationNotice: vi.fn(async () => undefined),
  sendShippedNotice: vi.fn(async () => undefined),
}));

import hqRouter from "./billing-hq-orders";
import officeRouter from "./billing-office-orders";
import publicRouter from "./billing-public";
import { sendShippedNotice } from "../billing/receipts";
import { __setCredentialsForTests } from "../billing/stripe-client";

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
afterAll(async () => {
  global.fetch = originalFetch;
  __setCredentialsForTests(null);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  __setCredentialsForTests({ secret: "sk_test_x", publishable: "pk_test_x", account_id: "acct_platform" });
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
    billing_refunds: [], billing_disputes: [], billing_ledger: [],
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
    return response([], 201);
  }) as typeof fetch;
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
    expect(sendShippedNotice).not.toHaveBeenCalled();

    const shipped = await call("PUT", "/billing/hq/fulfillment/0a1b2c3d-0000-4000-8000-000000000001", {
      status: "shipped", carrier: "UPS", tracking_number: "1Z999",
    });
    expect(shipped.status).toBe(200);
    expect(sendShippedNotice).toHaveBeenCalledOnce();
    expect(tables.billing_orders[0].fulfillment_status).toBe("shipped");
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