import React from 'react';
import { mount, STAFF, setScript, requests, writes, paths, resetRequests, press, type, isBlocked, one, all, ids, text, textOf, check, section, finish, settle, routerLog } from './payments-stubs/harness';
import { setSearchParams, setPathname } from './provider-training-stubs/expo-router';
import SubscriptionsScreen from '../app/(tabs)/payments/subscriptions';
import { SAMPLE_PRICES, SAMPLE_SUBSCRIPTIONS } from './fixtures/sample-office-payments';
import type { OfficeBillingStatus } from '../lib/office-billing-types';

const STATUS = {
  account: { id: 'acct_1' }, offered_products: 2, links: 0, sandbox: true, oauth_available: true,
  viewer: { office_role: 'owner', can_manage: true },
  office: { provider_id: 'prov-1', office_name: 'Maple Med Spa' },
} as unknown as OfficeBillingStatus;
const PRODUCTS = SAMPLE_PRICES.map((p) => p.product_id === 'fiber' ? { ...p, subscription_enabled: true } : p);
const UNPAUSED_ACTIVE = {
  ...SAMPLE_SUBSCRIPTIONS[1],
  id: 'live-sub-active',
  payer: { ...SAMPLE_SUBSCRIPTIONS[1].payer, name: 'Avery Active' },
  paused_at: null,
};
const LIVE_SUBSCRIPTIONS = [...SAMPLE_SUBSCRIPTIONS, UNPAUSED_ACTIVE];
const QUOTE = {
  current: { product_id: 'control', product_name: 'Control', unit_price_cents: 7999 },
  next: { product_id: 'fiber', product_name: 'Fiber', unit_price_cents: 4499, shipping_charge_cents: 1000, application_fee_cents: 2800 },
  effective_at: '2026-11-07T00:00:00Z',
};

