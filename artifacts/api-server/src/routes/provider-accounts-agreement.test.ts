/**
 * The reseller agreement date through the HQ provider-account routes: Add
 * Account and the edit form carry it to the database RPCs (edit sends an
 * explicit "set" flag so an older form leaves the date alone and HQ can still
 * clear it), the list/detail return it, a malformed or future date is refused
 * before anything is written, and the office's included period is re-anchored
 * exactly when the date — or the kind, with a date on file — changes.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  admin: vi.fn(), send: vi.fn(), audit: vi.fn(), identitySync: vi.fn(), anchor: vi.fn(), anchored: vi.fn(),
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: m.admin }));
vi.mock("../claim/delivery", () => ({ sendProviderClaimInvitation: m.send }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: m.audit }));
vi.mock("../billing/office-access/customer-identity", () => ({ queueOfficeStripeIdentitySync: m.identitySync }));
vi.mock("../billing/office-access/agreement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/office-access/agreement")>()),
  anchorIncludedPeriodToAgreementForSelectedMode: m.anchor,
  agreementAnchorRecordedForSelectedMode: m.anchored,
}));
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
    office_kind: "reseller", reseller_agreement_signed_on: null,
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
  providers = [
    providerRow({}),
    providerRow({ provider_id: "22222", office_name: "Dated Reseller", reseller_agreement_signed_on: "2026-01-15", onboarding_code: "135791" }),
    providerRow({ provider_id: "33333", office_name: "Soft Practice", office_kind: "software", onboarding_code: "246810" }),
  ];
  rpcCalls = [];
  // By default the office's period is already on record as anchored to its date.
  m.anchored.mockResolvedValue(true);
  m.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
    if (path.startsWith("/rest/v1/rpc/")) {
      const fn = path.slice("/rest/v1/rpc/".length);
      rpcCalls.push({ fn, body: body ?? {} });
      if (fn === "hq_create_provider_account") {
        const row = providerRow({
          provider_id: "44444", office_kind: body?.p_office_kind, onboarding_code: "975310",
          reseller_agreement_signed_on: body?.p_reseller_agreement_signed_on ?? null,
        });
        providers.push(row);
        return { status: 200, json: [row] };
      }
      if (fn === "hq_update_provider_account") {
        const row = providers.find((item) => item.provider_id === body?.p_provider_id);
        if (!row) return { status: 404, json: null };
        if (body?.p_office_kind) row.office_kind = body.p_office_kind;
        if (body?.p_set_reseller_agreement === true) row.reseller_agreement_signed_on = body.p_reseller_agreement_signed_on ?? null;
        return { status: 200, json: [row] };
      }
      return { status: 404, json: null };
    }
    if (path.startsWith("/rest/v1/providers?provider_id=eq.")) {
      const id = decodeURIComponent(path.slice("/rest/v1/providers?provider_id=eq.".length).split("&")[0]);
      return { status: 200, json: providers.filter((row) => row.provider_id === id) };
    }
    if (path.startsWith("/rest/v1/providers?")) return { status: 200, json: providers };
    if (path.startsWith("/rest/v1/patients?") || path.startsWith("/rest/v1/team_members?") || path.startsWith("/rest/v1/provider_account_locks?")) {
      return { status: 200, json: [] };
    }
    return { status: 500, json: null };
  });
  m.send.mockResolvedValue(undefined);
  m.audit.mockResolvedValue(undefined);
  m.anchor.mockResolvedValue({});
});

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
};

describe("the reseller agreement date on the HQ provider-account routes", () => {
  it("lists and details the date, null where HQ never recorded one", async () => {
    const list = await call("GET", "/provider-accounts");
    expect(list.status).toBe(200);
    expect(list.json.accounts.map((account: any) => [account.id, account.resellerAgreementSignedOn]))
      .toEqual([["11111", null], ["22222", "2026-01-15"], ["33333", null]]);
    const detail = await call("GET", "/provider-accounts/22222");
    expect(detail.json.account).toMatchObject({ id: "22222", officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15" });
  });

  it("creates a reseller with its agreement date and anchors its included period right away", async () => {
    const created = await call("POST", "/provider-accounts", { ...FORM, resellerAgreementSignedOn: "2026-02-01" });
    expect(created.status).toBe(201);
    expect(rpcCalls[0]).toMatchObject({ fn: "hq_create_provider_account", body: { p_office_kind: "reseller", p_reseller_agreement_signed_on: "2026-02-01" } });
    expect(created.json.account.resellerAgreementSignedOn).toBe("2026-02-01");
    expect(m.anchor).toHaveBeenCalledTimes(1);
    expect(m.anchor.mock.calls[0][0]).toMatchObject({
      providerId: "44444", facts: { officeKind: "reseller", resellerAgreementSignedOn: "2026-02-01" }, actor: { kind: "hq", userId: "hq-admin" },
    });
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it("creates without a date (and a software office with one) without touching any period", async () => {
    const plain = await call("POST", "/provider-accounts", FORM);
    expect(plain.status).toBe(201);
    expect(rpcCalls[0].body.p_reseller_agreement_signed_on).toBeNull();
    expect(plain.json.account.resellerAgreementSignedOn).toBeNull();
    const software = await call("POST", "/provider-accounts", { ...FORM, email: "soft@example.test", officeKind: "software", resellerAgreementSignedOn: "2026-02-01" });
    expect(software.status).toBe(201);
    expect(m.anchor).not.toHaveBeenCalled();
  });

  it("still creates the account when the period cannot be anchored; the owner's first sign-in anchors it later", async () => {
    m.anchor.mockRejectedValueOnce(new Error("Payments mode is unavailable."));
    const created = await call("POST", "/provider-accounts", { ...FORM, resellerAgreementSignedOn: "2026-02-01" });
    expect(created.status).toBe(201);
    expect(created.json.account.resellerAgreementSignedOn).toBe("2026-02-01");
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed, impossible or future date at the form, before any write", async () => {
    for (const value of ["01/15/2026", "2026-02-30", "2026-01-15T00:00:00Z", "2999-01-01"]) {
      const response = await call("POST", "/provider-accounts", { ...FORM, resellerAgreementSignedOn: value });
      expect(response.status, value).toBe(400);
      expect(response.json.field).toBe("resellerAgreementSignedOn");
    }
    expect(rpcCalls).toEqual([]);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("edits leave the date alone unless the form sends it, and re-anchor the period only when it changes", async () => {
    const untouched = await call("PATCH", "/provider-accounts/22222", FORM);
    expect(untouched.status).toBe(200);
    expect(rpcCalls[0].body).toMatchObject({ p_set_reseller_agreement: false, p_reseller_agreement_signed_on: null });
    expect(untouched.json.account.resellerAgreementSignedOn).toBe("2026-01-15");
    expect(m.anchor).not.toHaveBeenCalled();

    // The same date again: saved, but the period HQ may have adjusted by hand
    // after the recorded anchoring is not re-anchored.
    const same = await call("PATCH", "/provider-accounts/22222", { ...FORM, resellerAgreementSignedOn: "2026-01-15" });
    expect(same.status).toBe(200);
    expect(rpcCalls[1].body).toMatchObject({ p_set_reseller_agreement: true, p_reseller_agreement_signed_on: "2026-01-15" });
    expect(m.anchored).toHaveBeenCalledWith({ providerId: "22222", resellerAgreementSignedOn: "2026-01-15" });
    expect(m.anchor).not.toHaveBeenCalled();

    const corrected = await call("PATCH", "/provider-accounts/22222", { ...FORM, resellerAgreementSignedOn: "2026-03-01" });
    expect(corrected.status).toBe(200);
    expect(corrected.json.account.resellerAgreementSignedOn).toBe("2026-03-01");
    expect(m.anchor).toHaveBeenCalledTimes(1);
    expect(m.anchor.mock.calls[0][0]).toMatchObject({ providerId: "22222", facts: { officeKind: "reseller", resellerAgreementSignedOn: "2026-03-01" } });

    // Clearing is an explicit null with the set flag, and re-anchors too (back to the first sign-in).
    const cleared = await call("PATCH", "/provider-accounts/22222", { ...FORM, resellerAgreementSignedOn: null });
    expect(cleared.status).toBe(200);
    expect(rpcCalls[3].body).toMatchObject({ p_set_reseller_agreement: true, p_reseller_agreement_signed_on: null });
    expect(cleared.json.account.resellerAgreementSignedOn).toBeNull();
    expect(m.anchor).toHaveBeenCalledTimes(2);
    expect(m.anchor.mock.calls[1][0].facts).toEqual({ officeKind: "reseller", resellerAgreementSignedOn: null });
  });

  it("anchors when a software office becomes a reseller with a date on file, never for a software office", async () => {
    const soft = await call("PATCH", "/provider-accounts/33333", { ...FORM, officeKind: "software", resellerAgreementSignedOn: "2026-01-15" });
    expect(soft.status).toBe(200);
    expect(m.anchor).not.toHaveBeenCalled();
    const flipped = await call("PATCH", "/provider-accounts/33333", { ...FORM, officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15" });
    expect(flipped.status).toBe(200);
    expect(flipped.json.account).toMatchObject({ officeKind: "reseller", resellerAgreementSignedOn: "2026-01-15" });
    expect(m.anchor).toHaveBeenCalledTimes(1);
  });

  it("reports an edit whose period could not be moved, and saving the same date again really retries", async () => {
    m.anchor.mockRejectedValueOnce(new Error("store refused"));
    const response = await call("PATCH", "/provider-accounts/22222", { ...FORM, resellerAgreementSignedOn: "2026-03-01" });
    expect(response.status).toBe(502);
    expect(response.json.error).toMatch(/Save the date again to retry/);

    // No anchoring for that date is on record, so the identical save anchors
    // (the same path heals a create whose anchoring was logged and skipped).
    m.anchored.mockResolvedValueOnce(false);
    const again = await call("PATCH", "/provider-accounts/22222", { ...FORM, resellerAgreementSignedOn: "2026-03-01" });
    expect(again.status).toBe(200);
    expect(m.anchor).toHaveBeenCalledTimes(2);
    expect(m.anchor.mock.calls[1][0].facts).toEqual({ officeKind: "reseller", resellerAgreementSignedOn: "2026-03-01" });

    // A form that leaves the date out never triggers the check or the anchor.
    m.anchored.mockClear();
    const untouched = await call("PATCH", "/provider-accounts/22222", FORM);
    expect(untouched.status).toBe(200);
    expect(m.anchored).not.toHaveBeenCalled();
    expect(m.anchor).toHaveBeenCalledTimes(2);

    // The history read itself failing is reported, not swallowed.
    m.anchored.mockRejectedValueOnce(new Error("store down"));
    const unchecked = await call("PATCH", "/provider-accounts/22222", { ...FORM, resellerAgreementSignedOn: "2026-03-01" });
    expect(unchecked.status).toBe(502);
    expect(unchecked.json.error).toMatch(/Save again to retry/);
  });
});
