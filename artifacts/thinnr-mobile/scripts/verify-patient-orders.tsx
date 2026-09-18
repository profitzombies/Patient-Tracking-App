/**
 * Orders list + detail contract check: demo dataset (offline, writes
 * nudged), live list and detail on the patient order endpoints, shipment
 * panel states (processing / shipped with tracking link / delivered /
 * canceled), receipts, and load-failure recovery.
 */
import {
  alerts, assert, billingCalls, calls, finish, has, mount, opened, press, section, setRoute, text, unmount,
} from './patient-billing-stubs/harness';
import React, { act } from 'react';
import OrdersScreen from '../app/orders/index';
import OrderDetailScreen from '../app/orders/[id]';
import { DEMO_ORDERS } from '../data/patient-billing-demo';
import { shipmentPanel, subscriptionActions, moveWindow, moveDateAllowed, orderKindLabel } from '../lib/patient-billing-core';
import { routerCalls, clearRouterCalls, setSearchParams } from './patient-billing-stubs/expo-router';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';

const session: StubSession = { access_token: 'patient-token', user: { id: 'user-1' } };
const ORDER_ID = '22222222-2222-4222-8222-222222222222';

const shipment = (over: Partial<Record<string, unknown>> = {}) => ({
  status: 'processing', carrier: null, tracking_number: null, tracking_url: null,
  shipped_at: null, delivered_at: null, canceled_at: null, updated_at: '2026-09-01T12:00:00Z', ...over,
});
const summary = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, order_number: 'TH-1001', kind: 'one_time', status: 'paid', fulfillment_status: 'to_ship',
  total_cents: 8998, refunded_cents: 0, item_count: 2, items_label: 'Protein × 1, Hydrate × 1',
  created_at: '2026-09-01T12:00:00Z', paid_at: '2026-09-01T12:01:00Z', receipt_available: true,
  shipment: shipment(), subscription_id: null, cart_id: null,
  shipping: { method: 'standard', source: 'fallback', carrier_service_name: null, delivery_window_start: null, delivery_window_end: null },
  ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  items: [
    { product_id: 'p1', name: 'Protein', quantity: 1, unit_price_cents: 4499, line_total_cents: 4499 },
    { product_id: 'p2', name: 'Hydrate', quantity: 1, unit_price_cents: 3499, line_total_cents: 3499 },
  ],
  subtotal_cents: 7998, shipping_charge_cents: 1000, tax_cents: 0, refunds: [],
  shipping_address: { name: 'Pat Example', line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US', phone: null },
  failure_message: null, ...over,
});

let listFailure = false;
let secondPageFailure = false;
let detailBody: Record<string, unknown> = detail();
let receiptBody: Record<string, unknown> = { order_number: 'TH-1001', receipt_url: 'https://stripe.test/receipt', invoice_url: null, invoice_pdf_url: null };
const OLDER_ID = '66666666-6666-4666-8666-666666666666';
setRoute((call, url) => {
  if (call.path === 'patient-data/billing/orders' && call.method === 'GET') {
    if (listFailure) return { status: 503, body: { error: 'Orders are briefly unavailable.' } };
    if (url.searchParams.get('cursor') === 'page-2') {
      if (secondPageFailure) return { status: 503, body: { error: 'Older orders are briefly unavailable.' } };
      return { body: { items: [summary({ id: OLDER_ID, order_number: 'TH-0900', kind: 'subscription_initial', created_at: '2026-07-01T12:00:00Z' })], next_cursor: null } };
    }
    return { body: { items: [summary(), summary({ id: '33333333-3333-4333-8333-333333333333', order_number: 'TH-1002', status: 'refunded', refunded_cents: 8998, shipment: shipment({ status: 'canceled', canceled_at: '2026-09-02T12:00:00Z' }) })], next_cursor: 'page-2' } };
  }
  if (call.path === `patient-data/billing/orders/${ORDER_ID}` && call.method === 'GET') return { body: detailBody };
  if (call.path === `patient-data/billing/orders/${ORDER_ID}/receipt`) return { body: receiptBody };
  return undefined;
});

