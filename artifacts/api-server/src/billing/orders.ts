import crypto from "node:crypto";
import type Stripe from "stripe";
import { logger } from "../lib/logger";
import { getSettings } from "./catalog";
import { breakEvenMinimum, computeOrderFees, estimateStripeFee, hqProfit } from "./fees";
import { ensureCustomer } from "./customers";
import { resolvePayer, touchLinkUse } from "./links";
import { sendReceipt } from "./receipts";
import { connectedOpts, getPublishableKey, getStripe, isSandbox } from "./stripe-client";
import {
  insert, insertIgnore, nowIso, selectMany, selectOne, update, type BillingConnectedAccountRow,
  type BillingOrderItemRow, type BillingOrderRow, type BillingPaymentLinkRow,
} from "./store";
import { getOrderBundle, officeName } from "./store-orders";
import type { OrderDetail, PublicOrderResponse, ShippingAddress } from "./types";
import { dispatchStripeEvent, onStripeEvent, type StripeEventContext } from "./webhooks";

export class BillingOrderError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
type ItemInput = { product_id: string; quantity: number };
type QuoteLine = {
  product_id: string; name: string; quantity: number; unit_price_cents: number;
  floor_price_cents: number; hard_cost_cents: number; stripe_tax_code: string | null;
};
export type OrderQuote = {
  lines: QuoteLine[]; subtotal_cents: number; shipping_charge_cents: number; total_cents: number;
  application_fee_cents: number; thinnr_share_cents: number; hard_cost_cents: number;
  shipping_cost_cents: number; settings: Awaited<ReturnType<typeof getSettings>>;
};

