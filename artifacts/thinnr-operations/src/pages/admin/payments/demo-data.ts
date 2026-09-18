import { EMPTY_COACH_SUGGESTION } from '@/lib/billing-types';
import type {
  WarehouseSubmission,
  AiCostModel, AiCostSummary, AiCostSurface, CatalogChange, CoachSuggestionRule, ConnectedAccount, HqCatalogResponse, HqOverview, HqProviderDetail, HqProviderRow,
  HqActivityRow, HqTodayOverview, OrderDetail, OrderKind, OrderStatus, ProductPageContent, SeriesPoint, SubscriptionRow,
} from '@/lib/billing-types';
import { DEMO_PRODUCT_PAGES } from './demo-product-pages';

/**
 * Thirty fixed daily points ending on the demo anchor (Sept 24, 2026). Sums
 * reproduce the headline tiles; never derived from the viewer clock.
 */
function demoSeries(): SeriesPoint[] {
  const grossPattern = [31200, 44850, 52400, 0, 61000, 38950, 47800, 55600, 0, 42300, 68900, 39100, 51750, 0, 58400, 46200, 71900, 33800, 0, 62450, 49900, 54300, 60100, 0, 57800, 43600, 66200, 48900, 0, 71700];
  const refundPattern: Record<number, number> = { 9: 12999, 21: 11999 };
  return grossPattern.map((collected_cents, index) => {
    const day = new Date(Date.UTC(2026, 7, 26 + index));
    const orders = collected_cents === 0 ? 0 : 1 + (index % 3);
    const fee_cents = Math.round(collected_cents * 0.431);
    return {
      date: day.toISOString().slice(0, 10),
      collected_cents,
      fee_cents,
      net_cents: collected_cents - fee_cents,
      refunded_cents: refundPattern[index] ?? 0,
      orders,
    };
  });
}

export const DEMO_OVERVIEW: HqOverview = {
  collected_cents: 1487250, thinnr_fee_cents: 641400, shipping_charge_cents: 42000,
  hard_cost_cents: 168900, shipping_cost_cents: 42000, profit_cents: 430500,
  refunded_cents: 24998, disputed_cents: 12999, orders: 42, active_subscriptions: 18, needs_attention_subscriptions: 1,
  providers_onboarded: 6, providers_pending: 3, to_ship: 4,
  series: demoSeries(),
  recent: [
    { id: 'activity-1', kind: 'sale', label: 'Payment received', provider_id: 'demo-provider-1', office_name: 'Jenkins Wellness', amount_cents: 8999, occurred_at: '2026-09-24T15:30:00Z', order_id: 'demo-order-1', order_number: 'TH-D3MO01' },
    { id: 'activity-2', kind: 'refund', label: 'Refund issued', provider_id: 'demo-provider-2', office_name: 'Beacon Hill Aesthetics', amount_cents: -12999, occurred_at: '2026-09-23T18:10:00Z', order_id: 'demo-order-3', order_number: 'TH-D3MO03' },
    { id: 'activity-3', kind: 'payout', label: 'Payout to office', provider_id: 'demo-provider-3', office_name: 'Northstar Health Studio', amount_cents: -84250, occurred_at: '2026-09-22T13:00:00Z', order_id: null, order_number: null },
    { id: 'activity-4', kind: 'sale', label: 'Payment received', provider_id: 'demo-provider-2', office_name: 'Beacon Hill Aesthetics', amount_cents: 15999, occurred_at: '2026-09-21T16:45:00Z', order_id: 'demo-order-2', order_number: 'TH-D3MO02' },
  ],
};

export const DEMO_ACTIVITY: HqActivityRow[] = DEMO_OVERVIEW.recent;

const AI_RATES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.6-terra': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5.6-luna': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
};

function aiCost(model: string, prompt: number, cached: number, completion: number): number {
  const rate = AI_RATES[model];
  return ((prompt - cached) * rate.input + cached * rate.cached + completion * rate.output) / 1_000_000;
}

