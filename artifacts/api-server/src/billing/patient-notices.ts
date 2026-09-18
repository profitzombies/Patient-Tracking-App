/**
 * Patient push notices for billing events: a parcel shipped, a renewal coming
 * up, a renewal payment that failed. Each rides the shared patient outbox as
 * an account-level notice (not a patient preference; quiet hours still apply)
 * and carries a deep link the app allow-lists by kind + id — never a free-form
 * route the payload could point anywhere.
 *
 * Producers never throw into the caller: a notice that cannot be queued is
 * logged, and the money/fulfillment write it decorates stands on its own.
 */
import { logger } from "../lib/logger";
import { supabaseNotificationStore, type NotificationStore } from "../notifications/store";
import { formatCents } from "./money";
import { quoteRenewalShipping } from "./renewal-shipping";
import { selectMany } from "./store";
import type { BillingOrderRow, BillingShipmentRow, BillingSubscriptionRow } from "./store";

export const ORDER_SHIPPED_KIND = "order_shipped";
export const RENEWAL_UPCOMING_KIND = "subscription_renewal_upcoming";
export const PAYMENT_FAILED_KIND = "subscription_payment_failed";

/** Days before the next shipment the renewal reminder goes out. */
export const RENEWAL_REMINDER_DAYS = 3;

export function orderRoute(orderId: string): string { return `/orders/${orderId}`; }
export function subscriptionRoute(subscriptionId: string): string { return `/my-subscriptions/${subscriptionId}`; }

function shipDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

async function queue(store: NotificationStore, what: string, input: Parameters<NotificationStore["enqueue"]>[0]): Promise<boolean> {
  try {
    const { created } = await store.enqueue(input);
    return created;
  } catch (error) {
    logger.error({ err: error, kind: input.kind, patientId: input.patientId }, `${what} notice could not be queued`);
    return false;
  }
}

/** Once per order, when staff record a carrier and tracking number. */
export async function notifyOrderShipped(
  input: { order: BillingOrderRow; shipment: BillingShipmentRow },
  store: NotificationStore = supabaseNotificationStore,
): Promise<boolean> {
  const { order, shipment } = input;
  if (!order.patient_id || shipment.status !== "shipped") return false;
  const carrier = shipment.carrier ? ` with ${shipment.carrier}` : "";
  return queue(store, "order shipped", {
    patientId: order.patient_id,
    kind: ORDER_SHIPPED_KIND,
    category: "account",
    title: "Your order shipped",
    body: `Order ${order.order_number} is on its way${carrier}. Tap to track it.`,
    data: { route: orderRoute(order.id), kind: ORDER_SHIPPED_KIND, orderId: order.id, patientId: order.patient_id },
    dedupeKey: `${ORDER_SHIPPED_KIND}:${order.id}`,
  });
}

/** Once per failed invoice; the app opens the subscription with a retry-with-card path. */
export async function notifySubscriptionPaymentFailed(
  input: { subscription: BillingSubscriptionRow; productName: string; invoiceId: string; message: string },
  store: NotificationStore = supabaseNotificationStore,
): Promise<boolean> {
  const { subscription, productName, invoiceId, message } = input;
  if (!subscription.patient_id) return false;
  const reason = message.trim().replace(/\.?$/, ".");
  return queue(store, "payment failed", {
    patientId: subscription.patient_id,
    kind: PAYMENT_FAILED_KIND,
    category: "account",
    title: `${productName} payment didn't go through`,
    body: `${reason} Tap to retry with a saved card so your next shipment isn't delayed.`,
    data: {
      route: subscriptionRoute(subscription.id), kind: PAYMENT_FAILED_KIND,
      subscriptionId: subscription.id, patientId: subscription.patient_id, invoiceId,
    },
    dedupeKey: `${PAYMENT_FAILED_KIND}:${subscription.id}:${invoiceId}`,
  });
}

export interface UpcomingRenewal {
  subscription: BillingSubscriptionRow;
  productName: string;
}

/** Active, unpaused, non-ending subscriptions shipping within the reminder window. */
export async function loadUpcomingRenewals(now: Date, days = RENEWAL_REMINDER_DAYS): Promise<UpcomingRenewal[]> {
  const until = new Date(now.getTime() + days * 86_400_000);
  const rows = await selectMany("billing_subscriptions", [
    "status=eq.active", "paused_at=is.null", "cancel_at_period_end=is.false", "patient_id=not.is.null",
    `next_shipment_at=gte.${encodeURIComponent(now.toISOString())}`,
    `next_shipment_at=lte.${encodeURIComponent(until.toISOString())}`,
  ].join("&"));
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((row) => row.product_id))];
  const products = await selectMany("billing_products", `id=in.(${ids.map(encodeURIComponent).join(",")})`);
  const names = new Map(products.map((product) => [product.id, product.name]));
  return rows.map((subscription) => ({ subscription, productName: names.get(subscription.product_id) ?? "Your subscription" }));
}

export interface RenewalReminderSummary {
  evaluated: number;
  queued: number;
}

/**
 * One reminder per (subscription, shipment date): a moved or skipped shipment
 * earns a fresh reminder for its new date, a repeated tick does not.
 */
/** The amount the renewal will actually bill for shipping: a fresh quote, or the row's last amount when quoting is impossible. */
async function upcomingShippingCents(subscription: BillingSubscriptionRow): Promise<number> {
  try {
    const requote = await quoteRenewalShipping(subscription, false);
    return requote?.quote.patient_amount_cents ?? subscription.shipping_charge_cents;
  } catch { return subscription.shipping_charge_cents; }
}
export async function runRenewalReminderEvaluation(options: {
  store?: NotificationStore;
  now?: () => Date;
  days?: number;
  load?: (now: Date, days: number) => Promise<UpcomingRenewal[]>;
  /** Today's Shipping & handling for the renewal (the renewal itself is re-quoted the same way). */
  shipping?: (subscription: BillingSubscriptionRow) => Promise<number>;
} = {}): Promise<RenewalReminderSummary> {
  const store = options.store ?? supabaseNotificationStore;
  const now = (options.now ?? (() => new Date()))();
  const days = options.days ?? RENEWAL_REMINDER_DAYS;
  const upcoming = await (options.load ?? loadUpcomingRenewals)(now, days);
  let queued = 0;
  for (const { subscription, productName } of upcoming) {
    if (!subscription.patient_id || !subscription.next_shipment_at) continue;
    const dateKey = subscription.next_shipment_at.slice(0, 10);
    const shipping = await (options.shipping ?? upcomingShippingCents)(subscription);
    const total = subscription.unit_price_cents * Math.max(1, subscription.quantity ?? 1) + shipping;
    const created = await queue(store, "renewal reminder", {
      patientId: subscription.patient_id,
      kind: RENEWAL_UPCOMING_KIND,
      category: "account",
      title: `${productName} ships ${shipDate(subscription.next_shipment_at)}`,
      body: `Your card will be charged ${formatCents(total)} before any tax. Tap to move or skip this shipment, or change your card.`,
      data: {
        route: subscriptionRoute(subscription.id), kind: RENEWAL_UPCOMING_KIND,
        subscriptionId: subscription.id, patientId: subscription.patient_id, shipDate: dateKey,
      },
      dedupeKey: `${RENEWAL_UPCOMING_KIND}:${subscription.id}:${dateKey}`,
      expiresAt: new Date(subscription.next_shipment_at),
    });
    if (created) queued += 1;
  }
  return { evaluated: upcoming.length, queued };
}
