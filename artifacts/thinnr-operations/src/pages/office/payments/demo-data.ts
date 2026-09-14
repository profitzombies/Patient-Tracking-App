import type { HqActivityRow, HqTodayOverview, OfficeDashboard, OfficePrice, OfficeRefundRow, OrderDetail, OrderSummary, PaymentLink, SubscriptionRow } from '@/lib/billing-types';

export const DEMO_DASHBOARD: OfficeDashboard = {
  balance: { available_cents: 184250, pending_cents: 42600 },
  next_payout: { amount_cents: 184250, arrival_date: '2026-10-16' },
  collected_cents: 642850,
  thinnr_fee_cents: 241940,
  stripe_fee_cents: 18944,
  refunded_cents: 5999,
  net_cents: 381966,
  orders: 42,
  active_subscriptions: 18,
  to_ship: 6,
  series: [
    { date: '2026-10-05', collected_cents: 65400, net_cents: 39120, fee_cents: 23840, refunded_cents: 0, orders: 4 },
    { date: '2026-10-06', collected_cents: 89900, net_cents: 52600, fee_cents: 34000, refunded_cents: 0, orders: 2 },
    { date: '2026-10-07', collected_cents: 127800, net_cents: 74600, fee_cents: 48700, refunded_cents: 0, orders: 3 },
    { date: '2026-10-08', collected_cents: 110700, net_cents: 66320, fee_cents: 41200, refunded_cents: 0, orders: 4 },
    { date: '2026-10-09', collected_cents: 149950, net_cents: 88700, fee_cents: 57200, refunded_cents: 0, orders: 2 },
    { date: '2026-10-10', collected_cents: 99100, net_cents: 60500, fee_cents: 36900, refunded_cents: 0, orders: 3 },
  ],
};

export const DEMO_PRICES: OfficePrice[] = [
  {
    product_id: 'control',
    slug: 'control',
    name: 'Control',
    description: 'Daily appetite and craving support.',
    image_url: null,
    active: true,
    floor_price_cents: 5999,
    break_even_minimum_cents: 3767,
    sell_price_cents: 7999,
    subscription_enabled: true,
    offered: true,
    below_minimum: false,
  },
  {
    product_id: 'fiber',
    slug: 'fiber',
    name: 'Fiber',
    description: 'Gentle daily fiber for fullness and regularity.',
    image_url: null,
    active: true,
    floor_price_cents: 2999,
    break_even_minimum_cents: 1913,
    sell_price_cents: 4499,
    subscription_enabled: false,
    offered: true,
    below_minimum: false,
  },
];

export const DEMO_ORDERS: OrderSummary[] = [
  {
    id: 'demo-order-1',
    order_number: 'TH-D3MO01',
    provider_id: 'demo',
    office_name: 'Jenkins Wellness',
    payer: { id: 'payer-1', patient_id: 'patient-1', name: 'Maya Thompson', email: 'maya@example.com', phone: null },
    kind: 'one_time',
    status: 'partially_refunded',
    fulfillment_status: 'to_ship',
    total_cents: 8999,
    application_fee_cents: 4599,
    item_count: 1,
    items_label: 'Control',
    livemode: false,
    created_at: '2026-10-10T14:00:00Z',
    paid_at: '2026-10-10T14:02:00Z',
  },
];

