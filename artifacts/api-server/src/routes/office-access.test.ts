/**
 * The office's own access page reads scope-isolated Stripe tables, so the
 * route must pin the workspace's selected billing identity before it reads.
 * Without that the scoped store throws and every visit returns 502, which is
 * what production showed before the wrapper existed. The real identity
 * context is used here on purpose: a mocked pass-through would hide the bug.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { currentBillingIdentity } from "../billing/stripe-environment";

const m = vi.hoisted(() => ({ scope: vi.fn(), summary: vi.fn(), charge: vi.fn() }));

vi.mock("../auth/office-scope", () => ({
  resolveOfficeScope: m.scope,
  respondOfficeScopeDenied: (_req: unknown, res: any, result: any) => res.status(result.status).json({ error: result.message }),
}));
vi.mock("../billing/mode-state", () => ({ getBillingModeStatus: async () => ({ mode: "test", platformAccountId: "acct_test", version: 0 }) }));
vi.mock("../billing/office-access/admin", () => ({ accessSummary: m.summary }));
vi.mock("../billing/office-access/charge", () => ({ chargeOfficeAccess: m.charge }));
vi.mock("../billing/office-access/settings", () => ({
  loadAccessBillingSettings: async () => ({}),
  revenueSharePercent: () => 10,
}));
vi.mock("../lib/office-restriction", () => ({
  OFFICE_RESTRICTED_CAPABILITIES: [],
  OFFICE_RESTRICTED_STAFF_MESSAGE: "restricted",
  officeRestrictedForNonpayment: async () => false,
}));

import router from "./office-access";

let server: http.Server, base = "";
const owner = { providerId: "office-a", officeName: "A", actorUserId: "owner-a", actorKind: "provider", officeRole: "owner", teamMemberId: null, restricted: false };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  vi.clearAllMocks();
  m.scope.mockResolvedValue({ kind: "ok", scope: owner });
});

describe("GET /office/access", () => {
  it("reads the subscription inside the selected billing identity", async () => {
    let seen: unknown = null;
    m.summary.mockImplementation(async () => {
      seen = currentBillingIdentity();
      if (!seen) throw new Error("Billing identity is required.");
      return { state: "active", plan: "yearly", priceCents: 1000, lifetime: false, includedPeriodEndsAt: null, paidThrough: null, graceEndsAt: null, restrictedAt: null, setupCompletedAt: null };
    });
    const res = await fetch(`${base}/office/access`, { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ mode: "test", platformAccountId: "acct_test" });
    expect(((await res.json()) as { state: string }).state).toBe("active");
  });
});

describe("POST /office/access/pay", () => {
  it("runs the charge inside the selected billing identity", async () => {
    let seen: unknown = null;
    m.charge.mockImplementation(async () => { seen = currentBillingIdentity(); return { status: "succeeded" }; });
    m.summary.mockResolvedValue(null);
    const res = await fetch(`${base}/office/access/pay`, { method: "POST", headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ mode: "test", platformAccountId: "acct_test" });
  });
});