function script(over: Partial<Record<string, { status: number; body: unknown }>> = {}) {
  setScript((req, url) => {
    if (over[`${req.method} ${req.path}`]) return over[`${req.method} ${req.path}`];
    if (over[req.path]) return over[req.path];
    if (req.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (req.path === '/api/billing/office/subscriptions' && req.method === 'GET') {
      const status = url.searchParams.get('status');
      return {
        status: 200,
        body: { items: status ? LIVE_SUBSCRIPTIONS.filter((row) => row.status === status) : LIVE_SUBSCRIPTIONS, next_cursor: null },
      };
    }
    if (req.path === '/api/billing/office/prices' && req.method === 'GET') return { status: 200, body: { products: PRODUCTS, settings: {} } };
    if (req.path.endsWith('/change-quote')) return { status: 200, body: QUOTE };
    if (req.path.startsWith('/api/billing/office/subscriptions/') && req.method === 'POST') return { status: 200, body: { subscription: SAMPLE_SUBSCRIPTIONS[0] } };
    return undefined;
  });
}

function exactWrite(method: string, path: string, body: unknown) {
  const row = writes().find((r) => r.path === path);
  return row?.method === method && JSON.stringify(row.body) === JSON.stringify(body);
}

async function main() {
  setPathname('/payments/subscriptions');

  section('Signed out');
  resetRequests();
  setSearchParams({});
  script();
  const signedOut = await mount(<SubscriptionsScreen />, null);
  check('signed-out mount holds the sign-in frame: no rows, no fetch', requests.length === 0 && !!one(signedOut.root, 'billing-session-loading') && ids(signedOut.root, 'subscription-row-').length === 0, paths().join(' | '));
  await signedOut.unmount();

  section('Live filtering and reads');
  resetRequests();
  setSearchParams({ status: 'past_due' });
  script();
  const live = await mount(<SubscriptionsScreen />, STAFF);
  const list = requests.find((r) => r.path === '/api/billing/office/subscriptions');
  check('deep-link status is selected and sent', one(live.root, 'subscriptions-filter-past_due')?.props.accessibilityState?.selected === true && list?.url.endsWith('?status=past_due'), list?.url);
  check('all reads carry staff bearer and no office query', requests.every((r) => r.auth === 'Bearer staff-token' && !r.url.includes('office=')), paths().join(' | '));
  resetRequests();
  await press(live.root, 'subscriptions-filter-active');
  await settle();
  check('Active requests exact status query', requests.some((r) => r.path === '/api/billing/office/subscriptions' && r.url.endsWith('?status=active')), paths().join(' | '));
  check('Active excludes paused rows', !!one(live.root, 'subscription-row-live-sub-active') && !one(live.root, 'subscription-row-demo-sub-2'));

  await press(live.root, 'subscriptions-filter-paused');
  await settle();
  check('Paused requests active DB status', requests.some((r) => r.path === '/api/billing/office/subscriptions' && r.url.endsWith('?status=active')), paths().join(' | '));
  check('Paused renders paused fixture and excludes unpaused active fixture', !!one(live.root, 'subscription-row-demo-sub-2') && !one(live.root, 'subscription-row-live-sub-active'));

  for (const filter of ['incomplete', 'unpaid', 'canceled'] as const) {
    resetRequests();
    await press(live.root, `subscriptions-filter-${filter}`);
    await settle();
    check(`${filter} sends exact status query`, requests.some((r) => r.path === '/api/billing/office/subscriptions' && r.url.endsWith(`?status=${filter}`)), paths().join(' | '));
  }
  resetRequests();
  await press(live.root, 'subscriptions-filter-all');
  await settle();
  const allRequest = requests.find((r) => r.path === '/api/billing/office/subscriptions');
  check('All sends no status query', allRequest?.url.endsWith('/api/billing/office/subscriptions') === true, allRequest?.url);
  await live.unmount();

  resetRequests();
  setSearchParams({ status: 'paused' });
  const pausedDeepLink = await mount(<SubscriptionsScreen />, STAFF);
  const pausedRequest = requests.find((r) => r.path === '/api/billing/office/subscriptions');
  check('Paused deep link fetches exact active query', pausedRequest?.url.endsWith('?status=active') === true, pausedRequest?.url);
  check('Paused deep link locally splits active rows', !!one(pausedDeepLink.root, 'subscription-row-demo-sub-2') && !one(pausedDeepLink.root, 'subscription-row-live-sub-active'));
  await pausedDeepLink.unmount();

  section('All six writes and change quote');
  setSearchParams({});
  script();
  const actions = await mount(<SubscriptionsScreen />, STAFF);

  resetRequests();
  await press(actions.root, 'button-pause-demo-sub-1');
  check('pause writes exact empty body', exactWrite('POST', '/api/billing/office/subscriptions/demo-sub-1/pause', {}));
  check('pause success wording', text(actions.root, 'subscription-notice-demo-sub-1') === 'Subscription paused');

  resetRequests();
  await press(actions.root, 'button-resume-demo-sub-2');
  check('resume writes exact empty body', exactWrite('POST', '/api/billing/office/subscriptions/demo-sub-2/resume', {}));
  check('resume success wording', text(actions.root, 'subscription-notice-demo-sub-2') === 'Subscription resumed');

  resetRequests();
  await press(actions.root, 'button-retry-payment-demo-sub-1');
  check('retry payment writes exact empty body', exactWrite('POST', '/api/billing/office/subscriptions/demo-sub-1/retry-payment', {}));
  check('retry success wording', text(actions.root, 'subscription-notice-demo-sub-1') === 'Payment retry started');

  resetRequests();
  await press(actions.root, 'button-resend-payment-email-demo-sub-1');
  check('resend email writes exact empty body', exactWrite('POST', '/api/billing/office/subscriptions/demo-sub-1/resend-payment-email', {}));
  check('resend success wording', text(actions.root, 'subscription-notice-demo-sub-1') === 'Payment link emailed');

  await press(actions.root, 'button-cancel-subscription-demo-sub-1');
  check('cancel is safeguarded until CANCEL is typed', isBlocked(actions.root, 'button-cancel-subscription-confirm-demo-sub-1'));
  resetRequests();
  await type(actions.root, 'input-cancel-confirm-demo-sub-1', 'cancel');
  await press(actions.root, 'button-cancel-subscription-confirm-demo-sub-1');
  check('cancel writes exact period-end body', exactWrite('POST', '/api/billing/office/subscriptions/demo-sub-1/cancel', { at_period_end: true }));
  check('cancel success wording', text(actions.root, 'subscription-notice-demo-sub-1') === 'Subscription ends at period end');

  await press(actions.root, 'button-change-product-demo-sub-1');
  resetRequests();
  await press(actions.root, 'change-product-option-demo-sub-1-fiber');
  await settle();
  const quote = requests.find((r) => r.path.endsWith('/change-quote'));
  check('change quote GET has exact product query', quote?.method === 'GET' && quote.url.endsWith('/change-quote?product_id=fiber'), quote?.url);
  check('quote displays current, next, shipping and effective date', text(actions.root, 'subscription-change-quote-demo-sub-1').includes('Current: Control') && text(actions.root, 'subscription-change-quote-demo-sub-1').includes('Shipping: $10.00'));
  resetRequests();
  await press(actions.root, 'button-confirm-change-demo-sub-1');
  check('change writes exact body', exactWrite('POST', '/api/billing/office/subscriptions/demo-sub-1/change', { product_id: 'fiber' }));
  check('change success wording', text(actions.root, 'subscription-notice-demo-sub-1') === 'Product change scheduled');
  await actions.unmount();

  section('Write failure, loading, error and retry');
  script({ 'POST /api/billing/office/subscriptions/demo-sub-1/retry-payment': { status: 402, body: { error: 'Card was declined again.' } } });
  const failed = await mount(<SubscriptionsScreen />, STAFF);
  await press(failed.root, 'button-retry-payment-demo-sub-1');
  check('4xx write error is shown', text(failed.root, 'subscription-notice-demo-sub-1').includes('Card was declined again.'));
  await failed.unmount();

  script({ '/api/billing/office/subscriptions': { status: 500, body: { error: 'subscriptions unavailable' } } });
  const errored = await mount(<SubscriptionsScreen />, STAFF);
  check('read error has announced retry', !!one(errored.root, 'subscriptions-error') && !!one(errored.root, 'subscriptions-error-retry'));
  script();
  await press(errored.root, 'subscriptions-error-retry');
  check('retry recovers', !!one(errored.root, 'subscriptions-list'));
  await errored.unmount();

  setScript((req) => req.path === '/api/billing/office/status' ? { status: 200, body: STATUS } : req.path === '/api/billing/office/subscriptions' ? { delay: true } : req.path === '/api/billing/office/prices' ? { status: 200, body: { products: PRODUCTS, settings: {} } } : undefined);
  const loading = await mount(<SubscriptionsScreen />, STAFF);
  check('loading state is announced', !!one(loading.root, 'subscriptions-loading'));
  await loading.unmount();

  section('Accessibility');
  script();
  const accessible = await mount(<SubscriptionsScreen />, STAFF);
  const pressables = accessible.root.findAll((n) => n.type === 'Pressable' && typeof n.props.onPress === 'function');
  const unnamed = pressables.filter((n) => !n.props.accessibilityRole || (!n.props.accessibilityLabel && !textOf(n)));
  check('every pressable has a role and name', unnamed.length === 0, String(unnamed.length));
  await accessible.unmount();
  void all; void routerLog;
  finish('payments-subscriptions');
}

main().catch((error) => { console.error(error); process.exit(1); });