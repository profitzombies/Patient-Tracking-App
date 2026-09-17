import { logger } from "../lib/logger";
import {
  BillingCartError, abandonCart, attachCard, checkoutStatus, existingCheckout, failOrder, insertCartRows, intentOf,
  isAmbiguousStripeFailure, productIdsByOrder, resolveCart, resolveSubscriptionPrices, resumeAccount, type CheckoutInput, type InternalGroup,
} from "./cart";
import { getSettings } from "./catalog";
import { ensureCustomer } from "./customers";
import { applicationFeePercentFor } from "./fees";
import { resolvePayer } from "./links";
import { markOrderPaidFromInvoice } from "./orders";
import { connectedOpts, getPublishableKey, getStripe, isSandbox } from "./stripe-client";
import {
  selectMany, selectOne, update, type BillingCartRow, type BillingConnectedAccountRow, type BillingOrderRow,
  type BillingPaymentLinkRow, type BillingSettingsRow,
} from "./store";
import { markSubscriptionInvoicePaid, nextShipmentAt, periodEnd } from "./subscriptions";
import { BillingTerminalError, ensureTerminalLocation } from "./terminal";
import type {
  CartCheckoutItem, CartCheckoutResponse, CartLineInput, ShippingAddress, TapCancelResponse, TapCaptureResponse, TapCardOnFile, TapSaleItem,
  TapSaleResponse,
} from "./types";
import type { StripeEventContext } from "./webhooks";

/**
 * Tap to Pay sales: the same cart, order, subscription, invoice and ledger
 * records as a card sale, with the money collected on a card-present
 * PaymentIntent per order group instead of `invoices.pay`.
 *
 * Why not pay the invoice with the tapped card: Stripe refuses to attach
 * outside payments to invoices carrying an application fee, and card-present
 * intents cannot pay invoices directly. So each group keeps its invoice (tax,
 * receipts, renewals unchanged), gets ONE card-present intent for the invoice
 * total with the exact application fee, and once the intent is captured the
 * invoice is marked paid out of band. The existing invoice.paid reconciliation
 * then runs unchanged; it reads the charge from the intent stored on the order.
 *
 * Every step keys on the deterministic order id, so a lost response replays.
 */
const enc = encodeURIComponent;
/** Sentinel card id in the cart fingerprint: a tap cart is never resumable as a typed-card cart under the same key. */
export const TAP_PAYMENT_METHOD = "tap_to_pay";
export type TapSaleInput = {
  patientId: string; providerId: string; cartId: string; lines: CartLineInput[]; shipping_address: ShippingAddress;
  /** The pre-tax total the staff member saw on the button; a fresh cart that no longer prices to it is refused (409). */
  expected_total_cents?: number | null;
};
export const ACCOUNT_CHANGED_MESSAGE = "Your office connected a different Stripe account while this sale was open. Nothing was charged; start the sale again.";
export type TapCancelReason = "declined" | "canceled" | "fallback";
const CANCEL_MESSAGES: Record<TapCancelReason, string> = {
  declined: "The card was declined.",
  canceled: "Tap to Pay was canceled before the patient tapped.",
  fallback: "The sale was moved to another payment method.",
};
const PAID_STATES = ["paid", "partially_refunded", "refunded", "disputed"];

function checkoutInput(input: TapSaleInput): CheckoutInput {
  return { ...input, payment_method_id: TAP_PAYMENT_METHOD };
}
function itemBase(order: BillingOrderRow): TapSaleItem {
  return {
    kind: order.kind === "one_time" ? "one_time" : "subscription", order_id: order.id, order_number: order.order_number,
    subscription_id: order.subscription_id, payment_intent_id: null, client_secret: null, status: "failed", error: null,
    total_cents: order.total_cents,
  };
}
async function paidItem(order: BillingOrderRow): Promise<CartCheckoutItem> {
  const productIds = await productIdsByOrder([order.id]);
  return {
    kind: order.kind === "one_time" ? "one_time" : "subscription", order_id: order.id, order_number: order.order_number,
    subscription_id: order.subscription_id, status: "paid", client_secret: null, error: null, total_cents: order.total_cents,
    tax_cents: order.tax_cents ?? 0, product_ids: productIds.get(order.id) ?? [],
  };
}
function eventContext(account: BillingConnectedAccountRow, livemode: boolean): StripeEventContext {
  return { kind: "connect", account: account.stripe_account_id, livemode };
}
async function settingsFor(order: BillingOrderRow): Promise<BillingSettingsRow> {
  return (order.metadata?.settings as BillingSettingsRow | undefined) ?? await getSettings();
}

