import { notifySubscriptionEvent, notifySubscriptionStarted, planLabel } from "./customer-emails";
import crypto from "node:crypto";
import type Stripe from "stripe";
import { logger } from "../lib/logger";
import { applicationFeeOverCollection, applicationFeePercentFor, computeOrderFees, hqProfit } from "./fees";
import { getSettings } from "./catalog";
import { ensureCustomer } from "./customers";
import { resolvePayer, touchLinkUse } from "./links";
import { BillingOrderError, markOrderPaidFromInvoice, quoteOrder } from "./orders";
import { ensureRecurringPrices } from "./prices";
import { invoiceShippingLineAmount, quoteRenewalShipping, subscriptionThinnrShare } from "./renewal-shipping";
import { officeThinnrSharePercent } from "./office-share";
import { sendPaymentFailed } from "./receipts";
import { connectedOpts, getPublishableKey, getStripe, isSandbox } from "./stripe-client";
import {
  insert, insertIgnore, nowIso, selectMany, selectOne, shipmentColumns, shipmentTerms, update, type BillingConnectedAccountRow,
  type BillingPaymentLinkRow, type BillingSubscriptionRow,
} from "./store";
import { getOrderBundle, getProvider, officeName } from "./store-orders";
import type {
  PublicOrderResponse, PublicSubscription, ShippingAddress, SubscriptionChangeQuote, SubscriptionRow,
} from "./types";
import { onStripeEvent, type StripeEventContext } from "./webhooks";
import { notifySubscriptionPaymentFailed } from "./patient-notices";
import { isAppAccessSubscription } from "./app-access/catalog";
import { APP_ACCESS_THINNR_SHARE_PERCENT, appAccessThinnrShare } from "./fees";

export class BillingSubscriptionError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
function paymentIntent(invoice: any): any {
  const value = invoice.payment_intent ?? invoice.payments?.data?.[0]?.payment?.payment_intent;
  return typeof value === "string" ? { id: value } : value;
}
export function periodEnd(value: any): string | null {
  const seconds = value.current_period_end ?? value.items?.data?.[0]?.current_period_end;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}
/**
 * The next box ships when Stripe next bills: a pending trial_end (set by
 * skip / move-next) wins over the period end; a canceled subscription ships
 * nothing more. Paused rows keep their last known date for the resume view.
 */
export function nextShipmentAt(value: any, row?: { next_shipment_at?: string | null } | null): string | null {
  if (value.status === "canceled") return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof value.trial_end === "number" && value.trial_end > now) return new Date(value.trial_end * 1000).toISOString();
  return periodEnd(value) ?? row?.next_shipment_at ?? null;
}
function invoiceSubscriptionId(invoice: any): string | null {
  const value = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;
  return typeof value === "string" ? value : typeof value?.id === "string" ? value.id : null;
}
function invoiceHasPrice(invoice: any, priceId: string | null): boolean {
  if (!priceId) return false;
  return Boolean(invoice.lines?.data?.some((line: any) => {
    const value = line.price ?? line.pricing?.price_details?.price;
    return (typeof value === "string" ? value : value?.id) === priceId;
  }));
}
function failureMessage(value: any): string | null {
  const raw = value?.last_payment_error?.message ?? paymentIntent(value)?.last_payment_error?.message;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.replace(/\b(?:\d[ -]*?){12,19}\b/g, "[card number removed]").trim().slice(0, 200);
}
export async function accountFor(providerId: string): Promise<BillingConnectedAccountRow> {
  const account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}&disconnected_at=is.null`);
  if (!account?.charges_enabled) throw new BillingSubscriptionError("This office is not ready to accept payments.", 409);
  return account;
}
async function eventBelongsToProvider(providerId: string, ctx: StripeEventContext): Promise<boolean> {
  if (ctx.kind !== "connect" || !ctx.account) {
    logger.warn({ providerId, kind: ctx.kind }, "ignored non-connect subscription event");
    return false;
  }
  const account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`);
  const valid = account?.stripe_account_id === ctx.account;
  if (!valid) logger.warn({ providerId, account: ctx.account }, "ignored cross-account subscription event");
  return valid;
}
function orderNumber(): string {
  return `TH-${crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "A").slice(0, 6).toUpperCase()}`;
}

