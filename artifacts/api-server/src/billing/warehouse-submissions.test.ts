import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// A live tenant needs the flag AND the complete live login (WAREHOUSECRAFT_API_*).
beforeEach(() => {
  vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "live");
  for (const name of LIVE_WAREHOUSE_LOGIN) vi.stubEnv(name, `live-${name.toLowerCase()}`);
});
afterEach(() => vi.unstubAllEnvs());
import type { JobContext } from "../jobs/types";
import { LIVE_WAREHOUSE_LOGIN, WarehouseCraftError } from "../shipping/warehousecraft";
import type { WarehouseOrder, WarehouseOrderClient } from "../shipping/warehousecraft-orders";

/**
 * In-memory PostgREST stand-in: enough of the eq/in/lte/order/limit grammar for
 * the submission queue. Every write is recorded so the tests can assert the
 * exact state transitions, not just the return value.
 */
const state = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  writes: [] as Array<{ op: string; table: string; patch?: any }>,
  admin: [] as Array<{ method: string; path: string; body?: any }>,
  recipients: [{ auth_user_id: "hq-1", email: "hq@example.test", display_name: "HQ Admin" }] as any[],
}));

vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (method: string, path: string, body?: any) => {
    state.admin.push({ method, path, body });
    if (path.startsWith("/rest/v1/hq_memberships")) return { status: 200, json: state.recipients };
    // No office is offboarding in these fixtures; the job's exclusion scan sees an empty set.
    if (path.startsWith("/rest/v1/providers?or=(offboarding_status.in.")) return { status: 200, json: [] };
    if (path.startsWith("/rest/v1/staff_notifications")) {
      state.tables.staff_notifications ??= [];
      state.tables.staff_notifications.push(...(Array.isArray(body) ? body : [body]));
      return { status: 201, json: body };
    }
    return { status: 404, json: null };
  }),
}));
vi.mock("./customer-emails", () => ({ notifyShipmentTransition: vi.fn() }));
vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  const rows = (table: string) => (state.tables[table] ??= []);
  const parse = (query: string) => {
    const params = new URLSearchParams(query);
    const filters: Array<(row: any) => boolean> = [];
    let order: Array<[string, string]> = [];
    let limit = Infinity;
    for (const [key, value] of params) {
      if (key === "select") continue;
      if (key === "order") { order = value.split(",").map((part) => part.split(".") as [string, string]); continue; }
      if (key === "limit") { limit = Number(value); continue; }
      if (key === "or") {
        // or=(col.is.null,col.not.like.Prefix*): the drain's "not already held" filter.
        const terms = value.slice(1, -1).split(",").map((term) => {
          const isNull = /^([a-z_]+)\.is\.null$/.exec(term); const notLike = /^([a-z_]+)\.not\.like\.(.*)\*$/.exec(term);
          if (isNull) return (row: any) => row[isNull[1]] == null;
          if (notLike) return (row: any) => row[notLike[1]] != null && !String(row[notLike[1]]).startsWith(notLike[2]);
          throw new Error(`fake store: unsupported or term ${term}`);
        });
        filters.push((row) => terms.some((term) => term(row)));
        continue;
      }
      const eq = /^eq\.(.*)$/.exec(value); const lte = /^lte\.(.*)$/.exec(value); const gte = /^gte\.(.*)$/.exec(value); const inList = /^in\.\((.*)\)$/.exec(value);
      if (eq) filters.push((row) => String(row[key]) === eq[1]);
      else if (lte) filters.push((row) => row[key] != null && String(row[key]) <= lte[1]);
      else if (gte) filters.push((row) => row[key] != null && String(row[key]) >= gte[1]);
      else if (inList) { const set = new Set(inList[1].split(",").map((v) => v.replace(/^"|"$/g, ""))); filters.push((row) => set.has(String(row[key]))); }
      else throw new Error(`fake store: unsupported filter ${key}=${value}`);
    }
    return { filters, order, limit };
  };
  const select = (table: string, query: string) => {
    const { filters, order, limit } = parse(query);
    let out = rows(table).filter((row) => filters.every((filter) => filter(row)));
    if (order.length) out = [...out].sort((a, b) => {
      for (const [column, direction] of order) {
        const av = String(a[column] ?? ""); const bv = String(b[column] ?? "");
        if (av !== bv) return (av < bv ? -1 : 1) * (direction === "desc" ? -1 : 1);
      }
      return 0;
    });
    return out.slice(0, Number.isFinite(limit) ? limit : undefined);
  };
  let seq = 0;
  return {
    ...actual,
    nowIso: () => "2026-09-18T12:00:00.000Z",
    selectOne: vi.fn(async (table: string, query: string) => select(table, query)[0] ?? null),
    selectMany: vi.fn(async (table: string, query: string) => select(table, query)),
    update: vi.fn(async (table: string, query: string, patch: any) => {
      state.writes.push({ op: "update", table, patch });
      const row = select(table, query)[0];
      if (row) Object.assign(row, patch);
      return row ? { ...row } : null;
    }),
    insert: vi.fn(async (table: string, row: any) => { const full = { id: `${table}-${++seq}`, created_at: "2026-09-18T12:00:00.000Z", ...row }; rows(table).push(full); state.writes.push({ op: "insert", table, patch: full }); return full; }),
    insertIgnore: vi.fn(async (table: string, row: any) => {
      const key = table === "billing_shipments" || table === "billing_warehouse_submissions" ? "order_id" : "id";
      if (rows(table).some((existing) => existing[key] === row[key])) return null;
      const full = { id: `${table}-${++seq}`, created_at: "2026-09-18T12:00:00.000Z", ...row };
      rows(table).push(full); state.writes.push({ op: "insertIgnore", table, patch: full }); return full;
    }),
  };
});

