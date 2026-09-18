import { logger } from "../lib/logger";
import { syncSubscriptionAddress } from "./warehouse-submissions";
import { cardDto } from "./cards";
import { notifySubscriptionEvent, planLabel } from "./customer-emails";
import { getSettings, productCadences, subscribeSavePercent, subscriptionUnitPrice } from "./catalog";
import { applicationFeePercentFor, breakEvenMinimum, computeOrderFees } from "./fees";
import { ensureRecurringPrices } from "./prices";
import { connectedOpts, getStripe, isStripeMissing } from "./stripe-client";
import { selectOne, update, type BillingConnectedAccountRow, type BillingSubscriptionRow } from "./store";
import { accountFor, BillingSubscriptionError, mappedStatus, nextShipmentAt, periodEnd } from "./subscriptions";
import type { PatientCard, ShippingAddress } from "./types";

/**
 * Patient self-service on their own subscriptions. Every operation maps to one
 * Stripe call on the office's connected account and then mirrors the result
 * onto the same row columns staff screens read (status, period end, next
 * shipment, cadence, quantity, address).
 */
const enc = encodeURIComponent;
const DAY_MS = 86_400_000;
export const MOVE_MIN_DAYS = 1;
export const MOVE_MAX_DAYS = 365;

type Row = BillingSubscriptionRow;

function requireLive(row: Row): void {
  if (!row.stripe_subscription_id) throw new BillingSubscriptionError("Subscription setup is not complete.", 409);
  if (row.status === "canceled") throw new BillingSubscriptionError("This subscription is canceled.", 409);
}
function requireSchedulable(row: Row): void {
  requireLive(row);
  if (row.paused_at) throw new BillingSubscriptionError("Resume the subscription first.", 409);
  if (row.cancel_at_period_end) throw new BillingSubscriptionError("This subscription ends after the current period.", 409);
  if (row.status !== "active") throw new BillingSubscriptionError("Bring the subscription current first.", 409);
}

async function mirrorSchedule(row: Row, value: any): Promise<Row> {
  const updated = await update("billing_subscriptions", `id=eq.${enc(row.id)}`, {
    status: mappedStatus(value.status), current_period_end: periodEnd(value),
    next_shipment_at: nextShipmentAt(value, row),
    cancel_at_period_end: Boolean(value.cancel_at_period_end),
  });
  if (!updated) throw new BillingSubscriptionError("Subscription could not be updated.", 502);
  return updated;
}

/** Parses a YYYY-MM-DD date (noon UTC, so every US zone lands on that calendar day) or an ISO timestamp. */
export function parseMoveDate(raw: string, now: Date = new Date()): Date {
  const text = String(raw ?? "").trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const parsed = new Date(dateOnly ? `${text}T12:00:00.000Z` : text);
  if (Number.isNaN(parsed.getTime())) throw new BillingSubscriptionError("Choose a valid date.", 400, "next_shipment_at");
  const days = (parsed.getTime() - now.getTime()) / DAY_MS;
  if (days < MOVE_MIN_DAYS) throw new BillingSubscriptionError("Choose a date at least a day from now.", 400, "next_shipment_at");
  if (days > MOVE_MAX_DAYS) throw new BillingSubscriptionError("Choose a date within the next year.", 400, "next_shipment_at");
  return parsed;
}

/** Moves the next shipment (and charge) to a chosen date; later renewals follow from there. */
export async function moveNextShipment(row: Row, when: Date, event: "moved" | "skipped" = "moved"): Promise<Row> {
  requireSchedulable(row);
  const account = await accountFor(row.provider_id);
  const value: any = await (await getStripe()).subscriptions.update(row.stripe_subscription_id!, {
    trial_end: Math.floor(when.getTime() / 1000), proration_behavior: "none",
  }, connectedOpts(account.stripe_account_id));
  const updated = await mirrorSchedule(row, value);
  await notifySubscriptionEvent(updated, event === "skipped"
    ? { kind: "skipped", skipped: row.next_shipment_at ?? row.current_period_end }
    : { kind: "moved", previous: row.next_shipment_at ?? row.current_period_end });
  return updated;
}

/** Skips one box: the next shipment moves out by one cadence. */
export async function skipNextShipment(row: Row): Promise<Row> {
  requireSchedulable(row);
  const anchor = row.next_shipment_at ?? row.current_period_end;
  if (!anchor) throw new BillingSubscriptionError("The next shipment date is not known yet.", 409);
  const weeks = row.cadence_weeks ?? 4;
  const target = new Date(new Date(anchor).getTime() + weeks * 7 * DAY_MS);
  const floor = new Date(Date.now() + MOVE_MIN_DAYS * DAY_MS);
  return moveNextShipment(row, target > floor ? target : new Date(floor.getTime() + weeks * 7 * DAY_MS), "skipped");
}

