/**
 * Checkout screen contract check (real providers, scripted HTTP + card SDK).
 *
 * Real account: the address pre-fills from the storefront's saved address
 * and profile, the live quote prices the cart, saved cards are offered, and
 * one Pay tap sends POST /billing/cart/checkout with the exact wire shape
 * (lines, normalized address, payment method, set_default, cart_id) and an
 * Idempotency-Key. A 402 decline stays on the screen with the card error,
 * keeps the cart, and the next tap uses a NEW cart id; a lost response or a
 * 5xx retries with the SAME id and the SAME request, persisted so a remount
 * replays it; a partial answer drops the paid lines before the next attempt;
 * a paid answer clears the cart and replaces to the confirmation route with
 * order numbers. A tax-collecting office shows the server's tax estimate and
 * charges the amount due, never the pre-tax total. Validation blocks Pay
 * inline. Demo: the form renders, no card entry mounts, Pay is disabled and
 * explains, no network.
 */
import {
  act, alerts, assert, calls, finish, has, hosts, mount, otherSession, paidResponse, press, pressable, productBySlug, script, section, shopCalls,
  session, signIn, signOut, storageMap, text, type, unmount,
} from './shop-stubs/harness';
import React from 'react';
import CheckoutScreen from '../app/checkout';
import { routerLog, lastParams } from './provider-training-stubs/expo-router';
import { cardScript } from './shop-stubs/StripeCardEntry';
import { holdNextStubSessionLookup } from './live-diary-stubs/supabase';
import type { CartLine } from '../lib/cart-math';

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const checkoutCalls = () => shopCalls().filter(call => call.path.endsWith('/cart/checkout'));
const storedCart = (scope: string) => JSON.parse(storageMap.get(`thinnr_cart_v1:${scope}`) ?? '{"lines":[],"pending":null}') as { lines: CartLine[]; pending: { cartId: string; request: Record<string, unknown>; quote: { total_due_cents: number | null } } | null };
const storedLines = (scope: string) => storedCart(scope).lines;
const storedPending = (scope: string) => storedCart(scope).pending ?? null;
async function wait(ms: number) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }

async function main() {
  const control = productBySlug('control');
  const fiber = productBySlug('fiber');
  const lines: CartLine[] = [
    { product_id: control.product_id, quantity: 2, purchase: 'one_time', cadence_weeks: null },
    { product_id: fiber.product_id, quantity: 1, purchase: 'subscription', cadence_weeks: 8 },
  ];
  const subUnit = fiber.subscription_unit_price_cents as number;
  const expectedTotal = control.unit_price_cents * 2 + subUnit + script.shop.shipping_charge_cents * 2;

  section('demo persona');
  await signOut();
  storageMap.set('thinnr_cart_v1:demo', JSON.stringify({ lines }));
  let tree = await mount(<CheckoutScreen />);
  assert('demo form renders with the demo address and totals, no card entry, no network', has(tree, 'checkout-demo-note') && hosts(tree, 'checkout-name')[0]?.props.value === 'Demo Patient' && has(tree, 'checkout-card-placeholder') && cardScript.mounts === 0 && shopCalls().length === 0 && has(tree, 'checkout-total'));
  const demoPay = pressable(tree, 'checkout-pay');
  assert('demo Pay is disabled and explains on tap', demoPay?.props['aria-disabled'] === true || demoPay?.props.accessibilityState?.disabled === true);
  await press(tree, 'checkout-pay');
  assert('demo tap fires the demo nudge, no checkout request', alerts.length === 1 && checkoutCalls().length === 0 && routerLog.length === 0);
  await unmount(tree);

  section('real account: prefill, quote, cards');
  await signIn();
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines }));
  script.cards = { cards: [{ id: 'pm_saved', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, is_default: true }], default_payment_method_id: 'pm_saved' };
  calls.length = 0;
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  const name = hosts(tree, 'checkout-name')[0]?.props.value;
  assert('address pre-fills from the saved storefront address; email from the profile', name === 'Pat Example' && hosts(tree, 'checkout-line1')[0]?.props.value === '9 Harbor Rd' && hosts(tree, 'checkout-postal')[0]?.props.value === '02110' && text(tree, 'checkout-email') === 'pat@example.com' && hosts(tree, 'checkout-email')[0]?.props.value === undefined && hosts(tree, 'checkout-phone')[0]?.props.value === '+15550001010');
  assert('live quote fetched and shown with sandbox note', shopCalls().some(call => call.path.endsWith('/cart/quote')) && text(tree, 'checkout-total').includes(money(expectedTotal)) && has(tree, 'checkout-sandbox') && !has(tree, 'checkout-demo-note'));
  assert('saved default card preselected; new-card option offered; card entry mounted but hidden for 3DS', hosts(tree, 'checkout-card-pm_saved')[0]?.props.accessibilityState?.checked === true && has(tree, 'checkout-card-new') && cardScript.mounts === 1 && hosts(tree, 'checkout-card-entry')[0]?.props.hidden === true && !has(tree, 'checkout-save-card'));

  section('shipping methods, windows, free standard, fallback, and quote gating');
  await wait(50);
  assert('live shipping options render as a radio group with the standard arrival window', has(tree, 'checkout-shipping-methods') && hosts(tree, 'checkout-shipping-standard')[0]?.props.accessibilityState?.checked === true && text(tree, 'checkout-shipping-window') === 'Arrives Mon Sep 21 – Wed Sep 23');
  script.quoteDelayMs = 100;
  await press(tree, 'checkout-shipping-expedited');
  await wait(1);
  assert('Pay is aria-disabled while the selected method is being quoted', pressable(tree, 'checkout-pay')?.props['aria-disabled'] === true || pressable(tree, 'checkout-pay')?.props.accessibilityState?.disabled === true);
  await press(tree, 'checkout-pay');
  assert('a blocked Pay tap explains that pricing is still in progress', text(tree, 'checkout-error').includes('Still pricing'));
  await wait(110);
  const expeditedQuote = shopCalls().filter(call => call.path.endsWith('/cart/quote')).at(-1);
  assert('selecting expedited re-quotes with shipping_method and updates the total', expeditedQuote?.body?.shipping_method === 'expedited' && text(tree, 'checkout-total').includes(money(expectedTotal + 500)) && text(tree, 'checkout-shipping-window') === 'Arrives Sat Sep 19 – Sun Sep 20');
  script.quoteDelayMs = 0;
  script.standardFree = true;
  await press(tree, 'checkout-shipping-standard');
  await wait(5);
  assert('standard above the free-shipping threshold is labelled Free', text(tree, 'checkout-shipping-standard').includes('Free'));
  script.standardFree = false;
  script.shippingMode = 'fallback';
  await press(tree, 'checkout-shipping-expedited');
  await wait(5);
  assert('fallback shows the short note and no arrival window', has(tree, 'checkout-shipping-note') && !has(tree, 'checkout-shipping-window'));
  script.shippingMode = 'live';
  await press(tree, 'checkout-shipping-standard');
  await wait(5);
  script.quoteFailure = { status: 422, error: 'Check this shipping address.', field: 'shipping_address' };
  await type(tree, 'checkout-line2', 'Unit 5');
  await wait(5);
  assert('a 422 shipping_address refusal is announced at the address form', text(tree, 'checkout-address-error').includes('Check this shipping address'));
  script.quoteFailure = null;
  await type(tree, 'checkout-line2', 'Unit 4');
  await wait(5);

  section('pay with a saved card: request shape');
  script.checkoutAttempts.clear();
  let persistedBeforePost: boolean | null = null;
  script.checkout = (body, cartId) => {
    // Observed on the server's side of the wire: the attempt is already on disk, byte for byte, when the request arrives.
    const pending = storedPending('patient-1');
    persistedBeforePost = pending?.cartId === cartId && JSON.stringify(pending?.request) === JSON.stringify((({ cart_id: _omit, ...rest }) => rest)(body));
    return { status: 200, body: paidResponse(cartId, lines) };
  };
  await press(tree, 'checkout-pay');
  const paidCall = checkoutCalls()[0];
  assert('the attempt is committed to the device store BEFORE the request leaves', persistedBeforePost === true);
  assert('the body binds the total the button showed (expected_total_due_cents = quote total due)', paidCall?.body?.expected_total_due_cents === expectedTotal);
  assert('one POST with bearer and Idempotency-Key bound to the cart id', paidCall?.method === 'POST' && paidCall.auth === 'Bearer patient-token' && paidCall.headers['Idempotency-Key'] === `patient-billing-checkout-${String(paidCall.body?.cart_id)}` && checkoutCalls().length === 1);
  assert('body carries lines, normalized address, saved card, set_default false', JSON.stringify(paidCall?.body?.lines) === JSON.stringify([
    { product_id: control.product_id, quantity: 2, purchase: 'one_time' },
    { product_id: fiber.product_id, quantity: 1, purchase: 'subscription', cadence_weeks: 8 },
  ]) && JSON.stringify(paidCall?.body?.shipping_address) === JSON.stringify({ name: 'Pat Example', line1: '9 Harbor Rd', line2: 'Unit 4', city: 'Boston', state: 'MA', postal_code: '02110', country: 'US', phone: '+15550001010' }) && paidCall?.body?.shipping_method === 'standard' && paidCall?.body?.payment_method_id === 'pm_saved' && paidCall?.body?.set_default === false && typeof paidCall?.body?.cart_id === 'string');
  const confirmation = routerLog.at(-1);
  assert('paid → cart cleared and replaced to the confirmation with order numbers', confirmation?.method === 'replace' && confirmation.target === '/order-confirmation' && storedLines('patient-1').length === 0 && !has(tree, 'checkout-error'));
  assert('confirmation params carry the order, the subscription, the total, and the office', lastParams?.orders === 'TH-101' && lastParams?.subscriptions === 'TH-102' && lastParams?.total === String(expectedTotal) && lastParams?.office === 'Harbor Health');
  await unmount(tree);

  section('decline, retry ids, and a new card');
  routerLog.length = 0;
  alerts.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines }));
  script.cards = { cards: [], default_payment_method_id: null };
  script.checkoutAttempts.clear();
  const seen: { cartId: string; attempt: number; answer: string }[] = [];
  const answers: Array<'declined' | 'attach_declined' | 'network' | 'paid' | 'conflict' | 'server_error'> = ['attach_declined', 'declined', 'server_error', 'network', 'paid'];
  script.checkout = (body, cartId, attempt) => {
    const answer = answers.shift() ?? 'paid';
    seen.push({ cartId, attempt, answer });
    if (answer === 'network') return 'network';
    if (answer === 'conflict') return { status: 409, body: { error: 'Still processing.' } };
    if (answer === 'server_error') return { status: 502, body: { error: 'Bad gateway' } };
    if (answer === 'attach_declined') {
      // Stripe refuses some cards when the server attaches them, before any
      // order exists: a plain 402 error envelope, not a checkout result.
      return { status: 402, body: { error: 'Your card was declined.', field: 'payment_method_id' } };
    }
    if (answer === 'declined') {
      return { status: 402, body: { ...paidResponse(cartId, lines), status: 'failed', items: [{ kind: 'one_time', order_id: 'o-x', order_number: 'TH-X', subscription_id: null, status: 'failed', client_secret: null, error: 'Your card was declined.', total_cents: 0, product_ids: [] }] } };
    }
    return { status: 200, body: paidResponse(cartId, lines) };
  };
  cardScript.createPaymentMethod = async () => ({ paymentMethodId: 'pm_new_1' });
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  assert('no saved cards → new-card entry mounts with the office publishable key on the connected account', cardScript.mounts === 2 && hosts(tree, 'checkout-card-entry')[0]?.props.hidden === false && has(tree, 'checkout-save-card') && cardScript.configs.at(-1)?.publishableKey === 'pk_test_office1' && cardScript.configs.at(-1)?.stripeAccountId === 'acct_office1' && has(tree, 'checkout-card-entry'));
  await press(tree, 'checkout-pay');
  assert('incomplete card blocks Pay inline, no request', text(tree, 'checkout-error').toLowerCase().includes('card') && checkoutCalls().length === 1);
  await act(async () => cardScript.setComplete(true));
  await wait(5);

  await press(tree, 'checkout-pay');
  assert('402 error envelope (card refused at attach) shows the decline inline, keeps the cart, no navigation', text(tree, 'checkout-error') === 'Your card was declined.' && storedLines('patient-1').length === 2 && routerLog.length === 0 && seen.length === 1);
  assert('new card tokenized with billing details and set_default true', cardScript.billing.at(-1)?.address.postal_code === '02110' && cardScript.billing.at(-1)?.email === 'pat@example.com' && checkoutCalls().at(-1)?.body?.payment_method_id === 'pm_new_1' && checkoutCalls().at(-1)?.body?.set_default === true);

  await press(tree, 'checkout-pay');
  assert('402 failed result shows the card error under a NEW cart id, keeps the cart, no navigation', text(tree, 'checkout-error') === 'Your card was declined.' && seen.length === 2 && seen[1].cartId !== seen[0].cartId && storedLines('patient-1').length === 2 && routerLog.length === 0);

  assert('definite answers leave no pending attempt behind', storedPending('patient-1') === null && !has(tree, 'checkout-pending-note'));

  await press(tree, 'checkout-pay');
  assert('after a decline the next attempt uses a NEW cart id; a 5xx is announced and leaves the attempt PENDING', seen.length === 3 && seen[2].cartId !== seen[1].cartId && text(tree, 'checkout-error').length > 0 && routerLog.length === 0 && storedLines('patient-1').length === 2 && storedPending('patient-1')?.cartId === seen[2].cartId && has(tree, 'checkout-pending-note'));
  assert('the pending attempt persists the exact request that was sent', JSON.stringify(storedPending('patient-1')?.request) === JSON.stringify(checkoutCalls().at(-1)?.body && (({ cart_id: _omit, ...rest }) => rest)(checkoutCalls().at(-1)!.body as Record<string, unknown>)));
  assert('pending mode replaces the form with the frozen attempt: its total, ship-to, and card, no address inputs, Pay reads Confirm', has(tree, 'checkout-pending') && text(tree, 'checkout-pending-total').includes(money(expectedTotal)) && text(tree, 'checkout-pending-ship-to').includes('9 Harbor Rd') && text(tree, 'checkout-pending-card').length > 0 && !has(tree, 'checkout-name') && !has(tree, 'checkout-card-new') && text(tree, 'checkout-pay').includes('Confirm payment') && text(tree, 'checkout-pay').includes(money(expectedTotal)) && storedPending('patient-1')?.quote.total_due_cents === expectedTotal);

  await press(tree, 'checkout-pay');
  assert('a lost response replays the SAME cart id and stays pending', seen.length === 4 && seen[3].cartId === seen[2].cartId && seen[3].answer === 'network' && storedPending('patient-1')?.cartId === seen[2].cartId && routerLog.length === 0);

  // A remount (reload) must pick the pending attempt back up unchanged, even
  // with a different card preselected and no card details entered.
  await unmount(tree);
  script.cards = { cards: [{ id: 'pm_saved', brand: 'visa', last4: '3220', exp_month: 1, exp_year: 2031, is_default: true }], default_payment_method_id: 'pm_saved' };
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  assert('after a reload the screen offers to confirm the pending attempt', has(tree, 'checkout-pending-note') && text(tree, 'checkout-pay').includes('Confirm payment'));
  await press(tree, 'checkout-pay');
  assert('the replay reuses the persisted cart id and payment method, then succeeds and clears the cart and the pending attempt', seen.length === 5 && seen[4].cartId === seen[2].cartId && seen[4].answer === 'paid' && checkoutCalls().at(-1)?.body?.payment_method_id === 'pm_new_1' && routerLog.at(-1)?.target === '/order-confirmation' && storedLines('patient-1').length === 0 && storedPending('patient-1') === null);
  await unmount(tree);

  section('partial result drops the paid lines before any retry');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines }));
  script.checkoutAttempts.clear();
  seen.length = 0;
  script.checkout = (body, cartId, attempt) => {
    seen.push({ cartId, attempt, answer: 'partial' });
    const full = paidResponse(cartId, lines);
    const [oneTime, subscription] = full.items;
    if (seen.length === 1) {
      return { status: 200, body: { ...full, status: 'partial', items: [oneTime, { ...subscription, status: 'failed', client_secret: null, error: 'Insufficient funds.', total_cents: 0 }] } };
    }
    // The retry carries only the unpaid line; answering it paid proves the cart shrank.
    seen[seen.length - 1].answer = (body.lines as unknown[]).length === 1 ? 'paid-remainder' : 'paid-too-much';
    return { status: 200, body: paidResponse(cartId, [lines[1]]) };
  };
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  await press(tree, 'checkout-pay');
  assert('partial: paid order named inline, the paid line leaves the cart, the unpaid subscription stays, no pending attempt', text(tree, 'checkout-error').includes('TH-101') && text(tree, 'checkout-error').includes('Insufficient funds.') && storedLines('patient-1').length === 1 && storedLines('patient-1')[0].purchase === 'subscription' && storedPending('patient-1') === null && has(tree, 'checkout-partial-note') && routerLog.length === 0);
  await wait(20);
  await press(tree, 'checkout-pay');
  assert('the retry uses a NEW cart id and sends ONLY the unpaid line', seen.length === 2 && seen[1].cartId !== seen[0].cartId && seen[1].answer === 'paid-remainder' && routerLog.at(-1)?.target === '/order-confirmation' && storedLines('patient-1').length === 0);
  await unmount(tree);

  section('office that collects sales tax');
  routerLog.length = 0;
  script.shop = { ...script.shop, tax_enabled: true };
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines }));
  script.checkoutAttempts.clear();
  seen.length = 0;
  script.checkout = (_body, cartId) => { seen.push({ cartId, attempt: 1, answer: 'paid' }); return { status: 200, body: paidResponse(cartId, lines) }; };
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  assert('before the debounced address quote lands, the total is labelled before tax and Pay names no amount', has(tree, 'checkout-total-before-tax') && has(tree, 'checkout-tax-pending') && !has(tree, 'checkout-total'));
  await wait(400);
  const expectedTax = Math.round(expectedTotal * script.taxRate);
  const taxQuote = shopCalls().filter(call => call.path.endsWith('/cart/quote')).at(-1);
  assert('the quote carries the normalized shipping address so the server can price tax', (taxQuote?.body?.shipping_address as { postal_code?: string } | undefined)?.postal_code === '02110');
  assert('tax row and Total today reflect the server estimate; Pay names the amount due', text(tree, 'checkout-tax').includes(money(expectedTax)) && text(tree, 'checkout-total').includes(money(expectedTotal + expectedTax)) && text(tree, 'checkout-pay').includes(money(expectedTotal + expectedTax)));
  await type(tree, 'checkout-postal', '021');
  await wait(5);
  await press(tree, 'checkout-pay');
  assert('an incomplete address drops the estimate again and blocks Pay (no request)', has(tree, 'checkout-tax-pending') && !has(tree, 'checkout-total') && seen.length === 0 && has(tree, 'checkout-postal-error'));
  await type(tree, 'checkout-postal', '02110');
  await wait(400);
  script.quoteFailure = { status: 503, error: 'Couldn’t calculate sales tax for that address. Try again.' };
  await type(tree, 'checkout-line2', 'Unit 5');
  await wait(400);
  await press(tree, 'checkout-pay');
  assert('a tax estimate failure is announced and Pay stays blocked, never charging a pre-tax total', text(tree, 'checkout-quote-error').includes('sales tax') && seen.length === 0 && !has(tree, 'checkout-total'));
  script.quoteFailure = null;
  await type(tree, 'checkout-line2', 'Unit 4');
  await wait(400);
  await press(tree, 'checkout-pay');
  assert('with the estimate back, Pay goes through once', seen.length === 1 && routerLog.at(-1)?.target === '/order-confirmation');
  await unmount(tree);
  script.shop = { ...script.shop, tax_enabled: false };

  section('3DS round trip');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: [lines[0]] }));
  script.cards = { cards: [{ id: 'pm_saved', brand: 'visa', last4: '3220', exp_month: 1, exp_year: 2031, is_default: true }], default_payment_method_id: 'pm_saved' };
  script.checkoutAttempts.clear();
  seen.length = 0;
  script.checkout = (body, cartId, attempt) => {
    seen.push({ cartId, attempt, answer: attempt === 1 ? 'requires_action' : 'paid' });
    if (attempt === 1) {
      return { status: 200, body: { ...paidResponse(cartId, [lines[0]]), status: 'requires_action', items: [{ kind: 'one_time', order_id: 'o-1', order_number: 'TH-101', subscription_id: null, status: 'requires_action', client_secret: 'pi_secret_3ds', error: null, total_cents: 0, product_ids: [lines[0].product_id] }] } };
    }
    return { status: 200, body: paidResponse(cartId, [lines[0]]) };
  };
  cardScript.nextActions.length = 0;
  cardScript.handleNextAction = async () => 'succeeded';
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  await press(tree, 'checkout-pay');
  assert('requires_action hands the secret to the card SDK, re-POSTs the same cart id, and completes', cardScript.nextActions.join() === 'pi_secret_3ds' && seen.length === 2 && seen[0].cartId === seen[1].cartId && routerLog.at(-1)?.target === '/order-confirmation');
  await unmount(tree);

  section('total changed underneath the button (422) re-quotes under a new id');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: [lines[0]] }));
  script.checkoutAttempts.clear();
  seen.length = 0;
  const controlList = control.unit_price_cents;
  script.checkout = (body, cartId, attempt) => {
    seen.push({ cartId, attempt, answer: seen.length === 0 ? 'total_changed' : 'paid' });
    if (seen.length === 1) {
      // The office repriced between the quote and the tap: the server refuses the stale total with no rows behind it.
      script.shop = { ...script.shop, products: script.shop.products.map(product => product.slug === 'control' ? { ...product, unit_price_cents: controlList + 500 } : product) };
      return { status: 422, body: { error: 'Your total changed since your cart was priced. Review your cart and try again.', field: 'expected_total_due_cents' } };
    }
    return { status: 200, body: paidResponse(cartId, [lines[0]]) };
  };
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  const quotesBefore = shopCalls().filter(call => call.path.endsWith('/cart/quote')).length;
  const staleTotal = controlList * 2 + script.shop.shipping_charge_cents;
  assert('the button names the quoted total before the tap', text(tree, 'checkout-pay').includes(money(staleTotal)));
  await press(tree, 'checkout-pay');
  await wait(50);
  const repriced = staleTotal + 1000;
  assert('422 is definite: announced inline, no pending attempt, the cart is re-quoted and the button shows the NEW total', text(tree, 'checkout-error').includes('total changed') && storedPending('patient-1') === null && shopCalls().filter(call => call.path.endsWith('/cart/quote')).length === quotesBefore + 1 && text(tree, 'checkout-pay').includes(money(repriced)) && text(tree, 'checkout-total').includes(money(repriced)) && routerLog.length === 0);
  await press(tree, 'checkout-pay');
  assert('the next tap sends the NEW total under a NEW cart id', seen.length === 2 && seen[1].cartId !== seen[0].cartId && checkoutCalls().at(-1)?.body?.expected_total_due_cents === repriced && checkoutCalls().at(-2)?.body?.expected_total_due_cents === staleTotal && routerLog.at(-1)?.target === '/order-confirmation');
  await unmount(tree);
  script.shop = { ...script.shop, products: script.shop.products.map(product => product.slug === 'control' ? { ...product, unit_price_cents: controlList } : product) };

  section('server still holds a group open (requires_action, no secret)');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: [lines[0]] }));
  script.checkoutAttempts.clear();
  seen.length = 0;
  script.checkout = (_body, cartId, attempt) => {
    seen.push({ cartId, attempt, answer: attempt === 1 ? 'open' : 'paid' });
    if (attempt === 1) {
      return { status: 200, body: { ...paidResponse(cartId, [lines[0]]), status: 'requires_action', items: [{ kind: 'one_time', order_id: 'o-1', order_number: 'TH-101', subscription_id: null, status: 'requires_action', client_secret: null, error: null, total_cents: 0, product_ids: [lines[0].product_id] }] } };
    }
    return { status: 200, body: paidResponse(cartId, [lines[0]]) };
  };
  cardScript.nextActions.length = 0;
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  await press(tree, 'checkout-pay');
  assert('an open group with nothing for the device to do stays PENDING: same id kept, no 3DS, no success screen', has(tree, 'checkout-pending') && storedPending('patient-1')?.cartId === seen[0].cartId && cardScript.nextActions.length === 0 && routerLog.length === 0 && text(tree, 'checkout-error').toLowerCase().includes('bank'));
  await press(tree, 'checkout-pay');
  assert('confirming replays the same id and lands once the server settles it', seen.length === 2 && seen[1].cartId === seen[0].cartId && routerLog.at(-1)?.target === '/order-confirmation' && storedPending('patient-1') === null);
  await unmount(tree);

  section('device store failure blocks the charge');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: [lines[0]] }));
  script.checkoutAttempts.clear();
  seen.length = 0;
  script.checkout = (_body, cartId, attempt) => { seen.push({ cartId, attempt, answer: 'paid' }); return { status: 200, body: paidResponse(cartId, [lines[0]]) }; };
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  const store = (globalThis as { localStorage: { setItem: (key: string, value: string) => void } }).localStorage;
  const realSetItem = store.setItem;
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  await press(tree, 'checkout-pay');
  store.setItem = realSetItem;
  assert('if the attempt cannot be persisted, NO request is sent and the failure is explained inline', seen.length === 0 && text(tree, 'checkout-error').toLowerCase().includes('nothing was charged') && storedPending('patient-1') === null && routerLog.length === 0);
  await press(tree, 'checkout-pay');
  assert('with the store back, the same tap goes through', seen.length === 1 && routerLog.at(-1)?.target === '/order-confirmation');
  await unmount(tree);

  section('settlement is one write: paid lines never sit on disk without their replay key');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: [lines[0]] }));
  script.checkoutAttempts.clear();
  seen.length = 0;
  script.checkout = (_body, cartId, attempt) => { seen.push({ cartId, attempt, answer: 'paid' }); return { status: 200, body: paidResponse(cartId, [lines[0]]) }; };
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  // Every snapshot the screen writes during Pay, and a device that refuses the
  // settlement write (the one that would release the attempt) but not the commit.
  const snapshots: Array<{ lines: unknown[]; pending: unknown }> = [];
  const fullStore = (globalThis as { localStorage: { setItem: (key: string, value: string) => void; removeItem: (key: string) => void } }).localStorage;
  const realSet = fullStore.setItem;
  const realRemove = fullStore.removeItem;
  fullStore.setItem = (key: string, value: string) => {
    if (key === 'thinnr_cart_v1:patient-1') {
      const parsed = JSON.parse(value) as { lines: unknown[]; pending: unknown };
      snapshots.push(parsed);
      if (parsed.pending === null) throw new Error('QuotaExceededError');
    }
    realSet.call(fullStore, key, value);
  };
  fullStore.removeItem = (key: string) => {
    if (key === 'thinnr_cart_v1:patient-1') { snapshots.push({ lines: [], pending: null }); throw new Error('QuotaExceededError'); }
    realRemove.call(fullStore, key);
  };
  await press(tree, 'checkout-pay');
  await wait(20);
  fullStore.setItem = realSet;
  fullStore.removeItem = realRemove;
  const keptAttempt = storedPending('patient-1');
  assert('no snapshot ever drops the attempt while a paid line is still in it', snapshots.length >= 2 && snapshots.every(snapshot => snapshot.pending !== null || snapshot.lines.length === 0));
  assert('with the settlement write refused, the attempt stays on disk and the screen still moves on', seen.length === 1 && keptAttempt?.cartId === seen[0].cartId && routerLog.at(-1)?.target === '/order-confirmation');
  await unmount(tree);
  // Cold start on the same device: the kept attempt replays under the SAME id and settles now that the store works.
  routerLog.length = 0;
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  assert('the reload shows the frozen confirm view for the kept attempt', has(tree, 'checkout-pending') && text(tree, 'checkout-pay').includes('Confirm payment'));
  await press(tree, 'checkout-pay');
  assert('replayed under the same cart id, then settled: no attempt, no lines, confirmation shown', seen.length === 2 && seen[1].cartId === seen[0].cartId && storedPending('patient-1') === null && storedLines('patient-1').length === 0 && routerLog.at(-1)?.target === '/order-confirmation');
  await unmount(tree);

  section('account switch during card entry: nothing is sent, neither cart is touched');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines }));
  const otherLines: CartLine[] = [{ product_id: fiber.product_id, quantity: 3, purchase: 'one_time', cadence_weeks: null }];
  storageMap.set('thinnr_cart_v1:patient-2', JSON.stringify({ lines: otherLines }));
  script.cards = { cards: [], default_payment_method_id: null };
  script.checkoutAttempts.clear();
  seen.length = 0;
  script.checkout = (_body, cartId, attempt) => { seen.push({ cartId, attempt, answer: 'paid' }); return { status: 200, body: paidResponse(cartId, lines) }; };
  // The card SDK holds its sheet open until the test releases it.
  let releaseCard: (() => void) | null = null;
  cardScript.createPaymentMethod = () => new Promise(resolve => { releaseCard = () => resolve({ paymentMethodId: 'pm_switched' }); });
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  await act(async () => cardScript.setComplete(true));
  await wait(5);
  const sentBefore = checkoutCalls().length;
  await act(async () => { pressable(tree, 'checkout-pay')!.props.onPress(); await new Promise(resolve => setTimeout(resolve, 5)); });
  assert('Pay is waiting on the card sheet', cardScript.billing.at(-1)?.name === 'Pat Example' && releaseCard !== null && checkoutCalls().length === sentBefore);
  await signIn(otherSession);
  await wait(30);
  assert('the second patient\'s own cart is on screen once the account switches', hosts(tree, 'checkout-summary').length === 1 && text(tree, 'checkout-summary').includes('3 ×'));
  await act(async () => { releaseCard!(); await new Promise(resolve => setTimeout(resolve, 20)); });
  await wait(30);
  assert('the tokenized card is abandoned: no checkout request under either identity', checkoutCalls().length === sentBefore && seen.length === 0 && routerLog.length === 0);
  assert('patient-1\'s cart keeps its lines with no pending attempt; patient-2\'s cart is untouched', storedPending('patient-1') === null && storedLines('patient-1').length === 2 && storedPending('patient-2') === null && JSON.stringify(storedLines('patient-2')) === JSON.stringify(otherLines));
  assert('the abandoned attempt is announced, and the second patient can still pay', text(tree, 'checkout-error').includes('account changed') && has(tree, 'checkout-pay'));
  await unmount(tree);

  section('account switch while the server is answering: the answer settles only the first patient\'s cart');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines }));
  storageMap.set('thinnr_cart_v1:patient-2', JSON.stringify({ lines: otherLines }));
  script.cards = { cards: [{ id: 'pm_saved', brand: 'visa', last4: '3220', exp_month: 1, exp_year: 2031, is_default: true }], default_payment_method_id: 'pm_saved' };
  script.checkoutAttempts.clear();
  seen.length = 0;
  let releaseAnswer: (() => void) | null = null;
  script.checkout = (_body, cartId, attempt) => new Promise(resolve => {
    seen.push({ cartId, attempt, answer: 'paid' });
    releaseAnswer = () => resolve({ status: 200, body: paidResponse(cartId, lines) });
  });
  await signIn(session);
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  // Pay reads the session twice (tap identity, then the bearer to send under);
  // a request rail that resolved the token a third time, when the POST
  // finally leaves, would be held here and released after the switch.
  const releaseLateLookup = holdNextStubSessionLookup(2);
  await act(async () => { pressable(tree, 'checkout-pay')!.props.onPress(); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert('the request left under the FIRST patient\'s bearer and is committed on that patient\'s cart', seen.length === 1 && checkoutCalls().at(-1)?.auth === `Bearer ${session.access_token}` && storedPending('patient-1')?.cartId === seen[0].cartId);
  await signIn(otherSession);
  await act(async () => { releaseLateLookup(); await new Promise(resolve => setTimeout(resolve, 10)); });
  await wait(30);
  assert('no checkout request ever carries the second patient\'s bearer', checkoutCalls().every(call => call.auth !== `Bearer ${otherSession.access_token}`) && seen.length === 1);
  assert('the switch shows patient-2\'s cart, unlocked, while patient-1\'s answer is still out', text(tree, 'checkout-summary').includes('3 ×') && !has(tree, 'checkout-pending'));
  await act(async () => { releaseAnswer!(); await new Promise(resolve => setTimeout(resolve, 20)); });
  await wait(30);
  assert('the late paid answer settles patient-1\'s stored cart (lines gone, attempt released)', storedPending('patient-1') === null && storedLines('patient-1').length === 0);
  assert('patient-2\'s cart is untouched on disk and on screen, and no confirmation screen opens for them', JSON.stringify(storedLines('patient-2')) === JSON.stringify(otherLines) && text(tree, 'checkout-summary').includes('3 ×') && routerLog.length === 0 && !text(tree, 'checkout-error'));
  await unmount(tree);

  // Back on the first patient: their cart is empty, no replay is offered.
  await signIn(session);
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  assert('patient-1 returns to an empty cart, not a replay of the settled attempt', has(tree, 'checkout-empty') && !has(tree, 'checkout-pending'));
  await unmount(tree);
  storageMap.delete('thinnr_cart_v1:patient-2');

  section('sign-out during the session check: the tap is abandoned unsent');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines }));
  script.checkoutAttempts.clear();
  seen.length = 0;
  script.checkout = (_body, cartId, attempt) => { seen.push({ cartId, attempt, answer: 'paid' }); return { status: 200, body: paidResponse(cartId, lines) }; };
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  // Hold the bearer lookup that precedes the POST and sign out underneath it.
  const releaseLookup = holdNextStubSessionLookup(1);
  await act(async () => { pressable(tree, 'checkout-pay')!.props.onPress(); await new Promise(resolve => setTimeout(resolve, 10)); });
  await signOut();
  await act(async () => { releaseLookup(); await new Promise(resolve => setTimeout(resolve, 20)); });
  await wait(30);
  assert('nothing was sent and patient-1\'s cart holds no attempt', seen.length === 0 && storedPending('patient-1') === null && storedLines('patient-1').length === 2 && routerLog.length === 0);
  await unmount(tree);
  await signIn(session);

  section('validation and empty cart');
  routerLog.length = 0;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: [lines[0]] }));
  script.checkoutAttempts.clear();
  const before = checkoutCalls().length;
  tree = await mount(<CheckoutScreen />);
  await wait(50);
  await type(tree, 'checkout-postal', '123');
  await type(tree, 'checkout-state', 'Massachusetts');
  assert('state input caps at two uppercase letters', hosts(tree, 'checkout-state')[0]?.props.value === 'MA');
  await type(tree, 'checkout-state', 'm');
  await press(tree, 'checkout-pay');
  assert('bad ZIP/state block Pay with field errors and no request', has(tree, 'checkout-postal-error') && has(tree, 'checkout-state-error') && checkoutCalls().length === before && routerLog.length === 0);
  await unmount(tree);
  storageMap.delete('thinnr_cart_v1:patient-1');
  tree = await mount(<CheckoutScreen />);
  assert('empty cart shows the empty state instead of a form', has(tree, 'checkout-empty') && !has(tree, 'checkout-pay'));
  await unmount(tree);

  section('office unavailable');
  script.shop = { ...script.shop, available: false, unavailable_reason: 'not_connected', products: [], office: { provider_id: 'office-1', office_name: 'Harbor Health', payments_available: false } } as typeof script.shop;
  storageMap.set('thinnr_cart_v1:patient-1', JSON.stringify({ lines: [lines[0]] }));
  tree = await mount(<CheckoutScreen />);
  assert('not-connected office shows the unavailable state and no Pay', has(tree, 'checkout-unavailable') && !has(tree, 'checkout-pay'));
  await unmount(tree);

  finish();
}

main().catch(error => { console.error(error); process.exit(1); });
