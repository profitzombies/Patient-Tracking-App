import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../jobs/types";
import { WarehouseCraftError } from "../shipping/warehousecraft";
import type { WarehouseOrderStatus, WarehouseParcel, WarehouseStatusClient } from "../shipping/warehousecraft-status";

/** In-memory PostgREST stand-in (eq/in/lt/lte/gte/order/limit) recording every write. */
const state = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  writes: [] as Array<{ op: string; table: string; patch?: any }>,
  admin: [] as Array<{ method: string; path: string; body?: any }>,
  emails: [] as Array<{ from: string; to: string }>,
  pushes: [] as string[],
  recipients: [{ auth_user_id: "hq-1", email: "hq@example.test", display_name: "HQ Admin" }] as any[],
}));

vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (method: string, path: string, body?: any) => {
    state.admin.push({ method, path, body });
    if (path.startsWith("/rest/v1/hq_memberships")) return { status: 200, json: state.recipients };
    if (path.startsWith("/rest/v1/staff_notifications")) {
      state.tables.staff_notifications ??= [];
      for (const row of Array.isArray(body) ? body : [body]) {
        if (!state.tables.staff_notifications.some((existing) => existing.dedupe_key === row.dedupe_key)) state.tables.staff_notifications.push(row);
      }
      return { status: 201, json: body };
    }
    return { status: 404, json: null };
  }),
}));
vi.mock("./customer-emails", () => ({
  // Mirrors the real send rule (a shipped / delivered transition, never a re-save) so the tests count sent emails, not calls.
  notifyShipmentTransition: vi.fn(async (_order: any, shipment: any, previous: string) => {
    if (shipment.status === previous || (shipment.status !== "shipped" && shipment.status !== "delivered")) return "skipped";
    state.emails.push({ from: previous, to: shipment.status });
    return "sent";
  }),
}));
vi.mock("./patient-notices", () => ({
  notifyOrderShipped: vi.fn(async (input: any) => { state.pushes.push(input.order.id); return true; }),
}));
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
      const eq = /^eq\.(.*)$/.exec(value); const lt = /^lt\.(.*)$/.exec(value); const lte = /^lte\.(.*)$/.exec(value); const gte = /^gte\.(.*)$/.exec(value); const inList = /^in\.\((.*)\)$/.exec(value);
      if (eq) filters.push((row) => String(row[key]) === eq[1]);
      else if (lt) filters.push((row) => row[key] != null && String(row[key]) < lt[1]);
      else if (lte) filters.push((row) => row[key] != null && String(row[key]) <= lte[1]);
      else if (gte) filters.push((row) => row[key] != null && String(row[key]) >= gte[1]);
      else if (inList) { const set = new Set(inList[1].split(",")); filters.push((row) => set.has(String(row[key]))); }
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
    // Reads return copies, as PostgREST does: a later write must not mutate a row a caller is still holding.
    selectOne: vi.fn(async (table: string, query: string) => { const row = select(table, query)[0]; return row ? { ...row } : null; }),
    selectMany: vi.fn(async (table: string, query: string) => select(table, query).map((row) => ({ ...row }))),
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
    remove: vi.fn(async (table: string, query: string) => {
      const doomed = new Set(select(table, query).map((row) => row.id));
      state.tables[table] = rows(table).filter((row) => !doomed.has(row.id));
      state.writes.push({ op: "remove", table });
    }),
  };
});

import { notifyShipmentTransition } from "./customer-emails";
import { recordShipment } from "./shipments";
import { ShipmentTransitionError } from "./warehouse-status";
import {
  BASELINE_DAYS, MAX_WINDOW_DAYS, applyStatusRow, computePollWindow, followUpCandidates, runWarehouseStatusPoll, warehouseSyncHealth,
} from "./warehouse-status-sync";
import { runWarehouseStatusSync, warehouseStatusSyncJob } from "../jobs/definitions/warehouse-status-sync";
import { evaluateThresholds } from "../system/thresholds";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const ADDRESS = { name: "Pat Example", line1: "123 Test Street", line2: null, city: "Memphis", state: "TN", postal_code: "38103", country: "US", phone: null };