async function tapIntent(
  stripe: any, account: BillingConnectedAccountRow, customerId: string, order: BillingOrderRow, group: InternalGroup,
  amount: number, cartId: string, invoiceId: string, saveCard: boolean,
): Promise<any> {
  return stripe.paymentIntents.create({
    amount, currency: "usd", customer: customerId, payment_method_types: ["card_present"], capture_method: "manual",
    application_fee_amount: group.application_fee_cents, description: `Order ${order.order_number}`,
    // A subscription's first tap should also become the renewal card when the
    // network allows (contactless cards do, most wallets do not).
    ...(saveCard ? { setup_future_usage: "off_session" } : {}),
    metadata: { thinnr_order_id: order.id, thinnr_cart_id: cartId, thinnr_invoice_id: invoiceId, thinnr_source: "tap_to_pay" },
  }, connectedOpts(account.stripe_account_id, `order:${order.id}:terminal`));
}

async function prepareOneTime(
  stripe: any, account: BillingConnectedAccountRow, customerId: string, input: TapSaleInput, order: BillingOrderRow,
  group: InternalGroup, ctx: StripeEventContext, settings: BillingSettingsRow,
): Promise<TapSaleItem> {
  const acct = account.stripe_account_id;
  const base = itemBase(order);
  // After the invoice exists at Stripe, no later error may mark the order
  // failed: the resume replays every step by key instead.
  let stripeObjectCreated = false;
  try {
    const invoice = await stripe.invoices.create({
      customer: customerId, collection_method: "charge_automatically", auto_advance: false,
      automatic_tax: { enabled: account.tax_enabled }, application_fee_amount: group.application_fee_cents,
      metadata: { thinnr_order_id: order.id, thinnr_cart_id: input.cartId, thinnr_source: "tap_to_pay" }, pending_invoice_items_behavior: "exclude",
    } as any, connectedOpts(acct, `order:${order.id}:invoice`));
    stripeObjectCreated = true;
    for (const line of group.lines) {
      await stripe.invoiceItems.create({
        customer: customerId, invoice: invoice.id, quantity: line.quantity, currency: "usd",
        unit_amount_decimal: String(line.unit_price_cents), description: line.name,
        ...(line.stripe_tax_code ? { tax_code: line.stripe_tax_code } : {}),
      } as any, connectedOpts(acct, `order:${order.id}:item:${line.product_id}`));
    }
    await stripe.invoiceItems.create({
      customer: customerId, invoice: invoice.id, quantity: 1, currency: "usd",
      unit_amount_decimal: String(group.shipping_charge_cents), description: "Shipping",
    } as any, connectedOpts(acct, `order:${order.id}:shipping`));
    const finalized: any = await stripe.invoices.finalizeInvoice(invoice.id, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(acct, `order:${order.id}:finalize`));
    const tax = Number(finalized.total_taxes?.reduce((sum: number, row: any) => sum + (row.amount ?? 0), 0) ?? finalized.tax ?? 0);
    const total = Number(finalized.total ?? order.total_cents);
    if (finalized.status === "paid") {
      await update("billing_orders", `id=eq.${enc(order.id)}`, { stripe_invoice_id: finalized.id, stripe_payment_intent_id: intentOf(finalized)?.id ?? null, tax_cents: tax, total_cents: total });
      await markOrderPaidFromInvoice(finalized, ctx);
      return { ...base, status: "paid", total_cents: total };
    }
    const intent = await tapIntent(stripe, account, customerId, order, group, total, input.cartId, finalized.id, false);
    await update("billing_orders", `id=eq.${enc(order.id)}`, {
      stripe_invoice_id: finalized.id, stripe_payment_intent_id: intent.id, tax_cents: tax, total_cents: total,
    });
    return { ...base, status: "ready", payment_intent_id: intent.id, client_secret: intent.client_secret ?? null, total_cents: total };
  } catch (error) {
    logger.error({ err: error, orderId: order.id, stripeObjectCreated }, "tap to pay one-time order initialization failed");
    if (stripeObjectCreated || isAmbiguousStripeFailure(error)) throw error;
    await failOrder(order, settings, "Payment could not be started. Please try again.", null);
    return { ...base, error: "Payment could not be started. Please try again." };
  }
}