export async function quoteOrder(link: BillingPaymentLinkRow, items: ItemInput[], purchase: "one_time" | "subscription"): Promise<OrderQuote> {
  if (!items.length || (purchase === "subscription" && items.length !== 1)) {
    throw new BillingOrderError(purchase === "subscription" ? "Choose exactly one subscription product." : "Choose at least one product.", 400, "items");
  }
  if (items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10)) {
    throw new BillingOrderError("Each quantity must be between 1 and 10.", 400, "items");
  }
  const [prices, products, settings] = await Promise.all([
    selectMany("billing_office_prices", `provider_id=eq.${encodeURIComponent(link.provider_id)}`),
    selectMany("billing_products", "active=eq.true"),
    getSettings(),
  ]);
  const priceMap = new Map(prices.map((row) => [row.product_id, row]));
  const productMap = new Map(products.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const lines = items.map((item): QuoteLine => {
    const price = priceMap.get(item.product_id);
    const product = productMap.get(item.product_id);
    if (seen.has(item.product_id) || !price || !product || (purchase === "subscription" && !price.subscription_enabled)) {
      throw new BillingOrderError("One or more products are not available.", 400, "items");
    }
    if (price.sell_price_cents < breakEvenMinimum(product.floor_price_cents, settings)) {
      throw new BillingOrderError(`${product.name} has a price below the current minimum.`, 409, "items");
    }
    seen.add(item.product_id);
    return {
      product_id: product.id, name: product.name, quantity: item.quantity,
      unit_price_cents: price.sell_price_cents, floor_price_cents: product.floor_price_cents,
      hard_cost_cents: product.hard_cost_cents, stripe_tax_code: product.stripe_tax_code,
    };
  });
  const fees = computeOrderFees(lines.map((line) => ({ floor_price_cents: line.floor_price_cents, quantity: line.quantity })), settings);
  const subtotal = lines.reduce((sum, line) => sum + line.unit_price_cents * line.quantity, 0);
  return {
    lines, subtotal_cents: subtotal, shipping_charge_cents: settings.shipping_charge_cents,
    total_cents: subtotal + settings.shipping_charge_cents, application_fee_cents: fees.application_fee_cents,
    thinnr_share_cents: fees.thinnr_share_cents,
    hard_cost_cents: lines.reduce((sum, line) => sum + line.hard_cost_cents * line.quantity, 0),
    shipping_cost_cents: settings.shipping_cost_cents, settings,
  };
}
function orderNumber(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  return `TH-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}
async function accountFor(providerId: string): Promise<BillingConnectedAccountRow> {
  const account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}&disconnected_at=is.null`);
  if (!account?.charges_enabled) throw new BillingOrderError("This office is not ready to accept payments.", 409);
  return account;
}
async function eventBelongsToProvider(providerId: string, ctx: StripeEventContext): Promise<boolean> {
  if (ctx.kind !== "connect" || !ctx.account) {
    logger.warn({ providerId, kind: ctx.kind }, "ignored non-connect billing event");
    return false;
  }
  const account = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`);
  const valid = account?.stripe_account_id === ctx.account;
  if (!valid) logger.warn({ providerId, account: ctx.account }, "ignored cross-account billing event");
  return valid;
}
function paymentIntent(invoice: any): any {
  const direct = invoice.payment_intent;
  if (direct) return typeof direct === "string" ? { id: direct } : direct;
  const payment = invoice.payments?.data?.[0]?.payment?.payment_intent;
  return typeof payment === "string" ? { id: payment } : payment;
}
export async function createOneTimeOrder(input: {
  link: BillingPaymentLinkRow; payerInput?: { name: string; email: string; phone: string };
  shipping_address: ShippingAddress; items: ItemInput[];
}): Promise<PublicOrderResponse> {
  const quote = await quoteOrder(input.link, input.items, "one_time");
  const [payer, account] = await Promise.all([resolvePayer(input.link.provider_id, input.link, input.payerInput), accountFor(input.link.provider_id)]);
  const id = crypto.randomUUID();
  let order = await insert("billing_orders", {
    id, order_number: orderNumber(), provider_id: input.link.provider_id, payer_id: payer.id,
    patient_id: payer.patient_id, link_id: input.link.id, kind: "one_time", subscription_id: null,
    status: "pending", currency: "usd", subtotal_cents: quote.subtotal_cents,
    shipping_charge_cents: quote.shipping_charge_cents, tax_cents: 0, total_cents: quote.total_cents,
    application_fee_cents: quote.application_fee_cents, application_fee_collected_cents: null,
    stripe_fee_cents: null, office_net_cents: null, hard_cost_cents: quote.hard_cost_cents,
    shipping_cost_cents: quote.shipping_cost_cents,
    hq_profit_cents: hqProfit(quote.application_fee_cents, quote.hard_cost_cents, quote.shipping_cost_cents),
    shipping_address: input.shipping_address as unknown as Record<string, unknown>, livemode: !await isSandbox(),
    fulfillment_status: "to_ship", metadata: { settings: quote.settings },
  });
  for (const line of quote.lines) {
    await insert("billing_order_items", {
      order_id: id, product_id: line.product_id, product_name_snapshot: line.name, quantity: line.quantity,
      unit_price_cents: line.unit_price_cents, floor_price_cents_snapshot: line.floor_price_cents,
      thinnr_share_cents: Math.floor(line.floor_price_cents * 60 / 100) * line.quantity,
      hard_cost_cents_snapshot: line.hard_cost_cents,
    });
  }
  try {
    const customerId = await ensureCustomer(payer, input.shipping_address, account);
    const stripe = await getStripe();
    const invoice = await stripe.invoices.create({
      customer: customerId, collection_method: "charge_automatically", auto_advance: false,
      automatic_tax: { enabled: account.tax_enabled }, application_fee_amount: quote.application_fee_cents,
      metadata: { thinnr_order_id: id }, pending_invoice_items_behavior: "exclude",
    } as any, connectedOpts(account.stripe_account_id, `order:${id}:invoice`));
    for (const line of quote.lines) {
      await stripe.invoiceItems.create({
        // Invoice items take an inline unit amount + description; price_data
        // would require a pre-created Stripe product on the office's account.
        customer: customerId, invoice: invoice.id, quantity: line.quantity, currency: "usd",
        unit_amount_decimal: String(line.unit_price_cents), description: line.name,
        ...(line.stripe_tax_code ? { tax_code: line.stripe_tax_code } : {}),
      } as any, connectedOpts(account.stripe_account_id, `order:${id}:item:${line.product_id}`));
    }
    await stripe.invoiceItems.create({
      customer: customerId, invoice: invoice.id, quantity: 1, currency: "usd",
      unit_amount_decimal: String(quote.shipping_charge_cents), description: "Shipping",
    } as any, connectedOpts(account.stripe_account_id, `order:${id}:shipping`));
    let finalized: any = await stripe.invoices.finalizeInvoice(invoice.id, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(account.stripe_account_id, `order:${id}:finalize`));
    let intent = paymentIntent(finalized);
    if (!intent?.client_secret) {
      finalized = await stripe.invoices.retrieve(invoice.id, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(account.stripe_account_id));
      intent = paymentIntent(finalized);
    }
    if (!intent?.id || !intent.client_secret) throw new Error("Payment could not be initialized.");
    const tax = Number(finalized.total_taxes?.reduce((sum: number, row: any) => sum + (row.amount ?? 0), 0) ?? finalized.tax ?? 0);
    order = (await update("billing_orders", `id=eq.${encodeURIComponent(id)}`, {
      stripe_invoice_id: finalized.id, stripe_payment_intent_id: intent.id, tax_cents: tax,
      total_cents: Number(finalized.total ?? quote.total_cents),
    })) ?? order;
    await touchLinkUse(input.link.id);
    return {
      order_id: id, order_number: order.order_number, client_secret: intent.client_secret,
      stripe_account_id: account.stripe_account_id, publishable_key: await getPublishableKey(),
      sandbox: await isSandbox(), totals: {
        subtotal_cents: order.subtotal_cents, shipping_charge_cents: order.shipping_charge_cents,
        tax_cents: order.tax_cents, total_cents: order.total_cents,
      }, subscription: null,
    };
  } catch (error) {
    await update("billing_orders", `id=eq.${encodeURIComponent(id)}`, {
      status: "failed", metadata: { settings: quote.settings, error: error instanceof Error ? error.message.slice(0, 500) : "Stripe error" },
    });
    throw new BillingOrderError("Payment could not be initialized. Please try again.", 502);
  }
}

async function invoiceCharge(invoice: any, accountId: string, fallbackIntentId: string | null = null): Promise<any | null> {
  const stripe = await getStripe();
  const intent = paymentIntent(invoice);
  let intentId: string | undefined = typeof intent === "string" ? intent : intent?.id;
  // Webhook payloads on current API versions carry neither `payment_intent`
  // nor `payments`; fall back to the intent we stored at checkout, then to a
  // fresh retrieve with payments expanded.
  if (!intentId && fallbackIntentId) intentId = fallbackIntentId;
  if (!intentId && invoice.id) {
    const loaded: any = await stripe.invoices.retrieve(invoice.id, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(accountId));
    const loadedIntent = paymentIntent(loaded);
    intentId = typeof loadedIntent === "string" ? loadedIntent : loadedIntent?.id;
  }
  if (!intentId) return null;
  const pi: any = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge.balance_transaction", "latest_charge.application_fee"] } as any, connectedOpts(accountId));
  return typeof pi.latest_charge === "string" ? await stripe.charges.retrieve(pi.latest_charge, { expand: ["balance_transaction", "application_fee"] } as any, connectedOpts(accountId)) : pi.latest_charge;
}
/**
 * Stripe's processing fee on a direct charge. On the connected account's
 * balance transaction `fee` also includes our application fee, so sum only
 * the non-application fee lines; without fee details fall back to the total
 * minus the application fee. Unknown (no balance transaction yet) is null.
 */
export function stripeProcessingFeeCents(balance: any, applicationFeeCents: number): number | null {
  if (!balance || typeof balance !== "object") return null;
  const details: any[] | undefined = Array.isArray(balance.fee_details) ? balance.fee_details : undefined;
  if (details) return details.filter((row) => row.type !== "application_fee").reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  return Math.max(0, Number(balance.fee ?? 0) - applicationFeeCents);
}
export async function markOrderPaidFromInvoice(invoice: any, ctx: StripeEventContext): Promise<void> {
  const orderId = invoice.metadata?.thinnr_order_id;
  const order = orderId
    ? await selectOne("billing_orders", `id=eq.${encodeURIComponent(orderId)}`)
    : await selectOne("billing_orders", `stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`);
  if (!order) return;
  if (!(await eventBelongsToProvider(order.provider_id, ctx))) return;
  // Already paid: the only thing a replay may still do is fill in a processing
  // fee that was unknown at the time (no charge resolvable). Never re-post.
  if (order.status === "paid") {
    if (order.stripe_fee_cents === null) await backfillProcessingFee(order, invoice, ctx);
    else await finalizeSaleLine(order, invoice);
    return;
  }
  const account = ctx.account ?? (await accountFor(order.provider_id)).stripe_account_id;
  const charge = await invoiceCharge(invoice, account, order.stripe_payment_intent_id);
  const balance = typeof charge?.balance_transaction === "object" ? charge.balance_transaction : null;
  const collected = Number(charge?.application_fee_amount ?? charge?.application_fee?.amount ?? order.application_fee_cents);
  const stripeFee = stripeProcessingFeeCents(balance, collected);
  const total = Number(invoice.amount_paid ?? invoice.total ?? order.total_cents);
  const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : nowIso();
  const updated = await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}&status=eq.${encodeURIComponent(order.status)}`, {
    status: "paid", paid_at: paidAt, total_cents: total, stripe_charge_id: charge?.id ?? null,
    stripe_balance_transaction_id: balance?.id ?? null, stripe_fee_cents: stripeFee,
    application_fee_collected_cents: collected, office_net_cents: stripeFee === null ? null : total - collected - stripeFee,
  });
  if (!updated) return;
  // The sale line carries the office's net. With the processing fee unknown
  // it holds the office share BEFORE card fees and says so (fee_pending), so
  // nobody mistakes an assumed $0 fee for a real one; the backfill above
  // finalizes the amount once the fee is known.
  await insertIgnore("billing_ledger", {
    provider_id: order.provider_id, order_id: order.id, subscription_id: order.subscription_id,
    kind: "sale", amount_cents: total - collected - (stripeFee ?? 0), application_fee_cents: collected,
    stripe_ref: charge?.id ?? invoice.id,
    detail: { total_cents: total, stripe_fee_cents: stripeFee, ...(stripeFee === null ? { fee_pending: true } : {}) }, occurred_at: paidAt,
  }, "billing_ledger_kind_stripe_ref_unique");
  const bundle = await getOrderBundle(order.id);
  if (bundle) {
    const subscription = order.subscription_id ? await selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(order.subscription_id)}`) : null;
    await sendReceipt({ ...bundle, order: updated, subscription });
  }
}
/**
 * A paid order whose Stripe processing fee could not be resolved at payment
 * time: try again on a replayed/duplicate invoice.paid. When the charge and
 * its balance transaction are now available, finalize the fee, the office net
 * and the sale ledger line in place (guarded so two replays cannot both win).
 */
async function backfillProcessingFee(order: any, invoice: any, ctx: StripeEventContext): Promise<void> {
  const account = ctx.account ?? (await accountFor(order.provider_id)).stripe_account_id;
  const charge = await invoiceCharge(invoice, account, order.stripe_payment_intent_id);
  const balance = typeof charge?.balance_transaction === "object" ? charge.balance_transaction : null;
  const collected = Number(charge?.application_fee_amount ?? charge?.application_fee?.amount ?? order.application_fee_collected_cents ?? order.application_fee_cents);
  const stripeFee = stripeProcessingFeeCents(balance, collected);
  if (stripeFee === null) return;
  const total = Number(order.total_cents);
  const updated = await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}&status=eq.paid&stripe_fee_cents=is.null`, {
    stripe_charge_id: charge?.id ?? order.stripe_charge_id ?? null, stripe_balance_transaction_id: balance?.id ?? null,
    stripe_fee_cents: stripeFee, application_fee_collected_cents: collected, office_net_cents: total - collected - stripeFee,
  });
  if (!updated) return;
  await finalizeSaleLine(updated, invoice);
}
/**
 * Make the sale ledger line agree with a paid order whose fee is known, using
 * only stored values (no Stripe lookup): a still-pending line is finalized, a
 * missing one is posted. Runs on every paid replay so a failure between the
 * order update and the ledger write converges on the next delivery.
 */
