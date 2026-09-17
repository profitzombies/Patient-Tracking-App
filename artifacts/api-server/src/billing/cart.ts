import crypto from "node:crypto";
import { logger } from "../lib/logger";
import { getSettings, productCadences, resolveOffering, subscribeSavePercent, subscriptionUnitPrice } from "./catalog";
import { ensureCustomer } from "./customers";
import { applicationFeePercentFor, breakEvenMinimum, computeOrderFees, hqProfit } from "./fees";
import { resolvePayer } from "./links";
import { markOrderPaidFromInvoice } from "./orders";
import { ensureRecurringPrices } from "./prices";
import { connectedOpts, getPublishableKey, getStripe, isSandbox, isStripeMissing } from "./stripe-client";
import {
  insert, insertIgnore, nowIso, selectMany, selectOne, update, type BillingCartRow, type BillingConnectedAccountRow,
  type BillingOrderRow, type BillingPaymentLinkRow, type BillingPayerRow, type BillingProductRow, type BillingSettingsRow,
} from "./store";
import { markSubscriptionInvoicePaid, nextShipmentAt, periodEnd } from "./subscriptions";
import type {
  CartCheckoutItem, CartCheckoutResponse, CartLineInput, CartQuote, CartQuoteGroup, CartQuoteLine, CheckoutStatus,
  ShippingAddress,
} from "./types";
import type { StripeEventContext } from "./webhooks";

export class BillingCartError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}

const enc = encodeURIComponent;
export const MAX_CART_LINES = 20;
export const MAX_LINE_QUANTITY = 10;

type InternalLine = CartQuoteLine & {
  product: BillingProductRow; floor_price_cents: number; hard_cost_cents: number; stripe_tax_code: string | null;
};
export type InternalGroup = CartQuoteGroup & {
  lines: InternalLine[]; application_fee_cents: number; thinnr_share_cents: number;
  hard_cost_cents: number; shipping_cost_cents: number;
};
export type CartPlan = { quote: CartQuote; groups: InternalGroup[]; settings: BillingSettingsRow };

/**
 * Sales tax the office's own Stripe Tax settings will add at payment, estimated
 * for this cart shipped to this address. The checkout invoices run automatic
 * tax on the connected account, so the estimate uses the same engine, the same
 * product tax codes, and the same address (shipping is taxed as its own line).
 * Offices that do not collect tax owe nothing extra; the quote's total is exact.
 */
