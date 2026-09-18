import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { addCard, BillingCardError, cardSetup, listCards, patientCustomer, removeCard, setDefaultCard } from "../billing/cards";
import { BillingCartError, checkoutCart, estimateCartTax, MAX_CART_LINES, MAX_LINE_QUANTITY, planCart, withTaxEstimate } from "../billing/cart";
import { BillingCatalogError, officeOffering, subscribeSavePercent } from "../billing/catalog";
import { BillingOrderError } from "../billing/orders";
import {
  changeSubscriptionAddress, changeSubscriptionPlan, moveNextShipment, parseMoveDate, skipNextShipment,
  subscriptionCard, updateSubscriptionCard,
} from "../billing/patient-subscriptions";
import { BillingPriceError } from "../billing/prices";
import { shipmentsForOrders } from "../billing/shipments";
import { getPublishableKey, isSandbox } from "../billing/stripe-client";
import {
  BillingStoreError, cursorFilter, encodeCursor, pagination, selectMany, selectOne, type BillingConnectedAccountRow,
  type BillingOrderItemRow, type BillingRefundRow, type BillingSubscriptionRow,
} from "../billing/store";
import { BillingSubscriptionError, pauseSubscription, resumeSubscription, retrySubscriptionPayment } from "../billing/subscriptions";
import type {
  PatientOrderDetail, PatientOrderList, PatientShop, PatientSubscriptionDetail, ShippingAddress,
} from "../billing/types";
import { supabaseAdmin } from "../lib/supabase-admin";
import { list, orderDto, patientContext, subscriptionDto } from "./patient-billing";

/**
 * In-app shop for a signed-in patient: storefront, cart quote + checkout,
 * saved cards, order history, and subscription self-service. Identity always
 * comes from the bearer session; every read and write is filtered by the
 * patient's own id (and office), never by a client-supplied id.
 */
const router: IRouter = Router();
const enc = encodeURIComponent;
const uuid = z.string().uuid();
type Ctx = NonNullable<Awaited<ReturnType<typeof patientContext>>>;

const AddressSchema = z.object({
  name: z.string().trim().min(1), line1: z.string().trim().min(1), line2: z.string().trim().nullable(),
  city: z.string().trim().min(1), state: z.string().trim().min(1), postal_code: z.string().trim().min(3),
  country: z.string().trim().length(2), phone: z.string().trim().nullable(),
});
const LineSchema = z.object({
  product_id: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  purchase: z.enum(["one_time", "subscription"]), cadence_weeks: z.number().int().nullable().optional(),
});
const QuoteSchema = z.object({
  lines: z.array(LineSchema).min(1).max(MAX_CART_LINES), shipping_address: AddressSchema.optional(),
  shipping_method: z.enum(["standard", "expedited"]).optional(),
});
const CheckoutSchema = QuoteSchema.extend({
  shipping_address: AddressSchema, payment_method_id: z.string().trim().min(1).max(200), set_default: z.boolean().optional(),
  expected_total_due_cents: z.number().int().min(0),
});
const CardAddSchema = z.object({ payment_method_id: z.string().trim().min(1).max(200), set_default: z.boolean().optional() });
const MoveSchema = z.object({ next_shipment_at: z.string().trim().min(8).max(40) });
const AddressBodySchema = z.object({ shipping_address: AddressSchema });
const PlanSchema = z.object({
  cadence_weeks: z.number().int().optional(), quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY).optional(),
}).refine((value) => value.cadence_weeks !== undefined || value.quantity !== undefined, { message: "Choose a cadence or quantity." });
const CardBodySchema = z.object({ payment_method_id: z.string().trim().min(1).max(200) });
const RetryBodySchema = z.object({ payment_method_id: z.string().trim().min(1).max(200).optional() });

