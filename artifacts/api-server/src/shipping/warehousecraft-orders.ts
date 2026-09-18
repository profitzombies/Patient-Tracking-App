/**
 * WarehouseCraft (NovEx's WMS) HTTP client — orders.
 *
 * Facts pinned by real calls on 2026-09-18 (fixture: fixtures/warehousecraft-orders.json).
 * The public docs describe `api/Order/Create|Edit|Cancel|ById`; those routes answer 404 on
 * the NovEx tenant host (and 401 on the shared hosts with our account). The tenant speaks
 * the legacy resource routes below, so that is what we implement:
 * - `POST /api/OrderDatas` with one OrderData body. HTTP 200 for BOTH success and rejection;
 *   the verdict is inside `ResultOrder[].ResultDetail[]` (`Status` Success|Error + `Details`).
 *   Success → "Created OrderId: N"; duplicate ClientOrderId → "Duplicate Order: ... under
 *   OrderId N."; unknown SKU → "ItemSKU not recognized: X" (nothing created); bad method →
 *   "Unknown shipping method: X". An EMPTY line list is accepted, so we refuse it client-side.
 * - `GET /api/OrderDatas?clientOrderId=X` → 200 full order or 404 `{"Message":"Not Found."}`.
 * - `PUT /api/OrderDatas/{OrderId}` edits; the body MUST carry `OrderId`. Cancel is the same
 *   PUT with `OrderStatus: "Cancelled"`. The API does not gate edits by status (a cancelled
 *   order accepted an address change), so the 3PL's editable-status list is enforced here.
 * - 401 for missing/invalid credentials; 406 for an invalid status value; 404 unknown id.
 */
import type { ShippingAddress } from "../billing/types";
import { WarehouseCraftError, warehouseCraftConfig, type ShippingMethod } from "./warehousecraft";

/** The codes WarehouseCraft accepts as `ShippingMethod` on create. */
export const METHOD_CODES: Record<ShippingMethod, string> = {
  standard: "USPS_GroundAdvantage",
  expedited: "USPS_PriorityMail",
};

export interface WarehouseOrderLine { ItemSKU: string; ItemQuantity: number; ItemPrice: number }

export interface WarehouseOrderPayload {
  ClientOrderId: string;
  OrderDate: string;
  CompanyOrName: string;
  AddressLine1: string;
  AddressLine2: string | null;
  City: string;
  State: string;
  PostalCode: string;
  Country: string;
  Phone: string | null;
  Email: string | null;
  ShippingMethod: string;
  NotesToWarehouse: string | null;
  OrderDetailData: WarehouseOrderLine[];
}

export interface WarehouseOrder {
  order_id: number;
  client_order_id: string;
  status: string;
  shipping_method: string | null;
  address: { name: string; line1: string; line2: string | null; city: string; state: string; postal_code: string; country: string };
  lines: Array<{ sku: string; quantity: number }>;
}

export type CreateVerdict =
  | { kind: "created"; order_id: number }
  | { kind: "duplicate"; order_id: number | null }
  | { kind: "rejected"; message: string };

/** Statuses in which the 3PL still lets us change the order (cancel, lines, address). */
export const EDITABLE_STATUSES = new Set(["imported", "on hold", "back order", "created", "modified", "reset", "released back order", "editing"]);
/** Address edits are additionally allowed while the order is Committed (not yet picked). */
export const ADDRESS_EDITABLE_STATUSES = new Set([...EDITABLE_STATUSES, "committed"]);

const norm = (status: string | null | undefined) => (status ?? "").trim().toLowerCase();
export const canCancelAtWarehouse = (status: string | null | undefined) => EDITABLE_STATUSES.has(norm(status));
export const canEditAddressAtWarehouse = (status: string | null | undefined) => ADDRESS_EDITABLE_STATUSES.has(norm(status));
export const isCancelledAtWarehouse = (status: string | null | undefined) => norm(status) === "cancelled" || norm(status) === "canceled";