export async function createSubscriptionOrder(input: {
  link: BillingPaymentLinkRow; payerInput?: { name: string; email: string; phone: string };
  shipping_address: ShippingAddress; product_id: string;
}): Promise<PublicOrderResponse> {
  const quote = await quoteOrder(input.link, [{ product_id: input.product_id, quantity: 1 }], "subscription");
  const [payer, account] = await Promise.all([
    resolvePayer(input.link.provider_id, input.link, input.payerInput),
    accountFor(input.link.provider_id),
  ]);
  const subscriptionId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const number = orderNumber();
  await insert("billing_subscriptions", {
    id: subscriptionId, provider_id: input.link.provider_id, payer_id: payer.id, patient_id: payer.patient_id,
    product_id: input.product_id, stripe_subscription_id: null, stripe_customer_id: null,
    status: "incomplete", unit_price_cents: quote.lines[0].unit_price_cents,
    shipping_charge_cents: quote.shipping_charge_cents, shipping_cost_cents: quote.shipping_cost_cents,
    application_fee_cents: quote.application_fee_cents,
    shipping_address: input.shipping_address as unknown as Record<string, unknown>, current_period_end: null,
    cancel_at_period_end: false, canceled_at: null, cancel_token: crypto.randomBytes(24).toString("base64url"),
    livemode: !await isSandbox(),
  });
  await insert("billing_orders", {
    id: orderId, order_number: number, provider_id: input.link.provider_id, payer_id: payer.id,
    patient_id: payer.patient_id, link_id: input.link.id, kind: "subscription_initial", subscription_id: subscriptionId,
    status: "pending", currency: "usd", subtotal_cents: quote.subtotal_cents,
    shipping_charge_cents: quote.shipping_charge_cents, tax_cents: 0,
    total_cents: quote.total_cents, application_fee_cents: quote.application_fee_cents,
    application_fee_collected_cents: null, stripe_fee_cents: null, office_net_cents: null,
    hard_cost_cents: quote.hard_cost_cents, shipping_cost_cents: quote.shipping_cost_cents,
    hq_profit_cents: hqProfit(quote.application_fee_cents, quote.hard_cost_cents, quote.shipping_cost_cents),
    thinnr_share_percent: quote.share_percent,
    shipping_address: input.shipping_address as unknown as Record<string, unknown>,
    stripe_invoice_id: null, stripe_payment_intent_id: null, livemode: !await isSandbox(),
    fulfillment_status: "to_ship", metadata: { settings: quote.settings },
  });
  const line = quote.lines[0];
  await insert("billing_order_items", {
    order_id: orderId, product_id: line.product_id, product_name_snapshot: line.name, quantity: 1,
    unit_price_cents: line.unit_price_cents, floor_price_cents_snapshot: line.floor_price_cents,
    thinnr_share_cents: quote.thinnr_share_cents, hard_cost_cents_snapshot: line.hard_cost_cents,
  });
  let stripeSubscription: any;
  let invoice: any;
  let intent: any;
  let customerId: string;
  try {
    const mirrored = await ensureRecurringPrices(input.link.provider_id, input.product_id);
    if (!mirrored?.stripe_price_id || !mirrored.stripe_shipping_price_id) {
      throw new Error("Subscription pricing is unavailable.");
    }
    customerId = await ensureCustomer(payer, input.shipping_address, account);
    const stripe = await getStripe();
    stripeSubscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: mirrored.stripe_price_id }, { price: mirrored.stripe_shipping_price_id }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      application_fee_percent: applicationFeePercentFor(quote.application_fee_cents, quote.total_cents),
      automatic_tax: { enabled: account.tax_enabled },
      metadata: { thinnr_subscription_id: subscriptionId, thinnr_order_id: orderId },
    } as any, connectedOpts(account.stripe_account_id, `subscription:${subscriptionId}`));
    // Stripe caps expansion at 4 levels, so the PaymentIntent cannot be
    // expanded through subscription.latest_invoice; fetch the invoice itself.
    const latestInvoiceId = typeof stripeSubscription.latest_invoice === "string"
      ? stripeSubscription.latest_invoice : stripeSubscription.latest_invoice?.id;
    if (!latestInvoiceId) throw new Error("Subscription has no first invoice.");
    invoice = await stripe.invoices.retrieve(latestInvoiceId, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(account.stripe_account_id));
    intent = paymentIntent(invoice);
    if (!invoice?.id || !intent?.id || !intent.client_secret) throw new Error("Subscription payment could not be initialized.");
  } catch (error) {
    logger.error({ err: error, orderId, subscriptionId }, "billing subscription initialization failed");
    await update("billing_orders", `id=eq.${encodeURIComponent(orderId)}`, {
      status: "failed", metadata: { settings: quote.settings, error: error instanceof Error ? error.message.slice(0, 500) : "Stripe error" },
    });
    throw new BillingSubscriptionError("Subscription could not be initialized. Please try again.", 502);
  }
  const renews = periodEnd(stripeSubscription) ?? new Date(Date.now() + 28 * 86400_000).toISOString();
  await update("billing_subscriptions", `id=eq.${encodeURIComponent(subscriptionId)}`, {
    stripe_subscription_id: stripeSubscription.id, stripe_customer_id: customerId!, current_period_end: renews,
    next_shipment_at: renews,
  });
  const tax = Math.max(0, Number(invoice.total ?? quote.total_cents) - quote.total_cents);
  await update("billing_orders", `id=eq.${encodeURIComponent(orderId)}`, {
    stripe_invoice_id: invoice.id, stripe_payment_intent_id: intent.id,
    tax_cents: tax, total_cents: Number(invoice.total ?? quote.total_cents),
  });
  await touchLinkUse(input.link.id);
  return {
    order_id: orderId, order_number: number,
    client_secret: intent.client_secret, stripe_account_id: account.stripe_account_id,
    publishable_key: await getPublishableKey(), sandbox: await isSandbox(),
    totals: { subtotal_cents: quote.subtotal_cents, shipping_charge_cents: quote.shipping_charge_cents,
      tax_cents: tax, total_cents: Number(invoice.total ?? quote.total_cents) },
    subscription: { every_weeks: 4, renews_on: renews },
  };
}