export async function estimateCartTax(
  account: Pick<BillingConnectedAccountRow, "stripe_account_id" | "tax_enabled">, plan: CartPlan, address: ShippingAddress,
): Promise<number> {
  if (!account.tax_enabled) return 0;
  const stripe = await getStripe();
  // One calculation PER GROUP, each with its own shipping line: checkout
  // finalizes one Stripe invoice per group (one-time order, each subscription),
  // and tax rounds per invoice, so a single whole-cart calculation can differ
  // from the sum Stripe actually bills by a cent per group.
  let total = 0;
  for (const [index, group] of plan.groups.entries()) {
    let calculation: any;
    try {
      calculation = await stripe.tax.calculations.create({
        currency: "usd",
        line_items: group.lines.map((line, lineIndex) => ({
          amount: line.line_total_cents, quantity: line.quantity, reference: `${index}:${lineIndex}:${line.product_id}`,
          ...(line.stripe_tax_code ? { tax_code: line.stripe_tax_code } : {}),
        })),
        ...(group.shipping_charge_cents > 0 ? { shipping_cost: { amount: group.shipping_charge_cents } } : {}),
        customer_details: {
          address: {
            line1: address.line1, line2: address.line2 ?? undefined, city: address.city, state: address.state,
            postal_code: address.postal_code, country: address.country,
          },
          address_source: "shipping",
        },
      }, connectedOpts(account.stripe_account_id));
    } catch (error) {
      logger.error({ err: error, account: account.stripe_account_id }, "patient cart tax estimate failed");
      throw new BillingCartError("Sales tax couldn't be calculated for this address right now. Please try again.", 503, "shipping_address");
    }
    const exclusive = Number(calculation?.tax_amount_exclusive ?? 0);
    if (!Number.isFinite(exclusive) || exclusive < 0) {
      throw new BillingCartError("Sales tax couldn't be calculated for this address right now. Please try again.", 503, "shipping_address");
    }
    total += Math.round(exclusive);
  }
  return total;
}
function orderNumber(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `TH-${[...crypto.randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

/**
 * Prices a mixed cart for one office. One-time lines share one order (and one
 * shipping charge); every subscription line becomes its own subscription with
 * its own shipping charge, because each ships on its own schedule.
 */
export async function planCart(providerId: string, input: CartLineInput[], taxEnabled = false): Promise<CartPlan> {
  if (!Array.isArray(input) || input.length === 0) throw new BillingCartError("Add something to your cart first.", 400, "lines");
  if (input.length > MAX_CART_LINES) throw new BillingCartError(`A cart can hold up to ${MAX_CART_LINES} lines.`, 400, "lines");
  for (const line of input) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_LINE_QUANTITY) {
      throw new BillingCartError(`Each quantity must be between 1 and ${MAX_LINE_QUANTITY}.`, 400, "lines");
    }
  }
  const [prices, products, settings] = await Promise.all([
    selectMany("billing_office_prices", `provider_id=eq.${enc(providerId)}`),
    selectMany("billing_products", "active=eq.true"),
    getSettings(),
  ]);
  const priceMap = new Map(prices.map((row) => [row.product_id, row]));
  const productMap = new Map(products.map((row) => [row.id, row]));
  const percent = subscribeSavePercent(settings);
  const seen = new Set<string>();
  const lines = input.map((line): InternalLine => {
    const product = productMap.get(line.product_id);
    const price = priceMap.get(line.product_id) ?? null;
    const offering = product ? resolveOffering(product, price, settings) : null;
    const key = `${line.product_id}:${line.purchase}`;
    if (!product || !offering || seen.has(key)) throw new BillingCartError("One or more products are not available.", 400, "lines");
    if (offering.unit_price_cents < breakEvenMinimum(product.floor_price_cents, settings)) {
      throw new BillingCartError(`${product.name} has a price below the current minimum.`, 409, "lines");
    }
    seen.add(key);
    if (line.purchase === "subscription") {
      const cadences = productCadences(product);
      const weeks = line.cadence_weeks ?? cadences.default_cadence_weeks;
      if (!price?.subscription_enabled || !offering.office_priced) {
        throw new BillingCartError(`${product.name} is not available as a subscription from your office.`, 400, "lines");
      }
      if (!(cadences.offered_cadences_weeks as number[]).includes(weeks)) {
        throw new BillingCartError(`${product.name} is not offered every ${weeks} weeks.`, 400, "lines");
      }
      const unit = subscriptionUnitPrice(offering.unit_price_cents, percent);
      if (unit < breakEvenMinimum(product.floor_price_cents, settings)) {
        throw new BillingCartError(`${product.name} cannot be subscribed at the current discount.`, 409, "lines");
      }
      return {
        product_id: product.id, name: product.name, purchase: "subscription", quantity: line.quantity, cadence_weeks: weeks,
        unit_price_cents: unit, list_price_cents: offering.unit_price_cents,
        discount_cents: (offering.unit_price_cents - unit) * line.quantity, line_total_cents: unit * line.quantity,
        product, floor_price_cents: product.floor_price_cents, hard_cost_cents: product.hard_cost_cents, stripe_tax_code: product.stripe_tax_code,
      };
    }
    return {
      product_id: product.id, name: product.name, purchase: "one_time", quantity: line.quantity, cadence_weeks: null,
      unit_price_cents: offering.unit_price_cents, list_price_cents: offering.unit_price_cents, discount_cents: 0,
      line_total_cents: offering.unit_price_cents * line.quantity,
      product, floor_price_cents: product.floor_price_cents, hard_cost_cents: product.hard_cost_cents, stripe_tax_code: product.stripe_tax_code,
    };
  });
  const group = (kind: "one_time" | "subscription", members: InternalLine[]): InternalGroup => {
    const fees = computeOrderFees(members.map((line) => ({ floor_price_cents: line.floor_price_cents, quantity: line.quantity })), settings);
    const subtotal = members.reduce((sum, line) => sum + line.line_total_cents, 0);
    return {
      kind, product_id: kind === "subscription" ? members[0].product_id : null,
      cadence_weeks: kind === "subscription" ? members[0].cadence_weeks : null,
      quantity: members.reduce((sum, line) => sum + line.quantity, 0),
      subtotal_cents: subtotal, shipping_charge_cents: settings.shipping_charge_cents,
      total_cents: subtotal + settings.shipping_charge_cents, lines: members,
      application_fee_cents: fees.application_fee_cents, thinnr_share_cents: fees.thinnr_share_cents,
      hard_cost_cents: members.reduce((sum, line) => sum + line.hard_cost_cents * line.quantity, 0),
      shipping_cost_cents: settings.shipping_cost_cents,
    };
  };
  const oneTime = lines.filter((line) => line.purchase === "one_time");
  const groups: InternalGroup[] = [
    ...(oneTime.length ? [group("one_time", oneTime)] : []),
    ...lines.filter((line) => line.purchase === "subscription").map((line) => group("subscription", [line])),
  ];
  const quote: CartQuote = {
    lines: lines.map(({ product: _product, floor_price_cents: _f, hard_cost_cents: _h, stripe_tax_code: _t, ...line }) => line),
    groups: groups.map(({ lines: _l, application_fee_cents: _a, thinnr_share_cents: _s, hard_cost_cents: _h, shipping_cost_cents: _c, ...rest }) => rest),
    subtotal_cents: groups.reduce((sum, item) => sum + item.subtotal_cents, 0),
    discount_cents: lines.reduce((sum, line) => sum + line.discount_cents, 0),
    shipping_charge_cents: groups.reduce((sum, item) => sum + item.shipping_charge_cents, 0),
    total_cents: groups.reduce((sum, item) => sum + item.total_cents, 0),
    tax_enabled: taxEnabled, tax_cents: null, total_due_cents: null,
  };
  if (!taxEnabled) { quote.tax_cents = 0; quote.total_due_cents = quote.total_cents; }
  return { quote, groups, settings };
}

/** The quote with its sales-tax estimate filled in (0 for offices that do not collect tax). */
export function withTaxEstimate(quote: CartQuote, taxCents: number): CartQuote {
  return { ...quote, tax_cents: taxCents, total_due_cents: quote.total_cents + taxCents };
}
export type CheckoutInput = {
  patientId: string | null; providerId: string; cartId: string; lines: CartLineInput[];
  shipping_address: ShippingAddress; payment_method_id: string; set_default?: boolean;
  /**
   * The amount the payer authorized on the button (the quote's total_due_cents).
   * A fresh cart is refused (422) when today's plan plus tax no longer prices to
   * exactly this, so a price, shipping, discount, or tax change between quote and
   * Pay can never charge an amount the payer did not see. Omitted = unbound
   * (staff-driven sales price and charge in one step).
   */
  expected_total_due_cents?: number | null;
  /**
   * The pre-tax total the payer was shown (public prebuilt carts and office
   * sales, priced before the tax is known). A NEW checkout is refused (422)
   * when today's pricing no longer produces this amount, so a catalog,
   * discount, or shipping change between the quote and the card tap can never
   * charge a total nobody confirmed; the finalized invoices are checked
   * against it before any is paid. Replays of an already-claimed cart are
   * unaffected. Null and undefined both mean "no total was shown".
   */
  expected_total_cents?: number | null;
  resolvedPayer?: BillingPayerRow;
};

export const TOTAL_CHANGED_MESSAGE = "Your total changed since your cart was priced. Review your cart and try again.";

export const QUOTE_CHANGED_MESSAGE = "The total changed since this order was quoted. Review the new total before paying.";
/** Re-prices the lines today and throws 409 when the total the payer saw no longer holds. */
export async function assertQuoteCurrent(providerId: string, lines: CartLineInput[], expectedTotalCents: number, taxEnabled = false): Promise<CartPlan> {
  const plan = await planCart(providerId, lines, taxEnabled);
  if (plan.quote.total_cents !== expectedTotalCents) throw new BillingCartError(QUOTE_CHANGED_MESSAGE, 409, "expected_total_cents");
  return plan;
}

export function checkoutStatus(items: CartCheckoutItem[]): CheckoutStatus {
  if (items.every((item) => item.status === "paid")) return "paid";
  if (items.every((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "failed")) return "partial";
  return "requires_action";
}

export function stripeMessage(error: unknown): string {
  const raw = (error as { message?: unknown })?.message;
  const text = typeof raw === "string" && raw.trim() ? raw.trim() : "Your card could not be charged.";
  return text.replace(/\b(?:\d[ -]*?){12,19}\b/g, "[card number removed]").slice(0, 200);
}

/** Same cart + same group index → same row id on every attempt, so a retry can never mint a second row set. */
function derivedUuid(seed: string): string {
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
export function cartOrderId(cartId: string, index: number): string { return derivedUuid(`cart:${cartId}:order:${index}`); }
export function cartSubscriptionId(cartId: string, index: number): string { return derivedUuid(`cart:${cartId}:subscription:${index}`); }
export function cartItemId(cartId: string, index: number, lineIndex: number): string { return derivedUuid(`cart:${cartId}:order:${index}:item:${lineIndex}`); }

/** A staging cart younger than this is treated as in flight; older ones are resumed. */
export const CART_IN_FLIGHT_MS = 90_000;

/**
 * Claims the cart key. The primary key insert is the atomic step: exactly one
 * request owns a fresh cart; a second request with the same key sees the
 * existing row (ready → replay, staging → 409 while in flight, resume when stale).
 */
/**
 * What a cart key is bound to: the request itself (lines as sent, address,
 * card). A retry that sends the identical request resumes; anything else under
 * the same key is a different cart. Prices are deliberately NOT part of the
 * fingerprint: the first attempt's priced plan is persisted with the claim and
 * a resume runs on that stored plan, so an office price or setting change
 * after Stripe objects may already exist can never lock the cart out.
 */
function cartFingerprint(input: CheckoutInput): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    lines: input.lines.map((line) => ({
      product_id: line.product_id, quantity: line.quantity, purchase: line.purchase, cadence_weeks: line.cadence_weeks ?? null,
    })),
    address: input.shipping_address, payment_method_id: input.payment_method_id,
    expected_total_due_cents: input.expected_total_due_cents ?? null,
    expected_total_cents: input.expected_total_cents ?? null,
  })).digest("hex");
}

type StoredCart = {
  fingerprint: string; plan: CartPlan; quote: CartQuote;
  /** The Connect account the first attempt charged against. Stripe idempotency keys are account-scoped, so a resume must hit exactly this account. */
  stripe_account_id: string; tax_enabled: boolean;
};

/**
 * Where a resumed or replayed cart talks to Stripe: the account pinned at the
 * claim, never the office's current row. Reconnecting can swap the office's
 * Stripe account; replaying idempotency keys on a different account would
 * create (and charge) brand-new objects. Mirroring new prices is only allowed
 * while the office's live account is still that same account.
 */
export async function resumeAccount(cart: BillingCartRow, providerId: string): Promise<{ account: BillingConnectedAccountRow; mirrorAllowed: boolean; sameAccount: boolean }> {
  const stored = cart.quote as unknown as Partial<StoredCart> | null;
  const current = await selectOne("billing_connected_accounts", `provider_id=eq.${enc(providerId)}`);
  const pinned = stored?.stripe_account_id ?? current?.stripe_account_id;
  if (!pinned) throw new BillingCartError("Your office is not set up to take payments in the app yet.", 409);
  const sameAccount = current?.stripe_account_id === pinned;
  const live = Boolean(current && sameAccount && !current.disconnected_at && current.charges_enabled);
  const account = (sameAccount && current
    ? current
    : { ...(current ?? {}), provider_id: providerId, stripe_account_id: pinned, tax_enabled: stored?.tax_enabled ?? false }) as BillingConnectedAccountRow;
  return { account, mirrorAllowed: live, sameAccount };
}

/**
 * A stranded cart whose office has since connected a DIFFERENT Stripe account
 * is terminal. Charging it on the pinned account would move money to an
 * account the rest of billing (webhooks, reconcile, refunds, staff screens)
 * treats as foreign and ignores; charging the new account would duplicate any
 * object the first attempt already created. So: anything unpaid that the first
 * attempt left on the old account is voided or canceled there, every pending
 * row is failed honestly, and the patient is told to start over. The one case
 * this cannot settle, a first invoice that already PAID on the old account,
 * stays pending and is refused loudly for staff to resolve, never marked
 * failed and never re-charged.
 */
async function abandonSwappedCart(
  stripe: any, pinned: BillingConnectedAccountRow, input: CheckoutInput, settings: BillingSettingsRow,
): Promise<CartCheckoutResponse> {
  return abandonCart(stripe, pinned, input, settings, "Your office's payment account changed while this checkout was in progress. Start a new checkout.");
}

/**
 * Ends every still-pending order of a cart: voids/deletes its invoice, cancels
 * its (never-paid) subscription and any card-present intent, and fails the
 * row with `message`. Paid orders are reported paid, never touched. A paid
 * invoice on a pinned account nobody can reach any more is a staff matter.
 */
export async function abandonCart(
  stripe: any, pinned: BillingConnectedAccountRow, input: Pick<CheckoutInput, "cartId" | "patientId">, settings: BillingSettingsRow, message: string,
  options: { cleanupFailed?: boolean } = {},
): Promise<CartCheckoutResponse> {
  const acct = pinned.stripe_account_id;
  const opts = connectedOpts(acct);
  const patientFilter = input.patientId ? `patient_id=eq.${enc(input.patientId)}` : "patient_id=is.null";
  const orders = await selectMany("billing_orders", `cart_id=eq.${enc(input.cartId)}&${patientFilter}&order=created_at.asc,id.asc`);
  const productIds = await productIdsByOrder(orders.map((order) => order.id));
  const items: CartCheckoutItem[] = [];
  const swallowMissing = async (call: () => Promise<unknown>) => { try { await call(); } catch (error) { if (!isStripeMissing(error)) throw error; } };
  for (const order of orders) {
    const base: CartCheckoutItem = {
      kind: order.kind === "one_time" ? "one_time" : "subscription", order_id: order.id, order_number: order.order_number,
      subscription_id: order.subscription_id, status: "failed", client_secret: null, error: message, total_cents: order.total_cents,
      tax_cents: order.tax_cents ?? 0, product_ids: productIds.get(order.id) ?? [],
    };
    if (["paid", "partially_refunded", "refunded", "disputed"].includes(order.status)) { items.push({ ...base, status: "paid", error: null }); continue; }
    // A declined tap is failed by the webhook before the phone reports it;
    // with cleanupFailed its open invoice and incomplete subscription are
    // still voided here so nothing lingers at Stripe.
    const alreadyFailed = order.status === "failed";
    if (alreadyFailed && !options.cleanupFailed) { items.push({ ...base, error: order.failure_message ?? message }); continue; }
    if (order.metadata?.source === "tap_to_pay" && order.stripe_payment_intent_id) {
      // A card-present intent lives outside the invoice, so this path fails
      // closed on it, and it does so BEFORE anything else of the order is
      // touched: the invoice, the subscription and the row may only be torn
      // down once Stripe has PROVEN no charge can settle. Otherwise a capture
      // that wins the race would leave money behind a void invoice and a
      // canceled subscription that no later settle could repair. Cancelling
      // first (not reading first) makes the proof atomic against that race:
      // Stripe refuses to cancel a captured intent, and a refusal is re-read
      // rather than guessed. A throw here leaves the order exactly as it was.
      await releaseTapIntent(stripe, acct, order);
    }
    if (order.stripe_invoice_id) {
      let invoice: any = null;
      await swallowMissing(async () => { invoice = await stripe.invoices.retrieve(order.stripe_invoice_id, {}, opts); });
      if (invoice?.status === "paid") {
        logger.error({ orderId: order.id, account: acct, invoiceId: invoice.id }, "cart invoice paid on a replaced Connect account; needs staff resolution");
        throw new BillingCartError("A payment for this checkout already went through on your office's previous account. Contact your office to finish it.", 409);
      }
      // A subscription's first invoice is released by cancelling the subscription below (voiding it directly would cancel the subscription behind Stripe's back).
      if (!order.subscription_id) {
        if (invoice?.status === "draft") await swallowMissing(() => stripe.invoices.del(invoice.id, opts));
        else if (invoice?.status === "open") await swallowMissing(() => stripe.invoices.voidInvoice(invoice.id, {}, connectedOpts(acct, `order:${order.id}:void`)));
      }
    }
    if (order.subscription_id) {
      const row = await selectOne("billing_subscriptions", `id=eq.${enc(order.subscription_id)}`);
      if (row?.stripe_subscription_id) {
        await swallowMissing(() => stripe.subscriptions.cancel(row.stripe_subscription_id, { invoice_now: false, prorate: false }, connectedOpts(acct, `subscription:${row.id}:abandon`)));
      }
      await update("billing_subscriptions", `id=eq.${enc(order.subscription_id)}&status=eq.incomplete`, { status: "canceled", canceled_at: nowIso() });
    }
    if (alreadyFailed) { items.push({ ...base, error: order.failure_message ?? message }); continue; }
    await failOrder(order, settings, message, order.subscription_id);
    items.push(base);
  }
  await update("billing_carts", `id=eq.${enc(input.cartId)}`, { status: "ready" });
  return {
    cart_id: input.cartId, status: checkoutStatus(items), items,
    stripe_account_id: acct, publishable_key: await getPublishableKey(), sandbox: await isSandbox(),
  };
}

export const TAP_ALREADY_CHARGED_MESSAGE = "A tap payment for this sale already went through. Contact your office to finish it.";
/** An existing cart under this key is only this request's to continue if the same patient sent the same request. */
function assertCartOwner(existing: BillingCartRow, input: CheckoutInput, fingerprint: string): BillingCartRow {
  if (existing.patient_id !== input.patientId || existing.provider_id !== input.providerId) {
    throw new BillingCartError("That checkout key is already in use.", 409, "idempotency_key");
  }
  if ((existing.quote as { fingerprint?: unknown })?.fingerprint !== fingerprint) {
    // The key is bound to the first attempt's exact request; a changed body
    // (lines, address, card) must start a new checkout, never resume onto rows
    // that were built for something else.
    throw new BillingCartError("Your cart changed since checkout started. Start a new checkout.", 409, "idempotency_key");
  }
  return existing;
}

async function claimCart(input: CheckoutInput, plan: CartPlan, fingerprint: string, account: BillingConnectedAccountRow): Promise<{ cart: BillingCartRow; fresh: boolean }> {
  const stored: StoredCart = { fingerprint, plan, quote: plan.quote, stripe_account_id: account.stripe_account_id, tax_enabled: account.tax_enabled };
  const inserted = await insertIgnore("billing_carts", {
    id: input.cartId, provider_id: input.providerId, patient_id: input.patientId, status: "staging",
    quote: stored as unknown as Record<string, unknown>,
  }, "billing_carts_pkey");
  if (inserted) return { cart: inserted, fresh: true };
  // Lost the race to a concurrent request with the same key: continue on its row.
  const existing = await selectOne("billing_carts", `id=eq.${enc(input.cartId)}`);
  if (!existing) throw new BillingCartError("Checkout could not be started. Try again.", 503);
  return { cart: assertCartOwner(existing, input, fingerprint), fresh: false };
}

/**
 * The button's amount must be today's amount. Runs BEFORE the claim, so a
 * mismatch is a definite refusal with no rows and no Stripe objects behind it;
 * the app re-quotes and asks again under a new key.
 */
async function assertAuthorizedTotal(account: BillingConnectedAccountRow, plan: CartPlan, input: CheckoutInput): Promise<void> {
  const preTax = input.expected_total_cents;
  if (preTax !== undefined && preTax !== null && plan.quote.total_cents !== preTax) {
    throw new BillingCartError(TOTAL_CHANGED_MESSAGE, 422, "expected_total_cents");
  }
  const expected = input.expected_total_due_cents;
  if (expected === undefined || expected === null) return;
  const due = plan.quote.total_cents + await estimateCartTax(account, plan, input.shipping_address);
  if (due !== expected) {
    throw new BillingCartError(TOTAL_CHANGED_MESSAGE, 422, "expected_total_due_cents");
  }
}
/** A fresh checkout needs an office that can take payments today. */
export async function liveAccount(providerId: string): Promise<BillingConnectedAccountRow> {
  const account = await selectOne("billing_connected_accounts", `provider_id=eq.${enc(providerId)}&disconnected_at=is.null`);
  if (!account?.charges_enabled) throw new BillingCartError("Your office is not set up to take payments in the app yet.", 409);
  return account;
}

/** The plan a resumed attempt must run on: the one the first attempt priced and persisted, never a re-price. */
function storedPlan(cart: BillingCartRow): CartPlan | null {
  const stored = cart.quote as unknown as Partial<StoredCart> | null;
  return stored?.plan && Array.isArray(stored.plan.groups) && stored.plan.settings ? stored.plan : null;
}

/** Which cart lines each order carries, so the app can drop exactly the paid lines after a partial result. */
export async function productIdsByOrder(orderIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!orderIds.length) return map;
  const rows = await selectMany("billing_order_items", `order_id=in.(${orderIds.map(enc).join(",")})&order=id.asc`);
  for (const row of rows) map.set(row.order_id, [...(map.get(row.order_id) ?? []), row.product_id]);
  return map;
}
/** A retried checkout (same Idempotency-Key) replays what the first attempt created. */
export async function existingCheckout(cartId: string, patientId: string | null): Promise<CartCheckoutResponse | null> {
  const patientFilter = patientId ? `patient_id=eq.${enc(patientId)}` : "patient_id=is.null";
  const orders = await selectMany("billing_orders", `cart_id=eq.${enc(cartId)}&${patientFilter}&order=created_at.asc,id.asc`);
  if (!orders.length) return null;
  const cart = await selectOne("billing_carts", `id=eq.${enc(cartId)}`);
  const account = cart ? (await resumeAccount(cart, orders[0].provider_id)).account
    : await selectOne("billing_connected_accounts", `provider_id=eq.${enc(orders[0].provider_id)}`);
  const stripe = await getStripe();
  const productIds = await productIdsByOrder(orders.map((order) => order.id));
  const items: CartCheckoutItem[] = [];
  let settings: BillingSettingsRow | null = (cart && storedPlan(cart)?.settings) ?? null;
  for (const order of orders) {
    const base: CartCheckoutItem = {
      kind: order.kind === "one_time" ? "one_time" : "subscription", order_id: order.id, order_number: order.order_number,
      subscription_id: order.subscription_id, status: "requires_action", client_secret: null, error: null, total_cents: order.total_cents, tax_cents: order.tax_cents ?? 0,
      product_ids: productIds.get(order.id) ?? [],
    };
    if (["paid", "partially_refunded", "refunded", "disputed"].includes(order.status)) { items.push({ ...base, status: "paid" }); continue; }
    if (order.status === "failed") { items.push({ ...base, status: "failed", error: order.failure_message ?? "Payment failed." }); continue; }
    // Still pending: the original response may have been lost mid-3DS, so
    // recover the live PaymentIntent state, persist what Stripe settled, and
    // hand back the client secret only while the intent is genuinely waiting.
    if (order.stripe_payment_intent_id && account) {
      const opts = connectedOpts(account.stripe_account_id);
      let intent: any;
      try {
        intent = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, {}, opts);
      } catch (error) {
        // Unknown is unknown: never let a lookup outage read as "nothing
        // happened", or the app would retire this key and charge a new cart.
        logger.warn({ err: error, orderId: order.id }, "checkout replay could not read the payment intent");
        throw new BillingCartError("Your payment is still being confirmed. Try again in a moment.", 503, "idempotency_key");
      }
      if (intent?.status === "succeeded") {
        await settlePaidReplay(stripe, account, order, opts);
        items.push({ ...base, status: "paid" });
        continue;
      }
      // A card-present intent sits in requires_payment_method until the patient
      // taps, so for a Tap to Pay order that state is "waiting", not a decline;
      // its declines are recorded by the payment_failed webhook and the
      // phone's explicit cancel, never inferred here.
      const awaitingTap = order.metadata?.source === "tap_to_pay" && intent?.status === "requires_payment_method";
      if (intent?.status === "canceled" || (intent?.status === "requires_payment_method" && !awaitingTap)) {
        // The device-side authentication failed or the intent was voided: a
        // definite answer, recorded on the row so it can never loop as pending.
        const message = intent.status === "canceled" ? "Payment was canceled."
          : intent.last_payment_error ? stripeMessage(intent.last_payment_error) : "Your card could not be charged.";
        settings ??= await getSettings();
        await failOrder(order, settings, message, order.subscription_id);
        items.push({ ...base, status: "failed", error: message });
        continue;
      }
      items.push({ ...base, client_secret: intent?.client_secret ?? null });
      continue;
    }
    items.push(base);
  }
  return {
    cart_id: cartId, status: checkoutStatus(items), items,
    stripe_account_id: account?.stripe_account_id ?? "", publishable_key: await getPublishableKey(), sandbox: await isSandbox(),
  };
}

/**
 * A replayed intent that Stripe says succeeded is recorded now (the same
 * paid path the first attempt would have taken), not left for the webhook:
 * the response tells the patient "paid", so the rows must say so too.
 */
async function settlePaidReplay(stripe: any, account: BillingConnectedAccountRow, order: BillingOrderRow, opts: ReturnType<typeof connectedOpts>): Promise<void> {
  if (!order.stripe_invoice_id) return;
  const ctx: StripeEventContext = { kind: "connect", account: account.stripe_account_id, livemode: !await isSandbox() };
  try {
    const invoice: any = await stripe.invoices.retrieve(order.stripe_invoice_id, { expand: ["payments.data.payment.payment_intent"] } as any, opts);
    if (invoice?.status !== "paid") return;
    if (order.subscription_id) {
      await markSubscriptionInvoicePaid({ ...invoice, billing_reason: invoice.billing_reason ?? "subscription_create" }, ctx);
      await update("billing_subscriptions", `id=eq.${enc(order.subscription_id)}&status=eq.incomplete`, { status: "active" });
    } else {
      await markOrderPaidFromInvoice(invoice, ctx);
    }
  } catch (error) {
    // The intent is paid regardless; the invoice webhook lands the row if this read failed.
    logger.warn({ err: error, orderId: order.id }, "checkout replay could not record the paid invoice");
  }
}
export async function attachCard(stripe: any, account: BillingConnectedAccountRow, customerId: string, paymentMethodId: string, cartId: string, setDefault: boolean | undefined): Promise<void> {
  const opts = connectedOpts(account.stripe_account_id);
  let method: any;
  try {
    method = await stripe.paymentMethods.retrieve(paymentMethodId, {}, opts);
  } catch {
    throw new BillingCartError("That card could not be used. Enter it again.", 400, "payment_method_id");
  }
  const owner = typeof method.customer === "string" ? method.customer : method.customer?.id ?? null;
  if (owner && owner !== customerId) throw new BillingCartError("That card belongs to a different account.", 403, "payment_method_id");
  if (!owner) {
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }, connectedOpts(account.stripe_account_id, `cart:${cartId}:attach:${paymentMethodId}`));
    } catch (error: any) {
      // Stripe runs the card check on attach, so a decline surfaces here
      // before any order exists. That is a card answer (402), not an outage.
      if (error?.type === "StripeCardError" || error?.raw?.type === "card_error" || error?.code === "card_declined") {
        throw new BillingCartError(stripeMessage(error), 402, "payment_method_id");
      }
      throw error;
    }
  }
  const customer: any = await stripe.customers.retrieve(customerId, {}, opts);
  const currentDefault = customer?.invoice_settings?.default_payment_method;
  const hasDefault = Boolean(typeof currentDefault === "string" ? currentDefault : currentDefault?.id);
  if (setDefault || !hasDefault) {
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } }, opts);
  }
}

/**
 * One confirmation, one card, several charges: one invoice for the one-time
 * lines and one Stripe subscription per subscribed line. Every row is inserted
 * before any Stripe call (so no charge can exist without an order) and each
 * group is charged independently, so a declined subscription never undoes a
 * paid one-time order; the response says exactly which is which.
 */
/** Everything a checkout needs before Stripe is touched, or the response that ends it early (swapped account, replay). */
export type ResolvedCart =
  | { kind: "response"; response: CartCheckoutResponse }
  | { kind: "proceed"; cart: BillingCartRow; plan: CartPlan; account: BillingConnectedAccountRow; mirrorAllowed: boolean; fresh: boolean };
/**
 * One confirmation, one card, several charges: one invoice for the one-time
 * lines and one Stripe subscription per subscribed line. Every row is inserted
 * before any Stripe call (so no charge can exist without an order) and each
 * group is charged independently, so a declined subscription never undoes a
 * paid one-time order; the response says exactly which is which.
 */
export async function checkoutCart(input: CheckoutInput): Promise<CartCheckoutResponse> {
  const resolved = await resolveCart(input);
  if (resolved.kind === "response") return resolved.response;
  const { plan, account, mirrorAllowed } = resolved;
  const payer = input.resolvedPayer ?? await resolvePayer(input.providerId, { patient_id: input.patientId } as BillingPaymentLinkRow);
  const stripe = await getStripe();
  const customerId = await ensureCustomer(payer, input.shipping_address, account);
  await attachCard(stripe, account, customerId, input.payment_method_id, input.cartId, input.set_default);
  const livemode = !await isSandbox();
  const ctx: StripeEventContext = { kind: "connect", account: account.stripe_account_id, livemode };
  // 1. Every order (and subscription) row first.
  const pending = await insertCartRows(input, plan, payer, customerId, livemode);

  // 2. Finalize every group's Stripe invoice first (nothing is paid yet), then
  // hold the SUM of what Stripe actually finalized against the amount the payer
  // authorized, and only then pay group by group. Every Stripe idempotency key
  // derives from the deterministic order id, so even a racing duplicate replays
  // the same objects and the same charge instead of creating new ones.
  const prepared: PreparedGroup[] = [];
  for (const entry of pending) {
    if (entry.order.status !== "pending") {
      const replayed = (await existingCheckout(input.cartId, input.patientId))?.items.find((item) => item.order_id === entry.order.id);
      if (replayed) { prepared.push({ done: replayed }); continue; }
    }
    prepared.push(entry.subscriptionId
      ? await prepareSubscription(stripe, account, customerId, input, entry.order, entry.subscriptionId, entry.group, ctx, plan.settings, mirrorAllowed)
      : await prepareOneTime(stripe, account, customerId, input, entry.order, entry.group, ctx, plan.settings));
  }
  await refuseOverAuthorized(stripe, account, input, prepared, plan.settings);
  const items: CartCheckoutItem[] = [];
  for (const group of prepared) {
    items.push(group.done ?? await settleGroup(stripe, account, input, group, ctx, plan.settings));
  }
  // "ready" = every group was attempted; a retry from here on replays, never re-charges.
  await update("billing_carts", `id=eq.${enc(input.cartId)}`, { status: "ready" });
  return {
    cart_id: input.cartId, status: checkoutStatus(items), items,
    stripe_account_id: account.stripe_account_id, publishable_key: await getPublishableKey(), sandbox: !livemode,
  };
}

/**
 * Whether an error leaves Stripe state unknown. Card declines and invalid
 * requests are definite (nothing was created or it was rejected); network,
 * API, and rate-limit errors, and anything raised after a Stripe object came
 * back, are not. Ambiguous failures are re-thrown so the cart stays "staging"
 * and the retry resumes onto the same rows with the same idempotency keys.
 */
export function isAmbiguousStripeFailure(error: any): boolean {
  const type = String(error?.type ?? "");
  if (type === "StripeConnectionError" || type === "StripeAPIError" || type === "StripeRateLimitError") return true;
  return !type.startsWith("Stripe");
}

export function intentOf(invoice: any): any {
  const direct = invoice?.payment_intent;
  if (direct) return typeof direct === "string" ? { id: direct } : direct;
  const payment = invoice?.payments?.data?.[0]?.payment?.payment_intent;
  return typeof payment === "string" ? { id: payment } : payment ?? null;
}

export async function failOrder(order: BillingOrderRow, settings: BillingSettingsRow, message: string, subscriptionId: string | null): Promise<void> {
  await update("billing_orders", `id=eq.${enc(order.id)}&status=eq.pending`, {
    status: "failed", failure_message: message, metadata: { ...(order.metadata ?? {}), settings, error: message },
  });
  if (subscriptionId) {
    await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}&status=eq.incomplete`, { last_failure_message: message, last_payment_failed_at: nowIso() });
  }
}

