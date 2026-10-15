/**
 * Office kind through the HQ provider-account routes: Add Account defaults to
 * a THINNR reseller unless HQ says software, an unknown value is refused
 * before anything is written, the list/detail carry the kind, and an edit
 * leaves the kind alone unless the form sends one.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ admin: vi.fn(), send: vi.fn(), audit: vi.fn(), identitySync: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: m.admin }));
vi.mock("../claim/delivery", () => ({ sendProviderClaimInvitation: m.send }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: m.audit }));
vi.mock("../billing/office-access/customer-identity", () => ({ queueOfficeStripeIdentitySync: m.identitySync }));
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: () => (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.staff = { userId: "hq-admin", departmentRole: "super_admin" };
    next();
  },
}));
import router from "./provider-accounts";

let server: http.Server;
let base = "";
let providers: Record<string, unknown>[];
let rpcCalls: Array<{ fn: string; body: Record<string, unknown> }>;

const FORM = {
  officeName: "Harbor Wellness", providerName: "Avery Owner", providerRole: "MD", email: "owner@example.test",
  phone: "(555) 010-2000", address1: "1 Main St", address2: "", city: "Austin", state: "TX", postalCode: "78701", plan: "Core",
};

function providerRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    provider_id: "11111", provider_name: "Avery Owner", office_name: "Harbor Wellness", provider_role: "MD",
    email: "owner@example.test", phone: "5550102000", address_line_1: "1 Main St", address_line_2: null,
    city: "Austin", state: "TX", postal_code: "78701", plan: "Core", onboarding_code: "731942",
    auth_user_id: null, access_disabled: false, offboarding_status: "active", app_review: false,
    created_at: "2026-10-01T00:00:00.000Z", ...overrides,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPERATIONS_APP_URL", "https://ops.example.test/");
  providers = [providerRow({}), providerRow({ provider_id: "22222", office_name: "Soft Practice", office_kind: "software", onboarding_code: "246810" })];
  rpcCalls = [];
  m.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
    if (path.startsWith("/rest/v1/rpc/")) {
      const fn = path.slice("/rest/v1/rpc/".length);
      rpcCalls.push({ fn, body: body ?? {} });
      if (fn === "hq_create_provider_account") {
        const kind = body?.p_office_kind;
        if (kind !== "reseller" && kind !== "software") return { status: 400, json: { message: "Choose a valid office type." } };
        const row = providerRow({ provider_id: "33333", office_kind: kind, onboarding_code: "135790" });
        providers.push(row);
        return { status: 200, json: [row] };
      }
      if (fn === "hq_update_provider_account") {
        const row = providers.find((item) => item.provider_id === body?.p_provider_id);
        if (!row) return { status: 404, json: null };
        if (body?.p_office_kind !== null && body?.p_office_kind !== undefined) row.office_kind = body.p_office_kind;
        return { status: 200, json: [row] };
      }
      return { status: 404, json: null };
    }
    if (path.startsWith("/rest/v1/providers?")) return { status: 200, json: providers };
    if (path.startsWith("/rest/v1/patients?") || path.startsWith("/rest/v1/team_members?") || path.startsWith("/rest/v1/provider_account_locks?")) {
      return { status: 200, json: [] };
    }
    return { status: 500, json: null };
  });
  m.send.mockResolvedValue(undefined);
  m.audit.mockResolvedValue(undefined);
});

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
};

describe("office kind on the HQ provider-account routes", () => {
  it("lists and details the kind, reading legacy rows (no column value) as resellers", async () => {
    const list = await call("GET", "/provider-accounts");
    expect(list.status).toBe(200);
    expect(list.json.accounts.map((account: any) => [account.id, account.officeKind])).toEqual([["11111", "reseller"], ["22222", "software"]]);
    const detail = await call("GET", "/provider-accounts/22222");
    expect(detail.json.account).toMatchObject({ id: "22222", officeKind: "software", plan: "Core" });
  });

  it("creates a THINNR reseller unless HQ chose software", async () => {
    const reseller = await call("POST", "/provider-accounts", FORM);
    expect(reseller.status).toBe(201);
    expect(rpcCalls[0]).toMatchObject({ fn: "hq_create_provider_account", body: { p_office_kind: "reseller", p_plan: "Core" } });
    expect(reseller.json.account.officeKind).toBe("reseller");

    const software = await call("POST", "/provider-accounts", { ...FORM, email: "soft@example.test", officeKind: "software" });
    expect(software.status).toBe(201);
    expect(rpcCalls[1].body.p_office_kind).toBe("software");
    expect(software.json.account.officeKind).toBe("software");
    // The office still gets the same welcome email as a reseller.
    expect(m.send).toHaveBeenCalledTimes(2);
  });

  it("refuses an unknown office type at the form, before any write", async () => {
    const response = await call("POST", "/provider-accounts", { ...FORM, officeKind: "enterprise" });
    expect(response.status).toBe(400);
    expect(response.json.field).toBe("officeKind");
    expect(rpcCalls).toEqual([]);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("edits leave the kind alone unless the form sends one, and HQ can switch it either way", async () => {
    const untouched = await call("PATCH", "/provider-accounts/22222", FORM);
    expect(untouched.status).toBe(200);
    expect(rpcCalls[0].body.p_office_kind).toBeNull();
    expect(untouched.json.account.officeKind).toBe("software");

    const toReseller = await call("PATCH", "/provider-accounts/22222", { ...FORM, officeKind: "reseller" });
    expect(toReseller.json.account.officeKind).toBe("reseller");
    const toSoftware = await call("PATCH", "/provider-accounts/11111", { ...FORM, officeKind: "software" });
    expect(toSoftware.json.account.officeKind).toBe("software");
    expect(m.audit).toHaveBeenCalledTimes(3);
  });
});
