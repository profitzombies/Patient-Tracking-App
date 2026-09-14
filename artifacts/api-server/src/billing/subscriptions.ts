import crypto from "node:crypto";
import type Stripe from "stripe";
import { logger } from "../lib/logger";
import { applicationFeeOverCollection, applicationFeePercentFor, hqProfit } from "./fees";
import { ensureCustomer } from "./customers";
import { resolvePayer, touchLinkUse } from "./links";
import { BillingOrderError, markOrderPaidFromInvoice, quoteOrder } from "./orders";
import { ensureRecurringPrices } from "./prices";
import { sendCancellationNotice } from "./receipts";
import { connectedOpts, getPublishableKey, getStripe, isSandbox } from "./stripe-client";
import {
  insert, nowIso, selectMany, selectOne, update, type BillingConnectedAccountRow,
  type BillingPaymentLinkRow, type BillingSubscriptionRow,
} from "./store";
import { getOrderBundle, getProvider, officeName } from "./store-orders";
import type { PublicOrderResponse, PublicSubscription, ShippingAddress, SubscriptionRow } from "./types";
import { onStripeEvent, type StripeEventContext } from "./webhooks";

export class BillingSubscriptionError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
function paymentIntent(invoice: any): any {
  const value = invoice.payment_intent ?? invoice.payments?.data?.[0]?.payment?.payment_intent;
  return typeof value === "string" ? { id: value } : value;
}
function periodEnd(value: any): string | null {
  const seconds = value.current_period_end ?? value.items?.data?.[0]?.current_period_end;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}