import { BACKOFF_CAP_MS, HELD_LIVE_ORDER_MESSAGE, HOLD_RECHECK_MS, MAX_ATTEMPTS, SKIPPED_SANDBOX_REASON, backoffMs, cancelAtWarehouse, ensureSubmission, payloadForOrder, retrySubmission, submitOne, syncSubscriptionAddress, tenantVerdict, warehouseDto, warehouseHealth } from "./warehouse-submissions";
import { BATCH_SIZE, runWarehouseSubmit, warehouseSubmitJob } from "../jobs/definitions/warehouse-submit";
import { __setSandboxVerificationsForTests } from "./sandbox-verification";

const ADDRESS = { name: "Pat Example", line1: "123 Test Street", line2: null, city: "Memphis", state: "TN", postal_code: "38103", country: "US", phone: "9015550100" };
const NOW = new Date("2026-09-18T12:00:00.000Z");

function order(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    livemode: true,
    id: "ord-1", order_number: "TH-000123", provider_id: "office-1", patient_id: "pat-1", payer_id: "payer-1", subscription_id: null,
    kind: "one_time", status: "paid", fulfillment_status: "to_ship", shipping_address: ADDRESS, shipping_method: "standard",
    paid_at: "2026-09-18T11:58:00.000Z", created_at: "2026-09-18T11:57:00.000Z", carrier: null, tracking_number: null, shipped_at: null, canceled_reason: null, shipped_by: null,
    ...overrides,
  } as any;
}
function item(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: "item-1", order_id: "ord-1", product_id: "prod-1", product_name_snapshot: "Meal Replacement Shake", quantity: 2, unit_price_cents: 4900, warehousecraft_sku_snapshot: "Test01", created_at: "2026-09-18T11:57:00.000Z", ...overrides } as any;
}
function submission(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: "sub-1", order_id: "ord-1", provider_id: "office-1", patient_id: "pat-1", state: "pending", attempts: 0, next_attempt_at: "2026-09-18T11:59:00.000Z", warehouse_order_id: null, warehouse_status: null, last_error: null, last_error_kind: null, last_attempt_at: null, sent_at: null, skipped_reason: null, payload: null, created_at: "2026-09-18T11:58:00.000Z", ...overrides } as any;
}
function seed(input: { orders?: any[]; items?: any[]; submissions?: any[]; shipments?: any[]; settings?: any } = {}) {
  state.tables = {
    billing_orders: input.orders ?? [order()], billing_order_items: input.items ?? [item()],
    billing_payers: [{ id: "payer-1", email: "pat@example.test" }],
    billing_warehouse_submissions: input.submissions ?? [submission()], billing_shipments: input.shipments ?? [],
    billing_settings: [input.settings ?? { id: 1, warehouse_auto_submit: true }], staff_notifications: [],
  };
}
function fakeClient(overrides: Partial<WarehouseOrderClient> = {}): WarehouseOrderClient & { calls: string[] } {
  const calls: string[] = [];
  const wrap = <K extends keyof WarehouseOrderClient>(name: K, impl: WarehouseOrderClient[K]) => (async (...args: any[]) => { calls.push(name); return (impl as any)(...args); }) as WarehouseOrderClient[K];
  return {
    calls,
    create: wrap("create", overrides.create ?? (async () => ({ kind: "created", order_id: 1436119 }))),
    lookup: wrap("lookup", overrides.lookup ?? (async () => null)),
    editAddress: wrap("editAddress", overrides.editAddress ?? (async () => liveOrder("Imported"))),
    cancel: wrap("cancel", overrides.cancel ?? (async () => liveOrder("Cancelled"))),
  };
}
const liveOrder = (status: string, id = 1436119, clientOrderId = "TH-000123"): WarehouseOrder => ({ order_id: id, client_order_id: clientOrderId, status, shipping_method: "USPS Ground Advantage", address: { ...ADDRESS, line2: null }, lines: [{ sku: "Test01", quantity: 2 }] });
const sub = () => state.tables.billing_warehouse_submissions[0];
const shipment = () => state.tables.billing_shipments[0];

beforeEach(() => { state.writes = []; state.admin = []; seed(); });

describe("payloadForOrder", () => {
  it("builds the create body from the order, item snapshots, and payer email (renewals carry a note)", () => {
    const payload = payloadForOrder(order({ kind: "subscription_renewal", shipping_method: "expedited" }), [item(), item({ id: "item-2", warehousecraft_sku_snapshot: "Test03", quantity: 1, unit_price_cents: 1950 })], { email: "pat@example.test" });
    expect(payload).toMatchObject({ ClientOrderId: "TH-000123", ShippingMethod: "USPS_PriorityMail", Email: "pat@example.test", NotesToWarehouse: "Subscription renewal", AddressLine1: "123 Test Street", PostalCode: "38103" });
    expect(payload.OrderDetailData).toEqual([{ ItemSKU: "Test01", ItemQuantity: 2, ItemPrice: 49 }, { ItemSKU: "Test03", ItemQuantity: 1, ItemPrice: 19.5 }]);
    expect(payload.OrderDate).toBe("2026-09-18T11:58:00");
  });
  it("defaults to standard shipping for legacy orders without a method", () => {
    expect(payloadForOrder(order({ shipping_method: undefined }), [item()], null).ShippingMethod).toBe("USPS_GroundAdvantage");
  });
});