function demoAiCosts(): AiCostSummary {
  const surfaceSeeds = [
    ['coach.chat', 'gpt-5.6-terra', 1840, 12, 2760000, 1680000, 428000, 96000, 1480, 3100],
    ['coach.meal_photo', 'gpt-5.6-luna', 430, 8, 688000, 0, 172000, 28000, 2280, 5100],
    ['coach.menu_scan', 'gpt-5-nano', 215, 3, 344000, 31000, 91000, 12000, 1890, 4200],
    ['coach.label_scan', 'gpt-5-nano', 168, 2, 252000, 18000, 68000, 9000, 1710, 3900],
    ['support.chat', 'gpt-5.6-terra', 276, 4, 386000, 236000, 72000, 14000, 1320, 2800],
    ['coach.title', 'gpt-5-nano', 1260, 1, 184000, 112000, 32000, 0, 240, 520],
  ] as const;
  const by_surface: AiCostSurface[] = surfaceSeeds.map(
    ([surface, model, calls, error_calls, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, avg_latency_ms, p95_latency_ms]) => ({
      surface,
      model,
      calls,
      error_calls,
      prompt_tokens,
      cached_tokens,
      completion_tokens,
      reasoning_tokens,
      cached_share: cached_tokens / prompt_tokens,
      cost_usd: aiCost(model, prompt_tokens, cached_tokens, completion_tokens),
      avg_latency_ms,
      p95_latency_ms,
    }),
  );
  const sumSurface = (key: 'calls' | 'error_calls' | 'prompt_tokens' | 'cached_tokens' | 'completion_tokens' | 'reasoning_tokens' | 'cost_usd') =>
    by_surface.reduce((total, row) => total + row[key], 0);
  const modelNames = Object.keys(AI_RATES);
  const by_model: AiCostModel[] = modelNames.map((model) => {
    const rows = by_surface.filter((row) => row.model === model);
    const sum = (key: 'calls' | 'prompt_tokens' | 'cached_tokens' | 'completion_tokens' | 'cost_usd') =>
      rows.reduce((total, row) => total + row[key], 0);
    const prompt_tokens = sum('prompt_tokens');
    const cached_tokens = sum('cached_tokens');
    return {
      model,
      calls: sum('calls'),
      prompt_tokens,
      cached_tokens,
      completion_tokens: sum('completion_tokens'),
      cached_share: cached_tokens / prompt_tokens,
      cost_usd: sum('cost_usd'),
      unpriced: false,
      rate: AI_RATES[model],
    };
  });
  const calls = sumSurface('calls');
  const prompt_tokens = sumSurface('prompt_tokens');
  const cached_tokens = sumSurface('cached_tokens');
  const completion_tokens = sumSurface('completion_tokens');
  const cost_usd = sumSurface('cost_usd');
  const officeSeeds = [
    ['jenkins', 'Jenkins Wellness', 'Dr. Jordan Jenkins', 0.42, 86, 114],
    ['beacon', 'Beacon Hill Aesthetics', 'Dr. Priya Raman', 0.31, 64, 91],
    ['northstar', 'Northstar Health Studio', 'Dr. Elena Torres', 0.17, 39, 58],
    ['harbor', 'Harbor Integrative Care', 'Dr. Marcus Lee', 0.1, 23, 41],
  ] as const;
  const allocate = (total: number) => {
    const values = officeSeeds.map((row) => Math.round(total * row[3]));
    values[values.length - 1] = total - values.slice(0, -1).reduce((sum, value) => sum + value, 0);
    return values;
  };
  const officeCalls = allocate(calls);
  const officePrompts = allocate(prompt_tokens);
  const officeCached = allocate(cached_tokens);
  const officeCompletions = allocate(completion_tokens);
  const by_office = officeSeeds.map(([provider_id, office_name, provider_name, share, ai_patients, active_patients], index) => {
    const officeCost = cost_usd * share;
    return {
      provider_id,
      office_name,
      provider_name,
      calls: officeCalls[index],
      prompt_tokens: officePrompts[index],
      cached_tokens: officeCached[index],
      completion_tokens: officeCompletions[index],
      cached_share: officeCached[index] / officePrompts[index],
      cost_usd: officeCost,
      ai_patients,
      active_patients,
      cost_per_active_patient_usd: officeCost / active_patients,
    };
  });
  const dayWeights = [0.055, 0.064, 0.071, 0.048, 0.076, 0.081, 0.069, 0.073, 0.079, 0.062, 0.084, 0.074, 0.082, 0.082];
  const allocateDays = (total: number) => {
    const values = dayWeights.map((weight) => Math.round(total * weight));
    values[values.length - 1] = total - values.slice(0, -1).reduce((sum, value) => sum + value, 0);
    return values;
  };
  const dailyCalls = allocateDays(calls);
  const dailyPrompts = allocateDays(prompt_tokens);
  const dailyCached = allocateDays(cached_tokens);
  const dailyCompletions = allocateDays(completion_tokens);
  const dailyCosts = dayWeights.map((weight) => cost_usd * weight);
  dailyCosts[dailyCosts.length - 1] = cost_usd - dailyCosts.slice(0, -1).reduce((sum, value) => sum + value, 0);
  const by_day = dayWeights.map((_, index) => {
    const day = new Date(Date.UTC(2026, 8, 11 + index)).toISOString().slice(0, 10);
    return {
      day,
      calls: dailyCalls[index],
      prompt_tokens: dailyPrompts[index],
      cached_tokens: dailyCached[index],
      completion_tokens: dailyCompletions[index],
      cached_share: dailyCached[index] / dailyPrompts[index],
      cost_usd: dailyCosts[index],
      ai_patients: 38 + index % 9,
    };
  });
  const error_calls = sumSurface('error_calls');
  const active_patients = officeSeeds.reduce((total, row) => total + row[5], 0);
  const ai_patients = officeSeeds.reduce((total, row) => total + row[4], 0);
  return {
    from: '2026-09-11',
    to: '2026-09-24',
    pricing_version: '2026-09-01',
    totals: {
      calls,
      ok_calls: calls - error_calls,
      error_calls,
      aborted_calls: 0,
      prompt_tokens,
      cached_tokens,
      completion_tokens,
      reasoning_tokens: sumSurface('reasoning_tokens'),
      cached_share: cached_tokens / prompt_tokens,
      cost_usd,
      unpriced_calls: 0,
      active_patients,
      ai_patients,
      cost_per_active_patient_usd: cost_usd / active_patients,
      cost_per_ai_patient_usd: cost_usd / ai_patients,
    },
    unattributed: { calls: 0, cost_usd: 0 },
    by_day,
    by_office,
    by_surface,
    by_model,
    models: by_surface.map((row) => ({ surface: row.surface, model: row.model!, overridden: false })),
  };
}

