import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.permissions";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  process.env.SESSION_SECRET = "permissions-test-secret";
  process.env.BILLING_PUBLIC_ORIGIN = "https://billing.example";
});
const permissionMocks = vi.hoisted(() => ({
  created: [] as Array<{ permission: string; middleware: unknown }>,
}));
vi.mock("../lib/staff-auth", async () => {
  const actual = await vi.importActual<typeof import("../lib/staff-auth")>("../lib/staff-auth");
  return {
    ...actual,
    requireHqPermission(permission: Parameters<typeof actual.requireHqPermission>[0]) {
      const middleware = actual.requireHqPermission(permission);
      Object.defineProperty(middleware, "__hqPermission", { value: permission });
      permissionMocks.created.push({ permission, middleware });
      return middleware;
    },
  };
});
import hq from "./billing-hq";
import hqOrders from "./billing-hq-orders";
import office from "./billing-office";
import officeOrders from "./billing-office-orders";
import publicBilling from "./billing-public";

type Access = "public" | "office-read" | "office-write" | "hq-read" | "hq-provider-write" | "hq-settings-write";
type Identity = "anonymous" | "patient" | "staff" | "admin" | "owner" | "other-office" | "hq-none" | "hq-read" | "hq-provider";
type Outcome = "allowed" | 401 | 403 | "403-or-404";

const ROUTES: Record<string, Access> = {
  "GET /billing/public/config": "public",
  "GET /billing/public/product-images/:imageId": "public",
  "GET /billing/public/links/:token": "public",
  "POST /billing/public/links/:token/orders": "public",
  "GET /billing/public/orders/:id/status": "public",
  "GET /billing/public/subscriptions/:cancel_token": "public",
  "POST /billing/public/subscriptions/:cancel_token/cancel": "public",
  "GET /billing/oauth/callback": "public",
  "GET /billing/office/status": "office-read",
  "GET /billing/office/prices": "office-read",
  "GET /billing/office/links": "office-read",
  "GET /billing/office/patients/search": "office-read",
  "GET /billing/office/patients/:patientId/summary": "office-read",
  "GET /billing/office/dashboard": "office-read",
  "GET /billing/office/overview/today": "office-read",
  "GET /billing/office/activity": "office-read",
  "GET /billing/office/refunds": "office-read",
  "GET /billing/office/fulfillment": "office-read",
  "GET /billing/office/orders": "office-read",
  "GET /billing/office/orders/:id": "office-read",
  "GET /billing/office/subscriptions": "office-read",
  "GET /billing/office/subscriptions/:id/change-quote": "office-read",
  "GET /billing/office/payouts": "office-read",
  "GET /billing/office/connect/oauth/start": "office-write",
  "POST /billing/office/connect/create": "office-write",
  "POST /billing/office/connect/account-session": "office-write",
  "POST /billing/office/connect/sync": "office-write",
  "PUT /billing/office/prices/:product_id": "office-write",
  "POST /billing/office/links": "office-write",
  "PATCH /billing/office/links/:id": "office-write",
  "DELETE /billing/office/links/:id": "office-write",
  "POST /billing/office/orders/:id/refund": "office-write",
  "POST /billing/office/subscriptions/:id/cancel": "office-write",
  "POST /billing/office/subscriptions/:id/pause": "office-write",
  "POST /billing/office/subscriptions/:id/resume": "office-write",
  "POST /billing/office/subscriptions/:id/change": "office-write",
  "POST /billing/office/subscriptions/:id/retry-payment": "office-write",
  "POST /billing/office/subscriptions/:id/resend-payment-email": "office-write",
  "GET /billing/hq/health": "hq-read",
  "GET /billing/hq/catalog": "hq-read",
  "GET /billing/hq/catalog/products/:id": "hq-read",
  "GET /billing/hq/catalog/changes": "hq-read",
  "GET /billing/hq/providers": "hq-read",
  "GET /billing/hq/providers/:provider_id": "hq-read",
  "PUT /billing/hq/providers/:provider_id/stripe-customer-emails": "hq-provider-write",
  "GET /billing/hq/overview": "hq-read",
  "GET /billing/hq/overview/today": "hq-read",
  "GET /billing/hq/activity": "hq-read",
  "GET /billing/hq/transactions": "hq-read",
  "GET /billing/hq/transactions/:id": "hq-read",
  "GET /billing/hq/fulfillment": "hq-read",
  "GET /billing/hq/subscriptions": "hq-read",
  "GET /billing/hq/subscriptions/:id/change-quote": "hq-read",
  "POST /billing/hq/transactions/:id/refund": "hq-provider-write",
  "PUT /billing/hq/fulfillment/:order_id": "hq-provider-write",
  "POST /billing/hq/subscriptions/:id/cancel": "hq-provider-write",
  "POST /billing/hq/subscriptions/:id/pause": "hq-provider-write",
  "POST /billing/hq/subscriptions/:id/resume": "hq-provider-write",
  "POST /billing/hq/subscriptions/:id/change": "hq-provider-write",
  "POST /billing/hq/subscriptions/:id/retry-payment": "hq-provider-write",
  "POST /billing/hq/subscriptions/:id/resend-payment-email": "hq-provider-write",
  "POST /billing/hq/catalog/products": "hq-settings-write",
  "PUT /billing/hq/catalog/products/:id": "hq-settings-write",
  "PUT /billing/hq/catalog/order": "hq-settings-write",
  "POST /billing/hq/catalog/products/:id/status": "hq-settings-write",
  "POST /billing/hq/catalog/products/:id/images/upload-url": "hq-settings-write",
  "POST /billing/hq/catalog/products/:id/images": "hq-settings-write",
  "DELETE /billing/hq/catalog/products/:id/images/:imageId": "hq-settings-write",
  "POST /billing/hq/catalog/products/:id/images/:imageId/default": "hq-settings-write",
  "POST /billing/hq/catalog/products/:id/retire": "hq-settings-write",
  "POST /billing/hq/catalog/products/:id/reactivate": "hq-settings-write",
  "PUT /billing/hq/catalog/settings": "hq-settings-write",
};