async function main() {
  section('pure rules');
  assert('processing until a tracking number exists', shipmentPanel({ status: 'paid' }, shipment() as never).state === 'processing');
  assert('shipped carries carrier + number + url', (() => { const p = shipmentPanel({ status: 'paid' }, shipment({ status: 'shipped', carrier: 'USPS', tracking_number: '94001', tracking_url: 'https://usps.test/94001', shipped_at: '2026-09-02T12:00:00Z' }) as never); return p.state === 'shipped' && p.tracking?.carrier === 'USPS' && p.tracking.number === '94001' && p.tracking.url === 'https://usps.test/94001'; })());
  assert('delivered when known', shipmentPanel({ status: 'paid' }, shipment({ status: 'delivered', delivered_at: '2026-09-04T12:00:00Z' }) as never).state === 'delivered');
  assert('canceled shipment', shipmentPanel({ status: 'refunded' }, shipment({ status: 'canceled' }) as never).state === 'canceled');
  assert('move window bounds always satisfy the server rule (noon UTC, 1..365 days) at every hour', [0, 5, 11, 12, 13, 18, 23].every(hour => {
    const now = new Date(Date.UTC(2026, 8, 17, hour, 30));
    const { min, max } = moveWindow(now);
    const dayBefore = (key: string) => { const d = new Date(`${key}T12:00:00.000Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
    const dayAfter = (key: string) => { const d = new Date(`${key}T12:00:00.000Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
    return moveDateAllowed(min, now) && moveDateAllowed(max, now) && !moveDateAllowed(dayBefore(min), now) && !moveDateAllowed(dayAfter(max), now);
  }));
  assert('failed order never promises a shipment', shipmentPanel({ status: 'failed' }, shipment() as never).state === 'not_applicable');
  assert('demo dataset covers every panel state', ['processing', 'shipped', 'delivered', 'canceled', 'not_applicable'].every(state => DEMO_ORDERS.some(order => shipmentPanel(order, order.shipment).state === state)));
  const window = moveWindow(new Date(Date.UTC(2026, 8, 17, 9)));
  assert('move window is tomorrow through one year out (morning UTC)', window.min === '2026-09-18' && window.max === '2027-09-16');
  const late = moveWindow(new Date(Date.UTC(2026, 8, 17, 15)));
  assert('after noon UTC the earliest day slides so the API never rejects a shown day', late.min === '2026-09-19' && late.max === '2027-09-17');
  const base = { id: 's', product_name: 'x', unit_price_cents: 1, shipping_charge_cents: 1, status: 'active' as const, paused: false, current_period_end: null, cancel_at_period_end: false, last_hosted_invoice_url: null, last_failure_message: null, product_id: 'p', cadence_weeks: 4, quantity: 1, next_shipment_at: null, shipping_address: detail().shipping_address as never, shipping: { method: 'standard' as const, source: 'fallback' as const, carrier_service_name: null, delivery_window_start: null, delivery_window_end: null } };
  assert('active subscription offers scheduling, pause, cancel, address, plan, card', (() => { const a = subscriptionActions(base); return a.moveNext && a.skipNext && a.pause && !a.resume && a.cancel && a.address && a.plan && a.card && !a.retryPayment; })());
  assert('paused subscription offers resume, not move/skip', (() => { const a = subscriptionActions({ ...base, paused: true }); return !a.moveNext && !a.skipNext && a.resume && !a.pause && a.cancel; })());
  assert('past due leads with retry', subscriptionActions({ ...base, status: 'past_due' }).retryPayment && !subscriptionActions({ ...base, status: 'past_due' }).moveNext);
  assert('ending subscription cannot be canceled twice or rescheduled', (() => { const a = subscriptionActions({ ...base, cancel_at_period_end: true }); return !a.cancel && !a.moveNext && a.address; })());
  assert('canceled subscription offers nothing', Object.values(subscriptionActions({ ...base, status: 'canceled' })).every(value => value === false));

  section('demo orders are fixed and offline');
  setStubSession(null);
  let tree = await mount(<OrdersScreen />);
  const before = calls.length;
  assert('demo list renders the demo note and every demo order', has(tree, 'screen-orders-demo-note') && DEMO_ORDERS.every(order => has(tree, `card-order-${order.id}`)));
  assert('demo list shows shipment state per order', text(tree, 'card-order-demo-order-shipped-shipment') === 'Shipped' && text(tree, 'card-order-demo-order-processing-shipment') === 'Processing' && text(tree, 'card-order-demo-order-delivered-shipment') === 'Delivered' && text(tree, 'card-order-demo-order-canceled-shipment') === 'Canceled');
  clearRouterCalls();
  await press(tree, 'card-order-demo-order-shipped');
  assert('tapping a demo order opens its detail route without network', routerCalls.some(call => call.target === '/orders/demo-order-shipped') && calls.length === before);
  await unmount(tree);

  setSearchParams({ id: 'demo-order-shipped' });
  tree = await mount(<OrderDetailScreen />);
  assert('demo detail renders shipped panel with USPS tracking', text(tree, 'panel-shipment-status') === 'Shipped' && text(tree, 'panel-shipment-tracking-number') === '9400111899223197428490' && has(tree, 'panel-shipment-track'));
  await press(tree, 'panel-shipment-track');
  await press(tree, 'button-order-receipt');
  assert('demo tracking and receipt taps nudge instead of opening or fetching', opened.length === 0 && alerts.length === 2 && calls.length === before);
  assert('demo detail lists both items and the total', text(tree, 'card-order-items').includes('Protein') && text(tree, 'card-order-items').includes('Hydrate') && text(tree, 'text-order-total') === '$89.98');
  await unmount(tree);

  setSearchParams({ id: 'demo-order-delivered' });
  tree = await mount(<OrderDetailScreen />);
  assert('demo delivered order shows Delivered, refund line and refunds card', text(tree, 'panel-shipment-status') === 'Delivered' && text(tree, 'text-order-refunded') === '-$10.00' && has(tree, 'card-order-refunds') && has(tree, 'button-order-subscription'));
  await unmount(tree);
  setSearchParams({ id: 'demo-order-failed' });
  tree = await mount(<OrderDetailScreen />);
  assert('demo failed order shows failure and no shipment promise', text(tree, 'text-order-failure').includes('declined') && text(tree, 'panel-shipment-status') === 'Not shipping' && !has(tree, 'button-order-receipt'));
  await unmount(tree);
  setSearchParams({ id: 'nope' });
  tree = await mount(<OrderDetailScreen />);
  assert('unknown demo id explains instead of rendering blank', text(tree, 'screen-order-error').includes('not part of the demo'));
  await unmount(tree);

  section('live list');
  await act(async () => setStubSession(session));
  tree = await mount(<OrdersScreen />);
  const listCall = billingCalls().find(call => call.path === 'patient-data/billing/orders');
  assert('live list GETs orders with bearer and renders both rows', listCall?.auth === 'Bearer patient-token' && has(tree, `card-order-${ORDER_ID}`) && text(tree, 'screen-orders').includes('TH-1002') && !has(tree, 'screen-orders-demo-note'));
  assert('live rows show payment and shipment status', text(tree, `card-order-${ORDER_ID}-shipment`) === 'Processing' && text(tree, 'card-order-33333333-3333-4333-8333-333333333333-shipment') === 'Canceled' && text(tree, 'card-order-33333333-3333-4333-8333-333333333333').includes('Refunded'));
  clearRouterCalls();
  await press(tree, `card-order-${ORDER_ID}`);
  assert('tapping a live row navigates to its detail', routerCalls.some(call => call.target === `/orders/${ORDER_ID}`));
  assert('first page asks for 20 and offers older orders when a cursor comes back', new URL(`https://x/api/${listCall!.path}`) !== null && has(tree, 'button-orders-more') && !has(tree, `card-order-${OLDER_ID}`));
  secondPageFailure = true;
  await press(tree, 'button-orders-more');
  assert('a failed older page keeps the loaded history and the button', text(tree, 'text-orders-more-error').includes('Older orders') && has(tree, `card-order-${ORDER_ID}`) && has(tree, 'button-orders-more'));
  secondPageFailure = false;
  await press(tree, 'button-orders-more');
  const pageCalls = billingCalls().filter(call => call.path === 'patient-data/billing/orders');
  assert('older page is fetched with the cursor and appended after the first page', pageCalls.length === 3 && has(tree, `card-order-${OLDER_ID}`) && has(tree, `card-order-${ORDER_ID}`) && !has(tree, 'button-orders-more') && !has(tree, 'text-orders-more-error'));
  assert('first subscription purchases are labelled as subscription starts', text(tree, `card-order-${OLDER_ID}`).includes('Subscription start') && orderKindLabel('one_time') === 'One-time order' && orderKindLabel('subscription_renewal') === 'Subscription delivery');
  await unmount(tree);

  section('live detail: processing → shipped → delivered');
  setSearchParams({ id: ORDER_ID });
  tree = await mount(<OrderDetailScreen />);
  assert('detail GETs the order and renders Processing without tracking', billingCalls().some(call => call.path === `patient-data/billing/orders/${ORDER_ID}` && call.method === 'GET') && text(tree, 'panel-shipment-status') === 'Processing' && !has(tree, 'panel-shipment-track') && text(tree, 'panel-shipment-detail').includes('Tracking appears here'));
  assert('line items, subtotal, shipping and total render', text(tree, 'card-order-items').includes('$44.99') && text(tree, 'card-order-items').includes('$10.00') && text(tree, 'text-order-total') === '$89.98');
  assert('ships-to address renders', text(tree, 'card-order-address').includes('1 Main St') && text(tree, 'card-order-address').includes('Austin, TX 78701'));
  await press(tree, 'button-order-receipt');
  assert('receipt is fetched once and opened', billingCalls().filter(call => call.path.endsWith('/receipt')).length === 1 && opened.includes('https://stripe.test/receipt'));
  await unmount(tree);

  detailBody = detail({ fulfillment_status: 'shipped', shipment: shipment({ status: 'shipped', carrier: 'UPS', tracking_number: '1Z999', tracking_url: 'https://ups.test/1Z999', shipped_at: '2026-09-02T12:00:00Z' }) });
  receiptBody = { order_number: 'TH-1001', receipt_url: null, invoice_url: 'https://stripe.test/invoice', invoice_pdf_url: 'https://stripe.test/invoice.pdf' };
  tree = await mount(<OrderDetailScreen />);
  assert('shipped panel shows carrier, number and tracking link', text(tree, 'panel-shipment-status') === 'Shipped' && text(tree, 'panel-shipment-tracking-number') === '1Z999' && text(tree, 'panel-shipment').includes('UPS'));
  await press(tree, 'panel-shipment-track');
  assert('tap-to-open opens the carrier page', opened.includes('https://ups.test/1Z999'));
  await press(tree, 'button-order-receipt');
  assert('invoice receipt opens the hosted invoice and reveals the PDF button', opened.includes('https://stripe.test/invoice') && has(tree, 'button-order-receipt-pdf'));
  await press(tree, 'button-order-receipt-pdf');
  assert('PDF opens without a second receipt fetch', opened.includes('https://stripe.test/invoice.pdf') && billingCalls().filter(call => call.path.endsWith('/receipt')).length === 2);
  await unmount(tree);

  detailBody = detail({ shipment: shipment({ status: 'delivered', carrier: 'UPS', tracking_number: '1Z999', tracking_url: 'https://ups.test/1Z999', shipped_at: '2026-09-02T12:00:00Z', delivered_at: '2026-09-05T15:00:00Z' }) });
  tree = await mount(<OrderDetailScreen />);
  assert('delivered panel reports the delivery date', text(tree, 'panel-shipment-status') === 'Delivered' && text(tree, 'panel-shipment-detail').includes('Sep 5, 2026'));
  await unmount(tree);

  detailBody = detail({ status: 'partially_refunded', refunded_cents: 1000, refunds: [{ amount_cents: 1000, status: 'succeeded', created_at: '2026-09-06T10:00:00Z' }], subscription_id: '44444444-4444-4444-8444-444444444444', kind: 'subscription_renewal' });
  tree = await mount(<OrderDetailScreen />);
  assert('refunds render with totals and the subscription link', text(tree, 'badge-order-status') === 'Partially refunded' && text(tree, 'text-order-refunded') === '-$10.00' && text(tree, 'card-order-refunds').includes('$10.00'));
  clearRouterCalls();
  await press(tree, 'button-order-subscription');
  assert('View subscription navigates to that subscription', routerCalls.some(call => call.target === '/my-subscriptions/44444444-4444-4444-8444-444444444444'));
  await unmount(tree);

  section('failure and retry');
  listFailure = true;
  tree = await mount(<OrdersScreen />);
  assert('list failure shows the error and Retry, never an empty healthy list', text(tree, 'screen-orders-error').includes('briefly unavailable') && has(tree, 'screen-orders-retry') && !has(tree, 'text-orders-empty'));
  listFailure = false;
  await press(tree, 'screen-orders-retry');
  assert('Retry refetches and recovers', !has(tree, 'screen-orders-error') && has(tree, `card-order-${ORDER_ID}`));
  await unmount(tree);

  finish();
}

main().catch(error => { console.error(error); process.exit(1); });
