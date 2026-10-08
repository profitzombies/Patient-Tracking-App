import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({ getStripe: vi.fn() }));
const originMocks = vi.hoisted(() => ({ publicOrigin: vi.fn(() => "https://ops.test") }));

vi.mock("./stripe-client", () => ({
  BillingConfigError: class BillingConfigError extends Error {},
  getStripe: stripeMocks.getStripe,
}));
vi.mock("./app-origin", () => ({ publicOrigin: originMocks.publicOrigin }));

import {
  apiVersionFamily, BILLING_WEBHOOK_EVENTS, ensureBillingWebhookEndpoints, evaluateWebhookEndpoint,
  EXPECTED_STRIPE_API_VERSION, getBillingWebhookHealth, getEndpointSecret, resetBillingWebhookHealthCache,
} from "./webhook-endpoints";

const DAHLIA = "2026-08-26.dahlia";
const BASIL = "2025-08-27.basil";
const CONNECT_EVENTS = [...BILLING_WEBHOOK_EVENTS.connect, "account.application.deauthorized"];

function endpoint(kind: "platform" | "connect", over: Partial<Stripe.WebhookEndpoint> = {}, mode: "test" | "live" = "live"): Stripe.WebhookEndpoint {
  return {
    id: `we_${kind}`, object: "webhook_endpoint", url: `https://ops.test/api/billing/webhooks/${mode}/${kind}`,
    status: "enabled", application: kind === "connect" ? "ca_123" : null, api_version: DAHLIA,
    enabled_events: kind === "connect" ? CONNECT_EVENTS : [...BILLING_WEBHOOK_EVENTS.platform],
    ...over,
  } as Stripe.WebhookEndpoint;
}

function evaluate(kind: "platform" | "connect", endpoints: Stripe.WebhookEndpoint[], over: { secretSet?: boolean; accountDefaultVersion?: string | null } = {}) {
  return evaluateWebhookEndpoint({
    kind, url: `https://ops.test/api/billing/webhooks/live/${kind}`, endpoints,
    secretSet: over.secretSet ?? true, accountDefaultVersion: over.accountDefaultVersion ?? null, expectedVersion: DAHLIA,
  });
}

function fakeStripe(endpoints: Stripe.WebhookEndpoint[], eventsVersion: string | null = null) {
  const list = vi.fn(async () => ({ data: endpoints }));
  const events = vi.fn(async () => ({ data: eventsVersion ? [{ api_version: eventsVersion }] : [] }));
  return { client: { webhookEndpoints: { list }, events: { list: events } }, list, events };
}

beforeEach(() => {
  resetBillingWebhookHealthCache();
  stripeMocks.getStripe.mockReset();
  originMocks.publicOrigin.mockReset().mockReturnValue("https://ops.test");
});
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

  it("requires the office-access events on the platform endpoint", () => {
    expect(BILLING_WEBHOOK_EVENTS.platform).toEqual(expect.arrayContaining([
      "account.application.deauthorized", "payment_intent.succeeded", "payment_intent.payment_failed",
      "charge.dispute.created", "setup_intent.succeeded", "setup_intent.setup_failed",
    ]));
    expect(BILLING_WEBHOOK_EVENTS.connect).toContain("payout.canceled");
  });

  it("reads our API version family from the SDK", () => {
    expect(apiVersionFamily(DAHLIA)).toBe("dahlia");
    expect(apiVersionFamily("not-a-version")).toBeNull();
    expect(apiVersionFamily(EXPECTED_STRIPE_API_VERSION)).toMatch(/^[a-z]+$/);
  });
});