async function prepareSubscription(
  stripe: any, account: BillingConnectedAccountRow, customerId: string, input: TapSaleInput, order: BillingOrderRow,
  subscriptionId: string, group: InternalGroup, ctx: StripeEventContext, settings: BillingSettingsRow, mirrorAllowed: boolean,
): Promise<TapSaleItem> {
  const acct = account.stripe_account_id;
  const line = group.lines[0];
  const weeks = line.cadence_weeks ?? 4;
  const base = itemBase(order);
  const priced = await resolveSubscriptionPrices(input.providerId, subscriptionId, line, mirrorAllowed);
  if ("error" in priced) {
    await failOrder(order, settings, priced.error, subscriptionId);
    return { ...base, error: priced.error };
  }
  let stripeObjectCreated = false;
  try {
    // No payment method yet: the first invoice stays open until the tap is
    // captured and it is marked paid out of band, which activates the
    // subscription. Renewals then charge the saved card like any other.
    const subscription: any = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priced.cadence.price_id, quantity: line.quantity }, { price: priced.cadence.shipping_price_id, quantity: 1 }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      application_fee_percent: applicationFeePercentFor(group.application_fee_cents, group.total_cents),
      automatic_tax: { enabled: account.tax_enabled },
      metadata: { thinnr_subscription_id: subscriptionId, thinnr_order_id: order.id, thinnr_cart_id: input.cartId, thinnr_source: "tap_to_pay" },
    } as any, connectedOpts(acct, `subscription:${subscriptionId}`));
    stripeObjectCreated = true;
    const latest = typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice?.id;
    if (!latest) throw new Error("Subscription has no first invoice.");
    const invoice: any = await stripe.invoices.retrieve(latest, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(acct));
    const renews = periodEnd(subscription) ?? new Date(Date.now() + weeks * 7 * 86400_000).toISOString();
    await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}`, {
      stripe_subscription_id: subscription.id, stripe_customer_id: customerId, current_period_end: renews,
      next_shipment_at: nextShipmentAt(subscription) ?? renews,
    });
    const total = Number(invoice.total ?? group.total_cents);
    const tax = Math.max(0, total - group.total_cents);
    if (invoice.status === "paid") {
      await update("billing_orders", `id=eq.${enc(order.id)}`, { stripe_invoice_id: invoice.id, stripe_payment_intent_id: intentOf(invoice)?.id ?? null, tax_cents: tax, total_cents: total });
      await markSubscriptionInvoicePaid({ ...invoice, billing_reason: invoice.billing_reason ?? "subscription_create" }, ctx);
      await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}&status=eq.incomplete`, { status: "active" });
      return { ...base, status: "paid", total_cents: total };
    }
    const intent = await tapIntent(stripe, account, customerId, order, group, total, input.cartId, invoice.id, true);
    await update("billing_orders", `id=eq.${enc(order.id)}`, {
      stripe_invoice_id: invoice.id, stripe_payment_intent_id: intent.id, tax_cents: tax, total_cents: total,
    });
    return { ...base, status: "ready", payment_intent_id: intent.id, client_secret: intent.client_secret ?? null, total_cents: total };
  } catch (error) {
    logger.error({ err: error, orderId: order.id, subscriptionId, stripeObjectCreated }, "tap to pay subscription initialization failed");
    if (stripeObjectCreated || isAmbiguousStripeFailure(error)) throw error;
    await failOrder(order, settings, "Subscription could not be started. Please try again.", subscriptionId);
    return { ...base, error: "Subscription could not be started. Please try again." };
  }
}

/**
 * Finishes an order whose card-present intent has been authorized (or already
 * captured): capture, mark the invoice paid out of band, and run the same
 * paid-invoice bookkeeping a card sale runs. Idempotent by order id.
 */
