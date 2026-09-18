/**
 * Pure rules behind the patient Orders and Subscriptions screens: labels,
 * shipment panel states, which self-service actions a subscription offers,
 * and the allowed window for moving the next shipment. No React, no I/O, so
 * the RTR suites and the screens share one source of truth.
 */
import type {
  PatientBillingOrder,
  PatientBillingSubscription,
  PatientShippingChoice,
  PatientShipment,
  ShippingAddress,
} from '@/lib/patient-billing-types';

export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return 'Not available';
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function shortDateTime(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function dateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats WarehouseCraft calendar dates in the device timezone without treating them as ISO instants. */
export function arrivalWindow(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const first = dateOnly(start);
  const last = dateOnly(end);
  if (!first || !last) return null;
  const format = (date: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
    return `${part('weekday')} ${part('month')} ${part('day')}`;
  };
  const firstText = format(first);
  const lastText = format(last);
  return firstText === lastText ? `Arrives ${firstText}` : `Arrives ${firstText} – ${lastText}`;
}

export function shippingChoiceLabel(shipping: PatientShippingChoice): string {
  if (shipping.source === 'fallback') return 'Standard shipping';
  return shipping.method === 'expedited' ? 'Expedited shipping' : 'Standard shipping';
}

export function errorMessage(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : 'That didn’t go through. Please try again.';
}

/* ------------------------------- orders -------------------------------- */

export const ORDER_STATUS_LABEL: Record<PatientBillingOrder['status'], string> = {
  paid: 'Paid',
  pending: 'Pending',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
  failed: 'Payment failed',
  canceled: 'Canceled',
  disputed: 'Disputed',
};

export type BadgeTone = 'healthy' | 'watch' | 'risk' | 'neutral';

export function orderStatusTone(status: PatientBillingOrder['status']): BadgeTone {
  if (status === 'paid') return 'healthy';
  if (status === 'pending' || status === 'partially_refunded') return 'watch';
  if (status === 'refunded' || status === 'canceled') return 'neutral';
  return 'risk';
}

export function orderKindLabel(kind: PatientBillingOrder['kind']): string {
  if (kind === 'subscription_renewal') return 'Subscription delivery';
  if (kind === 'subscription_initial') return 'Subscription start';
  return 'One-time order';
}

export type ShipmentPanelState = 'processing' | 'shipped' | 'delivered' | 'canceled' | 'not_applicable';

export interface ShipmentPanel {
  state: ShipmentPanelState;
  title: string;
  detail: string;
  tone: BadgeTone;
  /** Carrier + tracking number when a label exists. */
  tracking: { carrier: string; number: string; url: string | null } | null;
}

/**
 * The shipment panel says "Processing" until staff record a tracking number,
 * then "Shipped" (with a tap-to-open tracking link when the carrier is
 * recognized), "Delivered" when known, or "Canceled". Orders that never
 * ship (failed, canceled, or fully refunded before fulfillment) get no
 * fulfillment promise at all.
 */
export function shipmentPanel(order: Pick<PatientBillingOrder, 'status'>, shipment: PatientShipment): ShipmentPanel {
  const tracking = shipment.tracking_number
    ? { carrier: shipment.carrier ?? 'Carrier', number: shipment.tracking_number, url: shipment.tracking_url }
    : null;
  if (shipment.status === 'canceled') {
    return { state: 'canceled', title: 'Canceled', detail: `This shipment was canceled${shipment.canceled_at ? ` on ${shortDate(shipment.canceled_at)}` : ''}.`, tone: 'neutral', tracking };
  }
  if (shipment.status === 'delivered') {
    return { state: 'delivered', title: 'Delivered', detail: shipment.delivered_at ? `Delivered ${shortDate(shipment.delivered_at)}.` : 'Your order has been delivered.', tone: 'healthy', tracking };
  }
  if (shipment.status === 'shipped') {
    return { state: 'shipped', title: 'Shipped', detail: shipment.shipped_at ? `Shipped ${shortDate(shipment.shipped_at)}${tracking ? ` with ${tracking.carrier}` : ''}.` : 'Your order is on its way.', tone: 'healthy', tracking };
  }
  if (order.status === 'failed' || order.status === 'canceled' || order.status === 'refunded') {
    return { state: 'not_applicable', title: 'Not shipping', detail: order.status === 'failed' ? 'The payment did not go through, so nothing will ship.' : 'This order will not ship.', tone: 'neutral', tracking };
  }
  return { state: 'processing', title: 'Processing', detail: 'Your office is preparing this order. Tracking appears here once it ships.', tone: 'watch', tracking };
}

/* ---------------------------- subscriptions ---------------------------- */

export interface SubscriptionStatusLabel {
  label: string;
  tone: BadgeTone;
}

export function subscriptionStatus(subscription: PatientBillingSubscription): SubscriptionStatusLabel {
  if (subscription.status === 'canceled') return { label: 'Canceled', tone: 'neutral' };
  if (subscription.cancel_at_period_end) return { label: `Ends ${shortDate(subscription.current_period_end)}`, tone: 'watch' };
  if (subscription.status === 'past_due' || subscription.status === 'unpaid') return { label: 'Payment failed', tone: 'risk' };
  if (subscription.paused) return { label: 'Paused', tone: 'watch' };
  if (subscription.status === 'active') return { label: 'Active', tone: 'healthy' };
  return { label: 'Pending', tone: 'watch' };
}

export function cadenceLabel(weeks: number): string {
  if (weeks === 4) return 'Every 4 weeks';
  if (weeks === 1) return 'Every week';
  return `Every ${weeks} weeks`;
}

export interface SubscriptionActions {
  moveNext: boolean;
  skipNext: boolean;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  address: boolean;
  plan: boolean;
  card: boolean;
  retryPayment: boolean;
}

/**
 * Which self-service controls a subscription offers right now. Scheduling
 * changes (move, skip) need a live, unpaused, non-ending subscription; a
 * failed renewal leads with retry and card changes; an ended subscription
 * offers nothing.
 */
export function subscriptionActions(subscription: PatientBillingSubscription): SubscriptionActions {
  const ended = subscription.status === 'canceled';
  const ending = subscription.cancel_at_period_end;
  const failed = subscription.status === 'past_due' || subscription.status === 'unpaid';
  const scheduling = !ended && !ending && !subscription.paused && subscription.status === 'active';
  return {
    moveNext: scheduling,
    skipNext: scheduling,
    pause: scheduling,
    resume: !ended && !ending && subscription.paused,
    cancel: !ended && !ending,
    address: !ended,
    plan: scheduling,
    card: !ended,
    retryPayment: failed && !ended,
  };
}

/** Local calendar key (YYYY-MM-DD) for a date. */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Tomorrow through one year out, in the device's calendar (the server enforces the same window in UTC). */
const DAY_MS = 86_400_000;
export const MOVE_MIN_DAYS = 1;
export const MOVE_MAX_DAYS = 365;

/** UTC calendar key (YYYY-MM-DD) of an instant; date-only picks are anchored at noon UTC server-side. */
export function utcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Allowed move window, computed with the server's rule: a date-only pick is
 * read as noon UTC and must land at least one day and at most a year from now.
 * Deriving the bounds from the same rule (rather than local calendar days)
 * means the picker never offers a day the API will reject, whatever the
 * device time zone or time of day.
 */
export function moveWindow(now: Date): { min: string; max: string } {
  const earliest = now.getTime() + MOVE_MIN_DAYS * DAY_MS;
  const latest = now.getTime() + MOVE_MAX_DAYS * DAY_MS;
  const min = new Date(earliest);
  if (min.getUTCHours() >= 12) min.setUTCDate(min.getUTCDate() + 1);
  const max = new Date(latest);
  if (max.getUTCHours() < 12) max.setUTCDate(max.getUTCDate() - 1);
  return { min: utcDateKey(min), max: utcDateKey(max) };
}

/** True when a date-only pick satisfies the server's window rule right now. */
export function moveDateAllowed(key: string, now: Date): boolean {
  const days = (Date.parse(`${key}T12:00:00.000Z`) - now.getTime()) / DAY_MS;
  return days >= MOVE_MIN_DAYS && days <= MOVE_MAX_DAYS;
}

export function quantityLabel(quantity: number): string {
  return quantity === 1 ? '1 unit' : `${quantity} units`;
}

export function addressLines(address: ShippingAddress): string[] {
  return [
    address.name,
    address.line1,
    address.line2 ?? '',
    `${address.city}, ${address.state} ${address.postal_code}`,
    address.country !== 'US' ? address.country : '',
  ].filter(line => line.length > 0);
}

export function cardLabel(card: { brand: string; last4: string; exp_month: number; exp_year: number }): string {
  const brand = card.brand.length <= 4 ? card.brand.toUpperCase() : card.brand.charAt(0).toUpperCase() + card.brand.slice(1);
  return `${brand} •••• ${card.last4} · exp ${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}`;
}

/* ------------------------------ deep links ----------------------------- */

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function orderHref(orderId: string): string {
  return `/orders/${encodeURIComponent(orderId)}`;
}
export function subscriptionHref(subscriptionId: string): string {
  return `/my-subscriptions/${encodeURIComponent(subscriptionId)}`;
}