export const DEMO_ORDER_DETAILS: Record<string, OrderDetail> = {
  'demo-order-1': {
    ...DEMO_ORDERS[0],
    items: [
      {
        id: 'demo-item-1',
        product_id: 'control',
        product_name: 'Control',
        quantity: 1,
        unit_price_cents: 7999,
        floor_price_cents: 5999,
        thinnr_share_cents: 3599,
        hard_cost_cents: 433,
      },
    ],
    shipping_address: {
      name: 'Maya Thompson',
      line1: '18 Beacon Street',
      line2: 'Apt 4',
      city: 'Boston',
      state: 'MA',
      postal_code: '02108',
      country: 'US',
      phone: '(617) 555-0142',
    },
    fees: {
      subtotal_cents: 7999,
      shipping_charge_cents: 1000,
      tax_cents: 0,
      total_cents: 8999,
      thinnr_share_cents: 3599,
      application_fee_cents: 4599,
      application_fee_collected_cents: 4599,
      stripe_fee_cents: 291,
      stripe_fee_estimate_cents: 291,
      office_net_cents: 4109,
      office_net_estimate_cents: 4109,
    },
    subscription_id: null,
    tracking_number: null,
    carrier: null,
    shipped_at: null,
    shipped_by_name: null,
    canceled_reason: null,
    refunds: [
      {
        id: 'demo-refund-1',
        stripe_refund_id: 're_demo',
        amount_cents: 1000,
        reason: 'Patient changed quantity',
        status: 'succeeded',
        requested_by_name: 'Dr. Sarah Jenkins',
        created_at: '2026-10-11T09:30:00Z',
      },
    ],
    disputes: [],
    ledger: [
      {
        id: 'demo-ledger-1',
        kind: 'sale',
        amount_cents: 4109,
        application_fee_cents: 4599,
        stripe_ref: 'ch_demo',
        detail: { description: 'Order payment received' },
        occurred_at: '2026-10-10T14:02:00Z',
      },
      {
        id: 'demo-ledger-2',
        kind: 'refund',
        amount_cents: -1000,
        application_fee_cents: 0,
        stripe_ref: 're_demo',
        detail: { reason: 'Patient changed quantity' },
        occurred_at: '2026-10-11T09:30:00Z',
      },
    ],
    stripe: {
      account_id: 'acct_demo',
      invoice_id: 'in_demo',
      payment_intent_id: 'pi_demo',
      charge_id: 'ch_demo',
      balance_transaction_id: 'txn_demo',
    },
  },
};

export const DEMO_LINKS: PaymentLink[] = [
  {
    id: 'demo-link-1',
    token: 'demo',
    url: 'https://example.com/pay/demo',
    provider_id: 'demo',
    patient_id: null,
    patient_name: null,
    label: 'Office checkout',
    active: true,
    uses: 12,
    last_used_at: '2026-10-10T14:00:00Z',
    created_at: '2026-09-01T12:00:00Z',
  },
];

export const DEMO_SUBSCRIPTIONS: SubscriptionRow[] = [
  {
    id: 'demo-sub-1',
    provider_id: 'demo',
    office_name: 'Jenkins Wellness',
    payer: { id: 'payer-1', patient_id: 'patient-1', name: 'Maya Thompson', email: 'maya@example.com', phone: null },
    product_id: 'control',
    product_name: 'Control',
    status: 'active',
    unit_price_cents: 7999,
    shipping_charge_cents: 1000,
    application_fee_cents: 4599,
    current_period_end: '2026-11-07T00:00:00Z',
    cancel_at_period_end: false,
    canceled_at: null,
    renewals: 3,
    livemode: false,
    created_at: '2026-08-15T00:00:00Z',
  },
];

// ---- Demo orders beyond the first: a shipped one and one still waiting ----
// Every date here is pinned to the office demo week (Oct 5–11, 2026); nothing
// is derived from the clock so the demo reads the same on any day.

const demoPayer = (id: string, name: string, email: string) => ({ id, patient_id: id.replace('payer', 'patient'), name, email, phone: null });

const DEMO_ORDER_2: OrderSummary = {
  id: 'demo-order-2',
  order_number: 'TH-D3MO02',
  provider_id: 'demo',
  office_name: 'Jenkins Wellness',
  payer: demoPayer('payer-2', 'Daniel Ortiz', 'daniel@example.com'),
  kind: 'subscription_renewal',
  status: 'paid',
  fulfillment_status: 'shipped',
  total_cents: 16998,
  application_fee_cents: 8198,
  item_count: 2,
  items_label: 'Control ×2',
  livemode: false,
  created_at: '2026-10-08T15:20:00Z',
  paid_at: '2026-10-08T15:21:00Z',
};
const DEMO_ORDER_3: OrderSummary = {
  id: 'demo-order-3',
  order_number: 'TH-D3MO03',
  provider_id: 'demo',
  office_name: 'Jenkins Wellness',
  payer: demoPayer('payer-3', 'Priya Natarajan', 'priya@example.com'),
  kind: 'one_time',
  status: 'disputed',
  fulfillment_status: 'to_ship',
  total_cents: 8999,
  application_fee_cents: 4599,
  item_count: 1,
  items_label: 'Control',
  livemode: false,
  created_at: '2026-10-06T18:40:00Z',
  paid_at: '2026-10-06T18:41:00Z',
};
DEMO_ORDERS.push(DEMO_ORDER_2, DEMO_ORDER_3);

