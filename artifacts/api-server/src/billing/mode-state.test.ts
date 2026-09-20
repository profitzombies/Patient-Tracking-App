import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { supabaseAdmin } from "../lib/supabase-admin";
import { getBillingModeSelection, getBillingModeStatus, switchBillingMode } from "./mode-state";
import { getPlatformAccountId } from "./stripe-client";
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: vi.fn() }));
vi.mock("./stripe-client", () => ({
  getPlatformAccountId: vi.fn(async () => "acct_configured"),
  getStripe: vi.fn(async () => ({})),
}));
const db = vi.mocked(supabaseAdmin);
beforeEach(() => {
  vi.stubEnv("BILLING_DEPLOYMENT_ID", "deployment-one");
  db.mockReset().mockResolvedValue({ status: 200, json: [], contentRange: null });
});
afterEach(() => vi.unstubAllEnvs());
it("defaults an unselected deployment to Test, version zero", async () => {
  expect(await getBillingModeStatus()).toEqual({ mode: "test", platformAccountId: "acct_configured", version: 0 });
  expect(db.mock.calls[0][1]).toContain("deployment_id=eq.deployment-one");
});
it("exposes selection even when Stripe keys are unavailable", async () => {
  vi.mocked(getPlatformAccountId).mockRejectedValueOnce(new Error("missing keys"));
  expect(await getBillingModeSelection()).toEqual({ mode: "test", version: 0, platformAccountId: null });
  await expect(getBillingModeStatus()).rejects.toThrow("missing keys");
});
it("refuses to use an existing mode after a platform account change", async () => {
  db.mockResolvedValue({ status: 200, json: [{ mode: "live", platform_account_id: "acct_previous", version: 2 }], contentRange: null });
  await expect(getBillingModeStatus()).rejects.toThrow("configured Stripe account changed");
});
const change = { mode: "live" as const, expectedVersion: 1, confirmLive: true, actorUserId: "actor", requestId: "request" };
it("requires explicit Live confirmation before persistence", async () => {
  await expect(switchBillingMode({ ...change, confirmLive: false })).rejects.toMatchObject({ status: 400 });
  expect(db).not.toHaveBeenCalled();
});
it("uses an atomic audited deployment/version RPC", async () => {
  db.mockResolvedValue({ status: 200, json: { mode: "live", platform_account_id: "acct_configured", version: 2 }, contentRange: null });
  expect(await switchBillingMode(change)).toMatchObject({ mode: "live", version: 2 });
  expect(db).toHaveBeenCalledWith("POST", "/rest/v1/rpc/switch_billing_mode", expect.objectContaining({
    p_expected_version: 1, p_actor_user_id: "actor", p_request_id: "request", p_deployment_id: "deployment-one",
  }));
});
it("reports concurrent selection changes as conflict", async () => {
  db.mockResolvedValue({ status: 400, json: { code: "40001" }, contentRange: null });
  await expect(switchBillingMode(change)).rejects.toMatchObject({ status: 409 });
});