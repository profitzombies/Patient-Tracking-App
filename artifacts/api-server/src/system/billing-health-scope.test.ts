import { afterEach, describe, expect, it, vi } from "vitest";
import { currentBillingIdentity } from "../billing/stripe-environment";
import { readPerformance } from "./performance";
import { warehouseSyncHealth } from "../billing/warehouse-status-sync";

vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async () => ({ status: 200, json: [], contentRange: null })),
}));
vi.mock("../billing/stripe-client", () => ({
  getStripeCredentials: vi.fn(async (mode: string) => {
    if (mode !== "live" || !process.env.STRIPE_LIVE_SECRET_KEY) throw new Error("Live is not configured.");
    return { account_id: "acct_live", secret: "synthetic", publishable: "synthetic" };
  }),
}));
vi.mock("../billing/warehouse-status-sync", () => ({
  warehouseSyncHealth: vi.fn(async () => {
    if (currentBillingIdentity()?.mode !== "live") throw new Error("Billing identity is required.");
    return { last_success_at: null, last_poll_at: null, stalled_after_minutes: 60, last_error: null };
  }),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const unavailable = async (): Promise<never> => { throw new Error("Unrelated reader unavailable in this focused test"); };
const readers = { latency: unavailable, slowStatements: unavailable, growth: unavailable, coldArchive: unavailable };

describe("system-threshold warehouse health", () => {
  it("runs the default warehouse reader in Live even without billing middleware", async () => {
    vi.stubEnv("STRIPE_LIVE_SECRET_KEY", "synthetic");
    const errors: string[] = [];
    await readPerformance(new Date(), { ...readers, onError: section => { errors.push(section); } });
    expect(warehouseSyncHealth).toHaveBeenCalledOnce();
    expect(errors).not.toContain("warehousePoll");
    expect(currentBillingIdentity()).toBeUndefined();
  });
  it("reports unavailable Live configuration rather than silently healthy warehouse data", async () => {
    vi.stubEnv("STRIPE_LIVE_SECRET_KEY", "");
    const errors: string[] = [];
    await readPerformance(new Date(), { ...readers, onError: section => { errors.push(section); } });
    expect(errors).toContain("warehousePoll");
    expect(warehouseSyncHealth).not.toHaveBeenCalled();
  });
});