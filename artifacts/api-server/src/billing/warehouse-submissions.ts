/**
 * WarehouseCraft submission queue.
 *
 * One intent row per paid order (billing_warehouse_submissions), created by the
 * paid-transition trigger and drained here in small leased batches by the
 * `warehouse-submit` job. Outcomes:
 * - created / duplicate (after lookup) → `sent`, warehouse id mirrored onto the shipment row;
 * - definite rejection (unknown SKU, bad address, unbuildable payload) → `needs_attention`
 *   with the warehouse's message, plus one HQ staff alert; HQ fixes the cause and retries;
 * - transient failure (network, 5xx, auth) → stays `pending` with bounded backoff, and turns
 *   into `needs_attention` once the attempt budget is spent so nothing retries forever.
 * The HQ kill switch (billing_settings.warehouse_auto_submit) pauses the drain; intents keep
 * accumulating and resume untouched when it is switched back on.
 */
import {
  WarehousePayloadError, buildWarehouseOrder, canCancelAtWarehouse, canEditAddressAtWarehouse, isCancelledAtWarehouse,
  warehouseOrderClient, type WarehouseOrderClient, type WarehouseOrderPayload,
} from "../shipping/warehousecraft-orders";
import { WarehouseCraftError } from "../shipping/warehousecraft";
import { ensureShipment } from "./shipments";
import { raiseWarehouseHqAlert } from "./warehouse-alerts";
import {
  insertIgnore, nowIso, selectMany, selectOne, update, type BillingOrderItemRow, type BillingOrderRow, type BillingPayerRow,
  type BillingWarehouseSubmissionRow, type WarehouseSubmissionState,
} from "./store";
import type { ShippingAddress, WarehouseSubmission } from "./types";

const enc = encodeURIComponent;
const MINUTE_MS = 60_000;
/** Transient retries: 2, 4, 8 … minutes, capped at 6 hours; after MAX_ATTEMPTS the order needs a human. */
export const MAX_ATTEMPTS = 12;
export const BACKOFF_CAP_MS = 6 * 60 * MINUTE_MS;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, 2 * MINUTE_MS * 2 ** Math.max(0, attempts - 1));
}

export type SubmissionDeps = { client?: WarehouseOrderClient; now?: () => Date };

/** Idempotent app-side fallback for orders paid before the trigger existed (or in test backends). */
export async function ensureSubmission(order: Pick<BillingOrderRow, "id" | "provider_id" | "patient_id" | "status">): Promise<BillingWarehouseSubmissionRow | null> {
  const existing = await selectOne("billing_warehouse_submissions", `order_id=eq.${enc(order.id)}`);
  if (existing || order.status !== "paid") return existing;
  const inserted = await insertIgnore("billing_warehouse_submissions", {
    order_id: order.id, provider_id: order.provider_id, patient_id: order.patient_id, state: "pending", attempts: 0, next_attempt_at: nowIso(),
  }, "billing_warehouse_submissions_order_id_key");
  return inserted ?? await selectOne("billing_warehouse_submissions", `order_id=eq.${enc(order.id)}`);
}

/** The exact body sent to WarehouseCraft, built from the order rows (works for one-time, initial and renewal orders alike). */
export function payloadForOrder(order: BillingOrderRow, items: BillingOrderItemRow[], payer: Pick<BillingPayerRow, "email"> | null): WarehouseOrderPayload {
  return buildWarehouseOrder({
    order_number: order.order_number, paid_at: order.paid_at ?? order.created_at,
    address: order.shipping_address as unknown as ShippingAddress, email: payer?.email ?? null,
    method: order.shipping_method ?? "standard",
    notes: order.kind === "subscription_renewal" ? "Subscription renewal" : null,
    lines: items.map((item) => ({ sku: item.warehousecraft_sku_snapshot ?? null, name: item.product_name_snapshot, quantity: item.quantity, unit_price_cents: item.unit_price_cents })),
  });
}

export type SubmitOutcome = "sent" | "duplicate" | "rejected" | "retry" | "exhausted" | "skipped";

