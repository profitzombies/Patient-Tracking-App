import type {
  CatalogChange, ConnectedAccount, HqCatalogResponse, HqOverview, HqProviderDetail, HqProviderRow,
  OrderDetail, OrderKind, OrderStatus, SubscriptionRow,
} from '@/lib/billing-types';

export const DEMO_OVERVIEW: HqOverview = {
  collected_cents: 1487250, thinnr_fee_cents: 641400, shipping_charge_cents: 42000,
  hard_cost_cents: 168900, shipping_cost_cents: 42000, profit_cents: 430500,
  refunded_cents: 24998, disputed_cents: 12999, orders: 42, active_subscriptions: 18,
  providers_onboarded: 6, providers_pending: 3, to_ship: 4,
  series: [
    { date: '2026-09-01', collected_cents: 312400, net_cents: 177200, fee_cents: 135200 },
    { date: '2026-09-08', collected_cents: 365850, net_cents: 205100, fee_cents: 160750 },
    { date: '2026-09-15', collected_cents: 390000, net_cents: 218600, fee_cents: 171400 },
    { date: '2026-09-22', collected_cents: 419000, net_cents: 234900, fee_cents: 184100 },
  ],
  recent: [
    { id: 'activity-1', kind: 'order_paid', label: 'Order TH-D3MO01 paid', office_name: 'Jenkins Wellness', amount_cents: 8999, occurred_at: '2026-09-24T15:30:00Z', order_id: 'demo-order-1' },
    { id: 'activity-2', kind: 'shipped', label: 'Order TH-D3MO03 shipped', office_name: 'Beacon Hill Aesthetics', amount_cents: null, occurred_at: '2026-09-23T18:10:00Z', order_id: 'demo-order-3' },
    { id: 'activity-3', kind: 'account_onboarded', label: 'Payments activated', office_name: 'Northstar Health Studio', amount_cents: null, occurred_at: '2026-09-22T13:00:00Z', order_id: null },
  ],
};

const requirements = (due: string[] = [], disabled_reason: string | null = null) => ({
  currently_due: due, past_due: [], eventually_due: [], disabled_reason, current_deadline: due.length ? '2026-10-15T00:00:00Z' : null,
});
function account(provider_id: string, state: 'active' | 'pending' | 'restricted'): ConnectedAccount {
  return {
    provider_id, stripe_account_id: `acct_demo_${provider_id}`, origin: 'created', dashboard_type: 'none',
    charges_enabled: state === 'active', payouts_enabled: state === 'active', details_submitted: state !== 'pending',
    requirements: state === 'pending' ? requirements(['individual.verification.document']) : state === 'restricted' ? requirements([], 'requirements.past_due') : requirements(),
    capabilities: { card_payments: state === 'active' ? 'active' : 'pending', transfers: state === 'active' ? 'active' : 'pending' },
    default_currency: 'usd', business_name: null, email: null, tax_enabled: state === 'active',
    livemode: false, last_synced_at: '2026-09-24T12:00:00Z', disconnected_at: null, created_at: '2026-08-01T12:00:00Z',
  };
}

const PROVIDER_SEEDS = [
  ['jenkins', 'Jenkins Wellness', 'Dr. Jordan Jenkins', 'active', 0],
  ['beacon', 'Beacon Hill Aesthetics', 'Dr. Priya Raman', 'active', 0],
  ['northstar', 'Northstar Health Studio', 'Dr. Elena Torres', 'pending', 0],
  ['harbor', 'Harbor Integrative Care', 'Dr. Marcus Lee', 'restricted', 0],
  ['willow', 'Willow Creek Wellness', 'Dr. Ava Patel', 'none', 0],
  ['summit', 'Summit Metabolic Health', 'Dr. Noah Williams', 'active', 2],
] as const;

export const DEMO_PROVIDERS: HqProviderRow[] = PROVIDER_SEEDS.map(([provider_id, office_name, provider_name, state, below], index) => ({
  provider_id, office_name, provider_name, account: state === 'none' ? null : account(provider_id, state),
  offered_products: state === 'none' ? 0 : 3 + index, orders_30d: state === 'active' ? 8 + index * 2 : 0,
  collected_30d_cents: state === 'active' ? 168900 + index * 32400 : 0,
  fees_30d_cents: state === 'active' ? 72400 + index * 12800 : 0, below_minimum_count: below,
}));