function fail(req: Request, res: Response, error: unknown): void {
  if (error instanceof BillingCartError || error instanceof BillingCardError || error instanceof BillingSubscriptionError
    || error instanceof BillingOrderError || error instanceof BillingCatalogError || error instanceof BillingPriceError
    || error instanceof BillingStoreError) {
    const status = (error as { status?: number }).status ?? 400;
    const field = (error as { field?: string }).field;
    res.status(status).json({ error: error.message, ...(field ? { field } : {}) });
    return;
  }
  req.log?.error({ err: error }, "patient shop request failed");
  res.status(503).json({ error: "The shop is unavailable right now." });
}

async function liveAccount(providerId: string): Promise<BillingConnectedAccountRow | null> {
  const account = await selectOne("billing_connected_accounts", `provider_id=eq.${enc(providerId)}&disconnected_at=is.null`);
  return account?.charges_enabled ? account : null;
}
async function requireAccount(ctx: Ctx, res: Response): Promise<BillingConnectedAccountRow | null> {
  const account = await liveAccount(ctx.providerId);
  if (!account) res.status(409).json({ error: "Your office is not set up to take payments in the app yet." });
  return account;
}
async function officeSummary(providerId: string) {
  const result = await supabaseAdmin("GET", `/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=provider_id,office_name,provider_name&limit=1`);
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error("Could not load office.");
  return result.json[0] as { provider_id: string; office_name?: string | null; provider_name?: string | null } | undefined;
}
async function lastAddress(ctx: Ctx): Promise<ShippingAddress | null> {
  const order = await selectOne("billing_orders", `patient_id=eq.${enc(ctx.patientId)}&provider_id=eq.${enc(ctx.providerId)}&order=created_at.desc`);
  return (order?.shipping_address as unknown as ShippingAddress | undefined) ?? null;
}
async function ownedSubscription(ctx: Ctx, id: string): Promise<BillingSubscriptionRow | null> {
  if (!uuid.safeParse(id).success) return null;
  return selectOne("billing_subscriptions", `id=eq.${enc(id)}&patient_id=eq.${enc(ctx.patientId)}&provider_id=eq.${enc(ctx.providerId)}`);
}
async function productName(productId: string): Promise<string> {
  return (await selectOne("billing_products", `id=eq.${enc(productId)}`))?.name ?? "Subscription";
}

/* ---------------------------------- shop --------------------------------- */

router.get("/patient-data/billing/shop", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const [provider, account, settings, offering, address] = await Promise.all([
      officeSummary(ctx.providerId), liveAccount(ctx.providerId), selectOne("billing_settings", "id=eq.1"),
      officeOffering(ctx.providerId), lastAddress(ctx),
    ]);
    if (!settings) throw new Error("Billing settings are unavailable.");
    const reason: PatientShop["unavailable_reason"] = !account ? "not_connected" : offering.length === 0 ? "no_products" : null;
    const available = reason === null;
    const body: PatientShop = {
      office: provider ? {
        provider_id: provider.provider_id,
        office_name: provider.office_name?.trim() || provider.provider_name?.trim() || "Office",
        payments_available: available,
      } : null,
      available, unavailable_reason: reason,
      // The offering rides along even when ordering is closed so a product
      // page (e.g. from a coach card) can still open informationally; the
      // client hides every buy control while `available` is false.
      products: offering,
      shipping_charge_cents: settings.shipping_charge_cents,
      subscribe_save_percent: subscribeSavePercent(settings),
      default_address: address,
      stripe_account_id: available ? account!.stripe_account_id : null,
      publishable_key: available ? await getPublishableKey() : null,
      sandbox: await isSandbox(),
      tax_enabled: !!account?.tax_enabled,
    };
    res.json(body);
  } catch (error) { fail(req, res, error); }
});

/* ---------------------------------- cart --------------------------------- */