async function mirror(order: Pick<BillingOrderRow, "id" | "provider_id" | "fulfillment_status" | "carrier" | "tracking_number" | "shipped_at" | "canceled_reason" | "shipped_by">, patch: {
  warehouse_state: WarehouseSubmissionState; warehouse_order_id?: string | null; warehouse_sent_at?: string | null; warehouse_error?: string | null;
}): Promise<void> {
  const shipment = await ensureShipment(order);
  await update("billing_shipments", `id=eq.${enc(shipment.id)}`, patch);
}

async function raiseAttentionAlert(order: BillingOrderRow, message: string, now: Date): Promise<void> {
  await raiseWarehouseHqAlert({
    key: order.id, metric: "warehouse_submission", level: "red", family: order.order_number,
    title: `Warehouse rejected order ${order.order_number}`,
    body: `${message} Fix the product or address, then retry from Fulfillment.`,
    data: { order_id: order.id },
  }, now);
}

/** Submits one pending intent. Never throws for warehouse answers; only store failures propagate. */
export async function submitOne(submission: BillingWarehouseSubmissionRow, deps: SubmissionDeps = {}): Promise<SubmitOutcome> {
  const client = deps.client ?? warehouseOrderClient;
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const order = await selectOne("billing_orders", `id=eq.${enc(submission.order_id)}`);
  if (!order) return "skipped";
  const attempts = submission.attempts + 1;
  const fail = async (kind: "rejected" | "transient" | "incomplete", message: string): Promise<SubmitOutcome> => {
    const permanent = kind !== "transient" || attempts >= MAX_ATTEMPTS;
    const error = permanent && kind === "transient" ? `${message} (gave up after ${attempts} attempts)` : message;
    await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, {
      state: permanent ? "needs_attention" : "pending", attempts, last_attempt_at: at, last_error: error, last_error_kind: kind,
      next_attempt_at: new Date(now.getTime() + backoffMs(attempts)).toISOString(),
    });
    if (permanent) {
      await mirror(order, { warehouse_state: "needs_attention", warehouse_error: error });
      await raiseAttentionAlert(order, error, now);
      return kind === "transient" ? "exhausted" : "rejected";
    }
    return "retry";
  };
  // Cancelled / refunded before the drain reached it: nothing to ship.
  if (order.fulfillment_status === "canceled" || order.status === "refunded") {
    await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, { state: "skipped", skipped_reason: `order ${order.fulfillment_status === "canceled" ? "canceled" : "refunded"} before submission`, last_attempt_at: at });
    await mirror(order, { warehouse_state: "skipped" });
    return "skipped";
  }
  const [items, payer] = await Promise.all([
    selectMany("billing_order_items", `order_id=eq.${enc(order.id)}&order=created_at.asc`),
    selectOne("billing_payers", `id=eq.${enc(order.payer_id)}`),
  ]);
  let payload: WarehouseOrderPayload;
  try { payload = payloadForOrder(order, items, payer); } catch (error) {
    if (error instanceof WarehousePayloadError) return fail("incomplete", error.message);
    throw error;
  }
  const succeed = async (warehouseOrderId: number, warehouseStatus: string | null): Promise<void> => {
    await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, {
      state: "sent", attempts, last_attempt_at: at, sent_at: at, warehouse_order_id: String(warehouseOrderId), warehouse_status: warehouseStatus,
      last_error: null, last_error_kind: null, payload: payload as unknown as Record<string, unknown>,
    });
    await mirror(order, { warehouse_state: "sent", warehouse_order_id: String(warehouseOrderId), warehouse_sent_at: at, warehouse_error: null });
  };
  try {
    const verdict = await client.create(payload);
    if (verdict.kind === "created") { await succeed(verdict.order_id, "Imported"); return "sent"; }
    if (verdict.kind === "duplicate") {
      // Accepted by an earlier attempt whose acknowledgement we lost: reconcile by lookup.
      const existing = await client.lookup(payload.ClientOrderId);
      const id = existing?.order_id ?? verdict.order_id;
      if (id === null) return fail("transient", "Duplicate ClientOrderId reported but the order could not be looked up.");
      await succeed(id, existing?.status ?? null);
      return "duplicate";
    }
    return fail("rejected", verdict.message);
  } catch (error) {
    if (error instanceof WarehousePayloadError) return fail("incomplete", error.message);
    if (error instanceof WarehouseCraftError) return fail(error.kind === "transient" ? "transient" : "rejected", error.message);
    return fail("transient", error instanceof Error ? error.message : String(error));
  }
}