export async function changeSubscriptionAddress(row: Row, address: ShippingAddress): Promise<Row> {
  requireLive(row);
  const account = await accountFor(row.provider_id);
  if (row.stripe_customer_id) {
    try {
      await (await getStripe()).customers.update(row.stripe_customer_id, {
        shipping: {
          name: address.name, phone: address.phone ?? undefined,
          address: { line1: address.line1, line2: address.line2 ?? undefined, city: address.city, state: address.state, postal_code: address.postal_code, country: address.country },
        },
      }, connectedOpts(account.stripe_account_id));
    } catch (error) { if (!isStripeMissing(error)) throw error; }
  }
  const updated = await update("billing_subscriptions", `id=eq.${enc(row.id)}`, { shipping_address: address as unknown as Record<string, unknown> });
  if (!updated) throw new BillingSubscriptionError("Subscription could not be updated.", 502);
  // Unshipped orders of this subscription follow the change: pending warehouse
  // intents read the (now updated) order row; already-sent orders are edited at
  // the warehouse while their status allows it, otherwise reported locked so the
  // patient learns the change applies to future shipments only.
  const sync = await syncSubscriptionAddress(row.id, address).catch((error) => {
    logger.warn({ subscriptionId: row.id, err: error instanceof Error ? error.message : String(error) }, "warehouse address sync failed");
    return { applied: [], locked: [], unavailable: [] };
  });
  lastAddressSync.set(row.id, sync);
  await notifySubscriptionEvent(updated, { kind: "address-changed" });
  return updated;
}
/** Result of the most recent warehouse address sync per subscription (read once by the route that returns it). */
const lastAddressSync = new Map<string, { applied: string[]; locked: string[]; unavailable: string[] }>();
export function takeAddressSync(subscriptionId: string): { applied: string[]; locked: string[]; unavailable: string[] } | null {
  const sync = lastAddressSync.get(subscriptionId) ?? null;
  lastAddressSync.delete(subscriptionId);
  return sync;
}

async function subscriptionItems(stripe: any, acct: string, row: Row, priceRow: { stripe_price_id: string | null; stripe_shipping_price_id: string | null; stripe_product_id: string | null; stripe_cadence_prices: Record<string, { price_id: string; shipping_price_id: string }> }) {
  const live: any = await stripe.subscriptions.retrieve(row.stripe_subscription_id!, { expand: ["items.data.price"] }, connectedOpts(acct));
  const shippingIds = new Set<string>([priceRow.stripe_shipping_price_id, row.stripe_shipping_price_id,
    ...Object.values(priceRow.stripe_cadence_prices ?? {}).map((entry) => entry.shipping_price_id)].filter(Boolean) as string[]);
  const items: any[] = live.items?.data ?? [];
  const shipping = items.find((item) => shippingIds.has(item.price?.id));
  const product = items.find((item) => item !== shipping && (
    item.price?.id === row.stripe_price_id || item.price?.id === priceRow.stripe_price_id
    || (typeof item.price?.product === "string" ? item.price.product : item.price?.product?.id) === priceRow.stripe_product_id
  )) ?? items.find((item) => item !== shipping);
  if (!product) throw new BillingSubscriptionError("Subscription items could not be read.", 502);
  return { live, product, shipping };
}

/**
 * Changes cadence and/or units per shipment in place: the current period is
 * untouched (no proration), the next renewal bills the new plan, and the
 * platform fee is re-derived for the new quantity.
 */
