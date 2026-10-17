/**
 * App-access subscriptions: a patient's recurring payment to their office for
 * the app's premium AI features.
 *
 * These ride the SAME billing_subscriptions / billing_orders tables as product
 * replenishments (so Stripe webhooks, the patient's subscriptions list, the
 * cancel route, dunning and office reporting all keep working) but with
 * kind 'app_access': nothing ships (fulfillment 'not_required' keeps the
 * shipment + warehouse triggers out), there is no floor price, and THINNR's
 * share is a flat percent of the charge snapshotted on every order.
 *
 * The subscription is created on the office's CONNECTED account with
 * `default_incomplete`, exactly like a product subscription: the public
 * checkout page confirms the first invoice's PaymentIntent with Stripe
 * Elements and the invoice.paid webhook marks the order paid.
 */
import crypto from "node:crypto";
import { logger } from "../../lib/logger";
import { ensureCustomer } from "../customers";
import { APP_ACCESS_THINNR_SHARE_PERCENT, appAccessThinnrShare, applicationFeePercentFor, hqProfit } from "../fees";
import { resolvePatientPayer } from "../links";
import { connectedOpts, getPublishableKey, getStripe, isSandbox, isStripeMissing } from "../stripe-client";
import { insert, selectMany, selectOne, update, type BillingSubscriptionRow } from "../store";
import { getProvider, officeName } from "../store-orders";
import { accountFor, BillingSubscriptionError, periodEnd } from "../subscriptions";
import { APP_ACCESS_PRODUCT_ID, APP_ACCESS_PRODUCT_NAME, isAppAccessSubscription } from "./catalog";
import type { AppAccessSubscriptionFacts } from "./entitlement";
import { cadenceLabel, cadenceWeeks, ensureAppAccessPrice, getOfficeAppAccessSettings } from "./settings";

const enc = encodeURIComponent;
const OPEN_STATUSES = ["incomplete", "active", "past_due", "unpaid"];

export { isAppAccessSubscription };

function orderNumber(): string {
  return `TH-${crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "A").slice(0, 6).toUpperCase()}`;
}

/**
 * The subscription that governs a patient's access today: an open one wins;
 * otherwise the most recently created (a cancelled row still covers its paid
 * period). Null when the patient never started one. Rows are read under the
 * current billing identity, like every Stripe-derived row.
 */
export async function findAppAccessSubscription(patientId: string): Promise<BillingSubscriptionRow | null> {
  const rows = await selectMany("billing_subscriptions",
    `patient_id=eq.${enc(patientId)}&kind=eq.app_access&order=created_at.desc&limit=20`);
  const open = rows.find((row) => OPEN_STATUSES.includes(row.status) && row.status !== "incomplete");
  return open ?? rows.find((row) => row.status !== "incomplete") ?? null;
}

/** Any open row (an unpaid first attempt included) — the one the unique index guards. */
export async function openAppAccessSubscription(patientId: string): Promise<BillingSubscriptionRow | null> {
  const rows = await selectMany("billing_subscriptions",
    `patient_id=eq.${enc(patientId)}&kind=eq.app_access&status=in.(${OPEN_STATUSES.join(",")})&order=created_at.desc&limit=5`);
  return rows.find((row) => row.status !== "incomplete") ?? rows[0] ?? null;
}

export function subscriptionFacts(row: BillingSubscriptionRow | null): AppAccessSubscriptionFacts | null {
  if (!row) return null;
  return { status: row.status, current_period_end: row.current_period_end, cancel_at_period_end: row.cancel_at_period_end };
}

export interface AppAccessCheckoutResponse {
  order_id: string;
  order_number: string;
  client_secret: string;
  stripe_account_id: string;
  publishable_key: string;
  sandbox: boolean;
  price_cents: number;
  cadence: "2_weeks" | "monthly";
  cadence_label: string;
  renews_on: string;
  office_name: string;
}

/** What the public checkout page shows before the patient pays. */
export interface AppAccessCheckoutPreview {
  office_name: string;
  price_cents: number;
  cadence: "2_weeks" | "monthly";
  cadence_label: string;
  /** The patient already has an open subscription: the page offers nothing to buy. */
  already_subscribed: boolean;
  sandbox: boolean;
}

export async function appAccessCheckoutPreview(input: { patientId: string; providerId: string }): Promise<AppAccessCheckoutPreview> {
  const [settings, office, existing] = await Promise.all([
    getOfficeAppAccessSettings(input.providerId), getProvider(input.providerId), openAppAccessSubscription(input.patientId),
  ]);
  if (!settings.enabled || settings.price_cents === null) throw new BillingSubscriptionError("This office does not charge for the app.", 409);
  if (!office) throw new BillingSubscriptionError("Office not found.", 404);
  return {
    office_name: officeName(office), price_cents: settings.price_cents, cadence: settings.cadence,
    cadence_label: cadenceLabel(settings.cadence),
    already_subscribed: Boolean(existing && existing.status !== "incomplete"),
    sandbox: await isSandbox(),
  };
}

