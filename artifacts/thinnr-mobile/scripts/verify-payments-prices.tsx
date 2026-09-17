import React from 'react';
import { mount, STAFF, setScript, requests, writes, paths, resetRequests, press, type, isBlocked, one, all, ids, text, textOf, check, section, finish, settle, routerLog } from './payments-stubs/harness';
import { setSearchParams, setPathname } from './provider-training-stubs/expo-router';
import PricesScreen from '../app/(tabs)/payments/prices';
import { DEMO_PRICES } from '../data/office-payments-demo';
import type { OfficeBillingStatus } from '../lib/office-billing-types';

const STATUS = {
  account: { id: 'acct_1' },
  offered_products: 2,
  links: 0,
  sandbox: true,
  oauth_available: true,
  viewer: { office_role: 'owner', can_manage: true },
  office: { provider_id: 'prov-1', office_name: 'Maple Med Spa' },
} as unknown as OfficeBillingStatus;
const PRICES = { products: DEMO_PRICES, settings: { shipping_charge_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, subscribe_save_enabled: true, subscribe_save_percent: 10 } };

function script(over: Partial<Record<string, { status: number; body: unknown }>> = {}) {
  setScript((req) => {
    if (over[`${req.method} ${req.path}`]) return over[`${req.method} ${req.path}`];
    if (over[req.path]) return over[req.path];
    if (req.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (req.path === '/api/billing/office/prices' && req.method === 'GET') return { status: 200, body: PRICES };
    if (req.path.startsWith('/api/billing/office/prices/') && req.method === 'PUT') return { status: 200, body: { product: DEMO_PRICES[0] } };
    return undefined;
  });
}

async function main() {
  setPathname('/payments/prices');
  setSearchParams({});

  section('Demo persona');
  resetRequests();
  script();
  const demo = await mount(<PricesScreen />, null);
  check('demo uses pinned catalog without fetches', requests.length === 0 && ids(demo.root, 'price-row-').length === DEMO_PRICES.length, paths().join(' | '));
  check('demo edit controls are blocked', DEMO_PRICES.every((p) => isBlocked(demo.root, `button-edit-price-${p.product_id}`)));
  check('catalog copy and cadence details render', text(demo.root, 'prices-catalog').includes('Subscriptions need your own price') && text(demo.root, 'text-price-plan-control').includes('subscribe and save 10%'));
  await demo.unmount();

  section('Live read, edit, validation and save');
  resetRequests();
  script();
  const live = await mount(<PricesScreen />, STAFF);
  check('status and prices use staff bearer', requests.length === 2 && requests.every((r) => r.auth === 'Bearer staff-token'), paths().join(' | '));
  check('live catalog renders', ids(live.root, 'price-row-').length === 2);
  await press(live.root, 'button-edit-price-control');
  check('edit exposes labelled money and toggles', !!one(live.root, 'input-price-control') && !!one(live.root, 'toggle-offered-control') && !!one(live.root, 'toggle-subscription-control'));

  resetRequests();
  await type(live.root, 'input-price-control', 'nope');
  await press(live.root, 'button-save-price-control');
  check('bad money is blocked client-side', writes().length === 0 && text(live.root, 'price-error-control').includes('Use dollars and cents, like 59.99.'));
  await type(live.root, 'input-price-control', '10.00');
  await press(live.root, 'button-save-price-control');
  check('below-minimum price is blocked', writes().length === 0 && text(live.root, 'price-error-control').includes('Price must be at least $37.67.'));

  await type(live.root, 'input-price-control', '82.50');
  await press(live.root, 'button-save-price-control');
  await settle();
  const save = writes()[0];
  check('save PUT has exact path and body', save?.method === 'PUT' && save.path === '/api/billing/office/prices/control' && JSON.stringify(save.body) === JSON.stringify({ sell_price_cents: 8250, subscription_enabled: true }), JSON.stringify(save));
  check('success notice uses web wording', text(live.root, 'price-success-control') === 'Control saved');

  await press(live.root, 'button-edit-price-fiber');
  await press(live.root, 'toggle-offered-fiber');
  resetRequests();
  await press(live.root, 'button-save-price-fiber');
  await settle();
  const blank = writes()[0];
  check('turning Own price off sends null and disables subscriptions', JSON.stringify(blank?.body) === JSON.stringify({ sell_price_cents: null, subscription_enabled: false }));
  await live.unmount();

  section('Write failure and read error retry');
  script({ 'PUT /api/billing/office/prices/control': { status: 422, body: { error: 'That price is no longer allowed.' } } });
  const failed = await mount(<PricesScreen />, STAFF);
  await press(failed.root, 'button-edit-price-control');
  await type(failed.root, 'input-price-control', '82.50');
  await press(failed.root, 'button-save-price-control');
  check('4xx message is announced', text(failed.root, 'price-error-control').includes('That price is no longer allowed.'));
  await failed.unmount();

  script({ '/api/billing/office/prices': { status: 500, body: { error: 'prices unavailable' } } });
  const errored = await mount(<PricesScreen />, STAFF);
  check('read error has retry', !!one(errored.root, 'prices-error') && !!one(errored.root, 'prices-error-retry'));
  script();
  await press(errored.root, 'prices-error-retry');
  check('retry recovers', !!one(errored.root, 'prices-catalog'));
  await errored.unmount();

  section('Loading and accessibility');
  setScript((req) => req.path === '/api/billing/office/status' ? { status: 200, body: STATUS } : req.path === '/api/billing/office/prices' ? { delay: true } : undefined);
  const loading = await mount(<PricesScreen />, STAFF);
  check('loading state is announced', !!one(loading.root, 'prices-loading'));
  await loading.unmount();
  script();
  const accessible = await mount(<PricesScreen />, STAFF);
  const pressables = accessible.root.findAll((n) => n.type === 'Pressable' && typeof n.props.onPress === 'function');
  const unnamed = pressables.filter((n) => !n.props.accessibilityRole || (!n.props.accessibilityLabel && !textOf(n)));
  check('every pressable has a role and name', unnamed.length === 0, String(unnamed.length));
  await accessible.unmount();
  void all; void textOf; void routerLog;
  finish('payments-prices');
}

main().catch((error) => { console.error(error); process.exit(1); });