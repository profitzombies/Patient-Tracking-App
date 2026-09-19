import { notifyShipmentTransition } from "./customer-emails";
import { trackingUrl } from "./receipts";
import {
  insertIgnore, nowIso, selectMany, selectOne, update, type BillingOrderRow, type BillingShipmentRow,
  type BillingShipmentStatus,
} from "./store";
import type { OrderShipmentState, PatientShipment } from "./types";
import { assertShipmentTransition, warehouseStatusLabel } from "./warehouse-status";

/**
 * One shipment per order. Staff fulfillment writes (and, later, shipping
 * provider callbacks) land here; the legacy fulfillment columns on the order
 * row are mirrored on every write so HQ/office screens, filters, and the
 * shipped-notice email keep reading what they always read.
 */
const enc = encodeURIComponent;

const LEGACY_STATUS: Record<BillingShipmentStatus, BillingOrderRow["fulfillment_status"]> = {
  processing: "to_ship", shipped: "shipped", delivered: "shipped", canceled: "canceled",
};

export function shipmentStatusFromLegacy(status: string): BillingShipmentStatus {
  if (status === "shipped") return "shipped";
  if (status === "canceled") return "canceled";
  return "processing";
}

export type ShipmentWrite = {
  status: BillingShipmentStatus;
  carrier?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  canceled_reason?: string | null;
  source?: "staff" | "provider";
  external_id?: string | null;
  label_created_at?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  event?: Record<string, unknown> | null;
  updated_by?: string | null;
  /** Extra shipment columns written in the same patch (warehouse feed bookkeeping). */
  extra?: Partial<Pick<BillingShipmentRow, "warehouse_status" | "warehouse_status_at" | "warehouse_back_ordered" | "warehouse_event_key" | "warehouse_last_event" | "warehouse_synced_at">>;
};

/** Ensures the row exists (orders created before the trigger, or in test backends). */
export async function ensureShipment(order: Pick<BillingOrderRow, "id" | "provider_id" | "fulfillment_status" | "carrier" | "tracking_number" | "shipped_at" | "canceled_reason" | "shipped_by">): Promise<BillingShipmentRow> {
  const existing = await selectOne("billing_shipments", `order_id=eq.${enc(order.id)}`);
  if (existing) return existing;
  const status = shipmentStatusFromLegacy(order.fulfillment_status);
  const inserted = await insertIgnore("billing_shipments", {
    order_id: order.id, provider_id: order.provider_id, status,
    carrier: order.carrier ?? null, tracking_number: order.tracking_number ?? null,
    tracking_url: order.tracking_number ? trackingUrl(order.carrier ?? null, order.tracking_number) : null,
    source: "staff", external_id: null, label_created_at: null, shipped_at: order.shipped_at ?? null,
    delivered_at: null, canceled_at: status === "canceled" ? nowIso() : null,
    canceled_reason: order.canceled_reason ?? null, events: [], updated_by: order.shipped_by ?? null,
  }, "billing_shipments_order_id_key");
  const row = inserted ?? await selectOne("billing_shipments", `order_id=eq.${enc(order.id)}`);
  if (!row) throw new Error("Shipment record could not be created.");
  return row;
}

/**
 * Records a shipment state and mirrors it onto the order. Returns the updated
 * order row (what callers already rendered) plus the shipment.
 */