export interface BuildOrderInput {
  order_number: string;
  paid_at: string;
  address: ShippingAddress;
  email: string | null;
  method: ShippingMethod;
  notes?: string | null;
  lines: Array<{ sku: string | null; name: string; quantity: number; unit_price_cents: number }>;
}

export class WarehousePayloadError extends Error {}

/** Builds the create body; throws WarehousePayloadError when the order cannot be represented. */
export function buildWarehouseOrder(input: BuildOrderInput): WarehouseOrderPayload {
  if (input.lines.length === 0) throw new WarehousePayloadError("The order has no lines to ship.");
  const missing = input.lines.filter((line) => !line.sku || !line.sku.trim());
  if (missing.length) throw new WarehousePayloadError(`No WarehouseCraft SKU for: ${missing.map((line) => line.name).join(", ")}.`);
  const address = input.address;
  for (const [key, label] of [["name", "recipient name"], ["line1", "street"], ["city", "city"], ["state", "state"], ["postal_code", "ZIP"]] as const) {
    if (!String(address[key] ?? "").trim()) throw new WarehousePayloadError(`Shipping address is missing the ${label}.`);
  }
  const date = new Date(input.paid_at);
  if (Number.isNaN(date.getTime())) throw new WarehousePayloadError("The order has no valid paid date.");
  return {
    ClientOrderId: input.order_number,
    OrderDate: date.toISOString().slice(0, 19),
    CompanyOrName: address.name.trim().slice(0, 100),
    AddressLine1: address.line1.trim(),
    AddressLine2: address.line2?.trim() || null,
    City: address.city.trim(),
    State: address.state.trim().toUpperCase(),
    PostalCode: address.postal_code.trim(),
    Country: (address.country || "US").trim().toUpperCase(),
    Phone: address.phone?.replace(/[^\d+]/g, "") || null,
    Email: input.email?.trim() || null,
    ShippingMethod: METHOD_CODES[input.method],
    NotesToWarehouse: input.notes?.trim() || null,
    OrderDetailData: input.lines.map((line) => ({
      ItemSKU: line.sku!.trim(), ItemQuantity: line.quantity, ItemPrice: Math.round(line.unit_price_cents) / 100,
    })),
  };
}

/** Reads the verdict out of a create response (HTTP 200 in every case). */
export function parseCreateResponse(body: unknown, clientOrderId: string): CreateVerdict {
  const results = body && typeof body === "object" ? (body as { ResultOrder?: unknown }).ResultOrder : null;
  const mine = (Array.isArray(results) ? results : []).find((entry) => entry && typeof entry === "object"
    && String((entry as Record<string, unknown>).ClientOrderId ?? "") === clientOrderId) as Record<string, unknown> | undefined;
  const details = Array.isArray(mine?.ResultDetail) ? mine!.ResultDetail as Array<Record<string, unknown>> : [];
  if (!details.length) throw new WarehouseCraftError("WarehouseCraft returned no result for the order.", "transient", 200);
  const first = details[0];
  const text = String(first.Details ?? "");
  if (String(first.Status).toLowerCase() === "success") {
    const id = /OrderId:\s*(\d+)/i.exec(text);
    if (!id) throw new WarehouseCraftError(`WarehouseCraft accepted the order without an OrderId (${text}).`, "transient", 200);
    return { kind: "created", order_id: Number(id[1]) };
  }
  if (/duplicate order/i.test(text)) {
    const id = /OrderId\s*(\d+)/i.exec(text);
    return { kind: "duplicate", order_id: id ? Number(id[1]) : null };
  }
  return { kind: "rejected", message: details.map((detail) => String(detail.Details ?? "")).filter(Boolean).join("; ") || "WarehouseCraft rejected the order." };
}

