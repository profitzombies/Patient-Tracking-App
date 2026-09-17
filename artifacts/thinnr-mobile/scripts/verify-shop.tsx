/**
 * Shop grid + cart screen contract check (real providers, scripted HTTP).
 *
 * Demo: the bundled storefront renders offline; the pay path is the demo
 * nudge. Real: the storefront comes from GET /billing/shop with a bearer,
 * tiles route to /product/<slug>, the cart quotes live from the server,
 * groups one-time vs subscription lines, edits and removes lines, persists
 * across a remount, and never leaks between accounts. Unavailable offices
 * (not connected / no products) show the explicit state and no tiles.
 */
import {
  act, alerts, assert, calls, finish, has, hosts, mount, press, pressable, productBySlug, script, section, shopCalls,
  signIn, signOut, storageMap, text, unavailableShop, unmount, liveShop,
} from './shop-stubs/harness';
import React from 'react';
import { readFileSync } from 'node:fs';
import ShopScreen from '../app/shop';
import CartScreen from '../app/cart';
import { routerLog } from './provider-training-stubs/expo-router';

async function main() {
  section('demo persona');
  await signOut();
  let tree = await mount(<ShopScreen />);
  const demoTiles = hosts(tree, 'shop-grid')[0]?.children.length ?? 0;
  assert('demo shop renders the bundled catalog offline', demoTiles >= 9 && has(tree, 'shop-demo-note') && has(tree, 'shop-product-control') && shopCalls().length === 0);
  assert('tile shows the patient price', text(tree, 'shop-price-control').includes('$'));
  await press(tree, 'shop-product-control');
  assert('tile opens the product page by slug', routerLog.at(-1)?.target === '/product/control');
  await unmount(tree);

  section('real storefront');
  await signIn();
  routerLog.length = 0;
  tree = await mount(<ShopScreen />);
  const shopCall = shopCalls().find(call => call.path.endsWith('/shop'));
  assert('storefront fetched once with bearer, demo note absent', shopCall?.auth === 'Bearer patient-token' && shopCalls().filter(call => call.path.endsWith('/shop')).length === 1 && !has(tree, 'shop-demo-note'));
  assert('every live product has a tile', script.shop.products.every(product => has(tree, `shop-product-${product.slug}`)));
  assert('header cart badge hidden while empty', !has(tree, 'shop-cart-count'));
  await unmount(tree);

  section('cart: lines, quote, grouping, edits');
  const control = productBySlug('control');
  const fiber = productBySlug('fiber');
  const bundle = script.shop.products.find(product => !product.subscription_available)!;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: [
    { product_id: control.product_id, quantity: 2, purchase: 'one_time', cadence_weeks: null },
    { product_id: fiber.product_id, quantity: 1, purchase: 'subscription', cadence_weeks: 8 },
    { product_id: bundle.product_id, quantity: 1, purchase: 'one_time', cadence_weeks: null },
  ] }));
  calls.length = 0;
  tree = await mount(<CartScreen />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  const quoteCall = shopCalls().find(call => call.path.endsWith('/cart/quote'));
  assert('live quote posted with wire lines', quoteCall?.method === 'POST' && JSON.stringify(quoteCall.body) === JSON.stringify({ lines: [
    { product_id: control.product_id, quantity: 2, purchase: 'one_time' },
    { product_id: fiber.product_id, quantity: 1, purchase: 'subscription', cadence_weeks: 8 },
    { product_id: bundle.product_id, quantity: 1, purchase: 'one_time' },
  ] }));
  assert('one-time and subscription lines grouped separately', has(tree, 'cart-group-one-time') && has(tree, 'cart-group-subscription-fiber') && has(tree, 'cart-line-control-one-time') && has(tree, 'cart-line-fiber-subscription'));
  const oneTimeSubtotal = control.unit_price_cents * 2 + bundle.unit_price_cents;
  const subUnit = fiber.subscription_unit_price_cents as number;
  const expectedShipping = script.shop.shipping_charge_cents * 2;
  const expectedTotal = oneTimeSubtotal + subUnit + expectedShipping;
  const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  assert('summary shows discount, shipping per group, and total', text(tree, 'cart-discount').includes(money(fiber.unit_price_cents - subUnit)) && text(tree, 'cart-shipping').includes(money(expectedShipping)) && text(tree, 'cart-total').includes(money(expectedTotal)));

  await press(tree, 'cart-control-one-time-inc');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  assert('quantity bump re-quotes and updates the line total', text(tree, 'cart-line-total-control-one-time').includes(money(control.unit_price_cents * 3)) && shopCalls().filter(call => call.path.endsWith('/cart/quote')).length >= 2);
  await press(tree, 'cart-fiber-cadence-12');
  assert('cadence change updates the subscription line', has(tree, 'cart-line-fiber-subscription') && JSON.parse(storageMap.get('thinnr_cart_v1:patient-1') ?? '{}').lines.some((line: { cadence_weeks: number | null }) => line.cadence_weeks === 12));
  await press(tree, 'cart-fiber-subscription-dec');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  assert('remove drops the subscription group and the discount row', !has(tree, 'cart-group-subscription-fiber') && !has(tree, 'cart-discount'));
  const persisted = JSON.parse(storageMap.get('thinnr_cart_v1:patient-1') ?? '{}') as { lines: unknown[] };
  assert('cart persists per account', persisted.lines.length === 2);
  await press(tree, 'cart-checkout');
  assert('checkout button routes to /checkout', routerLog.at(-1)?.target === '/checkout');
  await unmount(tree);

  section('shop header badge + remount, quote failure is inline');
  tree = await mount(<ShopScreen />);
  assert('shop header badge counts persisted items (3 + 1)', text(tree, 'shop-cart-count') === '4');
  await press(tree, 'shop-cart');
  assert('badge button opens the cart', routerLog.at(-1)?.target === '/cart');
  await unmount(tree);
  script.quoteFailure = { status: 503, error: 'Pricing is briefly unavailable.' };
  tree = await mount(<CartScreen />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  assert('persisted lines rehydrate and the quote error is announced inline', has(tree, 'cart-line-control-one-time') && text(tree, 'cart-quote-error').includes('briefly unavailable'));
  script.quoteFailure = null;
  await unmount(tree);

  section('cart locked behind a pending payment');
  const lockedLines = [
    { product_id: control.product_id, quantity: 2, purchase: 'one_time', cadence_weeks: null },
    { product_id: fiber.product_id, quantity: 1, purchase: 'subscription', cadence_weeks: 8 },
  ];
  const lockedQuote = { lines: [], groups: [], subtotal_cents: 1, discount_cents: 0, shipping_charge_cents: script.shop.shipping_charge_cents, tax_enabled: false, tax_cents: 0, total_cents: 1, total_due_cents: 1 };
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: lockedLines, pending: { cartId: 'cart-pending-2', request: { lines: [], shipping_address: { name: 'P', line1: '1', line2: null, city: 'B', state: 'MA', postal_code: '02110', country: 'US', phone: null }, payment_method_id: 'pm_x', set_default: false, expected_total_due_cents: 1 }, quote: lockedQuote } }));
  tree = await mount(<CartScreen />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  assert('the lock is announced with a Confirm payment action; Keep shopping is gone', has(tree, 'cart-locked') && has(tree, 'cart-confirm-payment') && !has(tree, 'cart-continue') && text(tree, 'cart-checkout') === 'Confirm payment');
  const incLocked = pressable(tree, 'cart-control-one-time-inc');
  const decLocked = pressable(tree, 'cart-fiber-subscription-dec');
  assert('steppers are frozen (disabled for assistive tech too)', incLocked?.props['aria-disabled'] === true && decLocked?.props['aria-disabled'] === true && !has(tree, 'cart-fiber-cadence-4'));
  await press(tree, 'cart-control-one-time-inc');
  await press(tree, 'cart-fiber-subscription-dec');
  const frozen = JSON.parse(storageMap.get('thinnr_cart_v1:patient-1') ?? '{}') as { lines: { quantity: number }[]; pending: unknown };
  assert('taps change nothing: lines and the pending attempt persist exactly as they were', text(tree, 'cart-control-one-time-value') === '2' && has(tree, 'cart-line-fiber-subscription') && frozen.lines.length === 2 && frozen.lines[0].quantity === 2 && !!frozen.pending);
  await press(tree, 'cart-confirm-payment');
  assert('Confirm payment routes to /checkout', routerLog.at(-1)?.target === '/checkout');
  await unmount(tree);
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: lockedLines }));

  section('account isolation');
  await signOut();
  tree = await mount(<CartScreen />);
  assert('demo account starts with its own empty cart, no network', has(tree, 'cart-empty') && !has(tree, 'cart-line-control-one-time'));
  await unmount(tree);
  await signIn();

  section('unavailable office');
  script.shop = unavailableShop('not_connected');
  tree = await mount(<ShopScreen />);
  assert('not connected: explicit state, no grid', has(tree, 'shop-unavailable') && !has(tree, 'shop-grid') && text(tree, 'shop-unavailable').toLowerCase().includes('payments'));
  await unmount(tree);
  script.shop = unavailableShop('no_products');
  tree = await mount(<ShopScreen />);
  assert('no products: explicit state', has(tree, 'shop-unavailable') && !has(tree, 'shop-grid'));
  await unmount(tree);

  section('storefront failure + retry');
  script.shop = liveShop();
  script.shopFailure = { status: 503, error: 'The shop is briefly unavailable.' };
  tree = await mount(<ShopScreen />);
  assert('failure shows inline error with Retry, no demo data', text(tree, 'shop-error').includes('briefly unavailable') && has(tree, 'shop-retry') && !has(tree, 'shop-product-control'));
  script.shopFailure = null;
  await press(tree, 'shop-retry');
  assert('Retry refetches and renders the grid', has(tree, 'shop-grid') && has(tree, 'shop-product-control'));
  await unmount(tree);

  section('launcher entry');
  const fab = readFileSync(new URL('../components/patient/PatientFabMenu.tsx', import.meta.url), 'utf8');
  assert('patient launcher has a Shop row routed to /shop with the cart badge', /key: 'shop'/.test(fab) && /href: '\/shop'/.test(fab) && /useCartCount/.test(fab));
  assert('no unexpected alerts fired', alerts.length === 0);

  finish();
}

main().catch(error => { console.error(error); process.exit(1); });