router.post("/patient-data/billing/cart/quote", async (req, res) => {
  const parsed = QuoteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Check the items in your cart.", field: "lines" }); return; }
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const account = await requireAccount(ctx, res);
    if (!account) return;
    // With an address the quote carries the tax the card will actually be
    // charged and the live shipping options; without one a tax-collecting
    // office's total stays "before tax" and shipping shows the flat charge.
    const address = parsed.data.shipping_address;
    const plan = await planCart(ctx.providerId, parsed.data.lines, account.tax_enabled, {
      address: address ?? null, method: parsed.data.shipping_method ?? "standard",
    });
    res.json(address ? withTaxEstimate(plan.quote, await estimateCartTax(account, plan, address)) : plan.quote);
  } catch (error) { fail(req, res, error); }
});

function cartIdFrom(req: Request): string | null {
  const header = req.get("idempotency-key");
  const body = (req.body as { cart_id?: unknown } | undefined)?.cart_id;
  const candidate = typeof header === "string" && header ? header : typeof body === "string" ? body : "";
  if (!candidate) return null;
  if (uuid.safeParse(candidate).success) return candidate.toLowerCase();
  // Any opaque client key becomes a stable UUID so the cart column stays typed.
  const digest = crypto.createHash("sha256").update(candidate).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

router.post("/patient-data/billing/cart/checkout", async (req, res) => {
  const parsed = CheckoutSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: "Check your cart, shipping address, and card.", field: String(issue?.path?.[0] ?? "lines") });
    return;
  }
  const cartId = cartIdFrom(req);
  if (!cartId) { res.status(400).json({ error: "Checkout needs an Idempotency-Key.", field: "idempotency_key" }); return; }
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    // No live-account gate here: checkoutCart resolves an existing cart key first so a
    // replay or resume still works after the office disconnects; fresh carts are gated inside.
    const result = await checkoutCart({
      patientId: ctx.patientId, providerId: ctx.providerId, cartId, lines: parsed.data.lines,
      shipping_address: parsed.data.shipping_address, payment_method_id: parsed.data.payment_method_id,
      shipping_method: parsed.data.shipping_method ?? "standard",
      set_default: parsed.data.set_default, expected_total_due_cents: parsed.data.expected_total_due_cents,
    });
    res.status(result.status === "failed" ? 402 : 200).json(result);
  } catch (error) { fail(req, res, error); }
});

/* --------------------------------- cards --------------------------------- */

router.get("/patient-data/billing/cards", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const account = await requireAccount(ctx, res);
    if (!account) return;
    const { customerId } = await patientCustomer(ctx.patientId, ctx.providerId, account);
    res.json(await listCards(customerId, account));
  } catch (error) { fail(req, res, error); }
});

router.post("/patient-data/billing/cards/setup", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const account = await requireAccount(ctx, res);
    if (!account) return;
    const { customerId } = await patientCustomer(ctx.patientId, ctx.providerId, account);
    res.json(await cardSetup(customerId, account, req.get("idempotency-key") || crypto.randomUUID()));
  } catch (error) { fail(req, res, error); }
});

router.post("/patient-data/billing/cards", async (req, res) => {
  const parsed = CardAddSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "A card is required.", field: "payment_method_id" }); return; }
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const account = await requireAccount(ctx, res);
    if (!account) return;
    const { customerId } = await patientCustomer(ctx.patientId, ctx.providerId, account);
    res.json(await addCard(customerId, account, parsed.data.payment_method_id, parsed.data.set_default ?? false));
  } catch (error) { fail(req, res, error); }
});

router.post("/patient-data/billing/cards/:id/default", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const account = await requireAccount(ctx, res);
    if (!account) return;
    const { customerId } = await patientCustomer(ctx.patientId, ctx.providerId, account);
    res.json(await setDefaultCard(customerId, account, String(req.params.id)));
  } catch (error) { fail(req, res, error); }
});

router.delete("/patient-data/billing/cards/:id", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const account = await requireAccount(ctx, res);
    if (!account) return;
    const { customerId } = await patientCustomer(ctx.patientId, ctx.providerId, account);
    res.json(await removeCard(ctx.patientId, customerId, account, String(req.params.id)));
  } catch (error) { fail(req, res, error); }
});

