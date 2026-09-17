/**
 * Payout verification: web-matched demo summary, authenticated live balances
 * and history, delayed/error states, and accessibility.
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
  section,
  setScript,
  settle,
  text,
  textOf,
} from './payments-stubs/harness';
import { setPathname } from './provider-training-stubs/expo-router';
import PayoutsScreen from '../app/(tabs)/payments/payouts';
import { DEMO_DASHBOARD } from '../data/office-payments-demo';
import { formatCents } from '../lib/office-billing-format';

const STATUS: any = { account: {}, sandbox: true, viewer: { can_manage: true }, office: {} };
const DATA = {
  balance: { available_cents: 12345, pending_cents: 6789 },
  items: [
    {
      id: 'po_1',
      stripe_payout_id: 'po_x',
      amount_cents: 9000,
      status: 'paid',
      arrival_date: '2026-10-12',
      method: 'standard',
      created_at: '2026-10-10T00:00:00Z',
    },
  ],
};

function liveScript(options?: { delayed?: boolean; error?: boolean }) {
  setScript((request) => {
    if (request.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (request.path !== '/api/billing/office/payouts') return undefined;
    if (options?.delayed) return { delay: true, body: DATA };
    if (options?.error) return { status: 400, body: { error: 'Payouts failed' } };
    return { status: 200, body: DATA };
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
  setPathname('/payments/payouts');
  section('Demo');
  resetRequests();
  liveScript();
  let mounted = await mount(<PayoutsScreen />, null);
  check(
    'demo derives balance from pinned dashboard with no fetch',
    requests.length === 0
      && text(mounted.root, 'payouts-demo').includes(formatCents(DEMO_DASHBOARD.balance.available_cents)),
  );
  check('demo has no write controls', !one(mounted.root, 'button-payout'));
  await mounted.unmount();

  section('Live');
  resetRequests();
  liveScript();
  mounted = await mount(<PayoutsScreen />, STAFF);
  const payoutRequest = requests.find((request) => request.path === '/api/billing/office/payouts');
  check(
    'payout GET has bearer and no query string',
    payoutRequest?.auth === 'Bearer staff-token' && payoutRequest.url.endsWith('/payouts'),
    payoutRequest?.url,
  );
  check(
    'balances and payout row render',
    text(mounted.root, 'payouts-available').includes('$123.45')
      && ids(mounted.root, 'row-payout-').length === 1,
  );
  check('all controls are accessible', accessible(mounted.root));
  await mounted.unmount();

  section('Loading and error retry');
  liveScript({ delayed: true });
  mounted = await mount(<PayoutsScreen />, STAFF);
  check('delayed response shows loading', !!one(mounted.root, 'payouts-loading'));
  release?.();
  await settle();
  await mounted.unmount();

  liveScript({ error: true });
  mounted = await mount(<PayoutsScreen />, STAFF);
  check('4xx message is shown', text(mounted.root, 'payouts-error').includes('Payouts failed'));
  liveScript();
  await press(mounted.root, 'payouts-error-retry');
  check('retry recovers', !!one(mounted.root, 'payouts-available'));
  await mounted.unmount();

  finish('payments-payouts');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});