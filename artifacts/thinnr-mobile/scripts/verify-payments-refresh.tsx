/**
 * Refreshable office payments screens: header Refresh + pull-to-refresh on
 * transactions, fulfillment and the transaction detail. A refresh re-reads
 * every active office-billing query through our API, a failed re-read keeps
 * the last loaded data behind a dismissable notice, and a signed-out mount
 * never fetches or renders rows.
 */
import React, { act } from 'react';
import {
  STAFF, check, finish, ids, isBlocked, mount, one, press, release, requests, resetRequests, section, setScript, settle, textOf,
} from './payments-stubs/harness';
import { setPathname, setSearchParams } from './provider-training-stubs/expo-router';
import { announcements } from './onboarding-gate-stubs/react-native';
import TransactionsScreen from '../app/(tabs)/payments/transactions/index';
import DetailScreen from '../app/(tabs)/payments/transactions/[orderId]';
import FulfillmentScreen from '../app/(tabs)/payments/fulfillment';
import { SAMPLE_FULFILLMENT, SAMPLE_ORDER_DETAILS, SAMPLE_ORDERS } from './fixtures/sample-office-payments';

const STATUS: any = { account: {}, sandbox: true, viewer: { can_manage: true }, office: {} };

let ordersBody: unknown = { items: SAMPLE_ORDERS.slice(0, 2), next_cursor: null };
let ordersFailure = false;
let ordersDelay = false;
let detailBody: unknown = { ...SAMPLE_ORDER_DETAILS['demo-order-1'], tracking_number: null, carrier: null };
let fulfillmentBody: unknown = { items: SAMPLE_FULFILLMENT.filter((order) => order.fulfillment_status === 'to_ship'), next_cursor: null };
let fulfillmentFailure = false;

setScript((request) => {
  if (request.path === '/api/billing/office/status') return { status: 200, body: STATUS };
  if (request.path === '/api/billing/office/orders') {
    if (ordersFailure) return { status: 503, body: { error: 'Orders are briefly unavailable.' } };
    if (ordersDelay) { ordersDelay = false; return { delay: true, body: ordersBody }; }
    return { status: 200, body: ordersBody };
  }
  if (request.path === '/api/billing/office/orders/demo-order-1' && request.method === 'GET') return { status: 200, body: detailBody };
  if (request.path === '/api/billing/office/fulfillment') {
    if (fulfillmentFailure) return { status: 503, body: { error: 'Queue unavailable.' } };
    return { status: 200, body: fulfillmentBody };
  }
  return undefined;
});

const byPath = (path: string) => requests.filter((request) => request.path === path);
const pull = (root: any) => root.findAll((node: any) => node.type === 'RefreshControl' && node.props.testID === 'payments-pull-refresh')[0];
const spinning = (root: any) => {
  const button = one(root, 'payments-refresh');
  return Boolean(button) && button!.props.accessibilityState?.busy === true && button!.findAll((node: any) => node.type === 'ActivityIndicator').length === 1;
};