const EXPECTED_HQ_PERMISSIONS: Record<string, "financial_read" | "provider_manage" | "settings_manage"> = {
  "GET /billing/hq/health": "financial_read",
  "GET /billing/hq/catalog": "financial_read",
  "GET /billing/hq/catalog/products/:id": "financial_read",
  "GET /billing/hq/catalog/changes": "financial_read",
  "GET /billing/hq/providers": "financial_read",
  "GET /billing/hq/providers/:provider_id": "financial_read",
  "PUT /billing/hq/providers/:provider_id/stripe-customer-emails": "provider_manage",
  "GET /billing/hq/overview": "financial_read",
  "GET /billing/hq/overview/today": "financial_read",
  "GET /billing/hq/activity": "financial_read",
  "GET /billing/hq/transactions": "financial_read",
  "GET /billing/hq/transactions/:id": "financial_read",
  "GET /billing/hq/fulfillment": "financial_read",
  "GET /billing/hq/subscriptions": "financial_read",
  "GET /billing/hq/subscriptions/:id/change-quote": "financial_read",
  "POST /billing/hq/transactions/:id/refund": "provider_manage",
  "PUT /billing/hq/fulfillment/:order_id": "provider_manage",
  "POST /billing/hq/subscriptions/:id/cancel": "provider_manage",
  "POST /billing/hq/subscriptions/:id/pause": "provider_manage",
  "POST /billing/hq/subscriptions/:id/resume": "provider_manage",
  "POST /billing/hq/subscriptions/:id/change": "provider_manage",
  "POST /billing/hq/subscriptions/:id/retry-payment": "provider_manage",
  "POST /billing/hq/subscriptions/:id/resend-payment-email": "provider_manage",
  "POST /billing/hq/catalog/products": "settings_manage",
  "PUT /billing/hq/catalog/products/:id": "settings_manage",
  "PUT /billing/hq/catalog/order": "settings_manage",
  "POST /billing/hq/catalog/products/:id/status": "settings_manage",
  "POST /billing/hq/catalog/products/:id/images/upload-url": "settings_manage",
  "POST /billing/hq/catalog/products/:id/images": "settings_manage",
  "DELETE /billing/hq/catalog/products/:id/images/:imageId": "settings_manage",
  "POST /billing/hq/catalog/products/:id/images/:imageId/default": "settings_manage",
  "POST /billing/hq/catalog/products/:id/retire": "settings_manage",
  "POST /billing/hq/catalog/products/:id/reactivate": "settings_manage",
  "PUT /billing/hq/catalog/settings": "settings_manage",
};

