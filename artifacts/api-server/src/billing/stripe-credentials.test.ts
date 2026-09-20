import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setCredentialsForTests, __setStripeForTests, getStripe, getStripeCredentials } from "./stripe-client";
import { runWithBillingIdentity } from "./stripe-environment";

const boundary = vi.hoisted(() => ({ retrieve: vi.fn(), construct: vi.fn() }));
vi.mock("stripe", () => ({
  default: class {
    accounts = { retrieve: boundary.retrieve };
    constructor(key: string) { boundary.construct(key); }
  },
}));

beforeEach(() => {
  __setCredentialsForTests(null);
  __setStripeForTests(null);
  vi.clearAllMocks();
  for (const mode of ["TEST", "LIVE"]) {
    vi.stubEnv(`STRIPE_${mode}_SECRET_KEY`, `sk_${mode.toLowerCase()}_synthetic`);
    vi.stubEnv(`STRIPE_${mode}_PUBLISHABLE_KEY`, `pk_${mode.toLowerCase()}_synthetic`);
    vi.stubEnv(`STRIPE_${mode}_PLATFORM_ACCOUNT_ID`, "acct_synthetic");
  }
  boundary.retrieve.mockResolvedValue({ id: "acct_synthetic" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  __setCredentialsForTests(null);
});

describe("environment-only Stripe credentials", () => {
  it("defaults to Test and never falls back to Live or connector credentials", async () => {
    vi.stubEnv("STRIPE_TEST_SECRET_KEY", "");
    await expect(getStripe()).rejects.toThrow("STRIPE_TEST_SECRET_KEY is missing");
    expect(boundary.construct).not.toHaveBeenCalled();
  });
  it.each(["SECRET_KEY", "PUBLISHABLE_KEY", "PLATFORM_ACCOUNT_ID"])("fails closed for missing %s", async (suffix) => {
    vi.stubEnv(`STRIPE_TEST_${suffix}`, "");
    await expect(getStripeCredentials()).rejects.toThrow(`STRIPE_TEST_${suffix} is missing`);
  });
  it.each(["SECRET_KEY", "PUBLISHABLE_KEY"])("rejects mismatched %s without leaking its value", async (suffix) => {
    const value = `${suffix === "SECRET_KEY" ? "sk" : "pk"}_live_synthetic`;
    vi.stubEnv(`STRIPE_TEST_${suffix}`, value);
    await expect(getStripe()).rejects.toThrow("key types do not match");
    await getStripe().catch((error: Error) => expect(error.message).not.toContain(value));
    expect(boundary.retrieve).not.toHaveBeenCalled();
  });
  it("verifies the authenticated platform, not the configured account by ID", async () => {
    boundary.retrieve.mockResolvedValue({ id: "acct_unexpected" });
    await expect(getStripe()).rejects.toThrow("platform account does not match");
    expect(boundary.retrieve).toHaveBeenCalledWith();
    boundary.retrieve.mockResolvedValue({ id: "acct_synthetic" });
    await expect(getStripe()).resolves.toBeDefined();
    expect(boundary.retrieve).toHaveBeenCalledTimes(2);
  });
  it("sanitizes verification failures", async () => {
    boundary.retrieve.mockRejectedValue(new Error("sk_test_synthetic transport diagnostic"));
    await expect(getStripe()).rejects.toThrow("platform identity could not be verified");
    await getStripe().catch((error: Error) => expect(error.message).not.toContain("sk_test_synthetic"));
  });
  it("single-flights identity checks, caches them, and verifies again after expiry", async () => {
    vi.useFakeTimers();
    const [first, second] = await Promise.all([getStripe(), getStripe()]);
    expect(first).toBe(second);
    expect(boundary.retrieve).toHaveBeenCalledTimes(1);
    await getStripe();
    expect(boundary.retrieve).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await getStripe();
    expect(boundary.retrieve).toHaveBeenCalledTimes(2);
  });
  it("invalidates cache when either secret or expected platform rotates", async () => {
    const original = await getStripe();
    vi.stubEnv("STRIPE_TEST_SECRET_KEY", "sk_test_rotated");
    expect(await getStripe()).not.toBe(original);
    vi.stubEnv("STRIPE_TEST_PLATFORM_ACCOUNT_ID", "acct_rotated");
    boundary.retrieve.mockResolvedValue({ id: "acct_rotated" });
    await getStripe();
    expect(boundary.retrieve).toHaveBeenCalledTimes(3);
    expect(boundary.construct).toHaveBeenCalledTimes(3);
  });
  it("refuses explicit mode changes and account rotation inside a pinned request", async () => {
    await runWithBillingIdentity({ mode: "test", platformAccountId: "acct_synthetic" }, async () => {
      await expect(getStripe("live")).rejects.toThrow("configuration changed");
      vi.stubEnv("STRIPE_TEST_PLATFORM_ACCOUNT_ID", "acct_rotated");
      await expect(getStripe()).rejects.toThrow("configuration changed");
    });
    expect(boundary.retrieve).not.toHaveBeenCalled();
  });
  it("keeps concurrent Test and Live contexts isolated", async () => {
    await Promise.all((["test", "live"] as const).map((mode) =>
      runWithBillingIdentity({ mode, platformAccountId: "acct_synthetic" }, async () => {
        await Promise.resolve();
        expect((await getStripeCredentials()).secret).toBe(`sk_${mode}_synthetic`);
        await getStripe();
      }),
    ));
    expect(boundary.construct).toHaveBeenCalledTimes(2);
  });
});