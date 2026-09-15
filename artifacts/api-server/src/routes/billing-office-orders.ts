import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireOfficeBillingScope } from "../billing/auth";
import { BillingOrderError, refundOrder, toOrderDetail } from "../billing/orders";
import { getBalance, listPayouts } from "../billing/payouts";
import { BillingReportingError, officeActivity, officeDashboard, officeRefunds, officeToday } from "../billing/reporting";
import {
  BillingSubscriptionError, cancelSubscription, changeSubscription, pauseSubscription, quoteSubscriptionChange,
  resendSubscriptionPaymentEmail, resumeSubscription, retrySubscriptionPayment, toSubscriptionRow,
} from "../billing/subscriptions";
import { encodeCursor, pagination, selectMany, selectOne, toOrderSummary } from "../billing/store";
import { getOrderBundle, officeName } from "../billing/store-orders";
import { stripeRejection } from "../billing/stripe-client";
import { recordAdminAuditEvent, requestIdOf, type AuditMetadata } from "../lib/admin-audit";

const router: IRouter = Router();
function audit(req: Request, scope: { actorUserId: string; providerId: string; isHq: boolean }, action: string, targetKind: string, targetId: string, metadata: AuditMetadata) {
  return recordAdminAuditEvent({
    action, actorUserId: scope.actorUserId, actorKind: scope.isHq ? "hq" : "team_member",
    providerId: scope.providerId, targetKind, targetId, requestId: requestIdOf(req), metadata,
  }).catch((error) => req.log?.error({ err: error }, `${action} audit failed`));
}
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
    const refund = await refundOrder(row.id, parsed.data, scope.actorUserId);
    await audit(req, scope, "billing_refund_issued", "billing_order", row.id, {
      order_id: row.id, amount_cents: refund.amount_cents, reason: "requested_by_customer",
    });
    res.json({ refund });
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
async function officeSubscription(req: Request, providerId: string) {
  return selectOne("billing_subscriptions",
    `id=eq.${encodeURIComponent(String(req.params.id))}&provider_id=eq.${encodeURIComponent(providerId)}`);
}
router.post("/billing/office/subscriptions/:id/pause", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    const row = await officeSubscription(req, scope.providerId);
    if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
    const subscription = await toSubscriptionRow(await pauseSubscription(row.id));
    await audit(req, scope, "billing_subscription_paused", "billing_subscription", row.id, { subscription_id: row.id });
    res.json({ subscription });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/subscriptions/:id/resume", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    const row = await officeSubscription(req, scope.providerId);
    if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
    const subscription = await toSubscriptionRow(await resumeSubscription(row.id));
    await audit(req, scope, "billing_subscription_resumed", "billing_subscription", row.id, { subscription_id: row.id });
    res.json({ subscription });
  } catch (error) { fail(req, res, error); }
});
const ChangeSchema = z.object({ product_id: z.string().uuid() });
router.get("/billing/office/subscriptions/:id/change-quote", async (req, res) => {
  const parsed = ChangeSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Choose a product.", field: "product_id" }); return; }
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: false }); if (!scope) return;
    const row = await officeSubscription(req, scope.providerId);
    if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
    res.json(await quoteSubscriptionChange(row.id, parsed.data.product_id));
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/subscriptions/:id/change", async (req, res) => {
  const parsed = ChangeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose a product.", field: "product_id" }); return; }
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    const row = await officeSubscription(req, scope.providerId);
    if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
    const subscription = await toSubscriptionRow(await changeSubscription(row.id, parsed.data.product_id));
    await audit(req, scope, "billing_subscription_changed", "billing_subscription", row.id, {
      subscription_id: row.id, product_id: parsed.data.product_id,
    });
    res.json({ subscription });
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
    const subscription = await cancelSubscription(row.id, parsed.data);
    await audit(req, scope, "billing_subscription_cancelled", "billing_subscription", row.id, {
      subscription_id: row.id, at_period_end: parsed.data.at_period_end,
    });
    res.json({ subscription });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/subscriptions/:id/retry-payment", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(String(req.params.id))}&provider_id=eq.${encodeURIComponent(scope.providerId)}`);
    if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
    const subscription = await toSubscriptionRow(await retrySubscriptionPayment(row.id));
    await audit(req, scope, "billing_subscription_payment_retried", "billing_subscription", row.id, { subscription_id: row.id });
    res.json({ subscription });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/subscriptions/:id/resend-payment-email", async (req, res) => {
  try {
    const scope = await requireOfficeBillingScope(req, res, { write: true }); if (!scope) return;
    const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(String(req.params.id))}&provider_id=eq.${encodeURIComponent(scope.providerId)}`);
    if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
    const subscription = await toSubscriptionRow(await resendSubscriptionPaymentEmail(row.id));
    await audit(req, scope, "billing_subscription_payment_email_sent", "billing_subscription", row.id, { subscription_id: row.id });
    res.json({ subscription });
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