async function main() {
  section('Transactions: header refresh');
  setPathname('/payments/transactions');
  setSearchParams({});
  resetRequests();
  let mounted = await mount(<TransactionsScreen />, STAFF);
  check('live list loads once with the header Refresh and pull control', byPath('/api/billing/office/orders').length === 1 && ids(mounted.root, 'row-order-').length === 2 && !!one(mounted.root, 'payments-refresh') && !!pull(mounted.root));
  const button = one(mounted.root, 'payments-refresh')!;
  check('Refresh is an accessible button named for the screen', button.props.accessibilityRole === 'button' && button.props.accessibilityLabel === 'Refresh transactions' && !isBlocked(mounted.root, 'payments-refresh'));
  ordersBody = { items: SAMPLE_ORDERS.slice(0, 3), next_cursor: null };
  ordersDelay = true;
  announcements.length = 0;
  await act(async () => { button.props.onPress(); });
  await settle(2);
  check('Refresh re-reads orders through our API and spins while the old rows stay', byPath('/api/billing/office/orders').length === 2 && spinning(mounted.root) && pull(mounted.root).props.refreshing === true && ids(mounted.root, 'row-order-').length === 2);
  check('a second tap while refreshing is ignored', isBlocked(mounted.root, 'payments-refresh') && (one(mounted.root, 'payments-refresh')!.props.onPress(), byPath('/api/billing/office/orders').length === 2));
  await act(async () => { release?.(); });
  await settle();
  check('fresh rows land, the spinner stops, completion is announced', ids(mounted.root, 'row-order-').length === 3 && !spinning(mounted.root) && pull(mounted.root).props.refreshing === false && announcements.includes('Transactions updated') && !one(mounted.root, 'payments-refresh-notice'));
  check('the status read was refreshed alongside the list', byPath('/api/billing/office/status').length === 2);

  section('Transactions: pull-to-refresh failure keeps data');
  ordersFailure = true;
  announcements.length = 0;
  await act(async () => { pull(mounted.root).props.onRefresh(); });
  await settle();
  // The office billing hooks retry a transient failure twice (see billingRetry), so one failed refresh is three attempts.
  check('pull-to-refresh hits the same API path (with the transient retries)', byPath('/api/billing/office/orders').length === 5, JSON.stringify(requests.map((r) => r.path)));
  const notice = one(mounted.root, 'payments-refresh-notice');
  check('a failed refresh keeps the rows, shows a notice and announces it', ids(mounted.root, 'row-order-').length === 3 && !one(mounted.root, 'transactions-error') && !!notice && textOf(notice).includes("Couldn't refresh transactions") && textOf(notice).includes('briefly unavailable') && textOf(notice).includes('last loaded data') && announcements.some((line) => line.includes("Couldn't refresh transactions")));
  await press(mounted.root, 'payments-refresh-notice-dismiss');
  check('the notice dismisses', !one(mounted.root, 'payments-refresh-notice'));
  ordersFailure = false;
  await press(mounted.root, 'payments-refresh');
  check('a later refresh clears the error state without a notice', !one(mounted.root, 'payments-refresh-notice') && ids(mounted.root, 'row-order-').length === 3);
  check('no client request ever left our API', requests.every((request) => request.path.startsWith('/api/')));
  await mounted.unmount();

  section('Transaction detail');
  setSearchParams({ orderId: 'demo-order-1' });
  resetRequests();
  mounted = await mount(<DetailScreen />, STAFF);
  check('detail loads once with Refresh named for the transaction', byPath('/api/billing/office/orders/demo-order-1').length === 1 && one(mounted.root, 'payments-refresh')?.props.accessibilityLabel === 'Refresh this transaction' && !textOf(mounted.root).includes('USPS · 9400111899'));
  detailBody = { ...SAMPLE_ORDER_DETAILS['demo-order-1'], tracking_number: '9400111899', carrier: 'USPS' };
  await press(mounted.root, 'payments-refresh');
  check('detail refresh re-reads the order and shows the tracking number that arrived', byPath('/api/billing/office/orders/demo-order-1').length === 2 && textOf(mounted.root).includes('USPS · 9400111899'));
  await mounted.unmount();

  section('Fulfillment');
  setPathname('/payments/fulfillment');
  setSearchParams({});
  resetRequests();
  mounted = await mount(<FulfillmentScreen />, STAFF);
  const queueBefore = ids(mounted.root, 'link-fulfillment-order-').length;
  check('fulfillment loads once with Refresh and pull control', byPath('/api/billing/office/fulfillment').length === 1 && queueBefore > 0 && one(mounted.root, 'payments-refresh')?.props.accessibilityLabel === 'Refresh fulfillment' && !!pull(mounted.root));
  fulfillmentFailure = true;
  await act(async () => { pull(mounted.root).props.onRefresh(); });
  await settle();
  check('a failed fulfillment refresh keeps the queue behind a notice', byPath('/api/billing/office/fulfillment').length === 4 && ids(mounted.root, 'link-fulfillment-order-').length === queueBefore && !one(mounted.root, 'fulfillment-error') && textOf(one(mounted.root, 'payments-refresh-notice')!).includes("Couldn't refresh fulfillment"));
  fulfillmentFailure = false;
  fulfillmentBody = { items: [], next_cursor: null };
  await press(mounted.root, 'payments-refresh');
  check('a successful refresh replaces the queue with the fresh answer', byPath('/api/billing/office/fulfillment').length === 5 && ids(mounted.root, 'link-fulfillment-order-').length === 0 && !!one(mounted.root, 'fulfillment-empty'));
  await mounted.unmount();

  section('Signed out');
  for (const [Screen, params, path] of [[TransactionsScreen, {}, '/payments/transactions'], [DetailScreen, { orderId: 'demo-order-1' }, '/payments/transactions/demo-order-1'], [FulfillmentScreen, {}, '/payments/fulfillment']] as const) {
    setPathname(path);
    setSearchParams(params as Record<string, string>);
    resetRequests();
    mounted = await mount(<Screen />, null);
    check(`signed-out ${path} holds the sign-in frame with no fetch and no rows`, requests.length === 0 && !!one(mounted.root, 'billing-session-loading') && ids(mounted.root, 'row-order-').length === 0 && ids(mounted.root, 'link-fulfillment-order-').length === 0);
    await mounted.unmount();
  }

  finish('payments-refresh');
}

main().catch((error) => { console.error(error); process.exit(1); });
