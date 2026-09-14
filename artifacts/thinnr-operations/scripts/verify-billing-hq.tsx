import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import {
  PaymentProviderDetail, PaymentTransactionDetail, PaymentsCatalog, PaymentsFulfillment, PaymentsOverview,
  PaymentsProviders, PaymentsTransactions,
} from '../src/pages/admin/payments/HqPaymentsPages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).window ??= {};
(globalThis as any).window.getSelection ??= () => ({ toString: () => '' });
let fetches = 0;
globalThis.fetch = async () => { fetches += 1; throw new Error('Demo pages must not fetch'); };
__setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });

let failures = 0;
async function check(name: string, path: string, Page: React.ComponentType, expected: string[]) {
  const location = memoryLocation({ path });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><Router hook={location.hook}><Route path="/admin/payments" nest><Page /></Route></Router></QueryClientProvider>);
  });
  const text = JSON.stringify(renderer!.toJSON());
  // The area is `nest`-mounted at /admin/payments, so every rendered link must
  // resolve under that base (never /admin/payments/admin/payments/...).
  const hrefs = renderer!.root.findAll(node => node.type === 'a' && typeof node.props.href === 'string').map(node => node.props.href as string);
  const badHref = hrefs.find(href => !href.startsWith('/admin/payments') || href.includes('/admin/payments/admin/'));
  if (badHref) { failures += 1; console.error(`FAIL ${name}: link escapes the nested base: ${badHref}`); }
  const passed = expected.every(value => text.includes(value));
  if (!passed) { failures += 1; console.error(`FAIL ${name}: missing ${expected.filter(value => !text.includes(value)).join(', ')}`); }
  else console.log(`ok ${name}`);
  await act(async () => { renderer!.unmount(); });
}

await check('overview demo', '/admin/payments', PaymentsOverview, ['Live payments appear here once HQ is signed in', 'Jenkins Wellness']);
await check('providers demo rows', '/admin/payments/providers', PaymentsProviders, ['Jenkins Wellness', 'Beacon Hill Aesthetics', 'below minimum']);
await check('transactions demo rows', '/admin/payments/transactions', PaymentsTransactions, ['TH-D3MO01', 'Maya Thompson', 'Subscription renewal']);
await check('fulfillment demo rows', '/admin/payments/fulfillment?status=to_ship', PaymentsFulfillment, ['TH-D3MO01', 'Mark shipped', 'Copy address']);
await check('catalog demo rows', '/admin/payments/catalog', PaymentsCatalog, ['Control', 'Maintenance + Detox Stack', 'Add product']);
await check(
  'provider detail back link',
  '/admin/payments/providers/jenkins',
  () => <PaymentProviderDetail params={{ providerId: 'jenkins' }} />,
  ['Jenkins Wellness', 'Back to providers', 'Collected · 30d', 'Active subscriptions', 'Recent orders', 'TH-D3MO01'],
);
await check(
  'transaction detail back link',
  '/admin/payments/transactions/demo-order-1',
  () => <PaymentTransactionDetail params={{ orderId: 'demo-order-1' }} />,
  ['TH-D3MO01', 'Back to transactions'],
);

{
  const location = memoryLocation({ path: '/admin/payments/catalog' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><Router hook={location.hook}><Route path="/admin/payments" nest><PaymentsCatalog /></Route></Router></QueryClientProvider>);
  });
  const add = renderer!.root.find(node => node.props['data-testid'] === 'button-catalog-add' && node.type === 'button');
  await act(async () => { add.props.onClick(); });
  const floor = renderer!.root.find(node => node.props['data-testid'] === 'input-catalog-floor' && node.type === 'input');
  await act(async () => { floor.props.onChange({ target: { value: '59.99' } }); });
  const text = JSON.stringify(renderer!.toJSON());
  if (!text.includes('$35.99') || !text.includes('$37.67')) {
    failures += 1;
    console.error('FAIL catalog live fee math: expected $35.99 share and $37.67 office minimum');
  } else console.log('ok catalog live fee math');
  await act(async () => { renderer!.unmount(); });
}

if (fetches !== 0) { failures += 1; console.error(`FAIL demo issued ${fetches} fetch request(s)`); }
console.log(failures === 0 ? 'All HQ billing checks passed.' : `${failures} HQ billing check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);