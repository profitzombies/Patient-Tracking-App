/**
 * Refund/dispute ledger verification: signed-out isolation, exact range/filter/page
 * requests, delayed and retry states, links, and accessibility.
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
import RefundsScreen from '../app/(tabs)/payments/refunds';
import { SAMPLE_REFUNDS } from './fixtures/sample-office-payments';
import { rangeForPreset } from '../components/payments/range';

const STATUS: any = { account: {}, sandbox: true, viewer: { can_manage: true }, office: {} };

function liveScript(options?: { delayed?: boolean; error?: boolean }) {
  setScript((request) => {
    if (request.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (request.path !== '/api/billing/office/refunds') return undefined;
    if (options?.delayed) return { delay: true, body: { items: [], next_cursor: null } };
    if (options?.error) return { status: 400, body: { error: 'Refund list failed' } };
    return { status: 200, body: { items: SAMPLE_REFUNDS, next_cursor: null, total: 41 } };
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
  setPathname('/payments/refunds');
  setSearchParams({});
  section('Signed out');
  resetRequests();
  liveScript();
  let mounted = await mount(<RefundsScreen />, null);
  check(
    'signed-out mount holds the sign-in frame: no rows, no fetch',
    requests.length === 0 && !!one(mounted.root, 'billing-session-loading') && ids(mounted.root, 'row-refund-').length === 0,
  );
  await mounted.unmount();

  section('Live kind filters');
  setSearchParams({ kind: 'refund' });
  resetRequests();
  liveScript();
  mounted = await mount(<RefundsScreen />, STAFF);
  const range = rangeForPreset(30);
  const initial = requests.find((request) => request.path === '/api/billing/office/refunds');
  check(
    'default kind query has bearer and only supported params',
    initial?.auth === 'Bearer staff-token'
      && initial.url.endsWith(`?kind=refund&from=${range.from}&to=${range.to}`)
      && !initial.url.includes('status=')
      && !initial.url.includes('page='),
    initial?.url,
  );
  resetRequests();
  await press(mounted.root, 'filter-refunds-dispute');
  const filtered = requests.find((request) => request.path === '/api/billing/office/refunds');
  check(
    'kind chip sends exact kind/from/to query',
    filtered?.url.endsWith(`?kind=dispute&from=${range.from}&to=${range.to}`),
    filtered?.url,
  );
  resetRequests();
  await press(mounted.root, 'filter-refunds-');
  const all = requests.find((request) => request.path === '/api/billing/office/refunds');
  check(
    'All sends only from/to',
    all?.url.endsWith(`?from=${range.from}&to=${range.to}`)
      && !all.url.includes('kind=')
      && !all.url.includes('status=')
      && !all.url.includes('page='),
    all?.url,
  );
  check('refunds never render paging controls', !one(mounted.root, 'refunds-load-more'));
  check('all controls are accessible', accessible(mounted.root));
  await mounted.unmount();

  section('Loading and error retry');
  setSearchParams({});
  liveScript({ delayed: true });
  mounted = await mount(<RefundsScreen />, STAFF);
  check('delayed response shows loading', !!one(mounted.root, 'refunds-loading'));
  release?.();
  await settle();
  await mounted.unmount();

  liveScript({ error: true });
  mounted = await mount(<RefundsScreen />, STAFF);
  check('4xx message is shown', text(mounted.root, 'refunds-error').includes('Refund list failed'));
  liveScript();
  await press(mounted.root, 'refunds-error-retry');
  check('retry recovers', ids(mounted.root, 'row-refund-').length === SAMPLE_REFUNDS.length);
  await mounted.unmount();

  finish('payments-refunds');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});