describe("ensureSubmission", () => {
  it("creates one pending intent per paid order and is idempotent", async () => {
    seed({ submissions: [] });
    const first = await ensureSubmission(order());
    const second = await ensureSubmission(order());
    expect(first?.state).toBe("pending");
    expect(second?.id).toBe(first?.id);
    expect(state.tables.billing_warehouse_submissions).toHaveLength(1);
  });
  it("never queues an unpaid order", async () => {
    seed({ submissions: [] });
    expect(await ensureSubmission(order({ status: "pending" }))).toBeNull();
    expect(state.tables.billing_warehouse_submissions).toHaveLength(0);
  });
});

describe("submitOne", () => {
  it("sends the order, stores the warehouse id, and mirrors Sent onto the shipment row", async () => {
    const client = fakeClient();
    await expect(submitOne(sub(), { client, now: () => NOW })).resolves.toBe("sent");
    expect(sub()).toMatchObject({ state: "sent", attempts: 1, warehouse_order_id: "1436119", sent_at: NOW.toISOString(), last_error: null });
    expect(sub().payload).toMatchObject({ ClientOrderId: "TH-000123" });
    expect(shipment()).toMatchObject({ order_id: "ord-1", warehouse_state: "sent", warehouse_order_id: "1436119", warehouse_sent_at: NOW.toISOString() });
    expect(state.tables.staff_notifications).toHaveLength(0);
  });
  it("treats a duplicate ClientOrderId as success after looking the order up (crash-after-accept is never a second order)", async () => {
    const client = fakeClient({ create: async () => ({ kind: "duplicate", order_id: null }), lookup: async () => liveOrder("Committed", 777) });
    await expect(submitOne(sub(), { client, now: () => NOW })).resolves.toBe("duplicate");
    expect(client.calls).toEqual(["create", "lookup"]);
    expect(sub()).toMatchObject({ state: "sent", warehouse_order_id: "777", warehouse_status: "Committed" });
  });
  it("parks a definite rejection as Needs attention with the warehouse's message and alerts HQ once", async () => {
    const client = fakeClient({ create: async () => ({ kind: "rejected", message: "ItemSKU not recognized: BOGUS" }) });
    await expect(submitOne(sub(), { client, now: () => NOW })).resolves.toBe("rejected");
    expect(sub()).toMatchObject({ state: "needs_attention", attempts: 1, last_error: "ItemSKU not recognized: BOGUS", last_error_kind: "rejected" });
    expect(shipment()).toMatchObject({ warehouse_state: "needs_attention", warehouse_error: "ItemSKU not recognized: BOGUS" });
    expect(state.tables.staff_notifications).toHaveLength(1);
    expect(state.tables.staff_notifications[0]).toMatchObject({ provider_id: null, auth_user_id: "hq-1", channel: "email", kind: "system_threshold", title: "Warehouse rejected order TH-000123", dedupe_key: "warehouse_submission:ord-1:hq-1:email" });
    expect(state.admin.find((call) => call.path.startsWith("/rest/v1/staff_notifications"))?.path).toContain("on_conflict=dedupe_key");
  });
  it("classifies an unbuildable payload (missing SKU) as Needs attention without calling the warehouse", async () => {
    seed({ items: [item({ warehousecraft_sku_snapshot: null })] });
    const client = fakeClient();
    await expect(submitOne(sub(), { client, now: () => NOW })).resolves.toBe("rejected");
    expect(client.calls).toEqual([]);
    expect(sub()).toMatchObject({ state: "needs_attention", last_error_kind: "incomplete", last_error: expect.stringMatching(/No WarehouseCraft SKU for: Meal Replacement Shake/) });
  });
  it("keeps a transient failure pending with exponential backoff and no alert", async () => {
    const client = fakeClient({ create: async () => { throw new WarehouseCraftError("WarehouseCraft HTTP 503: down", "transient", 503); } });
    await expect(submitOne(sub(), { client, now: () => NOW })).resolves.toBe("retry");
    expect(sub()).toMatchObject({ state: "pending", attempts: 1, last_error_kind: "transient", next_attempt_at: new Date(NOW.getTime() + 2 * 60_000).toISOString() });
    expect(state.tables.staff_notifications).toHaveLength(0);
    expect(state.tables.billing_shipments).toHaveLength(0);
    seed({ submissions: [submission({ attempts: 4 })] });
    await submitOne(sub(), { client, now: () => NOW });
    expect(sub().next_attempt_at).toBe(new Date(NOW.getTime() + backoffMs(5)).toISOString());
  });
  it("bounds the backoff and gives up into Needs attention after the attempt budget", async () => {
    expect(backoffMs(1)).toBe(2 * 60_000);
    expect(backoffMs(20)).toBe(BACKOFF_CAP_MS);
    seed({ submissions: [submission({ attempts: MAX_ATTEMPTS - 1 })] });
    const client = fakeClient({ create: async () => { throw new WarehouseCraftError("unreachable", "transient", null); } });
    await expect(submitOne(sub(), { client, now: () => NOW })).resolves.toBe("exhausted");
    expect(sub()).toMatchObject({ state: "needs_attention", attempts: MAX_ATTEMPTS, last_error: expect.stringMatching(/gave up after 12 attempts/) });
    expect(state.tables.staff_notifications).toHaveLength(1);
  });
  it("skips intents whose order was canceled or refunded before the drain reached them", async () => {
    seed({ orders: [order({ fulfillment_status: "canceled" })] });
    const client = fakeClient();
    await expect(submitOne(sub(), { client, now: () => NOW })).resolves.toBe("skipped");
    expect(client.calls).toEqual([]);
    expect(sub()).toMatchObject({ state: "skipped", skipped_reason: "order canceled before submission" });
    expect(shipment()).toMatchObject({ warehouse_state: "skipped" });
  });
});