/** Pays a finalized invoice off-session; returns the paid invoice, an action request, or a decline. */
async function payInvoice(stripe: any, account: BillingConnectedAccountRow, invoiceId: string, paymentMethodId: string, key: string):
  Promise<{ kind: "paid"; invoice: any } | { kind: "requires_action"; client_secret: string | null } | { kind: "failed"; message: string }> {
  try {
    const paid = await stripe.invoices.pay(invoiceId, {
      payment_method: paymentMethodId, off_session: true, expand: ["payments.data.payment.payment_intent"],
    } as any, connectedOpts(account.stripe_account_id, key));
    if (paid.status === "paid") return { kind: "paid", invoice: paid };
    const intent = intentOf(paid);
    if (intent?.status === "requires_action" || intent?.status === "requires_confirmation") {
      return { kind: "requires_action", client_secret: intent.client_secret ?? null };
    }
    return { kind: "failed", message: "Your card could not be charged." };
  } catch (error: any) {
    if (error?.code === "invoice_already_paid" || error?.raw?.code === "invoice_already_paid" || /already paid/i.test(String(error?.message ?? ""))) {
      // Paid by an earlier attempt (or at creation): read the invoice back instead of failing a charged order.
      const current = await stripe.invoices.retrieve(invoiceId, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(account.stripe_account_id));
      if (current?.status === "paid") return { kind: "paid", invoice: current };
    }
    const intent = error?.raw?.payment_intent ?? error?.payment_intent;
    if (intent?.status === "requires_action" || error?.code === "authentication_required" || error?.raw?.code === "authentication_required") {
      return { kind: "requires_action", client_secret: intent?.client_secret ?? null };
    }
    if (error?.type === "StripeCardError" || error?.raw?.type === "card_error" || error?.code === "card_declined") {
      return { kind: "failed", message: stripeMessage(error) };
    }
    throw error;
  }
}

