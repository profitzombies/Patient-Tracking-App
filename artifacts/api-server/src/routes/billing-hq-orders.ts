import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { BillingOrderError, refundOrder, toOrderDetail } from "../billing/orders";
import { sendShippedNotice } from "../billing/receipts";
import { hqOverview } from "../billing/reporting";
import { BillingSubscriptionError, cancelSubscription, toSubscriptionRow } from "../billing/subscriptions";
import { encodeCursor, pagination, selectMany, selectOne, toOrderSummary, update } from "../billing/store";
import { getOrderBundle, officeName } from "../billing/store-orders";
import { stripeRejection } from "../billing/stripe-client";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";

const router: IRouter = Router();
function actor(res: Response): string { return (res.locals.staff as StaffIdentity).userId; }
function fail(req: Request, res: Response, error: unknown): void {
  req.log?.error({ err: error }, "billing HQ orders request failed");
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
  try { res.json({ refund: await refundOrder(String(req.params.id), parsed.data, actor(res)) }); } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/fulfillment", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(await listOrders(req, true)); } catch (error) { fail(req, res, error); }
});
const FulfillmentSchema = z.object({
  status: z.enum(["to_ship", "shipped", "canceled"]), tracking_number: z.string().trim().nullable().optional(),
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
    if (parsed.data.status === "shipped" && !["paid", "partially_refunded"].includes(bundle.order.status)) {
      res.status(409).json({ error: "Only paid orders can be shipped." }); return;
    }
    const patch = parsed.data.status === "shipped" ? {
      fulfillment_status: "shipped", tracking_number: parsed.data.tracking_number,
      carrier: parsed.data.carrier, shipped_at: new Date().toISOString(), shipped_by: actor(res), canceled_reason: null,
    } : parsed.data.status === "canceled" ? {
      fulfillment_status: "canceled", canceled_reason: parsed.data.canceled_reason,
    } : { fulfillment_status: "to_ship", tracking_number: null, carrier: null, shipped_at: null, shipped_by: null, canceled_reason: null };
    const row = await update("billing_orders", `id=eq.${encodeURIComponent(bundle.order.id)}`, patch);
    if (!row) throw new BillingOrderError("Order not found.", 404);
    if (parsed.data.status === "shipped") await sendShippedNotice({ order: row, payer: bundle.payer, office: bundle.office });
    res.json({ order: await toOrderDetail(row.id, true) });
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
const CancelSchema = z.object({ at_period_end: z.boolean() });
router.post("/billing/hq/subscriptions/:id/cancel", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = CancelSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose when to cancel.", field: "at_period_end" }); return; }
  try { res.json({ subscription: await cancelSubscription(String(req.params.id), parsed.data) }); } catch (error) { fail(req, res, error); }
});

export default router;
