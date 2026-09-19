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
import { selectMany } from "./store";
import type { BillingOrderRow, BillingShipmentRow, BillingSubscriptionRow } from "./store";

export const ORDER_SHIPPED_KIND = "order_shipped";
export const RENEWAL_UPCOMING_KIND = "subscription_renewal_upcoming";
export const PAYMENT_FAILED_KIND = "subscription_payment_failed";

/** Days before the next shipment the renewal reminder goes out. */
export const RENEWAL_REMINDER_DAYS = 3;

/**
 * Lock-screen copy. Pushes ride Expo's servers (no BAA), so none of these
 * name a product, an amount, a carrier, or an order number: the order and
 * subscription screens the deep link opens carry the detail.
 */
export const ORDER_SHIPPED_TITLE = "Your order is on its way";
export const ORDER_SHIPPED_BODY = "Open the app to track it.";
export const PAYMENT_FAILED_TITLE = "A payment didn't go through";
export const PAYMENT_FAILED_BODY = "Open the app to update your card so your next shipment isn't delayed.";
export const RENEWAL_UPCOMING_TITLE = "Your next shipment is coming up";
export const RENEWAL_UPCOMING_BODY = "Open the app to review the date, the amount, or your card.";

export function orderRoute(orderId: string): string { return `/orders/${orderId}`; }
export function subscriptionRoute(subscriptionId: string): string { return `/my-subscriptions/${subscriptionId}`; }

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
  return queue(store, "order shipped", {
    patientId: order.patient_id,
    kind: ORDER_SHIPPED_KIND,
    category: "account",
    title: ORDER_SHIPPED_TITLE,
    body: ORDER_SHIPPED_BODY,
    data: { route: orderRoute(order.id), kind: ORDER_SHIPPED_KIND, orderId: order.id, patientId: order.patient_id },
    dedupeKey: `${ORDER_SHIPPED_KIND}:${order.id}`,
  });
}

/** Once per failed invoice; the app opens the subscription with a retry-with-card path. */
export async function notifySubscriptionPaymentFailed(
  input: { subscription: BillingSubscriptionRow; productName: string; invoiceId: string; message: string },
  store: NotificationStore = supabaseNotificationStore,
): Promise<boolean> {
  const { subscription, invoiceId } = input;
  if (!subscription.patient_id) return false;
  return queue(store, "payment failed", {
    patientId: subscription.patient_id,
    kind: PAYMENT_FAILED_KIND,
    category: "account",
    title: PAYMENT_FAILED_TITLE,
    body: PAYMENT_FAILED_BODY,
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
export async function runRenewalReminderEvaluation(options: {
  store?: NotificationStore;
  now?: () => Date;
  days?: number;
  load?: (now: Date, days: number) => Promise<UpcomingRenewal[]>;
} = {}): Promise<RenewalReminderSummary> {
  const store = options.store ?? supabaseNotificationStore;
  const now = (options.now ?? (() => new Date()))();
  const days = options.days ?? RENEWAL_REMINDER_DAYS;
  const upcoming = await (options.load ?? loadUpcomingRenewals)(now, days);
  let queued = 0;
  for (const { subscription } of upcoming) {
    if (!subscription.patient_id || !subscription.next_shipment_at) continue;
    const dateKey = subscription.next_shipment_at.slice(0, 10);
    const created = await queue(store, "renewal reminder", {
      patientId: subscription.patient_id,
      kind: RENEWAL_UPCOMING_KIND,
      category: "account",
      title: RENEWAL_UPCOMING_TITLE,
      body: RENEWAL_UPCOMING_BODY,
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
