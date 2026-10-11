/**
 * Refreshable patient order screens: pull-to-refresh and header Refresh on
 * the orders list and order detail (last good data stays on a failed
 * re-read; a signed-out mount never fetches), plus the
 * post-checkout invalidation that re-reads a mounted orders list the
 * moment the confirmation screen appears.
 */
import {
  assert, billingCalls, calls, finish, has, hosts, mount, press, section, setRoute, settle, text, unmount,
} from './patient-billing-stubs/harness';
import React, { act } from 'react';
import OrdersScreen from '../app/orders/index';
import OrderDetailScreen from '../app/orders/[id]';
import OrderConfirmationScreen from '../app/order-confirmation';
import { invalidateBillingResources } from '../components/billing/useBillingResource';
import { setSearchParams } from './patient-billing-stubs/expo-router';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';
import { announcements } from './onboarding-gate-stubs/react-native';

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
  items: [{ product_id: 'p1', name: 'Protein', quantity: 1, unit_price_cents: 4499, line_total_cents: 4499 }],
  subtotal_cents: 7998, shipping_charge_cents: 1000, tax_cents: 0, refunds: [],
  shipping_address: { name: 'Pat Example', line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US', phone: null },
  failure_message: null, ...over,
});

let listRows: Record<string, unknown>[] = [summary()];
let listFailure = false;
let detailBody: Record<string, unknown> = detail();
let detailFailure = false;
/** When set, the next list answer resolves only once released (spinner checks). */
let hold: Promise<unknown> | null = null;
setRoute((call) => {
  if (call.path === 'patient-data/billing/orders' && call.method === 'GET') {
    if (listFailure) return { status: 503, body: { error: 'Orders are briefly unavailable.' } };
    const body = { items: listRows, next_cursor: null };
    if (hold) { const gate = hold; hold = null; return { body: gate.then(() => body) }; }
    return { body };
  }
  if (call.path === `patient-data/billing/orders/${ORDER_ID}` && call.method === 'GET') {
    if (detailFailure) return { status: 503, body: { error: 'This order is briefly unavailable.' } };
    return { body: detailBody };
  }
  return undefined;
});
const listCalls = () => billingCalls().filter(call => call.path === 'patient-data/billing/orders');
const detailCalls = () => billingCalls().filter(call => call.path === `patient-data/billing/orders/${ORDER_ID}`);
const refreshButton = (tree: Parameters<typeof hosts>[0], id: string) => hosts(tree, id).find(node => typeof node.props.onPress === 'function');
const pull = (tree: Parameters<typeof hosts>[0], id: string) => tree.root.findAll(node => node.type === 'RefreshControl' && node.props.testID === id)[0];