function order(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    livemode: true,
    id: "ord-1", order_number: "TH-000123", provider_id: "office-1", patient_id: "pat-1", payer_id: "payer-1", subscription_id: null,
    kind: "one_time", status: "paid", fulfillment_status: "to_ship", shipping_address: ADDRESS, shipping_method: "standard",
    paid_at: "2026-09-17T11:58:00.000Z", created_at: "2026-09-17T11:57:00.000Z", carrier: null, tracking_number: null, shipped_at: null, canceled_reason: null, shipped_by: null,
    ...overrides,
  } as any;
}
function submission(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sub-1", order_id: "ord-1", provider_id: "office-1", patient_id: "pat-1", state: "sent", attempts: 1, next_attempt_at: "2026-09-17T11:59:00.000Z",
    warehouse_order_id: "1436119", warehouse_status: "Imported", last_error: null, last_error_kind: null, last_attempt_at: "2026-09-17T12:00:00.000Z",
    sent_at: "2026-09-17T12:00:00.000Z", skipped_reason: null, payload: {}, created_at: "2026-09-17T11:58:00.000Z", ...overrides,
  } as any;
}
function shipmentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ship-1", order_id: "ord-1", provider_id: "office-1", status: "processing", carrier: null, tracking_number: null, tracking_url: null,
    source: "staff", external_id: null, label_created_at: null, shipped_at: null, delivered_at: null, canceled_at: null, canceled_reason: null,
    events: [], updated_by: null, warehouse_order_id: "1436119", warehouse_state: "sent", warehouse_sent_at: "2026-09-17T12:00:00.000Z", warehouse_error: null,
    warehouse_status: "Imported", warehouse_status_at: "2026-09-17T12:00:00.000Z", warehouse_back_ordered: false, warehouse_event_key: null, warehouse_last_event: null, warehouse_synced_at: null,
    created_at: "2026-09-17T12:00:00.000Z", ...overrides,
  } as any;
}
function seed(input: { orders?: any[]; submissions?: any[]; shipments?: any[]; polls?: any[] } = {}) {
  state.tables = {
    billing_orders: input.orders ?? [order()], billing_warehouse_submissions: input.submissions ?? [submission()],
    billing_shipments: input.shipments ?? [shipmentRow()], billing_warehouse_sync_polls: input.polls ?? [], staff_notifications: [],
  };
}
const parcel = (overrides: Partial<WarehouseParcel> = {}): WarehouseParcel => ({
  ship_date: "2026-09-18T15:00:00.000Z", deliver_date: null, tracking_status: null, tracking_status_kind: null, tracking_exceptions: null,
  carrier: "USPS", tracking_number: "9400111899223", weight_lbs: 1.2, ...overrides,
});
const feedRow = (status: string, parcels: WarehouseParcel[] = [], overrides: Partial<WarehouseOrderStatus> = {}): WarehouseOrderStatus => ({
  order_id: 1436119, client_order_id: "TH-000123", order_date: "2026-09-17T17:00:00.000Z", import_date: "2026-09-17T17:01:00.000Z",
  status, carrier_code: "USPS", shipping_method: "USPS Ground Advantage", parcels, raw: { OrderId: 1436119, OrderStatus: status }, ...overrides,
});
const ship = () => state.tables.billing_shipments.find((row) => row.order_id === "ord-1");
const ord = () => state.tables.billing_orders.find((row) => row.id === "ord-1");