/* --------------------------------- orders -------------------------------- */

router.get("/patient-data/billing/orders", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const page = pagination(req.query);
    const filters = [`patient_id=eq.${enc(ctx.patientId)}`, `provider_id=eq.${enc(ctx.providerId)}`];
    if (page.cursor) filters.push(cursorFilter(page.cursor));
    const rows = await selectMany("billing_orders", `${filters.join("&")}&order=created_at.desc,id.desc&limit=${page.limit + 1}`);
    const visible = rows.slice(0, page.limit);
    const ids = visible.map((row) => row.id);
    const [items, refunds, shipments] = await Promise.all([
      ids.length ? selectMany("billing_order_items", `order_id=${list(ids)}`) : ([] as BillingOrderItemRow[]),
      ids.length ? selectMany("billing_refunds", `order_id=${list(ids)}&status=eq.succeeded`) : ([] as BillingRefundRow[]),
      shipmentsForOrders(ids),
    ]);
    const body: PatientOrderList = {
      items: visible.map((order) => orderDto(
        order, items.filter((item) => item.order_id === order.id),
        refunds.filter((refund) => refund.order_id === order.id), shipments.get(order.id) ?? null,
      )),
      next_cursor: rows.length > page.limit ? encodeCursor(visible[visible.length - 1] ?? null) : null,
    };
    res.json(body);
  } catch (error) { fail(req, res, error); }
});

router.get("/patient-data/billing/orders/:id", async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) { res.status(404).json({ error: "Order not found." }); return; }
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const order = await selectOne("billing_orders", `id=eq.${enc(String(req.params.id))}&patient_id=eq.${enc(ctx.patientId)}&provider_id=eq.${enc(ctx.providerId)}`);
    if (!order) { res.status(404).json({ error: "Order not found." }); return; }
    const [items, refunds, shipments] = await Promise.all([
      selectMany("billing_order_items", `order_id=eq.${enc(order.id)}`),
      selectMany("billing_refunds", `order_id=eq.${enc(order.id)}&status=eq.succeeded`),
      shipmentsForOrders([order.id]),
    ]);
    const body: PatientOrderDetail = {
      ...orderDto(order, items, refunds, shipments.get(order.id) ?? null),
      items: items.map((item) => ({
        product_id: item.product_id, name: item.product_name_snapshot, quantity: item.quantity,
        unit_price_cents: item.unit_price_cents, line_total_cents: item.unit_price_cents * item.quantity,
      })),
      subtotal_cents: order.subtotal_cents, shipping_charge_cents: order.shipping_charge_cents, tax_cents: order.tax_cents,
      refunds: refunds.map((refund) => ({ amount_cents: refund.amount_cents, status: refund.status, created_at: refund.created_at })),
      shipping_address: order.shipping_address as unknown as ShippingAddress,
      failure_message: order.failure_message ?? null,
    };
    res.json(body);
  } catch (error) { fail(req, res, error); }
});

/* ----------------------------- subscriptions ----------------------------- */

router.get("/patient-data/billing/subscriptions", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const rows = await selectMany("billing_subscriptions", `patient_id=eq.${enc(ctx.patientId)}&provider_id=eq.${enc(ctx.providerId)}&order=created_at.desc`);
    const items: PatientSubscriptionDetail[] = [];
    for (const row of rows) items.push(await detail(row));
    res.json({ items });
  } catch (error) { fail(req, res, error); }
});

async function detail(row: BillingSubscriptionRow): Promise<PatientSubscriptionDetail> {
  const [product, account] = await Promise.all([
    selectOne("billing_products", `id=eq.${enc(row.product_id)}`),
    selectOne("billing_connected_accounts", `provider_id=eq.${enc(row.provider_id)}`),
  ]);
  const card = account ? await subscriptionCard(row, account).catch(() => null) : null;
  return {
    ...subscriptionDto(row, product?.name ?? "Subscription"), card,
    offered_cadences_weeks: product?.offered_cadences_weeks ?? [4],
  };
}

