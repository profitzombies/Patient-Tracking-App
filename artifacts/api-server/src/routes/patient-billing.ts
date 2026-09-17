import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { officeOffering } from "../billing/catalog";
import { list, orderDto, paidStatuses, subscriptionDto } from "../billing/patient-dtos";
import { createLink, linkUrl } from "../billing/links";
import { connectedOpts, getStripe, isStripeMissing } from "../billing/stripe-client";
import { shipmentsForOrders } from "../billing/shipments";
import { selectMany, selectOne, type BillingOrderItemRow, type BillingOrderRow, type BillingRefundRow } from "../billing/store";
import { cancelSubscription, BillingSubscriptionError } from "../billing/subscriptions";
import type { PatientBillingOrder, PatientBillingOverview, PatientReceipt } from "../billing/types";
import { resolvePatient } from "../lib/patient-auth";
import { supabaseAdmin } from "../lib/supabase-admin";

export { list, orderDto, paidStatuses, subscriptionDto };

const router: IRouter = Router();
const enc = encodeURIComponent;
const uuid = z.string().uuid();

export async function patientContext(req: Request, res: Response) {
  const auth = await resolvePatient(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error, ...auth.details });
    return null;
  }
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(auth.patientId)}&select=id,provider_id&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error("Could not load patient billing details.");
  const row = result.json[0] as { id?: string; provider_id?: string } | undefined;
  if (!row?.provider_id) {
    res.status(403).json({ error: "This patient is not linked to an office." });
    return null;
  }
  return { patientId: auth.patientId, providerId: row.provider_id, authUserId: auth.authUserId };
}

async function loadOverview(patientId: string, providerId: string): Promise<PatientBillingOverview> {
  const [providerResult, account, settings, offering, orders, subscriptions] = await Promise.all([
    supabaseAdmin("GET", `/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=provider_id,office_name,provider_name&limit=1`),
    selectOne("billing_connected_accounts", `provider_id=eq.${enc(providerId)}&disconnected_at=is.null`),
    selectOne("billing_settings", "id=eq.1"),
    officeOffering(providerId),
    // Every patient read is scoped to the patient AND their current office: a
    // patient moved between practices never sees the prior office's activity here.
    selectMany("billing_orders", `patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&order=created_at.desc&limit=50`),
    selectMany("billing_subscriptions", `patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&order=created_at.desc`),
  ]);
  if (providerResult.status >= 300 || !Array.isArray(providerResult.json)) throw new Error("Could not load office.");
  const provider = providerResult.json[0] as { provider_id: string; office_name?: string | null; provider_name?: string | null } | undefined;
  if (!settings) throw new Error("Billing settings are unavailable.");
  const orderIds = orders.map((row) => row.id);
  const productIds = [...new Set(subscriptions.map((row) => row.product_id))];
  const [loadedItems, loadedRefunds, products, shipments] = await Promise.all([
    orderIds.length ? selectMany("billing_order_items", `order_id=${list(orderIds)}`) : [],
    orderIds.length ? selectMany("billing_refunds", `order_id=${list(orderIds)}&status=eq.succeeded`) : [],
    productIds.length ? selectMany("billing_products", `id=${list(productIds)}`) : [],
    shipmentsForOrders(orderIds),
  ]);
  const items = loadedItems as BillingOrderItemRow[];
  const refunds = loadedRefunds as BillingRefundRow[];
  const productsById = new Map(products.map((row) => [row.id, row.name]));
  const orderDtos: PatientBillingOrder[] = orders.map((order) => orderDto(
    order, items.filter((item) => item.order_id === order.id),
    refunds.filter((refund) => refund.order_id === order.id), shipments.get(order.id) ?? null,
  ));
  const paymentsAvailable = Boolean(provider && account?.charges_enabled && offering.length > 0);
  return {
    office: provider ? {
      provider_id: provider.provider_id,
      office_name: provider.office_name?.trim() || provider.provider_name?.trim() || "Office",
      payments_available: paymentsAvailable,
    } : null,
    products: paymentsAvailable ? offering : [],
    shipping_charge_cents: settings.shipping_charge_cents,
    orders: orderDtos,
    subscriptions: subscriptions.map((row) => subscriptionDto(row, productsById.get(row.product_id) ?? "Subscription")),
  };
}

function fail(req: Request, res: Response, error: unknown): void {
  if (error instanceof BillingSubscriptionError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  req.log?.error({ err: error }, "patient billing request failed");
  res.status(503).json({ error: "Billing is unavailable right now." });
}

router.get("/patient-data/billing/overview", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (ctx) res.json(await loadOverview(ctx.patientId, ctx.providerId));
  } catch (error) { fail(req, res, error); }
});

