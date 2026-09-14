import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mirror = vi.hoisted(() => vi.fn());
vi.mock("../lib/admin-audit", async (original) => {
  const actual = await original<typeof import("../lib/admin-audit")>();
  return { ...actual, recordAdminAuditEvent: vi.fn(async () => undefined) };
});
vi.mock("../billing/auth", () => ({
  viewerOfficeRole: (scope: { officeRole: string; canManage: boolean }) => ({ office_role: scope.officeRole, can_manage: scope.canManage }),
  requireOfficeBillingScope: vi.fn(async (req, res) => {
    const token = String(req.headers.authorization ?? "");
    if (!token) { res.status(401).json({ error: "Sign in to continue." }); return null; }
    if (token === "Bearer staff") { res.status(403).json({ error: "Only office owners and admins can manage payments." }); return null; }
    return { providerId: "office-1", officeName: "Harbor", actorUserId: "user-1", isHq: false, officeRole: "owner", canManage: true };
  }),
}));
vi.mock("../billing/prices", async (original) => {
  const actual = await original<typeof import("../billing/prices")>();
  return {
    ...actual,
    setOfficePrice: vi.fn(async (_provider: string, product: string, input: { sell_price_cents: number | null }) => {
      if ((input.sell_price_cents ?? 0) < 3767) throw new actual.BillingPriceError("Price must be at least 3767 cents.", 400, "sell_price_cents");
      mirror(product, input.sell_price_cents);
      return { product: { product_id: product, sell_price_cents: input.sell_price_cents, offered: true } };
    }),
  };
});
vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.STRIPE_CONNECT_CLIENT_ID = "ca_test";
  process.env.BILLING_PUBLIC_ORIGIN = "https://billing.example";
});
import router from "./billing-office";
import { __setCredentialsForTests } from "../billing/stripe-client";
import { recordAdminAuditEvent } from "../lib/admin-audit";

const originalFetch = global.fetch;
let server: http.Server;
let base = "";
let connected = false;
const account = {
  provider_id: "office-1", stripe_account_id: "acct_1", origin: "oauth", dashboard_type: "full",
  charges_enabled: true, payouts_enabled: true, details_submitted: true,
  requirements: { currently_due: [], past_due: [], eventually_due: [], disabled_reason: null, current_deadline: null },
  capabilities: {}, default_currency: "usd", business_name: "Harbor", email: "office@example.com",
  tax_enabled: false, tax_last_checked_at: null, oauth_refresh_token: null, livemode: false,
  last_synced_at: new Date().toISOString(), disconnected_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await originalFetch(`${base}${path}`, {
    method, redirect: "manual", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null), location: res.headers.get("location") };
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(router);
  server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  global.fetch = originalFetch; __setCredentialsForTests(null);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
  connected = false; mirror.mockClear();
  __setCredentialsForTests({ secret: "sk_test_fake", publishable: "pk_test_fake", account_id: "acct_platform" });
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/rest/v1/billing_connected_accounts") return response(connected ? [account] : []);
    if (url.pathname === "/rest/v1/billing_office_prices") return response([]);
    if (url.pathname === "/rest/v1/billing_payment_links") return response([]);
    if (url.pathname === "/rest/v1/providers") return response([{
      provider_id: "office-1", provider_name: "Dr. Reyes", office_name: "Harbor", email: "office@example.com",
      phone: null, address_line_1: "1 Main", address_line_2: null, city: "Austin", state: "TX", postal_code: "78701",
    }]);
    throw new Error(`unexpected ${url.pathname}`);
  }) as typeof fetch;
});
describe("billing office routes", () => {
  it("requires a session and refuses staff", async () => {
    expect((await call("GET", "/billing/office/status")).status).toBe(401);
    expect((await call("GET", "/billing/office/status", "staff")).status).toBe(403);
  });
  it("returns the complete status shape with and without an account", async () => {
    const empty = await call("GET", "/billing/office/status", "owner");
    expect(empty.json).toMatchObject({ account: null, offered_products: 0, links: 0, sandbox: true, oauth_available: true,
      viewer: { office_role: "owner", can_manage: true }, office: { provider_id: "office-1", office_name: "Harbor" } });
    connected = true;
    const present = await call("GET", "/billing/office/status", "owner");
    expect((present.json as { account: Record<string, unknown> }).account).toMatchObject({ stripe_account_id: "acct_1", charges_enabled: true });
  });
  it("rejects a below-minimum price and persists and mirrors a valid one", async () => {
    const low = await call("PUT", "/billing/office/prices/product-1", "owner", { sell_price_cents: 3766, subscription_enabled: true });
    expect(low.status).toBe(400); expect((low.json as { field: string }).field).toBe("sell_price_cents");
    const valid = await call("PUT", "/billing/office/prices/product-1", "owner", { sell_price_cents: 3767, subscription_enabled: true });
    expect(valid.status).toBe(200); expect(mirror).toHaveBeenCalledWith("product-1", 3767);
    expect(recordAdminAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "billing_prices_updated", providerId: "office-1",
      metadata: { product_id: "product-1", products_changed: 1 },
    }));
  });
  it("signs OAuth state and rejects a tampered callback state", async () => {
    const started = await call("GET", "/billing/office/connect/oauth/start", "owner");
    expect(started.status).toBe(200);
    const url = new URL((started.json as { url: string }).url);
    expect(url.origin).toBe("https://connect.stripe.com");
    const state = url.searchParams.get("state")!;
    expect(state.split(".")).toHaveLength(2);
    const callback = await call("GET", `/billing/oauth/callback?code=x&state=${encodeURIComponent(`${state}x`)}`);
    expect(callback.status).toBe(302);
    expect(callback.location).toContain("error=");
  });
  it("returns 409 and the unsupported account-session components", async () => {
    const result = await call("POST", "/billing/office/connect/account-session", "owner", { components: ["secrets"] });
    expect(result.status).toBe(409); expect((result.json as { unsupported: string[] }).unsupported).toEqual(["secrets"]);
  });
});