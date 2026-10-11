/**
 * Sample dataset for the patient Orders and Subscriptions suites (never
 * imported by app code). Anchored to the shared fixed TODAY so every
 * assertion renders the same story: one order in each shipment state plus a
 * refund, and one subscription in each self-service state including a
 * failed renewal.
 */
import { TODAY } from '@/data/patient-data';
import type {
  PatientBillingOrder,
  PatientCard,
  PatientOrderDetail,
  PatientShipment,
  PatientSubscriptionDetail,
  ShippingAddress,
} from '@/lib/patient-billing-types';

function daysFromToday(days: number, hour = 14): string {
  const date = new Date(TODAY);
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

export const SAMPLE_ADDRESS: ShippingAddress = {
  name: 'Demo Patient', line1: '100 Wellness Way', line2: 'Apt 4B', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US', phone: null,
};
const SAMPLE_SHIPPING = {
  method: 'standard' as const,
  source: 'fallback' as const,
  carrier_service_name: null,
  delivery_window_start: null,
  delivery_window_end: null,
};

export const SAMPLE_CARDS: PatientCard[] = [
  { id: 'demo-card-visa', brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2029, is_default: true },
  { id: 'demo-card-amex', brand: 'amex', last4: '0005', exp_month: 11, exp_year: 2028, is_default: false },
];

const idle = (updated: string): PatientShipment => ({
  status: 'processing', carrier: null, tracking_number: null, tracking_url: null,
  shipped_at: null, delivered_at: null, canceled_at: null, updated_at: updated,
});

export const SAMPLE_ORDER_DETAILS: PatientOrderDetail[] = [
  {
    id: 'demo-order-processing', order_number: 'TH-D3MO04', kind: 'subscription_renewal', status: 'paid', fulfillment_status: 'to_ship',
    total_cents: 7299, refunded_cents: 0, item_count: 1, items_label: 'Control × 1',
    created_at: daysFromToday(0, 9), paid_at: daysFromToday(0, 9), receipt_available: true,
    shipment: idle(daysFromToday(0, 9)), subscription_id: 'demo-sub-active', cart_id: null, shipping: SAMPLE_SHIPPING,
    items: [{ product_id: 'demo-control', name: 'Control', quantity: 1, unit_price_cents: 6299, line_total_cents: 6299 }],
    subtotal_cents: 6299, shipping_charge_cents: 1000, tax_cents: 0, refunds: [], shipping_address: SAMPLE_ADDRESS, failure_message: null,
  },
  {
    id: 'demo-order-shipped', order_number: 'TH-D3MO03', kind: 'one_time', status: 'paid', fulfillment_status: 'shipped',
    total_cents: 8998, refunded_cents: 0, item_count: 2, items_label: 'Protein × 1, Hydrate × 1',
    created_at: daysFromToday(-4, 15), paid_at: daysFromToday(-4, 15), receipt_available: true,
    shipment: {
      status: 'shipped', carrier: 'USPS', tracking_number: '9400111899223197428490',
      tracking_url: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490',
      shipped_at: daysFromToday(-3, 16), delivered_at: null, canceled_at: null, updated_at: daysFromToday(-3, 16),
    },
    subscription_id: null, cart_id: 'demo-cart-1', shipping: SAMPLE_SHIPPING,
    items: [
      { product_id: 'demo-protein', name: 'Protein', quantity: 1, unit_price_cents: 4499, line_total_cents: 4499 },
      { product_id: 'demo-hydrate', name: 'Hydrate', quantity: 1, unit_price_cents: 3499, line_total_cents: 3499 },
    ],
    subtotal_cents: 7998, shipping_charge_cents: 1000, tax_cents: 0, refunds: [], shipping_address: SAMPLE_ADDRESS, failure_message: null,
  },
  {
    id: 'demo-order-delivered', order_number: 'TH-D3MO02', kind: 'subscription_renewal', status: 'partially_refunded', fulfillment_status: 'shipped',
    total_cents: 7299, refunded_cents: 1000, item_count: 1, items_label: 'Control × 1',
    created_at: daysFromToday(-28, 9), paid_at: daysFromToday(-28, 9), receipt_available: true,
    shipment: {
      status: 'delivered', carrier: 'UPS', tracking_number: '1Z999AA10123456784',
      tracking_url: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
      shipped_at: daysFromToday(-27, 17), delivered_at: daysFromToday(-24, 13), canceled_at: null, updated_at: daysFromToday(-24, 13),
    },
    subscription_id: 'demo-sub-active', cart_id: null, shipping: SAMPLE_SHIPPING,
    items: [{ product_id: 'demo-control', name: 'Control', quantity: 1, unit_price_cents: 6299, line_total_cents: 6299 }],
    subtotal_cents: 6299, shipping_charge_cents: 1000, tax_cents: 0,
    refunds: [{ amount_cents: 1000, status: 'succeeded', created_at: daysFromToday(-22, 10) }],
    shipping_address: SAMPLE_ADDRESS, failure_message: null,
  },
  {
    id: 'demo-order-canceled', order_number: 'TH-D3MO01', kind: 'one_time', status: 'refunded', fulfillment_status: 'to_ship',
    total_cents: 4499, refunded_cents: 4499, item_count: 1, items_label: 'Protein × 1',
    created_at: daysFromToday(-40, 11), paid_at: daysFromToday(-40, 11), receipt_available: true,
    shipment: {
      status: 'canceled', carrier: null, tracking_number: null, tracking_url: null,
      shipped_at: null, delivered_at: null, canceled_at: daysFromToday(-39, 9), updated_at: daysFromToday(-39, 9),
    },
    subscription_id: null, cart_id: null, shipping: SAMPLE_SHIPPING,
    items: [{ product_id: 'demo-protein', name: 'Protein', quantity: 1, unit_price_cents: 4499, line_total_cents: 4499 }],
    subtotal_cents: 4499, shipping_charge_cents: 0, tax_cents: 0,
    refunds: [{ amount_cents: 4499, status: 'succeeded', created_at: daysFromToday(-39, 9) }],
    shipping_address: SAMPLE_ADDRESS, failure_message: null,
  },
  {
    id: 'demo-order-failed', order_number: 'TH-D3MO05', kind: 'subscription_renewal', status: 'failed', fulfillment_status: 'to_ship',
    total_cents: 4149, refunded_cents: 0, item_count: 1, items_label: 'Hydrate × 1',
    created_at: daysFromToday(-1, 8), paid_at: null, receipt_available: false,
    shipment: idle(daysFromToday(-1, 8)), subscription_id: 'demo-sub-failed', cart_id: null, shipping: SAMPLE_SHIPPING,
    items: [{ product_id: 'demo-hydrate', name: 'Hydrate', quantity: 1, unit_price_cents: 3149, line_total_cents: 3149 }],
    subtotal_cents: 3149, shipping_charge_cents: 1000, tax_cents: 0, refunds: [], shipping_address: SAMPLE_ADDRESS,
    failure_message: 'Your card was declined.',
  },
];

export const SAMPLE_ORDERS: PatientBillingOrder[] = SAMPLE_ORDER_DETAILS
  .map(({ items: _items, subtotal_cents: _s, shipping_charge_cents: _c, tax_cents: _t, refunds: _r, shipping_address: _a, failure_message: _f, ...order }) => order)
  .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

export const SAMPLE_SUBSCRIPTIONS: PatientSubscriptionDetail[] = [
  {
    id: 'demo-sub-active', product_name: 'Control', product_id: 'demo-control', unit_price_cents: 6299, shipping_charge_cents: 1000,
    status: 'active', paused: false, current_period_end: daysFromToday(28, 9), cancel_at_period_end: false,
    last_hosted_invoice_url: null, last_failure_message: null, cadence_weeks: 4, quantity: 1,
    next_shipment_at: daysFromToday(28, 9), shipping_address: SAMPLE_ADDRESS, shipping: SAMPLE_SHIPPING,
    card: SAMPLE_CARDS[0], offered_cadences_weeks: [4, 8],
  },
  {
    id: 'demo-sub-failed', product_name: 'Hydrate', product_id: 'demo-hydrate', unit_price_cents: 3149, shipping_charge_cents: 1000,
    status: 'past_due', paused: false, current_period_end: daysFromToday(-1, 8), cancel_at_period_end: false,
    last_hosted_invoice_url: 'https://invoice.stripe.com/i/demo', last_failure_message: 'Your card was declined.', cadence_weeks: 4, quantity: 1,
    next_shipment_at: daysFromToday(-1, 8), shipping_address: SAMPLE_ADDRESS, shipping: SAMPLE_SHIPPING,
    card: SAMPLE_CARDS[0], offered_cadences_weeks: [4, 8],
  },
  {
    id: 'demo-sub-paused', product_name: 'Protein', product_id: 'demo-protein', unit_price_cents: 4049, shipping_charge_cents: 1000,
    status: 'active', paused: true, current_period_end: daysFromToday(45, 9), cancel_at_period_end: false,
    last_hosted_invoice_url: null, last_failure_message: null, cadence_weeks: 8, quantity: 2,
    next_shipment_at: daysFromToday(45, 9), shipping_address: SAMPLE_ADDRESS, shipping: SAMPLE_SHIPPING,
    card: SAMPLE_CARDS[1], offered_cadences_weeks: [4, 8],
  },
  {
    id: 'demo-sub-ending', product_name: 'Hydrate', product_id: 'demo-hydrate', unit_price_cents: 3149, shipping_charge_cents: 1000,
    status: 'active', paused: false, current_period_end: daysFromToday(12, 9), cancel_at_period_end: true,
    last_hosted_invoice_url: null, last_failure_message: null, cadence_weeks: 4, quantity: 1,
    next_shipment_at: daysFromToday(12, 9), shipping_address: SAMPLE_ADDRESS, shipping: SAMPLE_SHIPPING,
    card: SAMPLE_CARDS[0], offered_cadences_weeks: [4],
  },
];

export function demoOrder(id: string): PatientOrderDetail | null {
  return SAMPLE_ORDER_DETAILS.find(order => order.id === id) ?? null;
}

export function demoSubscription(id: string): PatientSubscriptionDetail | null {
  return SAMPLE_SUBSCRIPTIONS.find(subscription => subscription.id === id) ?? null;
}
