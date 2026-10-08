import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

const mocks = vi.hoisted(() => ({
  selection: vi.fn(),
  status: vi.fn(),
  getStripe: vi.fn(),
  clientId: vi.fn(),
  webhooks: vi.fn(),
  origin: vi.fn(),
  selectMany: vi.fn(),
  supabaseAdmin: vi.fn(),
  scopes: [] as Array<{ table: string; identity: unknown }>,
}));

vi.mock("../lib/staff-auth", async (original) => ({
  ...(await original<typeof import("../lib/staff-auth")>()),
  requireHqPermission: () => (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.staff = { userId: "hq-user", role: "hq_admin", departmentRole: "admin" };
    next();
  },
}));
vi.mock("../billing/mode-state", async (original) => ({
  ...(await original<typeof import("../billing/mode-state")>()),
  getBillingModeSelection: mocks.selection,
  getBillingModeStatus: mocks.status,
}));
vi.mock("../billing/stripe-client", async (original) => ({
  ...(await original<typeof import("../billing/stripe-client")>()),
  getStripe: mocks.getStripe,
  getConnectClientId: mocks.clientId,
}));
vi.mock("../billing/webhook-endpoints", async (original) => ({
  ...(await original<typeof import("../billing/webhook-endpoints")>()),
  getBillingWebhookHealth: mocks.webhooks,
}));
vi.mock("../billing/app-origin", async (original) => ({
  ...(await original<typeof import("../billing/app-origin")>()),
  publicOrigin: mocks.origin,
}));
vi.mock("../billing/store", async (original) => ({
  ...(await original<typeof import("../billing/store")>()),
  selectMany: mocks.selectMany,
}));
vi.mock("../lib/supabase-admin", async (original) => ({
  ...(await original<typeof import("../lib/supabase-admin")>()),
  supabaseAdmin: mocks.supabaseAdmin,
}));

import router from "./billing-hq";
import { currentBillingIdentity } from "../billing/stripe-environment";

let server: http.Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const webhookHealth = (mode: "test" | "live") => ({
  mode, registered: true, expected_api_version: "2026-08-26.dahlia", endpoints: [], last_error: null, last_checked_at: "2026-10-08T00:00:00.000Z",
});

beforeEach(() => {
  mocks.scopes.length = 0;
  mocks.selection.mockReset().mockResolvedValue({ mode: "live", version: 3, platformAccountId: "acct_live" });
  mocks.status.mockReset().mockResolvedValue({ mode: "live", version: 3, platformAccountId: "acct_live" });
  mocks.getStripe.mockReset().mockResolvedValue({});
  mocks.clientId.mockReset().mockReturnValue("ca_live");
  mocks.webhooks.mockReset().mockImplementation(async (mode: "test" | "live") => webhookHealth(mode));
  mocks.origin.mockReset().mockReturnValue("https://app.trythinnr.com");
  mocks.selectMany.mockReset().mockImplementation(async (table: string, query: string) => {
    mocks.scopes.push({ table, identity: currentBillingIdentity() ?? null });
    if (table === "billing_webhook_events" && query.startsWith("processed_at=is.null")) return [{ stripe_event_id: "evt_1" }, { stripe_event_id: "evt_2" }];
    if (table === "billing_webhook_events" && query.startsWith("order=received_at")) return [{ received_at: "2026-10-08T01:00:00.000Z" }];
    if (table === "billing_connected_accounts") return [{ provider_id: "office-1", stripe_customer_emails: "off" }];
    return [];
  });
  mocks.supabaseAdmin.mockReset().mockResolvedValue({ status: 200, json: [{ started_at: "2026-10-08T00:30:00.000Z", status: "succeeded" }] });
});

async function health() {
  const res = await fetch(`${base}/billing/hq/health`, { headers: { Authorization: "Bearer hq" } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /billing/hq/health", () => {
  it("reports the selected Live mode and reads its ledger under the Live identity", async () => {
    const { status, json } = await health();
    expect(status).toBe(200);
    expect(mocks.getStripe).toHaveBeenCalledWith("live");
    expect(mocks.clientId).toHaveBeenCalledWith("live");
    expect(mocks.webhooks).toHaveBeenCalledWith("live");
    expect(json).toMatchObject({
      sandbox: false, livemode: true, credentials_ok: true, connect_client_id_configured: true,
      public_origin: "https://app.trythinnr.com", unprocessed_webhook_events: 2,
      last_webhook_received_at: "2026-10-08T01:00:00.000Z",
      last_reconcile_run: { at: "2026-10-08T00:30:00.000Z", status: "succeeded" },
      webhooks: { mode: "live", registered: true },
      stripe_customer_emails: { accounts_off: 1, accounts_on: [], accounts_unverified: [] },
    });
    expect(mocks.scopes).toHaveLength(5);
    expect(mocks.scopes.every((row) => JSON.stringify(row.identity) === JSON.stringify({ mode: "live", platformAccountId: "acct_live" }))).toBe(true);
  });

  it("checks the Test setup while Test is selected", async () => {
    mocks.selection.mockResolvedValue({ mode: "test", version: 2, platformAccountId: "acct_test" });
    mocks.status.mockResolvedValue({ mode: "test", version: 2, platformAccountId: "acct_test" });
    const { json } = await health();
    expect(mocks.webhooks).toHaveBeenCalledWith("test");
    expect(mocks.getStripe).toHaveBeenCalledWith("test");
    expect(json).toMatchObject({ sandbox: true, livemode: false, credentials_ok: true, webhooks: { mode: "test" } });
    expect(mocks.scopes.every((row) => (row.identity as { mode: string }).mode === "test")).toBe(true);
  });

  it("still answers when the Live keys fail, scoping reads to the recorded platform account", async () => {
    mocks.status.mockRejectedValue(new Error("The configured Stripe account changed."));
    const { status, json } = await health();
    expect(status).toBe(200);
    expect(json).toMatchObject({ sandbox: false, livemode: false, credentials_ok: false });
    expect(mocks.scopes.every((row) => JSON.stringify(row.identity) === JSON.stringify({ mode: "live", platformAccountId: "acct_live" }))).toBe(true);
  });

  it("never reads the ledger unscoped when no platform account is known", async () => {
    mocks.selection.mockResolvedValue({ mode: "live", version: 1, platformAccountId: null });
    mocks.status.mockRejectedValue(new Error("keys missing"));
    const { status, json } = await health();
    expect(status).toBe(200);
    expect(mocks.selectMany).not.toHaveBeenCalled();
    expect(json).toMatchObject({ credentials_ok: false, unprocessed_webhook_events: 0, last_webhook_received_at: null });
  });

  it("reports an invalid Connect client id as not configured instead of failing", async () => {
    mocks.clientId.mockImplementation(() => { throw new Error("Stripe Connect client ID is invalid."); });
    const { status, json } = await health();
    expect(status).toBe(200);
    expect(json.connect_client_id_configured).toBe(false);
  });

  it("answers 503 when the selected mode cannot be read", async () => {
    mocks.selection.mockRejectedValue(new Error("db down"));
    const { status, json } = await health();
    expect(status).toBe(503);
    expect(json).toEqual({ error: "Payments health is temporarily unavailable." });
    expect(mocks.webhooks).not.toHaveBeenCalled();
  });
});
