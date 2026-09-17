/**
 * Fulfillment queue verification: pinned read-only demo, exact status queries,
 * delayed/error states, order navigation and accessibility.
 */
import React from 'react';
import {
  STAFF,
  check,
  finish,
  ids,
  mount,
  one,
  press,
  release,
  requests,
  resetRequests,
  routerLog,
  section,
  setScript,
  settle,
  text,
  textOf,
} from './payments-stubs/harness';
import { setPathname, setSearchParams } from './provider-training-stubs/expo-router';
import FulfillmentScreen from '../app/(tabs)/payments/fulfillment';
import { DEMO_FULFILLMENT } from '../data/office-payments-demo';

const STATUS: any = { account: {}, sandbox: true, viewer: { can_manage: true }, office: {} };

function liveScript(options?: { delayed?: boolean; error?: boolean }) {
  setScript((request, url) => {
    if (request.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (request.path !== '/api/billing/office/fulfillment') return undefined;
    if (options?.delayed) return { delay: true, body: { items: [], next_cursor: null } };
    if (options?.error) return { status: 400, body: { error: 'Queue unavailable' } };
    const status = url.searchParams.get('status') ?? 'to_ship';
    const matching = DEMO_FULFILLMENT.filter((order) => order.fulfillment_status === status);
    if (url.searchParams.get('cursor')) {
      const source = matching[0] ?? DEMO_FULFILLMENT[0];
      return {
        status: 200,
        body: {
          items: source ? [{ ...source, id: `${source.id}-next`, order_number: `${source.order_number}-NEXT` }] : [],
          next_cursor: null,
        },
      };
    }
    return {
      status: 200,
      body: {
        items: matching.slice(0, 1),
        next_cursor: 'fulfillment-next',
      },
    };
  });
}

function accessible(root: any): boolean {
  return root.findAll((node: any) => (
    node.type === 'Pressable'
    && typeof node.props.onPress === 'function'
    && (
      !node.props.accessibilityRole
      || (!node.props.accessibilityLabel && !textOf(node).trim())
    )
  )).length === 0;
}

async function main() {
  setPathname('/payments/fulfillment');
  setSearchParams({});
  section('Demo');
  resetRequests();
  liveScript();
  let mounted = await mount(<FulfillmentScreen />, null);
  const waiting = DEMO_FULFILLMENT.filter((order) => order.fulfillment_status === 'to_ship');
  check(
    'pinned waiting rows and no fetch',
    requests.length === 0 && ids(mounted.root, 'link-fulfillment-order-').length === waiting.length,
  );
  check('demo has no write controls', !one(mounted.root, 'button-mark-shipped'));
  await press(mounted.root, 'filter-fulfillment-shipped');
  const shipped = DEMO_FULFILLMENT.filter((order) => order.fulfillment_status === 'shipped');
  check('demo stage filters locally', ids(mounted.root, 'link-fulfillment-order-').length === shipped.length);
  await mounted.unmount();

  section('Live status filters');
  resetRequests();
  liveScript();
  mounted = await mount(<FulfillmentScreen />, STAFF);
  const initial = requests.find((request) => request.path === '/api/billing/office/fulfillment');
  check(
    'initial query is exact and authenticated',
    initial?.auth === 'Bearer staff-token' && initial.url.endsWith('?status=to_ship'),
    initial?.url,
  );
  resetRequests();
  await press(mounted.root, 'fulfillment-load-more');
  const more = requests.find((request) => request.path === '/api/billing/office/fulfillment');
  const rowIds = ids(mounted.root, 'link-fulfillment-order-');
  check(
    'load more sends opaque cursor and appends without duplicates',
    more?.url.endsWith('?status=to_ship&cursor=fulfillment-next')
      && rowIds.length === 2
      && new Set(rowIds).size === rowIds.length,
    more?.url,
  );
  check('load more hides when next cursor is null', !one(mounted.root, 'fulfillment-load-more'));
  resetRequests();
  await press(mounted.root, 'filter-fulfillment-shipped');
  const filtered = requests.find((request) => request.path === '/api/billing/office/fulfillment');
  check('stage chip sends exact status', filtered?.url.endsWith('?status=shipped'), filtered?.url);
  const link = ids(mounted.root, 'link-fulfillment-order-')[0];
  await press(mounted.root, link);
  check('order link opens detail', routerLog.some((call) => call.target.includes('/payments/transactions/')));
  check('all controls are accessible', accessible(mounted.root));
  await mounted.unmount();

  section('Loading and error retry');
  liveScript({ delayed: true });
  mounted = await mount(<FulfillmentScreen />, STAFF);
  check('delayed queue shows loading', !!one(mounted.root, 'fulfillment-loading'));
  release?.();
  await settle();
  await mounted.unmount();

  liveScript({ error: true });
  mounted = await mount(<FulfillmentScreen />, STAFF);
  check('4xx message is shown', text(mounted.root, 'fulfillment-error').includes('Queue unavailable'));
  liveScript();
  await press(mounted.root, 'fulfillment-error-retry');
  check('retry recovers', !!one(mounted.root, 'fulfillment-list'));
  await mounted.unmount();

  finish('payments-fulfillment');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});