async function cancelStripeSubscriptionQuietly(stripeSubscriptionId: string, stripeAccountId: string, subscriptionId: string): Promise<void> {
  try {
    const stripe = await getStripe();
    await stripe.subscriptions.cancel(stripeSubscriptionId, {}, connectedOpts(stripeAccountId));
  } catch (error) {
    if (isStripeMissing(error)) return;
    logger.error({ err: error, subscriptionId, stripeSubscriptionId }, "app access subscription cancel failed");
    throw error;
  }
}

/**
 * Release the slot an unpaid earlier attempt still holds. The Stripe
 * subscription is cancelled first — that voids its open invoice, so a payment
 * sheet left open in another tab can no longer start a SECOND recurring
 * charge — and only then is the local row closed. If Stripe shows the earlier
 * attempt already paid (its webhook simply has not landed yet), nothing is
 * touched and the patient is told they already subscribe.
 */
async function retireIncompleteAttempt(existing: BillingSubscriptionRow, stripeAccountId: string): Promise<void> {
  if (existing.stripe_subscription_id) {
    const stripe = await getStripe();
    let remote: { status?: string } | null = null;
    try {
      remote = await stripe.subscriptions.retrieve(existing.stripe_subscription_id, {}, connectedOpts(stripeAccountId));
    } catch (error) {
      if (!isStripeMissing(error)) throw error;
    }
    if (remote && remote.status !== "incomplete" && remote.status !== "incomplete_expired" && remote.status !== "canceled") {
      throw new BillingSubscriptionError("You already have an app subscription.", 409);
    }
    if (remote && remote.status === "incomplete") {
      await cancelStripeSubscriptionQuietly(existing.stripe_subscription_id, stripeAccountId, existing.id);
    }
  }
  const canceledAt = new Date().toISOString();
  await update("billing_subscriptions", `id=eq.${enc(existing.id)}&status=eq.incomplete`, { status: "canceled", canceled_at: canceledAt });
  await update("billing_orders", `subscription_id=eq.${enc(existing.id)}&kind=eq.subscription_initial&status=eq.pending`, { status: "canceled" });
}

/**
 * Start the patient's app-access subscription on the office's connected
 * account at the office's CURRENT price. A patient with an open subscription
 * is refused (the DB's partial unique index is the last line of defence).
 */