describe("tenant guard", () => {
  it("routes real orders to the live tenant only and sandbox orders to the test tenant only", () => {
    expect(tenantVerdict({ livemode: true }, "live")).toBe("send");
    expect(tenantVerdict({ livemode: false }, "test")).toBe("skip");
    expect(tenantVerdict({ livemode: true }, "test")).toBe("hold");
    expect(tenantVerdict({ livemode: false }, "live")).toBe("skip");
    // Legacy rows without the flag are treated as sandbox (never sent to a live tenant by accident).
    expect(tenantVerdict({ livemode: undefined as unknown as boolean }, "live")).toBe("skip");
  });
  it("is live only with the flag (live/production/prod) AND the complete live login, and each tenant signs in with its own login", async () => {
    const { missingLiveWarehouseLogin, requestedWarehouseTenant, warehouseCraftConfig, warehouseTenantMode } = await import("../shipping/warehousecraft");
    const login = { WAREHOUSECRAFT_API_BASE_URL: "live.example.test", WAREHOUSECRAFT_API_USERNAME: "live-user", WAREHOUSECRAFT_API_PASSWORD: "live-pass" };
    const novex = { NOVEX_API_BASE_URL: "novex.example.test", NOVEX_API_USERNAME: "novex-user", NOVEX_API_PASSWORD: "novex-pass" };
    const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    expect(warehouseTenantMode({ ...novex, ...login })).toBe("test");
    for (const value of ["live", "LIVE", "production", "prod"]) expect(warehouseTenantMode({ ...novex, ...login, WAREHOUSECRAFT_TENANT_MODE: value })).toBe("live");
    expect(warehouseTenantMode({ ...novex, ...login, WAREHOUSECRAFT_TENANT_MODE: "sandbox" })).toBe("test");
    // The flag with only the test tenant's login (or a partial live one) stays on the test tenant.
    const flagOnly = { ...novex, WAREHOUSECRAFT_TENANT_MODE: "live" };
    expect(requestedWarehouseTenant(flagOnly)).toBe("live");
    expect(missingLiveWarehouseLogin(flagOnly)).toEqual([...LIVE_WAREHOUSE_LOGIN]);
    expect(warehouseTenantMode(flagOnly)).toBe("test");
    expect(missingLiveWarehouseLogin({ ...flagOnly, ...login, WAREHOUSECRAFT_API_PASSWORD: " " })).toEqual(["WAREHOUSECRAFT_API_PASSWORD"]);
    expect(warehouseTenantMode({ ...flagOnly, ...login, WAREHOUSECRAFT_API_PASSWORD: " " })).toBe("test");
    expect(warehouseCraftConfig(flagOnly)).toMatchObject({ tenant: "test", orderApiBaseUrl: "https://novex.example.test", authorization: basic("novex-user", "novex-pass") });
    // A complete live login with the flag uses the live login only.
    expect(warehouseCraftConfig({ ...novex, ...login, WAREHOUSECRAFT_TENANT_MODE: "live" })).toMatchObject({
      tenant: "live", orderApiBaseUrl: "https://live.example.test", authorization: basic("live-user", "live-pass"),
    });
    // A saved live login without the flag is ignored: test traffic keeps the test login, and nothing is mixed.
    expect(warehouseCraftConfig({ ...novex, ...login })).toMatchObject({ tenant: "test", orderApiBaseUrl: "https://novex.example.test", authorization: basic("novex-user", "novex-pass") });
    expect(warehouseCraftConfig({ ...login, NOVEX_API_BASE_URL: "novex.example.test" })).toMatchObject({ tenant: "test", orderApiBaseUrl: "https://novex.example.test", authorization: null });
  });
  it("holds a real order when the live flag is set but the live login is incomplete, never sending it on the test login", async () => {
    vi.stubEnv("WAREHOUSECRAFT_API_PASSWORD", "");
    vi.stubEnv("NOVEX_API_BASE_URL", "novex.example.test");
    vi.stubEnv("NOVEX_API_USERNAME", "novex-user");
    vi.stubEnv("NOVEX_API_PASSWORD", "novex-pass");
    seed({ orders: [order({ livemode: true })] });
    const client = fakeClient();
    await expect(submitOne(sub(), { client, now: () => NOW })).resolves.toBe("held");
    expect(client.calls).toEqual([]);
    expect(sub()).toMatchObject({ state: "pending", attempts: 0, last_error: HELD_LIVE_ORDER_MESSAGE });
    // Completing the live login releases it on the next pass.
    vi.stubEnv("WAREHOUSECRAFT_API_PASSWORD", "live-pass");
    await expect(submitOne(sub(), { client, now: () => NOW })).resolves.toBe("sent");
  });
  it("holds a real order while the connection is in test mode: no call, no attempt spent, re-checked later, not counted as a failure", async () => {
    seed({ orders: [order({ livemode: true })] });
    const client = fakeClient();
    await expect(submitOne(sub(), { client, now: () => NOW, tenantMode: "test" })).resolves.toBe("held");
    expect(client.calls).toEqual([]);
    expect(sub()).toMatchObject({ state: "pending", attempts: 0, last_error: HELD_LIVE_ORDER_MESSAGE, last_error_kind: null, next_attempt_at: new Date(NOW.getTime() + HOLD_RECHECK_MS).toISOString() });
    expect(shipment()).toMatchObject({ warehouse_state: "pending", warehouse_error: HELD_LIVE_ORDER_MESSAGE });
    expect(state.tables.staff_notifications).toHaveLength(0);
    // Flipping the mode drains the held order on the next pass and clears the hold message.
    await expect(submitOne(sub(), { client, now: () => NOW, tenantMode: "live" })).resolves.toBe("sent");
    expect(sub()).toMatchObject({ state: "sent", attempts: 1, last_error: null });
    expect(shipment()).toMatchObject({ warehouse_state: "sent", warehouse_error: null });
  });
  it("skips a Stripe sandbox order for good once the connection is live, without calling the warehouse", async () => {
    seed({ orders: [order({ livemode: false })] });
    const client = fakeClient();
    await expect(submitOne(sub(), { client, now: () => NOW, tenantMode: "live" })).resolves.toBe("skipped");
    expect(client.calls).toEqual([]);
    expect(sub()).toMatchObject({ state: "skipped", skipped_reason: SKIPPED_SANDBOX_REASON });
    expect(shipment()).toMatchObject({ warehouse_state: "skipped" });
  });
  it("never sends a sandbox order even to a test tenant; sends a real order to live", async () => {
    seed({ orders: [order({ livemode: false })] });
    const client = fakeClient();
    await expect(submitOne(sub(), { client, now: () => NOW, tenantMode: "test" })).resolves.toBe("skipped");
    expect(client.calls).toEqual([]);
    seed({ orders: [order({ livemode: true })] });
    await expect(submitOne(sub(), { client: fakeClient(), now: () => NOW, tenantMode: "live" })).resolves.toBe("sent");
  });
});

