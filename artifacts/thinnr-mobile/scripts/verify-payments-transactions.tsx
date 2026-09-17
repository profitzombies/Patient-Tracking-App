/**
 * Transactions list/detail/refund verification, including exact filters and
 * pages, delayed states, refund validation, wire bodies and accessibility.
 */
import React from 'react';
import {
  STAFF,
  check,
  finish,
  ids,
  isBlocked,
  mount,
  one,
  paths,
  press,
  release,
  requests,
  resetRequests,
  section,
  setScript,
  settle,
  text,
  textOf,
  type,
  writes,
} from './payments-stubs/harness';
import { setPathname, setSearchParams } from './provider-training-stubs/expo-router';
import TransactionsScreen from '../app/(tabs)/payments/transactions/index';
import DetailScreen from '../app/(tabs)/payments/transactions/[orderId]';
import { DEMO_ORDER_DETAILS, DEMO_ORDERS } from '../data/office-payments-demo';
import { rangeForPreset } from '../components/payments/range';

const STATUS: any = {
  account: {},
  sandbox: true,
  viewer: { can_manage: true },
  office: {},
};

interface ScriptOptions {
  listDelay?: boolean;
  listError?: boolean;
  detailDelay?: boolean;
  writeDelay?: boolean;
  writeError?: boolean;
}