async function finishTapOrder(
  stripe: any, account: BillingConnectedAccountRow, order: BillingOrderRow, intent: any,
): Promise<{ order: BillingOrderRow; card_on_file: TapCardOnFile }> {
  const acct = account.stripe_account_id;
  const ctx = eventContext(account, order.livemode);
  let captured: any = intent;
  if (intent.status === "requires_capture") {
    captured = await stripe.paymentIntents.capture(intent.id, { expand: ["latest_charge"] } as any, connectedOpts(acct, `order:${order.id}:capture`));
  }
  if (captured.status !== "succeeded") throw new BillingTerminalError("The payment could not be captured. Try the tap again.", 409);
  if (!order.stripe_invoice_id) throw new BillingTerminalError("This sale has no invoice to settle.", 409);
  let invoice: any;
  try {
    invoice = await stripe.invoices.pay(order.stripe_invoice_id, { paid_out_of_band: true, expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(acct, `order:${order.id}:paid-out-of-band`));
  } catch (error: any) {
    if (!(error?.code === "invoice_already_paid" || /already paid/i.test(String(error?.message ?? "")))) throw error;
    invoice = await stripe.invoices.retrieve(order.stripe_invoice_id, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(acct));
  }
  if (invoice?.status !== "paid") throw new BillingTerminalError("The invoice could not be settled. Try again.", 503);
  // The money is on the card-present intent, not on the invoice's own intent:
  // hand the reconciler the real one so the charge, fee and net are exact.
  const settled = { ...invoice, payment_intent: captured.id };
  if (order.subscription_id) {
    await markSubscriptionInvoicePaid({ ...settled, billing_reason: invoice.billing_reason ?? "subscription_create" }, ctx);
    await update("billing_subscriptions", `id=eq.${enc(order.subscription_id)}&status=eq.incomplete`, { status: "active" });
  } else {
    await markOrderPaidFromInvoice(settled, ctx);
  }
  const card_on_file = order.subscription_id ? await saveGeneratedCard(stripe, account, order, captured) : null;
  const paid = await selectOne("billing_orders", `id=eq.${enc(order.id)}`);
  return { order: paid ?? { ...order, status: "paid" }, card_on_file };
}

/**
 * A tapped physical card yields a reusable `generated_card`; make it the
 * subscription's renewal card. Wallets usually do not, so the caller then asks
 * for a card to keep on file. Never fatal: the sale is already recorded.
 */
async function saveGeneratedCard(stripe: any, account: BillingConnectedAccountRow, order: BillingOrderRow, intent: any): Promise<TapCardOnFile> {
  const acct = account.stripe_account_id;
  const stored = order.metadata?.card_on_file;
  if (stored === "saved") return "saved";
  const subscription = order.subscription_id ? await selectOne("billing_subscriptions", `id=eq.${enc(order.subscription_id)}`) : null;
  if (!subscription?.stripe_subscription_id) return "needed";
  try {
    let charge: any = intent.latest_charge;
    if (typeof charge === "string" || !charge) {
      const loaded: any = await stripe.paymentIntents.retrieve(intent.id, { expand: ["latest_charge"] } as any, connectedOpts(acct));
      charge = loaded.latest_charge;
    }
    const generated = charge?.payment_method_details?.card_present?.generated_card;
    if (typeof generated !== "string" || !generated) {
      await rememberCardOnFile(order, "needed");
      return "needed";
    }
    await stripe.subscriptions.update(subscription.stripe_subscription_id, { default_payment_method: generated }, connectedOpts(acct, `subscription:${subscription.id}:tap-card`));
    if (subscription.stripe_customer_id) {
      const customer: any = await stripe.customers.retrieve(subscription.stripe_customer_id, {}, connectedOpts(acct));
      const current = customer?.invoice_settings?.default_payment_method;
      if (!(typeof current === "string" ? current : current?.id)) {
        await stripe.customers.update(subscription.stripe_customer_id, { invoice_settings: { default_payment_method: generated } }, connectedOpts(acct));
      }
    }
    await rememberCardOnFile(order, "saved");
    return "saved";
  } catch (error) {
    logger.warn({ err: error, orderId: order.id }, "tap to pay renewal card could not be saved");
    await rememberCardOnFile(order, "needed");
    return "needed";
  }
}
async function rememberCardOnFile(order: BillingOrderRow, state: "saved" | "needed"): Promise<void> {
  const current = await selectOne("billing_orders", `id=eq.${enc(order.id)}`);
  await update("billing_orders", `id=eq.${enc(order.id)}`, { metadata: { ...((current ?? order).metadata ?? {}), card_on_file: state } });
}

/** Current state of one tap order, healing a lost capture response on the way. */
async function replayItem(stripe: any, account: BillingConnectedAccountRow | null, order: BillingOrderRow): Promise<TapSaleItem> {
  const base = itemBase(order);
  if (PAID_STATES.includes(order.status)) return { ...base, status: "paid" };
  if (order.status === "failed") return { ...base, error: order.failure_message ?? "Payment failed." };
  if (!order.stripe_payment_intent_id || !account) return { ...base, error: "Payment could not be started. Please try again." };
  try {
    const intent: any = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, { expand: ["latest_charge"] } as any, connectedOpts(account.stripe_account_id));
    if (intent.status === "requires_capture" || intent.status === "succeeded") {
      // The patient tapped but the capture call never landed: finish it now.
      await finishTapOrder(stripe, account, order, intent);
      return { ...base, status: "paid" };
    }
    if (intent.status === "canceled") {
      await failOrder(order, await settingsFor(order), "Tap to Pay was canceled.", order.subscription_id);
      return { ...base, error: "Tap to Pay was canceled." };
    }
    return { ...base, status: "ready", payment_intent_id: intent.id, client_secret: intent.client_secret ?? null };
  } catch (error) {
    if (error instanceof BillingTerminalError) throw error;
    logger.warn({ err: error, orderId: order.id }, "tap to pay replay could not read the payment intent");
    return { ...base, status: "ready", payment_intent_id: order.stripe_payment_intent_id };
  }
}

