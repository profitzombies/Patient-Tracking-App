import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { DateRangeProvider } from '../src/contexts/date-range';
import {
  PaymentProviderDetail, PaymentTransactionDetail, PaymentsFulfillment, PaymentsOverview,
  PaymentsProviders, PaymentsTransactions,
} from '../src/pages/admin/payments/HqPaymentsPages';
import { PaymentsActivity } from '../src/pages/admin/payments/PaymentsActivity';
import { PaymentsCatalog, SettingsCard } from '../src/pages/admin/payments/catalog/CatalogPage';
import { DEMO_CATALOG } from '../src/pages/admin/payments/demo-data';
import { PaymentsCatalogHistory } from '../src/pages/admin/payments/catalog/CatalogHistory';
import { ProductEditorPage } from '../src/pages/admin/payments/catalog/ProductEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).window ??= {};
(globalThis as any).window.getSelection ??= () => ({ toString: () => '' });
(globalThis as any).window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).window.innerWidth ??= 1280;
let fetches = 0;
globalThis.fetch = async () => { fetches += 1; throw new Error('Demo pages must not fetch'); };
__setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });

let failures = 0;
async function check(name: string, path: string, Page: React.ComponentType, expected: string[]) {
  const location = memoryLocation({ path });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><Page /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const text = JSON.stringify(renderer!.toJSON());
  // The area is `nest`-mounted at /admin/payments, so every rendered link must
  // resolve under that base (never /admin/payments/admin/payments/...).
  const hrefs = renderer!.root.findAll(node => node.type === 'a' && typeof node.props.href === 'string').map(node => node.props.href as string);
  // Teammate profile links deliberately escape to the Team page.
  const badHref = hrefs.find(href => !(href.startsWith('/admin/payments') || href.startsWith('/admin/team?member=')) || href.includes('/admin/payments/admin/'));
  if (badHref) { failures += 1; console.error(`FAIL ${name}: link escapes the nested base: ${badHref}`); }
  const passed = expected.every(value => text.includes(value));
  if (!passed) { failures += 1; console.error(`FAIL ${name}: missing ${expected.filter(value => !text.includes(value)).join(', ')}`); }
  else console.log(`ok ${name}`);
  await act(async () => { renderer!.unmount(); });
}

await check('overview demo', '/admin/payments', PaymentsOverview, [
  'Live payments appear here once HQ is signed in', 'Jenkins Wellness', 'Gross collected', 'Net collected', 'THINNR profit', 'Payments processed',
  'Daily revenue', 'Payments per day', 'Refunds per day', 'View all activity', 'Payment received', 'TH-D3MO01',
  "Today's revenue", 'Sep 24 so far, by the hour', 'THINNR fees', '4 PM',
]);
await check('activity demo rows', '/admin/payments/activity?kind=refund', PaymentsActivity, ['Refund issued', 'TH-D3MO03', 'Beacon Hill Aesthetics', 'All offices']);