describe("sandbox verification allowance", () => {
  const flag = (orderId = "ord-1", expiresAt = "2999-01-01T00:00:00.000Z") => [{ order_id: orderId, designated_inbox: "qa-inbox@example.test", authorized_by: "tester", note: null, created_at: "2026-09-18T11:00:00.000Z", expires_at: expiresAt }];
  afterEach(() => __setSandboxVerificationsForTests(null));
  it("only a flagged sandbox order against the sandbox tenant is sendable; every other combination is unchanged", () => {
    expect(tenantVerdict({ livemode: false }, "test", true)).toBe("send");
    expect(tenantVerdict({ livemode: false }, "live", true)).toBe("skip");
    expect(tenantVerdict({ livemode: false }, "test", false)).toBe("skip");
    expect(tenantVerdict({ livemode: true }, "test", true)).toBe("hold");
    expect(tenantVerdict({ livemode: true }, "live", true)).toBe("send");
  });
  it("submits a flagged sandbox order to the sandbox tenant and never to a live tenant", async () => {
    __setSandboxVerificationsForTests(flag());
    seed({ orders: [order({ livemode: false })] });
    const live = fakeClient();
    await expect(submitOne(sub(), { client: live, now: () => NOW, tenantMode: "live" })).resolves.toBe("skipped");
    expect(live.calls).toEqual([]);
    expect(sub()).toMatchObject({ state: "skipped", skipped_reason: SKIPPED_SANDBOX_REASON });
    seed({ orders: [order({ livemode: false })] });
    const sandbox = fakeClient();
    await expect(submitOne(sub(), { client: sandbox, now: () => NOW, tenantMode: "test" })).resolves.toBe("sent");
    expect(sandbox.calls).toEqual(["create"]);
    expect(sub()).toMatchObject({ state: "sent", warehouse_order_id: "1436119" });
    expect(shipment()).toMatchObject({ warehouse_state: "sent" });
  });
  it("an expired flag, a flag for another order, or a real order under the flag changes nothing", async () => {
    const client = fakeClient();
    __setSandboxVerificationsForTests(flag("ord-1", "2026-09-18T11:59:00.000Z"));
    seed({ orders: [order({ livemode: false })] });
    await expect(submitOne(sub(), { client, now: () => NOW, tenantMode: "test" })).resolves.toBe("skipped");
    __setSandboxVerificationsForTests(flag("ord-other"));
    seed({ orders: [order({ livemode: false })] });
    await expect(submitOne(sub(), { client, now: () => NOW, tenantMode: "test" })).resolves.toBe("skipped");
    __setSandboxVerificationsForTests(flag());
    seed({ orders: [order({ livemode: true })] });
    await expect(submitOne(sub(), { client, now: () => NOW, tenantMode: "test" })).resolves.toBe("held");
    expect(client.calls).toEqual([]);
  });
  it("lets the flagged sandbox order be cancelled at the sandbox tenant through the verified lookup, but not at a live tenant", async () => {
    __setSandboxVerificationsForTests(flag());
    seed({ orders: [order({ livemode: false, fulfillment_status: "canceled" })], submissions: [submission({ state: "sent", warehouse_order_id: "1436119", payload: { ClientOrderId: "TH-000123" } })] });
    const live = fakeClient({ lookup: async () => liveOrder("Imported") });
    expect(await cancelAtWarehouse("ord-1", { client: live, tenantMode: "live" })).toMatchObject({ kind: "unavailable" });
    expect(live.calls).toEqual([]);
    const sandbox = fakeClient({ lookup: async () => liveOrder("Imported") });
    expect((await cancelAtWarehouse("ord-1", { client: sandbox, tenantMode: "test" })).kind).toBe("applied");
    expect(sandbox.calls).toEqual(["lookup", "cancel"]);
  });
  it("the verification pass drains only the flagged order ids", async () => {
    __setSandboxVerificationsForTests(flag("ord-2"));
    seed({
      orders: [order({ livemode: false }), order({ id: "ord-2", order_number: "TH-2", livemode: false })],
      items: [item(), item({ id: "i2", order_id: "ord-2" })],
      submissions: [submission(), submission({ id: "sub-2", order_id: "ord-2" })],
    });
    const created: string[] = [];
    const client = fakeClient({ create: async (payload) => { created.push(payload.ClientOrderId); return { kind: "created", order_id: 77 }; } });
    const tallies: Record<string, number> = {};
    const context = { now: NOW, dryRun: false, leaseLost: false, tally: (key: string, by: number) => { tallies[key] = (tallies[key] ?? 0) + by; }, failItem: () => {}, log: () => {}, checkpoint: () => {} } as unknown as JobContext;
    await runWarehouseSubmit(context, { client, tenantMode: "test", onlyOrderIds: ["ord-2"] });
    expect(created).toEqual(["TH-2"]);
    expect(tallies).toMatchObject({ due: 1, sent: 1 });
    expect(state.tables.billing_warehouse_submissions.map((row: any) => [row.order_id, row.state])).toEqual([["ord-1", "pending"], ["ord-2", "sent"]]);
  });
});