/**
 * A group whose Stripe invoice is finalized but not yet paid, or one that already
 * reached its answer (`done`: paid earlier, replayed, or refused before any charge).
 */
type PreparedGroup =
  | { done: CartCheckoutItem }
  | {
      done?: undefined; base: CartCheckoutItem; order: BillingOrderRow; invoiceId: string; total_cents: number; tax_cents: number;
      subscriptionId: string | null; stripeSubscriptionId: string | null;
    };

async function prepareSubscription(
  stripe: any, account: BillingConnectedAccountRow, customerId: string, input: CheckoutInput,
  order: BillingOrderRow, subscriptionId: string, group: InternalGroup, ctx: StripeEventContext, settings: BillingSettingsRow,
  mirrorAllowed: boolean,
): Promise<PreparedGroup> {
  const acct = account.stripe_account_id;
  const line = group.lines[0];
  const weeks = line.cadence_weeks ?? 4;
  const base: CartCheckoutItem = {
    kind: "subscription", order_id: order.id, order_number: order.order_number, subscription_id: subscriptionId,
    status: "failed", client_secret: null, error: null, total_cents: order.total_cents, tax_cents: 0,
    product_ids: [line.product_id],
  };
  let invoiceId: string | null = null;
  // Resolve the Stripe prices ONCE per subscription row and persist them before
  // the create call. A resumed attempt reuses the persisted ids (the Stripe
  // idempotency key then replays the identical create) instead of re-mirroring,
  // so a price that moved after Stripe may already hold the subscription can
  // neither refuse the line nor change what is created.
  const priced = await resolveSubscriptionPrices(input.providerId, subscriptionId, line, mirrorAllowed);
  if ("error" in priced) {
    await failOrder(order, settings, priced.error, subscriptionId);
    return { done: { ...base, error: priced.error } };
  }
  const cadence = priced.cadence;
  // Once Stripe has handed back an object, every later error is ambiguous: a
  // subscription (and possibly a settled first invoice) exists, so the order
  // must stay pending for the resume / reconcile path, never be marked failed.
  let stripeObjectCreated = false;
  try {
    const subscription: any = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: cadence.price_id, quantity: line.quantity }, { price: cadence.shipping_price_id, quantity: 1 }],
      default_payment_method: input.payment_method_id,
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      application_fee_percent: applicationFeePercentFor(group.application_fee_cents, group.total_cents),
      automatic_tax: { enabled: account.tax_enabled },
      metadata: { thinnr_subscription_id: subscriptionId, thinnr_order_id: order.id, thinnr_cart_id: input.cartId },
    } as any, connectedOpts(acct, `subscription:${subscriptionId}`));
    stripeObjectCreated = true;
    const latest = typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice?.id;
    if (!latest) throw new Error("Subscription has no first invoice.");
    const invoice: any = await stripe.invoices.retrieve(latest, { expand: ["payments.data.payment.payment_intent"] } as any, connectedOpts(acct));
    invoiceId = invoice.id;
    const renews = periodEnd(subscription) ?? new Date(Date.now() + weeks * 7 * 86400_000).toISOString();
    await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}`, {
      stripe_subscription_id: subscription.id, stripe_customer_id: customerId, current_period_end: renews,
      next_shipment_at: nextShipmentAt(subscription) ?? renews,
    });
    const total = Number(invoice.total ?? group.total_cents);
    const tax = invoice.total_taxes || invoice.tax !== undefined ? taxOf(invoice) : Math.max(0, total - group.total_cents);
    await update("billing_orders", `id=eq.${enc(order.id)}`, {
      stripe_invoice_id: invoice.id, stripe_payment_intent_id: intentOf(invoice)?.id ?? null,
      tax_cents: tax, total_cents: total,
    });
    base.total_cents = total;
    base.tax_cents = tax;
    if (invoice.status === "paid") {
      // Stripe settled the first invoice at creation (or an earlier attempt paid it): record it, never pay twice.
      await markSubscriptionInvoicePaid({ ...invoice, billing_reason: invoice.billing_reason ?? "subscription_create" }, ctx);
      await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}&status=eq.incomplete`, { status: "active" });
      return { done: { ...base, status: "paid" } };
    }
    if (subscription.status === "canceled" || invoice.status === "void") {
      // Cancelled by an earlier attempt's authorization check; the replayed key hands the same subscription back.
      await failOrder(order, settings, TOTAL_CHANGED_MESSAGE, subscriptionId);
      await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}&status=eq.incomplete`, { status: "canceled", canceled_at: nowIso() });
      return { done: { ...base, error: TOTAL_CHANGED_MESSAGE } };
    }
    return { base, order, invoiceId: invoice.id, total_cents: total, tax_cents: tax, subscriptionId, stripeSubscriptionId: subscription.id };
  } catch (error) {
    logger.error({ err: error, orderId: order.id, subscriptionId, stripeObjectCreated }, "patient cart subscription initialization failed");
    if (stripeObjectCreated || isAmbiguousStripeFailure(error)) throw error;
    await failOrder(order, settings, "Subscription could not be started. Please try again.", subscriptionId);
    return { done: { ...base, error: "Subscription could not be started. Please try again." } };
  }
}

/** Pays one prepared group and records the outcome on its rows. */
async function settleGroup(
  stripe: any, account: BillingConnectedAccountRow, input: CheckoutInput, group: PreparedGroup & { done?: undefined },
  ctx: StripeEventContext, settings: BillingSettingsRow,
): Promise<CartCheckoutItem> {
  const { base, order, invoiceId, subscriptionId } = group;
  const key = subscriptionId ? `subscription:${subscriptionId}:pay` : `order:${order.id}:pay`;
  const outcome = await payInvoice(stripe, account, invoiceId, input.payment_method_id, key);
  if (outcome.kind === "paid") {
    if (subscriptionId) {
      await markSubscriptionInvoicePaid({ ...outcome.invoice, billing_reason: outcome.invoice.billing_reason ?? "subscription_create" }, ctx);
      await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}&status=eq.incomplete`, { status: "active" });
    } else {
      await markOrderPaidFromInvoice(outcome.invoice, ctx);
    }
    return { ...base, status: "paid" };
  }
  if (outcome.kind === "requires_action") return { ...base, status: "requires_action", client_secret: outcome.client_secret };
  await failOrder(order, settings, outcome.message, subscriptionId);
  return { ...base, error: outcome.message };
}

