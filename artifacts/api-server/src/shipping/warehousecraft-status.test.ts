import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/warehousecraft-order-status.json";
import { WarehouseCraftError } from "./warehousecraft";
import {
  addDays, normalizeTrackingStatus, parseWarehouseOrderStatus, parseWarehouseOrderStatusList, warehouseDate, warehouseStatusClient,
  warehouseTimestampToIso,
} from "./warehousecraft-status";

type Call = { label: string; method: string; path: string; status: number; body: unknown };
const calls = fixture.calls as Call[];
const recorded = (label: string): Call => {
  const call = calls.find((entry) => entry.label === label);
  if (!call) throw new Error(`fixture has no call ${label}`);
  return call;
};

describe("warehouse timestamps", () => {
  it("treats zone-less feed timestamps as warehouse local (Central) time", () => {
    // September = CDT (UTC−5); the recorded ImportDate trails the UTC recording time by 5 h.
    expect(warehouseTimestampToIso("2026-09-18T15:38:13.093")).toBe("2026-09-18T20:38:13.093Z");
    // January = CST (UTC−6).
    expect(warehouseTimestampToIso("2026-01-10T08:00:00")).toBe("2026-01-10T14:00:00.000Z");
    expect(warehouseTimestampToIso("2019-03-28T00:00:00")).toBe("2019-03-28T05:00:00.000Z");
  });
  it("honours explicit designators and rejects garbage", () => {
    expect(warehouseTimestampToIso("2026-09-17T22:26:24.4360613+00:00")).toBe("2026-09-17T22:26:24.436Z");
    expect(warehouseTimestampToIso("2026-09-17T22:26:24Z")).toBe("2026-09-17T22:26:24.000Z");
    expect(warehouseTimestampToIso(null)).toBeNull();
    expect(warehouseTimestampToIso("")).toBeNull();
    expect(warehouseTimestampToIso("yesterday")).toBeNull();
  });
  it("derives the warehouse calendar date of an instant", () => {
    // 03:30 UTC on the 19th is still the evening of the 18th in Chicago.
    expect(warehouseDate(new Date("2026-09-19T03:30:00Z"))).toBe("2026-09-18");
    expect(warehouseDate(new Date("2026-09-19T05:30:00Z"))).toBe("2026-09-19");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("normalizeTrackingStatus", () => {
  it("classifies the carrier vocabulary, exceptions before delivery", () => {
    expect(normalizeTrackingStatus("Delivered")).toBe("delivered");
    expect(normalizeTrackingStatus("Delivered, In/At Mailbox")).toBe("delivered");
    expect(normalizeTrackingStatus("Not Delivered")).toBe("exception");
    expect(normalizeTrackingStatus("Undelivered")).toBe("exception");
    expect(normalizeTrackingStatus("Delivery attempt made")).toBe("exception");
    expect(normalizeTrackingStatus("Return to Sender")).toBe("exception");
    expect(normalizeTrackingStatus("Out for Delivery")).toBe("out_for_delivery");
    expect(normalizeTrackingStatus("In Transit")).toBe("in_transit");
    expect(normalizeTrackingStatus("Label Created")).toBe("in_transit");
    expect(normalizeTrackingStatus("sample string 4")).toBe("unknown");
    expect(normalizeTrackingStatus(null)).toBeNull();
    expect(normalizeTrackingStatus("  ")).toBeNull();
  });
});

describe("parseWarehouseOrderStatus", () => {
  it("parses the recorded window rows (no parcels yet)", () => {
    const rows = parseWarehouseOrderStatusList(recorded("by_date_window").body);
    expect(rows.map((row) => [row.order_id, row.client_order_id, row.status])).toEqual([
      [1436119, "TH-APITEST2", "Cancelled"], [1436120, "TH-APITEST2-NOITEMS", "Cancelled"], [1435883, "TH-APITEST1", "Committed"],
    ]);
    expect(rows[2]).toMatchObject({ carrier_code: "UPS", shipping_method: "UPS Ground", parcels: [], import_date: "2026-09-17T14:34:31.597Z" });
    expect(rows[0].raw).toMatchObject({ OrderId: 1436119, OrderStatus: "Cancelled" });
  });
  it("parses a shipped row with a parcel (another client's order, as the tenant answers by id)", () => {
    const row = parseWarehouseOrderStatus(recorded("by_id_foreign_order").body);
    expect(row).toMatchObject({ order_id: 1, client_order_id: "ISC_TEST2019032801", status: "Closed" });
    expect(row.parcels).toEqual([{
      ship_date: "2019-03-29T03:20:22.513Z", deliver_date: null, tracking_status: null, tracking_status_kind: null, tracking_exceptions: null,
      carrier: "USPS", tracking_number: "TEST12345678901", weight_lbs: null,
    }]);
  });
  it("parses the documented schema fields when the feed sends them", () => {
    const row = parseWarehouseOrderStatus((fixture.doc_sample.body as unknown[])[0]);
    expect(row.parcels[0]).toMatchObject({ deliver_date: "2026-09-17T22:26:24.436Z", tracking_status: "sample string 4", tracking_status_kind: "unknown", tracking_exceptions: "sample string 5", weight_lbs: 1.1 });
  });
  it("rejects shapes that are not rows", () => {
    expect(() => parseWarehouseOrderStatusList({})).toThrow(WarehouseCraftError);
    expect(() => parseWarehouseOrderStatus({ ClientOrderId: "x" })).toThrow(WarehouseCraftError);
  });
});

describe("warehouseStatusClient", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    // The test tenant (no live flag) signs in with the NOVEX_API_* login.
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "");
    vi.stubEnv("NOVEX_API_BASE_URL", "https://tenant.example.test");
    vi.stubEnv("NOVEX_API_USERNAME", "user");
    vi.stubEnv("NOVEX_API_PASSWORD", "pass");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const reply = (call: Call) => new Response(JSON.stringify(call.body), { status: call.status, headers: { "content-type": "application/json" } });

  it("reads a date-only window through the tenant OrderStatusDatas route", async () => {
    fetchMock.mockResolvedValueOnce(reply(recorded("by_date_window")));
    const rows = await warehouseStatusClient.byDate("2026-09-17", "2026-09-18");
    expect(rows).toHaveLength(3);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://tenant.example.test/api/OrderStatusDatas?startDate=2026-09-17&endDate=2026-09-18");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });
  it("refuses datetime bounds (the tenant handles them unpredictably)", async () => {
    await expect(warehouseStatusClient.byDate("2026-09-17T00:00:00Z", "2026-09-18")).rejects.toThrow(WarehouseCraftError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reads by id and by client order id; a miss is null, a server error is transient", async () => {
    fetchMock.mockResolvedValueOnce(reply(recorded("by_id")));
    await expect(warehouseStatusClient.byId(1436119)).resolves.toMatchObject({ order_id: 1436119, status: "Cancelled" });
    fetchMock.mockResolvedValueOnce(reply(recorded("by_client_order_id_miss")));
    await expect(warehouseStatusClient.byClientOrderId("TH-NOPE")).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(reply(recorded("by_client_order_id")));
    await expect(warehouseStatusClient.byClientOrderId("TH-APITEST2")).resolves.toMatchObject({ client_order_id: "TH-APITEST2" });
    fetchMock.mockResolvedValueOnce(new Response("upstream down", { status: 503 }));
    await expect(warehouseStatusClient.byDate("2026-09-17", "2026-09-18")).rejects.toMatchObject({ kind: "transient", status: 503 });
  });
});
