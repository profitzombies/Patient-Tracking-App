import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireOfficeBillingScope } from "../billing/auth";
import { BillingOrderError, refundOrder, toOrderDetail } from "../billing/orders";
import { getBalance, listPayouts } from "../billing/payouts";
import { BillingReportingError, officeActivity, officeDashboard, officeRefunds, officeToday } from "../billing/reporting";
import { BillingSubscriptionError, cancelSubscription, toSubscriptionRow } from "../billing/subscriptions";
import { encodeCursor, pagination, selectMany, selectOne, toOrderSummary } from "../billing/store";
import { getOrderBundle, officeName } from "../billing/store-orders";
import { stripeRejection } from "../billing/stripe-client";

const router: IRouter = Router();
function fail(req: Request, res: Response, error: unknown): void {
  req.log?.error({ err: error }, "billing office orders request failed");
  if (error instanceof BillingOrderError || error instanceof BillingSubscriptionError) {
    res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}) }); return;
  }
  if (error instanceof BillingReportingError) { res.status(error.status).json({ error: error.message }); return; }
  const rejected = stripeRejection(error);
  if (rejected) { res.status(rejected.status).json({ error: rejected.message }); return; }
  res.status(503).json({ error: "Payments are temporarily unavailable." });
}
router.get("/billing/office/dashboard", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    const dashboard = await officeDashboard(scope.providerId, req.query);
    const account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(scope.providerId)}`);
    if (account) {
      const balance = await getBalance(account.stripe_account_id);
      if (balance.balance) dashboard.balance = balance.balance;
      const payouts = await listPayouts(account.stripe_account_id, scope.providerId);
      const next = payouts.items.find((row) => row.status === "pending" || row.status === "in_transit");
      dashboard.next_payout = next ? { amount_cents: next.amount_cents, arrival_date: next.arrival_date } : null;
    }
    res.json(dashboard);
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/overview/today", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    res.json(await officeToday(scope.providerId, req.query));
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/activity", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    res.json(await officeActivity(scope.providerId, req.query));
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/refunds", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    res.json(await officeRefunds(scope.providerId, req.query));
  } catch (error) { fail(req, res, error); }
});
/**
 * Read-only shipping status for the office: paid orders in one fulfillment
 * state (default: waiting to ship) as full detail rows. HQ ships from its own
 * queue; the office only watches.
 */
router.get("/billing/office/fulfillment", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    const page = pagination(req.query);
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : "to_ship";
    const filters = [
      `provider_id=eq.${encodeURIComponent(scope.providerId)}`,
      `fulfillment_status=eq.${encodeURIComponent(status)}`,
      "status=in.(paid,partially_refunded)",
    ];
    if (typeof req.query.from === "string") filters.push(`created_at=gte.${encodeURIComponent(`${req.query.from}T00:00:00Z`)}`);
    if (typeof req.query.to === "string") filters.push(`created_at=lte.${encodeURIComponent(`${req.query.to}T23:59:59Z`)}`);
    if (page.cursor) filters.push(`created_at=lt.${encodeURIComponent(page.cursor.created_at)}`);
    const rows = await selectMany("billing_orders", `${filters.join("&")}&order=created_at.desc,id.desc&limit=${page.limit + 1}`);
    const visible = rows.slice(0, page.limit);
    const items = await Promise.all(visible.map((row) => toOrderDetail(row.id, false)));
    res.json({ items, next_cursor: rows.length > page.limit ? encodeCursor(visible.at(-1) ?? null) : null });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/orders", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    const page = pagination(req.query);
    const filters = [`provider_id=eq.${encodeURIComponent(scope.providerId)}`];
    for (const key of ["status", "fulfillment_status", "patient_id"] as const) {
      const queryKey = key === "fulfillment_status" ? "fulfillment" : key;
      if (typeof req.query[queryKey] === "string") filters.push(`${key}=eq.${encodeURIComponent(req.query[queryKey] as string)}`);
    }
    if (typeof req.query.from === "string") filters.push(`created_at=gte.${encodeURIComponent(`${req.query.from}T00:00:00Z`)}`);
    if (typeof req.query.to === "string") filters.push(`created_at=lte.${encodeURIComponent(`${req.query.to}T23:59:59Z`)}`);
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      filters.push(`order_number=ilike.*${encodeURIComponent(req.query.q.trim().replace(/[%(),]/g, ""))}*`);
    }
    if (page.cursor) filters.push(`created_at=lt.${encodeURIComponent(page.cursor.created_at)}`);
    const rows = await selectMany("billing_orders", `${filters.join("&")}&order=created_at.desc,id.desc&limit=${page.limit + 1}`);
    const visible = rows.slice(0, page.limit);
    const items = await Promise.all(visible.map(async (row) => {
      const bundle = await getOrderBundle(row.id);
      if (!bundle) throw new Error("Order details are incomplete.");
      return toOrderSummary(row, bundle.items, bundle.payer, officeName(bundle.office));
    }));
    res.json({ items, next_cursor: rows.length > page.limit ? encodeCursor(visible.at(-1) ?? null) : null });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/orders/:id", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    const row = await selectOne("billing_orders", `id=eq.${encodeURIComponent(String(req.params.id))}&provider_id=eq.${encodeURIComponent(scope.providerId)}`);
    if (!row) { res.status(404).json({ error: "Order not found." }); return; }
    res.json(await toOrderDetail(row.id, false));
  } catch (error) { fail(req, res, error); }
});
const RefundSchema = z.object({ amount_cents: z.number().int().positive().optional(), reason: z.string().trim().min(1).max(500) });
router.post("/billing/office/orders/:id/refund", async (req, res) => {
  const parsed = RefundSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the refund.", field: String(parsed.error.issues[0]?.path[0] ?? "") }); return; }
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    const row = await selectOne("billing_orders", `id=eq.${encodeURIComponent(String(req.params.id))}&provider_id=eq.${encodeURIComponent(scope.providerId)}`);
    if (!row) { res.status(404).json({ error: "Order not found." }); return; }
    res.json({ refund: await refundOrder(row.id, parsed.data, scope.actorUserId) });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/subscriptions", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    const status = typeof req.query.status === "string" ? `&status=eq.${encodeURIComponent(req.query.status)}` : "";
    const rows = await selectMany("billing_subscriptions", `provider_id=eq.${encodeURIComponent(scope.providerId)}${status}&order=created_at.desc`);
    res.json({ items: await Promise.all(rows.map(toSubscriptionRow)), next_cursor: null });
  } catch (error) { fail(req, res, error); }
});
const CancelSchema = z.object({ at_period_end: z.boolean() });
router.post("/billing/office/subscriptions/:id/cancel", async (req, res) => {
  const parsed = CancelSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose when to cancel.", field: "at_period_end" }); return; }
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(String(req.params.id))}&provider_id=eq.${encodeURIComponent(scope.providerId)}`);
    if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
    res.json({ subscription: await cancelSubscription(row.id, parsed.data) });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/payouts", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    const account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(scope.providerId)}`);
    if (!account) { res.status(409).json({ error: "Connect a Stripe account first." }); return; }
    const [balance, payouts] = await Promise.all([getBalance(account.stripe_account_id), listPayouts(account.stripe_account_id, scope.providerId)]);
    if (!balance.balance && payouts.stale && !payouts.items.length) { res.status(503).json({ error: "Payout information is temporarily unavailable." }); return; }
    res.json({ balance: balance.balance ?? { available_cents: 0, pending_cents: 0 }, items: payouts.items, stale: balance.stale || payouts.stale });
  } catch (error) { fail(req, res, error); }
});

export default router;