describe("evaluateWebhookEndpoint", () => {
  it("reports problems in the order an operator fixes them", () => {
    expect(evaluate("connect", []).verdict).toBe("missing");
    expect(evaluate("connect", [endpoint("connect", { application: null, status: "disabled" })]).verdict).toBe("wrong_scope");
    expect(evaluate("platform", [endpoint("platform", { application: "ca_123" })]).verdict).toBe("wrong_scope");
    expect(evaluate("connect", [endpoint("connect", { status: "disabled", enabled_events: [] })]).verdict).toBe("disabled");
    expect(evaluate("connect", [endpoint("connect", { enabled_events: ["account.updated"] })], { secretSet: false })).toMatchObject({
      verdict: "missing_events", missingRequired: ["capability.updated"],
    });
    expect(evaluate("connect", [endpoint("connect", { api_version: BASIL })], { secretSet: false }).verdict).toBe("secret_missing");
    expect(evaluate("connect", [endpoint("connect", { api_version: BASIL, enabled_events: ["account.updated", "capability.updated"] })]).verdict).toBe("version_mismatch");
    expect(evaluate("connect", [endpoint("connect", { enabled_events: ["account.updated", "capability.updated"] })]).verdict).toBe("missing_recommended");
    expect(evaluate("connect", [endpoint("connect")]).verdict).toBe("ok");
  });

  it("fails a platform endpoint that only carries the disconnect notice", () => {
    const result = evaluate("platform", [endpoint("platform", { enabled_events: ["account.application.deauthorized"] })]);
    expect(result.verdict).toBe("missing_events");
    expect(result.missingRequired).toEqual(["payment_intent.succeeded", "payment_intent.payment_failed", "charge.dispute.created", "setup_intent.succeeded", "setup_intent.setup_failed"]);
  });

  it("judges an unpinned endpoint by the account default and never passes an unknown version", () => {
    const unpinned = [endpoint("platform", { api_version: null })];
    expect(evaluate("platform", unpinned, { accountDefaultVersion: BASIL })).toMatchObject({ verdict: "version_mismatch", apiVersion: BASIL, apiVersionSource: "account_default" });
    expect(evaluate("platform", unpinned, { accountDefaultVersion: "2026-09-30.dahlia" })).toMatchObject({ verdict: "ok", apiVersionSource: "account_default" });
    expect(evaluate("platform", unpinned)).toMatchObject({ verdict: "version_unknown", apiVersion: null, apiVersionSource: "unknown" });
    expect(evaluate("platform", [endpoint("platform", { api_version: "  " })])).toMatchObject({ verdict: "version_unknown", apiVersionSource: "unknown" });
    // An unreadable version string is just as unknown as a missing one.
    expect(evaluate("platform", [endpoint("platform", { api_version: "not-a-version" })])).toMatchObject({ verdict: "version_unknown", apiVersionSource: "endpoint" });
    expect(evaluate("platform", [endpoint("platform", { api_version: BASIL })])).toMatchObject({ verdict: "version_mismatch", apiVersionSource: "endpoint" });
  });

  it("accepts wildcard subscriptions and trailing slashes", () => {
    expect(evaluate("connect", [endpoint("connect", { enabled_events: ["*"], url: "https://ops.test/api/billing/webhooks/live/connect/" })]).verdict).toBe("ok");
  });
});