const base = DEMO_ORDER_DETAILS['demo-order-1'];
DEMO_ORDER_DETAILS['demo-order-2'] = {
  ...base,
  ...DEMO_ORDER_2,
  items: [{ ...base.items[0], id: 'demo-item-2', quantity: 2 }],
  shipping_address: { ...base.shipping_address, name: 'Daniel Ortiz', line1: '42 Harbor Way', line2: null, city: 'Cambridge', postal_code: '02139', phone: null },
  fees: { ...base.fees, subtotal_cents: 15998, total_cents: 16998, thinnr_share_cents: 7198, application_fee_cents: 8198, application_fee_collected_cents: 8198, stripe_fee_cents: 523, stripe_fee_estimate_cents: 523, office_net_cents: 8277, office_net_estimate_cents: 8277 },
  subscription_id: 'demo-sub-1',
  tracking_number: '9400 1000 0000 0000 0012 34',
  carrier: 'USPS',
  shipped_at: '2026-10-09T13:05:00Z',
  shipped_by_name: 'THINNR Fulfillment',
  refunds: [],
  disputes: [],
  ledger: [{ id: 'demo-ledger-3', kind: 'sale', amount_cents: 8277, application_fee_cents: 8198, stripe_ref: 'ch_demo2', detail: { description: 'Subscription renewal received' }, occurred_at: '2026-10-08T15:21:00Z' }],
};
DEMO_ORDER_DETAILS['demo-order-3'] = {
  ...base,
  ...DEMO_ORDER_3,
  items: [{ ...base.items[0], id: 'demo-item-3' }],
  shipping_address: { ...base.shipping_address, name: 'Priya Natarajan', line1: '7 Commonwealth Ave', line2: null, city: 'Boston', postal_code: '02116', phone: null },
  refunds: [],
  disputes: [
    { id: 'demo-dispute-1', stripe_dispute_id: 'dp_demo', amount_cents: 8999, status: 'needs_response', reason: 'product_not_received', evidence_due_by: '2026-10-20T23:59:00Z', created_at: '2026-10-11T08:15:00Z', closed_at: null },
  ],
  ledger: [
    { id: 'demo-ledger-4', kind: 'sale', amount_cents: 4109, application_fee_cents: 4599, stripe_ref: 'ch_demo3', detail: { description: 'Order payment received' }, occurred_at: '2026-10-06T18:41:00Z' },
    { id: 'demo-ledger-5', kind: 'dispute_opened', amount_cents: -8999, application_fee_cents: 0, stripe_ref: 'dp_demo', detail: { reason: 'product_not_received' }, occurred_at: '2026-10-11T08:15:00Z' },
  ],
};