async function main() {
  section('live orders list: header refresh');
  await act(async () => setStubSession(session));
  let tree = await mount(<OrdersScreen />);
  assert('list loads once and shows the refresh button and pull control', listCalls().length === 1 && has(tree, `card-order-${ORDER_ID}`) && Boolean(refreshButton(tree, 'screen-orders-refresh')) && Boolean(pull(tree, 'screen-orders-pull')));
  const header = refreshButton(tree, 'screen-orders-refresh')!;
  assert('refresh button is an accessible, enabled button named for the screen', header.props.accessibilityRole === 'button' && header.props.accessibilityLabel === 'Refresh orders' && header.props.accessibilityState?.disabled === false && header.props.accessibilityState?.busy === false);
  listRows = [summary({ order_number: 'TH-1001', shipment: shipment({ status: 'shipped', carrier: 'USPS', tracking_number: '94001' }) })];
  let release!: () => void;
  hold = new Promise<void>(resolve => { release = resolve; });
  announcements.length = 0;
  await act(async () => header.props.onPress());
  await settle(2);
  assert('header refresh re-reads through our API and spins while the old rows stay', listCalls().length === 2 && has(tree, 'screen-orders-refreshing') && has(tree, `card-order-${ORDER_ID}`) && text(tree, `card-order-${ORDER_ID}-shipment`) === 'Processing' && pull(tree, 'screen-orders-pull').props.refreshing === true);
  assert('a second tap while refreshing is ignored', (() => { const busy = refreshButton(tree, 'screen-orders-refresh')!; busy.props.onPress(); return listCalls().length === 2 && busy.props.accessibilityState?.busy === true; })());
  await act(async () => { release(); });
  await settle();
  assert('fresh shipment state lands, the spinner stops and completion is announced', text(tree, `card-order-${ORDER_ID}-shipment`) === 'Shipped' && !has(tree, 'screen-orders-refreshing') && pull(tree, 'screen-orders-pull').props.refreshing === false && announcements.includes('Orders updated'));

  section('live orders list: pull-to-refresh and failure');
  listFailure = true;
  await act(async () => pull(tree, 'screen-orders-pull').props.onRefresh());
  await settle();
  assert('pull-to-refresh calls the same API path', listCalls().length === 3);
  assert('a failed refresh keeps the last good rows and shows a non-blocking notice', has(tree, `card-order-${ORDER_ID}`) && text(tree, `card-order-${ORDER_ID}-shipment`) === 'Shipped' && !has(tree, 'screen-orders-error') && !has(tree, 'screen-orders-retry') && text(tree, 'screen-orders-notice').includes("Couldn't refresh orders") && text(tree, 'screen-orders-notice').includes('briefly unavailable'));
  await press(tree, 'screen-orders-notice-dismiss');
  assert('the notice dismisses', !has(tree, 'screen-orders-notice'));
  listFailure = false;
  assert('every read went to our API only', calls.every(call => !/warehouse|novex/i.test(call.path)));

  section('post-checkout invalidation');
  listRows = [summary({ id: '77777777-7777-4777-8777-777777777777', order_number: 'TH-NEW01' }), summary()];
  const before = listCalls().length;
  setSearchParams({ orders: 'TH-NEW01', total: '8998', office: 'Beacon Hill' });
  const confirmation = await mount(<OrderConfirmationScreen />);
  assert('the confirmation screen renders the new order number', has(confirmation, 'confirmation-order-TH-NEW01'));
  assert('a paid confirmation makes the mounted orders list re-read so the new order is already there', listCalls().length === before + 1 && has(tree, 'card-order-77777777-7777-4777-8777-777777777777') && has(tree, `card-order-${ORDER_ID}`));
  await unmount(confirmation);
  setSearchParams({});
  const emptyConfirmation = await mount(<OrderConfirmationScreen />);
  assert('a confirmation without a result invalidates nothing', listCalls().length === before + 1);
  await unmount(emptyConfirmation);
  await unmount(tree);
  invalidateBillingResources(['orders']);
  assert('invalidation with nothing mounted is inert', listCalls().length === before + 1);

  section('live order detail');
  setSearchParams({ id: ORDER_ID });
  tree = await mount(<OrderDetailScreen />);
  assert('detail shows processing and a refresh button', detailCalls().length === 1 && text(tree, 'panel-shipment-status') === 'Processing' && Boolean(refreshButton(tree, 'screen-order-refresh')) && Boolean(pull(tree, 'screen-order-pull')));
  detailBody = detail({ shipment: shipment({ status: 'shipped', carrier: 'USPS', tracking_number: '9400111899', tracking_url: 'https://usps.test/9400111899', shipped_at: '2026-09-02T12:00:00Z' }) });
  announcements.length = 0;
  await press(tree, 'screen-order-refresh');
  assert('header refresh re-reads the order and shows the tracking number that arrived', detailCalls().length === 2 && text(tree, 'panel-shipment-status') === 'Shipped' && text(tree, 'panel-shipment-tracking-number') === '9400111899' && announcements.includes('Order updated'));
  detailFailure = true;
  await act(async () => pull(tree, 'screen-order-pull').props.onRefresh());
  await settle();
  assert('a failed detail refresh keeps the order on screen with a notice', detailCalls().length === 3 && text(tree, 'panel-shipment-tracking-number') === '9400111899' && !has(tree, 'screen-order-error') && text(tree, 'screen-order-notice').includes("Couldn't refresh this order"));
  detailFailure = false;
  await unmount(tree);

  section('signed out');
  await act(async () => setStubSession(null));
  const signedOutBefore = calls.length;
  tree = await mount(<OrdersScreen />);
  assert('signed-out list makes no request and renders neither rows nor a refresh control', calls.length === signedOutBefore && has(tree, 'screen-orders-loading') && tree.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('card-order-')).length === 0 && !pull(tree, 'screen-orders-pull'));
  await unmount(tree);
  setSearchParams({ id: ORDER_ID });
  tree = await mount(<OrderDetailScreen />);
  assert('signed-out detail holds the loading frame with a disabled refresh button, no pull control and no fetch', has(tree, 'screen-order-loading') && refreshButton(tree, 'screen-order-refresh')?.props.accessibilityState?.disabled === true && !pull(tree, 'screen-order-pull') && calls.length === signedOutBefore);
  await unmount(tree);

  finish();
}

main().catch(error => { console.error(error); process.exit(1); });
