import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireOfficeBillingScope, type BillingOfficeScope } from "../billing/auth";
import { BillingCartError, checkoutCart, planCart } from "../billing/cart";
import { officeOffering, subscribeSavePercent } from "../billing/catalog";
import {
  PrebuiltCartError, cartPatient, createPrebuiltCart, getPrebuiltCart, listPrebuiltCarts, revokePrebuiltCart,
} from "../billing/prebuilt-carts";
import { getPublishableKey, isSandbox } from "../billing/stripe-client";
import { selectOne } from "../billing/store";
import { recordAdminAuditEvent, requestIdOf, type AuditMetadata } from "../lib/admin-audit";

const router: IRouter = Router();
const Line = z.object({
  product_id: z.string().uuid(), quantity: z.number().int().min(1).max(10),
  purchase: z.enum(["one_time", "subscription"]), cadence_weeks: z.number().int().nullable().optional(),
});
const Address = z.object({
  name: z.string().trim().min(1), line1: z.string().trim().min(1), line2: z.string().trim().nullable(),
  city: z.string().trim().min(1), state: z.string().trim().min(1), postal_code: z.string().trim().min(3),
  country: z.string().trim().length(2), phone: z.string().trim().nullable(),
});
const Sale = z.object({
  patient_id: z.string().uuid(), lines: z.array(Line).min(1).max(20), shipping_address: Address,
  payment_method_id: z.string().trim().min(1).max(200), cart_id: z.string().uuid(),
});
const Cart = z.object({
  patient_id: z.string().uuid().nullish(), lines: z.array(Line).min(1).max(20),
  label: z.string().trim().max(120).nullish(), expires_in_minutes: z.number().int().min(5).max(1440).optional(),
});
function audit(req: Request, scope: BillingOfficeScope, action: string, targetId: string | null, metadata: AuditMetadata) {
  return recordAdminAuditEvent({
    action, actorUserId: scope.actorUserId, actorKind: scope.isHq ? "hq" : "team_member",
    providerId: scope.providerId, targetKind: "billing_cart", targetId, requestId: requestIdOf(req), metadata,
  }).catch((error) => req.log?.error({ err: error }, `${action} audit failed`));
}
function fail(req: Request, res: Response, error: unknown) {
  if (error instanceof BillingCartError || error instanceof PrebuiltCartError) {
    res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}) }); return;
  }
  req.log?.error({ err: error }, "office sale request failed");
  res.status(503).json({ error: "Payments are temporarily unavailable." });
}
async function scope(req: Request, res: Response) { return requireOfficeBillingScope(req, res, { write: true, sell: true }); }
async function patient(scopeValue: BillingOfficeScope, id: string) {
  const value = await cartPatient(scopeValue.providerId, id);
  if (!value) throw new PrebuiltCartError("Patient not found.", 404, "patient_id");
  return value;
}
function name(person: { first_name?: string | null; last_name?: string | null; name?: string | null }) {
  return person.name?.trim() || `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim() || "Patient";
}
router.get("/billing/office/sales/context", async (req, res) => {
  try {
    const scoped = await scope(req, res); if (!scoped) return;
    const id = typeof req.query.patient_id === "string" ? req.query.patient_id : "";
    if (!z.string().uuid().safeParse(id).success) { res.status(400).json({ error: "Choose a patient.", field: "patient_id" }); return; }
    const person = await patient(scoped, id);
    const [products, account, settings, order, sandbox, publishableKey] = await Promise.all([
      officeOffering(scoped.providerId),
      selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(scoped.providerId)}&disconnected_at=is.null`),
      selectOne("billing_settings", "id=eq.1"),
      selectOne("billing_orders", `patient_id=eq.${encodeURIComponent(id)}&provider_id=eq.${encodeURIComponent(scoped.providerId)}&order=created_at.desc`),
      isSandbox(), getPublishableKey(),
    ]);
    const available = Boolean(account?.charges_enabled && products.length);
    res.json({
      patient: { id: person.id, name: name(person), email: person.email ?? null, phone: person.phone ?? null },
      default_address: order?.shipping_address ?? null, products,
      shipping_charge_cents: settings?.shipping_charge_cents ?? 0, subscribe_save_percent: settings ? subscribeSavePercent(settings) : 0,
      stripe_account_id: account?.stripe_account_id ?? null, publishable_key: publishableKey, sandbox, available,
      unavailable_reason: available ? null : !account?.charges_enabled ? "not_connected" : "no_products",
    });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/sales/quote", async (req, res) => {
  try {
    const scoped = await scope(req, res); if (!scoped) return;
    const parsed = z.object({ patient_id: z.string().uuid(), lines: z.array(Line).min(1).max(20) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the sale." }); return; }
    await patient(scoped, parsed.data.patient_id);
    res.json((await planCart(scoped.providerId, parsed.data.lines)).quote);
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/sales", async (req, res) => {
  try {
    const scoped = await scope(req, res); if (!scoped) return;
    const parsed = Sale.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the sale." }); return; }
    await patient(scoped, parsed.data.patient_id);
    const cartId = String(req.headers["idempotency-key"] ?? parsed.data.cart_id ?? crypto.randomUUID());
    if (!z.string().uuid().safeParse(cartId).success) { res.status(400).json({ error: "Use a valid checkout key.", field: "cart_id" }); return; }
    const result = await checkoutCart({
      patientId: parsed.data.patient_id, providerId: scoped.providerId, cartId, lines: parsed.data.lines,
      shipping_address: parsed.data.shipping_address, payment_method_id: parsed.data.payment_method_id,
    });
    await audit(req, scoped, "billing_office_sale_created", result.cart_id, { patient_id: parsed.data.patient_id, status: result.status });
    res.status(result.status === "failed" ? 402 : 200).json(result);
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/office/carts", async (req, res) => {
  try {
    const scoped = await scope(req, res); if (!scoped) return;
    const parsed = Cart.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the cart." }); return; }
    const plan = await planCart(scoped.providerId, parsed.data.lines);
    const cart = await createPrebuiltCart(scoped.providerId, scoped.actorUserId, { ...parsed.data, quote: plan.quote });
    await audit(req, scoped, "billing_prebuilt_cart_created", cart.id, { patient_id: parsed.data.patient_id ?? null });
    res.status(201).json(cart);
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/office/carts/:id", async (req, res) => {
  try { const scoped = await scope(req, res); if (!scoped) return; res.json(await getPrebuiltCart(scoped.providerId, String(req.params.id))); }
  catch (error) { fail(req, res, error); }
});
router.post("/billing/office/carts/:id/revoke", async (req, res) => {
  try { const scoped = await scope(req, res); if (!scoped) return; res.json(await revokePrebuiltCart(scoped.providerId, String(req.params.id))); }
  catch (error) { fail(req, res, error); }
});
router.get("/billing/office/carts", async (req, res) => {
  try {
    const scoped = await scope(req, res); if (!scoped) return;
    res.json({ items: await listPrebuiltCarts(scoped.providerId, {
      patient_id: typeof req.query.patient_id === "string" ? req.query.patient_id : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
    }) });
  } catch (error) { fail(req, res, error); }
});
export default router;