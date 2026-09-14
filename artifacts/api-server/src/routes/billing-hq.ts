import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { toConnectedAccount } from "../billing/accounts";
import {
  BillingCatalogError, createProduct, editProduct, finalizeProductImage, getProduct, listCatalog, listCatalogChanges,
  productImageUploadUrl, removeProductImage, reorderProducts, setDefaultProductImage, setProductActive, setProductStatus,
  updateSettings,
} from "../billing/catalog";
import { listOfficePrices } from "../billing/prices";
import { officeDashboard } from "../billing/reporting";
import { selectMany, selectOne, toOrderSummary } from "../billing/store";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { stripeRejection } from "../billing/stripe-client";
import { supabaseAdmin } from "../lib/supabase-admin";
import { getBillingWebhookHealth } from "../billing/webhook-endpoints";
import { publicOrigin } from "../billing/app-origin";
import { getConnectClientId, getStripeCredentials, isSandbox } from "../billing/stripe-client";
import { recordAdminAuditEvent, requestIdOf, type AuditMetadata } from "../lib/admin-audit";

const router: IRouter = Router();
const ProductSchema = z.object({
  name: z.string().trim().min(1).max(120), slug: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  floor_price_cents: z.number().int().nonnegative(), hard_cost_cents: z.number().int().nonnegative(),
  sort_order: z.number().int().optional(), status: z.enum(["draft", "active"]).optional(),
});
const StatusSchema = z.object({ status: z.enum(["draft", "active", "retired", "archived"]) });
const OrderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });
const ImageUploadSchema = z.object({ content_type: z.string().min(1), size: z.number().int().positive() });
const ImageFinalizeSchema = ImageUploadSchema.extend({ image_id: z.string().uuid(), object_path: z.string().min(1) });
const SettingsSchema = z.object({
  shipping_charge_cents: z.number().int().nonnegative(), shipping_cost_cents: z.number().int().nonnegative(),
  card_fee_bps: z.number().int().min(0).max(10_000), card_fee_fixed_cents: z.number().int().nonnegative(),
  expected_version: z.number().int().nonnegative(),
});
function actor(res: Response): string { return (res.locals.staff as StaffIdentity).userId; }
function audit(req: Request, res: Response, action: string, targetKind: string, targetId: string | null, metadata: AuditMetadata) {
  return recordAdminAuditEvent({
    action, actorUserId: actor(res), actorKind: "hq", providerId: null, targetKind, targetId,
    requestId: requestIdOf(req), metadata,
  }).catch((error) => req.log?.error({ err: error }, `${action} audit failed`));
}
function fail(req: Request, res: Response, error: unknown): void {
  req.log?.error({ err: error }, "billing HQ request failed");
  if (error instanceof BillingCatalogError) {
    res.status(error.status).json({ error: error.message, ...(error.field ? { field: error.field } : {}) }); return;
  }
  const rejected = stripeRejection(error);
  if (rejected) { res.status(rejected.status).json({ error: rejected.message }); return; }
  res.status(503).json({ error: "Payments are temporarily unavailable." });
}
router.get("/billing/hq/health", requireHqPermission("financial_read"), async (_req, res) => {
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  let credentialsOk = true;
  let sandbox = false;
  try {
    await getStripeCredentials();
    sandbox = await isSandbox();
  } catch {
    credentialsOk = false;
  }
  let origin: string | null = null;
  try { origin = publicOrigin(); } catch { /* reported as missing configuration */ }
  try {
    const [webhooks, lastEvents, pending, unprocessed, failed, runResult] = await Promise.all([
      getBillingWebhookHealth(),
      selectMany("billing_webhook_events", "order=received_at.desc&limit=1"),
      selectMany("billing_orders", `status=eq.pending&created_at=lt.${encodeURIComponent(hourAgo)}&select=id`),
      selectMany("billing_webhook_events", "processed_at=is.null&select=stripe_event_id"),
      selectMany("billing_webhook_events", `error=not.is.null&received_at=gte.${encodeURIComponent(dayAgo)}&select=stripe_event_id`),
      supabaseAdmin("GET", "/rest/v1/system_job_runs?job_name=eq.billing-reconcile&order=started_at.desc&limit=1&select=started_at,status"),
    ]);
    if (runResult.status >= 300) throw new Error(`reconcile health lookup failed (${runResult.status})`);
    const run = Array.isArray(runResult.json) ? runResult.json[0] as any : null;
    res.json({
      sandbox, livemode: credentialsOk && !sandbox, credentials_ok: credentialsOk,
      connect_client_id_configured: Boolean(getConnectClientId()), public_origin: origin, webhooks,
      last_webhook_received_at: lastEvents[0]?.received_at ?? null,
      pending_orders_over_1h: pending.length, unprocessed_webhook_events: unprocessed.length,
      last_reconcile_run: run ? { at: run.started_at, status: run.status } : null,
      failed_events_24h: failed.length,
    });
  } catch (error) {
    _req.log?.error({ err: error }, "payments health lookup failed");
    res.status(503).json({ error: "Payments health is temporarily unavailable." });
  }
});
router.get("/billing/hq/catalog", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json(await listCatalog()); } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/catalog/products", requireHqPermission("settings_manage"), async (req, res) => {
  const parsed = ProductSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the product.", field: String(parsed.error.issues[0]?.path[0] ?? "") }); return; }
  try {
    const product = await createProduct(parsed.data, actor(res));
    await audit(req, res, "billing_product_created", "billing_product", product.id, { product_id: product.id });
    res.status(201).json({ product });
  } catch (error) { fail(req, res, error); }
});
router.put("/billing/hq/catalog/products/:id", requireHqPermission("settings_manage"), async (req, res) => {
  const parsed = ProductSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Check the product details." }); return; }
  try {
    const product = await editProduct(String(req.params.id), parsed.data, actor(res));
    const floorChanged = parsed.data.floor_price_cents !== undefined;
    await audit(req, res, floorChanged ? "billing_product_floor_updated" : "billing_product_updated", "billing_product", product.id,
      floorChanged ? { product_id: product.id, floor_price_cents: product.floor_price_cents } : { product_id: product.id });
    res.json({ product });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/catalog/products/:id", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json({ product: await getProduct(String(req.params.id)) }); } catch (error) { fail(req, res, error); }
});
router.put("/billing/hq/catalog/order", requireHqPermission("settings_manage"), async (req, res) => {
  const parsed = OrderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Check the product order." }); return; }
  try {
    const products = await reorderProducts(parsed.data.ids, actor(res));
    await audit(req, res, "billing_prices_updated", "billing_catalog", null, { products_changed: products.length });
    res.json({ products });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/catalog/products/:id/status", requireHqPermission("settings_manage"), async (req, res) => {
  const parsed = StatusSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose a valid status.", field: "status" }); return; }
  try {
    const product = await setProductStatus(String(req.params.id), parsed.data.status, actor(res));
    const action = parsed.data.status === "retired" || parsed.data.status === "archived" ? "billing_product_archived" : "billing_product_updated";
    await audit(req, res, action, "billing_product", product.id, { product_id: product.id });
    res.json({ product });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/catalog/products/:id/images/upload-url", requireHqPermission("settings_manage"), async (req, res) => {
  const parsed = ImageUploadSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Check the image file.", field: "image" }); return; }
  try { res.json(await productImageUploadUrl(String(req.params.id), parsed.data, actor(res))); } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/catalog/products/:id/images", requireHqPermission("settings_manage"), async (req, res) => {
  const parsed = ImageFinalizeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Check the image file.", field: "image" }); return; }
  try {
    const product = await finalizeProductImage(String(req.params.id), parsed.data, actor(res));
    await audit(req, res, "billing_product_updated", "billing_product", product.id, { product_id: product.id });
    res.status(201).json({ product });
  } catch (error) { fail(req, res, error); }
});
router.delete("/billing/hq/catalog/products/:id/images/:imageId", requireHqPermission("settings_manage"), async (req, res) => {
  try {
    const product = await removeProductImage(String(req.params.id), String(req.params.imageId), actor(res));
    await audit(req, res, "billing_product_updated", "billing_product", product.id, { product_id: product.id });
    res.json({ product });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/catalog/products/:id/images/:imageId/default", requireHqPermission("settings_manage"), async (req, res) => {
  try {
    const product = await setDefaultProductImage(String(req.params.id), String(req.params.imageId), actor(res));
    await audit(req, res, "billing_product_updated", "billing_product", product.id, { product_id: product.id });
    res.json({ product });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/catalog/products/:id/retire", requireHqPermission("settings_manage"), async (req, res) => {
  try {
    const product = await setProductActive(String(req.params.id), false, actor(res));
    await audit(req, res, "billing_product_archived", "billing_product", product.id, { product_id: product.id });
    res.json({ product });
  } catch (error) { fail(req, res, error); }
});
router.post("/billing/hq/catalog/products/:id/reactivate", requireHqPermission("settings_manage"), async (req, res) => {
  try {
    const product = await setProductActive(String(req.params.id), true, actor(res));
    await audit(req, res, "billing_product_updated", "billing_product", product.id, { product_id: product.id });
    res.json({ product });
  } catch (error) { fail(req, res, error); }
});
router.put("/billing/hq/catalog/settings", requireHqPermission("settings_manage"), async (req, res) => {
  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Check the billing settings.", field: String(parsed.error.issues[0]?.path[0] ?? "") }); return; }
  try {
    const settings = await updateSettings(parsed.data, actor(res));
    await audit(req, res, "billing_settings_updated", "billing_settings", "1", { keys_changed: 4 });
    res.json({ settings });
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/catalog/changes", requireHqPermission("financial_read"), async (req, res) => {
  try { res.json({ items: await listCatalogChanges(), next_cursor: null }); } catch (error) { fail(req, res, error); }
});

type Provider = { provider_id: string; office_name: string | null; provider_name: string | null; email?: string | null; phone?: string | null };
async function providers(): Promise<Provider[]> {
  const result = await supabaseAdmin("GET", "/rest/v1/providers?select=provider_id,office_name,provider_name,email,phone&access_disabled=neq.true&limit=1000");
  if (result.status >= 300) throw new Error("provider list failed");
  return Array.isArray(result.json) ? result.json : [];
}
router.get("/billing/hq/providers", requireHqPermission("financial_read"), async (req, res) => {
  try {
    const [offices, accounts, prices, orders, catalog] = await Promise.all([
      providers(), selectMany("billing_connected_accounts"), selectMany("billing_office_prices"),
      selectMany("billing_orders", `created_at=gte.${encodeURIComponent(new Date(Date.now() - 30 * 86400_000).toISOString())}`),
      listCatalog(),
    ]);
    res.json(offices.map((office) => {
      const ownOrders = orders.filter((order) => order.provider_id === office.provider_id);
      return {
        provider_id: office.provider_id, office_name: office.office_name ?? office.provider_name ?? "Office",
        provider_name: office.provider_name ?? office.office_name ?? "Provider",
        account: (() => { const row = accounts.find((a) => a.provider_id === office.provider_id); return row ? toConnectedAccount(row) : null; })(),
        offered_products: prices.filter((price) => price.provider_id === office.provider_id).length,
        orders_30d: ownOrders.length,
        collected_30d_cents: ownOrders.filter((order) => order.status === "paid").reduce((sum, order) => sum + order.total_cents, 0),
        fees_30d_cents: ownOrders.filter((order) => order.status === "paid").reduce((sum, order) => sum + order.application_fee_cents, 0),
        below_minimum_count: catalog.products.reduce((sum, product) => sum +
          prices.filter((price) => price.provider_id === office.provider_id && price.product_id === product.id &&
            price.sell_price_cents < product.break_even_minimum_cents).length, 0),
      };
    }));
  } catch (error) { fail(req, res, error); }
});
router.get("/billing/hq/providers/:provider_id", requireHqPermission("financial_read"), async (req, res) => {
  try {
    const providerId = String(req.params.provider_id);
    const office = (await providers()).find((row) => row.provider_id === providerId);
    if (!office) { res.status(404).json({ error: "Office not found." }); return; }
    const [account, events, prices, subscriptions, payouts, links, activity, recentRows] = await Promise.all([
      selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`),
      selectMany("billing_account_events", `provider_id=eq.${encodeURIComponent(providerId)}&order=created_at.desc`),
      listOfficePrices(providerId),
      selectMany("billing_subscriptions", `provider_id=eq.${encodeURIComponent(providerId)}`),
      selectMany("billing_payouts", `provider_id=eq.${encodeURIComponent(providerId)}&order=created_at.desc&limit=20`),
      selectMany("billing_payment_links", `provider_id=eq.${encodeURIComponent(providerId)}&active=eq.true&select=id`),
      officeDashboard(providerId, {}),
      selectMany("billing_orders", `provider_id=eq.${encodeURIComponent(providerId)}&order=created_at.desc,id.desc&limit=10`),
    ]);
    // Two bulk reads for the whole page rather than a bundle per order; the
    // office row is already in hand.
    const inList = (values: string[]) => `in.(${[...new Set(values)].map((value) => `"${value.replace(/"/g, "")}"`).join(",")})`;
    const [items, payers] = recentRows.length === 0 ? [[], []] : await Promise.all([
      selectMany("billing_order_items", `order_id=${inList(recentRows.map((row) => row.id))}&order=created_at.asc`),
      selectMany("billing_payers", `id=${inList(recentRows.map((row) => row.payer_id))}`),
    ]);
    const payerById = new Map(payers.map((row) => [row.id, row]));
    const recentOrders = recentRows.map((row) => {
      const payer = payerById.get(row.payer_id);
      if (!payer) throw new Error("Order details are incomplete.");
      return toOrderSummary(row, items.filter((item) => item.order_id === row.id), payer, office.office_name?.trim() || office.provider_name?.trim() || "Office");
    });
    res.json({
      office: { provider_id: providerId, office_name: office.office_name ?? office.provider_name ?? "Office",
        provider_name: office.provider_name ?? office.office_name ?? "Provider", email: office.email ?? null, phone: office.phone ?? null },
      account: account ? toConnectedAccount(account) : null, events, prices: prices.products,
      subscriptions: {
        active: subscriptions.filter((row) => row.status === "active").length,
        past_due: subscriptions.filter((row) => row.status === "past_due").length,
        canceled: subscriptions.filter((row) => row.status === "canceled").length,
      },
      activity_30d: {
        collected_cents: activity.collected_cents, thinnr_fee_cents: activity.thinnr_fee_cents,
        refunded_cents: activity.refunded_cents, net_cents: activity.net_cents,
        orders: activity.orders, to_ship: activity.to_ship,
      },
      recent_orders: recentOrders, payouts: payouts.map((row) => ({
        id: row.id, stripe_payout_id: row.stripe_payout_id, amount_cents: row.amount_cents,
        status: row.status, arrival_date: row.arrival_date, method: row.method, created_at: row.created_at,
      })), links: links.length,
    });
  } catch (error) { fail(req, res, error); }
});
export default router;