function ctx(overrides: Partial<JobContext> & { counts?: Record<string, number>; failures?: Array<{ item: string; error: unknown; reportLocal?: boolean }>; logs?: any[] } = {}): JobContext & { counts: Record<string, number>; failures: Array<{ item: string; error: unknown; reportLocal?: boolean }>; logs: any[] } {
  const counts: Record<string, number> = overrides.counts ?? {};
  const failures = overrides.failures ?? [];
  const logs = overrides.logs ?? [];
  return {
    dryRun: false, now: NOW, leaseLost: false,
    tally: (key, by = 1) => { counts[key] = (counts[key] ?? 0) + by; },
    failItem: (item, error, options) => { failures.push({ item, error, reportLocal: options?.reportLocal }); },
    log: (event, detail) => { logs.push({ event, ...detail }); },
    checkpoint: () => {},
    ...overrides, counts, failures, logs,
  };
}
function fakeClient(overrides: Partial<WarehouseStatusClient> & { rows?: WarehouseOrderStatus[] } = {}): WarehouseStatusClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    byDate: async (start, end) => { calls.push(`byDate:${start}:${end}`); return overrides.byDate ? overrides.byDate(start, end) : overrides.rows ?? []; },
    byId: async (id) => { calls.push(`byId:${id}`); return overrides.byId ? overrides.byId(id) : null; },
    byClientOrderId: async (id) => { calls.push(`byClientOrderId:${id}`); return overrides.byClientOrderId ? overrides.byClientOrderId(id) : null; },
  };
}

beforeEach(() => { state.writes = []; state.admin = []; state.emails = []; state.pushes = []; seed(); vi.mocked(notifyShipmentTransition).mockClear(); });

describe("computePollWindow", () => {
  it("covers at least the baseline week and always reaches tomorrow in the warehouse clock", () => {
    const window = computePollWindow(NOW, new Date("2026-09-18T11:45:00.000Z"));
    expect(window).toEqual({ start: "2026-09-11", end: "2026-09-19" });
    expect(computePollWindow(NOW, null)).toEqual({ start: "2026-09-11", end: "2026-09-19" });
  });
  it("re-reads behind a stale last success with the overlap, capped at the maximum window", () => {
    // 12 days since the last success + 2 h overlap → 12 days back (beyond the baseline).
    expect(computePollWindow(NOW, new Date("2026-09-06T13:00:00.000Z")).start).toBe("2026-09-06");
    expect(computePollWindow(NOW, new Date("2026-06-01T00:00:00.000Z")).start).toBe(`2026-08-${19}`);
    expect(BASELINE_DAYS).toBeLessThan(MAX_WINDOW_DAYS);
  });
  it("uses the warehouse calendar (Central) so late-evening UTC skew never drops a day", () => {
    // 03:30 UTC on the 19th is still the 18th in Chicago; end = 18 + 1.
    expect(computePollWindow(new Date("2026-09-19T03:30:00.000Z"), null)).toEqual({ start: "2026-09-11", end: "2026-09-19" });
    // A last-success stamped ahead of our clock (3PL skew) still yields a sane window.
    expect(computePollWindow(NOW, new Date("2026-09-18T13:30:00.000Z"))).toEqual({ start: "2026-09-11", end: "2026-09-19" });
  });
});