describe("getBillingWebhookHealth", () => {
  it("lists the requested mode's endpoints and reports each verdict", async () => {
    vi.stubEnv("STRIPE_LIVE_PLATFORM_WEBHOOK_SECRET", "whsec_platform");
    vi.stubEnv("STRIPE_LIVE_CONNECT_WEBHOOK_SECRET", "whsec_connect");
    const stripe = fakeStripe([endpoint("platform", { api_version: BASIL, enabled_events: ["account.application.deauthorized"] }), endpoint("connect")]);
    stripeMocks.getStripe.mockResolvedValue(stripe.client);
    const health = await getBillingWebhookHealth("live");
    expect(stripeMocks.getStripe).toHaveBeenCalledWith("live");
    expect(stripe.list).toHaveBeenCalledWith({ limit: 100 });
    expect(stripe.events).not.toHaveBeenCalled();
    expect(health).toMatchObject({ mode: "live", registered: false, expected_api_version: EXPECTED_STRIPE_API_VERSION, last_error: null });
    expect(health.endpoints[0]).toMatchObject({
      kind: "platform", url: "https://ops.test/api/billing/webhooks/live/platform", status: "missing_events",
      enabled_events: 1, api_version: BASIL, secret_configured: true,
    });
    expect(health.endpoints[0].missing_events).toContain("setup_intent.succeeded");
    expect(health.endpoints[1]).toMatchObject({ kind: "connect", status: EXPECTED_STRIPE_API_VERSION.endsWith(".dahlia") ? "ok" : "version_mismatch" });
  });

  it("is not registered while an unpinned endpoint's version cannot be read", async () => {
    vi.stubEnv("STRIPE_TEST_PLATFORM_WEBHOOK_SECRET", "whsec_platform");
    vi.stubEnv("STRIPE_TEST_CONNECT_WEBHOOK_SECRET", "whsec_connect");
    const stripe = fakeStripe([endpoint("platform", {}, "test"), endpoint("connect", { api_version: null }, "test")]);
    stripeMocks.getStripe.mockResolvedValue(stripe.client);
    const health = await getBillingWebhookHealth("test");
    expect(stripe.events).toHaveBeenCalledWith({ limit: 1 });
    expect(health.registered).toBe(false);
    expect(health.endpoints.map((row) => row.status)).toEqual([EXPECTED_STRIPE_API_VERSION.endsWith(".dahlia") ? "ok" : "version_mismatch", "version_unknown"]);
    expect(health.endpoints[1].api_version).toBeNull();
  });

  it("is registered only when both endpoints are fully ok, and caches the read per mode", async () => {
    vi.stubEnv("STRIPE_TEST_PLATFORM_WEBHOOK_SECRET", "whsec_platform");
    vi.stubEnv("STRIPE_TEST_CONNECT_WEBHOOK_SECRET", "whsec_connect");
    const stripe = fakeStripe([
      endpoint("platform", { api_version: null }, "test"), endpoint("connect", { api_version: null }, "test"),
    ], EXPECTED_STRIPE_API_VERSION);
    stripeMocks.getStripe.mockResolvedValue(stripe.client);
    const first = await getBillingWebhookHealth("test");
    expect(first.registered).toBe(true);
    expect(first.endpoints.map((row) => row.api_version)).toEqual([EXPECTED_STRIPE_API_VERSION, EXPECTED_STRIPE_API_VERSION]);
    await getBillingWebhookHealth("test");
    expect(stripe.list).toHaveBeenCalledTimes(1);
    resetBillingWebhookHealthCache();
    await getBillingWebhookHealth("test");
    expect(stripe.list).toHaveBeenCalledTimes(2);
  });

  it("never echoes vendor error text and marks endpoints unknown when Stripe cannot be asked", async () => {
    stripeMocks.getStripe.mockRejectedValue(Object.assign(new Error("sk_live_LEAKED"), { type: "StripeAuthenticationError" }));
    const health = await getBillingWebhookHealth("live");
    expect(JSON.stringify(health)).not.toContain("LEAKED");
    expect(health.last_error).toBe("Stripe webhook endpoints could not be listed. (StripeAuthenticationError)");
    expect(health.registered).toBe(false);
    expect(health.endpoints.map((row) => row.status)).toEqual(["unknown", "unknown"]);
  });

  it("reports a missing public origin without calling Stripe", async () => {
    originMocks.publicOrigin.mockImplementation(() => { throw new Error("BILLING_PUBLIC_ORIGIN https://user:pass@x"); });
    const health = await getBillingWebhookHealth("live");
    expect(stripeMocks.getStripe).not.toHaveBeenCalled();
    expect(health.last_error).toBe("The billing public origin is not configured.");
    expect(health.endpoints.every((row) => row.status === "unknown" && row.url === "")).toBe(true);
  });
});
