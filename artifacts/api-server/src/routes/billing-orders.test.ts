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
vi.mock("../billing/receipts", () => ({
  sendReceipt: vi.fn(async () => undefined),
  sendCancellationNotice: vi.fn(async () => undefined),
  sendShippedNotice: vi.fn(async () => undefined),
}));

import hqRouter from "./billing-hq-orders";
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
    if (raw.startsWith("in.(") && !raw.slice(4, -1).split(",").includes(String(row[key]))) return false;
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