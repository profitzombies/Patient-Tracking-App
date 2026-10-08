import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/warehousecraft-orders.json";
import { WarehouseCraftError } from "./warehousecraft";
import {
  ADDRESS_EDITABLE_STATUSES, EDITABLE_STATUSES, METHOD_CODES, WarehousePayloadError, buildWarehouseOrder, canCancelAtWarehouse,
  canEditAddressAtWarehouse, isCancelledAtWarehouse, parseCreateResponse, parseWarehouseOrder, warehouseOrderClient,
} from "./warehousecraft-orders";

type Call = { label: string; method: string; path: string; request: unknown; status: number; body: unknown };
const calls = fixture.calls as Call[];
const recorded = (label: string): Call => {
  const call = calls.find((entry) => entry.label === label);
  if (!call) throw new Error(`fixture has no call ${label}`);
  return call;
};

const ADDRESS = { name: "THINNR API Test", line1: "123 Test Street", line2: null, city: "Memphis", state: "tn", postal_code: "38103", country: "US", phone: "(901) 555-0100" };
const LINES = [
  { sku: "Test01", name: "Bundle A", quantity: 1, unit_price_cents: 4900 },
  { sku: "Test03", name: "Bundle C", quantity: 2, unit_price_cents: 1950 },
];

describe("buildWarehouseOrder", () => {
  it("reproduces the recorded create request from order rows", () => {
    const payload = buildWarehouseOrder({
      order_number: "TH-APITEST2", paid_at: "2026-09-18T12:00:00Z", address: ADDRESS, email: "test@example.com",
      method: "standard", notes: "API connectivity test - do not ship", lines: LINES,
    });
    const expected = recorded("create").request as Record<string, unknown>;
    expect(payload).toMatchObject(expected);
    expect(payload.State).toBe("TN");
    expect(payload.Phone).toBe("9015550100");
    expect(payload.ClientOrderId).not.toContain("#");
  });
  it("maps the two shipping methods to the codes the warehouse accepts", () => {
    expect(METHOD_CODES).toEqual({ standard: "USPS_GroundAdvantage", expedited: "USPS_PriorityMail" });
    expect(buildWarehouseOrder({ order_number: "TH-1", paid_at: "2026-09-18T12:00:00Z", address: ADDRESS, email: null, method: "expedited", lines: LINES }).ShippingMethod).toBe("USPS_PriorityMail");
  });
  it("refuses orders that cannot be represented instead of sending them", () => {
    const base = { order_number: "TH-1", paid_at: "2026-09-18T12:00:00Z", address: ADDRESS, email: null, method: "standard" as const };
    expect(() => buildWarehouseOrder({ ...base, lines: [] })).toThrow(WarehousePayloadError);
    expect(() => buildWarehouseOrder({ ...base, lines: [{ ...LINES[0], sku: null }] })).toThrow(/No WarehouseCraft SKU for: Bundle A/);
    expect(() => buildWarehouseOrder({ ...base, lines: LINES, address: { ...ADDRESS, postal_code: " " } })).toThrow(/missing the ZIP/);
    expect(() => buildWarehouseOrder({ ...base, lines: LINES, paid_at: "nope" })).toThrow(WarehousePayloadError);
  });
});

describe("parseCreateResponse", () => {
  it("reads a success verdict and the new OrderId", () => {
    expect(parseCreateResponse(recorded("create").body, "TH-APITEST2")).toEqual({ kind: "created", order_id: 1436119 });
  });
  it("treats a duplicate ClientOrderId as an earlier success and keeps the id", () => {
    expect(parseCreateResponse(recorded("create_duplicate").body, "TH-APITEST2")).toEqual({ kind: "duplicate", order_id: 1436119 });
  });
  it("reports unknown SKUs and unknown methods as definite rejections with the warehouse's message", () => {
    const sku = parseCreateResponse(recorded("create_unknown_sku").body, "TH-APITEST2-BADSKU");
    expect(sku.kind).toBe("rejected");
    expect((sku as { message: string }).message).toMatch(/ItemSKU not recognized/);
    const method = parseCreateResponse(recorded("create_bad_method").body, "TH-APITEST2-BADMETHOD");
    expect(method).toMatchObject({ kind: "rejected", message: expect.stringMatching(/Unknown shipping method/) });
  });
  it("throws a transient error when the response carries no verdict for the order", () => {
    expect(() => parseCreateResponse({ ResultOrder: [] }, "TH-X")).toThrow(WarehouseCraftError);
  });
});

describe("parseWarehouseOrder", () => {
  it("reads the order shape returned by lookup and edits", () => {
    const order = parseWarehouseOrder(recorded("lookup_hit").body);
    expect(order).toMatchObject({ order_id: 1436119, client_order_id: "TH-APITEST2", status: "Imported", shipping_method: "USPS Ground Advantage" });
    expect(order.lines).toEqual([{ sku: "Test01", quantity: 1 }, { sku: "Test03", quantity: 2 }]);
    expect(parseWarehouseOrder(recorded("after_cancel").body).status).toBe("Cancelled");
  });
});

