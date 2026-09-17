/**
 * Payment activity verification: demo isolation, exact live filters and
 * cursor paging, loading/error recovery, and accessible controls.
 */
import React from 'react';
import {
  STAFF,
  check,
  finish,
  ids,
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
} from './payments-stubs/harness';
import { setPathname } from './provider-training-stubs/expo-router';
import ActivityScreen from '../app/(tabs)/payments/activity';
import { DEMO_ACTIVITY } from '../data/office-payments-demo';
import { rangeForPreset } from '../components/payments/range';

const STATUS: any = {
  account: {},
  sandbox: true,
  viewer: { can_manage: true },
  office: { office_name: 'Office' },
};

function liveScript(options?: { delayed?: boolean; error?: boolean }) {
  setScript((request, url) => {
    if (request.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (request.path !== '/api/billing/office/activity') return undefined;
    if (options?.delayed) return { delay: true, body: { items: [], next_cursor: null } };
    if (options?.error) return { status: 400, body: { error: 'Activity unavailable' } };
    const cursor = url.searchParams.get('cursor');
    return {
      status: 200,
      body: {
        items: cursor ? DEMO_ACTIVITY.slice(2, 3) : DEMO_ACTIVITY.slice(0, 2),
        next_cursor: cursor ? null : 'next',
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
  section('Demo');
  resetRequests();
  liveScript();
  let mounted = await mount(<ActivityScreen />, null);
  check(
    'pinned demo rows and no fetch',
    requests.length === 0 && ids(mounted.root, 'row-activity-').length === DEMO_ACTIVITY.length,
  );
  await press(mounted.root, 'filter-activity-refund');
  check('demo filter is client-side', ids(mounted.root, 'row-activity-').length === 1);
  check('demo has no write control', !one(mounted.root, 'button-activity-more'));
  await mounted.unmount();

  section('Live filters and cursor page');
  setPathname('/payments/activity');
  resetRequests();
  liveScript();
  mounted = await mount(<ActivityScreen />, STAFF);
  const range = rangeForPreset(30);
  const first = requests.find((request) => request.path === '/api/billing/office/activity');
  check(
    'initial query has bearer and exact range',
    first?.auth === 'Bearer staff-token'
      && first.url.includes(`from=${range.from}`)
      && first.url.includes(`to=${range.to}`)
      && !first.url.includes('kind='),
    first?.url,
  );
  resetRequests();
  await press(mounted.root, 'filter-activity-refund');
  const filtered = requests.find((request) => request.path === '/api/billing/office/activity');
  check('kind chip sends kind=refund', filtered?.url.includes('kind=refund'), filtered?.url);
  resetRequests();
  await press(mounted.root, 'button-activity-more');
  const more = requests.find((request) => request.path === '/api/billing/office/activity');
  check('load more sends next cursor', more?.url.includes('cursor=next'), paths().join(' | '));
  check('next page appends rows', ids(mounted.root, 'row-activity-').length === 3);
  check('all interactive controls are named', accessible(mounted.root));
  await mounted.unmount();

  section('Loading and error retry');
  liveScript({ delayed: true });
  mounted = await mount(<ActivityScreen />, STAFF);
  check('delayed response shows loading', !!one(mounted.root, 'activity-loading'));
  release?.();
  await settle();
  await mounted.unmount();

  liveScript({ error: true });
  mounted = await mount(<ActivityScreen />, STAFF);
  check('4xx message is announced', text(mounted.root, 'activity-error').includes('Activity unavailable'));
  liveScript();
  await press(mounted.root, 'activity-error-retry');
  check('retry recovers', !!one(mounted.root, 'activity-list'));
  await mounted.unmount();

  finish('payments-activity');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});