async function tapResponse(cartId: string, account: BillingConnectedAccountRow, items: TapSaleItem[]): Promise<TapSaleResponse> {
  return { cart_id: cartId, items, stripe_account_id: account.stripe_account_id, location_id: account.terminal_location_id ?? "", sandbox: await isSandbox() };
}

async function cartOf(providerId: string, cartId: string): Promise<{ cart: BillingCartRow; account: BillingConnectedAccountRow; sameAccount: boolean }> {
  const cart = await selectOne("billing_carts", `id=eq.${enc(cartId)}&provider_id=eq.${enc(providerId)}`);
  if (!cart) throw new BillingTerminalError("That sale was not found.", 404);
  const { account, sameAccount } = await resumeAccount(cart, providerId);
  return { cart, account, sameAccount };
}
/**
 * A staged tap whose office has since connected a DIFFERENT Stripe account is
 * terminal: capturing on the pinned account would move money somewhere the
 * rest of billing treats as foreign, so every authorization is released there
 * (an intent that already captured is refused loudly, never hidden) and the
 * rows are failed honestly. Uses the pinned account: that is where the objects live.
 */
async function releaseSwappedSale(stripe: any, cart: BillingCartRow, pinned: BillingConnectedAccountRow, settings: BillingSettingsRow): Promise<never> {
  await abandonCart(stripe, pinned, { cartId: cart.id, patientId: cart.patient_id }, settings, ACCOUNT_CHANGED_MESSAGE, { cleanupFailed: true });
  throw new BillingTerminalError(ACCOUNT_CHANGED_MESSAGE, 409);
}

/**
 * Stages a Tap to Pay sale: rows, invoices/subscriptions and one card-present
 * intent per group. The phone collects and confirms each intent with the
 * Terminal SDK, then calls `captureTapSale` per order. Re-sending the same
 * cart key replays the current state instead of creating anything twice.
 */
