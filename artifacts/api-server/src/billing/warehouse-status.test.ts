import { describe, expect, it } from "vitest";
import type { WarehouseOrderStatus, WarehouseParcel } from "../shipping/warehousecraft-status";
import {
  ShipmentTransitionError, assertShipmentTransition, canTransitionShipment, mapWarehouseStatus, warehouseStatusLabel,
} from "./warehouse-status";

const parcel = (overrides: Partial<WarehouseParcel> = {}): WarehouseParcel => ({
  ship_date: "2026-09-18T20:00:00.000Z", deliver_date: null, tracking_status: null, tracking_status_kind: null, tracking_exceptions: null,
  carrier: "USPS", tracking_number: "9400111899223", weight_lbs: 1.2, ...overrides,
});
const row = (status: string, parcels: WarehouseParcel[] = []): WarehouseOrderStatus => ({
  order_id: 1436119, client_order_id: "TH-000123", order_date: "2026-09-18T17:00:00.000Z", import_date: "2026-09-18T17:01:00.000Z",
  status, carrier_code: "USPS", shipping_method: "USPS Ground Advantage", parcels, raw: { OrderStatus: status },
});

describe("mapWarehouseStatus", () => {
  it.each(["Imported", "Created", "Editing", "Modified", "Reset", "On Hold", "Released Back Order", "Committed", "Being Fulfilled", "Fulfilled"])(
    "maps %s to processing with the raw status kept for staff", (status) => {
      expect(mapWarehouseStatus(row(status))).toMatchObject({ kind: "state", status: "processing", back_ordered: false, raw_status: status, tracking_number: null });
    },
  );
  it("flags Back Order as processing + back-ordered", () => {
    expect(mapWarehouseStatus(row("Back Order"))).toMatchObject({ kind: "state", status: "processing", back_ordered: true, event_key: "processing:back_order@-" });
    expect(mapWarehouseStatus(row("Released Back Order"))).toMatchObject({ status: "processing", back_ordered: false });
  });
  it("maps Shipped / Closed with a parcel to shipped carrying the warehouse tracking and ship date", () => {
    for (const status of ["Shipped", "Closed", "shipped"]) {
      expect(mapWarehouseStatus(row(status, [parcel()]))).toMatchObject({
        kind: "state", status: "shipped", carrier: "USPS", tracking_number: "9400111899223", shipped_at: "2026-09-18T20:00:00.000Z", delivered_at: null,
        event_key: "shipped@2026-09-18T20:00:00.000Z:9400111899223",
      });
    }
  });
  it("holds Shipped / Closed without a tracking number (tracking is required to ship)", () => {
    expect(mapWarehouseStatus(row("Shipped"))).toMatchObject({ kind: "awaiting_tracking", raw_status: "Shipped" });
    expect(mapWarehouseStatus(row("Closed", [parcel({ tracking_number: null })]))).toMatchObject({ kind: "awaiting_tracking" });
  });
  it("maps a DeliverDate or a delivered tracking status to delivered", () => {
    expect(mapWarehouseStatus(row("Shipped", [parcel({ deliver_date: "2026-09-21T18:00:00.000Z" })]))).toMatchObject({
      kind: "state", status: "delivered", delivered_at: "2026-09-21T18:00:00.000Z", shipped_at: "2026-09-18T20:00:00.000Z", tracking_number: "9400111899223",
      event_key: "delivered@2026-09-21T18:00:00.000Z:9400111899223",
    });
    expect(mapWarehouseStatus(row("Closed", [parcel({ tracking_status: "Delivered, Front Door", tracking_status_kind: "delivered" })]))).toMatchObject({ status: "delivered" });
    // A delivery exception is not a delivery.
    expect(mapWarehouseStatus(row("Shipped", [parcel({ tracking_status: "Not Delivered", tracking_status_kind: "exception" })]))).toMatchObject({ status: "shipped" });
  });
  it("prefers the delivered parcel of a multi-parcel order, else the first with tracking", () => {
    const mapped = mapWarehouseStatus(row("Shipped", [parcel({ tracking_number: null }), parcel({ tracking_number: "A" }), parcel({ tracking_number: "B", deliver_date: "2026-09-21T18:00:00.000Z" })]));
    expect(mapped).toMatchObject({ status: "delivered", tracking_number: "B" });
    expect(mapWarehouseStatus(row("Shipped", [parcel({ tracking_number: null }), parcel({ tracking_number: "A" })]))).toMatchObject({ status: "shipped", tracking_number: "A" });
  });
  it("maps Cancelled (either spelling) to canceled", () => {
    expect(mapWarehouseStatus(row("Cancelled"))).toMatchObject({ kind: "state", status: "canceled", event_key: "canceled@-" });
    expect(mapWarehouseStatus(row("Canceled"))).toMatchObject({ status: "canceled" });
  });
  it("records an unknown status without a transition", () => {
    expect(mapWarehouseStatus(row("Quarantined"))).toEqual({ kind: "unknown", raw_status: "Quarantined", event_key: "unknown:quarantined@-" });
  });
  it("keys events so a re-read of the same row is the same event and a new tracking number is not", () => {
    const first = mapWarehouseStatus(row("Shipped", [parcel()]));
    const again = mapWarehouseStatus(row("Shipped", [parcel()]));
    const relabelled = mapWarehouseStatus(row("Shipped", [parcel({ tracking_number: "NEW" })]));
    expect(first.event_key).toBe(again.event_key);
    expect(relabelled.event_key).not.toBe(first.event_key);
  });
});

describe("shipment transition guard", () => {
  it("allows forward moves and same-status re-saves only", () => {
    const allowed: Array<[string, string]> = [];
    for (const from of ["processing", "shipped", "delivered", "canceled"] as const) {
      for (const to of ["processing", "shipped", "delivered", "canceled"] as const) {
        if (canTransitionShipment(from, to)) allowed.push([from, to]);
      }
    }
    expect(allowed).toEqual([
      ["processing", "processing"], ["processing", "shipped"], ["processing", "delivered"], ["processing", "canceled"],
      ["shipped", "shipped"], ["shipped", "delivered"], ["shipped", "canceled"],
      ["delivered", "delivered"],
      ["canceled", "canceled"],
    ]);
  });
  it("throws a 409 with staff wording for backward moves", () => {
    expect(() => assertShipmentTransition("shipped", "processing")).toThrow(ShipmentTransitionError);
    try { assertShipmentTransition("delivered", "shipped"); } catch (error) {
      expect(error).toMatchObject({ status: 409, message: "This order was already delivered." });
    }
    try { assertShipmentTransition("canceled", "shipped"); } catch (error) {
      expect(error).toMatchObject({ status: 409, message: "This order was canceled and cannot be reopened." });
    }
    expect(() => assertShipmentTransition("processing", "delivered")).not.toThrow();
  });
});

describe("warehouseStatusLabel", () => {
  it("title-cases the raw status for staff and hides blanks", () => {
    expect(warehouseStatusLabel("being fulfilled")).toBe("Being Fulfilled");
    expect(warehouseStatusLabel("Back Order")).toBe("Back Order");
    expect(warehouseStatusLabel("  ")).toBeNull();
    expect(warehouseStatusLabel(null)).toBeNull();
  });
});