describe("applyStatusRow", () => {
  it("ignores rows for orders that were never submitted to the warehouse", async () => {
    await expect(applyStatusRow(feedRow("Shipped", [parcel()], { order_id: 1, client_order_id: "ISC_TEST2019032801" }), { now: () => NOW })).resolves.toBe("unmatched");
    seed({ submissions: [submission({ state: "pending", warehouse_order_id: null })], shipments: [shipmentRow({ warehouse_state: "pending", warehouse_order_id: null })] });
    await expect(applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => NOW })).resolves.toBe("not_submitted");
    expect(ship().status).toBe("processing");
    expect(state.emails).toEqual([]);
  });
  it("refuses a by-id row whose ClientOrderId is not ours (the tenant answers for other clients)", async () => {
    await expect(applyStatusRow(feedRow("Shipped", [parcel()], { client_order_id: "SOMEONE-ELSE" }), { now: () => NOW })).resolves.toBe("mismatch");
    expect(ship().status).toBe("processing");
  });
  it("matches by ClientOrderId when the warehouse id is unknown", async () => {
    seed({ submissions: [submission({ warehouse_order_id: "999" })], shipments: [shipmentRow({ warehouse_order_id: "999" })] });
    await expect(applyStatusRow(feedRow("Committed"), { now: () => NOW })).resolves.toBe("noted");
    expect(ship()).toMatchObject({ warehouse_status: "Committed", warehouse_status_at: NOW.toISOString(), warehouse_event_key: "processing:committed@-" });
    expect(state.tables.billing_warehouse_submissions[0].warehouse_status).toBe("Committed");
  });
  it("ships through the shipment write path with provider source: tracking, mirror, one email, one push", async () => {
    await expect(applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => NOW })).resolves.toBe("transition");
    expect(ship()).toMatchObject({
      status: "shipped", source: "provider", carrier: "USPS", tracking_number: "9400111899223", tracking_url: expect.stringContaining("9400111899223"),
      shipped_at: "2026-09-18T15:00:00.000Z", external_id: "1436119", warehouse_status: "Shipped", warehouse_event_key: "shipped@2026-09-18T15:00:00.000Z:9400111899223",
      warehouse_synced_at: NOW.toISOString(),
    });
    expect(ship().events.at(-1)).toMatchObject({ status: "shipped", detail: { source: "warehousecraft", warehouse_status: "Shipped" } });
    expect(ord()).toMatchObject({ fulfillment_status: "shipped", carrier: "USPS", tracking_number: "9400111899223", shipped_at: "2026-09-18T15:00:00.000Z" });
    expect(state.emails).toEqual([{ from: "processing", to: "shipped" }]);
    expect(state.pushes).toEqual(["ord-1"]);
  });
  it("is idempotent: the same row again is a duplicate, no second email or push", async () => {
    await applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => NOW });
    const writesBefore = state.writes.length;
    await expect(applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => new Date("2026-09-18T12:15:00.000Z") })).resolves.toBe("duplicate");
    expect(state.emails).toHaveLength(1);
    expect(state.pushes).toHaveLength(1);
    // Only the synced-at touch.
    expect(state.writes.slice(writesBefore).map((write) => Object.keys(write.patch))).toEqual([["warehouse_synced_at"]]);
  });
  it("never rewinds: a late processing row after shipped, or a shipped row after staff delivered, is stale", async () => {
    await applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => NOW });
    await expect(applyStatusRow(feedRow("Being Fulfilled"), { now: () => NOW })).resolves.toBe("stale");
    expect(ship()).toMatchObject({ status: "shipped", tracking_number: "9400111899223", warehouse_status: "Being Fulfilled" });
    expect(ord().fulfillment_status).toBe("shipped");
    await recordShipment(ord(), { status: "delivered", source: "staff", updated_by: "staff-1" });
    expect(state.emails).toEqual([{ from: "processing", to: "shipped" }, { from: "shipped", to: "delivered" }]);
    await expect(applyStatusRow(feedRow("Shipped", [parcel({ tracking_number: "LATE" })]), { now: () => NOW })).resolves.toBe("stale");
    expect(ship()).toMatchObject({ status: "delivered", tracking_number: "9400111899223" });
    expect(state.emails).toHaveLength(2);
  });
  it("holds Shipped without tracking until the number is uploaded, then ships once", async () => {
    await expect(applyStatusRow(feedRow("Shipped"), { now: () => NOW })).resolves.toBe("awaiting_tracking");
    expect(ship()).toMatchObject({ status: "processing", warehouse_status: "Shipped", warehouse_event_key: null });
    expect(state.emails).toEqual([]);
    await expect(applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => NOW })).resolves.toBe("transition");
    expect(state.emails).toEqual([{ from: "processing", to: "shipped" }]);
  });
  it("moves shipped → delivered on a DeliverDate with the delivered email and no second push", async () => {
    await applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => NOW });
    await expect(applyStatusRow(feedRow("Closed", [parcel({ deliver_date: "2026-09-21T18:00:00.000Z" })]), { now: () => NOW })).resolves.toBe("transition");
    expect(ship()).toMatchObject({ status: "delivered", delivered_at: "2026-09-21T18:00:00.000Z", shipped_at: "2026-09-18T15:00:00.000Z", warehouse_status: "Closed" });
    expect(ord().fulfillment_status).toBe("shipped");
    expect(state.emails).toEqual([{ from: "processing", to: "shipped" }, { from: "shipped", to: "delivered" }]);
    expect(state.pushes).toEqual(["ord-1"]);
  });
  it("jumps processing → delivered when the first sighting is already delivered (shipped push fires once)", async () => {
    await expect(applyStatusRow(feedRow("Closed", [parcel({ tracking_status: "Delivered", tracking_status_kind: "delivered" })]), { now: () => NOW })).resolves.toBe("transition");
    expect(ship()).toMatchObject({ status: "delivered", delivered_at: "2026-09-18T15:00:00.000Z" });
    expect(state.emails).toEqual([{ from: "processing", to: "delivered" }]);
    expect(state.pushes).toEqual(["ord-1"]);
  });
  it("lets the warehouse tracking override staff-entered tracking without a new email", async () => {
    await recordShipment(ord(), { status: "shipped", source: "staff", carrier: "UPS", tracking_number: "1Z999", updated_by: "staff-1" });
    state.emails = [];
    await expect(applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => NOW })).resolves.toBe("tracking_updated");
    expect(ship()).toMatchObject({ status: "shipped", carrier: "USPS", tracking_number: "9400111899223", source: "provider" });
    expect(ord()).toMatchObject({ carrier: "USPS", tracking_number: "9400111899223" });
    expect(state.emails).toEqual([]);
    expect(state.pushes).toEqual([]);
  });
  it("flags back orders for staff with one HQ alert, and clears the flag on release", async () => {
    await expect(applyStatusRow(feedRow("Back Order"), { now: () => NOW })).resolves.toBe("noted");
    expect(ship()).toMatchObject({ status: "processing", warehouse_back_ordered: true, warehouse_status: "Back Order" });
    expect(ord().fulfillment_status).toBe("to_ship");
    expect(state.tables.staff_notifications).toHaveLength(1);
    expect(state.tables.staff_notifications[0]).toMatchObject({ kind: "system_threshold", title: "Order TH-000123 is back-ordered at the warehouse", dedupe_key: "warehouse_back_order:ord-1:2026-09-18:hq-1:email" });
    expect(state.tables.staff_notifications[0].body).toContain("Preparing your order");
    await expect(applyStatusRow(feedRow("Back Order"), { now: () => NOW })).resolves.toBe("duplicate");
    await expect(applyStatusRow(feedRow("Released Back Order"), { now: () => NOW })).resolves.toBe("noted");
    expect(ship()).toMatchObject({ warehouse_back_ordered: false, warehouse_status: "Released Back Order" });
    expect(state.tables.staff_notifications).toHaveLength(1);
    expect(state.emails).toEqual([]);
  });
  it("cancels a paid, unshipped order the warehouse cancelled and alerts HQ", async () => {
    await expect(applyStatusRow(feedRow("Cancelled"), { now: () => NOW })).resolves.toBe("transition");
    expect(ship()).toMatchObject({ status: "canceled", canceled_reason: "Canceled at the warehouse." });
    expect(ord()).toMatchObject({ fulfillment_status: "canceled", canceled_reason: "Canceled at the warehouse." });
    expect(state.tables.staff_notifications[0]).toMatchObject({ title: "Warehouse canceled order TH-000123", dedupe_key: "warehouse_canceled:ord-1:hq-1:email" });
    expect(state.emails).toEqual([]);
  });
  it("records an unknown warehouse status for staff without changing the shipment", async () => {
    await expect(applyStatusRow(feedRow("Quarantined"), { now: () => NOW })).resolves.toBe("unknown_status");
    expect(ship()).toMatchObject({ status: "processing", warehouse_status: "Quarantined" });
  });
});