function liveScript(options: ScriptOptions = {}) {
  setScript((request, url) => {
    if (request.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (request.path === '/api/billing/office/orders') {
      if (options.listDelay) return { delay: true, body: { items: [], next_cursor: null } };
      if (options.listError) return { status: 400, body: { error: 'Orders unavailable' } };
      if (url.searchParams.get('cursor')) {
        return { status: 200, body: { items: DEMO_ORDERS.slice(2), next_cursor: null } };
      }
      return { status: 200, body: { items: DEMO_ORDERS.slice(0, 2), next_cursor: 'orders-next' } };
    }
    if (request.path === '/api/billing/office/orders/demo-order-1' && request.method === 'GET') {
      if (options.detailDelay) return { delay: true, body: DEMO_ORDER_DETAILS['demo-order-1'] };
      return { status: 200, body: DEMO_ORDER_DETAILS['demo-order-1'] };
    }
    if (request.path === '/api/billing/office/orders/demo-order-1/refund') {
      if (options.writeDelay) return { delay: true, body: {} };
      if (options.writeError) return { status: 422, body: { error: 'Refund declined' } };
      return { status: 200, body: {} };
    }
    return undefined;
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

async function openPreparedRefund(root: any) {
  await press(root, 'button-refund-open');
  await type(root, 'input-refund-reason', 'Patient request');
  await press(root, 'checkbox-refund-acknowledge');
}

async function main() {
  section('Demo list and detail');
  setPathname('/payments/transactions');
  setSearchParams({});
  resetRequests();
  liveScript();
  let mounted = await mount(<TransactionsScreen />, null);
  check(
    'pinned demo rows and no fetch',
    requests.length === 0 && ids(mounted.root, 'row-order-').length === DEMO_ORDERS.length,
  );
  await press(mounted.root, 'filter-transactions-status-paid');
  check('demo status filter is local', ids(mounted.root, 'row-order-').length === 1);
  await mounted.unmount();

  setSearchParams({ orderId: 'demo-order-1' });
  resetRequests();
  mounted = await mount(<DetailScreen />, null);
  check('demo detail uses pinned data with no fetch', requests.length === 0 && !!one(mounted.root, 'billing-fee-breakdown'));
  check('demo Refund is blocked', isBlocked(mounted.root, 'button-refund-open'));
  await press(mounted.root, 'button-refund-open');
  check('pressing blocked demo Refund does not open sheet', !one(mounted.root, 'refund-sheet'));
  check('demo detail controls are accessible', accessible(mounted.root));
  await mounted.unmount();

  section('Live list filters and cursor paging');
  setSearchParams({ status: 'paid' });
  resetRequests();
  liveScript();
  mounted = await mount(<TransactionsScreen />, STAFF);
  const initial = requests.find((request) => request.path === '/api/billing/office/orders');
  const range = rangeForPreset(30);
  const initialQuery = `?status=paid&from=${range.from}&to=${range.to}&limit=50`;
  check(
    'default status and range query are exact',
    initial?.auth === 'Bearer staff-token'
      && initial.url.endsWith(initialQuery)
      && !initial.url.includes('page=')
      && !initial.url.includes('kind='),
    initial?.url,
  );
  resetRequests();
  await press(mounted.root, 'filter-transactions-status-refunded');
  const status = requests.find((request) => request.path === '/api/billing/office/orders');
  check(
    'status chip sends only supported filters',
    status?.url.endsWith(`?status=refunded&from=${range.from}&to=${range.to}&limit=50`)
      && !status.url.includes('page=')
      && !status.url.includes('kind='),
    status?.url,
  );
  resetRequests();
  await type(mounted.root, 'input-transactions-search', 'Maya');
  const search = requests.find((request) => request.path === '/api/billing/office/orders');
  check(
    'search query is exact',
    search?.url.endsWith(`?status=refunded&q=Maya&from=${range.from}&to=${range.to}&limit=50`),
    search?.url,
  );
  resetRequests();
  await press(mounted.root, 'transactions-load-more');
  const page = requests.find((request) => request.path === '/api/billing/office/orders');
  check(
    'load more sends opaque cursor and appends without duplicates',
    page?.url.endsWith(
      `?status=refunded&q=Maya&from=${range.from}&to=${range.to}&limit=50&cursor=orders-next`,
    )
      && new Set(ids(mounted.root, 'row-order-')).size === ids(mounted.root, 'row-order-').length,
    paths().join(' | '),
  );
  check('load more hides when next cursor is null', !one(mounted.root, 'transactions-load-more'));
  check('live list controls are accessible', accessible(mounted.root));
  await mounted.unmount();

  section('List loading and error retry');
  setSearchParams({});
  liveScript({ listDelay: true });
  mounted = await mount(<TransactionsScreen />, STAFF);
  check('delayed list shows loading', !!one(mounted.root, 'transactions-loading'));
  release?.();
  await settle();
  await mounted.unmount();

  liveScript({ listError: true });
  mounted = await mount(<TransactionsScreen />, STAFF);
  check('list 4xx message is shown', text(mounted.root, 'transactions-error').includes('Orders unavailable'));
  liveScript();
  await press(mounted.root, 'transactions-error-retry');
  check('list retry recovers', ids(mounted.root, 'row-order-').length > 0);
  await mounted.unmount();

  section('Detail loading');
  setSearchParams({ orderId: 'demo-order-1' });
  liveScript({ detailDelay: true });
  mounted = await mount(<DetailScreen />, STAFF);
  check('delayed detail shows loading', !!one(mounted.root, 'transaction-loading'));
  release?.();
  await settle();
  await mounted.unmount();

  section('Refund validation');
  resetRequests();
  liveScript();
  mounted = await mount(<DetailScreen />, STAFF);
  await openPreparedRefund(mounted.root);
  const acknowledgement = one(mounted.root, 'checkbox-refund-acknowledge');
  check(
    'acknowledgement quotes exact full amount',
    String(acknowledgement?.props.accessibilityLabel).includes('$79.99'),
  );
  resetRequests();
  await type(mounted.root, 'input-refund-amount', '100.00');
  await press(mounted.root, 'button-refund-confirm');
  check(
    'over-refundable amount is blocked client-side',
    writes().length === 0 && !!one(mounted.root, 'refund-over-max'),
  );
  await type(mounted.root, 'input-refund-amount', 'not money');
  await press(mounted.root, 'button-refund-confirm');
  check(
    'non-numeric amount is blocked client-side',
    writes().length === 0 && text(mounted.root, 'refund-error').includes('Use dollars and cents'),
  );
  await mounted.unmount();

  section('Full and partial refund bodies');
  resetRequests();
  liveScript();
  mounted = await mount(<DetailScreen />, STAFF);
  await openPreparedRefund(mounted.root);
  await press(mounted.root, 'select-refund-preset-remaining');
  await press(mounted.root, 'button-refund-confirm');
  await settle();
  let write = writes()[0];
  check(
    'full refund sends exact method, path and JSON',
    write?.method === 'POST'
      && write.path === '/api/billing/office/orders/demo-order-1/refund'
      && JSON.stringify(write.body) === JSON.stringify({ amount_cents: 7999, reason: 'Patient request' }),
    JSON.stringify(write),
  );
  check('full refund success notice', text(mounted.root, 'refund-success').includes('$79.99'));
  resetRequests();
  await openPreparedRefund(mounted.root);
  await type(mounted.root, 'input-refund-amount', '10.00');
  await press(mounted.root, 'button-refund-confirm');
  await settle();
  write = writes()[0];
  check(
    'partial refund sends exact amount',
    JSON.stringify(write?.body) === JSON.stringify({ amount_cents: 1000, reason: 'Patient request' }),
    JSON.stringify(write),
  );
  await mounted.unmount();

  section('Refund busy and failure');
  resetRequests();
  liveScript({ writeDelay: true });
  mounted = await mount(<DetailScreen />, STAFF);
  await openPreparedRefund(mounted.root);
  await press(mounted.root, 'button-refund-confirm');
  check('refund button is busy and blocked during write', isBlocked(mounted.root, 'button-refund-confirm'));
  release?.();
  await settle();
  await mounted.unmount();

  liveScript({ writeError: true });
  mounted = await mount(<DetailScreen />, STAFF);
  await openPreparedRefund(mounted.root);
  await press(mounted.root, 'button-refund-confirm');
  await settle();
  check('refund 4xx message is shown', text(mounted.root, 'refund-error').includes('Refund declined'));
  check('refund sheet controls are accessible', accessible(mounted.root));
  await mounted.unmount();

  finish('payments-transactions');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});