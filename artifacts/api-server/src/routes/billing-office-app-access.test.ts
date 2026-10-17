/**
 * Office app-access settings routes: "Charge patients for AI features",
 * price + cadence, and the non-THINNR trial length.
 *
 * Pinned here: the defaults an office starts with (off, 7-day trial, 30%
 * THINNR share), the owner/admin matrix (staff read, never write), field
 * validation (Stripe's $0.50 floor, trial bounds, enabled needs a price),
 * optimistic versioning (409 on a stale version), that turning charging ON
 * mirrors a recurring price on the office's CONNECTED Stripe account before
 * the row is saved (and refuses without a charges-enabled account), and
 * that an edited price archives the old one and creates a replacement.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/admin-audit", async (original) => {
  const actual = await original<typeof import("../lib/admin-audit")>();
  return { ...actual, recordAdminAuditEvent: vi.fn(async () => undefined) };
});
vi.mock("../billing/auth", () => ({
  viewerOfficeRole: (scope: { officeRole: string; canManage: boolean }) => ({ office_role: scope.officeRole, can_manage: scope.canManage }),
  requireOfficeBillingScope: vi.fn(async (req, res, options: { write: boolean }) => {
    const manage = options.write;
    const token = String(req.headers.authorization ?? "");
    if (!token) { res.status(401).json({ error: "Sign in to continue." }); return null; }
    const staff = token === "Bearer staff";
    if (staff && manage) { res.status(403).json({ error: "Only office owners and admins can manage payments." }); return null; }
    return { providerId: "office-1", officeName: "Harbor", actorUserId: "user-1", isHq: false, officeRole: staff ? "staff" : "owner", canManage: !staff };
  }),
}));

const stripe = vi.hoisted(() => ({
  products: new Map<string, { id: string; name: string }>(),
  prices: new Map<string, { id: string; product: string; unit_amount: number; active: boolean; recurring: { interval: string; interval_count: number } }>(),
  accounts: [] as string[],
  seq: 0,
}));
vi.mock("../billing/stripe-client", async (original) => {
  const actual = await original<typeof import("../billing/stripe-client")>();
  const missing = (id: string) => Object.assign(new Error(`No such object: ${id}`), { code: "resource_missing", statusCode: 404 });
  const note = (opts?: { stripeAccount?: string }) => { if (opts?.stripeAccount) stripe.accounts.push(opts.stripeAccount); };
  const fake = {
    products: {
      retrieve: async (id: string, _p: unknown, opts?: { stripeAccount?: string }) => { note(opts); const p = stripe.products.get(id); if (!p) throw missing(id); return p; },
      create: async (params: { name: string }, opts?: { stripeAccount?: string }) => {
        note(opts); const p = { id: `prod_${++stripe.seq}`, name: params.name }; stripe.products.set(p.id, p); return p;
      },
    },
    prices: {
      retrieve: async (id: string, _p: unknown, opts?: { stripeAccount?: string }) => { note(opts); const p = stripe.prices.get(id); if (!p) throw missing(id); return p; },
      create: async (params: { product: string; unit_amount: number; recurring: { interval: string; interval_count: number } }, opts?: { stripeAccount?: string }) => {
        note(opts);
        const p = { id: `price_${++stripe.seq}`, product: params.product, unit_amount: params.unit_amount, active: true, recurring: params.recurring };
        stripe.prices.set(p.id, p); return p;
      },
      update: async (id: string, patch: { active?: boolean }, opts?: { stripeAccount?: string }) => {
        note(opts); const p = stripe.prices.get(id); if (!p) throw missing(id); Object.assign(p, patch); return p;
      },
    },
  };
  return {
    ...actual,
    getStripe: async () => fake,
    isStripeMissing: (error: unknown) => (error as { code?: string })?.code === "resource_missing",
  };
});
vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.BILLING_PUBLIC_ORIGIN = "https://billing.example";
  process.env.BILLING_DEPLOYMENT_ID = "deploy";
});
import router from "./billing-office";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { runWithBillingIdentity } from "../billing/stripe-environment";

type Row = Record<string, unknown>;
const originalFetch = global.fetch;
let server: http.Server;
let base = "";
let settings: Row | null = null;
let priceMirror: Row | null = null;
let chargesEnabled = true;
let catalogChanges: Row[] = [];

const account = () => ({
  provider_id: "office-1", stripe_account_id: "acct_office", disconnected_at: null, charges_enabled: chargesEnabled,
  payouts_enabled: chargesEnabled, details_submitted: true, livemode: false,
});

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function filterValue(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  return raw && raw.startsWith("eq.") ? raw.slice(3) : null;
}
async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await originalFetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Row | null };
}

beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((_req, _res, next) => runWithBillingIdentity({ mode: "test", platformAccountId: "acct_platform" }, next));
  app.use(router);
  server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
  settings = null; priceMirror = null; chargesEnabled = true; catalogChanges = [];
  stripe.products.clear(); stripe.prices.clear(); stripe.accounts = []; stripe.seq = 0;
  vi.mocked(recordAdminAuditEvent).mockClear();
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Row) : null;
    switch (url.pathname) {
      case "/rest/v1/billing_office_settings": {
        if (method === "GET") return response(settings ? [settings] : []);
        if (method === "POST") {
          if (settings) return response({ code: "23505", message: "duplicate key value violates unique constraint \"billing_office_settings_pkey\"" }, 409);
          settings = { ...body, updated_at: "2026-03-01T00:00:00Z" }; return response([settings]);
        }
        if (method === "PATCH") {
          const version = filterValue(url, "version");
          if (!settings || String(settings.version) !== version) return response([]);
          settings = { ...settings, ...body, updated_at: "2026-03-02T00:00:00Z" }; return response([settings]);
        }
        break;
      }
      case "/rest/v1/billing_app_access_prices": {
        if (method === "GET") return response(priceMirror ? [priceMirror] : []);
        if (method === "POST") { priceMirror = { ...body }; return response([priceMirror]); }
        if (method === "PATCH") { priceMirror = { ...priceMirror, ...body }; return response([priceMirror]); }
        break;
      }
      case "/rest/v1/billing_connected_accounts": return response([account()]);
      case "/rest/v1/billing_catalog_changes": catalogChanges.push(body!); return response([body], 201);
      case "/rest/v1/billing_mode_state": return response([{ mode: "test", version: 1, platform_account_id: "acct_platform" }]);
      default: break;
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
});

const ON = { enabled: true, price_cents: 699, cadence: "2_weeks", trial_days: 7, expected_version: 0 };

describe("office app-access settings", () => {
  it("starts off with a 7-day trial and the 30% THINNR share; staff can read but not write", async () => {
    expect((await call("GET", "/billing/office/app-access")).status).toBe(401);
    const read = await call("GET", "/billing/office/app-access", "staff");
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ enabled: false, price_cents: null, cadence: "monthly", trial_days: 7, version: 0, updated_at: null, thinnr_share_percent: 30 });
    expect((await call("PUT", "/billing/office/app-access", "staff", ON)).status).toBe(403);
    expect(settings).toBeNull();
  });

  it("validates the fields before touching Stripe or the row", async () => {
    const cases: Array<[Row, string]> = [
      [{ ...ON, price_cents: 49 }, "price_cents"],
      [{ ...ON, price_cents: null }, "price_cents"],
      [{ ...ON, trial_days: 366 }, "trial_days"],
      [{ ...ON, trial_days: -1 }, "trial_days"],
      [{ ...ON, cadence: "weekly" }, "cadence"],
      [{ ...ON, price_cents: 6.99 }, "price_cents"],
    ];
    for (const [body, field] of cases) {
      const res = await call("PUT", "/billing/office/app-access", "owner", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json?.field, JSON.stringify(body)).toBe(field);
    }
    expect(stripe.prices.size).toBe(0);
    expect(settings).toBeNull();
  });

  it("allows a price to be kept on file while charging is off, without a Stripe mirror", async () => {
    const res = await call("PUT", "/billing/office/app-access", "owner", { ...ON, enabled: false, price_cents: 10000, cadence: "monthly", trial_days: 14 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ enabled: false, price_cents: 10000, cadence: "monthly", trial_days: 14, version: 1 });
    expect(stripe.prices.size).toBe(0);
    expect(priceMirror).toBeNull();
  });

  it("refuses to charge until the office's Stripe account can take payments", async () => {
    chargesEnabled = false;
    const res = await call("PUT", "/billing/office/app-access", "owner", ON);
    expect(res.status).toBe(409);
    expect(res.json?.error).toMatch(/Connect Stripe/);
    expect(settings).toBeNull();
    expect(stripe.products.size).toBe(0);
  });

  it("turning charging on mirrors a recurring price on the connected account, then saves and audits", async () => {
    const res = await call("PUT", "/billing/office/app-access", "owner", ON);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ enabled: true, price_cents: 699, cadence: "2_weeks", trial_days: 7, version: 1, thinnr_share_percent: 30 });
    expect(settings).toMatchObject({ provider_id: "office-1", app_access_enabled: true, app_access_price_cents: 699, app_access_cadence: "2_weeks", app_access_trial_days: 7, version: 1, updated_by: "user-1" });
    const [price] = [...stripe.prices.values()];
    expect(price).toMatchObject({ unit_amount: 699, active: true, recurring: { interval: "week", interval_count: 2 } });
    expect(priceMirror).toMatchObject({ provider_id: "office-1", price_cents: 699, cadence: "2_weeks", stripe_price_id: price.id, stripe_product_id: price.product });
    // Every Stripe call rode the office's connected account, never the platform.
    expect(new Set(stripe.accounts)).toEqual(new Set(["acct_office"]));
    expect(catalogChanges).toHaveLength(1);
    expect(catalogChanges[0]).toMatchObject({ kind: "office_app_access_settings_updated", provider_id: "office-1", before: null, after: { enabled: true, price_cents: 699 } });
    expect(recordAdminAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "billing_office_app_access_updated", providerId: "office-1",
      metadata: { enabled: true, price_cents: 699, cadence: "2_weeks", trial_days: 7 },
    }));
  });

  it("rejects a stale version with 409 and leaves Stripe alone", async () => {
    expect((await call("PUT", "/billing/office/app-access", "owner", ON)).status).toBe(200);
    const stale = await call("PUT", "/billing/office/app-access", "owner", { ...ON, price_cents: 999 });
    expect(stale.status).toBe(409);
    expect(settings?.app_access_price_cents).toBe(699);
    expect(stripe.prices.size).toBe(1);
  });

  it("a changed price or cadence archives the old Stripe price and points the mirror at a new one", async () => {
    expect((await call("PUT", "/billing/office/app-access", "owner", ON)).status).toBe(200);
    const first = priceMirror!.stripe_price_id as string;
    const product = priceMirror!.stripe_product_id as string;
    // Same amount + cadence: nothing new is created.
    expect((await call("PUT", "/billing/office/app-access", "owner", { ...ON, trial_days: 10, expected_version: 1 })).status).toBe(200);
    expect(priceMirror!.stripe_price_id).toBe(first);
    expect(stripe.prices.size).toBe(1);
    // New amount, monthly: a replacement price on the same product; the old one is archived, never deleted.
    const changed = await call("PUT", "/billing/office/app-access", "owner", { ...ON, price_cents: 10000, cadence: "monthly", expected_version: 2 });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ price_cents: 10000, cadence: "monthly", version: 3 });
    const second = priceMirror!.stripe_price_id as string;
    expect(second).not.toBe(first);
    expect(priceMirror!.stripe_product_id).toBe(product);
    expect(stripe.prices.get(first)).toMatchObject({ active: false });
    expect(stripe.prices.get(second)).toMatchObject({ active: true, unit_amount: 10000, recurring: { interval: "month", interval_count: 1 } });
  });

  it("recreates the mirror when the office's account no longer has the objects", async () => {
    expect((await call("PUT", "/billing/office/app-access", "owner", ON)).status).toBe(200);
    stripe.products.clear(); stripe.prices.clear();
    const res = await call("PUT", "/billing/office/app-access", "owner", { ...ON, expected_version: 1 });
    expect(res.status).toBe(200);
    expect(stripe.products.size).toBe(1);
    expect(stripe.prices.size).toBe(1);
    expect(priceMirror!.stripe_price_id).toBe([...stripe.prices.keys()][0]);
  });
});