describe("recordShipment guard (staff and provider share it)", () => {
  it("rejects a staff move backwards with a 409", async () => {
    await applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => NOW });
    await expect(recordShipment(ord(), { status: "processing", source: "staff", updated_by: "staff-1" })).rejects.toBeInstanceOf(ShipmentTransitionError);
    await expect(recordShipment(ord(), { status: "processing", source: "staff", updated_by: "staff-1" })).rejects.toMatchObject({ status: 409 });
    expect(ship().status).toBe("shipped");
  });
  it("lets staff re-save the same status without an email", async () => {
    await applyStatusRow(feedRow("Shipped", [parcel()]), { now: () => NOW });
    await recordShipment(ord(), { status: "shipped", source: "staff", carrier: "USPS", tracking_number: "9400111899223", updated_by: "staff-1" });
    expect(state.emails).toHaveLength(1);
  });
});

describe("followUpCandidates", () => {
  it("lists submitted orders that left the window without a terminal state, dropping long-shipped ones", async () => {
    seed({ shipments: [
      shipmentRow({ id: "old-processing", order_id: "o1", warehouse_order_id: "11", warehouse_sent_at: "2026-08-20T00:00:00.000Z" }),
      shipmentRow({ id: "old-shipped", order_id: "o2", warehouse_order_id: "12", status: "shipped", shipped_at: "2026-09-05T00:00:00.000Z", warehouse_sent_at: "2026-08-20T00:00:00.000Z" }),
      shipmentRow({ id: "ancient-shipped", order_id: "o3", warehouse_order_id: "13", status: "shipped", shipped_at: "2026-08-01T00:00:00.000Z", warehouse_sent_at: "2026-07-20T00:00:00.000Z" }),
      shipmentRow({ id: "in-window", order_id: "o4", warehouse_order_id: "14", warehouse_sent_at: "2026-09-15T00:00:00.000Z" }),
      shipmentRow({ id: "delivered", order_id: "o5", warehouse_order_id: "15", status: "delivered", warehouse_sent_at: "2026-08-20T00:00:00.000Z" }),
      shipmentRow({ id: "not-sent", order_id: "o6", warehouse_order_id: null, warehouse_state: "pending", warehouse_sent_at: null, created_at: "2026-08-01T00:00:00.000Z" }),
    ] });
    const candidates = await followUpCandidates({ start: "2026-09-11", end: "2026-09-19" }, NOW);
    expect(candidates.map((candidate) => candidate.warehouseOrderId)).toEqual([11, 12]);
  });
});

