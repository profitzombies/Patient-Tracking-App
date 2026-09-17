/**
 * Shared per-patient purchases fixture for the web purchases suite. Typed
 * against the real wire shape so a PatientPurchasesSummary change breaks the
 * fixture instead of silently drifting the suite.
 */
import type { PatientPurchasesSummary } from '../../src/lib/billing-types';

export const PURCHASES_PATIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

export const PURCHASES_FIXTURE: PatientPurchasesSummary = {
  patient_id: PURCHASES_PATIENT_ID,
  subscriptions: [
    {
      id: 'sub-1', product_id: 'prod-1', product_name: 'Protocol Drops', unit_price_cents: 8900, shipping_charge_cents: 1000,
      status: 'past_due', paused: false, current_period_end: '2026-10-01T00:00:00Z', cancel_at_period_end: false,
      last_hosted_invoice_url: 'https://invoice.stripe.com/i/test', last_failure_message: 'Your card was declined.',
      cadence_weeks: 4, quantity: 1, next_shipment_at: '2026-10-01T00:00:00Z',
      shipping_address: { name: 'Devon', line1: '1 Main St', line2: null, city: 'Boston', state: 'MA', postal_code: '02108', country: 'US', phone: null },
    },
    {
      id: 'sub-2', product_id: 'prod-2', product_name: 'Metabolic Support', unit_price_cents: 4500, shipping_charge_cents: 0,
      status: 'active', paused: true, current_period_end: '2026-09-28T00:00:00Z', cancel_at_period_end: true,
      last_hosted_invoice_url: null, last_failure_message: null,
      cadence_weeks: 8, quantity: 2, next_shipment_at: '2026-09-28T00:00:00Z',
      shipping_address: { name: 'Devon', line1: '1 Main St', line2: null, city: 'Boston', state: 'MA', postal_code: '02108', country: 'US', phone: null },
    },
  ],
  orders: [
    {
      id: 'ord-2', order_number: 'TH-0002', kind: 'subscription_renewal', status: 'paid', fulfillment_status: 'shipped',
      total_cents: 9900, refunded_cents: 0, item_count: 1, items_label: 'Protocol Drops', created_at: '2026-09-02T14:00:00Z', paid_at: '2026-09-02T14:00:00Z', receipt_available: true,
      shipment: { status: 'shipped', carrier: 'usps', tracking_number: '9400111899223', tracking_url: null, shipped_at: '2026-09-03T00:00:00Z', delivered_at: null, canceled_at: null, updated_at: '2026-09-03T00:00:00Z' },
      subscription_id: 'sub-1', cart_id: null,
    },
    {
      id: 'ord-1', order_number: 'TH-0001', kind: 'one_time', status: 'partially_refunded', fulfillment_status: 'shipped',
      total_cents: 14900, refunded_cents: 2000, item_count: 2, items_label: 'Protocol Drops, Metabolic Support', created_at: '2026-08-05T14:00:00Z', paid_at: '2026-08-05T14:00:00Z', receipt_available: true,
      shipment: { status: 'delivered', carrier: 'ups', tracking_number: '1Z999', tracking_url: null, shipped_at: '2026-08-06T00:00:00Z', delivered_at: '2026-08-09T00:00:00Z', canceled_at: null, updated_at: '2026-08-09T00:00:00Z' },
      subscription_id: null, cart_id: null,
    },
  ],
  totals: {
    order_count: 3, lifetime_paid_cents: 24800, lifetime_refunded_cents: 2000, lifetime_net_cents: 22800,
    last_paid_at: '2026-09-02T14:00:00Z', active_subscription_count: 2,
  },
  saved_card: { state: 'on_file', brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2028 },
  last_payment_problem: {
    source: 'subscription', subscription_id: 'sub-1', order_id: null, order_number: null,
    at: '2026-09-10T09:00:00Z', message: 'Your card was declined.', hosted_invoice_url: 'https://invoice.stripe.com/i/test',
  },
};
