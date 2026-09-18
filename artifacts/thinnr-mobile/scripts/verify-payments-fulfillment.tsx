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

  section('Warehouse state (read-only on the phone)');
  resetRequests();
  const base = DEMO_FULFILLMENT.find((order) => order.fulfillment_status === 'to_ship')!;
  const sent = { state: 'sent', warehouse_order_id: '1436188', warehouse_status: 'Imported', sent_at: '2026-10-11T14:04:00Z', error: null, attempts: 1, next_attempt_at: null, last_attempt_at: '2026-10-11T14:04:00Z' };
  const rejected = { ...sent, state: 'needs_attention', warehouse_order_id: null, warehouse_status: null, sent_at: null, error: 'ItemSKU not recognized: CONTROL-OLD' };
  const queued = { ...sent, state: 'pending', warehouse_order_id: null, warehouse_status: null, sent_at: null, attempts: 0, last_attempt_at: null, next_attempt_at: '2026-10-11T14:06:00Z' };
  const rows = [['w1', sent], ['w2', rejected], ['w3', queued], ['w4', null]] as const;
  setScript((request) => {
    if (request.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (request.path !== '/api/billing/office/fulfillment') return undefined;
    return { status: 200, body: { items: rows.map(([id, warehouse]) => ({ ...base, id, order_number: `TH-${id.toUpperCase()}`, warehouse })), next_cursor: null } };
  });
  mounted = await mount(<FulfillmentScreen />, STAFF);
  const line = (id: string) => text(mounted.root, `text-warehouse-${id}`);
  // The pill renders its label uppercased, so compare case-insensitively.
  const pill = (id: string) => (one(mounted.root, `pill-warehouse-${id}`) ? textOf(one(mounted.root, `pill-warehouse-${id}`)!).toLowerCase() : '');
  check('sent order shows the warehouse id and timestamp', line('w1').includes('Sent to the warehouse') && line('w1').includes('warehouse order 1436188') && pill('w1').includes('sent to warehouse'), `${line('w1')} | ${pill('w1')}`);
  check('rejected order reads needs attention with HQ handling it, never the raw error', pill('w2').includes('needs attention') && line('w2').includes('THINNR HQ is fixing it') && !JSON.stringify(mounted.renderer.toJSON()).includes('CONTROL-OLD'), `${line('w2')} | ${pill('w2')}`);
  check('queued order reads sending; pre-warehouse orders keep the plain waiting line', pill('w3').includes('sending to warehouse') && line('w3').includes('Waiting for THINNR') && line('w4').includes('Waiting for THINNR') && !one(mounted.root, 'pill-warehouse-w4'), `${line('w3')} | ${line('w4')}`);
  check('no retry control on the phone', mounted.root.findAll((node: any) => node.type === 'Pressable' && /retry/i.test(textOf(node))).length === 0);
  check('warehouse rows stay accessible', accessible(mounted.root));
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