export const DEMO_AI_COSTS: AiCostSummary = demoAiCosts();

/**
 * Fixed hourly points for the demo anchor day (Sept 24, 2026), shown through
 * 4 PM so the chart reads as "today so far". Never derived from the clock.
 */
function demoToday(): HqTodayOverview {
  const grossByHour: Record<number, number> = { 8: 8999, 9: 15999, 10: 12999, 11: 31998, 12: 8999, 13: 0, 14: 24998, 15: 15999, 16: 8999 };
  const refundByHour: Record<number, number> = { 13: 12999 };
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const collected_cents = grossByHour[hour] ?? 0;
    const refunded_cents = refundByHour[hour] ?? 0;
    const fee_cents = Math.round(collected_cents * 0.431);
    return {
      hour, collected_cents, refunded_cents, net_cents: collected_cents - refunded_cents, fee_cents,
      profit_cents: Math.round(fee_cents * 0.62), orders: collected_cents === 0 ? 0 : Math.max(1, Math.round(collected_cents / 12999)),
    };
  });
  const sum = (key: 'collected_cents' | 'net_cents' | 'fee_cents' | 'profit_cents' | 'refunded_cents' | 'orders') => hours.reduce((total, point) => total + point[key], 0);
  return {
    date: '2026-09-24', time_zone: 'America/New_York', current_hour: 16, hours,
    collected_cents: sum('collected_cents'), net_cents: sum('net_cents'), fee_cents: sum('fee_cents'),
    profit_cents: sum('profit_cents'), refunded_cents: sum('refunded_cents'), orders: sum('orders'),
  };
}
export const DEMO_TODAY: HqTodayOverview = demoToday();

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
    stripe_customer_emails: 'off', stripe_customer_emails_checked_at: '2026-08-01T12:00:00Z',
    stripe_customer_emails_note: 'No Stripe Dashboard: Stripe customer emails cannot be enabled on this account.',
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
    fees: {
      subtotal_cents: unit, shipping_charge_cents: 1000,
      shipping: { shipping_method: 'standard', shipping_source: 'fallback', carrier_service_name: null, carrier_cost_cents: 1000, pick_pack_fee_cents: 0, packaging_cents: 0, pick_pack_passed_through: false, delivery_window_start: null, delivery_window_end: null },
      tax_cents: 0, total_cents: total, thinnr_share_cents: share, application_fee_cents: fee, application_fee_collected_cents: status === 'pending' ? null : fee, stripe_fee_cents: status === 'pending' ? null : stripe, stripe_fee_estimate_cents: stripe, office_net_cents: status === 'pending' ? null : total - fee - stripe, office_net_estimate_cents: total - fee - stripe,
    },
    profit: { hard_cost_cents: hard, shipping_cost_cents: 1000, fulfillment_fee_cents: 0, hq_profit_cents: fee - hard - 1000 },
    subscription_id: kind === 'one_time' ? null : `demo-sub-${index % 6 + 1}`,
    tracking_number: fulfillment === 'shipped' ? `9400111899223857${String(index).padStart(4, '0')}` : null,
    carrier: fulfillment === 'shipped' ? 'USPS' : null, shipped_at: fulfillment === 'shipped' ? '2026-09-24T17:00:00Z' : null,
    shipped_by_name: fulfillment === 'shipped' ? 'Alex Morgan' : null,
    canceled_reason: fulfillment === 'canceled' ? 'Patient requested cancellation before shipment.' : null,
    warehouse: demoWarehouse(index, status, fulfillment),
    refunds: refunded ? [{ id: `refund-${index}`, stripe_refund_id: `re_demo_${index}`, amount_cents: refunded, reason: 'Patient request', status: 'succeeded', requested_by_name: 'Alex Morgan', created_at: '2026-09-24T16:00:00Z' }] : [],
    disputes: status === 'disputed' ? [{ id: `dispute-${index}`, stripe_dispute_id: `dp_demo_${index}`, amount_cents: total, status: 'needs_response', reason: 'fraudulent', evidence_due_by: '2026-10-05T00:00:00Z', created_at: '2026-09-24T16:00:00Z', closed_at: null }] : [],
    ledger: [
      { id: `ledger-sale-${index}`, kind: 'sale', amount_cents: total - fee - stripe, application_fee_cents: fee, stripe_ref: `ch_demo_${index}`, detail: {}, occurred_at: '2026-09-24T14:02:00Z' },
      ...(refunded ? [{ id: `ledger-refund-${index}`, kind: 'refund' as const, amount_cents: -refunded, application_fee_cents: 0, stripe_ref: `re_demo_${index}`, detail: {}, occurred_at: '2026-09-24T16:00:00Z' }] : []),
    ],
    stripe: { account_id: provider.account?.stripe_account_id ?? `acct_demo_${provider.provider_id}`, invoice_id: `in_demo_${index}`, payment_intent_id: `pi_demo_${index}`, charge_id: `ch_demo_${index}`, balance_transaction_id: `txn_demo_${index}` },
  };
}

