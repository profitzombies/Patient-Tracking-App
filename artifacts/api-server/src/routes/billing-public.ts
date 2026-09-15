import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { officeOffering, productImageSignedUrl } from "../billing/catalog";
import { BillingLinkError, resolveActiveLink, withClaimedLinkUse } from "../billing/links";
import { BillingOrderError, createOneTimeOrder } from "../billing/orders";
import { BillingSubscriptionError, cancelByToken, createSubscriptionOrder, toPublicSubscription } from "../billing/subscriptions";
import { getPublishableKey, isSandbox } from "../billing/stripe-client";
import { selectMany, selectOne } from "../billing/store";
import { getOrderBundle, getProvider, officeName } from "../billing/store-orders";
import { createLimiter } from "../coach/limits";
import { supabaseAdmin } from "../lib/supabase-admin";

const router: IRouter = Router();
const limits = (burst: number) => createLimiter({
  burst, refillPerMinute: burst / 10, maxConcurrent: 20, dailyBudget: 100_000,
  dailyMessage: "Payment requests have reached their daily limit. Please try again tomorrow.",
  busyMessage: "Payments are busy right now. Please try again in a moment.",
  rapidMessage: "Too many payment requests. Please wait a moment.",
});
const readLimit = limits(120);
const orderLimit = limits(20);
const cancelLimit = limits(10);
async function limited(req: Request, res: Response, acquire: ReturnType<typeof limits>, work: () => Promise<void>) {
  const slot = acquire(req.ip || req.socket.remoteAddress || "unknown");
  if (!slot.ok) { res.status(429).json({ error: slot.message }); return; }
  try { await work(); } finally { slot.release(); }
}
function fail(req: Request, res: Response, error: unknown): void {
  if (error instanceof BillingLinkError || error instanceof BillingOrderError || error instanceof BillingSubscriptionError) {
    // Expected client outcomes (dead link, bad field) are not incidents.
    if (error.status >= 500) req.log?.error({ err: error }, "billing public request failed");
    else req.log?.info({ status: error.status, message: error.message }, "billing public request rejected");
    res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}) }); return;
  }
  req.log?.error({ err: error }, "billing public request failed");
  res.status(503).json({ error: "Payments are temporarily unavailable." });
}
function maskedEmail(email: string | null): string | null {
  if (!email) return null;
  const separator = email.lastIndexOf("@");
  if (separator < 1 || separator === email.length - 1) return null;
  return `${email[0]}***${email.slice(separator)}`;
}
router.get("/billing/public/config", (req, res) => void limited(req, res, readLimit, async () => {
  try { res.json({ sandbox: await isSandbox() }); } catch (error) { fail(req, res, error); }
}));
// Product images are open reads: the id is an unguessable uuid and the object
// itself only ever holds catalog artwork. The redirect target is a
// short-lived signed URL, so nothing durable leaks through the redirect.
router.get("/billing/public/product-images/:imageId", async (req, res) => {
  try {
    const url = await productImageSignedUrl(String(req.params.imageId));
    if (!url) { res.status(404).json({ error: "Image not found." }); return; }
    res.setHeader("Cache-Control", "private, max-age=600");
    res.redirect(302, url);
  } catch (error) {
    req.log?.error({ err: error }, "product image redirect failed");
    res.status(503).json({ error: "Image unavailable." });
  }
});
router.get("/billing/public/links/:token", (req, res) => void limited(req, res, readLimit, async () => {
  try {
    const link = await resolveActiveLink(String(req.params.token));
    const [products, account, settings, provider, patientResult] = await Promise.all([
      officeOffering(link.provider_id),
      selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(link.provider_id)}&disconnected_at=is.null`),
      selectOne("billing_settings", "id=eq.1"),
      getProvider(link.provider_id),
      link.patient_id ? supabaseAdmin("GET", `/rest/v1/patients?id=eq.${encodeURIComponent(link.patient_id)}&provider_id=eq.${encodeURIComponent(link.provider_id)}&select=first_name,last_name,name,email,phone&limit=1`) : null,
    ]);
    if (!account?.charges_enabled || !provider || !settings) throw new BillingLinkError("This office is not ready to accept payments.", 409);
    const patient = patientResult && patientResult.status < 300 && Array.isArray(patientResult.json) ? patientResult.json[0] as {
      first_name?: string | null; last_name?: string | null; name?: string | null; email?: string | null; phone?: string | null;
    } | undefined : undefined;
    const patientName = patient?.name?.trim() || `${patient?.first_name ?? ""} ${patient?.last_name ?? ""}`.trim() || "Patient";
    res.json({
      token: link.token, office: { name: officeName(provider), city: provider.city, state: provider.state },
      products,
      shipping_charge_cents: settings.shipping_charge_cents, tax_enabled: account.tax_enabled,
      locked_payer: link.patient_id ? { name: patientName, email: patient?.email ?? null, phone: patient?.phone ?? null } : null,
      sandbox: await isSandbox(), publishable_key: await getPublishableKey(), stripe_account_id: account.stripe_account_id, active: true,
      preselected_product_id: link.product_id,
    });
  } catch (error) { fail(req, res, error); }
}));
const AddressSchema = z.object({
  name: z.string().trim().min(1), line1: z.string().trim().min(1), line2: z.string().trim().nullable(),
  city: z.string().trim().min(1), state: z.string().trim().min(1), postal_code: z.string().trim().min(3),
  country: z.string().trim().length(2), phone: z.string().trim().nullable(),
});
const OrderSchema = z.object({
  items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.number().int().min(1).max(10) })).min(1),
  payer: z.object({ name: z.string().trim().min(1), email: z.string().email(), phone: z.string() }).optional(),
  shipping_address: AddressSchema, purchase: z.enum(["one_time", "subscription"]),
});
router.post("/billing/public/links/:token/orders", (req, res) => void limited(req, res, orderLimit, async () => {
  const parsed = OrderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the order.", field: String(parsed.error.issues[0]?.path[0] ?? "") }); return; }
  try {
    const link = await resolveActiveLink(String(req.params.token));
    if (parsed.data.purchase === "subscription" && (parsed.data.items.length !== 1 || parsed.data.items[0].quantity !== 1)) {
      res.status(400).json({ error: "Choose one product for a subscription.", field: "items" }); return;
    }
    const result = await withClaimedLinkUse(link.id, () => parsed.data.purchase === "one_time"
      ? createOneTimeOrder({ link, payerInput: parsed.data.payer, shipping_address: parsed.data.shipping_address, items: parsed.data.items })
      : createSubscriptionOrder({ link, payerInput: parsed.data.payer, shipping_address: parsed.data.shipping_address, product_id: parsed.data.items[0].product_id }));
    res.status(201).json(result);
  } catch (error) { fail(req, res, error); }
}));
router.get("/billing/public/orders/:id/status", (req, res) => void limited(req, res, readLimit, async () => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    // A non-UUID id (e.g. an order number pasted into the URL) is "not found",
    // not a database error.
    if (!z.string().uuid().safeParse(req.params.id).success) { res.status(404).json({ error: "Order not found." }); return; }
    const link = token ? await selectOne("billing_payment_links", `token=eq.${encodeURIComponent(token)}`) : null;
    const bundle = await getOrderBundle(String(req.params.id));
    if (!link || !bundle || bundle.order.link_id !== link.id) { res.status(404).json({ error: "Order not found." }); return; }
    const subscription = bundle.order.subscription_id ? await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(bundle.order.subscription_id)}`) : null;
    res.json({
      order_id: bundle.order.id, order_number: bundle.order.order_number, status: bundle.order.status,
      total_cents: bundle.order.total_cents, tax_cents: bundle.order.tax_cents, subtotal_cents: bundle.order.subtotal_cents,
      shipping_charge_cents: bundle.order.shipping_charge_cents,
      items: bundle.items.map((item) => ({ name: item.product_name_snapshot, quantity: item.quantity, unit_price_cents: item.unit_price_cents })),
      office_name: officeName(bundle.office), payer_email: maskedEmail(bundle.payer.email),
      subscription: subscription ? { every_weeks: 4, renews_on: subscription.current_period_end } : null,
    });
  } catch (error) { fail(req, res, error); }
}));
router.get("/billing/public/subscriptions/:cancel_token", (req, res) => void limited(req, res, readLimit, async () => {
  try {
    const row = await selectOne("billing_subscriptions", `cancel_token=eq.${encodeURIComponent(String(req.params.cancel_token))}`);
    if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
    res.json(await toPublicSubscription(row));
  } catch (error) { fail(req, res, error); }
}));
router.post("/billing/public/subscriptions/:cancel_token/cancel", (req, res) => void limited(req, res, cancelLimit, async () => {
  try { res.json(await cancelByToken(String(req.params.cancel_token))); } catch (error) { fail(req, res, error); }
}));

export default router;