function taxOf(invoice: any): number {
  return Number(invoice?.total_taxes?.reduce((sum: number, row: any) => sum + (row.amount ?? 0), 0) ?? invoice?.tax ?? 0);
}

async function prepareOneTime(
  stripe: any, account: BillingConnectedAccountRow, customerId: string, input: CheckoutInput,
  order: BillingOrderRow, group: InternalGroup, ctx: StripeEventContext, settings: BillingSettingsRow,
): Promise<PreparedGroup> {
  const acct = account.stripe_account_id;
  const base: CartCheckoutItem = {
    kind: "one_time", order_id: order.id, order_number: order.order_number, subscription_id: null,
    status: "failed", client_secret: null, error: null, total_cents: order.total_cents, tax_cents: 0,
    product_ids: group.lines.map((member) => member.product_id),
  };
  let invoiceId: string | null = null;
  // Same rule as subscriptions: after the invoice exists at Stripe, no later
  // error may mark the order failed (the resume replays every step by key).
  let stripeObjectCreated = false;
  try {
    const invoice = await stripe.invoices.create({
      customer: customerId, collection_method: "charge_automatically", auto_advance: false,
      automatic_tax: { enabled: account.tax_enabled }, application_fee_amount: group.application_fee_cents,
      default_payment_method: input.payment_method_id,
      metadata: { thinnr_order_id: order.id, thinnr_cart_id: input.cartId }, pending_invoice_items_behavior: "exclude",
    } as any, connectedOpts(acct, `order:${order.id}:invoice`));
    stripeObjectCreated = true;
    invoiceId = invoice.id;
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
    const intent = intentOf(finalized);
    const tax = taxOf(finalized);
    const total = Number(finalized.total ?? order.total_cents);
    await update("billing_orders", `id=eq.${enc(order.id)}`, {
      stripe_invoice_id: finalized.id, stripe_payment_intent_id: intent?.id ?? null, tax_cents: tax, total_cents: total,
    });
    base.total_cents = total;
    base.tax_cents = tax;
    if (finalized.status === "paid") {
      // A resumed attempt can find the invoice already paid; never charge or fail it again.
      await markOrderPaidFromInvoice(finalized, ctx);
      return { done: { ...base, status: "paid" } };
    }
    if (finalized.status === "void") {
      // Voided by an earlier attempt's authorization check; the replayed keys hand the same void invoice back.
      await failOrder(order, settings, TOTAL_CHANGED_MESSAGE, null);
      return { done: { ...base, error: TOTAL_CHANGED_MESSAGE } };
    }
    return { base, order, invoiceId: finalized.id, total_cents: total, tax_cents: tax, subscriptionId: null, stripeSubscriptionId: null };
  } catch (error) {
    logger.error({ err: error, orderId: order.id, stripeObjectCreated }, "patient cart one-time order initialization failed");
    if (stripeObjectCreated || isAmbiguousStripeFailure(error)) throw error;
    await failOrder(order, settings, "Payment could not be started. Please try again.", null);
    return { done: { ...base, error: "Payment could not be started. Please try again." } };
  }
}