/** WarehouseCraft state per demo order: one rejection and one in-flight intent so every queue state is on screen. */
function demoWarehouse(index: number, status: OrderStatus, fulfillment: 'to_ship' | 'shipped' | 'canceled'): WarehouseSubmission | null {
  if (status === 'pending' || status === 'failed') return null;
  const paidAt = `2026-09-${String(10 + index).padStart(2, '0')}T14:02:00Z`;
  const base = { warehouse_order_id: null, warehouse_status: null, sent_at: null, error: null, attempts: 1, next_attempt_at: null, last_attempt_at: `2026-09-${String(10 + index).padStart(2, '0')}T14:04:00Z` };
  if (fulfillment === 'canceled') return { ...base, state: 'skipped', attempts: 0, last_attempt_at: null };
  if (index === 1) return { ...base, state: 'needs_attention', attempts: 1, error: 'ItemSKU not recognized: REGULATE-OLD' };
  if (index === 4) return { ...base, state: 'pending', attempts: 0, last_attempt_at: null, next_attempt_at: '2026-09-24T14:06:00Z' };
  return { ...base, state: 'sent', warehouse_order_id: String(1436100 + index), warehouse_status: fulfillment === 'shipped' ? 'Shipped' : 'Imported', sent_at: paidAt.replace('14:02', '14:04') };
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
  paused_at: index === 0 ? '2026-09-24T14:00:00Z' : null,
  pending_change: index === 1
    ? { product_id: 'catalog-3', product_name: 'Detox', unit_price_cents: 8999, effective_at: '2026-10-13T00:00:00Z' }
    : null,
  payment_failure_count: index === 4 ? 2 : 0,
  last_payment_failed_at: index === 4 ? '2026-09-24T13:30:00Z' : null,
  last_failure_message: index === 4 ? 'Your card was declined.' : null,
  shipping: { shipping_method: 'standard', shipping_source: 'fallback', carrier_service_name: null, carrier_cost_cents: 1000, pick_pack_fee_cents: 0, packaging_cents: 0, pick_pack_passed_through: false, delivery_window_start: null, delivery_window_end: null },
  shipping_requoted_at: null,
}));