router.get("/patient-data/billing/subscriptions/:id", async (req, res) => {
  try {
    const ctx = await patientContext(req, res);
    if (!ctx) return;
    const row = await ownedSubscription(ctx, String(req.params.id));
    if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
    res.json(await detail(row));
  } catch (error) { fail(req, res, error); }
});

type Action = (ctx: Ctx, row: BillingSubscriptionRow, body: unknown) => Promise<BillingSubscriptionRow>;
function action(name: string, run: Action): void {
  router.post(`/patient-data/billing/subscriptions/:id/${name}`, async (req, res) => {
    try {
      const ctx = await patientContext(req, res);
      if (!ctx) return;
      const row = await ownedSubscription(ctx, String(req.params.id));
      if (!row) { res.status(404).json({ error: "Subscription not found." }); return; }
      const updated = await run(ctx, row, req.body);
      res.json(subscriptionDto(updated, await productName(updated.product_id)));
    } catch (error) { fail(req, res, error); }
  });
}

action("move-next", async (_ctx, row, body) => {
  const parsed = MoveSchema.safeParse(body);
  if (!parsed.success) throw new BillingSubscriptionError("Choose a date.", 400, "next_shipment_at");
  return moveNextShipment(row, parseMoveDate(parsed.data.next_shipment_at));
});
action("skip-next", async (_ctx, row) => skipNextShipment(row));
action("pause", async (_ctx, row) => pauseSubscription(row.id));
action("resume", async (_ctx, row) => resumeSubscription(row.id));
action("address", async (_ctx, row, body) => {
  const parsed = AddressBodySchema.safeParse(body);
  if (!parsed.success) throw new BillingSubscriptionError("Check the shipping address.", 400, "shipping_address");
  return changeSubscriptionAddress(row, parsed.data.shipping_address);
});
action("plan", async (_ctx, row, body) => {
  const parsed = PlanSchema.safeParse(body);
  if (!parsed.success) throw new BillingSubscriptionError("Choose a cadence or quantity.", 400, "cadence_weeks");
  return changeSubscriptionPlan(row, parsed.data);
});
async function setRenewalCard(ctx: Ctx, row: BillingSubscriptionRow, paymentMethodId: string): Promise<BillingSubscriptionRow> {
  const account = await liveAccount(ctx.providerId);
  if (!account) throw new BillingSubscriptionError("Your office is not set up to take payments in the app yet.", 409);
  const { customerId } = await patientCustomer(ctx.patientId, ctx.providerId, account);
  if (row.stripe_customer_id && row.stripe_customer_id !== customerId) {
    throw new BillingSubscriptionError("This subscription is billed to a different account.", 409);
  }
  return updateSubscriptionCard(row, customerId, paymentMethodId);
}
action("card", async (ctx, row, body) => {
  const parsed = CardBodySchema.safeParse(body);
  if (!parsed.success) throw new BillingSubscriptionError("A card is required.", 400, "payment_method_id");
  return setRenewalCard(ctx, row, parsed.data.payment_method_id);
});
/**
 * Failed renewal, retried by the patient: optionally point the subscription at
 * one of their saved cards first, then pay the open failed invoice. A decline
 * comes back as 402 with Stripe's reason; a missing failed invoice is 409.
 */
action("retry-payment", async (ctx, row, body) => {
  const parsed = RetryBodySchema.safeParse(body ?? {});
  if (!parsed.success) throw new BillingSubscriptionError("Choose a card.", 400, "payment_method_id");
  if (!row.last_failed_invoice_id) throw new BillingSubscriptionError("There is no failed payment to retry.", 409);
  const current = parsed.data.payment_method_id ? await setRenewalCard(ctx, row, parsed.data.payment_method_id) : row;
  return retrySubscriptionPayment(current.id);
});

export default router;
