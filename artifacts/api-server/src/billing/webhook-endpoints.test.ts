import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureBillingWebhookEndpoints, getBillingWebhookHealth, getEndpointSecret } from "./webhook-endpoints";

vi.mock("./stripe-client", () => ({
  BillingConfigError: class extends Error {},
  isSandbox: async () => true,
}));
vi.mock("./app-origin", () => ({ publicOrigin: () => "https://ops.test" }));
afterEach(() => vi.unstubAllEnvs());
describe("portable webhook configuration", () => {
  it("selects only the exact mode and endpoint secret", async () => {
    vi.stubEnv("STRIPE_TEST_CONNECT_WEBHOOK_SECRET", "whsec_test");
    vi.stubEnv("STRIPE_LIVE_CONNECT_WEBHOOK_SECRET", "whsec_live");
    await expect(getEndpointSecret("connect", "test")).resolves.toBe("whsec_test");
    await expect(getEndpointSecret("connect", "live")).resolves.toBe("whsec_live");
    vi.stubEnv("STRIPE_TEST_PLATFORM_WEBHOOK_SECRET", "");
    await expect(getEndpointSecret("platform", "test")).rejects.toThrow("STRIPE_TEST_PLATFORM_WEBHOOK_SECRET");
  });
  it("never registers or deletes remote endpoints at startup", async () => {
    const fetch = vi.spyOn(global, "fetch");
    await ensureBillingWebhookEndpoints();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it("reports local configuration without claiming Dashboard registration", async () => {
    vi.stubEnv("STRIPE_TEST_CONNECT_WEBHOOK_SECRET", "whsec_test");
    vi.stubEnv("STRIPE_TEST_PLATFORM_WEBHOOK_SECRET", "whsec_platform");
    const health = await getBillingWebhookHealth();
    expect(health.registered).toBe(false);
    expect(health.endpoints.map((endpoint) => endpoint.status)).toEqual(["configured_unverified", "configured_unverified"]);
    expect(health.endpoints[1].url).toBe("https://ops.test/api/billing/webhooks/test/connect");
  });
});