async function renewalOrder(invoice: any, ctx: StripeEventContext): Promise<string | null> {
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  const subscription = stripeSubscriptionId
    ? await selectOne("billing_subscriptions", `stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}`) : null;
  if (!subscription) return null;
  if (!(await eventBelongsToProvider(subscription.provider_id, ctx))) return null;
  const existing = await selectOne("billing_orders", `stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`);
  if (existing) return existing.id;
  const product = await selectOne("billing_products", `id=eq.${encodeURIComponent(subscription.product_id)}`);
  if (!product) return null;
  const id = crypto.randomUUID();
  if (isAppAccessSubscription(subscription)) return appAccessRenewalOrder(id, subscription, product, invoice);
  // In-app plans ship N units per box; legacy link subscriptions are 1.
  const quantity = subscription.quantity ?? 1;
  const subtotal = subscription.unit_price_cents * quantity;
  const hard = product.hard_cost_cents * quantity;
  const terms = shipmentTerms(subscription);
  const fulfillmentFee = terms.pick_pack_fee_cents + terms.packaging_cents;
  // The share as it stands for this renewal: an office restricted since the
  // subscription began pays the elevated share from this charge forward.
  const sharePercent = await officeThinnrSharePercent(subscription.provider_id);
  const share = await subscriptionThinnrShare(subscription, sharePercent);
  const created = await insertIgnore("billing_orders", {
    id, order_number: orderNumber(), provider_id: subscription.provider_id, payer_id: subscription.payer_id,
    patient_id: subscription.patient_id, link_id: null, kind: "subscription_renewal", subscription_id: subscription.id,
    status: "pending", currency: "usd", subtotal_cents: subtotal,
    shipping_charge_cents: subscription.shipping_charge_cents,
    tax_cents: Math.max(0, Number(invoice.total ?? 0) - subtotal - subscription.shipping_charge_cents),
    total_cents: Number(invoice.total ?? subtotal + subscription.shipping_charge_cents),
    application_fee_cents: subscription.application_fee_cents, application_fee_collected_cents: null,
    stripe_fee_cents: null, office_net_cents: null, hard_cost_cents: hard, shipping_cost_cents: subscription.shipping_cost_cents,
    hq_profit_cents: hqProfit(subscription.application_fee_cents, hard, subscription.shipping_cost_cents, fulfillmentFee),
    thinnr_share_percent: sharePercent,
    shipping_method: terms.shipping_method, shipping_source: terms.shipping_source, carrier_service_name: terms.carrier_service_name,
    pick_pack_fee_cents: terms.pick_pack_fee_cents, packaging_cents: terms.packaging_cents,
    pick_pack_passed_through: terms.pick_pack_passed_through,
    delivery_window_start: terms.delivery_window_start, delivery_window_end: terms.delivery_window_end,
    shipping_address: subscription.shipping_address, stripe_invoice_id: invoice.id,
    stripe_payment_intent_id: paymentIntent(invoice)?.id ?? null, livemode: subscription.livemode,
    fulfillment_status: "to_ship", metadata: {},
  }, "billing_orders_stripe_invoice_unique");
  if (!created) {
    return (await selectOne("billing_orders", `stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`))?.id ?? null;
  }
  await insert("billing_order_items", {
    order_id: id, product_id: product.id, product_name_snapshot: product.name, quantity,
    unit_price_cents: subscription.unit_price_cents, floor_price_cents_snapshot: product.floor_price_cents,
    thinnr_share_cents: share, hard_cost_cents_snapshot: product.hard_cost_cents,
    warehousecraft_sku_snapshot: product.warehousecraft_sku ?? null, shipping_weight_oz_snapshot: product.shipping_weight_oz ?? null,
  });
  return id;
}
/**
 * An app-access renewal: nothing ships, no floor, THINNR's flat share of the
 * charge snapshotted on the order; 'not_required' keeps the order out of the
 * shipment and warehouse triggers.
 */