const productSeeds = [
  ['control', 'Control', 5999, 433, 3767], ['regulate', 'Regulate', 5999, 816, 3767],
  ['detox', 'Detox', 5999, 679, 3767], ['fiber', 'Fiber', 2999, 427, 1913],
  ['creatine-plus', 'Creatine+', 8999, 1383, 5621], ['b-active', 'B-Active', 8999, 500, 5621],
  ['boost', 'Boost', 11999, 990, 7475], ['maintenance-stack', 'Maintenance Stack', 9999, 1249, 6239],
  ['maintenance-stack-2', 'Maintenance Stack – 2 Products', 9999, 1249, 6239],
  ['maintenance-detox-stack', 'Maintenance + Detox Stack', 14999, 1928, 9329],
] as const;
const productBlurbs: Record<string, string> = {
  control: 'Daily appetite and craving support.', regulate: 'Blood sugar balance between meals.',
  detox: 'A gentle reset for digestion and bloat.', fiber: 'Gentle daily fiber for fullness and regularity.',
  'creatine-plus': 'Strength and lean muscle support during weight loss.', 'b-active': 'B-vitamin energy without the crash.',
  boost: 'Metabolic support for stalled progress.', 'maintenance-stack': 'The core maintenance routine after goal weight.',
  'maintenance-stack-2': 'A two-product maintenance routine.', 'maintenance-detox-stack': 'Maintenance plus a periodic detox reset.',
};
/** Mirrors the seeded billing_products.coach_suggestion defaults (see the coach_product_suggestions migration). */
const DEMO_COACH_SUGGESTIONS: Record<string, CoachSuggestionRule> = {
  boost: { signals: ['glp1_medication'], avoid_signals: [], phrasing: 'Only alongside a GLP-1 their provider prescribed; frame it as support for the plan they are already on, never a replacement.', bloodwork_covered: false, topics: ['thinnr boost', 'glp-1', 'ozempic', 'wegovy', 'semaglutide', 'tirzepatide', 'mounjaro', 'zepbound', 'prescription weight loss', 'weight loss injection', 'weight loss injections', 'weight loss shot'] },
  control: { signals: ['off_plan_meals', 'stall'], avoid_signals: [], phrasing: 'Tie it to hunger, cravings, or snacking they actually described; a stall alone is not a reason unless appetite is part of it.', bloodwork_covered: false, topics: ['appetite', 'hungry all the time', 'always hungry', 'snacking urges', 'urge to snack', 'portion control', 'thinnr control'] },
  detox: { signals: ['bloodwork_liver_high'], avoid_signals: [], phrasing: 'Keep it about digestion and feeling less sluggish; never promise anything about lab values.', bloodwork_covered: false, topics: ['detox', 'liver', 'bloated', 'bloating', 'water retention', 'puffy', 'sluggish digestion', 'thinnr detox'] },
  regulate: { signals: ['bloodwork_glucose_high'], avoid_signals: ['diabetes_medication'], phrasing: 'Position it as blood sugar support worth raising with their provider, not a treatment for a lab result.', bloodwork_covered: false, topics: ['blood sugar', 'glucose', 'sugar spikes', 'sugar crash', 'insulin resistance', 'a1c', 'berberine', 'thinnr regulate'] },
  'b-active': { signals: ['bloodwork_b12_low'], avoid_signals: [], phrasing: 'Connect it to energy and focus they mentioned; the lab flag is something for their provider to weigh in on.', bloodwork_covered: false, topics: ['fatigue', 'low energy', 'no energy', 'exhausted', 'energy levels', 'brain fog', 'b vitamins', 'vitamin b', 'b12', 'b-active', 'feeling tired', 'so tired', 'tired all the time', 'tired lately', 'sluggish'] },
  'creatine-plus': { signals: ['low_protein'], avoid_signals: ['bloodwork_kidney_flag'], phrasing: 'Frame it as protecting lean mass while they lose, especially when protein is running low or they train.', bloodwork_covered: false, topics: ['muscle', 'muscles', 'lifting', 'lift weights', 'weight training', 'strength training', 'gym', 'workout', 'workouts', 'working out', 'work out', 'creatine', 'lean mass', 'toned', 'tone up', 'strength', 'post workout recovery', 'hmb'] },
  fiber: { signals: [], avoid_signals: [], phrasing: '', bloodwork_covered: false, topics: ['constipation', 'constipated', 'irregular', 'regularity', 'fiber', 'psyllium', 'thinnr fiber'] },
  'maintenance-stack': { signals: ['program_complete', 'weight_regain'], avoid_signals: [], phrasing: 'For patients past the protocol who want to hold their results; lead with keeping the weight off, not starting over.', bloodwork_covered: false, topics: ['maintenance stack', 'keep the weight off', 'keeping the weight off', 'keep my weight off', 'keep it off', 'maintain my weight', 'maintain my results', 'after the program ends', 'finished the program', 'program is over', 'regain', 'gaining it back', 'gained some back', 'stay at this weight'] },
};
const EMPTY_PAGE: ProductPageContent = {
  category: 'supplement', tagline: '', format: '', benefits: [], how_to_take: '', facts_title: '', facts: [], faqs: [], disclaimer: '',
};
function demoPage(slug: string): ProductPageContent {
  const page = DEMO_PRODUCT_PAGES[slug];
  if (!page) return EMPTY_PAGE;
  const { description: _description, ...content } = page;
  return content;
}
export const DEMO_CATALOG: HqCatalogResponse = {
  products: productSeeds.map(([slug, name, floor, hard, minimum], index) => ({
    id: `catalog-${index + 1}`, slug, name, description: productBlurbs[slug] ?? '', floor_price_cents: floor, hard_cost_cents: hard,
    ...demoPage(slug), offered_cadences_weeks: index === 6 ? [4, 8, 12] : [2, 4, 6, 8, 10, 12], default_cadence_weeks: 4,
    coach_suggestion: DEMO_COACH_SUGGESTIONS[slug] ?? EMPTY_COACH_SUGGESTION,
    warehousecraft_sku: null, shipping_weight_oz: null, package_length_in: null, package_width_in: null, package_height_in: null, oversized: false,
    active: index !== 8, status: index === 8 ? 'retired' : 'active', retired_at: index === 8 ? '2026-09-18T12:00:00Z' : null,
    archived_at: null, image_url: null, image_count: 0, updated_at: '2026-09-21T14:00:00Z', sort_order: index + 1,
    thinnr_share_cents: Math.floor(floor * .6), break_even_minimum_cents: minimum,
    hq_profit_per_unit_cents: Math.floor(floor * .6) - hard, offices_offering: 3 + index % 4,
    offices_below_minimum: index === 6 ? 2 : 0,
  })),
  settings: {
    shipping_charge_cents: 1000, shipping_cost_cents: 1000, free_shipping_over_cents: null,
    pick_pack_tier: 'under_50',
    pick_pack_schedule: {
      order_fee_cents: { under_50: 495, from_51: 425, from_100: 395, from_250: 345, from_500: 295, from_1500: 175 },
      unit_cents: 25, oversized_unit_cents: 75, overweight_pick_cents: 200, overweight_threshold_lb: 30, packaging_cents: 0,
    },
    pick_pack_pass_through_default: false, expedited_enabled: false, weekly_paid_orders: 0,
    card_fee_bps: 290, card_fee_fixed_cents: 30, subscribe_save_enabled: true, subscribe_save_percent: 10, version: 4, updated_at: '2026-09-21T14:00:00Z',
  },
  offices_below_minimum: 2,
};