async function accountFor(providerId: string): Promise<BillingConnectedAccountRow> {
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
  const stripeSubscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.parent?.subscription_details?.subscription;
  const subscription = stripeSubscriptionId
    ? await selectOne("billing_subscriptions", `stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}`) : null;
  if (!subscription) return null;
  if (!(await eventBelongsToProvider(subscription.provider_id, ctx))) return null;
  const existing = await selectOne("billing_orders", `stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`);
  if (existing) return existing.id;
  const product = await selectOne("billing_products", `id=eq.${encodeURIComponent(subscription.product_id)}`);
  if (!product) return null;
  const id = crypto.randomUUID();
  const hard = product.hard_cost_cents;
  await insert("billing_orders", {
    id, order_number: orderNumber(), provider_id: subscription.provider_id, payer_id: subscription.payer_id,
    patient_id: subscription.patient_id, link_id: null, kind: "subscription_renewal", subscription_id: subscription.id,
    status: "pending", currency: "usd", subtotal_cents: subscription.unit_price_cents,
    shipping_charge_cents: subscription.shipping_charge_cents,
    tax_cents: Math.max(0, Number(invoice.total ?? 0) - subscription.unit_price_cents - subscription.shipping_charge_cents),
    total_cents: Number(invoice.total ?? subscription.unit_price_cents + subscription.shipping_charge_cents),
    application_fee_cents: subscription.application_fee_cents, application_fee_collected_cents: null,
    stripe_fee_cents: null, office_net_cents: null, hard_cost_cents: hard, shipping_cost_cents: subscription.shipping_cost_cents,
    hq_profit_cents: hqProfit(subscription.application_fee_cents, hard, subscription.shipping_cost_cents),
    shipping_address: subscription.shipping_address, stripe_invoice_id: invoice.id,
    stripe_payment_intent_id: paymentIntent(invoice)?.id ?? null, livemode: subscription.livemode,
    fulfillment_status: "to_ship", metadata: {},
  });
  await insert("billing_order_items", {
    order_id: id, product_id: product.id, product_name_snapshot: product.name, quantity: 1,
    unit_price_cents: subscription.unit_price_cents, floor_price_cents_snapshot: product.floor_price_cents,
    thinnr_share_cents: subscription.application_fee_cents - subscription.shipping_charge_cents,
    hard_cost_cents_snapshot: product.hard_cost_cents,
  });
  return id;
}
async function prepareRenewal(invoice: any, ctx: StripeEventContext): Promise<void> {
  const stripeSubscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.parent?.subscription_details?.subscription;
  const subscription = stripeSubscriptionId
    ? await selectOne("billing_subscriptions", `stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}`) : null;
  if (!subscription) return;
  if (!(await eventBelongsToProvider(subscription.provider_id, ctx))) return;
  try {
    await (await getStripe()).invoices.update(invoice.id, { application_fee_amount: subscription.application_fee_cents } as any, connectedOpts(ctx.account ?? (await accountFor(subscription.provider_id)).stripe_account_id));
  } catch (error) {
    await insert("billing_ledger", {
      provider_id: subscription.provider_id, order_id: null, subscription_id: subscription.id, kind: "fee_discrepancy",
      amount_cents: 0, application_fee_cents: subscription.application_fee_cents, stripe_ref: invoice.id,
      detail: { error: error instanceof Error ? error.message.slice(0, 500) : "Stripe error" }, occurred_at: nowIso(),
    });
  }
  await renewalOrder(invoice, ctx);
}
export async function markSubscriptionInvoicePaid(invoice: any, ctx: StripeEventContext): Promise<void> {
  const orderId = await renewalOrder(invoice, ctx);
  const order = orderId
    ? await selectOne("billing_orders", `id=eq.${encodeURIComponent(orderId)}`)
    : await selectOne("billing_orders", `stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`);
  if (!order) return;
  if (!(await eventBelongsToProvider(order.provider_id, ctx))) return;
  await markOrderPaidFromInvoice({ ...invoice, metadata: { ...invoice.metadata, thinnr_order_id: order.id } }, ctx);
  if (invoice.billing_reason !== "subscription_create") return;
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
  await insert("billing_ledger", {
    provider_id: order.provider_id, order_id: order.id, subscription_id: order.subscription_id,
    kind: "application_fee_adjustment", amount_cents: 0, application_fee_cents: -adjustment,
    stripe_ref: feeId, detail: { collected_cents: collected, exact_cents: order.application_fee_cents }, occurred_at: nowIso(),
  });
}
function mappedStatus(status: string): BillingSubscriptionRow["status"] {
  if (status === "active" || status === "past_due" || status === "unpaid" || status === "incomplete") return status;
  return "canceled";
}
async function syncSubscription(value: any, ctx: StripeEventContext): Promise<void> {
  const row = await selectOne("billing_subscriptions", `stripe_subscription_id=eq.${encodeURIComponent(value.id)}`);
  if (!row || !(await eventBelongsToProvider(row.provider_id, ctx))) return;
  await update("billing_subscriptions", `id=eq.${encodeURIComponent(row.id)}`, {
    status: mappedStatus(value.status), current_period_end: periodEnd(value),
    cancel_at_period_end: Boolean(value.cancel_at_period_end),
    canceled_at: value.canceled_at ? new Date(value.canceled_at * 1000).toISOString() : value.status === "canceled" ? nowIso() : null,
  });
}
export async function cancelSubscription(id: string, input: { at_period_end: boolean }): Promise<BillingSubscriptionRow> {
  const row = await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  const account = await accountFor(row.provider_id);
  if (!row.stripe_subscription_id) throw new BillingSubscriptionError("Subscription setup is not complete.", 409);
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
  const payer = await selectOne("billing_payers", `id=eq.${encodeURIComponent(row.payer_id)}`);
  const product = await selectOne("billing_products", `id=eq.${encodeURIComponent(row.product_id)}`);
  if (payer && product) await sendCancellationNotice({ subscription: updated, payer, productName: product.name });
  return updated;
}
export async function cancelByToken(token: string): Promise<PublicSubscription> {
  const row = await selectOne("billing_subscriptions", `cancel_token=eq.${encodeURIComponent(token)}`);
  if (!row) throw new BillingSubscriptionError("Subscription not found.", 404);
  await cancelSubscription(row.id, { at_period_end: true });
  return toPublicSubscription((await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(row.id)}`))!);
}
export async function toSubscriptionRow(row: BillingSubscriptionRow): Promise<SubscriptionRow> {
  const [payer, product, provider, renewals] = await Promise.all([
    selectOne("billing_payers", `id=eq.${encodeURIComponent(row.payer_id)}`),
    selectOne("billing_products", `id=eq.${encodeURIComponent(row.product_id)}`),
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
    livemode: row.livemode, created_at: row.created_at,
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