{
  // Overview: activity rows are real links to the transaction, and the chart carries a spoken summary.
  const location = memoryLocation({ path: '/admin/payments', record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><PaymentsOverview /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const rowLink = renderer!.root.findAll(node => node.type === 'a' && node.props.href === '/admin/payments/transactions/demo-order-1');
  const chart = renderer!.root.findAll(node => node.type === 'svg' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Daily revenue'));
  const small = renderer!.root.findAll(node => ['chart-payments', 'chart-refunds', 'chart-gross', 'chart-net'].includes(node.props['data-testid']));
  // Today's chart: hourly x keys through the demo's 4 PM, four series in the readout, totals that add up to the hourly points.
  const today = renderer!.root.findAll(node => node.type === 'svg' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith("Today's revenue"));
  const todayReadout = renderer!.root.findAll(node => node.props['data-testid'] === 'chart-today-revenue-readout');
  const readoutText = todayReadout.length ? JSON.stringify(todayReadout[0].children.map(child => typeof child === 'string' ? child : '')) : '';
  const readoutLabels = ['Gross collected', 'Net after refunds', 'THINNR fees', 'THINNR profit'].filter(label =>
    todayReadout.length && todayReadout[0].findAll(node => node.type === 'dt' && String(node.children.at(-1)) === label).length === 1);
  const todayGross = renderer!.root.findAll(node => node.props['data-testid'] === 'today-gross').map(node => String(node.children.join('')));
  const hourLabels = today.length ? today[0].findAll(node => node.type === 'text').map(node => String(node.children.join(''))) : [];
  const row = renderer!.root.find(node => node.props['data-testid'] === 'row-activity-activity-1' && node.type === 'tr');
  await act(async () => { row.props.onClick({ defaultPrevented: false, target: { closest: () => null } }); });
  const navigated = location.history.at(-1) ?? '';
  const problems = [
    rowLink.length === 0 ? 'activity row lacks a transaction link' : '',
    chart.length !== 1 ? `expected one daily revenue chart, found ${chart.length}` : '',
    small.length !== 4 ? `expected four small charts, found ${small.length}` : '',
    today.length !== 1 ? `expected one today chart, found ${today.length}` : '',
    readoutLabels.length !== 4 ? `today readout lists ${readoutLabels.join(', ') || 'nothing'} (${readoutText})` : '',
    todayGross[0] !== '$1,289.90' ? `today gross tile shows ${todayGross[0] ?? '(missing)'}` : '',
    !hourLabels.includes('12 AM') || !hourLabels.includes('4 PM') || hourLabels.some(label => /^[A-Z][a-z]{2} \d/.test(label)) ? `today axis labels: ${hourLabels.join(' | ')}` : '',
    navigated !== '/admin/payments/transactions/demo-order-1' ? `row click navigated to ${navigated || '(nowhere)'}` : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL overview charts and activity links: ${problems.join('; ')}`); }
  else console.log('ok overview charts and activity links');
  await act(async () => { renderer!.unmount(); });
}
await check('providers demo rows', '/admin/payments/providers', PaymentsProviders, ['Jenkins Wellness', 'Beacon Hill Aesthetics', 'below minimum']);
await check('transactions demo rows', '/admin/payments/transactions', PaymentsTransactions, ['TH-D3MO01', 'Maya Thompson', 'Subscription renewal']);
await check('fulfillment demo rows', '/admin/payments/fulfillment?status=to_ship', PaymentsFulfillment, ['TH-D3MO01', 'Mark shipped', 'Copy address']);
await check('catalog demo rows', '/admin/payments/catalog', PaymentsCatalog, [
  'Control', 'Maintenance + Detox Stack', 'Add product', 'Active products', 'Program settings', 'Card fee rate', '"2.90"', '/admin/payments/catalog/products/new',
]);
await check('catalog history demo rows', '/admin/payments/catalog/history', PaymentsCatalogHistory, [
  'Office price changed', 'Jenkins Wellness', 'Alex Morgan', '/admin/team?member=hq-1', 'floor $109.99 → $119.99', 'price $79.99 → $84.99', ':27',
]);
await check(
  'product editor demo page',
  '/admin/payments/catalog/products/catalog-1',
  () => <ProductEditorPage params={{ productId: 'catalog-1' }} />,
  ['Control', 'Back to product catalog', 'Pictures', 'Fee math', 'Retire', 'Archive', 'Drag pictures here', 'Browse files'],
);
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
  // New-product page: fee math updates live as the floor is typed, using the demo program settings.
  const location = memoryLocation({ path: '/admin/payments/catalog/products/new' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><ProductEditorPage params={{}} /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const floor = renderer!.root.find(node => node.props['data-testid'] === 'input-catalog-floor' && node.type === 'input');
  await act(async () => { floor.props.onChange({ target: { value: '59.99' } }); });
  const text = JSON.stringify(renderer!.toJSON());
  const problems = [
    !text.includes('$35.99') || !text.includes('$37.67') ? 'expected $35.99 share and $37.67 office minimum' : '',
    !text.includes('Save the product first') ? 'upload zone should wait for the first save' : '',
    !text.includes('Add product') ? 'primary action should read Add product' : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL new product live fee math: ${problems.join('; ')}`); }
  else console.log('ok new product live fee math');
  await act(async () => { renderer!.unmount(); });
}

{
  // Catalog reorder: arrow keys on a row handle move it, and the demo never fetches.
  const location = memoryLocation({ path: '/admin/payments/catalog' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><PaymentsCatalog /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const rowsBefore = renderer!.root.findAll(node => node.type === 'tr' && typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('row-catalog-')).map(node => node.props['data-testid']);
  const handle = renderer!.root.find(node => node.props['data-testid'] === 'handle-catalog-catalog-2' && node.type === 'button');
  await act(async () => { handle.props.onKeyDown({ key: 'ArrowUp', preventDefault() {} }); });
  const rowsAfter = renderer!.root.findAll(node => node.type === 'tr' && typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('row-catalog-')).map(node => node.props['data-testid']);
  const archive = renderer!.root.findAll(node => node.props['data-testid'] === 'button-archive-catalog-1' && node.type === 'button');
  const problems = [
    rowsBefore[1] !== 'row-catalog-catalog-2' ? `expected catalog-2 second, got ${rowsBefore[1]}` : '',
    rowsAfter[0] !== 'row-catalog-catalog-2' ? `ArrowUp should move catalog-2 first, got ${rowsAfter[0]}` : '',
    archive.length !== 1 ? 'expected an Archive button on the first row' : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL catalog reorder: ${problems.join('; ')}`); }
  else console.log('ok catalog reorder');
  await act(async () => { renderer!.unmount(); });
}

{
  // Program settings: a dirty form keeps the version it was filled from when the
  // server moves on (save must 409, never overwrite), an untouched form follows the server.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const v1 = DEMO_CATALOG;
  const v2 = { ...v1, settings: { ...v1.settings, version: v1.settings.version + 1, shipping_charge_cents: v1.settings.shipping_charge_cents + 100 } };
  const tree = (data: typeof v1) => <QueryClientProvider client={client}><SettingsCard data={data} canWrite demo={false} /></QueryClientProvider>;
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(tree(v1)); });
  const input = () => renderer!.root.find(node => node.props['data-testid'] === 'input-settings-shipping-charge' && node.type === 'input');
  const before = input().props.value;
  await act(async () => { input().props.onChange({ target: { value: '12.34' } }); });
  await act(async () => { renderer!.update(tree(v2)); });
  const dirtyValue = input().props.value;
  const notice = renderer!.root.findAll(node => node.props['data-testid'] === 'text-settings-behind');
  await act(async () => { renderer!.root.find(node => node.props['data-testid'] === 'button-settings-discard').props.onClick(); });
  const afterDiscard = input().props.value;
  const noticeAfter = renderer!.root.findAll(node => node.props['data-testid'] === 'text-settings-behind');
  await act(async () => { renderer!.unmount(); });
  // Untouched form: server change flows straight into the fields.
  await act(async () => { renderer = create(tree(v1)); });
  await act(async () => { renderer!.update(tree(v2)); });
  const untouched = input().props.value;
  const untouchedNotice = renderer!.root.findAll(node => node.props['data-testid'] === 'text-settings-behind');
  await act(async () => { renderer!.unmount(); });
  const expectedV2 = (v2.settings.shipping_charge_cents / 100).toFixed(2);
  const problems = [
    dirtyValue !== '12.34' ? `dirty field was overwritten by the server change (${dirtyValue})` : '',
    notice.length !== 1 ? `expected the behind notice while dirty, found ${notice.length}` : '',
    afterDiscard !== expectedV2 ? `discard should load ${expectedV2}, got ${afterDiscard}` : '',
    noticeAfter.length !== 0 ? 'behind notice should clear after discarding' : '',
    untouched !== expectedV2 ? `untouched form should follow the server (${untouched} vs ${expectedV2}, started ${before})` : '',
    untouchedNotice.length !== 0 ? 'untouched form should not show the behind notice' : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL settings baseline: ${problems.join('; ')}`); }
  else console.log('ok settings baseline');
}

if (fetches !== 0) { failures += 1; console.error(`FAIL demo issued ${fetches} fetch request(s)`); }
console.log(failures === 0 ? 'All HQ billing checks passed.' : `${failures} HQ billing check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);