export async function createAppAccessSubscription(input: { patientId: string; providerId: string }): Promise<AppAccessCheckoutResponse> {
  const settings = await getOfficeAppAccessSettings(input.providerId);
  if (!settings.enabled || settings.price_cents === null) throw new BillingSubscriptionError("This office does not charge for the app.", 409);
  const existing = await openAppAccessSubscription(input.patientId);
  if (existing && existing.status !== "incomplete") {
    throw new BillingSubscriptionError("You already have an app subscription.", 409);
  }
  const [payer, account, office] = await Promise.all([
    resolvePatientPayer(input.providerId, input.patientId), accountFor(input.providerId), getProvider(input.providerId),
  ]);
  if (!office) throw new BillingSubscriptionError("Office not found.", 404);
  const price = settings.price_cents;
  const share = appAccessThinnrShare(price);
  const subscriptionId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const number = orderNumber();
  const livemode = !await isSandbox();
  // An earlier attempt that never paid blocks the unique index: retire it on
  // Stripe FIRST (so its payment sheet can no longer be completed), then here.
  if (existing?.status === "incomplete") await retireIncompleteAttempt(existing, account.stripe_account_id);
  await insert("billing_subscriptions", {
    id: subscriptionId, provider_id: input.providerId, payer_id: payer.id, patient_id: input.patientId,
    product_id: APP_ACCESS_PRODUCT_ID, kind: "app_access", stripe_subscription_id: null, stripe_customer_id: null,
    status: "incomplete", unit_price_cents: price, shipping_charge_cents: 0, shipping_cost_cents: 0,
    application_fee_cents: share, shipping_address: {}, current_period_end: null, next_shipment_at: null,
    cadence_weeks: cadenceWeeks(settings.cadence), quantity: 1,
    cancel_at_period_end: false, canceled_at: null, cancel_token: crypto.randomBytes(24).toString("base64url"), livemode,
  });
  await insert("billing_orders", {
    id: orderId, order_number: number, provider_id: input.providerId, payer_id: payer.id,
    patient_id: input.patientId, link_id: null, kind: "subscription_initial", subscription_id: subscriptionId,
    status: "pending", currency: "usd", subtotal_cents: price, shipping_charge_cents: 0, tax_cents: 0,
    total_cents: price, application_fee_cents: share, application_fee_collected_cents: null, stripe_fee_cents: null,
    office_net_cents: null, hard_cost_cents: 0, shipping_cost_cents: 0, hq_profit_cents: hqProfit(share, 0, 0),
    thinnr_share_percent: APP_ACCESS_THINNR_SHARE_PERCENT, shipping_address: {},
    stripe_invoice_id: null, stripe_payment_intent_id: null, livemode,
    fulfillment_status: "not_required", metadata: { app_access: { cadence: settings.cadence } },
  });
  await insert("billing_order_items", {
    order_id: orderId, product_id: APP_ACCESS_PRODUCT_ID, product_name_snapshot: APP_ACCESS_PRODUCT_NAME, quantity: 1,
    unit_price_cents: price, floor_price_cents_snapshot: 0, thinnr_share_cents: share, hard_cost_cents_snapshot: 0,
  });
  let stripeSubscription: any;
  let invoice: any;
  let intent: any;
  let customerId: string;
  try {
    const mirrored = await ensureAppAccessPrice(input.providerId, { price_cents: price, cadence: settings.cadence });
    if (!mirrored.stripe_price_id) throw new Error("App access pricing is unavailable.");
    customerId = await ensureCustomer(payer, null, account);
    const stripe = await getStripe();
    stripeSubscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: mirrored.stripe_price_id }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      application_fee_percent: applicationFeePercentFor(share, price),
      metadata: { thinnr_subscription_id: subscriptionId, thinnr_order_id: orderId, thinnr_kind: "app_access" },
    } as any, connectedOpts(account.stripe_account_id, `subscription:${subscriptionId}`));
    const latestInvoiceId = typeof stripeSubscription.latest_invoice === "string"
      ? stripeSubscription.latest_invoice : stripeSubscription.latest_invoice?.id;
    if (!latestInvoiceId) throw new Error("Subscription has no first invoice.");
    invoice = await stripe.invoices.retrieve(latestInvoiceId, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(account.stripe_account_id));
    const value = invoice.payment_intent ?? invoice.payments?.data?.[0]?.payment?.payment_intent;
    intent = typeof value === "string" ? { id: value } : value;
    if (!invoice?.id || !intent?.id || !intent.client_secret) throw new Error("Subscription payment could not be initialized.");
  } catch (error) {
    logger.error({ err: error, orderId, subscriptionId }, "app access subscription initialization failed");
    // A Stripe subscription that was created but never handed to the patient
    // must not stay payable (its first invoice would be settled blind).
    if (stripeSubscription?.id) await cancelStripeSubscriptionQuietly(stripeSubscription.id, account.stripe_account_id, subscriptionId);
    await update("billing_orders", `id=eq.${enc(orderId)}`, {
      status: "failed", metadata: { app_access: { cadence: settings.cadence }, error: error instanceof Error ? error.message.slice(0, 500) : "Stripe error" },
    });
    await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}&status=eq.incomplete`, { status: "canceled", canceled_at: new Date().toISOString() });
    throw new BillingSubscriptionError("Subscription could not be initialized. Please try again.", 502);
  }
  const renews = periodEnd(stripeSubscription) ?? new Date(Date.now() + (settings.cadence === "2_weeks" ? 14 : 30) * 86400_000).toISOString();
  await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}`, {
    stripe_subscription_id: stripeSubscription.id, stripe_customer_id: customerId!, current_period_end: renews, next_shipment_at: null,
  });
  await update("billing_orders", `id=eq.${enc(orderId)}`, {
    stripe_invoice_id: invoice.id, stripe_payment_intent_id: intent.id, total_cents: Number(invoice.total ?? price),
  });
  return {
    order_id: orderId, order_number: number, client_secret: intent.client_secret, stripe_account_id: account.stripe_account_id,
    publishable_key: await getPublishableKey(), sandbox: !livemode, price_cents: price, cadence: settings.cadence,
    cadence_label: cadenceLabel(settings.cadence), renews_on: renews, office_name: officeName(office),
  };
}

/** The paid state of the first order (the checkout "done" page polls this). */
export async function appAccessOrderStatus(orderId: string, patientId: string): Promise<{ status: string; subscription_status: string | null }> {
  const order = await selectOne("billing_orders", `id=eq.${enc(orderId)}&patient_id=eq.${enc(patientId)}`);
  if (!order) throw new BillingSubscriptionError("Order not found.", 404);
  const sub = order.subscription_id ? await selectOne("billing_subscriptions", `id=eq.${enc(order.subscription_id)}`) : null;
  return { status: order.status, subscription_status: sub?.status ?? null };
}