/** HQ retry after the product/address was fixed: back to pending, due now. */
export async function retrySubmission(orderId: string): Promise<BillingWarehouseSubmissionRow | null> {
  const order = await selectOne("billing_orders", `id=eq.${enc(orderId)}`);
  if (!order) return null;
  const existing = await ensureSubmission(order);
  if (!existing) return null;
  if (existing.state === "sent") return existing;
  const updated = await update("billing_warehouse_submissions", `id=eq.${enc(existing.id)}`, {
    state: "pending", attempts: 0, next_attempt_at: nowIso(), last_error: existing.last_error, skipped_reason: null,
  });
  await mirror(order, { warehouse_state: "pending", warehouse_error: null });
  return updated ?? { ...existing, state: "pending" };
}

export type WarehouseSync =
  | { kind: "not_sent" } | { kind: "applied"; warehouse_order_id: string } | { kind: "locked"; warehouse_status: string } | { kind: "unavailable"; message: string };

/**
 * Mirrors an in-app cancellation to the warehouse. Pending intents are marked skipped
 * (the drain would skip them anyway); sent orders are cancelled only while the 3PL still
 * allows it, otherwise the current shipment is reported locked and the caller tells staff.
 */
export async function cancelAtWarehouse(orderId: string, deps: SubmissionDeps = {}): Promise<WarehouseSync> {
  const client = deps.client ?? warehouseOrderClient;
  const submission = await selectOne("billing_warehouse_submissions", `order_id=eq.${enc(orderId)}`);
  if (!submission || submission.state === "skipped") return { kind: "not_sent" };
  if (submission.state !== "sent" || !submission.warehouse_order_id) {
    await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, { state: "skipped", skipped_reason: "canceled in app before submission" });
    const order = await selectOne("billing_orders", `id=eq.${enc(orderId)}`);
    if (order) await mirror(order, { warehouse_state: "skipped", warehouse_error: null });
    return { kind: "not_sent" };
  }
  try {
    const live = await client.lookup(await clientOrderIdFor(orderId, submission));
    const status = live?.status ?? submission.warehouse_status ?? "";
    if (isCancelledAtWarehouse(status)) return { kind: "applied", warehouse_order_id: submission.warehouse_order_id };
    if (!canCancelAtWarehouse(status)) {
      await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, { warehouse_status: status, last_error: `Warehouse order is ${status}; cancellation could not be applied.` });
      return { kind: "locked", warehouse_status: status };
    }
    const result = await client.cancel(Number(submission.warehouse_order_id));
    await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, { warehouse_status: result.status });
    return { kind: "applied", warehouse_order_id: submission.warehouse_order_id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, { last_error: `Cancel not mirrored: ${message}` });
    return { kind: "unavailable", message };
  }
}

async function clientOrderIdFor(orderId: string, submission: BillingWarehouseSubmissionRow): Promise<string> {
  const fromPayload = submission.payload?.ClientOrderId;
  if (typeof fromPayload === "string" && fromPayload) return fromPayload;
  const order = await selectOne("billing_orders", `id=eq.${enc(orderId)}`);
  return order?.order_number ?? "";
}

/**
 * Applies a new address to every unshipped order of a subscription: pending intents pick
 * the new address up from the order row (which the caller updates); sent orders are edited
 * at the warehouse while their status allows, otherwise reported locked so the patient is
 * told the change applies to future shipments only.
 */