describe("runWarehouseStatusPoll", () => {
  it("polls the window, applies rows, follows up by id, and writes one ok ledger row", async () => {
    seed({
      orders: [order(), order({ id: "ord-2", order_number: "TH-000124" })],
      submissions: [submission(), submission({ id: "sub-2", order_id: "ord-2", warehouse_order_id: "1436200" })],
      shipments: [shipmentRow(), shipmentRow({ id: "ship-2", order_id: "ord-2", warehouse_order_id: "1436200", warehouse_sent_at: "2026-08-20T00:00:00.000Z" })],
      polls: [{ id: "p0", started_at: "2026-09-18T11:40:00.000Z", finished_at: "2026-09-18T11:40:01.000Z", ok: true, window_start: "2026-09-11", window_end: "2026-09-19" }],
    });
    const client = fakeClient({
      rows: [feedRow("Shipped", [parcel()]), feedRow("Closed", [parcel()], { order_id: 1, client_order_id: "ISC_TEST2019032801" })],
      byId: async (id) => (id === 1436200 ? feedRow("Back Order", [], { order_id: 1436200, client_order_id: "TH-000124" }) : null),
    });
    const context = ctx();
    const summary = await runWarehouseStatusPoll(context, { client });
    expect(client.calls).toEqual(["byDate:2026-09-11:2026-09-19", "byId:1436200"]);
    expect(summary).toMatchObject({ window: { start: "2026-09-11", end: "2026-09-19" }, rows_seen: 3, matched: 2, transitions: 1, errors: 0, outcomes: { transition: 1, unmatched: 1, noted: 1 } });
    expect(context.counts).toMatchObject({ rowsSeen: 2, transition: 1, unmatched: 1, followUps: 1, noted: 1 });
    const polls = state.tables.billing_warehouse_sync_polls;
    expect(polls).toHaveLength(2);
    expect(polls[1]).toMatchObject({ ok: true, window_start: "2026-09-11", window_end: "2026-09-19", rows_seen: 3, matched: 2, transitions: 1, errors: 0, error: null });
    expect(polls[1].finished_at).toBeTruthy();
    expect(state.tables.billing_shipments[1]).toMatchObject({ warehouse_back_ordered: true });
  });
  it("records a failed poll when the feed is down and rethrows so the job goes unhealthy", async () => {
    const client = fakeClient({ byDate: async () => { throw new WarehouseCraftError("WarehouseCraft HTTP 503: down", "transient", 503); } });
    await expect(runWarehouseStatusPoll(ctx(), { client })).rejects.toThrow(/503/);
    expect(state.tables.billing_warehouse_sync_polls[0]).toMatchObject({ ok: false, error: "WarehouseCraft HTTP 503: down", errors: 1 });
    expect(ship().status).toBe("processing");
  });
  it("counts a per-row store failure without aborting the poll", async () => {
    const { update } = await import("./store");
    const original = vi.mocked(update).getMockImplementation()!;
    vi.mocked(update).mockImplementation(async (table, query, patch) => {
      if (table === "billing_shipments") throw new Error("store hiccup");
      return original(table, query, patch);
    });
    const context = ctx();
    let summary;
    try {
      summary = await runWarehouseStatusPoll(context, { client: fakeClient({ rows: [feedRow("Committed")] }) });
    } finally {
      vi.mocked(update).mockImplementation(original);
    }
    expect(summary).toMatchObject({ errors: 1, matched: 0 });
    expect(context.failures.map((failure) => failure.item)).toEqual(["warehouse:1436119"]);
    expect(state.tables.billing_warehouse_sync_polls[0]).toMatchObject({ ok: true, errors: 1 });
  });
  it("dry runs compute the window and touch nothing; a lost lease stops between rows", async () => {
    const client = fakeClient({ rows: [feedRow("Shipped", [parcel()])] });
    const dry = ctx({ dryRun: true });
    await runWarehouseStatusPoll(dry, { client });
    expect(client.calls).toEqual([]);
    expect(state.tables.billing_warehouse_sync_polls).toEqual([]);
    expect(dry.logs[0]).toMatchObject({ event: "warehouse_status_sync_dry_run", window: { start: "2026-09-11", end: "2026-09-19" } });
    const lost = ctx({ leaseLost: true });
    await runWarehouseStatusPoll(lost, { client });
    expect(ship().status).toBe("processing");
    expect(state.emails).toEqual([]);
  });
  it("trims poll rows older than a week after a successful poll", async () => {
    seed({ polls: [
      { id: "ancient", started_at: "2026-09-01T00:00:00.000Z", finished_at: "2026-09-01T00:00:01.000Z", ok: true, window_start: "2026-08-25", window_end: "2026-09-02" },
      { id: "recent", started_at: "2026-09-17T00:00:00.000Z", finished_at: "2026-09-17T00:00:01.000Z", ok: true, window_start: "2026-09-10", window_end: "2026-09-18" },
    ] });
    await runWarehouseStatusPoll(ctx(), { client: fakeClient() });
    expect(state.tables.billing_warehouse_sync_polls.map((row) => row.id)).toEqual(["recent", expect.any(String)]);
  });
  it("is registered as a 15-minute leased job that tallies unconfigured and does nothing without credentials", async () => {
    expect(warehouseStatusSyncJob).toMatchObject({ name: "warehouse-status-sync", intervalMs: 15 * 60_000 });
    expect(warehouseStatusSyncJob.leaseSeconds).toBeGreaterThanOrEqual(300);
    for (const name of ["WAREHOUSECRAFT_API_BASE_URL", "WAREHOUSECRAFT_API_USERNAME", "WAREHOUSECRAFT_API_PASSWORD", "NOVEX_API_BASE_URL", "NOVEX_API_USERNAME", "NOVEX_API_PASSWORD"]) vi.stubEnv(name, "");
    try {
      const context = ctx();
      await runWarehouseStatusSync(context);
      expect(context.counts).toEqual({ unconfigured: 1 });
      expect(state.tables.billing_warehouse_sync_polls).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("warehouseSyncHealth and the stalled threshold", () => {
  it("summarises the ledger and flags a feed with no success for over the limit", async () => {
    seed({ polls: [
      { id: "a", started_at: "2026-09-18T09:00:00.000Z", finished_at: "2026-09-18T09:00:01.000Z", ok: true, window_start: "2026-09-11", window_end: "2026-09-19", rows_seen: 4, transitions: 1, errors: 0 },
      { id: "b", started_at: "2026-09-18T11:30:00.000Z", finished_at: "2026-09-18T11:30:01.000Z", ok: false, window_start: "2026-09-11", window_end: "2026-09-19", rows_seen: 0, transitions: 0, errors: 1, error: "HTTP 503" },
    ], shipments: [shipmentRow({ warehouse_back_ordered: true }), shipmentRow({ id: "s2", order_id: "o2", warehouse_status: "Shipped" })] });
    const health = await warehouseSyncHealth(NOW);
    expect(health).toMatchObject({
      last_success_at: "2026-09-18T09:00:01.000Z", last_poll_at: "2026-09-18T11:30:00.000Z", last_error: "HTTP 503", last_window: { start: "2026-09-11", end: "2026-09-19" },
      rows_seen_24h: 4, transitions_24h: 1, errors_24h: 1, polls_24h: 2, failed_polls_24h: 1, stalled: true, stalled_after_minutes: 60, back_ordered: 1, awaiting_tracking: 1,
    });
    const findings = evaluateThresholds({ latencyLastHour: [], growth: null, now: NOW, warehousePoll: { lastSuccessAt: health.last_success_at, lastPollAt: health.last_poll_at, stalledAfterMinutes: health.stalled_after_minutes, lastError: health.last_error } });
    expect(findings).toEqual([expect.objectContaining({ metric: "warehouse_poll", level: "red", value: 179, limit: 60 })]);
    expect(findings[0].message).toContain("Last error: HTTP 503");
  });
  it("is quiet while the feed is fresh or has never run", async () => {
    expect(await warehouseSyncHealth(NOW)).toMatchObject({ stalled: false, last_poll_at: null, polls_24h: 0 });
    expect(evaluateThresholds({ latencyLastHour: [], growth: null, now: NOW, warehousePoll: { lastSuccessAt: null, lastPollAt: null, stalledAfterMinutes: 60, lastError: null } })).toEqual([]);
    expect(evaluateThresholds({ latencyLastHour: [], growth: null, now: NOW, warehousePoll: { lastSuccessAt: "2026-09-18T11:30:00.000Z", lastPollAt: "2026-09-18T11:45:00.000Z", stalledAfterMinutes: 60, lastError: "blip" } })).toEqual([]);
    // Never succeeded but polling for longer than the limit: also red.
    expect(evaluateThresholds({ latencyLastHour: [], growth: null, now: NOW, warehousePoll: { lastSuccessAt: null, lastPollAt: "2026-09-18T10:00:00.000Z", stalledAfterMinutes: 60, lastError: "auth" } })[0]?.message).toContain("never synced");
  });
});
