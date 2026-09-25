/**
 * HQ testing hard-delete routes: only HQ admins with provider-management
 * permission get in; office staff, providers and patients are refused; the
 * POSTs also need a fresh sign-in code and the exact name typed back before
 * anything is erased.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const PATIENT = "00000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({
  fresh: true,
  permissions: [] as string[],
  deleteProvider: vi.fn(),
  deletePatient: vi.fn(),
}));

vi.mock("../lib/staff-auth", () => ({
  // Mirrors the real guard: non-HQ tokens (office staff, providers, patients)
  // resolve to no HQ identity → 401; HQ roles without the permission → 403.
  requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    mocks.permissions.push(permission);
    const token = req.headers.authorization;
    if (token === "Bearer hq-admin") {
      res.locals.staff = { userId: "hq-admin-user", departmentRole: "admin" };
      return next();
    }
    if (token === "Bearer hq-support") return res.status(403).json({ error: "Your HQ role does not have permission to do this." });
    return res.status(401).json({ error: "Sign in with an active HQ account to continue." });
  },
}));
vi.mock("../auth/fresh-code", () => ({
  requireFreshCode: async (_req: express.Request, res: express.Response) => {
    if (mocks.fresh) return true;
    res.status(401).json({ error: "Confirm it's you", code: "REAUTH_REQUIRED" });
    return false;
  },
}));
vi.mock("../testing-delete/hard-delete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../testing-delete/hard-delete")>()),
  previewProvider: vi.fn(async (id: string) => ({ kind: "provider", id, name: "Harbor Test Spa", staffLogins: 2, hqMembersKept: 0, patients: 1, patientLogins: 1, stripeAccounts: [], accessPlan: null, providerName: null })),
  previewPatient: vi.fn(async (id: string) => ({ kind: "patient", id, name: "Pat Tester", providerId: "live-abc", officeName: "Harbor", hasLogin: true, hqMemberKept: false, activeSubscriptions: 0 })),
  hardDeleteProvider: mocks.deleteProvider,
  hardDeletePatient: mocks.deletePatient,
}));

import router from "./hq-testing-delete";

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  mocks.fresh = true;
  mocks.permissions = [];
  mocks.deleteProvider.mockReset().mockImplementation(async (id: string) => ({ kind: "provider", id, name: "Harbor Test Spa", stripe: [], logins: { deleted: 2, alreadyGone: 0, keptHqMembers: 0, failed: [] }, files: { deleted: 3, failed: [] }, rows: {} }));
  mocks.deletePatient.mockReset().mockImplementation(async (id: string) => ({ kind: "patient", id, name: "Pat Tester", stripe: [], logins: { deleted: 1, alreadyGone: 0, keptHqMembers: 0, failed: [] }, files: { deleted: 0, failed: [] }, rows: {} }));
});

const call = (path: string, token: string, body?: unknown) => fetch(base + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("HQ testing hard delete routes", () => {
  it("refuses office staff, providers, patients and HQ roles without provider management", async () => {
    for (const token of ["office-staff", "provider-owner", "patient", "hq-support"]) {
      for (const path of ["/hq/testing-delete/providers/live-abc", `/hq/testing-delete/patients/${PATIENT}`]) {
        const res = await call(path, token, { confirmName: token.includes("patient") ? "Pat Tester" : "Harbor Test Spa" });
        expect([401, 403]).toContain(res.status);
        expect((await call(path, token)).status).toBeGreaterThanOrEqual(401);
      }
    }
    expect(mocks.deleteProvider).not.toHaveBeenCalled();
    expect(mocks.deletePatient).not.toHaveBeenCalled();
    expect(new Set(mocks.permissions)).toEqual(new Set(["provider_manage"]));
  });

  it("returns the erase preview to HQ admins", async () => {
    const res = await call("/hq/testing-delete/providers/live-abc", "hq-admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Harbor Test Spa", staffLogins: 2, patients: 1 });
    expect((await call(`/hq/testing-delete/patients/${PATIENT}`, "hq-admin")).status).toBe(200);
  });

  it("requires a fresh sign-in code before deleting", async () => {
    mocks.fresh = false;
    const res = await call("/hq/testing-delete/providers/live-abc", "hq-admin", { confirmName: "Harbor Test Spa" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code?: string }).code).toBe("REAUTH_REQUIRED");
    expect(mocks.deleteProvider).not.toHaveBeenCalled();
  });

  it("requires the exact name typed back", async () => {
    let res = await call("/hq/testing-delete/providers/live-abc", "hq-admin", { confirmName: "Harbor" });
    expect(res.status).toBe(400);
    res = await call(`/hq/testing-delete/patients/${PATIENT}`, "hq-admin", {});
    expect(res.status).toBe(400);
    expect(mocks.deleteProvider).not.toHaveBeenCalled();
    expect(mocks.deletePatient).not.toHaveBeenCalled();
  });

  it("rejects malformed ids", async () => {
    expect((await call("/hq/testing-delete/patients/not-a-uuid", "hq-admin", { confirmName: "x" })).status).toBe(400);
    expect((await call("/hq/testing-delete/providers/bad%20id", "hq-admin", { confirmName: "x" })).status).toBe(400);
  });

  it("erases and returns the outcome report when everything checks out", async () => {
    let res = await call("/hq/testing-delete/providers/live-abc", "hq-admin", { confirmName: " harbor test spa " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "provider", logins: { deleted: 2 } });
    expect(mocks.deleteProvider).toHaveBeenCalledWith("live-abc");
    res = await call(`/hq/testing-delete/patients/${PATIENT}`, "hq-admin", { confirmName: "Pat Tester" });
    expect(res.status).toBe(200);
    expect(mocks.deletePatient).toHaveBeenCalledWith(PATIENT);
  });

  it("passes engine errors through with their status and Stripe detail", async () => {
    const { HardDeleteError } = await import("../testing-delete/hard-delete");
    mocks.deleteProvider.mockRejectedValueOnce(new HardDeleteError("Nothing was deleted: Stripe is down.", 502, { stripe: [] }));
    const res = await call("/hq/testing-delete/providers/live-abc", "hq-admin", { confirmName: "Harbor Test Spa" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Nothing was deleted: Stripe is down.", stripe: [] });
  });
});