const payerNames = ['Maya Thompson', 'Olivia Chen', 'Marcus Reed', 'Sophia Bennett', 'Ethan Walker', 'Amelia Scott'];
const productNames = ['Control', 'Regulate', 'Detox', 'Fiber', 'Creatine+', 'B-Active', 'Boost'];
function makeOrder(index: number, kind: OrderKind, status: OrderStatus, fulfillment: 'to_ship' | 'shipped' | 'canceled'): OrderDetail {
  const provider = DEMO_PROVIDERS[index % DEMO_PROVIDERS.length];
  const unit = [7999, 8499, 8999, 4499, 10999, 10499, 13999][index % 7];
  const floor = [5999, 5999, 5999, 2999, 8999, 8999, 11999][index % 7];
  const share = Math.floor(floor * .6);
  const total = unit + 1000;
  const stripe = Math.round(total * .029) + 30;
  const fee = share + 1000;
  const hard = [433, 816, 679, 427, 1383, 500, 990][index % 7];
  const refunded = status === 'refunded' ? total : status === 'partially_refunded' ? 3000 : 0;
  return {
    id: `demo-order-${index + 1}`, order_number: `TH-D3MO${String(index + 1).padStart(2, '0')}`,
    provider_id: provider.provider_id, office_name: provider.office_name,
    payer: { id: `payer-${index + 1}`, patient_id: `patient-${index + 1}`, name: payerNames[index % payerNames.length], email: `${payerNames[index % payerNames.length].toLowerCase().replace(' ', '.')}@example.com`, phone: '(555) 010-2026' },
    kind, status, fulfillment_status: fulfillment, total_cents: total, application_fee_cents: fee,
    item_count: 1, items_label: productNames[index % 7], livemode: false,
    created_at: `2026-09-${String(10 + index).padStart(2, '0')}T14:00:00Z`,
    paid_at: status === 'pending' || status === 'failed' ? null : `2026-09-${String(10 + index).padStart(2, '0')}T14:02:00Z`,
    items: [{ id: `item-${index + 1}`, product_id: `product-${index % 7}`, product_name: productNames[index % 7], quantity: 1, unit_price_cents: unit, floor_price_cents: floor, thinnr_share_cents: share, hard_cost_cents: hard }],
    shipping_address: { name: payerNames[index % payerNames.length], line1: `${120 + index} Market Street`, line2: index % 3 === 0 ? 'Suite 200' : null, city: index % 2 ? 'Boston' : 'Austin', state: index % 2 ? 'MA' : 'TX', postal_code: index % 2 ? '02108' : '78701', country: 'US', phone: '(555) 010-2026' },
    fees: { subtotal_cents: unit, shipping_charge_cents: 1000, tax_cents: 0, total_cents: total, thinnr_share_cents: share, application_fee_cents: fee, application_fee_collected_cents: status === 'pending' ? null : fee, stripe_fee_cents: status === 'pending' ? null : stripe, stripe_fee_estimate_cents: stripe, office_net_cents: status === 'pending' ? null : total - fee - stripe, office_net_estimate_cents: total - fee - stripe },
    profit: { hard_cost_cents: hard, shipping_cost_cents: 1000, hq_profit_cents: fee - hard - 1000 },
    subscription_id: kind === 'one_time' ? null : `demo-sub-${index % 6 + 1}`,
    tracking_number: fulfillment === 'shipped' ? `9400111899223857${String(index).padStart(4, '0')}` : null,
    carrier: fulfillment === 'shipped' ? 'USPS' : null, shipped_at: fulfillment === 'shipped' ? '2026-09-24T17:00:00Z' : null,
    shipped_by_name: fulfillment === 'shipped' ? 'Alex Morgan' : null,
    canceled_reason: fulfillment === 'canceled' ? 'Patient requested cancellation before shipment.' : null,
    refunds: refunded ? [{ id: `refund-${index}`, stripe_refund_id: `re_demo_${index}`, amount_cents: refunded, reason: 'Patient request', status: 'succeeded', requested_by_name: 'Alex Morgan', created_at: '2026-09-24T16:00:00Z' }] : [],
    disputes: status === 'disputed' ? [{ id: `dispute-${index}`, stripe_dispute_id: `dp_demo_${index}`, amount_cents: total, status: 'needs_response', reason: 'fraudulent', evidence_due_by: '2026-10-05T00:00:00Z', created_at: '2026-09-24T16:00:00Z', closed_at: null }] : [],
    ledger: [
      { id: `ledger-sale-${index}`, kind: 'sale', amount_cents: total - fee - stripe, application_fee_cents: fee, stripe_ref: `ch_demo_${index}`, detail: {}, occurred_at: '2026-09-24T14:02:00Z' },
      ...(refunded ? [{ id: `ledger-refund-${index}`, kind: 'refund' as const, amount_cents: -refunded, application_fee_cents: 0, stripe_ref: `re_demo_${index}`, detail: {}, occurred_at: '2026-09-24T16:00:00Z' }] : []),
    ],
    stripe: { account_id: provider.account?.stripe_account_id ?? `acct_demo_${provider.provider_id}`, invoice_id: `in_demo_${index}`, payment_intent_id: `pi_demo_${index}`, charge_id: `ch_demo_${index}`, balance_transaction_id: `txn_demo_${index}` },
  };
}