async function finalizeSaleLine(order: any, invoice: any): Promise<void> {
  if (order.stripe_fee_cents === null || order.stripe_fee_cents === undefined) return;
  const total = Number(order.total_cents);
  const collected = Number(order.application_fee_collected_cents ?? order.application_fee_cents);
  const amount = total - collected - Number(order.stripe_fee_cents);
  const detail = { total_cents: total, stripe_fee_cents: Number(order.stripe_fee_cents), fee_pending: false };
  const sale = await selectOne("billing_ledger", `kind=eq.sale&order_id=eq.${encodeURIComponent(order.id)}`);
  if (!sale) {
    await insertIgnore("billing_ledger", {
      provider_id: order.provider_id, order_id: order.id, subscription_id: order.subscription_id,
      kind: "sale", amount_cents: amount, application_fee_cents: collected,
      stripe_ref: order.stripe_charge_id ?? invoice?.id ?? order.stripe_invoice_id, detail, occurred_at: order.paid_at ?? nowIso(),
    }, "billing_ledger_kind_stripe_ref_unique");
    return;
  }
  // Only a still-pending line is rewritten: finalized lines may legitimately differ
  // later (e.g. a first-invoice fee adjustment posts its own ledger line).
  if (sale.detail?.fee_pending !== true) return;
  await update("billing_ledger", `id=eq.${encodeURIComponent(sale.id)}`, {
    amount_cents: amount, application_fee_cents: collected, detail: { ...(sale.detail ?? {}), ...detail },
  });
}
export async function refundOrder(orderId: string, input: { amount_cents?: number; reason: string }, actor: string | null) {
  const order = await selectOne("billing_orders", `id=eq.${encodeURIComponent(orderId)}`);
  if (!order || order.status === "pending" || order.status === "failed" || !order.stripe_payment_intent_id) throw new BillingOrderError("Order is not refundable.", 409);
  const existing = await selectMany("billing_refunds", `order_id=eq.${encodeURIComponent(order.id)}`);
  const refunded = existing.filter((row) => row.status !== "failed" && row.status !== "canceled").reduce((sum, row) => sum + row.amount_cents, 0);
  const remainder = order.total_cents - refunded;
  const amount = input.amount_cents ?? remainder;
  if (!Number.isInteger(amount) || amount <= 0 || amount > remainder) throw new BillingOrderError("Refund amount exceeds the refundable balance.", 400, "amount_cents");
  const account = await accountFor(order.provider_id);
  const stripeRefund = await (await getStripe()).refunds.create({
    payment_intent: order.stripe_payment_intent_id, amount, reason: "requested_by_customer",
    refund_application_fee: false, metadata: { thinnr_order_id: order.id, requested_reason: input.reason.slice(0, 200) },
  }, connectedOpts(account.stripe_account_id, `refund:${order.id}:${existing.length + 1}`));
  const row = await insert("billing_refunds", {
    order_id: order.id, stripe_refund_id: stripeRefund.id, amount_cents: amount,
    reason: input.reason.trim(), status: stripeRefund.status ?? "pending", requested_by: actor,
  });
  if (stripeRefund.status === "succeeded") {
    await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}`, { status: amount === remainder ? "refunded" : "partially_refunded" });
    await insertIgnore("billing_ledger", {
      provider_id: order.provider_id, order_id: order.id, subscription_id: order.subscription_id, kind: "refund",
      amount_cents: -amount, application_fee_cents: 0, stripe_ref: stripeRefund.id,
      detail: { reason: input.reason }, occurred_at: nowIso(),
    }, "billing_ledger_kind_stripe_ref_unique");
  }
  return row;
}

export async function toOrderDetail(orderId: string, hq: boolean): Promise<OrderDetail> {
  const bundle = await getOrderBundle(orderId);
  if (!bundle) throw new BillingOrderError("Order not found.", 404);
  const { order, items, payer, office } = bundle;
  const [refunds, disputes, ledger, account] = await Promise.all([
    selectMany("billing_refunds", `order_id=eq.${encodeURIComponent(order.id)}&order=created_at.desc`),
    selectMany("billing_disputes", `order_id=eq.${encodeURIComponent(order.id)}&order=created_at.desc`),
    selectMany("billing_ledger", `order_id=eq.${encodeURIComponent(order.id)}&order=occurred_at.desc`),
    // Reading an order must not depend on the office still being able to
    // charge: paid goods ship even after a disconnect or a capability pause.
    selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(order.provider_id)}`),
  ]);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const settings = (order.metadata?.settings ?? { card_fee_bps: 290, card_fee_fixed_cents: 30 }) as any;
  const share = items.reduce((sum, item) => sum + item.thinnr_share_cents, 0);
  return {
    id: order.id, order_number: order.order_number, provider_id: order.provider_id, office_name: officeName(office),
    payer: { id: payer.id, patient_id: payer.patient_id, name: payer.name, email: payer.email, phone: payer.phone },
    kind: order.kind, status: order.status as any, fulfillment_status: order.fulfillment_status as any,
    total_cents: order.total_cents, application_fee_cents: order.application_fee_cents, item_count: itemCount,
    items_label: items.map((item) => `${item.product_name_snapshot} × ${item.quantity}`).join(", "),
    livemode: order.livemode, created_at: order.created_at, paid_at: order.paid_at,
    items: items.map((item) => ({ id: item.id, product_id: item.product_id, product_name: item.product_name_snapshot,
      quantity: item.quantity, unit_price_cents: item.unit_price_cents, floor_price_cents: item.floor_price_cents_snapshot,
      thinnr_share_cents: item.thinnr_share_cents, hard_cost_cents: item.hard_cost_cents_snapshot })),
    shipping_address: order.shipping_address as unknown as ShippingAddress,
    fees: {
      subtotal_cents: order.subtotal_cents, shipping_charge_cents: order.shipping_charge_cents, tax_cents: order.tax_cents,
      total_cents: order.total_cents, thinnr_share_cents: share, application_fee_cents: order.application_fee_cents,
      application_fee_collected_cents: order.application_fee_collected_cents, stripe_fee_cents: order.stripe_fee_cents,
      stripe_fee_estimate_cents: estimateStripeFee(order.total_cents, settings),
      office_net_cents: order.office_net_cents,
      office_net_estimate_cents: order.total_cents - order.application_fee_cents - estimateStripeFee(order.total_cents, settings),
    },
    ...(hq ? { profit: { hard_cost_cents: order.hard_cost_cents, shipping_cost_cents: order.shipping_cost_cents, hq_profit_cents: order.hq_profit_cents } } : {}),
    subscription_id: order.subscription_id, tracking_number: order.tracking_number, carrier: order.carrier,
    shipped_at: order.shipped_at, shipped_by_name: null, canceled_reason: order.canceled_reason,
    refunds: refunds.map((row) => ({ id: row.id, stripe_refund_id: row.stripe_refund_id, amount_cents: row.amount_cents,
      reason: row.reason, status: row.status, requested_by_name: null, created_at: row.created_at })),
    disputes: disputes as any, ledger: ledger as any,
    stripe: { account_id: account?.stripe_account_id ?? "", invoice_id: order.stripe_invoice_id,
      payment_intent_id: order.stripe_payment_intent_id, charge_id: order.stripe_charge_id,
      balance_transaction_id: order.stripe_balance_transaction_id },
  };
}

