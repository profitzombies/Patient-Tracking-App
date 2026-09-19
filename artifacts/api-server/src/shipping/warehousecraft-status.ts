/**
 * WarehouseCraft (NovEx's WMS) HTTP client — order status feed.
 *
 * Facts pinned by real calls on 2026-09-18 (fixture: fixtures/warehousecraft-order-status.json).
 * The documented `api/OrderStatus/ByDate` answers 404 on the tenant host; the tenant speaks
 * - `GET /api/OrderStatusDatas?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` → 200 array of rows
 *   whose OrderDate or ShipDate falls in the window. Date-only bounds are INCLUSIVE by
 *   calendar day in the warehouse's local clock (US Central); datetime bounds behave
 *   unpredictably, so we never send them. A reversed range answers an empty 200 rather
 *   than an error. Windows of many months time out; 30 days answers in about a second.
 * - `GET /api/OrderStatusDatas/{OrderId}` → 200 one row. The tenant answers for ids that
 *   belong to OTHER clients, so a by-id read is only trusted once its ClientOrderId matches.
 * - `GET /api/OrderStatusDatas?clientOrderId=X` → 200 one row or 404 `{"Message":"Not Found."}`.
 * Row timestamps carry no zone designator and are in the warehouse's local clock; they are
 * converted to UTC instants here. `ShippingData[]` holds one entry per parcel with ShipDate,
 * Carrier, TrackingNumber; the published schema also lists DeliverDate and TrackingStatus,
 * which are parsed when present (the 3PL says the feed rarely reports delivery itself).
 */
import { WarehouseCraftError } from "./warehousecraft";
import { callOrderApi, orderApiFailure } from "./warehousecraft-orders";

/** The warehouse server clock (ImportDate trails UTC by 5 h in September = CDT). */
export const WAREHOUSE_TIME_ZONE = "America/Chicago";

export type TrackingStatusKind = "delivered" | "out_for_delivery" | "in_transit" | "exception" | "unknown";

export interface WarehouseParcel {
  ship_date: string | null;
  deliver_date: string | null;
  tracking_status: string | null;
  tracking_status_kind: TrackingStatusKind | null;
  tracking_exceptions: string | null;
  carrier: string | null;
  tracking_number: string | null;
  weight_lbs: number | null;
}

export interface WarehouseOrderStatus {
  order_id: number;
  client_order_id: string;
  order_date: string | null;
  import_date: string | null;
  status: string;
  carrier_code: string | null;
  shipping_method: string | null;
  parcels: WarehouseParcel[];
  /** The row exactly as the warehouse sent it (persisted as the last event for staff). */
  raw: Record<string, unknown>;
}

const DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: WAREHOUSE_TIME_ZONE, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Wall-clock parts of an instant in the warehouse zone. */
export function warehouseClock(at: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(DATE_PARTS.formatToParts(at).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** The warehouse's calendar date (YYYY-MM-DD) for an instant. */
export function warehouseDate(at: Date): string {
  const clock = warehouseClock(at);
  return `${clock.year}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;
}

/** Adds whole days to a YYYY-MM-DD string. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Converts a zone-less warehouse timestamp ("2019-03-28T22:20:22.513") to a UTC ISO
 * instant. Timestamps that already carry a designator (Z or ±hh:mm) are honoured as is.
 */
export function warehouseTimestampToIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/(z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const direct = new Date(text);
    return Number.isNaN(direct.getTime()) ? null : direct.toISOString();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0"] = match;
  const millis = Math.round(Number(`0.${frac}`) * 1000);
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), millis);
  // Two passes: the offset at the guessed instant is exact except across a DST jump,
  // where the second pass corrects it.
  let guess = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    const clock = warehouseClock(new Date(guess));
    const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second, millis);
    guess = wall - (asUtc - guess);
  }
  return new Date(guess).toISOString();
}

/** Normalizes the free-text tracking vocabulary to what the sync acts on. */
export function normalizeTrackingStatus(value: unknown): TrackingStatusKind | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim().toLowerCase();
  if (/(not|un)[\s-]*deliver|attempt|exception|return|refus|undeliverable|failed|delay|held|hold|lost|damage/.test(text)) return "exception";
  if (/delivered/.test(text)) return "delivered";
  if (/out for delivery/.test(text)) return "out_for_delivery";
  if (/transit|accepted|picked up|shipped|label|departed|arrived|processed|in route|en route/.test(text)) return "in_transit";
  return "unknown";
}

const str = (raw: Record<string, unknown>, key: string): string | null => {
  const value = raw[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export function parseWarehouseOrderStatus(body: unknown): WarehouseOrderStatus {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WarehouseCraftError("Order status row was not an object.", "transient", 200);
  const raw = body as Record<string, unknown>;
  if (typeof raw.OrderId !== "number") throw new WarehouseCraftError("Order status row had no OrderId.", "transient", 200);
  const parcels = (Array.isArray(raw.ShippingData) ? raw.ShippingData : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      ship_date: warehouseTimestampToIso(entry.ShipDate),
      deliver_date: warehouseTimestampToIso(entry.DeliverDate),
      tracking_status: str(entry, "TrackingStatus"),
      tracking_status_kind: normalizeTrackingStatus(entry.TrackingStatus),
      tracking_exceptions: str(entry, "TrackingDeliveryExceptions"),
      carrier: str(entry, "Carrier"),
      tracking_number: str(entry, "TrackingNumber"),
      weight_lbs: typeof entry.WeightInLbs === "number" ? entry.WeightInLbs : null,
    }));
  return {
    order_id: raw.OrderId, client_order_id: str(raw, "ClientOrderId") ?? "",
    order_date: warehouseTimestampToIso(raw.OrderDate), import_date: warehouseTimestampToIso(raw.ImportDate),
    status: str(raw, "OrderStatus") ?? "", carrier_code: str(raw, "CarrierCode"), shipping_method: str(raw, "ShippingMethod"),
    parcels, raw,
  };
}

export function parseWarehouseOrderStatusList(body: unknown): WarehouseOrderStatus[] {
  if (!Array.isArray(body)) throw new WarehouseCraftError("Order status feed was not a list.", "transient", 200);
  return body.map(parseWarehouseOrderStatus);
}

export interface WarehouseStatusClient {
  /** Rows whose OrderDate or ShipDate falls on a warehouse calendar day in [start, end] (YYYY-MM-DD, inclusive). */
  byDate(start: string, end: string): Promise<WarehouseOrderStatus[]>;
  /** One row by the warehouse's own id; callers MUST check client_order_id before trusting it. */
  byId(orderId: number): Promise<WarehouseOrderStatus | null>;
  byClientOrderId(clientOrderId: string): Promise<WarehouseOrderStatus | null>;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const warehouseStatusClient: WarehouseStatusClient = {
  async byDate(start, end) {
    if (!DATE_ONLY.test(start) || !DATE_ONLY.test(end)) throw new WarehouseCraftError("Status window bounds must be YYYY-MM-DD.", "bad_address", null);
    const result = await callOrderApi("GET", `/api/OrderStatusDatas?startDate=${start}&endDate=${end}`);
    if (result.status !== 200) throw orderApiFailure(result.status, result.json, result.text);
    return parseWarehouseOrderStatusList(result.json);
  },
  async byId(orderId) {
    const result = await callOrderApi("GET", `/api/OrderStatusDatas/${encodeURIComponent(String(orderId))}`);
    if (result.status === 404) return null;
    if (result.status !== 200) throw orderApiFailure(result.status, result.json, result.text);
    return parseWarehouseOrderStatus(result.json);
  },
  async byClientOrderId(clientOrderId) {
    const result = await callOrderApi("GET", `/api/OrderStatusDatas?clientOrderId=${encodeURIComponent(clientOrderId)}`);
    if (result.status === 404) return null;
    if (result.status !== 200) throw orderApiFailure(result.status, result.json, result.text);
    return parseWarehouseOrderStatus(result.json);
  },
};
