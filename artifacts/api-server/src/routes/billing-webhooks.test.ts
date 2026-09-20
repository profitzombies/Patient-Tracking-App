import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../billing/webhook-handlers", () => ({ registerBillingWebhookHandlers: vi.fn(async () => undefined) }));
vi.mock("../billing/webhooks", async (original) => ({
  ...(await original<typeof import("../billing/webhooks")>()),
  dispatchStripeEvent: dispatch,
}));
vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

import router from "./billing-webhooks";
import { __setStripeForTests, __setCredentialsForTests } from "../billing/stripe-client";

const secret = "whsec_test_secret";
const stripe = new Stripe("sk_test_fake");
const originalFetch = global.fetch;
let server: http.Server;
let base = "";
type EventRow = {
  stripe_event_id: string; claimed_at: string | null; processed_at: string | null;
  error: string | null; [key: string]: unknown;
};
let events = new Map<string, EventRow>();

function response(body: unknown, status = 200): Response {
  return new Response(body == null ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function post(payload: string, signature?: string) {
  const res = await originalFetch(`${base}/test/connect`, {
    method: "POST", body: payload,
    headers: { "Content-Type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
beforeAll(async () => {
  const app = express();
  app.use(router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  global.fetch = originalFetch;
  __setStripeForTests(null);
  __setCredentialsForTests(null);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
  events = new Map();
  dispatch.mockReset().mockResolvedValue(undefined);
  __setStripeForTests(stripe);
  __setCredentialsForTests({ secret: "sk_test_fake", publishable: "pk_test_fake", account_id: "acct_platform" });
  process.env.STRIPE_TEST_CONNECT_WEBHOOK_SECRET = secret;
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    if (url.pathname === "/rest/v1/billing_webhook_endpoints") {
      return response([{ id: "endpoint", kind: "connect", url: "https://example/api/billing/webhooks/connect",
        stripe_endpoint_id: "we_1", secret, livemode: false, created_at: "2026-01-01T00:00:00Z" }]);
    }
    if (url.pathname === "/rest/v1/billing_webhook_events" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as EventRow;
      if (events.has(body.stripe_event_id)) return response({ message: "duplicate key" }, 409);
      events.set(body.stripe_event_id, body);
      return response([body], 201);
    }
    if (url.pathname === "/rest/v1/billing_webhook_events" && method === "GET") {
      const id = decodeURIComponent(String(url.searchParams.get("stripe_event_id") ?? "").replace("eq.", ""));
      return response(events.has(id) ? [events.get(id)] : []);
    }
    if (url.pathname === "/rest/v1/billing_webhook_events" && method === "PATCH") {
      const id = decodeURIComponent(String(url.searchParams.get("stripe_event_id") ?? "").replace("eq.", ""));
      const row = events.get(id);
      if (!row || row.processed_at) return response([]);
      const oldClaim = url.searchParams.get("claimed_at");
      const matches = !oldClaim || (oldClaim === "is.null" ? row.claimed_at === null
        : row.claimed_at === decodeURIComponent(oldClaim.replace("eq.", "")));
      if (!matches) return response([]);
      const body = JSON.parse(String(init?.body)) as Partial<EventRow>;
      const updated = { ...row, ...body };
      events.set(id, updated);
      return response([updated]);
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
});
function fixture(id = "evt_once") {
  const payload = JSON.stringify({
    id, object: "event", api_version: "2025-12-15.clover", created: 1,
    data: { object: { id: "acct_1", object: "account" } }, livemode: false,
    pending_webhooks: 1, request: null, type: "account.updated", account: "acct_1",
  });
  return { payload, signature: stripe.webhooks.generateTestHeaderString({ payload, secret }) };
}
describe("billing webhooks", () => {
  it("refuses legacy URLs instead of guessing the active mode", async () => {
    const result = await originalFetch(`${base}/connect`, { method: "POST" });
    expect(result.status).toBe(410);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("rejects a correctly signed event from the wrong mode before claiming", async () => {
    const payload = JSON.stringify({ id: "evt_wrong_mode", type: "account.updated", livemode: true, account: "acct_1" });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect((await post(payload, signature)).status).toBe(400);
    expect(events.size).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("requires a connected account on connect deliveries", async () => {
    const payload = JSON.stringify({ id: "evt_no_account", type: "account.updated", livemode: false });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect((await post(payload, signature)).status).toBe(400);
    expect(events.size).toBe(0);
  });
  it("rejects missing and bad signatures without dispatching", async () => {
    expect((await post("{}")).status).toBe(400);
    expect((await post("{}", "bad")).status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("dispatches a valid signed event once and ignores an already-processed replay", async () => {
    const event = fixture();
    expect((await post(event.payload, event.signature)).status).toBe(200);
    expect((await post(event.payload, event.signature)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(events.get("evt_once")?.processed_at).toBeTruthy();
  });
  it("reclaims a failed event and completes it on a successful retry", async () => {
    dispatch.mockRejectedValueOnce(new Error("handler failed"));
    const event = fixture("evt_fail");
    expect((await post(event.payload, event.signature)).status).toBe(500);
    expect(events.get("evt_fail")).toMatchObject({ processed_at: null, error: "handler failed" });
    expect((await post(event.payload, event.signature)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(events.get("evt_fail")?.processed_at).toBeTruthy();
    expect(events.get("evt_fail")?.error).toBeNull();
  });
  it("returns non-200 for a concurrent duplicate while its lease is fresh", async () => {
    const event = fixture("evt_busy");
    events.set("evt_busy", {
      stripe_event_id: "evt_busy", claimed_at: new Date().toISOString(),
      processed_at: null, error: null,
    });
    const result = await post(event.payload, event.signature);
    expect(result.status).toBe(500);
    expect(result.json).toMatchObject({ received: true, in_progress: true });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("answers an already-processed duplicate without dispatching", async () => {
    const event = fixture("evt_done");
    events.set("evt_done", {
      stripe_event_id: "evt_done", claimed_at: new Date().toISOString(),
      processed_at: new Date().toISOString(), error: null,
    });
    const result = await post(event.payload, event.signature);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ received: true, duplicate: true });
    expect(dispatch).not.toHaveBeenCalled();
  });
});