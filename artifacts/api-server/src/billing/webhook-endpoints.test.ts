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
      list: vi.fn(() => ({ data: [], [Symbol.asyncIterator]: async function* () {} })),
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

  describe("stale workspace endpoint pruning", () => {
    const DAY = 24 * 60 * 60_000;
    const now = Date.parse("2026-09-17T12:00:00Z");
    const endpoint = (id: string, url: string, ageMs: number) => ({ id, url, status: "enabled", created: Math.floor((now - ageMs) / 1000) });
    // Stripe list results are async-iterable (auto-pagination); mirror that shape.
    const page = (data: any[]) => ({ data, [Symbol.asyncIterator]: async function* () { yield* data; } });
    const deadOnly = async (host: string) => !host.includes("-dead");
    const useWorkspaceOrigin = () => { process.env.BILLING_PUBLIC_ORIGIN = "https://abc-00-x.kirk.replit.dev"; };
    const restoreOrigin = () => { process.env.BILLING_PUBLIC_ORIGIN = "https://ops.test"; };

    it("does nothing when this origin is not a workspace domain", async () => {
      stripe.webhookEndpoints.list.mockReturnValue(page([
        endpoint("we_dead", "https://abc-00-x-dead1.kirk.replit.dev/api/billing/webhooks/connect", 3 * DAY),
      ]));
      const { pruneStaleWorkspaceEndpoints } = await import("./webhook-endpoints");
      await expect(pruneStaleWorkspaceEndpoints(stripe, "connect", now, deadOnly)).resolves.toBe(0);
      expect(stripe.webhookEndpoints.del).not.toHaveBeenCalled();
    });

    it("refuses to prune with live Stripe keys", async () => {
      useWorkspaceOrigin();
      __setCredentialsForTests({ secret: "sk_live_x", publishable: "pk_live_x", account_id: "acct_platform" });
      stripe.webhookEndpoints.list.mockReturnValue(page([
        endpoint("we_dead", "https://abc-00-x-dead1.kirk.replit.dev/api/billing/webhooks/connect", 3 * DAY),
      ]));
      try {
        const { pruneStaleWorkspaceEndpoints } = await import("./webhook-endpoints");
        await expect(pruneStaleWorkspaceEndpoints(stripe, "connect", now, deadOnly)).resolves.toBe(0);
        expect(stripe.webhookEndpoints.del).not.toHaveBeenCalled();
      } finally { restoreOrigin(); }
    });

    it("deletes only dead sibling workspace endpoints for the same route, across pages", async () => {
      useWorkspaceOrigin();
      const deleted: string[] = [];
      global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "DELETE") { deleted.push(String(input)); return response([]); }
        return response([]);
      }) as typeof fetch;
      const probed: string[] = [];
      const isAlive = async (host: string) => { probed.push(host); return deadOnly(host); };
      stripe.webhookEndpoints.list.mockReturnValue(page([
        endpoint("we_self", "https://abc-00-x.kirk.replit.dev/api/billing/webhooks/connect", 30 * DAY),
        endpoint("we_dead", "https://abc-00-x-dead1.kirk.replit.dev/api/billing/webhooks/connect", 3 * DAY),
        endpoint("we_dead_young", "https://abc-00-x-dead2.kirk.replit.dev/api/billing/webhooks/connect", DAY / 48),
        endpoint("we_live_old", "https://abc-00-x-livetask.kirk.replit.dev/api/billing/webhooks/connect", 30 * DAY),
        endpoint("we_other_kind", "https://abc-00-x-dead1.kirk.replit.dev/api/billing/webhooks/platform", 3 * DAY),
        endpoint("we_prod", "https://thinnr.replit.app/api/billing/webhooks/connect", 30 * DAY),
        endpoint("we_custom", "https://ops.thinnr.example/api/billing/webhooks/connect", 30 * DAY),
        endpoint("we_dead_page2", "https://abc-00-x-dead3.kirk.replit.dev/api/billing/webhooks/connect", 9 * DAY),
      ]));
      try {
        const { pruneStaleWorkspaceEndpoints } = await import("./webhook-endpoints");
        await expect(pruneStaleWorkspaceEndpoints(stripe, "connect", now, isAlive)).resolves.toBe(2);
        expect(stripe.webhookEndpoints.del.mock.calls.map((call: any[]) => call[0])).toEqual(["we_dead", "we_dead_page2"]);
        expect(probed.sort()).toEqual(["abc-00-x-dead1.kirk.replit.dev", "abc-00-x-dead3.kirk.replit.dev", "abc-00-x-livetask.kirk.replit.dev"]);
        expect(deleted.map(decodeURIComponent).join("\n")).toContain("abc-00-x-dead1.kirk.replit.dev/api/billing/webhooks/connect");
      } finally { restoreOrigin(); }
    });
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
