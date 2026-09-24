/**
 * The narrowed surface, enforced once at the shared office scope resolver.
 *
 * Every office-scoped route inherits the policy from here, so this suite is
 * the server-side boundary proof: what a restricted office may still call,
 * what it may not, that the answer never depends on the staffer's role (any
 * staff member can pay), that HQ is never narrowed by an office's billing,
 * and that the older lock / offboarding states are untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  identify: vi.fn(),
  locked: vi.fn(),
  restricted: vi.fn(),
  audit: vi.fn(),
  staffIdentity: vi.fn(),
}));

vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("./identify", () => ({ identifyBearer: mocks.identify }));
vi.mock("./directory", () => ({ providerLocked: mocks.locked }));
vi.mock("../lib/admin-audit", () => ({ recordAccessDenied: mocks.audit }));
vi.mock("../practice-launch/state", () => ({
  isLaunchAllowedPath: () => true,
  readLaunch: vi.fn(async () => null),
  operationalLaunchComplete: vi.fn(async () => true),
}));
vi.mock("../lib/staff-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/staff-auth")>()),
  staffIdentityForUser: mocks.staffIdentity,
}));
vi.mock("../lib/office-restriction", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/office-restriction")>()),
  officeRestrictedForNonpayment: mocks.restricted,
}));

import { resolveOfficeScope } from "./office-scope";

const OFFICE = {
  provider_id: "office-1",
  provider_name: "Beacon Hill",
  office_name: "Beacon Hill Aesthetics",
  onboarding_code: "123456",
  access_disabled: false,
  offboarding_status: null,
};

/** Who is calling: the owner's own provider row, or a teammate in any role. */
type Caller = "owner" | "admin" | "staff";

function rows(caller: Caller) {
  return (path: string) => {
    if (path.startsWith("/rest/v1/providers")) {
      return caller === "owner" ? [OFFICE] : path.includes("provider_id=eq.") ? [OFFICE] : [];
    }
    if (path.startsWith("/rest/v1/team_members")) {
      return caller === "owner"
        ? []
        : [{ id: "tm-1", provider_id: "office-1", activation_status: "activated", office_role: caller }];
    }
    return [];
  };
}

async function resolve(url: string, caller: Caller = "owner") {
  const table = rows(caller);
  mocks.admin.mockImplementation(async (_method: string, path: string) => ({ status: 200, json: table(path) }));
  return resolveOfficeScope({
    authorization: "Bearer token",
    hqPermission: "provider_manage",
    requireUnlocked: false,
    request: { method: "GET", url, originalUrl: url, headers: {} } as never,
  });
}

const ALLOWED = [
  "/api/office/access",
  "/api/office/access/pay",
  "/api/billing/office/status",
  "/api/billing/office/connect",
  "/api/billing/office/payouts",
  "/api/billing/office/subscriptions",
  "/api/billing/office/subscriptions/sub-1/cancel",
  "/api/exports",
  "/api/exports/job-1/download?part=1",
];

const BLOCKED = [
  "/api/office/roster",
  "/api/office/roster/invitations",
  "/api/staff/conversations",
  "/api/office/team",
  "/api/office/settings",
  "/api/operational-rollups",
  "/api/billing/office/orders",
  "/api/billing/office/sales",
  "/api/office/alerts",
  "/api/office/files",
];

beforeEach(() => {
  mocks.identify.mockReset().mockResolvedValue({ id: "user-1" });
  mocks.locked.mockReset().mockResolvedValue(false);
  mocks.restricted.mockReset().mockResolvedValue(false);
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.staffIdentity.mockReset().mockResolvedValue(null);
  mocks.admin.mockReset();
});