async function appAccessRenewalOrder(id: string, subscription: BillingSubscriptionRow, product: { id: string; name: string }, invoice: any): Promise<string | null> {
  const subtotal = subscription.unit_price_cents;
  const share = appAccessThinnrShare(subtotal);
  const created = await insertIgnore("billing_orders", {
    id, order_number: orderNumber(), provider_id: subscription.provider_id, payer_id: subscription.payer_id,
    patient_id: subscription.patient_id, link_id: null, kind: "subscription_renewal", subscription_id: subscription.id,
    status: "pending", currency: "usd", subtotal_cents: subtotal, shipping_charge_cents: 0,
    tax_cents: Math.max(0, Number(invoice.total ?? 0) - subtotal), total_cents: Number(invoice.total ?? subtotal),
    application_fee_cents: share, application_fee_collected_cents: null,
    stripe_fee_cents: null, office_net_cents: null, hard_cost_cents: 0, shipping_cost_cents: 0,
    hq_profit_cents: hqProfit(share, 0, 0), thinnr_share_percent: APP_ACCESS_THINNR_SHARE_PERCENT,
    shipping_address: {}, stripe_invoice_id: invoice.id,
    stripe_payment_intent_id: paymentIntent(invoice)?.id ?? null, livemode: subscription.livemode,
    fulfillment_status: "not_required", metadata: { app_access: { cadence_weeks: subscription.cadence_weeks ?? null } },
  }, "billing_orders_stripe_invoice_unique");
  if (!created) {
    return (await selectOne("billing_orders", `stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`))?.id ?? null;
  }
  await insert("billing_order_items", {
    order_id: id, product_id: product.id, product_name_snapshot: product.name, quantity: 1,
    unit_price_cents: subscription.unit_price_cents, floor_price_cents_snapshot: 0,
    thinnr_share_cents: share, hard_cost_cents_snapshot: 0,
  });
  return id;
}
async function prepareRenewal(invoice: any, ctx: StripeEventContext): Promise<void> {
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  const subscription = stripeSubscriptionId
    ? await selectOne("billing_subscriptions", `stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}`) : null;
  if (!subscription) return;
  if (!(await eventBelongsToProvider(subscription.provider_id, ctx))) return;
  const pending = invoiceHasPrice(invoice, subscription.pending_stripe_price_id);
  let applicationFee = pending
    ? subscription.pending_application_fee_cents ?? subscription.application_fee_cents
    : subscription.application_fee_cents;
  const acct = ctx.account ?? (await accountFor(subscription.provider_id)).stripe_account_id;
  const stripe = await getStripe();
  // App access ships nothing: the flat share stands, no shipping re-quote.
  if (isAppAccessSubscription(subscription)) applicationFee = appAccessThinnrShare(subscription.unit_price_cents);
  try {
    // Re-quote the shipment for today's address and method; the recurring
    // shipping price is only the base, the invoice bills the fresh quote.
    const requote = isAppAccessSubscription(subscription) ? null : await quoteRenewalShipping(subscription, pending);
    if (requote) {
      const billed = invoiceShippingLineAmount(invoice, [subscription.stripe_price_id, subscription.pending_stripe_price_id])
        ?? (pending ? subscription.pending_shipping_charge_cents ?? subscription.shipping_charge_cents : subscription.shipping_charge_cents);
      const delta = requote.quote.patient_amount_cents - billed;
      if (delta !== 0) {
        await stripe.invoiceItems.create({
          customer: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id, invoice: invoice.id,
          amount: delta, currency: "usd", description: "Shipping & handling adjustment",
          metadata: { thinnr_subscription_id: subscription.id, thinnr_shipping_source: requote.quote.source },
        } as any, connectedOpts(acct, `renewal:${invoice.id}:shipping`));
      }
      applicationFee = requote.application_fee_cents;
      await update("billing_subscriptions", `id=eq.${encodeURIComponent(subscription.id)}`, {
        ...(pending
          ? { pending_shipping_charge_cents: requote.quote.patient_amount_cents, pending_application_fee_cents: applicationFee }
          : { shipping_charge_cents: requote.quote.patient_amount_cents, application_fee_cents: applicationFee }),
        shipping_cost_cents: requote.quote.carrier_cost_cents, ...shipmentColumns(requote.quote), shipping_requoted_at: nowIso(),
      });
    }
  } catch (error) {
    // The invoice keeps its recurring (flat) shipping line; the fee below still lands.
    logger.warn({ err: error, subscriptionId: subscription.id, invoiceId: invoice.id }, "renewal shipping re-quote failed; flat charge kept");
  }
  try {
    await stripe.invoices.update(invoice.id, { application_fee_amount: applicationFee } as any, connectedOpts(acct));
  } catch (error) {
    await insertIgnore("billing_ledger", {
      provider_id: subscription.provider_id, order_id: null, subscription_id: subscription.id, kind: "fee_discrepancy",
      amount_cents: 0, application_fee_cents: subscription.application_fee_cents, stripe_ref: invoice.id,
      detail: { error: error instanceof Error ? error.message.slice(0, 500) : "Stripe error" }, occurred_at: nowIso(),
    }, "billing_ledger_kind_stripe_ref_unique");
  }
}
export async function markSubscriptionInvoicePaid(invoice: any, ctx: StripeEventContext): Promise<void> {
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  const pending = stripeSubscriptionId
    ? await selectOne("billing_subscriptions", `stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}`) : null;
  if (invoice.billing_reason === "subscription_cycle" && pending?.pending_product_id
      && invoiceHasPrice(invoice, pending.pending_stripe_price_id)
      && await eventBelongsToProvider(pending.provider_id, ctx)) {
    const promoted = await update("billing_subscriptions",
      `id=eq.${encodeURIComponent(pending.id)}&pending_product_id=eq.${encodeURIComponent(pending.pending_product_id)}`, {
        product_id: pending.pending_product_id,
        unit_price_cents: pending.pending_unit_price_cents ?? pending.unit_price_cents,
        application_fee_cents: pending.pending_application_fee_cents ?? pending.application_fee_cents,
        shipping_charge_cents: pending.pending_shipping_charge_cents ?? pending.shipping_charge_cents,
        pending_product_id: null, pending_unit_price_cents: null, pending_application_fee_cents: null,
        pending_effective_at: null, pending_shipping_charge_cents: null, pending_stripe_price_id: null,
      });
    if (!promoted) {
      await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(pending.id)}`);
    }
  }
  const orderId = await renewalOrder(invoice, ctx);
  const order = orderId
    ? await selectOne("billing_orders", `id=eq.${encodeURIComponent(orderId)}`)
    : await selectOne("billing_orders", `stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`);
  if (!order) return;
  if (!(await eventBelongsToProvider(order.provider_id, ctx))) return;
  await markOrderPaidFromInvoice({ ...invoice, metadata: { ...invoice.metadata, thinnr_order_id: order.id } }, ctx);
  if (order.subscription_id) {
    await update("billing_subscriptions",
      `id=eq.${encodeURIComponent(order.subscription_id)}&or=(last_failed_invoice_id.eq.${encodeURIComponent(invoice.id)},last_failed_invoice_id.is.null)`, {
      payment_failure_count: 0, last_payment_failed_at: null, last_failed_invoice_id: null,
      last_hosted_invoice_url: null, last_failure_message: null, payment_failure_email_sent_invoice_id: null,
      last_paid_invoice_id: invoice.id,
    });
  }
  if (invoice.billing_reason !== "subscription_create") return;
  if (order.subscription_id) {
    const started = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(order.subscription_id)}`);
    // The "subscription started" email describes a shipment; app access has
    // none (its receipt already says what renews and when).
    if (started && !isAppAccessSubscription(started)) await notifySubscriptionStarted(started);
  }
  const paid = await selectOne("billing_orders", `id=eq.${encodeURIComponent(order.id)}`);
  const collected = paid?.application_fee_collected_cents ?? paid?.application_fee_cents ?? 0;
  const adjustment = applicationFeeOverCollection(collected, order.application_fee_cents);
  if (!adjustment) return;
  const stripe = await getStripe();
  const charge: any = invoice.charge;
  let feeId = typeof charge === "object" && typeof charge.application_fee === "string" ? charge.application_fee : null;
  if (!feeId && paid?.stripe_charge_id) {
    const loaded: any = await stripe.charges.retrieve(paid.stripe_charge_id, { expand: ["application_fee"] } as any, connectedOpts(ctx.account ?? (await accountFor(order.provider_id)).stripe_account_id));
    feeId = typeof loaded.application_fee === "string" ? loaded.application_fee : loaded.application_fee?.id;
  }
  if (!feeId) return;
  await stripe.applicationFees.createRefund(feeId, { amount: adjustment }, { idempotencyKey: `subscription:${order.subscription_id}:fee-adjustment` });
  const corrected = await update("billing_orders",
    `id=eq.${encodeURIComponent(order.id)}&application_fee_collected_cents=eq.${collected}`, {
      application_fee_collected_cents: order.application_fee_cents,
      office_net_cents: (paid?.office_net_cents ?? 0) + adjustment,
      hq_profit_cents: hqProfit(order.application_fee_cents, order.hard_cost_cents, order.shipping_cost_cents),
    });
  if (!corrected) return;
  if (await selectOne("billing_ledger", `kind=eq.application_fee_adjustment&order_id=eq.${encodeURIComponent(order.id)}`)) return;
  await insertIgnore("billing_ledger", {
    provider_id: order.provider_id, order_id: order.id, subscription_id: order.subscription_id,
    kind: "application_fee_adjustment", amount_cents: 0, application_fee_cents: -adjustment,
    stripe_ref: feeId, detail: { collected_cents: collected, exact_cents: order.application_fee_cents }, occurred_at: nowIso(),
  }, "billing_ledger_kind_stripe_ref_unique");
}
export async function markSubscriptionInvoiceFailed(invoice: any, ctx: StripeEventContext): Promise<void> {
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  const subscription = stripeSubscriptionId
    ? await selectOne("billing_subscriptions", `stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}`) : null;
  if (!subscription || !(await eventBelongsToProvider(subscription.provider_id, ctx))) return;
  if (subscription.last_paid_invoice_id === invoice.id) return;
  const orderId = await renewalOrder(invoice, ctx);
  const message = failureMessage(invoice);
  let failedOrder = null;
  if (orderId) {
    failedOrder = await update("billing_orders", `id=eq.${encodeURIComponent(orderId)}&status=in.(pending,failed)`, {
      status: "failed", paid_at: null, failure_message: message,
    });
  }
  if (orderId && !failedOrder) return;
  const invoiceFilter = encodeURIComponent(invoice.id);
  const updated = await update("billing_subscriptions",
    `id=eq.${encodeURIComponent(subscription.id)}&or=(last_failed_invoice_id.neq.${invoiceFilter},last_failed_invoice_id.is.null)&or=(last_paid_invoice_id.is.null,last_paid_invoice_id.neq.${invoiceFilter})`, {
    ...(!["canceled", "unpaid"].includes(subscription.status) ? { status: "past_due" } : {}),
    payment_failure_count: subscription.payment_failure_count + 1,
    last_payment_failed_at: nowIso(),
    last_failed_invoice_id: invoice.id,
    last_hosted_invoice_url: invoice.hosted_invoice_url ?? subscription.last_hosted_invoice_url,
    last_failure_message: message,
  });
  if (!updated) return;
  if (updated.patient_id) {
    const product = await selectOne("billing_products", `id=eq.${encodeURIComponent(updated.product_id)}`);
    await notifySubscriptionPaymentFailed({ subscription: updated, productName: product?.name ?? "Subscription", invoiceId: invoice.id, message: message ?? "The renewal payment did not go through.", appAccess: isAppAccessSubscription(updated) });
  }
  if (!invoice.hosted_invoice_url) return;
  const claimed = await update("billing_subscriptions",
    `id=eq.${encodeURIComponent(subscription.id)}&last_failed_invoice_id=eq.${invoiceFilter}&or=(payment_failure_email_sent_invoice_id.neq.${invoiceFilter},payment_failure_email_sent_invoice_id.is.null)`, {
    payment_failure_email_sent_invoice_id: invoice.id,
  });
  if (!claimed) return;
  const [payer, product, office] = await Promise.all([
    selectOne("billing_payers", `id=eq.${encodeURIComponent(subscription.payer_id)}`),
    selectOne("billing_products", `id=eq.${encodeURIComponent(subscription.product_id)}`),
    getProvider(subscription.provider_id),
  ]);
  if (!payer || !product || !office) return;
  await sendPaymentFailed({
    subscription: claimed, payer, productName: product.name, office,
    amountCents: Number(invoice.amount_due ?? invoice.total ?? subscription.unit_price_cents + subscription.shipping_charge_cents),
    hostedInvoiceUrl: invoice.hosted_invoice_url,
  });
}
export function mappedStatus(status: string): BillingSubscriptionRow["status"] {
  if (status === "active" || status === "past_due" || status === "unpaid" || status === "incomplete") return status;
  // A paid subscription whose next shipment was moved sits in a Stripe "trial"
  // until the new date; to the office and the patient it is still active.
  if (status === "trialing") return "active";
  return "canceled";
}
async function syncSubscription(value: any, ctx: StripeEventContext): Promise<void> {
  const row = await selectOne("billing_subscriptions", `stripe_subscription_id=eq.${encodeURIComponent(value.id)}`);
  if (!row || !(await eventBelongsToProvider(row.provider_id, ctx))) return;
  const reconcileCas = ctx.expectedSubscriptionUpdatedAt
    ? `&updated_at=eq.${encodeURIComponent(ctx.expectedSubscriptionUpdatedAt)}` : "";
  await update("billing_subscriptions", `id=eq.${encodeURIComponent(row.id)}${reconcileCas}`, {
    status: mappedStatus(value.status), current_period_end: periodEnd(value),
    next_shipment_at: isAppAccessSubscription(row) ? null : nextShipmentAt(value, row),
    cancel_at_period_end: Boolean(value.cancel_at_period_end),
    canceled_at: value.canceled_at ? new Date(value.canceled_at * 1000).toISOString() : value.status === "canceled" ? nowIso() : null,
    paused_at: value.pause_collection ? row.paused_at ?? nowIso() : null,
  });
}
export async function pauseSubscription(id: string): Promise<BillingSubscriptionRow> {
  const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  if (row.paused_at) throw new BillingSubscriptionError("Subscription is already paused.", 409);
  if (row.status === "past_due") {
    throw new BillingSubscriptionError("Bring the subscription current or cancel it; past-due subscriptions can't be paused.", 409);
  }
  if (row.status !== "active") throw new BillingSubscriptionError("Only active subscriptions can be paused.", 409);
  if (!row.stripe_subscription_id) throw new BillingSubscriptionError("Subscription setup is not complete.", 409);
  const account = await accountFor(row.provider_id);
  await (await getStripe()).subscriptions.update(row.stripe_subscription_id, {
    pause_collection: { behavior: "void" },
  }, connectedOpts(account.stripe_account_id));
  const pausedAt = nowIso();
  const updated = await update("billing_subscriptions",
    `id=eq.${encodeURIComponent(id)}&status=eq.${encodeURIComponent(row.status)}&paused_at=is.null`, { paused_at: pausedAt });
  if (!updated) {
    const mirrored = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
    if (mirrored?.paused_at) return mirrored;
    throw new BillingSubscriptionError("Subscription was updated elsewhere. Refresh and try again.", 409);
  }
  await notifySubscriptionEvent(updated, { kind: "paused" });
  return updated;
}
export async function resumeSubscription(id: string): Promise<BillingSubscriptionRow> {
  const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  if (!row.paused_at) throw new BillingSubscriptionError("Subscription is not paused.", 409);
  if (!row.stripe_subscription_id) throw new BillingSubscriptionError("Subscription setup is not complete.", 409);
  const account = await accountFor(row.provider_id);
  await (await getStripe()).subscriptions.update(row.stripe_subscription_id, {
    pause_collection: "",
  } as any, connectedOpts(account.stripe_account_id));
  const updated = await update("billing_subscriptions",
    `id=eq.${encodeURIComponent(id)}&paused_at=eq.${encodeURIComponent(row.paused_at)}`, { paused_at: null });
  if (!updated) {
    const mirrored = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
    if (mirrored && !mirrored.paused_at) return mirrored;
    throw new BillingSubscriptionError("Subscription was updated elsewhere. Refresh and try again.", 409);
  }
  await notifySubscriptionEvent(updated, { kind: "resumed" });
  return updated;
}
async function changeQuoteData(row: BillingSubscriptionRow, productId: string) {
  if (row.product_id === productId) throw new BillingSubscriptionError("Subscription already uses this product.", 409, "product_id");
  const [current, next, price, settings] = await Promise.all([
    selectOne("billing_products", `id=eq.${encodeURIComponent(row.product_id)}`),
    selectOne("billing_products", `id=eq.${encodeURIComponent(productId)}`),
    selectOne("billing_office_prices", `provider_id=eq.${encodeURIComponent(row.provider_id)}&product_id=eq.${encodeURIComponent(productId)}`),
    getSettings(),
  ]);
  if (!current) throw new BillingSubscriptionError("Current product not found.", 409);
  if (!next || !next.active || next.status !== "active") throw new BillingSubscriptionError("Product not found.", 404, "product_id");
  if (!price || price.enabled === false || !price.subscription_enabled || price.sell_price_cents < next.floor_price_cents) {
    throw new BillingSubscriptionError("This product is not available for subscriptions at this office.", 409, "product_id");
  }
  const fees = computeOrderFees([{ floor_price_cents: next.floor_price_cents, quantity: 1 }], settings);
  return { current, next, price, settings, fees };
}
export async function quoteSubscriptionChange(id: string, productId: string): Promise<SubscriptionChangeQuote> {
  const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  const data = await changeQuoteData(row, productId);
  return {
    current: { product_id: data.current.id, product_name: data.current.name, unit_price_cents: row.unit_price_cents },
    next: {
      product_id: data.next.id, product_name: data.next.name, unit_price_cents: data.price.sell_price_cents,
      shipping_charge_cents: data.settings.shipping_charge_cents, application_fee_cents: data.fees.application_fee_cents,
    },
    effective_at: row.current_period_end,
  };
}
export async function changeSubscription(id: string, productId: string): Promise<BillingSubscriptionRow> {
  const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  if (!row.stripe_subscription_id) throw new BillingSubscriptionError("Subscription setup is not complete.", 409);
  const data = await changeQuoteData(row, productId);
  const mirrored = await ensureRecurringPrices(row.provider_id, productId);
  if (!mirrored?.stripe_price_id || !mirrored.stripe_shipping_price_id) {
    throw new BillingSubscriptionError("Subscription pricing is unavailable.", 409);
  }
  const account = await accountFor(row.provider_id);
  const stripe = await getStripe();
  const stripeSubscription: any = await stripe.subscriptions.retrieve(
    row.stripe_subscription_id, {}, connectedOpts(account.stripe_account_id),
  );
  const currentPrice = await selectOne("billing_office_prices",
    `provider_id=eq.${encodeURIComponent(row.provider_id)}&product_id=eq.${encodeURIComponent(row.product_id)}`);
  const item = stripeSubscription.items?.data?.find((candidate: any) =>
    candidate.price?.id === currentPrice?.stripe_price_id) ?? stripeSubscription.items?.data?.find((candidate: any) =>
    candidate.price?.id !== currentPrice?.stripe_shipping_price_id);
  const shippingItem = stripeSubscription.items?.data?.find((candidate: any) =>
    candidate.price?.id === currentPrice?.stripe_shipping_price_id) ?? stripeSubscription.items?.data?.find((candidate: any) =>
    candidate.id !== item?.id);
  if (!item?.id || !shippingItem?.id) {
    throw new BillingSubscriptionError("Subscription product or shipping item could not be found.", 409);
  }
  await stripe.subscriptions.update(row.stripe_subscription_id, {
    items: [
      { id: item.id, price: mirrored.stripe_price_id, quantity: 1 },
      { id: shippingItem.id, price: mirrored.stripe_shipping_price_id, quantity: 1 },
    ],
    proration_behavior: "none", billing_cycle_anchor: "unchanged",
    application_fee_percent: applicationFeePercentFor(
      data.fees.application_fee_cents, data.price.sell_price_cents + data.settings.shipping_charge_cents,
    ),
  } as any, connectedOpts(account.stripe_account_id));
  const updated = await update("billing_subscriptions", `id=eq.${encodeURIComponent(id)}&product_id=eq.${encodeURIComponent(row.product_id)}`, {
    pending_product_id: productId, pending_unit_price_cents: data.price.sell_price_cents,
    pending_application_fee_cents: data.fees.application_fee_cents,
    pending_effective_at: row.current_period_end,
    pending_shipping_charge_cents: data.settings.shipping_charge_cents,
    pending_stripe_price_id: mirrored.stripe_price_id,
  });
  if (!updated) throw new BillingSubscriptionError("Subscription was updated elsewhere. Refresh and try again.", 409);
  await notifySubscriptionEvent(updated, {
    kind: "plan-changed",
    previousPlan: planLabel(data.current.name, row.quantity, row.cadence_weeks),
    newPlan: planLabel(data.next.name, row.quantity, row.cadence_weeks),
  });
  return updated;
}
export async function cancelSubscription(id: string, input: { at_period_end: boolean }): Promise<BillingSubscriptionRow> {
  const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  const account = await accountFor(row.provider_id);
  if (!row.stripe_subscription_id) throw new BillingSubscriptionError("Subscription setup is not complete.", 409);
  // Already in the requested end state: no second Stripe write, no second email.
  if (row.status === "canceled" || (input.at_period_end && row.cancel_at_period_end)) return row;
  const stripe = await getStripe();
  const value: any = input.at_period_end
    ? await stripe.subscriptions.update(row.stripe_subscription_id, { cancel_at_period_end: true }, connectedOpts(account.stripe_account_id))
    : await stripe.subscriptions.cancel(row.stripe_subscription_id, {}, connectedOpts(account.stripe_account_id));
  const updated = await update("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`, {
    status: mappedStatus(value.status), current_period_end: periodEnd(value),
    cancel_at_period_end: Boolean(value.cancel_at_period_end),
    canceled_at: value.canceled_at ? new Date(value.canceled_at * 1000).toISOString() : null,
  });
  if (!updated) throw new BillingSubscriptionError("Subscription could not be updated.", 502);
  // App-access cancellation emails are a later scope (the in-app list shows the end date).
  if (!isAppAccessSubscription(updated)) await notifySubscriptionEvent(updated, { kind: "cancelled" });
  return updated;
}
export async function retrySubscriptionPayment(id: string): Promise<BillingSubscriptionRow> {
  const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  if (!row.last_failed_invoice_id) throw new BillingSubscriptionError("There is no failed invoice to retry.", 409);
  const account = await accountFor(row.provider_id);
  try {
    await (await getStripe()).invoices.pay(
      row.last_failed_invoice_id, {},
      connectedOpts(account.stripe_account_id, `retry:${row.id}:${row.last_failed_invoice_id}:${row.payment_failure_count}`),
    );
  } catch (error) {
    const stripeError = error as { type?: string; message?: string };
    if (stripeError?.type === "StripeCardError") {
      throw new BillingSubscriptionError((stripeError.message || "The card was declined.").slice(0, 200), 402);
    }
    throw error;
  }
  return (await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`)) ?? row;
}
export async function resendSubscriptionPaymentEmail(id: string): Promise<BillingSubscriptionRow> {
  const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  if (!row.last_failed_invoice_id || !row.last_hosted_invoice_url) {
    throw new BillingSubscriptionError("There is no failed invoice to email.", 409);
  }
  const [payer, product, office, order] = await Promise.all([
    selectOne("billing_payers", `id=eq.${encodeURIComponent(row.payer_id)}`),
    selectOne("billing_products", `id=eq.${encodeURIComponent(row.product_id)}`),
    getProvider(row.provider_id),
    selectOne("billing_orders", `stripe_invoice_id=eq.${encodeURIComponent(row.last_failed_invoice_id)}`),
  ]);
  if (!payer || !product || !office) throw new BillingSubscriptionError("Subscription details are incomplete.", 502);
  await sendPaymentFailed({
    subscription: row, payer, productName: product.name, office,
    amountCents: order?.total_cents ?? row.unit_price_cents + row.shipping_charge_cents,
    hostedInvoiceUrl: row.last_hosted_invoice_url,
  });
  return row;
}
export async function cancelByToken(token: string): Promise<PublicSubscription> {
  const row = await selectOne("billing_subscriptions", `cancel_token=eq.${encodeURIComponent(token)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  await cancelSubscription(row.id, { at_period_end: true });
  return toPublicSubscription((await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(row.id)}`))!);
}
export async function toSubscriptionRow(row: BillingSubscriptionRow): Promise<SubscriptionRow> {
  const [payer, product, pendingProduct, provider, renewals] = await Promise.all([
    selectOne("billing_payers", `id=eq.${encodeURIComponent(row.payer_id)}`),
    selectOne("billing_products", `id=eq.${encodeURIComponent(row.product_id)}`),
    row.pending_product_id ? selectOne("billing_products", `id=eq.${encodeURIComponent(row.pending_product_id)}`) : null,
    getProvider(row.provider_id),
    selectMany("billing_orders", `subscription_id=eq.${encodeURIComponent(row.id)}&kind=eq.subscription_renewal&status=eq.paid&select=id`),
  ]);
  if (!payer || !product || !provider) throw new BillingSubscriptionError("Subscription details are incomplete.", 502);
  return {
    id: row.id, provider_id: row.provider_id, office_name: officeName(provider),
    payer: { id: payer.id, patient_id: payer.patient_id, name: payer.name, email: payer.email, phone: payer.phone },
    product_id: product.id, product_name: product.name, status: row.status as SubscriptionRow["status"],
    unit_price_cents: row.unit_price_cents, shipping_charge_cents: row.shipping_charge_cents,
    application_fee_cents: row.application_fee_cents, current_period_end: row.current_period_end,
    cancel_at_period_end: row.cancel_at_period_end, canceled_at: row.canceled_at, renewals: renewals.length,
    payment_failure_count: row.payment_failure_count, last_payment_failed_at: row.last_payment_failed_at,
    last_failure_message: row.last_failure_message,
    paused_at: row.paused_at,
    pending_change: row.pending_product_id && pendingProduct ? {
      product_id: row.pending_product_id, product_name: pendingProduct.name,
      unit_price_cents: row.pending_unit_price_cents ?? row.unit_price_cents,
      effective_at: row.pending_effective_at,
    } : null,
    livemode: row.livemode, created_at: row.created_at,
    shipping: shipmentTerms(row), shipping_requoted_at: row.shipping_requoted_at ?? null,
  };
}
export async function toPublicSubscription(row: BillingSubscriptionRow): Promise<PublicSubscription> {
  const [product, bundle] = await Promise.all([
    selectOne("billing_products", `id=eq.${encodeURIComponent(row.product_id)}`),
    selectOne("billing_orders", `subscription_id=eq.${encodeURIComponent(row.id)}&order=created_at.asc`),
  ]);
  const orderBundle = bundle ? await getOrderBundle(bundle.id) : null;
  return { product_name: product?.name ?? "Subscription", office_name: orderBundle ? officeName(orderBundle.office) : "Office",
    unit_price_cents: row.unit_price_cents, shipping_charge_cents: row.shipping_charge_cents,
    status: row.status as PublicSubscription["status"], current_period_end: row.current_period_end,
    cancel_at_period_end: row.cancel_at_period_end };
}
export function registerSubscriptionWebhookHandlers(): void {
  onStripeEvent("invoice.created", async (event, ctx) => {
    const invoice: any = event.data.object;
    if (invoice.billing_reason === "subscription_cycle") await prepareRenewal(invoice, ctx);
  });
  onStripeEvent("customer.subscription.updated", async (event, ctx) => syncSubscription(event.data.object, ctx));
  onStripeEvent("customer.subscription.deleted", async (event, ctx) => syncSubscription(event.data.object, ctx));
}
