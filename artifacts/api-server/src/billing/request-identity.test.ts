import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const mocks = vi.hoisted(() => ({
  selected: vi.fn(), credentials: vi.fn(), database: vi.fn(),
}));
vi.mock("./mode-state", () => ({ getBillingModeStatus: mocks.selected }));
vi.mock("./stripe-client", () => ({ getStripeCredentials: mocks.credentials }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.database }));
import { billingRequestIdentity, storedIdentityReference } from "./request-identity";
import { currentBillingIdentity } from "./stripe-environment";

function request(path: string, method = "GET", scope?: string) {
  return { path, method, query: {}, get: () => scope } as unknown as Request;
}
function response() {
  return { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.selected.mockResolvedValue({ mode: "live", platformAccountId: "acct_live", version: 2 });
  mocks.credentials.mockImplementation(async (mode: string) => ({ account_id: `acct_${mode}` }));
});
describe("billing HTTP identity", () => {
  it("pins a new read once and exposes a scope for the form", async () => {
    const res = response();
    let identity;
    await billingRequestIdentity(request("/api/patient-data/billing/shop"), res, () => { identity = currentBillingIdentity(); });
    expect(identity).toEqual({ mode: "live", platformAccountId: "acct_live" });
    expect(res.setHeader).toHaveBeenCalledWith("X-Billing-Scope", "live:acct_live");
    expect(currentBillingIdentity()).toBeUndefined();
  });
  it.each([undefined, "test:acct_test"])("refuses checkout with absent or stale scope (%s)", async (scope) => {
    const res = response(), next = vi.fn();
    await billingRequestIdentity(request("/api/patient-data/billing/cart/checkout", "POST", scope), res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(next).not.toHaveBeenCalled();
  });
  it("allows checkout when its displayed identity still matches", async () => {
    const next = vi.fn();
    await billingRequestIdentity(request("/api/billing/office/sales", "POST", "live:acct_live"), response(), next);
    expect(next).toHaveBeenCalledOnce();
  });
  it("keeps old public links in Test after a Live switch", async () => {
    mocks.database.mockResolvedValue({ status: 200, json: [{ stripe_mode: "test", stripe_platform_account_id: "acct_test" }] });
    let identity;
    await billingRequestIdentity(request("/api/billing/public/links/token/orders", "POST"), response(), () => { identity = currentBillingIdentity(); });
    expect(identity).toEqual({ mode: "test", platformAccountId: "acct_test" });
    expect(mocks.selected).not.toHaveBeenCalled();
  });
  it("quarantines legacy links without an identity", async () => {
    mocks.database.mockResolvedValue({ status: 200, json: [{ stripe_mode: null, stripe_platform_account_id: null }] });
    const next = vi.fn(), res = response();
    await billingRequestIdentity(request("/api/billing/public/links/token"), res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
  it("refuses records whose original platform no longer matches configuration", async () => {
    mocks.database.mockResolvedValue({ status: 200, json: [{ stripe_mode: "test", stripe_platform_account_id: "acct_retired" }] });
    const next = vi.fn(), res = response();
    await billingRequestIdentity(request("/api/billing/public/carts/token/checkout", "POST"), res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
  it("scopes HQ office access, which lives outside the /api/billing tree", async () => {
    let identity: unknown = null;
    await billingRequestIdentity(request("/api/hq/office-access/office-1"), response(), () => { identity = currentBillingIdentity(); });
    expect(identity).toEqual({ mode: "live", platformAccountId: "acct_live" });
  });
  it.each(["/api/billing/hq/mode", "/api/billing/hq/health", "/api/billing/oauth/callback", "/api/healthz"])("leaves configuration and nonbilling routes available: %s", async (path) => {
    const next = vi.fn();
    await billingRequestIdentity(request(path), response(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(mocks.selected).not.toHaveBeenCalled();
  });
  it("pins receipt/refund and subscription actions by original record id", () => {
    expect(storedIdentityReference("/api/billing/office/orders/11111111-1111-1111-1111-111111111111/refund", {}))
      .toEqual({ table: "billing_orders", field: "id", value: "11111111-1111-1111-1111-111111111111" });
  });
});