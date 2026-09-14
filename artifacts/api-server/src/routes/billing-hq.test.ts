import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/staff-auth", async (original) => {
  const actual = await original<typeof import("../lib/staff-auth")>();
  return {
    ...actual,
    requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
      if (!token) { res.status(401).json({ error: "Sign in to continue." }); return; }
      if (permission === "settings_manage" && token !== "manager") {
        res.status(403).json({ error: "Your HQ role does not have permission to do this." }); return;
      }
      res.locals.staff = { userId: "hq-user", role: "hq_admin", departmentRole: token === "manager" ? "admin" : "clinical" };
      next();
    },
  };
});
vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});
import router from "./billing-hq";

type Row = Record<string, unknown>;
const originalFetch = global.fetch;
let server: http.Server;
let base = "";
let settings: Row;
let product: Row;
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await originalFetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(router);
  server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
  settings = { id: 1, shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290,
    card_fee_fixed_cents: 30, version: 2, updated_by: null, updated_at: null, created_at: "2026-01-01T00:00:00Z" };
  product = { id: "product-1", slug: "control", name: "Control", floor_price_cents: 5999, hard_cost_cents: 433,
    active: true, retired_at: null, sort_order: 1, stripe_tax_code: null, created_at: "2026-01-01T00:00:00Z" };
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Row : {};
    if (url.pathname === "/rest/v1/billing_settings") {
      if (method === "GET") return response([settings]);
      if (method === "PATCH") {
        if (Number(url.searchParams.get("version")?.replace("eq.", "")) !== settings.version) return response([]);
        settings = { ...settings, ...body }; return response([settings]);
      }
    }
    if (url.pathname === "/rest/v1/billing_products") {
      if (method === "GET") return response([product]);
      if (method === "PATCH") { product = { ...product, ...body }; return response([product]); }
    }
    if (url.pathname === "/rest/v1/billing_office_prices") return response([]);
    if (url.pathname === "/rest/v1/billing_catalog_changes" && method === "POST") return response([{ id: "change-1", ...body }], 201);
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
});
describe("billing HQ catalog routes", () => {
  it("allows financial readers to read the catalog", async () => {
    const result = await call("GET", "/billing/hq/catalog", "reader");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ settings: { version: 2 }, products: [{ name: "Control", break_even_minimum_cents: 3767 }] });
  });
  it("requires settings_manage for catalog writes", async () => {
    const result = await call("POST", "/billing/hq/catalog/products/product-1/retire", "reader");
    expect(result.status).toBe(403);
    expect(product.active).toBe(true);
  });
  it("returns 409 for a stale settings version", async () => {
    const result = await call("PUT", "/billing/hq/catalog/settings", "manager", {
      shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290,
      card_fee_fixed_cents: 30, expected_version: 1,
    });
    expect(result.status).toBe(409);
  });
  it("retires and reactivates products", async () => {
    const retired = await call("POST", "/billing/hq/catalog/products/product-1/retire", "manager");
    expect(retired.status).toBe(200); expect((retired.json as { product: { active: boolean } }).product.active).toBe(false);
    const active = await call("POST", "/billing/hq/catalog/products/product-1/reactivate", "manager");
    expect(active.status).toBe(200); expect((active.json as { product: { active: boolean } }).product.active).toBe(true);
  });
});