/**
 * The last gate before money moves: the finalized invoices, summed across every
 * group (paid-earlier and open alike), may never exceed what the payer
 * authorized (`expected_total_due_cents`, or the pre-tax `expected_total_cents`
 * when the payer page could not know the tax). Tax is estimated per group
 * before the claim, but Stripe's own per-invoice rounding is what bills, so the
 * real numbers are checked here and every OPEN group is voided and failed
 * (definite, nothing charged) rather than paid over the shown amount.
 */
async function refuseOverAuthorized(
  stripe: any, account: BillingConnectedAccountRow, input: CheckoutInput, prepared: PreparedGroup[], settings: BillingSettingsRow,
): Promise<void> {
  const due = input.expected_total_due_cents ?? null;
  const preTax = input.expected_total_cents ?? null;
  if (due === null && preTax === null) return;
  let sumDue = 0;
  let sumPreTax = 0;
  for (const group of prepared) {
    if (group.done) {
      if (group.done.status === "failed") continue;
      sumDue += group.done.total_cents;
      sumPreTax += group.done.total_cents - (group.done.tax_cents ?? 0);
      continue;
    }
    sumDue += group.total_cents;
    sumPreTax += group.total_cents - group.tax_cents;
  }
  const over = (due !== null && sumDue > due) || (due === null && preTax !== null && sumPreTax > preTax);
  if (!over) return;
  logger.warn({ cartId: input.cartId, sumDue, sumPreTax, due, preTax }, "patient cart finalized above the authorized total; voiding");
  for (const group of prepared) {
    if (group.done) continue;
    const opts = connectedOpts(account.stripe_account_id);
    if (group.stripeSubscriptionId) {
      // Cancelling an incomplete subscription voids its open first invoice.
      await stripe.subscriptions.cancel(group.stripeSubscriptionId, {}, opts);
    } else {
      await stripe.invoices.voidInvoice(group.invoiceId, {}, opts);
    }
    await failOrder(group.order, settings, TOTAL_CHANGED_MESSAGE, group.subscriptionId);
    if (group.subscriptionId) await update("billing_subscriptions", `id=eq.${enc(group.subscriptionId)}&status=eq.incomplete`, { status: "canceled", canceled_at: nowIso() });
    (group as PreparedGroup).done = { ...group.base, error: TOTAL_CHANGED_MESSAGE };
  }
}