export async function syncSubscriptionAddress(subscriptionId: string, address: ShippingAddress, deps: SubmissionDeps = {}): Promise<{ applied: string[]; locked: string[]; unavailable: string[] }> {
  const client = deps.client ?? warehouseOrderClient;
  const orders = await selectMany("billing_orders", `subscription_id=eq.${enc(subscriptionId)}&status=in.(paid,partially_refunded)&fulfillment_status=eq.to_ship`);
  const result = { applied: [] as string[], locked: [] as string[], unavailable: [] as string[] };
  for (const order of orders) {
    await update("billing_orders", `id=eq.${enc(order.id)}`, { shipping_address: address as unknown as Record<string, unknown> });
    const submission = await selectOne("billing_warehouse_submissions", `order_id=eq.${enc(order.id)}`);
    if (!submission || submission.state !== "sent" || !submission.warehouse_order_id) continue;
    try {
      const live = await client.lookup(order.order_number);
      const status = live?.status ?? submission.warehouse_status ?? "";
      if (!canEditAddressAtWarehouse(status)) {
        await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, { warehouse_status: status });
        result.locked.push(order.order_number);
        continue;
      }
      const edited = await client.editAddress(Number(submission.warehouse_order_id), address);
      await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, {
        warehouse_status: edited.status, payload: { ...(submission.payload ?? {}), AddressLine1: address.line1, AddressLine2: address.line2, City: address.city, State: address.state, PostalCode: address.postal_code, CompanyOrName: address.name },
      });
      result.applied.push(order.order_number);
    } catch (error) {
      await update("billing_warehouse_submissions", `id=eq.${enc(submission.id)}`, { last_error: `Address edit not mirrored: ${error instanceof Error ? error.message : String(error)}` });
      result.unavailable.push(order.order_number);
    }
  }
  return result;
}

export function warehouseDto(row: Pick<BillingWarehouseSubmissionRow, "state" | "warehouse_order_id" | "warehouse_status" | "sent_at" | "last_error" | "attempts" | "next_attempt_at" | "last_attempt_at"> | null): WarehouseSubmission | null {
  if (!row) return null;
  return {
    state: row.state, warehouse_order_id: row.warehouse_order_id, warehouse_status: row.warehouse_status, sent_at: row.sent_at,
    error: row.last_error, attempts: row.attempts, next_attempt_at: row.state === "pending" ? row.next_attempt_at : null, last_attempt_at: row.last_attempt_at,
  };
}

export async function submissionsForOrders(orderIds: string[]): Promise<Map<string, BillingWarehouseSubmissionRow>> {
  if (!orderIds.length) return new Map();
  const rows = await selectMany("billing_warehouse_submissions", `order_id=in.(${orderIds.map(enc).join(",")})`);
  return new Map(rows.map((row) => [row.order_id, row]));
}

/** System health: the last 24 h of submission activity plus everything still waiting. */
export async function warehouseHealth(now: Date): Promise<{ pending: number; due: number; sent24h: number; failed24h: number; retries24h: number; needs_attention: number; auto_submit: boolean; recent_failures: Array<{ order_id: string; order_number: string | null; error: string | null; at: string | null; state: WarehouseSubmissionState }> }> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const [pending, recent, attention, settings] = await Promise.all([
    selectMany("billing_warehouse_submissions", "state=eq.pending&select=id,next_attempt_at"),
    selectMany("billing_warehouse_submissions", `last_attempt_at=gte.${enc(since)}&select=id,state,attempts,last_error_kind,sent_at`),
    selectMany("billing_warehouse_submissions", "state=eq.needs_attention&order=last_attempt_at.desc&select=order_id,last_error,last_attempt_at,state"),
    selectOne("billing_settings", "id=eq.1&select=warehouse_auto_submit"),
  ]);
  const failures = attention.slice(0, 10);
  const orderIds = failures.map((row) => row.order_id);
  const numbers = new Map((orderIds.length ? await selectMany("billing_orders", `id=in.(${orderIds.map(enc).join(",")})&select=id,order_number`) : []).map((row) => [row.id, row.order_number]));
  return {
    pending: pending.length, due: pending.filter((row) => row.next_attempt_at <= now.toISOString()).length,
    sent24h: recent.filter((row) => row.state === "sent" && row.sent_at && row.sent_at >= since).length,
    failed24h: recent.filter((row) => row.state === "needs_attention" || (row.state === "pending" && row.last_error_kind)).length,
    retries24h: recent.filter((row) => row.attempts > 1).length,
    needs_attention: attention.length, auto_submit: settings?.warehouse_auto_submit ?? true,
    recent_failures: failures.map((row) => ({ order_id: row.order_id, order_number: numbers.get(row.order_id) ?? null, error: row.last_error, at: row.last_attempt_at, state: row.state })),
  };
}