router.post("/patient-data/billing/checkout-link", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const parsed = z.object({ product_id: z.string().uuid().nullable().optional() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "Choose a valid product." }); return; }
    const [account, offering] = await Promise.all([
      selectOne("billing_connected_accounts", `provider_id=eq.${enc(ctx.providerId)}&disconnected_at=is.null`),
      officeOffering(ctx.providerId),
    ]);
    if (!account?.charges_enabled || offering.length === 0) {
      res.status(409).json({ error: "This office is not ready to accept payments." }); return;
    }
    const productId = parsed.data.product_id ?? null;
    if (productId && !offering.some((product) => product.product_id === productId)) {
      res.status(400).json({ error: "Choose a product offered by this office." }); return;
    }
    const productFilter = productId ? `product_id=eq.${enc(productId)}` : "product_id=is.null";
    const existing = await selectOne(
      "billing_payment_links",
      `provider_id=eq.${enc(ctx.providerId)}&patient_id=eq.${enc(ctx.patientId)}&label=eq.${enc("Patient app")}` +
      `&active=eq.true&expires_at=is.null&max_uses=is.null&${productFilter}&order=created_at.desc`,
    );
    const link = existing ?? await createLink(ctx.providerId, ctx.authUserId, {
      patient_id: ctx.patientId, label: "Patient app", product_id: productId,
      expires_in_hours: null, max_uses: null,
    });
    res.json({
      url: `${linkUrl(link.token)}?source=app`,
      token: link.token,
      expires_at: link.expires_at,
    });
  } catch (error) { fail(req, res, error); }
});

async function ownedOrder(id: string, patientId: string, providerId: string): Promise<BillingOrderRow | null> {
  return selectOne("billing_orders", `id=eq.${enc(id)}&patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}`);
}

router.get("/patient-data/billing/orders/:id/receipt", async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) { res.status(404).json({ error: "Receipt not found." }); return; }
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const order = await ownedOrder(String(req.params.id), ctx.patientId, ctx.providerId);
    if (!order || !paidStatuses.has(order.status)) { res.status(404).json({ error: "Receipt not found." }); return; }
    // Historical receipts still belong to the patient after an office disconnects.
    // Stripe scopes the retrieval to the stored Connect account id.
    const account = await selectOne("billing_connected_accounts", `provider_id=eq.${enc(order.provider_id)}`);
    if (!account) { res.status(404).json({ error: "Receipt not found." }); return; }
    const stripe = await getStripe();
    const receipt: PatientReceipt = {
      order_number: order.order_number, receipt_url: null, invoice_url: null, invoice_pdf_url: null,
    };
    if ((order.kind === "subscription_initial" || order.kind === "subscription_renewal") && order.stripe_invoice_id) {
      const invoice = await stripe.invoices.retrieve(order.stripe_invoice_id, {}, connectedOpts(account.stripe_account_id));
      receipt.invoice_url = invoice.hosted_invoice_url ?? null;
      receipt.invoice_pdf_url = invoice.invoice_pdf ?? null;
    } else if (order.stripe_charge_id) {
      const charge = await stripe.charges.retrieve(order.stripe_charge_id, {}, connectedOpts(account.stripe_account_id));
      receipt.receipt_url = charge.receipt_url ?? null;
    } else if (order.stripe_payment_intent_id) {
      const intent = await stripe.paymentIntents.retrieve(
        order.stripe_payment_intent_id, { expand: ["latest_charge"] }, connectedOpts(account.stripe_account_id),
      );
      const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
      receipt.receipt_url = charge && "receipt_url" in charge ? charge.receipt_url : null;
    }
    if (!receipt.receipt_url && !receipt.invoice_url && !receipt.invoice_pdf_url) {
      res.status(404).json({ error: "Receipt not found." }); return;
    }
    res.json(receipt);
  } catch (error) {
    if (isStripeMissing(error)) { res.status(404).json({ error: "Receipt not found." }); return; }
    req.log?.error({ err: error }, "patient receipt lookup failed");
    res.status(502).json({ error: "Receipt is unavailable right now." });
  }
});

router.post("/patient-data/billing/subscriptions/:id/cancel", async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) { res.status(404).json({ error: "Subscription not found." }); return; }
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const id = String(req.params.id);
    const row = await selectOne("billing_subscriptions", `id=eq.${enc(id)}&patient_id=eq.${enc(ctx.patientId)}&provider_id=eq.${enc(ctx.providerId)}`);
    if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
    if (row.status === "canceled" || row.cancel_at_period_end) {
      res.status(409).json({ error: "This subscription is already canceled." }); return;
    }
    const updated = await cancelSubscription(id, { at_period_end: true });
    const product = await selectOne("billing_products", `id=eq.${enc(updated.product_id)}`);
    res.json(subscriptionDto(updated, product?.name ?? "Subscription"));
  } catch (error) { fail(req, res, error); }
});

export default router;