export function parseWarehouseOrder(body: unknown): WarehouseOrder {
  if (!body || typeof body !== "object") throw new WarehouseCraftError("Order response was not an object.", "transient", 200);
  const raw = body as Record<string, unknown>;
  if (typeof raw.OrderId !== "number") throw new WarehouseCraftError("Order response had no OrderId.", "transient", 200);
  const str = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  return {
    order_id: raw.OrderId, client_order_id: str("ClientOrderId"), status: str("OrderStatus"),
    shipping_method: str("ShippingMethod") || null,
    address: {
      name: str("CompanyOrName"), line1: str("AddressLine1"), line2: str("AddressLine2") || null, city: str("City"),
      state: str("State"), postal_code: str("PostalCode"), country: str("Country"),
    },
    lines: (Array.isArray(raw.OrderDetailData) ? raw.OrderDetailData as Array<Record<string, unknown>> : [])
      .map((line) => ({ sku: String(line.ItemSKU ?? ""), quantity: Number(line.ItemQuantity ?? 0) })),
  };
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const config = warehouseCraftConfig();
  if (!config.orderApiBaseUrl || !config.authorization) throw new WarehouseCraftError("WarehouseCraft order API is not configured.", "transient", null);
  let response: Response;
  try {
    response = await fetch(`${config.orderApiBaseUrl}${path}`, {
      method, headers: { Accept: "application/json", Authorization: config.authorization, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new WarehouseCraftError(`WarehouseCraft unreachable: ${error instanceof Error ? error.message : String(error)}`, "transient", null);
  }
  const text = await response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text };
}

function messageOf(json: unknown, text: string): string {
  const message = json && typeof json === "object" ? (json as { Message?: unknown }).Message : null;
  return typeof message === "string" && message ? message : text.slice(0, 200);
}

export interface WarehouseOrderClient {
  create(payload: WarehouseOrderPayload): Promise<CreateVerdict>;
  lookup(clientOrderId: string): Promise<WarehouseOrder | null>;
  editAddress(orderId: number, address: ShippingAddress): Promise<WarehouseOrder>;
  cancel(orderId: number): Promise<WarehouseOrder>;
}

/** 5xx / network / auth problems are retried later; anything else is a definite answer. */
function failure(status: number, json: unknown, text: string): WarehouseCraftError {
  return new WarehouseCraftError(`WarehouseCraft HTTP ${status}: ${messageOf(json, text)}`, status >= 500 || status === 401 || status === 429 ? "transient" : "bad_address", status);
}

export const warehouseOrderClient: WarehouseOrderClient = {
  async create(payload) {
    if (!payload.OrderDetailData.length) throw new WarehousePayloadError("Refusing to submit an order without lines.");
    const result = await call("POST", "/api/OrderDatas", payload);
    if (result.status !== 200) throw failure(result.status, result.json, result.text);
    return parseCreateResponse(result.json, payload.ClientOrderId);
  },
  async lookup(clientOrderId) {
    const result = await call("GET", `/api/OrderDatas?clientOrderId=${encodeURIComponent(clientOrderId)}`);
    if (result.status === 404) return null;
    if (result.status !== 200) throw failure(result.status, result.json, result.text);
    return parseWarehouseOrder(result.json);
  },
  async editAddress(orderId, address) {
    const result = await call("PUT", `/api/OrderDatas/${orderId}`, {
      OrderId: orderId, CompanyOrName: address.name.trim(), AddressLine1: address.line1.trim(), AddressLine2: address.line2?.trim() || null,
      City: address.city.trim(), State: address.state.trim().toUpperCase(), PostalCode: address.postal_code.trim(),
      Country: (address.country || "US").trim().toUpperCase(), Phone: address.phone?.replace(/[^\d+]/g, "") || null,
    });
    if (result.status !== 200) throw failure(result.status, result.json, result.text);
    return parseWarehouseOrder(result.json);
  },
  async cancel(orderId) {
    const result = await call("PUT", `/api/OrderDatas/${orderId}`, { OrderId: orderId, OrderStatus: "Cancelled" });
    if (result.status !== 200) throw failure(result.status, result.json, result.text);
    return parseWarehouseOrder(result.json);
  },
};