const ORDER_STATES: Array<[OrderKind, OrderStatus, 'to_ship' | 'shipped' | 'canceled']> = [
  ['one_time', 'paid', 'to_ship'], ['subscription_initial', 'paid', 'to_ship'], ['subscription_renewal', 'paid', 'shipped'],
  ['one_time', 'refunded', 'canceled'], ['one_time', 'partially_refunded', 'to_ship'], ['subscription_renewal', 'disputed', 'shipped'],
  ['one_time', 'pending', 'to_ship'], ['one_time', 'paid', 'shipped'], ['subscription_initial', 'paid', 'shipped'],
  ['subscription_renewal', 'paid', 'to_ship'], ['one_time', 'failed', 'canceled'], ['one_time', 'paid', 'shipped'],
];
export const DEMO_ORDER_DETAILS = ORDER_STATES.map((row, index) => makeOrder(index, ...row));
export const DEMO_ORDERS = DEMO_ORDER_DETAILS;
export const DEMO_FULFILLMENT = DEMO_ORDER_DETAILS.filter(order => order.status === 'paid' || order.status === 'partially_refunded');

export const DEMO_SUBSCRIPTIONS: SubscriptionRow[] = Array.from({ length: 7 }, (_, index) => ({
  id: `demo-sub-${index + 1}`, provider_id: DEMO_PROVIDERS[index % 6].provider_id, office_name: DEMO_PROVIDERS[index % 6].office_name,
  payer: DEMO_ORDER_DETAILS[index].payer, product_id: `product-${index}`, product_name: productNames[index],
  status: index === 4 ? 'past_due' : index === 6 ? 'canceled' : 'active',
  unit_price_cents: [7999, 8499, 8999, 4499, 10999, 10499, 13999][index], shipping_charge_cents: 1000,
  application_fee_cents: Math.floor([5999, 5999, 5999, 2999, 8999, 8999, 11999][index] * .6) + 1000,
  current_period_end: `2026-10-${String(12 + index).padStart(2, '0')}T00:00:00Z`, cancel_at_period_end: index === 5,
  canceled_at: index === 6 ? '2026-09-20T00:00:00Z' : null, renewals: index + 1, livemode: false, created_at: `2026-07-${String(10 + index).padStart(2, '0')}T00:00:00Z`,
}));