describe("retrySubmission", () => {
  it("returns a Needs attention intent to pending, due now, and clears the shipment error", async () => {
    seed({ submissions: [submission({ state: "needs_attention", attempts: 3, last_error: "ItemSKU not recognized: BOGUS", last_error_kind: "rejected" })], shipments: [{ id: "ship-1", order_id: "ord-1", warehouse_state: "needs_attention", warehouse_error: "ItemSKU not recognized: BOGUS" }] });
    const row = await retrySubmission("ord-1");
    expect(row).toMatchObject({ state: "pending", attempts: 0, next_attempt_at: "2026-09-18T12:00:00.000Z" });
    expect(shipment()).toMatchObject({ warehouse_state: "pending", warehouse_error: null });
  });
  it("leaves a sent intent alone", async () => {
    seed({ submissions: [submission({ state: "sent", warehouse_order_id: "1" })] });
    expect((await retrySubmission("ord-1"))?.state).toBe("sent");
  });
});

describe("cancelAtWarehouse", () => {
  it("marks a not-yet-sent intent skipped so the drain never sends a canceled order", async () => {
    const client = fakeClient();
    await expect(cancelAtWarehouse("ord-1", { client })).resolves.toEqual({ kind: "not_sent" });
    expect(client.calls).toEqual([]);
    expect(sub().state).toBe("skipped");
  });
  it("cancels at the warehouse while the status is still editable", async () => {
    seed({ submissions: [submission({ state: "sent", warehouse_order_id: "1436119", payload: { ClientOrderId: "TH-000123" } })] });
    const client = fakeClient({ lookup: async () => liveOrder("On Hold") });
    await expect(cancelAtWarehouse("ord-1", { client })).resolves.toEqual({ kind: "applied", warehouse_order_id: "1436119" });
    expect(client.calls).toEqual(["lookup", "cancel"]);
    expect(sub().warehouse_status).toBe("Cancelled");
  });
  it("reports the shipment locked once the warehouse has committed the order", async () => {
    seed({ submissions: [submission({ state: "sent", warehouse_order_id: "1436119" })] });
    const client = fakeClient({ lookup: async () => liveOrder("Committed") });
    await expect(cancelAtWarehouse("ord-1", { client })).resolves.toEqual({ kind: "locked", warehouse_status: "Committed" });
    expect(client.calls).toEqual(["lookup"]);
    expect(sub()).toMatchObject({ warehouse_status: "Committed", last_error: expect.stringMatching(/cancellation could not be applied/) });
  });
  it("reports unavailable (never throws) when the warehouse cannot be reached", async () => {
    seed({ submissions: [submission({ state: "sent", warehouse_order_id: "1436119" })] });
    const client = fakeClient({ lookup: async () => { throw new WarehouseCraftError("down", "transient", 503); } });
    await expect(cancelAtWarehouse("ord-1", { client })).resolves.toMatchObject({ kind: "unavailable" });
  });
  it("never writes by the cached numeric id: a lookup miss or a tenant mismatch refuses instead of cancelling someone else's order", async () => {
    // Sent to the test tenant, connection now live: the cached OrderId belongs to another tenant.
    seed({ orders: [order({ livemode: false })], submissions: [submission({ state: "sent", warehouse_order_id: "1436119" })] });
    let client = fakeClient({ lookup: async () => liveOrder("On Hold") });
    await expect(cancelAtWarehouse("ord-1", { client, tenantMode: "live" })).resolves.toMatchObject({ kind: "unavailable", message: expect.stringMatching(/LIVE mode but this is a sandbox order/) });
    expect(client.calls).toEqual([]);
    expect(sub().last_error).toMatch(/Cancel not mirrored/);
    // Same tenant, but the ClientOrderId is unknown there: no fallback to the cached status or id.
    seed({ submissions: [submission({ state: "sent", warehouse_order_id: "1436119", warehouse_status: "Imported" })] });
    client = fakeClient({ lookup: async () => null });
    await expect(cancelAtWarehouse("ord-1", { client, tenantMode: "live" })).resolves.toMatchObject({ kind: "unavailable", message: expect.stringMatching(/not found at the warehouse/) });
    expect(client.calls).toEqual(["lookup"]);
    // The lookup answers a different ClientOrderId: refuse as well.
    seed({ submissions: [submission({ state: "sent", warehouse_order_id: "1436119" })] });
    client = fakeClient({ lookup: async () => liveOrder("On Hold", 999, "TH-OTHER") });
    await expect(cancelAtWarehouse("ord-1", { client, tenantMode: "live" })).resolves.toMatchObject({ kind: "unavailable" });
    expect(client.calls).toEqual(["lookup"]);
  });
  it("cancels the order the lookup verified and re-points the cached id at it", async () => {
    seed({ submissions: [submission({ state: "sent", warehouse_order_id: "1", payload: { ClientOrderId: "TH-000123" } })] });
    const client = fakeClient({ lookup: async () => liveOrder("Imported", 777), cancel: async (id) => liveOrder("Cancelled", id) });
    await expect(cancelAtWarehouse("ord-1", { client, tenantMode: "live" })).resolves.toEqual({ kind: "applied", warehouse_order_id: "777" });
    expect(sub()).toMatchObject({ warehouse_order_id: "777", warehouse_status: "Cancelled" });
  });
});