const MATRIX: Record<Access, Record<Identity, Outcome>> = {
  public: { anonymous: "allowed", patient: "allowed", staff: "allowed", admin: "allowed", owner: "allowed", "other-office": "allowed", "hq-none": "allowed", "hq-read": "allowed", "hq-provider": "allowed" },
  // The current shared office resolver intentionally limits the whole Payments area to owners/admins.
  // Office identities cannot widen scope with ?office=. An owner of B is allowed through, but still resolves to B.
  // HQ drill-in is an intentional production feature and is authorized by financial_read/provider_manage.
  "office-read": { anonymous: 401, patient: 403, staff: 403, admin: "allowed", owner: "allowed", "other-office": "allowed", "hq-none": 403, "hq-read": "allowed", "hq-provider": "allowed" },
  "office-write": { anonymous: 401, patient: 403, staff: 403, admin: "allowed", owner: "allowed", "other-office": "allowed", "hq-none": 403, "hq-read": "allowed", "hq-provider": "allowed" },
  // requireHqPermission deliberately returns 401 when a live token is not an active HQ identity.
  "hq-read": { anonymous: 401, patient: 401, staff: 401, admin: 401, owner: 401, "other-office": 401, "hq-none": 403, "hq-read": "allowed", "hq-provider": "allowed" },
  "hq-provider-write": { anonymous: 401, patient: 401, staff: 401, admin: 401, owner: 401, "other-office": 401, "hq-none": 403, "hq-read": "allowed", "hq-provider": "allowed" },
  // The fixed production department-role map gives an HQ admin all three billing permissions.
  "hq-settings-write": { anonymous: 401, patient: 401, staff: 401, admin: 401, owner: 401, "other-office": 401, "hq-none": 403, "hq-read": "allowed", "hq-provider": "allowed" },
};

const identities: Identity[] = ["anonymous", "patient", "staff", "admin", "owner", "other-office", "hq-none", "hq-read", "hq-provider"];
const userByToken: Partial<Record<Identity, string>> = {
  patient: "user-patient", staff: "user-staff", admin: "user-admin", owner: "user-owner-a",
  "other-office": "user-owner-b", "hq-none": "user-hq-none", "hq-read": "user-hq-read", "hq-provider": "user-hq-provider",
};
const OFFICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OFFICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROW_ID = "11111111-1111-4111-8111-111111111111";
const originalFetch = global.fetch;
let server: http.Server;
let base = "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function officeRow(id: string, authUserId: string | null = null) {
  return { provider_id: id, provider_name: `Provider ${id === OFFICE_A ? "A" : "B"}`, office_name: `Office ${id === OFFICE_A ? "A" : "B"}`,
    onboarding_code: null, access_disabled: false, auth_user_id: authUserId, email: "office@example.test", phone: null };
}

function serviceRows(url: URL): unknown[] {
  const table = url.pathname.split("/").at(-1);
  if (table === "provider_account_locks" || table === "profiles") return [];
  if (table === "hq_memberships") {
    const user = url.searchParams.get("auth_user_id")?.replace("eq.", "");
    if (user === "user-hq-none") return [{ department_role: "clinical", status: "active" }];
    if (user === "user-hq-read" || user === "user-hq-provider") return [{ department_role: "admin", status: "active" }];
    return [];
  }
  if (table === "providers") {
    const authUser = url.searchParams.get("auth_user_id")?.replace("eq.", "");
    if (authUser === "user-owner-a") return [officeRow(OFFICE_A, authUser)];
    if (authUser === "user-owner-b") return [officeRow(OFFICE_B, authUser)];
    const providerId = url.searchParams.get("provider_id")?.replace("eq.", "");
    if (providerId === OFFICE_A) return [officeRow(OFFICE_A)];
    if (providerId === OFFICE_B) return [officeRow(OFFICE_B)];
    return [];
  }
  if (table === "team_members") {
    const user = url.searchParams.get("auth_user_id")?.replace("eq.", "");
    if (user === "user-staff") return [{ id: "member-staff", provider_id: OFFICE_A, activation_status: "active", office_role: "staff" }];
    if (user === "user-admin") return [{ id: "member-admin", provider_id: OFFICE_A, activation_status: "active", office_role: "admin" }];
    return [];
  }
  return [];
}

function bodyFor(route: string): unknown {
  if (route === "POST /billing/public/links/:token/orders") return {
    items: [{ product_id: ROW_ID, quantity: 1 }],
    payer: { name: "Test Payer", email: "payer@example.test", phone: "" },
    shipping_address: { name: "Test Payer", line1: "1 Main St", line2: null, city: "Austin", state: "TX", postal_code: "78701", country: "US", phone: null },
    purchase: "one_time",
  };
  if (route.endsWith("/refund")) return { amount_cents: 100, reason: "Patient request" };
  if (route.endsWith("/cancel")) return { at_period_end: true };
  if (route.endsWith("/change")) return { product_id: ROW_ID };
  if (route.includes("/fulfillment/:order_id")) return { status: "to_ship" };
  if (route.endsWith("/connect/account-session")) return { components: ["payments"] };
  if (route.includes("/prices/:product_id")) return { sell_price_cents: 5000, subscription_enabled: false };
  if (route === "POST /billing/hq/catalog/products") return { name: "Test", floor_price_cents: 1000, hard_cost_cents: 100 };
  if (route === "PUT /billing/hq/catalog/products/:id") return { floor_price_cents: 1000 };
  if (route === "PUT /billing/hq/catalog/order") return { ids: [ROW_ID] };
  if (route.endsWith("/:id/status")) return { status: "active" };
  if (route.endsWith("/images/upload-url")) return { content_type: "image/png", size: 100 };
  if (route.endsWith("/:id/images")) return { image_id: ROW_ID, object_path: `/objects/product-images/${ROW_ID}/${ROW_ID}`, content_type: "image/png", size: 100 };
  if (route.endsWith("/catalog/settings")) return { shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, expected_version: 1 };
  return {};
}

