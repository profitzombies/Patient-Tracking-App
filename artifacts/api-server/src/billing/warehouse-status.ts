/**
 * Pure rules for the WarehouseCraft status feed: the 3PL vocabulary → our
 * shipment states, the forward-only transition table shared by staff and
 * provider writes, and the idempotency key of one warehouse event.
 *
 * Mapping (from the 3PL):
 * - Imported / Created / Editing / Modified / Reset / On Hold / Released Back
 *   Order / Committed / Being Fulfilled / Fulfilled → processing (raw status
 *   shown to staff, patient copy stays neutral).
 * - Back Order → processing with the back-ordered flag (staff alert).
 * - Shipped / Closed → shipped; tracking is required, so a shipped row without
 *   a tracking number is held until the warehouse uploads one.
 * - A DeliverDate, or a delivered tracking status, → delivered.
 * - Cancelled → canceled.
 */
import type { WarehouseOrderStatus, WarehouseParcel } from "../shipping/warehousecraft-status";
import type { BillingShipmentStatus } from "./store";

export const PROCESSING_STATUSES = new Set([
  "imported", "created", "editing", "modified", "reset", "on hold", "released back order", "committed", "being fulfilled", "fulfilled",
]);
export const BACK_ORDER_STATUSES = new Set(["back order", "backorder", "back ordered", "back-order"]);
export const SHIPPED_STATUSES = new Set(["shipped", "closed"]);
export const CANCELED_STATUSES = new Set(["cancelled", "canceled"]);

export const normalizeWarehouseStatus = (status: string | null | undefined): string => (status ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export type MappedWarehouseStatus =
  | {
    kind: "state";
    status: BillingShipmentStatus;
    back_ordered: boolean;
    raw_status: string;
    carrier: string | null;
    tracking_number: string | null;
    shipped_at: string | null;
    delivered_at: string | null;
    /** Idempotency key: same key = same event already applied. */
    event_key: string;
  }
  /** Shipped/Closed without a tracking number: wait for the upload rather than ship blind. */
  | { kind: "awaiting_tracking"; raw_status: string; event_key: string }
  /** A status the mapping table does not know: recorded for staff, no transition. */
  | { kind: "unknown"; raw_status: string; event_key: string };

/** The parcel that decides the order state: delivered first, else the first one with tracking, else the first. */
export function primaryParcel(parcels: readonly WarehouseParcel[]): WarehouseParcel | null {
  if (!parcels.length) return null;
  return parcels.find((parcel) => parcel.deliver_date || parcel.tracking_status_kind === "delivered")
    ?? parcels.find((parcel) => parcel.tracking_number)
    ?? parcels[0];
}

export function mapWarehouseStatus(row: WarehouseOrderStatus): MappedWarehouseStatus {
  const raw_status = row.status.trim();
  const normalized = normalizeWarehouseStatus(raw_status);
  const parcel = primaryParcel(row.parcels);
  const carrier = parcel?.carrier ?? row.carrier_code ?? null;
  const tracking_number = parcel?.tracking_number ?? null;
  const shipped_at = parcel?.ship_date ?? null;
  const delivered_at = parcel?.deliver_date ?? (parcel?.tracking_status_kind === "delivered" ? parcel.ship_date : null);
  const delivered = Boolean(parcel && (parcel.deliver_date || parcel.tracking_status_kind === "delivered"));
  const key = (status: string, stamp: string | null) => `${status}@${stamp ?? "-"}${tracking_number ? `:${tracking_number}` : ""}`;
  if (CANCELED_STATUSES.has(normalized)) {
    return { kind: "state", status: "canceled", back_ordered: false, raw_status, carrier: null, tracking_number: null, shipped_at: null, delivered_at: null, event_key: key("canceled", null) };
  }
  // Delivery evidence outranks the order status: a Closed order whose parcel
  // was delivered is delivered, and the 3PL keeps Shipped while the carrier
  // reports delivered.
  if (delivered) {
    return { kind: "state", status: "delivered", back_ordered: false, raw_status, carrier, tracking_number, shipped_at, delivered_at, event_key: key("delivered", delivered_at) };
  }
  if (SHIPPED_STATUSES.has(normalized)) {
    if (!tracking_number) return { kind: "awaiting_tracking", raw_status, event_key: key("awaiting_tracking", shipped_at) };
    return { kind: "state", status: "shipped", back_ordered: false, raw_status, carrier, tracking_number, shipped_at, delivered_at: null, event_key: key("shipped", shipped_at) };
  }
  if (BACK_ORDER_STATUSES.has(normalized)) {
    return { kind: "state", status: "processing", back_ordered: true, raw_status, carrier: null, tracking_number: null, shipped_at: null, delivered_at: null, event_key: key("processing:back_order", null) };
  }
  if (PROCESSING_STATUSES.has(normalized)) {
    return { kind: "state", status: "processing", back_ordered: false, raw_status, carrier: null, tracking_number: null, shipped_at: null, delivered_at: null, event_key: key(`processing:${normalized}`, null) };
  }
  return { kind: "unknown", raw_status, event_key: key(`unknown:${normalized || "-"}`, null) };
}

/** Forward-only shipment transitions; a re-save of the same status is always allowed. */
const ALLOWED: Record<BillingShipmentStatus, readonly BillingShipmentStatus[]> = {
  processing: ["processing", "shipped", "delivered", "canceled"],
  shipped: ["shipped", "delivered", "canceled"],
  delivered: ["delivered"],
  canceled: ["canceled"],
};

export function canTransitionShipment(from: BillingShipmentStatus, to: BillingShipmentStatus): boolean {
  return ALLOWED[from].includes(to);
}

export class ShipmentTransitionError extends Error {
  readonly status = 409;
  constructor(readonly from: BillingShipmentStatus, readonly to: BillingShipmentStatus) {
    super(from === "delivered"
      ? "This order was already delivered."
      : from === "canceled"
        ? "This order was canceled and cannot be reopened."
        : `A ${from} order cannot go back to ${to}.`);
  }
}

export function assertShipmentTransition(from: BillingShipmentStatus, to: BillingShipmentStatus): void {
  if (!canTransitionShipment(from, to)) throw new ShipmentTransitionError(from, to);
}

/** Staff wording for the raw warehouse status (Title Case of what the 3PL sent). */
export function warehouseStatusLabel(raw: string | null | undefined): string | null {
  const normalized = normalizeWarehouseStatus(raw);
  if (!normalized) return null;
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