describe("syncSubscriptionAddress", () => {
  it("edits sent-but-editable orders, updates pending ones locally, and reports committed ones as locked", async () => {
    seed({
      orders: [
        order({ id: "ord-a", order_number: "TH-A", subscription_id: "sub-9" }),
        order({ id: "ord-b", order_number: "TH-B", subscription_id: "sub-9" }),
        order({ id: "ord-c", order_number: "TH-C", subscription_id: "sub-9" }),
        order({ id: "ord-d", order_number: "TH-D", subscription_id: "sub-9", fulfillment_status: "shipped" }),
      ],
      submissions: [
        submission({ id: "s-a", order_id: "ord-a", state: "sent", warehouse_order_id: "1", payload: { ClientOrderId: "TH-A" } }),
        submission({ id: "s-b", order_id: "ord-b", state: "sent", warehouse_order_id: "2" }),
        submission({ id: "s-c", order_id: "ord-c" }),
      ],
    });
    const next = { ...ADDRESS, line1: "456 Edited Ave" };
    const client = fakeClient({ lookup: async (id) => liveOrder(id === "TH-A" ? "Committed" : "Picked", id === "TH-A" ? 1 : 2, id), editAddress: async () => liveOrder("Modified", 1, "TH-A") });
    await expect(syncSubscriptionAddress("sub-9", next, { client })).resolves.toEqual({ applied: ["TH-A"], locked: ["TH-B"], unavailable: [] });
    expect(state.tables.billing_orders.find((row) => row.id === "ord-c").shipping_address.line1).toBe("456 Edited Ave");
    expect(state.tables.billing_orders.find((row) => row.id === "ord-d").shipping_address.line1).toBe("123 Test Street");
    expect(state.tables.billing_warehouse_submissions.find((row) => row.id === "s-a")).toMatchObject({ warehouse_status: "Modified", payload: { AddressLine1: "456 Edited Ave" } });
  });
  it("refuses to edit at the warehouse when the tenant does not match the order or the lookup misses", async () => {
    seed({
      orders: [order({ id: "ord-a", order_number: "TH-A", subscription_id: "sub-9", livemode: true }), order({ id: "ord-b", order_number: "TH-B", subscription_id: "sub-9", livemode: false })],
      submissions: [submission({ id: "s-a", order_id: "ord-a", state: "sent", warehouse_order_id: "1" }), submission({ id: "s-b", order_id: "ord-b", state: "sent", warehouse_order_id: "2" })],
    });
    const client = fakeClient({ lookup: async () => null });
    // Test tenant: real and sandbox orders are both refused without any call.
    await expect(syncSubscriptionAddress("sub-9", ADDRESS, { client, tenantMode: "test" })).resolves.toEqual({ applied: [], locked: [], unavailable: ["TH-A", "TH-B"] });
    expect(client.calls).toEqual([]);
    expect(state.tables.billing_warehouse_submissions.map((row) => row.last_error)).toEqual([expect.stringMatching(/TEST mode but this is a live order/), expect.stringMatching(/TEST mode but this is a sandbox order/)]);
  });
});

describe("warehouseDto / warehouseHealth", () => {
  it("exposes the next attempt only while pending", () => {
    expect(warehouseDto(submission({ state: "sent", next_attempt_at: "x" }))?.next_attempt_at).toBeNull();
    expect(warehouseDto(submission())?.next_attempt_at).toBe("2026-09-18T11:59:00.000Z");
    expect(warehouseDto(null)).toBeNull();
  });
  it("counts the last 24 h and lists Needs attention orders with their numbers", async () => {
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "test");
    seed({
      orders: [order(), order({ id: "ord-2", order_number: "TH-000124" })],
      submissions: [
        submission({ id: "a", state: "sent", sent_at: "2026-09-18T10:00:00.000Z", last_attempt_at: "2026-09-18T10:00:00.000Z", attempts: 2 }),
        submission({ id: "b", order_id: "ord-2", state: "needs_attention", last_attempt_at: "2026-09-18T11:00:00.000Z", last_error: "ItemSKU not recognized: X", last_error_kind: "rejected", attempts: 1 }),
        submission({ id: "c", order_id: "ord-3", state: "pending", next_attempt_at: "2026-09-18T13:00:00.000Z", last_attempt_at: "2026-09-18T11:30:00.000Z", last_error_kind: "transient", attempts: 1 }),
        submission({ id: "d", order_id: "ord-4", state: "pending", next_attempt_at: "2026-09-18T11:00:00.000Z" }),
        submission({ id: "e", order_id: "ord-5", state: "sent", sent_at: "2026-09-16T10:00:00.000Z", last_attempt_at: "2026-09-16T10:00:00.000Z", attempts: 1 }),
        // Held and past its re-check time: counted as held, not as due, while the tenant is test.
        submission({ id: "f", order_id: "ord-6", state: "pending", next_attempt_at: "2026-09-18T11:10:00.000Z", last_error: HELD_LIVE_ORDER_MESSAGE }),
      ],
      settings: { id: 1, warehouse_auto_submit: false },
    });
    await expect(warehouseHealth(NOW)).resolves.toEqual({
      pending: 3, due: 1, held: 1, sent24h: 1, failed24h: 2, retries24h: 1, needs_attention: 1, auto_submit: false, tenant_mode: "test",
      recent_failures: [{ order_id: "ord-2", order_number: "TH-000124", error: "ItemSKU not recognized: X", at: "2026-09-18T11:00:00.000Z", state: "needs_attention" }],
    });
  });
});