const productSeeds = [
  ['control', 'Control', 5999, 433, 3767], ['regulate', 'Regulate', 5999, 816, 3767],
  ['detox', 'Detox', 5999, 679, 3767], ['fiber', 'Fiber', 2999, 427, 1913],
  ['creatine-plus', 'Creatine+', 8999, 1383, 5621], ['b-active', 'B-Active', 8999, 500, 5621],
  ['boost', 'Boost', 11999, 990, 7475], ['maintenance-stack', 'Maintenance Stack', 9999, 1249, 6239],
  ['maintenance-stack-2', 'Maintenance Stack – 2 Products', 9999, 1249, 6239],
  ['maintenance-detox-stack', 'Maintenance + Detox Stack', 14999, 1928, 9329],
] as const;
export const DEMO_CATALOG: HqCatalogResponse = {
  products: productSeeds.map(([slug, name, floor, hard, minimum], index) => ({
    id: `catalog-${index + 1}`, slug, name, floor_price_cents: floor, hard_cost_cents: hard,
    active: index !== 8, retired_at: index === 8 ? '2026-09-18T12:00:00Z' : null, sort_order: index,
    thinnr_share_cents: Math.floor(floor * .6), break_even_minimum_cents: minimum,
    hq_profit_per_unit_cents: Math.floor(floor * .6) - hard, offices_offering: 3 + index % 4,
    offices_below_minimum: index === 6 ? 2 : 0,
  })),
  settings: { shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, version: 4, updated_at: '2026-09-21T14:00:00Z' },
  offices_below_minimum: 2,
};

export const DEMO_CATALOG_CHANGES: CatalogChange[] = [
  { id: 'change-1', product_id: 'catalog-7', product_name: 'Boost', kind: 'product_updated', before: { floor_price_cents: 10999 }, after: { floor_price_cents: 11999 }, actor_user_id: 'hq-1', actor_name: 'Alex Morgan', created_at: '2026-09-21T14:00:00Z' },
  { id: 'change-2', product_id: null, product_name: null, kind: 'settings_updated', before: { shipping_cost_cents: 900 }, after: { shipping_cost_cents: 1000 }, actor_user_id: 'hq-1', actor_name: 'Alex Morgan', created_at: '2026-09-19T16:30:00Z' },
  { id: 'change-3', product_id: 'catalog-9', product_name: 'Maintenance Stack – 2 Products', kind: 'product_retired', before: { active: true }, after: { active: false }, actor_user_id: 'hq-2', actor_name: 'Morgan Lee', created_at: '2026-09-18T12:00:00Z' },
];

export const DEMO_PROVIDER_DETAILS: Record<string, HqProviderDetail> = Object.fromEntries(DEMO_PROVIDERS.map((provider, index) => [
  provider.provider_id,
  {
    office: { provider_id: provider.provider_id, office_name: provider.office_name, provider_name: provider.provider_name, email: `office${index + 1}@example.com`, phone: '(555) 010-1000' },
    account: provider.account,
    events: provider.account ? [
      { id: `event-${index}-1`, provider_id: provider.provider_id, kind: 'account_created', detail: {}, created_at: '2026-08-01T12:00:00Z' },
      { id: `event-${index}-2`, provider_id: provider.provider_id, kind: provider.account.charges_enabled ? 'charges_enabled' : 'requirements_updated', detail: {}, created_at: '2026-08-02T15:00:00Z' },
    ] : [],
    prices: DEMO_CATALOG.products.slice(0, 5).map((product, productIndex) => ({
      product_id: product.id, slug: product.slug, name: product.name, active: product.active,
      floor_price_cents: product.floor_price_cents, break_even_minimum_cents: product.break_even_minimum_cents,
      sell_price_cents: index === 5 && productIndex < 2 ? product.break_even_minimum_cents - 100 : product.floor_price_cents + 2000,
      subscription_enabled: productIndex < 2, offered: true, below_minimum: index === 5 && productIndex < 2,
    })),
    subscriptions: { active: index + 1, past_due: index === 3 ? 1 : 0, canceled: index % 2 },
    recent_orders: DEMO_ORDERS.filter(order => order.provider_id === provider.provider_id).slice(0, 4),
    payouts: provider.account?.payouts_enabled ? [{ id: `payout-${index}`, stripe_payout_id: `po_demo_${index}`, amount_cents: 84250 + index * 10000, status: 'paid', arrival_date: '2026-09-25', method: 'standard', created_at: '2026-09-23T12:00:00Z' }] : [],
    links: index + 1,
  },
]));