export const DEMO_CATALOG_CHANGES: CatalogChange[] = [
  { id: 'change-1', product_id: 'catalog-7', product_name: 'Boost', kind: 'product_updated', before: { floor_price_cents: 10999 }, after: { floor_price_cents: 11999 }, actor_user_id: 'hq-1', actor_name: 'Alex Morgan', actor_member_id: 'hq-1', provider_id: null, office_name: null, created_at: '2026-09-21T14:03:27Z' },
  { id: 'change-2', product_id: 'catalog-1', product_name: 'Control', kind: 'office_price_updated', before: { sell_price_cents: 7999, subscription_enabled: true }, after: { sell_price_cents: 8499, subscription_enabled: true }, actor_user_id: 'hq-1', actor_name: 'Alex Morgan', actor_member_id: 'hq-1', provider_id: 'demo-1', office_name: 'Jenkins Wellness', created_at: '2026-09-20T09:41:08Z' },
  { id: 'change-3', product_id: null, product_name: null, kind: 'settings_updated', before: { shipping_cost_cents: 900 }, after: { shipping_cost_cents: 1000 }, actor_user_id: 'hq-1', actor_name: 'Alex Morgan', actor_member_id: 'hq-1', provider_id: null, office_name: null, created_at: '2026-09-19T16:30:52Z' },
  { id: 'change-4', product_id: 'catalog-9', product_name: 'Maintenance Stack – 2 Products', kind: 'product_retired', before: { status: 'active' }, after: { status: 'retired' }, actor_user_id: 'hq-2', actor_name: 'Morgan Lee', actor_member_id: 'hq-2', provider_id: null, office_name: null, created_at: '2026-09-18T12:00:14Z' },
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
      product_id: product.id, slug: product.slug, name: product.name, description: product.description, image_url: null, active: product.active,
      category: product.category, tagline: product.tagline,
      offered_cadences_weeks: product.offered_cadences_weeks, default_cadence_weeks: product.default_cadence_weeks,
      floor_price_cents: product.floor_price_cents, break_even_minimum_cents: product.break_even_minimum_cents,
      sell_price_cents: index === 5 && productIndex < 2 ? product.break_even_minimum_cents - 100 : product.floor_price_cents + 2000,
      subscription_enabled: productIndex < 2, offered: true, below_minimum: index === 5 && productIndex < 2,
      subscribe_save_percent: productIndex < 2 ? 10 : 0,
      subscription_price_cents: productIndex < 2 ? Math.round((product.floor_price_cents + 2000) * 0.9) : null,
    })),
    subscriptions: { active: index + 1, past_due: index === 3 ? 1 : 0, canceled: index % 2 },
    activity_30d: {
      collected_cents: provider.collected_30d_cents, thinnr_fee_cents: provider.fees_30d_cents,
      refunded_cents: provider.account?.charges_enabled ? 8999 : 0,
      net_cents: Math.max(0, provider.collected_30d_cents - provider.fees_30d_cents - Math.round(provider.collected_30d_cents * 0.029)),
      orders: provider.orders_30d, to_ship: provider.account?.charges_enabled ? 2 : 0,
    },
    recent_orders: DEMO_ORDERS.filter(order => order.provider_id === provider.provider_id).slice(0, 4),
    payouts: provider.account?.payouts_enabled ? [{ id: `payout-${index}`, stripe_payout_id: `po_demo_${index}`, amount_cents: 84250 + index * 10000, status: 'paid', arrival_date: '2026-09-25', method: 'standard', created_at: '2026-09-23T12:00:00Z' }] : [],
    links: index + 1,
  },
]));