function concretePath(pattern: string, access: Access): string {
  let path = pattern.replace(/:cancel_token|:token/g, "test-token").replace(/:provider_id/g, OFFICE_A)
    .replace(/:product_id|:order_id|:patientId|:imageId|:id/g, ROW_ID);
  if ((access === "office-read" || access === "office-write") && !path.includes("?")) path += `?office=${OFFICE_A}`;
  if (pattern.endsWith("/change-quote")) path += `${path.includes("?") ? "&" : "?"}product_id=${ROW_ID}`;
  return path;
}

async function request(route: string, access: Access, identity: Identity): Promise<number> {
  const [method, pattern] = route.split(" ", 2);
  const token = identity === "anonymous" ? null : identity;
  const response = await originalFetch(`${base}${concretePath(pattern, access)}`, {
    method,
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(bodyFor(route)),
  });
  return response.status;
}

function inventory(): string[] {
  const routers = [hq, hqOrders, office, officeOrders, publicBilling] as Array<{ stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }>;
  return routers.flatMap((router) => router.stack.flatMap((layer) => {
    if (!layer.route) return [];
    return Object.keys(layer.route.methods).filter((method) => layer.route!.methods[method]).map((method) => `${method.toUpperCase()} ${layer.route!.path}`);
  })).sort();
}

function hqPermissionInventory(): Record<string, string> {
  type RouteLayer = {
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: { __hqPermission?: string } }>;
    };
  };
  const routers = [hq, hqOrders] as Array<{ stack: RouteLayer[] }>;
  return Object.fromEntries(routers.flatMap((router) => router.stack.flatMap((layer) => {
    if (!layer.route) return [];
    const permission = layer.route.stack
      .map((handler) => handler.handle.__hqPermission)
      .filter((value): value is string => Boolean(value));
    return Object.keys(layer.route.methods)
      .filter((method) => layer.route!.methods[method])
      .map((method) => [`${method.toUpperCase()} ${layer.route!.path}`, permission.join(",")]);
  })));
}

beforeAll(async () => {
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== "http://supabase.permissions") return json({ error: "not configured" }, 404);
    if (url.pathname === "/auth/v1/user") {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const token = headers.get("authorization")?.replace("Bearer ", "") as Identity | undefined;
      const userId = token ? userByToken[token] : undefined;
      return userId ? json({ id: userId, email: `${token}@example.test` }) : json({ error: "invalid token" }, 401);
    }
    return json(serviceRows(url));
  }) as typeof fetch;
  const app = express();
  app.use(express.json());
  app.use(hq, hqOrders, office, officeOrders, publicBilling);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("billing route permission matrix", () => {
  it("classifies every real route and rejects stale table entries", () => {
    expect(inventory()).toEqual(Object.keys(ROUTES).sort());
  });

  it("enforces the explicit outcome for every identity on every real route", async () => {
    for (const [route, access] of Object.entries(ROUTES)) {
      for (const identity of identities) {
        const expected = MATRIX[access][identity];
        expect(expected, `${route} has no ${identity} outcome`).toBeDefined();
        const status = await request(route, access, identity);
        if (expected === "allowed") {
          expect([401, 403], `${identity} unexpectedly blocked from ${route} (${status})`).not.toContain(status);
        } else if (expected === "403-or-404") {
          expect([403, 404], `${identity} unexpectedly reached ${route} (${status})`).toContain(status);
        } else {
          expect(status, `${identity} received the wrong denial from ${route}`).toBe(expected);
        }
      }
    }
  });

  it("binds every HQ route to its exact named permission", () => {
    expect(permissionMocks.created).toHaveLength(Object.keys(EXPECTED_HQ_PERMISSIONS).length);
    expect(hqPermissionInventory()).toEqual(EXPECTED_HQ_PERMISSIONS);
  });
});
