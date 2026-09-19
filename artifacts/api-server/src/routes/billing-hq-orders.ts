import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { BillingOrderError, refundOrder, toOrderDetail } from "../billing/orders";
import { notifyOrderShipped } from "../billing/patient-notices";
import { BillingReportingError, hqActivity, hqOverview, hqToday } from "../billing/reporting";
import {
  BillingSubscriptionError, cancelSubscription, changeSubscription, pauseSubscription, quoteSubscriptionChange,
  resendSubscriptionPaymentEmail, resumeSubscription, retrySubscriptionPayment, toSubscriptionRow,
} from "../billing/subscriptions";
import { recordShipment } from "../billing/shipments";
import { ShipmentTransitionError } from "../billing/warehouse-status";
import { cancelAtWarehouse, retrySubmission } from "../billing/warehouse-submissions";
import { encodeCursor, pagination, selectMany, selectOne, toOrderSummary } from "../billing/store";
import { getOrderBundle, officeName } from "../billing/store-orders";
import { stripeRejection } from "../billing/stripe-client";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { recordAdminAuditEvent, requestIdOf, type AuditMetadata } from "../lib/admin-audit";

const router: IRouter = Router();
function actor(res: Response): string { return (res.locals.staff as StaffIdentity).userId; }
function audit(req: Request, res: Response, action: string, targetKind: string, targetId: string, metadata: AuditMetadata, providerId: string | null = null) {
  return recordAdminAuditEvent({
    action, actorUserId: actor(res), actorKind: "hq", providerId, targetKind, targetId,
    requestId: requestIdOf(req), metadata,
  }).catch((error) => req.log?.error({ err: error }, `${action} audit failed`));
}
function fail(req: Request, res: Response, error: unknown): void {
  req.log?.error({ err: error }, "billing HQ orders request failed");
  if (error instanceof BillingReportingError || error instanceof ShipmentTransitionError) { res.status(error.status).json({ error: error.message }); return; }
  if (error instanceof BillingOrderError || error instanceof BillingSubscriptionError) {
    res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}) }); return;
  }
  const rejected = stripeRejection(error);
  if (rejected) { res.status(rejected.status).json({ error: rejected.message }); return; }
  res.status(503).json({ error: "Payments are temporarily unavailable." });
}
router.get("/billing/hq/overview", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(await hqOverview(req.query)); } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/overview/today", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(await hqToday({ tz: req.query.tz })); } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/activity", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(await hqActivity(req.query)); } catch (error) { fail(req, res, error); }
});
async function listOrders(req: Request, fulfillmentOnly = false) {
  const page = pagination(req.query);
  const filters: string[] = [];
  for (const key of ["provider_id", "status", "kind"] as const) {
    if (fulfillmentOnly && key === "status") continue;
    if (typeof req.query[key] === "string") filters.push(`${key}=eq.${encodeURIComponent(req.query[key] as string)}`);
  }
  if (fulfillmentOnly) {
    // The shipping queue only deals with orders that were actually paid.
    filters.push(`fulfillment_status=eq.${encodeURIComponent(typeof req.query.status === "string" ? req.query.status : "to_ship")}`);
    filters.push("status=in.(paid,partially_refunded)");
  }
  if (typeof req.query.from === "string") filters.push(`created_at=gte.${encodeURIComponent(`${req.query.from}T00:00:00Z`)}`);
  if (typeof req.query.to === "string") filters.push(`created_at=lte.${encodeURIComponent(`${req.query.to}T23:59:59Z`)}`);
  if (typeof req.query.q === "string" && req.query.q.trim()) {
    filters.push(`order_number=ilike.*${encodeURIComponent(req.query.q.trim().replace(/[%(),]/g, ""))}*`);
  }
  if (page.cursor) filters.push(`created_at=lt.${encodeURIComponent(page.cursor.created_at)}`);
  const rows = await selectMany("billing_orders", `${filters.join("&")}${filters.length ? "&" : ""}order=created_at.desc,id.desc&limit=${page.limit + 1}`);
  const visible = rows.slice(0, page.limit);
  // The fulfillment queue renders items and the shipping address, so it
  // needs full detail rows; the transactions list keeps the lighter summary.
  const items = await Promise.all(visible.map(async (row) => {
    if (fulfillmentOnly) return toOrderDetail(row.id, true);
    const bundle = await getOrderBundle(row.id);
    if (!bundle) throw new Error("Order details are incomplete.");
    return toOrderSummary(row, bundle.items, bundle.payer, officeName(bundle.office));
  }));
  return { items, next_cursor: rows.length > page.limit ? encodeCursor(visible.at(-1) ?? null) : null };
}
router.get("/billing/hq/transactions", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(await listOrders(req)); } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/transactions/:id", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(await toOrderDetail(String(req.params.id), true)); } catch (error) { fail(req, res, error); }
});
const RefundSchema = z.object({ amount_cents: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(500) });
router.post("/billing/hq/transactions/:id/refund", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = RefundSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the refund.", field: String(parsed.error.issues[0]?.path[0] ?? "") }); return; }
  try {
    const refund = await refundOrder(String(req.params.id), parsed.data, actor(res));
    await audit(req, res, "billing_refund_issued", "billing_order", String(req.params.id), {
      order_id: String(req.params.id), amount_cents: refund.amount_cents, reason: "requested_by_customer",
    });
    res.json({ refund });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/fulfillment", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(await listOrders(req, true)); } catch (error) { fail(req, res, error); }
});
const FulfillmentSchema = z.object({
  status: z.enum(["to_ship", "shipped", "delivered", "canceled"]), tracking_number: z.string().trim().nullable().optional(),
  carrier: z.string().trim().nullable().optional(), canceled_reason: z.string().trim().nullable().optional(),
});
router.put("/billing/hq/fulfillment/:order_id", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = FulfillmentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Check the fulfillment details." }); return; }
  if (parsed.data.status === "shipped" && (!parsed.data.tracking_number || !parsed.data.carrier)) {
    res.status(400).json({ error: "Carrier and tracking number are required.", field: "tracking_number" }); return;
  }
  if (parsed.data.status === "canceled" && !parsed.data.canceled_reason) {
    res.status(400).json({ error: "A cancellation reason is required.", field: "canceled_reason" }); return;
  }
  try {
    const bundle = await getOrderBundle(String(req.params.order_id));
    if (!bundle) { res.status(404).json({ error: "Order not found." }); return; }
    if ((parsed.data.status === "shipped" || parsed.data.status === "delivered") && !["paid", "partially_refunded"].includes(bundle.order.status)) {
      res.status(409).json({ error: "Only paid orders can be shipped." }); return;
    }
    // The shipment record is the source of truth; it mirrors the legacy
    // fulfillment columns on the order so every existing reader stays intact.
    // Shipped and delivered emails fire inside recordShipment, once per
    // status transition, so a re-save with the same status sends nothing.
    // The patient push notice below dedupes per order the same way.
    const { order: row, shipment } = await recordShipment(bundle.order, parsed.data.status === "shipped" ? {
      status: "shipped", tracking_number: parsed.data.tracking_number, carrier: parsed.data.carrier, updated_by: actor(res), source: "staff",
    } : parsed.data.status === "delivered" ? {
      status: "delivered", tracking_number: parsed.data.tracking_number, carrier: parsed.data.carrier, updated_by: actor(res), source: "staff",
    } : parsed.data.status === "canceled" ? {
      status: "canceled", canceled_reason: parsed.data.canceled_reason, updated_by: actor(res), source: "staff",
    } : { status: "processing", updated_by: actor(res), source: "staff" });
    if (parsed.data.status === "shipped") await notifyOrderShipped({ order: row, shipment });
    // A staff cancellation follows through to WarehouseCraft while the 3PL still
    // allows it; once the order is committed there, the response says so and
    // the app-side cancel stands on its own.
    const warehouse = parsed.data.status === "canceled" ? await cancelAtWarehouse(row.id) : null;
    await audit(req, res, "billing_order_fulfillment_updated", "billing_order", row.id, {
      order_id: row.id, fulfillment_status: parsed.data.status, has_tracking: Boolean(parsed.data.tracking_number),
      ...(warehouse ? { warehouse_sync: warehouse.kind } : {}),
    }, bundle.order.provider_id);
    res.json({ order: await toOrderDetail(row.id, true), warehouse_sync: warehouse });
  } catch (error) { fail(req, res, error); }
});
/** HQ retry after the product SKU or address was fixed: the intent goes back to pending and the next drain picks it up. */
router.post("/billing/hq/fulfillment/:order_id/warehouse-retry", requireHqPermission("provider_manage"), async (req, res) => {
  try {
    const bundle = await getOrderBundle(String(req.params.order_id));
    if (!bundle) { res.status(404).json({ error: "Order not found." }); return; }
    if (!["paid", "partially_refunded"].includes(bundle.order.status) || bundle.order.fulfillment_status !== "to_ship") {
      res.status(409).json({ error: "Only paid, unshipped orders can be resent to the warehouse." }); return;
    }
    const submission = await retrySubmission(bundle.order.id);
    if (!submission) { res.status(409).json({ error: "This order has no warehouse submission." }); return; }
    await audit(req, res, "billing_warehouse_retry", "billing_order", bundle.order.id, {
      order_id: bundle.order.id, order_number: bundle.order.order_number, previous_error: submission.last_error,
    }, bundle.order.provider_id);
    res.json({ order: await toOrderDetail(bundle.order.id, true) });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/subscriptions", requireHqPermission("financial_read"), async (req, res) => {
  try {
    const filters: string[] = [];
    if (typeof req.query.provider_id === "string") filters.push(`provider_id=eq.${encodeURIComponent(req.query.provider_id)}`);
    if (typeof req.query.status === "string") filters.push(`status=eq.${encodeURIComponent(req.query.status)}`);
    const rows = await selectMany("billing_subscriptions", `${filters.join("&")}${filters.length ? "&" : ""}order=created_at.desc`);
    res.json({ items: await Promise.all(rows.map(toSubscriptionRow)), next_cursor: null });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/subscriptions/:id/pause", requireHqPermission("provider_manage"), async (req, res) => {
  try {
    const row = await pauseSubscription(String(req.params.id));
    await audit(req, res, "billing_subscription_paused", "billing_subscription", row.id,
      { subscription_id: row.id }, row.provider_id);
    res.json({ subscription: await toSubscriptionRow(row) });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/subscriptions/:id/resume", requireHqPermission("provider_manage"), async (req, res) => {
  try {
    const row = await resumeSubscription(String(req.params.id));
    await audit(req, res, "billing_subscription_resumed", "billing_subscription", row.id,
      { subscription_id: row.id }, row.provider_id);
    res.json({ subscription: await toSubscriptionRow(row) });
  } catch (error) { fail(req, res, error); }
});
const ChangeSchema = z.object({ product_id: z.string().uuid() });
router.get("/billing/hq/subscriptions/:id/change-quote", requireHqPermission("financial_read"), async (req, res) => {
  const parsed = ChangeSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Choose a product.", field: "product_id" }); return; }
  try { res.json(await quoteSubscriptionChange(String(req.params.id), parsed.data.product_id)); }
  catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/subscriptions/:id/change", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = ChangeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose a product.", field: "product_id" }); return; }
  try {
    const row = await changeSubscription(String(req.params.id), parsed.data.product_id);
    await audit(req, res, "billing_subscription_changed", "billing_subscription", row.id, {
      subscription_id: row.id, product_id: parsed.data.product_id,
    }, row.provider_id);
    res.json({ subscription: await toSubscriptionRow(row) });
  } catch (error) { fail(req, res, error); }
});
const CancelSchema = z.object({ at_period_end: z.boolean() });
router.post("/billing/hq/subscriptions/:id/cancel", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = CancelSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose when to cancel.", field: "at_period_end" }); return; }
  try {
    const subscription = await cancelSubscription(String(req.params.id), parsed.data);
    await audit(req, res, "billing_subscription_cancelled", "billing_subscription", String(req.params.id), {
      subscription_id: String(req.params.id), at_period_end: parsed.data.at_period_end,
    });
    res.json({ subscription });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/subscriptions/:id/retry-payment", requireHqPermission("provider_manage"), async (req, res) => {
  try {
    const row = await retrySubscriptionPayment(String(req.params.id));
    await audit(req, res, "billing_subscription_payment_retried", "billing_subscription", String(req.params.id), {
      subscription_id: String(req.params.id),
    });
    res.json({ subscription: await toSubscriptionRow(row) });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/subscriptions/:id/resend-payment-email", requireHqPermission("provider_manage"), async (req, res) => {
  try {
    const row = await resendSubscriptionPaymentEmail(String(req.params.id));
    await audit(req, res, "billing_subscription_payment_email_sent", "billing_subscription", String(req.params.id), {
      subscription_id: String(req.params.id),
    });
    res.json({ subscription: await toSubscriptionRow(row) });
  } catch (error) { fail(req, res, error); }
});

export default router;