export async function changeSubscriptionPlan(row: Row, input: { cadence_weeks?: number; quantity?: number }): Promise<Row> {
  requireLive(row);
  if (row.paused_at) throw new BillingSubscriptionError("Resume the subscription first.", 409);
  const weeks = input.cadence_weeks ?? row.cadence_weeks ?? 4;
  const quantity = input.quantity ?? row.quantity ?? 1;
  if (weeks === (row.cadence_weeks ?? 4) && quantity === (row.quantity ?? 1)) {
    throw new BillingSubscriptionError("That is already the current plan.", 409);
  }
  const [product, settings] = await Promise.all([
    selectOne("billing_products", `id=eq.${enc(row.product_id)}`), getSettings(),
  ]);
  if (!product || !product.active) throw new BillingSubscriptionError("This product is no longer offered.", 409);
  if (!productCadences(product).offered_cadences_weeks.includes(weeks as 2 | 4 | 6 | 8 | 10 | 12)) {
    throw new BillingSubscriptionError(`${product.name} is not offered every ${weeks} weeks.`, 400, "cadence_weeks");
  }
  const priceRow = await ensureRecurringPrices(row.provider_id, row.product_id);
  if (!priceRow?.subscription_enabled) throw new BillingSubscriptionError("Your office no longer offers this subscription.", 409);
  const cadence = priceRow.stripe_cadence_prices?.[String(weeks)];
  if (!cadence?.price_id || !cadence.shipping_price_id) throw new BillingSubscriptionError("Subscription pricing is unavailable.", 409);
  const unit = subscriptionUnitPrice(priceRow.sell_price_cents, subscribeSavePercent(settings));
  if (unit < breakEvenMinimum(product.floor_price_cents, settings)) {
    throw new BillingSubscriptionError(`${product.name} cannot be subscribed at the current discount.`, 409);
  }
  const fees = computeOrderFees([{ floor_price_cents: product.floor_price_cents, quantity }], settings);
  const total = unit * quantity + settings.shipping_charge_cents;
  const account = await accountFor(row.provider_id);
  const stripe = await getStripe();
  const { product: productItem, shipping: shippingItem } = await subscriptionItems(stripe, account.stripe_account_id, row, priceRow);
  const items = [
    { id: productItem.id, price: cadence.price_id, quantity },
    ...(shippingItem ? [{ id: shippingItem.id, price: cadence.shipping_price_id, quantity: 1 }] : [{ price: cadence.shipping_price_id, quantity: 1 }]),
  ];
  // A cadence change swaps prices whose recurring interval differs. Stripe
  // resets the billing-cycle anchor (and invoices immediately) on an interval
  // change unless told to keep it, so the anchor is pinned explicitly: the new
  // cadence and quantity start at the next renewal, nothing is charged now.
  const value: any = await stripe.subscriptions.update(row.stripe_subscription_id!, {
    items, proration_behavior: "none", billing_cycle_anchor: "unchanged",
    application_fee_percent: applicationFeePercentFor(fees.application_fee_cents, total),
  } as any, connectedOpts(account.stripe_account_id));
  const updated = await update("billing_subscriptions", `id=eq.${enc(row.id)}`, {
    cadence_weeks: weeks, quantity, unit_price_cents: unit, shipping_charge_cents: settings.shipping_charge_cents,
    shipping_cost_cents: settings.shipping_cost_cents, application_fee_cents: fees.application_fee_cents,
    stripe_price_id: cadence.price_id, stripe_shipping_price_id: cadence.shipping_price_id,
    status: mappedStatus(value.status), current_period_end: periodEnd(value), next_shipment_at: nextShipmentAt(value, row),
  });
  if (!updated) throw new BillingSubscriptionError("Subscription could not be updated.", 502);
  await notifySubscriptionEvent(updated, {
    kind: "plan-changed", previousPlan: planLabel(product.name, row.quantity, row.cadence_weeks), newPlan: planLabel(product.name, quantity, weeks),
  });
  return updated;
}

/** Points renewals at a card the patient owns (attaching a freshly entered one first). */
export async function updateSubscriptionCard(row: Row, customerId: string, paymentMethodId: string): Promise<Row> {
  requireLive(row);
  const account = await accountFor(row.provider_id);
  const acct = account.stripe_account_id;
  const stripe = await getStripe();
  let method: any;
  try { method = await stripe.paymentMethods.retrieve(paymentMethodId, {}, connectedOpts(acct)); }
  catch (error) {
    if (isStripeMissing(error)) throw new BillingSubscriptionError("Card not found.", 404, "payment_method_id");
    throw error;
  }
  const owner = typeof method.customer === "string" ? method.customer : method.customer?.id ?? null;
  if (owner && owner !== customerId) throw new BillingSubscriptionError("That card belongs to a different account.", 403, "payment_method_id");
  if (!owner) await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }, connectedOpts(acct, `card:${customerId}:attach:${paymentMethodId}`));
  await stripe.subscriptions.update(row.stripe_subscription_id!, { default_payment_method: paymentMethodId }, connectedOpts(acct));
  const updated = (await selectOne("billing_subscriptions", `id=eq.${enc(row.id)}`)) ?? row;
  await notifySubscriptionEvent(updated, { kind: "card-updated", paymentMethod: method });
  return updated;
}

/** The card Stripe will charge at the next renewal (subscription default, else customer default). */
export async function subscriptionCard(row: Row, account: BillingConnectedAccountRow): Promise<PatientCard | null> {
  if (!row.stripe_subscription_id) return null;
  const stripe = await getStripe();
  const acct = account.stripe_account_id;
  try {
    const live: any = await stripe.subscriptions.retrieve(row.stripe_subscription_id, {
      expand: ["default_payment_method", "customer.invoice_settings.default_payment_method"],
    }, connectedOpts(acct));
    const own = live.default_payment_method && typeof live.default_payment_method === "object" ? live.default_payment_method : null;
    const customerDefault = live.customer && typeof live.customer === "object" ? live.customer.invoice_settings?.default_payment_method : null;
    const method = own ?? (customerDefault && typeof customerDefault === "object" ? customerDefault : null);
    return method ? cardDto(method, method.id) : null;
  } catch (error) {
    if (isStripeMissing(error)) return null;
    throw error;
  }
}