export async function recordShipment(order: BillingOrderRow, write: ShipmentWrite): Promise<{ order: BillingOrderRow; shipment: BillingShipmentRow }> {
  const current = await ensureShipment(order);
  // One forward-only guard for staff and provider writes alike: a delivered or
  // canceled order never moves again, and a shipped order never goes back to
  // processing. Re-saving the same status is fine (no email rides a re-save).
  assertShipmentTransition(current.status, write.status);
  const now = nowIso();
  const tracking = write.tracking_number === undefined ? current.tracking_number : write.tracking_number;
  const carrier = write.carrier === undefined ? current.carrier : write.carrier;
  const url = write.tracking_url ?? (tracking ? trackingUrl(carrier, tracking) : null);
  const patch: Partial<BillingShipmentRow> = {
    status: write.status, carrier, tracking_number: tracking, tracking_url: url,
    source: write.source ?? "staff", updated_by: write.updated_by ?? current.updated_by,
    external_id: write.external_id === undefined ? current.external_id : write.external_id,
    label_created_at: write.label_created_at === undefined ? current.label_created_at : write.label_created_at,
    events: write.event ? [...(current.events ?? []), { at: now, status: write.status, detail: write.event }] : current.events ?? [],
    ...(write.extra ?? {}),
  };
  if (write.status === "processing") {
    Object.assign(patch, { carrier: null, tracking_number: null, tracking_url: null, shipped_at: null, delivered_at: null, canceled_at: null, canceled_reason: null });
  } else if (write.status === "shipped") {
    Object.assign(patch, { shipped_at: write.shipped_at ?? current.shipped_at ?? now, delivered_at: null, canceled_at: null, canceled_reason: null });
  } else if (write.status === "delivered") {
    Object.assign(patch, { shipped_at: write.shipped_at ?? current.shipped_at ?? now, delivered_at: write.delivered_at ?? now, canceled_at: null, canceled_reason: null });
  } else {
    Object.assign(patch, { canceled_at: now, canceled_reason: write.canceled_reason ?? current.canceled_reason ?? null });
  }
  const shipment = (await update("billing_shipments", `id=eq.${enc(current.id)}`, patch)) ?? { ...current, ...patch } as BillingShipmentRow;
  const legacy = LEGACY_STATUS[write.status];
  const orderPatch = legacy === "shipped" ? {
    fulfillment_status: "shipped", tracking_number: shipment.tracking_number, carrier: shipment.carrier,
    shipped_at: shipment.shipped_at, shipped_by: write.updated_by ?? order.shipped_by ?? null, canceled_reason: null,
  } : legacy === "canceled" ? {
    fulfillment_status: "canceled", canceled_reason: shipment.canceled_reason,
  } : { fulfillment_status: "to_ship", tracking_number: null, carrier: null, shipped_at: null, shipped_by: null, canceled_reason: null };
  const updatedOrder = await update("billing_orders", `id=eq.${enc(order.id)}`, orderPatch);
  const result = { order: updatedOrder ?? { ...order, ...orderPatch } as BillingOrderRow, shipment };
  // Shipped / delivered emails ride the status transition itself (never a
  // re-save of the same status) and can never fail the write above.
  await notifyShipmentTransition(result.order, shipment, current.status);
  return result;
}

/** Patient-facing shipment block; synthesized from the order when no row exists yet. */
export function shipmentDto(order: BillingOrderRow, shipment: BillingShipmentRow | null): PatientShipment {
  if (shipment) {
    return {
      status: shipment.status, carrier: shipment.carrier, tracking_number: shipment.tracking_number,
      tracking_url: shipment.tracking_url ?? (shipment.tracking_number ? trackingUrl(shipment.carrier, shipment.tracking_number) : null),
      shipped_at: shipment.shipped_at, delivered_at: shipment.delivered_at, canceled_at: shipment.canceled_at,
      updated_at: shipment.updated_at ?? shipment.created_at,
    };
  }
  const status = shipmentStatusFromLegacy(order.fulfillment_status);
  return {
    status, carrier: order.carrier, tracking_number: order.tracking_number,
    tracking_url: order.tracking_number ? trackingUrl(order.carrier, order.tracking_number) : null,
    shipped_at: order.shipped_at, delivered_at: null, canceled_at: null, updated_at: order.updated_at ?? order.created_at,
  };
}

/** Staff-facing shipment state block for order detail rows. */
export function shipmentStateDto(shipment: BillingShipmentRow | null): OrderShipmentState | null {
  if (!shipment) return null;
  return {
    status: shipment.status, source: shipment.source, delivered_at: shipment.delivered_at,
    back_ordered: shipment.warehouse_back_ordered === true,
    warehouse_status: warehouseStatusLabel(shipment.warehouse_status), warehouse_status_at: shipment.warehouse_status_at ?? null,
  };
}

export async function shipmentsForOrders(orderIds: string[]): Promise<Map<string, BillingShipmentRow>> {
  if (!orderIds.length) return new Map();
  const rows = await selectMany("billing_shipments", `order_id=in.(${orderIds.map(enc).join(",")})`);
  return new Map(rows.map((row) => [row.order_id, row]));
}