export async function startTapSale(input: TapSaleInput): Promise<TapSaleResponse> {
  const asCheckout = checkoutInput(input);
  const resolved = await resolveCart(asCheckout);
  const stripe = await getStripe();
  if (resolved.kind === "response") {
    const { account } = await cartOf(input.providerId, input.cartId);
    const orders = await selectMany("billing_orders", `cart_id=eq.${enc(input.cartId)}&patient_id=eq.${enc(input.patientId)}&order=created_at.asc,id.asc`);
    const items: TapSaleItem[] = [];
    for (const order of orders) items.push(await replayItem(stripe, account, order));
    return tapResponse(input.cartId, account, items);
  }
  const { plan, mirrorAllowed } = resolved;
  const located = await ensureTerminalLocation(input.providerId, resolved.account);
  const account = located.account;
  const payer = await resolvePayer(input.providerId, { patient_id: input.patientId } as BillingPaymentLinkRow);
  const customerId = await ensureCustomer(payer, input.shipping_address, account);
  const livemode = !await isSandbox();
  const ctx = eventContext(account, livemode);
  const pending = await insertCartRows(asCheckout, plan, payer, customerId, livemode, "tap_to_pay");
  const items: TapSaleItem[] = [];
  for (const entry of pending) {
    if (entry.order.status !== "pending") { items.push(await replayItem(stripe, account, entry.order)); continue; }
    items.push(entry.subscriptionId
      ? await prepareSubscription(stripe, account, customerId, input, entry.order, entry.subscriptionId, entry.group, ctx, plan.settings, mirrorAllowed)
      : await prepareOneTime(stripe, account, customerId, input, entry.order, entry.group, ctx, plan.settings));
  }
  // "ready" = every group was staged; a retry from here on replays, never re-stages.
  await update("billing_carts", `id=eq.${enc(input.cartId)}`, { status: "ready" });
  return tapResponse(input.cartId, account, items);
}

/** After the phone confirmed the tap: capture and record the order. Safe to repeat. */
export async function captureTapSale(providerId: string, cartId: string, orderId: string): Promise<TapCaptureResponse> {
  const { cart, account, sameAccount } = await cartOf(providerId, cartId);
  const order = await selectOne("billing_orders", `id=eq.${enc(orderId)}&cart_id=eq.${enc(cartId)}&provider_id=eq.${enc(providerId)}`);
  if (!order) throw new BillingTerminalError("That order was not found.", 404);
  if (order.metadata?.source !== "tap_to_pay") throw new BillingTerminalError("That order was not started with Tap to Pay.", 409);
  const stripe = await getStripe();
  const checkout = async () => (await existingCheckout(cartId, cart.patient_id)) ?? emptyCheckout(cartId, account);
  if (PAID_STATES.includes(order.status)) {
    const stored = order.metadata?.card_on_file;
    return { item: await paidItem(order), card_on_file: order.subscription_id ? (stored === "saved" ? "saved" : "needed") : null, checkout: await checkout() };
  }
  if (order.status !== "pending" || !order.stripe_payment_intent_id) {
    throw new BillingTerminalError(order.failure_message ?? "This order can no longer be captured.", 409);
  }
  if (!sameAccount) await releaseSwappedSale(stripe, cart, account, await settingsFor(order));
  const intent: any = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, { expand: ["latest_charge"] } as any, connectedOpts(account.stripe_account_id));
  if (intent.status === "canceled") {
    await failOrder(order, await settingsFor(order), "Tap to Pay was canceled.", order.subscription_id);
    throw new BillingTerminalError("Tap to Pay was canceled.", 409);
  }
  if (intent.status !== "requires_capture" && intent.status !== "succeeded") {
    throw new BillingTerminalError("The patient has not tapped yet. Finish the tap on the phone first.", 409);
  }
  const finished = await finishTapOrder(stripe, account, order, intent);
  return { item: await paidItem(finished.order), card_on_file: finished.card_on_file, checkout: await checkout() };
}

function emptyCheckout(cartId: string, account: BillingConnectedAccountRow): CartCheckoutResponse {
  return { cart_id: cartId, status: checkoutStatus([]), items: [], stripe_account_id: account.stripe_account_id, publishable_key: "", sandbox: !account.livemode };
}

/**
 * The provider gave up on the tap (declined card, canceled, or switched to the
 * card form / QR code): every order that was never authorized is failed and
 * its Stripe objects voided. An order whose tap DID authorize in the meantime
 * is finished, never thrown away with the patient's money on hold.
 */
export const SETTLEMENT_UNKNOWN_MESSAGE = "Stripe could not confirm what happened to the tap yet. Check the payment again in a moment.";

