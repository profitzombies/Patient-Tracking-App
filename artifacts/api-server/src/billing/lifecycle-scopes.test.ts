import { afterEach, describe, expect, it, vi } from "vitest";
import { supabaseAdmin } from "../lib/supabase-admin";
import { forEachBillingScope, liveBillingEffectsAllowed, withLiveBillingScope } from "./lifecycle-scopes";
import { currentBillingIdentity, runWithBillingIdentity } from "./stripe-environment";

vi.mock("./stripe-client", () => ({
  getStripeCredentials: vi.fn(async (mode: string) => {
    if (!process.env[`STRIPE_${mode.toUpperCase()}_SECRET_KEY`] || process.env[`STRIPE_${mode.toUpperCase()}_SECRET_KEY`] === "invalid") throw new Error("Missing configuration");
    return { account_id: `acct_${mode}`, secret: "synthetic", publishable: "synthetic" };
  }),
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: vi.fn(async () => ({ status: 200, json: [], contentRange: null })) }));
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(supabaseAdmin).mockResolvedValue({ status: 200, json: [], contentRange: null }); });

describe("billing lifecycle scope isolation", () => {
  it("pins unscoped operational health to Live and restores the caller context", async () => {
    vi.stubEnv("STRIPE_LIVE_SECRET_KEY", "synthetic");
    const result = await withLiveBillingScope(async () => {
      expect(currentBillingIdentity()).toEqual({ mode: "live", platformAccountId: "acct_live" });
      return { pending: 3 };
    });
    expect(result).toEqual({ pending: 3 });
    expect(currentBillingIdentity()).toBeUndefined();
  });
  it("never turns missing Live health configuration into a successful empty queue", async () => {
    vi.stubEnv("STRIPE_LIVE_SECRET_KEY", "");
    const read = vi.fn(async () => ({ pending: 0 }));
    await expect(withLiveBillingScope(read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("reports persisted live rows without credentials while still processing Test", async () => {
    vi.stubEnv("STRIPE_TEST_SECRET_KEY", "synthetic");
    vi.stubEnv("STRIPE_LIVE_SECRET_KEY", "");
    vi.mocked(supabaseAdmin).mockResolvedValue({ status: 200, json: [{ stripe_mode: "live", stripe_platform_account_id: "acct_live" }], contentRange: null });
    const seen: string[] = [];
    await expect(forEachBillingScope(async () => { seen.push(currentBillingIdentity()!.mode); })).rejects.toThrow("could not be processed");
    expect(seen).toEqual(["test"]);
  });
  it("reports historical account rotation without operating on the wrong account", async () => {
    vi.stubEnv("STRIPE_LIVE_SECRET_KEY", "synthetic");
    vi.mocked(supabaseAdmin).mockResolvedValue({ status: 200, json: [{ stripe_mode: "live", stripe_platform_account_id: "acct_retired" }], contentRange: null });
    await expect(forEachBillingScope(async () => {
      expect(currentBillingIdentity()?.platformAccountId).toBe("acct_live");
    }, ["live"])).rejects.toThrow("could not be processed");
  });
  it("processes live renewals as well as test regardless of interactive selection", async () => {
    vi.stubEnv("STRIPE_TEST_SECRET_KEY", "synthetic");
    vi.stubEnv("STRIPE_LIVE_SECRET_KEY", "synthetic");
    const seen: unknown[] = [];
    await forEachBillingScope(async () => { seen.push(currentBillingIdentity()); });
    expect(seen).toEqual([
      { mode: "test", platformAccountId: "acct_test" },
      { mode: "live", platformAccountId: "acct_live" },
    ]);
    expect(currentBillingIdentity()).toBeUndefined();
  });
  it("does not let broken test configuration starve live, and reports failure", async () => {
    vi.stubEnv("STRIPE_TEST_SECRET_KEY", "invalid");
    vi.stubEnv("STRIPE_LIVE_SECRET_KEY", "synthetic");
    const seen: string[] = [];
    await expect(forEachBillingScope(async () => { seen.push(currentBillingIdentity()!.mode); })).rejects.toThrow("could not be processed");
    expect(seen).toEqual(["live"]);
  });
  it("fails closed for customer effects without a live identity", async () => {
    expect(liveBillingEffectsAllowed()).toBe(false);
    await runWithBillingIdentity({ mode: "test", platformAccountId: "acct_test" }, async () => {
      await Promise.resolve();
      expect(liveBillingEffectsAllowed()).toBe(false);
    });
    expect(runWithBillingIdentity({ mode: "live", platformAccountId: "acct_live" }, liveBillingEffectsAllowed)).toBe(true);
  });
  it("keeps concurrent test and live work isolated", async () => {
    await Promise.all((["test", "live"] as const).map((mode) =>
      runWithBillingIdentity({ mode, platformAccountId: `acct_${mode}` }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(currentBillingIdentity()?.mode).toBe(mode);
        expect(liveBillingEffectsAllowed()).toBe(mode === "live");
      }),
    ));
  });
});