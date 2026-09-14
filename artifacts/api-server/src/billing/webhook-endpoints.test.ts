import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setCredentialsForTests, __setStripeForTests } from "./stripe-client";
import { ensureEndpoint, getBillingWebhookHealth, getEndpointSecret } from "./webhook-endpoints";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.BILLING_PUBLIC_ORIGIN = "https://ops.test";
});
const originalFetch = global.fetch;
const CONNECT_URL = "https://ops.test/api/billing/webhooks/connect";
let rows: Record<string, any>[];
let upserts: Record<string, any>[];
let stripe: any;
function response(json: unknown, status = 200) {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}
function missing(id: string) {
  return new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error", code: "resource_missing", message: `No such webhook endpoint: '${id}'`,
  } as any);
}
beforeEach(() => {
  rows = [{ kind: "connect", url: CONNECT_URL, stripe_endpoint_id: "we_old", secret: "whsec_old", livemode: false }];
  upserts = [];
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/billing_webhook_endpoints")) {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        upserts.push(body);
        rows = [body];
        return response([body]);
      }
      return response(rows.filter((row) => url.searchParams.get("url") === `eq.${row.url}`));
    }
    return response([]);
  }) as typeof fetch;
  stripe = {
    webhookEndpoints: {
      retrieve: vi.fn(async (id: string) => ({ id, status: "enabled" })),
      list: vi.fn(async () => ({ data: [] })),
      del: vi.fn(async () => ({})),
      create: vi.fn(async (params: any) => ({ id: "we_new", secret: "whsec_new", url: params.url })),
    },
  };
  __setStripeForTests(stripe);
  __setCredentialsForTests({ secret: "sk_test_x", publishable: "pk_test_x", account_id: "acct_platform" });
});
afterAll(() => {
  global.fetch = originalFetch;
  __setStripeForTests(null);
  __setCredentialsForTests(null);
});

describe("billing webhook endpoint registration", () => {
  it("keeps a saved endpoint that still exists on the connected Stripe account", async () => {
    await ensureEndpoint("connect");
    expect(stripe.webhookEndpoints.retrieve).toHaveBeenCalledWith("we_old");
    expect(stripe.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
    await expect(getEndpointSecret("connect")).resolves.toBe("whsec_old");
  });

  it("re-registers when the saved endpoint belongs to a previous Stripe account", async () => {
    stripe.webhookEndpoints.retrieve.mockImplementation(async (id: string) => { throw missing(id); });
    await ensureEndpoint("connect");
    expect(stripe.webhookEndpoints.create).toHaveBeenCalledTimes(1);
    expect(stripe.webhookEndpoints.create.mock.calls[0][0]).toMatchObject({ url: CONNECT_URL, connect: true });
    expect(upserts).toEqual([
      expect.objectContaining({ kind: "connect", url: CONNECT_URL, stripe_endpoint_id: "we_new", secret: "whsec_new", livemode: false }),
    ]);
    await expect(getEndpointSecret("connect")).resolves.toBe("whsec_new");
  });

  it("surfaces non-missing Stripe failures instead of silently re-creating", async () => {
    stripe.webhookEndpoints.retrieve.mockImplementation(async () => {
      throw new Stripe.errors.StripeAuthenticationError({ type: "authentication_error", message: "bad key" } as any);
    });
    await expect(ensureEndpoint("connect")).rejects.toThrow("bad key");
    expect(stripe.webhookEndpoints.create).not.toHaveBeenCalled();
  });

  it("reports enabled endpoints without exposing signing secrets", async () => {
    rows.push({ kind: "platform", url: "https://ops.test/api/billing/webhooks/platform",
      stripe_endpoint_id: "we_platform", secret: "whsec_platform", livemode: false });
    stripe.webhookEndpoints.retrieve.mockImplementation(async (id: string) => ({
      id, status: "enabled", enabled_events: id === "we_old" ? ["invoice.paid"] : ["account.updated"],
    }));
    const health = await getBillingWebhookHealth();
    expect(health).toMatchObject({ registered: true, last_error: null });
    expect(health.endpoints).toEqual([
      expect.objectContaining({ kind: "platform", status: "enabled", enabled_events: 1 }),
      expect.objectContaining({ kind: "connect", status: "enabled", enabled_events: 1 }),
    ]);
    expect(JSON.stringify(health)).not.toContain("whsec");
  });
});