/** Every ledger line across the demo orders plus the week's payout, newest first. */
export const DEMO_ACTIVITY: HqActivityRow[] = ([
  { id: 'demo-ledger-5', kind: 'dispute_opened', label: 'Dispute opened', provider_id: 'demo', office_name: 'Jenkins Wellness', amount_cents: -8999, occurred_at: '2026-10-11T08:15:00Z', order_id: 'demo-order-3', order_number: 'TH-D3MO03' },
  { id: 'demo-ledger-2', kind: 'refund', label: 'Refund issued', provider_id: 'demo', office_name: 'Jenkins Wellness', amount_cents: -1000, occurred_at: '2026-10-11T09:30:00Z', order_id: 'demo-order-1', order_number: 'TH-D3MO01' },
  { id: 'demo-ledger-1', kind: 'sale', label: 'Payment received', provider_id: 'demo', office_name: 'Jenkins Wellness', amount_cents: 8999, occurred_at: '2026-10-10T14:02:00Z', order_id: 'demo-order-1', order_number: 'TH-D3MO01' },
  { id: 'demo-ledger-payout', kind: 'payout', label: 'Payout to office', provider_id: 'demo', office_name: 'Jenkins Wellness', amount_cents: -184250, occurred_at: '2026-10-09T06:00:00Z', order_id: null, order_number: null },
  { id: 'demo-ledger-3', kind: 'sale', label: 'Payment received', provider_id: 'demo', office_name: 'Jenkins Wellness', amount_cents: 16998, occurred_at: '2026-10-08T15:21:00Z', order_id: 'demo-order-2', order_number: 'TH-D3MO02' },
  { id: 'demo-ledger-4', kind: 'sale', label: 'Payment received', provider_id: 'demo', office_name: 'Jenkins Wellness', amount_cents: 8999, occurred_at: '2026-10-06T18:41:00Z', order_id: 'demo-order-3', order_number: 'TH-D3MO03' },
] satisfies HqActivityRow[]).sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));

export const DEMO_REFUNDS: OfficeRefundRow[] = [
  { id: 'demo-refund-1', kind: 'refund', order_id: 'demo-order-1', order_number: 'TH-D3MO01', payer_name: 'Maya Thompson', amount_cents: 1000, status: 'succeeded', reason: 'Patient changed quantity', evidence_due_by: null, closed_at: null, created_at: '2026-10-11T09:30:00Z' },
  { id: 'demo-dispute-1', kind: 'dispute', order_id: 'demo-order-3', order_number: 'TH-D3MO03', payer_name: 'Priya Natarajan', amount_cents: 8999, status: 'needs_response', reason: 'product_not_received', evidence_due_by: '2026-10-20T23:59:00Z', closed_at: null, created_at: '2026-10-11T08:15:00Z' },
];

/** The office's shipping status view is the paid detail rows grouped by fulfillment state. */
export const DEMO_FULFILLMENT: OrderDetail[] = Object.values(DEMO_ORDER_DETAILS).filter(
  (order) => order.status === 'paid' || order.status === 'partially_refunded',
);

/**
 * Fixed hourly points for the office demo day (Oct 10, 2026), shown through
 * 4 PM so the chart reads as "today so far". The profit line is the office's
 * net after THINNR and card fees. Never derived from the clock.
 */
function demoToday(): HqTodayOverview {
  const grossByHour: Record<number, number> = { 9: 8999, 10: 8999, 11: 16998, 13: 8999, 14: 8999, 16: 16998 };
  const refundByHour: Record<number, number> = { 12: 1000 };
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const collected_cents = grossByHour[hour] ?? 0;
    const refunded_cents = refundByHour[hour] ?? 0;
    const fee_cents = Math.round(collected_cents * 0.511);
    const card_fees = Math.round(collected_cents * 0.032);
    return {
      hour, collected_cents, refunded_cents, net_cents: collected_cents - refunded_cents, fee_cents,
      profit_cents: collected_cents - fee_cents - card_fees, orders: collected_cents === 0 ? 0 : Math.max(1, Math.round(collected_cents / 8999)),
    };
  });
  const sum = (key: 'collected_cents' | 'net_cents' | 'fee_cents' | 'profit_cents' | 'refunded_cents' | 'orders') => hours.reduce((total, point) => total + point[key], 0);
  return {
    date: '2026-10-10', time_zone: 'America/New_York', current_hour: 16, hours,
    collected_cents: sum('collected_cents'), net_cents: sum('net_cents'), fee_cents: sum('fee_cents'),
    profit_cents: sum('profit_cents'), refunded_cents: sum('refunded_cents'), orders: sum('orders'),
  };
}
export const DEMO_TODAY: HqTodayOverview = demoToday();
