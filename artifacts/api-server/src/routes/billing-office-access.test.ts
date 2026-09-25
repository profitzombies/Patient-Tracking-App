/**
 * The HTTP boundary of the office's own payment setup.
 *
 * What matters here is who may do what: any staff member can fix a card or
 * settle a balance from their phone, only the owner may choose the plan or
 * accept the terms, and HQ may look but never act on an office's money. The
 * duplicate-card refusal must reach the browser intact, because the setup
 * screen has to explain it rather than show a generic failure.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  scope: vi.fn(), snapshot: vi.fn(), attach: vi.fn(), plan: vi.fn(), disclosure: vi.fn(),
  verify: vi.fn(), charge: vi.fn(), customer: vi.fn(), setupIntent: vi.fn(),
  // The real error classes carry status/code; the router branches on both.
  errors: class extends Error { constructor(message: string, readonly status = 400, readonly code?: string) { super(message); } },
}));

vi.mock("../auth/office-scope", () => ({
  resolveOfficeScope: m.scope,
  respondOfficeScopeDenied: (_req: unknown, res: any, result: any) => res.status(result.status).json({ error: result.message }),
}));
vi.mock("../billing/mode-state", () => ({ getBillingModeStatus: async () => ({ mode: "test", platformAccountId: "acct_test", version: 0 }) }));
vi.mock("../billing/stripe-environment", () => ({
  currentBillingIdentity: () => ({ mode: "test", platformAccountId: "acct_test" }),
  runWithBillingIdentity: (_identity: unknown, fn: () => unknown) => fn(),
}));
vi.mock("../billing/stripe-client", () => ({
  getStripe: async () => ({ setupIntents: { create: m.setupIntent } }),
  getPublishableKey: async () => "pk_test_123",
  isSandbox: async () => true,
  stripeRejection: () => null,
}));
vi.mock("../billing/store", () => ({ selectOne: async () => ({ details_submitted: true, charges_enabled: true, payouts_enabled: true, requirements: {} }) }));
vi.mock("../billing/office-access/setup", () => ({
  AccessSetupError: m.errors,
  accessSetupSnapshot: m.snapshot,
  acknowledgeAccessDisclosure: m.disclosure,
  refreshBankVerification: m.verify,
  selectAccessPlan: m.plan,
}));
vi.mock("../billing/office-access/instruments", () => ({
  AccessInstrumentError: m.errors,
  attachAccessInstrument: m.attach,
  ensureAccessCustomer: m.customer,
}));
vi.mock("../billing/office-access/subscription", () => ({ ensureAccessSubscription: async () => ({ id: "sub-1" }) }));
vi.mock("../billing/office-access/charge", () => ({ chargeOfficeAccess: m.charge }));
vi.mock("../lib/admin-audit", () => ({ requestIdOf: () => "req-1" }));

import router from "./billing-office-access";

let server: http.Server, base = "";
const owner = { providerId: "office-a", officeName: "A", actorUserId: "owner-a", actorKind: "provider", officeRole: "owner", teamMemberId: null };
const staff = { ...owner, actorUserId: "staff-a", actorKind: "team_member", officeRole: "staff", teamMemberId: "tm-1" };
const hq = { ...owner, actorUserId: "hq-a", actorKind: "hq" };

async function call(method: string, path = "", body?: unknown) {
  return fetch(`${base}/billing/office/access${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  vi.clearAllMocks();
  m.scope.mockResolvedValue({ kind: "ok", scope: owner });
  m.snapshot.mockImplementation(async (input: any) => ({ complete: false, canManage: input.canManage, canChoosePlan: input.canChoosePlan, connect: { state: await input.connect, sandbox: await input.sandbox }, row: input.row ?? null }));
  m.attach.mockResolvedValue({ slot: "card_backup" });
  m.plan.mockResolvedValue({});
  m.disclosure.mockResolvedValue({});
  m.verify.mockResolvedValue({ verified: true });
  m.charge.mockResolvedValue({ status: "succeeded" });
  m.customer.mockResolvedValue("cus_1");
  m.setupIntent.mockResolvedValue({ id: "seti_1", client_secret: "seti_1_secret" });
});

describe("office access setup boundary", () => {
  it("reports the connected-account state alongside the office's own setup", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connect: { state: "ready", sandbox: true }, canManage: true, canChoosePlan: true });
    expect(m.snapshot).toHaveBeenCalledWith(expect.objectContaining({ providerId: "office-a" }));
  });

  it("preserves an office-scope denial instead of answering with setup data", async () => {
    m.scope.mockResolvedValue({ kind: "denied", status: 403, message: "Your office is locked." });
    const res = await call("GET");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Your office is locked." });
    expect(m.snapshot).not.toHaveBeenCalled();
  });

  it("lets any staff member add an instrument, choose nothing, and settle a balance", async () => {
    m.scope.mockResolvedValue({ kind: "ok", scope: staff });
    expect((await call("POST", "/setup-intent", { slot: "card_primary" })).status).toBe(200);
    expect((await call("POST", "/instruments", { slot: "card_primary", paymentMethodId: "pm_1", setupIntentId: "seti_1" })).status).toBe(200);
    expect((await call("POST", "/bank/verify", {})).status).toBe(200);
    expect((await call("POST", "/pay", {})).status).toBe(200);
    expect(m.attach).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "office-a", slot: "card_primary", paymentMethodId: "pm_1", setupIntentId: "seti_1",
    }));

    for (const [path, body] of [["/plan", { plan: "yearly" }], ["/disclosure", { version: 3 }]] as const) {
      expect((await call("POST", path, body)).status).toBe(403);
    }
    expect(m.plan).not.toHaveBeenCalled();
    expect(m.disclosure).not.toHaveBeenCalled();
  });

  it("lets the owner choose a plan and accept the terms", async () => {
    expect((await call("POST", "/plan", { plan: "yearly" })).status).toBe(200);
    expect((await call("POST", "/disclosure", { version: 4 })).status).toBe(200);
    expect(m.plan).toHaveBeenCalledWith(expect.objectContaining({ plan: "yearly", actor: expect.objectContaining({ kind: "provider", userId: "owner-a" }) }));
    expect(m.disclosure).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }));
  });

  it("answers a plan choice and an acknowledgment with the new setup, built from the written row", async () => {
    m.plan.mockResolvedValue({ id: "sub-1", plan: "yearly", plan_selected_at: "2026-09-25T00:00:00Z" });
    const planned = await (await call("POST", "/plan", { plan: "yearly" })).json();
    expect(planned).toMatchObject({ connect: { state: "ready", sandbox: true }, row: { plan: "yearly" } });
    m.disclosure.mockResolvedValue({ id: "sub-1", disclosure_acknowledged_at: "2026-09-25T00:00:00Z" });
    const acknowledged = await (await call("POST", "/disclosure", { version: 4 })).json();
    expect(acknowledged).toMatchObject({ row: { disclosure_acknowledged_at: "2026-09-25T00:00:00Z" } });
    // One snapshot per write: no follow-up read is needed to see the change.
    expect(m.snapshot).toHaveBeenCalledTimes(2);
  });

  it("does not build a snapshot when the write itself fails", async () => {
    m.plan.mockRejectedValue(new m.errors("Contact THINNR support to change your billing plan.", 409, "plan_locked"));
    const res = await call("POST", "/plan", { plan: "monthly" });
    expect(res.status).toBe(409);
    expect(m.snapshot).not.toHaveBeenCalled();
  });

  it("lets HQ review an office's setup but never act on it", async () => {
    m.scope.mockResolvedValue({ kind: "ok", scope: hq });
    const read = await call("GET");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canManage: false, canChoosePlan: false });
    for (const [method, path, body] of [
      ["POST", "/setup-intent", { slot: "bank" }], ["POST", "/instruments", { slot: "bank", paymentMethodId: "pm_1" }],
      ["POST", "/plan", { plan: "monthly" }], ["POST", "/disclosure", { version: 1 }],
      ["POST", "/bank/verify", {}], ["POST", "/pay", {}],
    ] as const) {
      expect((await call(method, path, body)).status).toBe(403);
    }
    expect(m.attach).not.toHaveBeenCalled();
    expect(m.charge).not.toHaveBeenCalled();
  });

  it("passes the duplicate-card refusal through with its code so the screen can explain it", async () => {
    m.attach.mockRejectedValue(new m.errors("That is the same card you already have on file.", 409, "duplicate_card"));
    const res = await call("POST", "/instruments", { slot: "card_backup", paymentMethodId: "pm_same" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "That is the same card you already have on file.", code: "duplicate_card" });
  });

  it("asks Stripe for a bank SetupIntent of the right type and never touches the details", async () => {
    const res = await call("POST", "/setup-intent", { slot: "bank" });
    expect(await res.json()).toMatchObject({ clientSecret: "seti_1_secret", setupIntentId: "seti_1", publishableKey: "pk_test_123", slot: "bank" });
    expect(m.setupIntent).toHaveBeenCalledWith(expect.objectContaining({ payment_method_types: ["us_bank_account"], customer: "cus_1" }));
  });

  it("rejects an unknown slot rather than storing it", async () => {
    expect((await call("POST", "/instruments", { slot: "card_third", paymentMethodId: "pm_1" })).status).toBe(400);
    expect(m.attach).not.toHaveBeenCalled();
  });

  it("says plainly when there is nothing to pay", async () => {
    m.charge.mockResolvedValue(null);
    expect(await (await call("POST", "/pay", {})).json()).toMatchObject({ status: "nothing_due" });
  });
});