describe("office scope while restricted for nonpayment", () => {
  it("changes nothing for an office that has paid", async () => {
    for (const url of [...ALLOWED, ...BLOCKED]) {
      const result = await resolve(url);
      expect(result.kind, url).toBe("ok");
      if (result.kind === "ok") expect(result.scope.restricted).toBe(false);
    }
  });

  it("keeps payments, subscriptions and export open to every staff role", async () => {
    mocks.restricted.mockResolvedValue(true);
    for (const caller of ["owner", "admin", "staff"] as Caller[]) {
      for (const url of ALLOWED) {
        const result = await resolve(url, caller);
        expect(result.kind, `${caller} ${url}`).toBe("ok");
        // The route is served, and the scope says why it looks narrowed.
        if (result.kind === "ok") expect(result.scope.restricted).toBe(true);
      }
    }
  });

  it("refuses everything else, for every staff role, with a code the client can route on", async () => {
    mocks.restricted.mockResolvedValue(true);
    for (const caller of ["owner", "admin", "staff"] as Caller[]) {
      for (const url of BLOCKED) {
        const result = await resolve(url, caller);
        expect(result.kind, `${caller} ${url}`).toBe("denied");
        if (result.kind === "denied") {
          expect(result.status).toBe(403);
          expect(result.reason).toBe("office_restricted");
          // Non-punitive, and it names what still works.
          expect(result.message).toMatch(/Patient subscriptions, payments and patient data export stay open/);
        }
      }
    }
  });

  it("never narrows HQ, which must still see and help the office", async () => {
    mocks.restricted.mockResolvedValue(true);
    mocks.staffIdentity.mockResolvedValue({
      userId: "hq-1", role: "hq_admin", departmentRole: "admin",
    });
    mocks.admin.mockImplementation(async (_method: string, path: string) => ({
      status: 200,
      json: path.startsWith("/rest/v1/providers") && path.includes("provider_id=eq.") ? [OFFICE] : [],
    }));
    const result = await resolveOfficeScope({
      authorization: "Bearer token",
      explicitOfficeId: "office-1",
      hqPermission: "provider_manage",
      requireUnlocked: false,
      request: { method: "GET", url: "/api/office/roster", originalUrl: "/api/office/roster", headers: {} } as never,
    });
    expect(result.kind).toBe("ok");
    // HQ still sees the office's state — it just is not narrowed by it.
    if (result.kind === "ok") expect(result.scope.restricted).toBe(true);
  });

  it("restores the whole surface on the next request once the office pays", async () => {
    mocks.restricted.mockResolvedValue(true);
    expect((await resolve("/api/office/roster")).kind).toBe("denied");
    mocks.restricted.mockResolvedValue(false);
    for (const url of BLOCKED) {
      const result = await resolve(url);
      expect(result.kind, url).toBe("ok");
      if (result.kind === "ok") expect(result.scope.restricted).toBe(false);
    }
  });

  it("leaves the lock and offboarding states exactly as they were", async () => {
    mocks.locked.mockResolvedValue(true);
    const locked = await resolve("/api/office/access");
    expect(locked.kind).toBe("denied");
    // The lock still ends access entirely — the narrowed surface is not a way in.
    if (locked.kind === "denied") expect(locked.reason).toBe("office_locked");

    mocks.locked.mockResolvedValue(false);
    mocks.admin.mockImplementation(async (_method: string, path: string) => ({
      status: 200,
      json: path.startsWith("/rest/v1/providers") ? [{ ...OFFICE, offboarding_status: "offboarded" }] : [],
    }));
    const ended = await resolveOfficeScope({
      authorization: "Bearer token",
      hqPermission: "provider_manage",
      requireUnlocked: false,
      request: { method: "GET", url: "/api/office/access", originalUrl: "/api/office/access", headers: {} } as never,
    });
    expect(ended.kind).toBe("denied");
    if (ended.kind === "denied") expect(ended.reason).toBe("office_offboarded");
  });

  it("does not narrow a caller whose request cannot be placed on the map", async () => {
    mocks.restricted.mockResolvedValue(true);
    const table = rows("owner");
    mocks.admin.mockImplementation(async (_method: string, path: string) => ({ status: 200, json: table(path) }));
    const result = await resolveOfficeScope({
      authorization: "Bearer token",
      hqPermission: "provider_manage",
      requireUnlocked: false,
    });
    // The route it reaches still enforces its own rule, and the charge path
    // applies the elevated share regardless.
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.scope.restricted).toBe(true);
  });
});