describe("warehouse-submit job", () => {
  function ctx(overrides: Partial<JobContext> = {}): JobContext & { tallies: Record<string, number>; failures: string[]; checkpoints: number } {
    const tallies: Record<string, number> = {}; const failures: string[] = [];
    const context = {
      now: NOW, dryRun: false, leaseLost: false, tallies, failures, checkpoints: 0,
      tally: (key: string, by: number) => { tallies[key] = (tallies[key] ?? 0) + by; },
      failItem: (key: string) => { failures.push(key); },
      log: () => {}, checkpoint: () => { context.checkpoints += 1; },
      ...overrides,
    } as any;
    return context;
  }
  it("is scheduled on the tick and only drains due intents in order", async () => {
    expect(warehouseSubmitJob.intervalMs).toBe(120_000);
    seed({
      orders: [order(), order({ id: "ord-2", order_number: "TH-2" }), order({ id: "ord-3", order_number: "TH-3" })],
      items: [item(), item({ id: "i2", order_id: "ord-2" }), item({ id: "i3", order_id: "ord-3" })],
      submissions: [submission({ id: "late", order_id: "ord-2", next_attempt_at: "2026-09-18T11:00:00.000Z" }), submission(), submission({ id: "future", order_id: "ord-3", next_attempt_at: "2026-09-18T13:00:00.000Z" })],
    });
    const created: string[] = [];
    const client = fakeClient({ create: async (payload) => { created.push(payload.ClientOrderId); return { kind: "created", order_id: created.length }; } });
    const context = ctx();
    await runWarehouseSubmit(context, { client });
    expect(created).toEqual(["TH-2", "TH-000123"]);
    expect(context.tallies).toMatchObject({ due: 2, sent: 2 });
    expect(context.checkpoints).toBeGreaterThan(0);
    expect(state.tables.billing_warehouse_submissions.find((row) => row.id === "future").state).toBe("pending");
  });
  it("pauses under the HQ kill switch without touching the queue", async () => {
    seed({ settings: { id: 1, warehouse_auto_submit: false } });
    const client = fakeClient();
    const context = ctx();
    await runWarehouseSubmit(context, { client });
    expect(client.calls).toEqual([]);
    expect(context.tallies).toEqual({ pausedPending: 1 });
    expect(sub().state).toBe("pending");
  });
  it("counts but sends nothing on a dry run", async () => {
    const client = fakeClient();
    const context = ctx({ dryRun: true });
    await runWarehouseSubmit(context, { client });
    expect(client.calls).toEqual([]);
    expect(context.tallies).toEqual({ due: 1, wouldSubmit: 1 });
    expect(state.writes).toEqual([]);
  });
  it("stops at the lease boundary and surfaces rejections as item failures", async () => {
    seed({
      orders: [order(), order({ id: "ord-2", order_number: "TH-2" })], items: [item(), item({ id: "i2", order_id: "ord-2" })],
      submissions: [submission(), submission({ id: "s2", order_id: "ord-2" })],
    });
    const client = fakeClient({ create: async () => ({ kind: "rejected", message: "ItemSKU not recognized: X" }) });
    const context = ctx();
    let sent = 0;
    Object.defineProperty(context, "leaseLost", { get: () => sent++ >= 1 });
    await runWarehouseSubmit(context, { client });
    expect(client.calls).toEqual(["create"]);
    expect(context.failures).toEqual(["order:ord-1"]);
    expect(context.tallies).toMatchObject({ rejected: 1 });
  });
  it("drains more than one batch when the queue is deep", async () => {
    const orders = Array.from({ length: BATCH_SIZE + 2 }, (_, i) => order({ id: `o${i}`, order_number: `TH-${i}` }));
    seed({ orders, items: orders.map((row) => item({ id: `i${row.id}`, order_id: row.id })), submissions: orders.map((row) => submission({ id: `s${row.id}`, order_id: row.id })) });
    const client = fakeClient();
    const context = ctx();
    await runWarehouseSubmit(context, { client });
    expect(context.tallies.sent).toBe(BATCH_SIZE + 2);
  });
  it("keeps already-held live orders out of the batch budget while the tenant is test, and drains them once it is live", async () => {
    // A real order first touched in test mode is held once (tallied, mirrored) ...
    seed({ orders: [order({ livemode: true }), order({ id: "ord-2", order_number: "TH-2", livemode: false })], items: [item(), item({ id: "i2", order_id: "ord-2" })], submissions: [submission(), submission({ id: "s2", order_id: "ord-2" })] });
    const client = fakeClient();
    const first = ctx();
    await runWarehouseSubmit(first, { client, tenantMode: "test" });
    expect(first.tallies).toMatchObject({ due: 2, held: 1, skipped: 1 });
    expect(first.tallies.retriesResolved).toBeUndefined();
    // ... and on a later pass (still test mode, hold re-check time elapsed) it is not even selected.
    sub().next_attempt_at = "2026-09-18T11:00:00.000Z";
    const second = ctx();
    await runWarehouseSubmit(second, { client, tenantMode: "test" });
    expect(second.tallies).toEqual({});
    expect(sub()).toMatchObject({ state: "pending", attempts: 0 });
    // Flipping the connection to live drains it.
    const third = ctx();
    await runWarehouseSubmit(third, { client, tenantMode: "live" });
    expect(third.tallies).toMatchObject({ due: 1, sent: 1 });
    expect(sub()).toMatchObject({ state: "sent", last_error: null });
  });
});