describe("status gating", () => {
  it("allows cancels only in the 3PL's editable statuses and address edits also while Committed", () => {
    for (const status of ["Imported", "On Hold", "Back Order", "Created", "Modified", "Reset", "Released Back Order", "Editing"]) {
      expect(canCancelAtWarehouse(status), status).toBe(true);
      expect(canEditAddressAtWarehouse(status), status).toBe(true);
    }
    expect(canCancelAtWarehouse("Committed")).toBe(false);
    expect(canEditAddressAtWarehouse("Committed")).toBe(true);
    for (const status of ["Picked", "Packed", "Shipped", "Cancelled", "", null, undefined]) {
      expect(canCancelAtWarehouse(status), String(status)).toBe(false);
      expect(canEditAddressAtWarehouse(status), String(status)).toBe(false);
    }
    expect(isCancelledAtWarehouse("cancelled")).toBe(true);
    expect(isCancelledAtWarehouse("Canceled")).toBe(true);
    expect(ADDRESS_EDITABLE_STATUSES.size).toBe(EDITABLE_STATUSES.size + 1);
  });
});

describe("warehouseOrderClient", () => {
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
  const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

  it("uses only the live login once the tenant is live, and only the test login otherwise", async () => {
    vi.stubEnv("WAREHOUSECRAFT_API_BASE_URL", "https://live-tenant.example.test");
    vi.stubEnv("WAREHOUSECRAFT_API_USERNAME", "live-user");
    vi.stubEnv("WAREHOUSECRAFT_API_PASSWORD", "live-pass");
    const lookupWith = async () => {
      fetchMock.mockResolvedValueOnce(reply(recorded("lookup_miss")));
      await warehouseOrderClient.lookup("TH-1");
      const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
      return { url, auth: (init.headers as Record<string, string>).Authorization };
    };
    // Saved live login, no flag: still the test tenant and its own login.
    await expect(lookupWith()).resolves.toEqual({ url: "https://tenant.example.test/api/OrderDatas?clientOrderId=TH-1", auth: basic("user", "pass") });
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "live");
    await expect(lookupWith()).resolves.toEqual({ url: "https://live-tenant.example.test/api/OrderDatas?clientOrderId=TH-1", auth: basic("live-user", "live-pass") });
    // Flag with an incomplete live login: back on the test tenant, never a mix of the two.
    vi.stubEnv("WAREHOUSECRAFT_API_USERNAME", "");
    await expect(lookupWith()).resolves.toEqual({ url: "https://tenant.example.test/api/OrderDatas?clientOrderId=TH-1", auth: basic("user", "pass") });
  });

  it("creates through the tenant OrderDatas route with Basic auth", async () => {
    fetchMock.mockResolvedValueOnce(reply(recorded("create")));
    const payload = buildWarehouseOrder({ order_number: "TH-APITEST2", paid_at: "2026-09-18T12:00:00Z", address: ADDRESS, email: null, method: "standard", lines: LINES });
    await expect(warehouseOrderClient.create(payload)).resolves.toEqual({ kind: "created", order_id: 1436119 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://tenant.example.test/api/OrderDatas");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(JSON.parse(String(init.body)).ClientOrderId).toBe("TH-APITEST2");
  });
  it("refuses to send an order without lines even though the API would accept it", async () => {
    const payload = buildWarehouseOrder({ order_number: "TH-1", paid_at: "2026-09-18T12:00:00Z", address: ADDRESS, email: null, method: "standard", lines: LINES });
    await expect(warehouseOrderClient.create({ ...payload, OrderDetailData: [] })).rejects.toThrow(WarehousePayloadError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("returns null on a lookup miss and the order on a hit", async () => {
    fetchMock.mockResolvedValueOnce(reply(recorded("lookup_miss")));
    await expect(warehouseOrderClient.lookup("TH-APITEST2")).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(reply(recorded("lookup_hit")));
    await expect(warehouseOrderClient.lookup("TH-APITEST2")).resolves.toMatchObject({ order_id: 1436119, status: "Imported" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://tenant.example.test/api/OrderDatas?clientOrderId=TH-APITEST2");
  });
  it("edits and cancels via PUT with the OrderId in the body", async () => {
    fetchMock.mockResolvedValueOnce(reply(recorded("edit_address")));
    await warehouseOrderClient.editAddress(1436119, { ...ADDRESS, line1: "456 Edited Ave" });
    let [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://tenant.example.test/api/OrderDatas/1436119");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({ OrderId: 1436119, AddressLine1: "456 Edited Ave", State: "TN" });
    fetchMock.mockResolvedValueOnce(reply(recorded("cancel")));
    await expect(warehouseOrderClient.cancel(1436119)).resolves.toMatchObject({ status: "Cancelled" });
    [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ OrderId: 1436119, OrderStatus: "Cancelled" });
  });
  it("classifies auth and server failures as transient and a 404 edit as definite", async () => {
    fetchMock.mockResolvedValueOnce(reply(recorded("bad_credentials")));
    await expect(warehouseOrderClient.lookup("TH-1")).rejects.toMatchObject({ kind: "transient", status: 401 });
    fetchMock.mockResolvedValueOnce(new Response("upstream down", { status: 503 }));
    await expect(warehouseOrderClient.lookup("TH-1")).rejects.toMatchObject({ kind: "transient", status: 503 });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(warehouseOrderClient.lookup("TH-1")).rejects.toMatchObject({ kind: "transient", status: null });
    fetchMock.mockResolvedValueOnce(reply(recorded("edit_unknown_order")));
    await expect(warehouseOrderClient.cancel(99999999)).rejects.toMatchObject({ kind: "bad_address", status: 404, message: expect.stringMatching(/order was not found/) });
  });
  it("fails transiently (never as a rejection) when credentials are not configured", async () => {
    vi.stubEnv("WAREHOUSECRAFT_API_PASSWORD", "");
    vi.stubEnv("NOVEX_API_PASSWORD", "");
    await expect(warehouseOrderClient.lookup("TH-1")).rejects.toMatchObject({ kind: "transient" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