/**
 * Settles a Tap to Pay cart and answers with what is now PROVEN about the
 * money. This is the phone's only way out of a lost reply, so it fails closed:
 * an authorization it finds is captured and recorded, everything else is
 * voided through {@link abandonCart} (which will not fail a row until Stripe
 * has refused to let its intent settle), and any read or void that could not
 * be completed is a 503 `settlement_unknown`, never a guessed "failed". A
 * capture that raced ahead of the void surfaces as 409 `manual_resolution`.
 */
export async function cancelTapSale(providerId: string, cartId: string, reason: TapCancelReason, detail?: string | null): Promise<TapCancelResponse> {
  const { cart, account, sameAccount } = await cartOf(providerId, cartId);
  const stripe = await getStripe();
  const orders = await selectMany("billing_orders", `cart_id=eq.${enc(cartId)}&provider_id=eq.${enc(providerId)}&status=in.(pending,failed)`);
  const settings = (orders[0]?.metadata?.settings as BillingSettingsRow | undefined) ?? await getSettings();
  const message = detail?.trim() ? `${CANCEL_MESSAGES[reason]} ${detail.trim().slice(0, 200)}` : CANCEL_MESSAGES[reason];
  let response: CartCheckoutResponse;
  try {
    if (sameAccount) {
      for (const order of orders) {
        if (order.status !== "pending" || order.metadata?.source !== "tap_to_pay" || !order.stripe_payment_intent_id) continue;
        const intent: any = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, { expand: ["latest_charge"] } as any, connectedOpts(account.stripe_account_id));
        if (intent.status === "requires_capture" || intent.status === "succeeded") await finishTapOrder(stripe, account, order, intent);
      }
      response = await abandonCart(stripe, account, { cartId, patientId: cart.patient_id }, settings, message, { cleanupFailed: true });
    } else {
      // A swapped account can capture nothing: every authorization is released
      // on the pinned account (anything already captured there is refused) and
      // that release IS the definite answer, so the phone may start over.
      response = await abandonCart(stripe, account, { cartId, patientId: cart.patient_id }, settings, ACCOUNT_CHANGED_MESSAGE, { cleanupFailed: true });
    }
  } catch (error) {
    if (error instanceof BillingCartError && error.status === 409) throw new BillingTerminalError(error.message, 409, "manual_resolution");
    if (error instanceof BillingTerminalError || error instanceof BillingCartError) throw error;
    logger.warn({ err: error, cartId }, "tap to pay settle could not complete; the phone stays locked");
    throw new BillingTerminalError(SETTLEMENT_UNKNOWN_MESSAGE, 503, "settlement_unknown");
  }
  const paid = response.items.filter((item) => item.status === "paid").length;
  return {
    ...response, publishable_key: await getPublishableKey(),
    settlement: paid === 0 ? "not_charged" : paid === response.items.length ? "paid" : "partial",
  };
}

/** A card the provider typed after a tap that could not be saved: becomes the subscription's renewal card. */
export async function saveTapCardOnFile(providerId: string, cartId: string, subscriptionId: string, paymentMethodId: string): Promise<{ saved: true }> {
  const { account, sameAccount } = await cartOf(providerId, cartId);
  if (!sameAccount) throw new BillingTerminalError("Your office connected a different Stripe account since this sale; the renewal card cannot be saved here.", 409);
  const subscription = await selectOne("billing_subscriptions", `id=eq.${enc(subscriptionId)}&provider_id=eq.${enc(providerId)}`);
  const order = subscription ? await selectOne("billing_orders", `subscription_id=eq.${enc(subscriptionId)}&cart_id=eq.${enc(cartId)}`) : null;
  if (!subscription || !order) throw new BillingTerminalError("That subscription was not found.", 404);
  if (!subscription.stripe_subscription_id || !subscription.stripe_customer_id) throw new BillingTerminalError("That subscription has not started yet.", 409);
  const stripe = await getStripe();
  try {
    await attachCard(stripe, account, subscription.stripe_customer_id, paymentMethodId, cartId, false);
  } catch (error) {
    if (error instanceof BillingCartError) throw new BillingTerminalError(error.message, error.status);
    throw error;
  }
  await stripe.subscriptions.update(subscription.stripe_subscription_id, { default_payment_method: paymentMethodId }, connectedOpts(account.stripe_account_id));
  await rememberCardOnFile(order, "saved");
  return { saved: true };
}