/**
 * Every order (and subscription) row first, before any Stripe call, so no
 * charge can exist without an order. Each row id derives from the cart key,
 * so a resume fills in exactly what is missing.
 */
export async function insertCartRows(
  input: CheckoutInput, plan: CartPlan, payer: BillingPayerRow, customerId: string, livemode: boolean, source: "patient_app" | "tap_to_pay" = "patient_app",
): Promise<PendingGroup[]> {
  const address = input.shipping_address as unknown as Record<string, unknown>;
  const pending: PendingGroup[] = [];
  for (const [index, group] of plan.groups.entries()) {
    const orderId = cartOrderId(input.cartId, index);
    const subscriptionId = group.kind === "subscription" ? cartSubscriptionId(input.cartId, index) : null;
    if (subscriptionId) {
      const line = group.lines[0];
      await insertIgnore("billing_subscriptions", {
        id: subscriptionId, provider_id: input.providerId, payer_id: payer.id, patient_id: input.patientId,
        product_id: line.product_id, stripe_subscription_id: null, stripe_customer_id: customerId,
        status: "incomplete", unit_price_cents: line.unit_price_cents,
        shipping_charge_cents: group.shipping_charge_cents, shipping_cost_cents: group.shipping_cost_cents,
        application_fee_cents: group.application_fee_cents, shipping_address: address, current_period_end: null,
        cancel_at_period_end: false, canceled_at: null, cancel_token: crypto.randomBytes(24).toString("base64url"),
        livemode, cadence_weeks: line.cadence_weeks ?? 4, quantity: line.quantity, next_shipment_at: null,
      }, "billing_subscriptions_pkey");
    }
    const insertedOrder = await insertIgnore("billing_orders", {
      id: orderId, order_number: orderNumber(), provider_id: input.providerId, payer_id: payer.id,
      patient_id: input.patientId, link_id: null, kind: subscriptionId ? "subscription_initial" : "one_time",
      subscription_id: subscriptionId, status: "pending", currency: "usd", subtotal_cents: group.subtotal_cents,
      shipping_charge_cents: group.shipping_charge_cents, tax_cents: 0, total_cents: group.total_cents,
      application_fee_cents: group.application_fee_cents, application_fee_collected_cents: null,
      stripe_fee_cents: null, office_net_cents: null, hard_cost_cents: group.hard_cost_cents,
      shipping_cost_cents: group.shipping_cost_cents,
      hq_profit_cents: hqProfit(group.application_fee_cents, group.hard_cost_cents, group.shipping_cost_cents),
      shipping_address: address, stripe_invoice_id: null, stripe_payment_intent_id: null, livemode,
      fulfillment_status: "to_ship", cart_id: input.cartId,
      metadata: { settings: plan.settings, source, cart: plan.quote },
    }, "billing_orders_pkey");
    const order = insertedOrder ?? await selectOne("billing_orders", `id=eq.${enc(orderId)}`);
    if (!order) throw new BillingCartError("Checkout could not be started. Try again.", 503);
    // Each line has its own derived id, so a resume fills in exactly the items
    // that are missing (never "some items exist, skip the rest").
    for (const [lineIndex, line] of group.lines.entries()) {
      await insertIgnore("billing_order_items", {
        id: cartItemId(input.cartId, index, lineIndex), order_id: orderId, product_id: line.product_id, product_name_snapshot: line.name, quantity: line.quantity,
        unit_price_cents: line.unit_price_cents, floor_price_cents_snapshot: line.floor_price_cents,
        thinnr_share_cents: Math.floor(line.floor_price_cents * 60 / 100) * line.quantity,
        hard_cost_cents_snapshot: line.hard_cost_cents,
      }, "billing_order_items_pkey");
    }
    pending.push({ group, order, subscriptionId });
  }
  return pending;
}