async function reconcileRefund(charge: any, ctx: StripeEventContext) {
  const order = await selectOne("billing_orders", `stripe_charge_id=eq.${encodeURIComponent(charge.id)}`);
  if (!order) return;
  if (!(await eventBelongsToProvider(order.provider_id, ctx))) return;
  // `charge.refunds` is not included in webhook payloads on current API
  // versions; list them on the connected account instead.
  let refunds: any[] = Array.isArray(charge.refunds?.data) ? charge.refunds.data : [];
  if (!refunds.length && Number(charge.amount_refunded ?? 0) > 0) {
    const stripe = await getStripe();
    const account = ctx.account ?? (await accountFor(order.provider_id)).stripe_account_id;
    refunds = (await stripe.refunds.list({ charge: charge.id, limit: 100 }, connectedOpts(account))).data;
  }
  for (const refund of refunds) {
    const existing = await selectOne("billing_refunds", `stripe_refund_id=eq.${encodeURIComponent(refund.id)}`);
    if (existing) {
      await update("billing_refunds", `stripe_refund_id=eq.${encodeURIComponent(refund.id)}`, { status: refund.status ?? "succeeded" });
    } else {
      await insert("billing_refunds", { order_id: order.id, stripe_refund_id: refund.id, amount_cents: refund.amount,
        reason: refund.metadata?.requested_reason ?? refund.reason ?? null, status: refund.status ?? "succeeded", requested_by: null });
    }
    if ((refund.status ?? "succeeded") === "succeeded") {
      await insertIgnore("billing_ledger", { provider_id: order.provider_id, order_id: order.id, subscription_id: order.subscription_id,
        kind: "refund", amount_cents: -refund.amount, application_fee_cents: 0, stripe_ref: refund.id,
        detail: {}, occurred_at: nowIso() }, "billing_ledger_kind_stripe_ref_unique");
    }
  }
  const recorded = await selectMany("billing_refunds", `order_id=eq.${encodeURIComponent(order.id)}`);
  const total = recorded.filter((row) => row.status === "succeeded").reduce((sum, row) => sum + row.amount_cents, 0);
  await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}`, {
    status: total >= order.total_cents ? "refunded" : total > 0 ? "partially_refunded" : "paid",
  });
}
async function dispute(event: "created" | "updated" | "closed" | "funds_withdrawn" | "funds_reinstated", value: any, ctx: StripeEventContext) {
  const order = await selectOne("billing_orders", `stripe_charge_id=eq.${encodeURIComponent(typeof value.charge === "string" ? value.charge : value.charge?.id)}`);
  if (!order) return;
  if (!(await eventBelongsToProvider(order.provider_id, ctx))) return;
  const won = value.status === "won";
  await insert("billing_disputes", { order_id: order.id, stripe_dispute_id: value.id, amount_cents: value.amount,
    status: value.status, reason: value.reason ?? null, evidence_due_by: value.evidence_details?.due_by ? new Date(value.evidence_details.due_by * 1000).toISOString() : null,
    closed_at: event === "closed" ? nowIso() : null }).catch(async () => {
      await update("billing_disputes", `stripe_dispute_id=eq.${encodeURIComponent(value.id)}`, {
        status: value.status,
        evidence_due_by: value.evidence_details?.due_by ? new Date(value.evidence_details.due_by * 1000).toISOString() : null,
        ...(event === "closed" ? { closed_at: nowIso() } : {}),
      });
    });
  if (event !== "updated") {
    await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}`, {
      status: event === "created" || event === "funds_withdrawn" || !won ? "disputed" : "paid",
    });
  }
  const kind = event === "created" || event === "funds_withdrawn" ? "dispute_opened" : won || event === "funds_reinstated" ? "dispute_won" : "dispute_lost";
  if (event === "updated") return;
  if (!(await selectOne("billing_ledger", `kind=eq.${kind}&stripe_ref=eq.${encodeURIComponent(value.id)}`))) {
    await insertIgnore("billing_ledger", { provider_id: order.provider_id, order_id: order.id, subscription_id: order.subscription_id,
      kind, amount_cents: event === "created" || event === "funds_withdrawn" ? -value.amount : won || event === "funds_reinstated" ? value.amount : 0, application_fee_cents: 0,
      stripe_ref: value.id, detail: { status: value.status }, occurred_at: nowIso() }, "billing_ledger_kind_stripe_ref_unique");
  }
}
export function registerOrderWebhookHandlers(): void {
  onStripeEvent("invoice.paid", async (event, ctx) => {
    const invoice: any = event.data.object;
    if (invoice.billing_reason === "subscription_create" || invoice.billing_reason === "subscription_cycle") {
      await (await import("./subscriptions")).markSubscriptionInvoicePaid(invoice, ctx); return;
    }
    await markOrderPaidFromInvoice(invoice, ctx);
  });
  const failed = async (event: Stripe.Event, ctx: StripeEventContext) => {
    const object: any = event.data.object;
    if (object.object === "invoice" && (object.billing_reason === "subscription_create" || object.billing_reason === "subscription_cycle")) {
      await (await import("./subscriptions")).markSubscriptionInvoiceFailed(object, ctx);
      return;
    }
    const query = object.object === "invoice" ? `stripe_invoice_id=eq.${encodeURIComponent(object.id)}` : `stripe_payment_intent_id=eq.${encodeURIComponent(object.id)}`;
    const order = await selectOne("billing_orders", query);
    if (order && await eventBelongsToProvider(order.provider_id, ctx)) {
      if (object.object === "payment_intent" && order.subscription_id && object.invoice && ctx.account) {
        const invoiceId = typeof object.invoice === "string" ? object.invoice : object.invoice.id;
        const invoice = await (await getStripe()).invoices.retrieve(
          invoiceId, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(ctx.account),
        );
        await (await import("./subscriptions")).markSubscriptionInvoiceFailed(invoice, ctx);
        return;
      }
      const rawMessage = object.last_payment_error?.message ?? paymentIntent(object)?.last_payment_error?.message;
      const message = typeof rawMessage === "string"
        ? rawMessage.replace(/\b(?:\d[ -]*?){12,19}\b/g, "[card number removed]").trim().slice(0, 200)
        : null;
      await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}&status=in.(pending,failed)`, { status: "failed", failure_message: message });
    }
  };
  onStripeEvent("invoice.payment_failed", failed);
  onStripeEvent("payment_intent.payment_failed", failed);
  onStripeEvent("charge.refunded", async (event, ctx) => reconcileRefund(event.data.object, ctx));
  onStripeEvent("refund.updated", async (event, ctx) => {
    const value: any = event.data.object;
    if (value.status !== "failed" && value.status !== "canceled") return;
    const existing = await selectOne("billing_refunds", `stripe_refund_id=eq.${encodeURIComponent(value.id)}`);
    if (!existing) return;
    const order = await selectOne("billing_orders", `id=eq.${encodeURIComponent(existing.order_id)}`);
    if (!order || !(await eventBelongsToProvider(order.provider_id, ctx))) return;
    await update("billing_refunds", `stripe_refund_id=eq.${encodeURIComponent(value.id)}`, { status: value.status });
    const debit = await selectOne("billing_ledger", `kind=eq.refund&stripe_ref=eq.${encodeURIComponent(value.id)}`);
    if (debit) {
      await insertIgnore("billing_ledger", {
        provider_id: order.provider_id, order_id: order.id, subscription_id: order.subscription_id,
        kind: "refund", amount_cents: existing.amount_cents, application_fee_cents: 0,
        stripe_ref: `${value.id}:reversal`, detail: { status: value.status }, occurred_at: nowIso(),
      }, "billing_ledger_kind_stripe_ref_unique");
    }
    const refunds = await selectMany("billing_refunds", `order_id=eq.${encodeURIComponent(order.id)}`);
    const succeeded = refunds.filter((row) => row.stripe_refund_id !== value.id && row.status === "succeeded")
      .reduce((sum, row) => sum + row.amount_cents, 0);
    await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}`, {
      status: succeeded >= order.total_cents ? "refunded" : succeeded > 0 ? "partially_refunded" : "paid",
    });
  });
  onStripeEvent("charge.dispute.created", async (event, ctx) => dispute("created", event.data.object, ctx));
  onStripeEvent("charge.dispute.updated", async (event, ctx) => dispute("updated", event.data.object, ctx));
  onStripeEvent("charge.dispute.closed", async (event, ctx) => dispute("closed", event.data.object, ctx));
  onStripeEvent("charge.dispute.funds_withdrawn", async (event, ctx) => dispute("funds_withdrawn", event.data.object, ctx));
  onStripeEvent("charge.dispute.funds_reinstated", async (event, ctx) => dispute("funds_reinstated", event.data.object, ctx));
  onStripeEvent("invoice.finalized", async (event, ctx) => {
    const invoice: any = event.data.object;
    const paymentIntent = typeof invoice.payment_intent === "string" ? invoice.payment_intent : invoice.payment_intent?.id;
    if (!paymentIntent) return;
    const order = await selectOne("billing_orders", `stripe_payment_intent_id=eq.${encodeURIComponent(paymentIntent)}`);
    if (order?.status === "pending" && !order.stripe_invoice_id && await eventBelongsToProvider(order.provider_id, ctx)) {
      await update("billing_orders", `id=eq.${encodeURIComponent(order.id)}`, { stripe_invoice_id: invoice.id });
    }
  });
  onStripeEvent("customer.subscription.created", async (event, ctx) => {
    await dispatchStripeEvent({ ...event, type: "customer.subscription.updated" } as Stripe.Event, ctx);
  });
}