/**
 * Resolves the Stripe prices ONCE per subscription row and persists them before
 * the create call. A resumed attempt reuses the persisted ids (the Stripe
 * idempotency key then replays the identical create) instead of re-mirroring,
 * so a price that moved after Stripe may already hold the subscription can
 * neither refuse the line nor change what is created. A returned `error` is a
 * definite refusal with nothing created at Stripe.
 */
export async function resolveSubscriptionPrices(
  providerId: string, subscriptionId: string, line: InternalLine, mirrorAllowed: boolean,
): Promise<{ cadence: { price_id: string; shipping_price_id: string } } | { error: string }> {
  const weeks = line.cadence_weeks ?? 4;
  const row = await selectOne("billing_subscriptions", `id=eq.${enc(subscriptionId)}`);
  if (row?.stripe_price_id && row.stripe_shipping_price_id) return { cadence: { price_id: row.stripe_price_id, shipping_price_id: row.stripe_shipping_price_id } };
  if (!mirrorAllowed) {
    // Nothing is pinned, so no Stripe subscription exists yet (pinning always
    // precedes the create). The office's live account is gone or replaced, and
    // mirroring prices would land on the wrong account: fail the line for real.
    return { error: "Your office's payment account changed. Start a new checkout for this subscription." };
  }
  // Price mirroring: a transient Stripe/store failure here is NOT a refusal of
  // this line; it propagates so the cart stays staging and the retry resumes.
  const mirrored = await ensureRecurringPrices(providerId, line.product_id);
  const resolved = mirrored?.stripe_cadence_prices?.[String(weeks)];
  if (!resolved?.price_id || !resolved.shipping_price_id || resolved.unit_amount_cents !== line.unit_price_cents) {
    // Definite: the office no longer sells this cadence at the quoted price; nothing was created at Stripe.
    return { error: resolved ? "Subscription pricing changed. Quote again." : "Subscription pricing is unavailable." };
  }
  const cadence = { price_id: resolved.price_id, shipping_price_id: resolved.shipping_price_id };
  await update("billing_subscriptions", `id=eq.${enc(subscriptionId)}`, { stripe_price_id: cadence.price_id, stripe_shipping_price_id: cadence.shipping_price_id });
  return { cadence };
}

/**
 * Claims or resumes the cart key. Shared by the card checkout and the Tap to
 * Pay sale so both obey the same key, ownership, in-flight, and pinned-account
 * rules; the caller decides what "charge" means afterwards.
 */
export async function resolveCart(input: CheckoutInput): Promise<ResolvedCart> {
  const fingerprint = cartFingerprint(input);
  // An existing key is resolved BEFORE anything is validated against today's
  // catalog or account: a replay or resume must work even if the product was
  // archived, the subscription switched off, the price moved below minimum, or
  // the office disconnected since the first attempt, because Stripe may already
  // hold (and have settled) the objects for these rows. Only a genuinely new key
  // is priced and account-checked now, then claimed atomically.
  let cart = await selectOne("billing_carts", `id=eq.${enc(input.cartId)}`);
  let fresh = false;
  let plan: CartPlan | null = null;
  let account: BillingConnectedAccountRow | null = null;
  let mirrorAllowed = true;
  if (cart) {
    assertCartOwner(cart, input, fingerprint);
  } else {
    account = await liveAccount(input.providerId);
    plan = input.expected_total_cents == null
      ? await planCart(input.providerId, input.lines, account.tax_enabled)
      : await assertQuoteCurrent(input.providerId, input.lines, input.expected_total_cents, account.tax_enabled);
    await assertAuthorizedTotal(account, plan, input);
    const claimed = await claimCart(input, plan, fingerprint, account);
    cart = claimed.cart; fresh = claimed.fresh;
  }
  if (!fresh) {
    // The account the first attempt was claimed against (pinned on the cart),
    // live or not: resuming must reach the exact Stripe account the objects
    // and idempotency keys live on, never an account the office reconnected to.
    const resume = await resumeAccount(cart, input.providerId);
    account = resume.account; mirrorAllowed = resume.mirrorAllowed;
    if (!resume.sameAccount) {
      const stored = storedPlan(cart);
      return { kind: "response", response: await abandonSwappedCart(await getStripe(), account, input, stored?.settings ?? (await getSettings())) };
    }
    if (cart.status === "ready") {
      const replay = await existingCheckout(input.cartId, input.patientId);
      if (replay) return { kind: "response", response: replay };
    }
    const age = Date.now() - new Date(cart.updated_at ?? cart.created_at).getTime();
    if (age < CART_IN_FLIGHT_MS) {
      throw new BillingCartError("Your checkout is still being processed. Try again in a moment.", 409, "idempotency_key");
    }
    // Stale staging cart (the first attempt died between inserts or after a
    // Stripe object came back): finish the SAME rows below on the plan the
    // first attempt persisted, so every derived id, amount, and Stripe
    // idempotency key replays exactly even if prices or the catalog moved since.
    plan = storedPlan(cart) ?? plan ?? await planCart(input.providerId, input.lines);
  }
  if (!plan || !account) throw new BillingCartError("Checkout could not be started. Try again.", 503);
  return { kind: "proceed", cart, plan, account, mirrorAllowed, fresh };
}

export type PendingGroup = { group: InternalGroup; order: BillingOrderRow; subscriptionId: string | null };

/**
 * Voids a Tap to Pay order's card-present intent, or throws. A successful
 * cancel is Stripe's proof that nothing can settle. When Stripe refuses, the
 * intent is re-read: already canceled is fine; captured or authorized means
 * money moved (or is moving) behind an unpaid row, which is refused with 409
 * and never buried under a failed row. Any other refusal, and any failure to
 * read, propagates so the order stays pending and the phone stays locked.
 */
async function releaseTapIntent(stripe: any, acct: string, order: BillingOrderRow): Promise<void> {
  const id = order.stripe_payment_intent_id!;
  const opts = connectedOpts(acct);
  const refuse = (intentId: string, status: string): never => {
    logger.error({ orderId: order.id, account: acct, intentId, status }, "tap to pay intent charged but the order is unpaid; needs staff resolution");
    throw new BillingCartError(TAP_ALREADY_CHARGED_MESSAGE, 409);
  };
  try {
    await stripe.paymentIntents.cancel(id, {}, opts);
    return;
  } catch (error) {
    if (isStripeMissing(error)) return;
    const intent: any = await stripe.paymentIntents.retrieve(id, {}, opts);
    if (intent?.status === "canceled") return;
    if (["succeeded", "requires_capture", "processing"].includes(String(intent?.status))) refuse(intent.id, intent.status);
    throw error;
  }
}
