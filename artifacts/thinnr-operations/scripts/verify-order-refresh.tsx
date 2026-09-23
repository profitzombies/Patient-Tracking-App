/**
 * Refreshable order screens (web): the page-header Refresh control, the
 * stale-on-focus refetch, error handling that keeps the last good data, and
 * the demo persona's animated no-op. Renders the REAL office payments area
 * and HQ payment pages under react-test-renderer with a scripted fetch.
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { DateRangeProvider } from '../src/contexts/date-range';
import OfficePaymentsArea from '../src/pages/office/payments/OfficePaymentsArea';
import { PaymentTransactionDetail, PaymentsFulfillment, PaymentsTransactions } from '../src/pages/admin/payments/HqPaymentsPages';
import { DEMO_FULFILLMENT, DEMO_ORDERS, DEMO_ORDER_DETAILS, DEMO_PRICES, DEMO_SUBSCRIPTIONS } from '../src/pages/office/payments/demo-data';
import { formatUpdatedAgo } from '../src/components/billing/RefreshControl';
import { ORDER_REFRESH_STALE_MS } from '../src/hooks/use-billing';
import { __getToastStateForTests, __resetToastStoreForTests } from '../src/hooks/use-toast';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.location ??= { assign() {} };
g.window.getSelection ??= () => ({ toString: () => '' });
g.navigator ??= {};

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (pass) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let responses: Array<() => Response> = [];
const requests: Array<{ url: string; method: string }> = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
  const next = responses.shift();
  if (!next) throw new Error(`unexpected fetch ${url}`);
  return next();
};

const account = {
  provider_id: 'office-1', stripe_account_id: 'acct_1', origin: 'created', dashboard_type: 'none',
  charges_enabled: true, payouts_enabled: true, details_submitted: true,
  requirements: { currently_due: [], past_due: [], eventually_due: [], disabled_reason: null, current_deadline: null },
  capabilities: {}, default_currency: 'usd', business_name: 'Beacon Hill', email: 'office@example.com',
  tax_enabled: false, livemode: false, last_synced_at: '2026-10-11T00:00:00Z', disconnected_at: null, created_at: '2026-10-01T00:00:00Z',
};
const status = () => ({
  account, offered_products: 1, links: 1, sandbox: true, oauth_available: true,
  viewer: { office_role: 'owner', can_manage: true }, office: { provider_id: 'office-1', office_name: 'Beacon Hill' },
});
const orderRow = (orderNumber: string) => ({ ...DEMO_ORDERS[0], id: `order-${orderNumber}`, order_number: orderNumber });

function reset(kind: 'demo' | 'owner' | 'hq' = 'owner') {
  requests.length = 0; responses = []; __setScope(null); __resetToastStoreForTests();
  if (kind === 'demo') {
    __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
    __setSupabaseSession(null);
  } else if (kind === 'hq') {
    __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Super Admin' });
    __setSupabaseSession('hq-token');
  } else {
    __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' } });
    __setSupabaseSession('staff-token');
  }
}
async function settle(rounds = 12) { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
async function wait(ms: number) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); await settle(4); }

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
async function renderOffice(path: string) {
  const location = memoryLocation({ path: `/payments${path === '/' ? '' : path}`, record: true });
  const client = newClient();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/payments" nest><OfficePaymentsArea /></Route></Router></DateRangeProvider></QueryClientProvider>); });
  await settle();
  return { renderer, root: renderer.root, client };
}
async function renderHq(path: string, Page: React.ComponentType) {
  const location = memoryLocation({ path: `/admin/payments${path}`, record: true });
  const client = newClient();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><Page /></Route></Router></DateRangeProvider></QueryClientProvider>); });
  await settle();
  return { renderer, root: renderer.root, client };
}
const all = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => all(root, id)[0];
const text = (node: ReactTestInstance | undefined) => {
  if (!node) return '';
  const parts: string[] = [];
  const walk = (item: ReactTestInstance | string) => typeof item === 'string' ? parts.push(item) : item.children.forEach((child) => walk(child as ReactTestInstance | string));
  walk(node); return parts.join('');
};
const ordersRequests = () => requests.filter((request) => request.url.includes('/api/billing/office/orders') && !request.url.includes('/orders/'));
const controlCheck = (root: ReactTestInstance, id: string, subject: string) => {
  const button = one(root, `${id}-button`);
  const statusNode = one(root, `${id}-status`);
  return Boolean(button) && button.type === 'button' && String(button.props['aria-label']).startsWith(`Refresh ${subject}`)
    && button.props['data-spinning'] === 'false' && Boolean(statusNode) && statusNode.props.role === 'status' && statusNode.props['aria-live'] === 'polite';
};

console.log('order refresh: relative time');
{
  const now = Date.parse('2026-10-11T12:00:00Z');
  check(
    'updated-ago text rounds down to just now / minutes / hours',
    formatUpdatedAgo(now - 5_000, now) === 'Updated just now' && formatUpdatedAgo(now - 61_000, now) === 'Updated 1 min ago'
      && formatUpdatedAgo(now - 59 * 60_000, now) === 'Updated 59 min ago' && formatUpdatedAgo(now - 2 * 3_600_000 - 1000, now) === 'Updated 2 hr ago',
  );
  check('stale window for focus refetch is 30 seconds', ORDER_REFRESH_STALE_MS === 30_000);
}

console.log('\norder refresh: office transactions (live)');
{
  reset();
  responses = [json(200, status()), json(200, { items: [orderRow('TH-FIRST')], next_cursor: null })];
  const page = await renderOffice('/transactions');
  const id = 'refresh-transactions';
  check('header carries the refresh control with an updated-just-now readout', controlCheck(page.root, id, 'transactions') && text(one(page.root, `${id}-updated`)) === 'Updated just now' && text(page.root).includes('TH-FIRST'), text(page.root).slice(0, 200));
  check('updated readout is aria-hidden and the button names the age', one(page.root, `${id}-updated`).props['aria-hidden'] === 'true' && one(page.root, `${id}-button`).props['aria-label'] === 'Refresh transactions. Updated just now');
  check('no fetch fires before a refresh beyond the initial reads', ordersRequests().length === 1, String(ordersRequests().length));

  // Manual refresh: one API call, rows swap, completion announced.
  let release!: () => void;
  responses = [() => { throw new Error('unused'); }];
  responses = [];
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    await new Promise<void>((resolve) => { release = resolve; });
    return json(200, { items: [orderRow('TH-SECOND')], next_cursor: null })();
  };
  await act(async () => one(page.root, `${id}-button`).props.onClick());
  await settle(2);
  check('refresh calls our API once and spins while in flight', ordersRequests().length === 2 && ordersRequests()[1].method === 'GET' && one(page.root, `${id}-button`).props['data-spinning'] === 'true' && one(page.root, `${id}-button`).props['aria-busy'] === true && text(page.root).includes('TH-FIRST'), JSON.stringify(ordersRequests()));
  check('warehouse vendor is never contacted from the client', requests.every((request) => request.url.startsWith('/api/') || request.url.includes('/api/')), requests.map((request) => request.url).join(','));
  await act(async () => { release(); });
  await settle();
  check('fresh rows replace the old ones and the control stops spinning', text(page.root).includes('TH-SECOND') && !text(page.root).includes('TH-FIRST') && one(page.root, `${id}-button`).props['data-spinning'] === 'false');
  check('completion is announced through the polite live region', /^Transactions refreshed at \d/.test(text(one(page.root, `${id}-status`))), text(one(page.root, `${id}-status`)));
  check('a successful refresh raises no toast', __getToastStateForTests().toasts.length === 0);

  // Focus refetch: only when the data is older than the stale window.
  // (Runs before the failure case: React Query flags data invalidated after a
  // background error, so a failed refresh is retried on the next focus.)
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    return json(200, { items: [orderRow('TH-FOCUS')], next_cursor: null })();
  };
  const before = ordersRequests().length;
  focusManager.setFocused(false);
  await act(async () => { focusManager.setFocused(true); });
  await settle();
  check('regaining focus with fresh data does not refetch', ordersRequests().length === before, `${before} → ${ordersRequests().length}`);
  const ordersQuery = page.client.getQueryCache().findAll().find((query) => query.queryKey.includes('orders'));
  check('orders query is registered with the stale window and focus refetch', Boolean(ordersQuery) && ordersQuery!.options.staleTime === ORDER_REFRESH_STALE_MS && ordersQuery!.options.refetchOnWindowFocus === true, JSON.stringify(ordersQuery?.options.staleTime));
  page.client.setQueryData(ordersQuery!.queryKey, ordersQuery!.state.data, { updatedAt: Date.now() - ORDER_REFRESH_STALE_MS - 1000 });
  focusManager.setFocused(false);
  await act(async () => { focusManager.setFocused(true); });
  await settle();
  check('regaining focus after 30 seconds refetches through our API and shows the new rows', ordersRequests().length === before + 1 && text(page.root).includes('TH-FOCUS'), `${before} → ${ordersRequests().length}`);
  focusManager.setFocused(undefined);
  // Failed refresh: rows stay, toast + announcement say so.
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    return new Response(JSON.stringify({ error: 'Billing is briefly unavailable.' }), { status: 503, headers: { 'content-type': 'application/json' } });
  };
  await act(async () => one(page.root, `${id}-button`).props.onClick());
  await settle();
  const toasts = __getToastStateForTests().toasts;
  check('a failed refresh keeps the last good rows on screen (no error box)', text(page.root).includes('TH-FOCUS') && page.root.findAll((node) => node.props.role === 'alert' && typeof node.type === 'string').length === 0, text(page.root).slice(0, 300));
  check('failure raises a non-blocking destructive toast', toasts.length === 1 && toasts[0].variant === 'destructive' && String(toasts[0].title).includes("Couldn't refresh transactions") && String(toasts[0].description).includes('last loaded data'), JSON.stringify(toasts.map((toast) => [toast.variant, toast.title, toast.description])));
  check('failure is announced to screen readers', /refresh failed at \d/.test(text(one(page.root, `${id}-status`))) && text(one(page.root, `${id}-status`)).includes('last loaded data'), text(one(page.root, `${id}-status`)));

  page.renderer.unmount();
}

console.log('\norder refresh: office detail, fulfillment and subscriptions (live)');
{
  reset();
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next();
  };
  const detail = { ...DEMO_ORDER_DETAILS['demo-order-1'], id: 'live-1', order_number: 'TH-LIVE01', tracking_number: null };
  responses = [json(200, status()), json(200, detail)];
  const page = await renderOffice('/transactions/live-1');
  check('order detail header carries the refresh control beside Refund', controlCheck(page.root, 'refresh-order', 'order') && page.root.findAll((node) => node.type === 'button' && text(node) === 'Refund').length === 1);
  responses = [json(200, { ...detail, tracking_number: '9400111899223' })];
  await act(async () => one(page.root, 'refresh-order-button').props.onClick());
  await settle();
  check('detail refresh re-reads the order and shows the tracking number that arrived', requests.filter((request) => request.url.includes('/orders/live-1')).length === 2 && text(page.root).includes('9400111899223'), text(page.root).slice(0, 200));
  const detailQuery = page.client.getQueryCache().findAll().find((query) => query.queryKey.includes('order'));
  check('order detail query refetches on stale focus', detailQuery?.options.staleTime === ORDER_REFRESH_STALE_MS && detailQuery?.options.refetchOnWindowFocus === true);
  page.renderer.unmount();

  reset();
  responses = [json(200, status()), json(200, { items: [{ ...DEMO_FULFILLMENT[0], id: 'f1', order_number: 'TH-F1', fulfillment_status: 'to_ship', warehouse: null }], next_cursor: null })];
  const fulfillment = await renderOffice('/fulfillment');
  check('fulfillment header carries the refresh control', controlCheck(fulfillment.root, 'refresh-fulfillment', 'fulfillment') && text(fulfillment.root).includes('TH-F1'));
  responses = [json(503, { error: 'down' })];
  await act(async () => one(fulfillment.root, 'refresh-fulfillment-button').props.onClick());
  await settle();
  check('failed fulfillment refresh keeps the queue and toasts', text(fulfillment.root).includes('TH-F1') && __getToastStateForTests().toasts.some((toast) => String(toast.title).includes("Couldn't refresh fulfillment")));
  const fulfillmentQuery = fulfillment.client.getQueryCache().findAll().find((query) => query.queryKey.includes('fulfillment'));
  check('fulfillment query refetches on stale focus', fulfillmentQuery?.options.staleTime === ORDER_REFRESH_STALE_MS && fulfillmentQuery?.options.refetchOnWindowFocus === true);
  fulfillment.renderer.unmount();

  reset();
  responses = [json(200, status()), json(200, { items: DEMO_SUBSCRIPTIONS.slice(0, 1), next_cursor: null }), json(200, { products: DEMO_PRICES })];
  const subscriptions = await renderOffice('/subscriptions');
  check('subscriptions header carries the refresh control', controlCheck(subscriptions.root, 'refresh-subscriptions', 'subscriptions'), text(subscriptions.root).slice(0, 200));
  responses = [json(200, { items: DEMO_SUBSCRIPTIONS.slice(0, 1), next_cursor: null }), json(200, { products: DEMO_PRICES })];
  const beforeSubs = requests.length;
  await act(async () => one(subscriptions.root, 'refresh-subscriptions-button').props.onClick());
  await settle();
  check('subscriptions refresh re-reads both subscriptions and prices', requests.length === beforeSubs + 2 && requests.slice(beforeSubs).some((request) => request.url.includes('/subscriptions')) && requests.slice(beforeSubs).some((request) => request.url.includes('/prices')), requests.slice(beforeSubs).map((request) => request.url).join(','));
  const subsQuery = subscriptions.client.getQueryCache().findAll().find((query) => query.queryKey.includes('subscriptions'));
  check('subscriptions query refetches on stale focus', subsQuery?.options.staleTime === ORDER_REFRESH_STALE_MS && subsQuery?.options.refetchOnWindowFocus === true);
  subscriptions.renderer.unmount();
}

console.log('\norder refresh: demo persona (office + HQ)');
{
  reset('demo');
  const page = await renderOffice('/transactions');
  const id = 'refresh-transactions';
  check('demo transactions show the control without any fetch', requests.length === 0 && controlCheck(page.root, id, 'transactions') && text(one(page.root, `${id}-updated`)) === 'Updated just now');
  await act(async () => one(page.root, `${id}-button`).props.onClick());
  await settle(2);
  check('demo refresh animates', one(page.root, `${id}-button`).props['data-spinning'] === 'true');
  await wait(600);
  check('demo refresh is a no-op that confirms the preview and never fetches', requests.length === 0 && one(page.root, `${id}-button`).props['data-spinning'] === 'false' && text(one(page.root, `${id}-status`)) === 'Transactions preview is up to date.', text(one(page.root, `${id}-status`)));
  page.renderer.unmount();

  for (const [path, id, subject] of [['/transactions/demo-order-1', 'refresh-order', 'order'], ['/fulfillment', 'refresh-fulfillment', 'fulfillment'], ['/subscriptions', 'refresh-subscriptions', 'subscriptions']] as const) {
    reset('demo');
    const demo = await renderOffice(path);
    check(`demo office ${path} carries the refresh control`, requests.length === 0 && controlCheck(demo.root, id, subject), text(demo.root).slice(0, 120));
    demo.renderer.unmount();
  }

  for (const [path, Page, id, subject] of [
    ['/transactions', PaymentsTransactions, 'refresh-transactions', 'transactions'],
    ['/fulfillment', PaymentsFulfillment, 'refresh-fulfillment', 'fulfillment'],
    ['/transactions/demo-order-1', () => <PaymentTransactionDetail params={{ orderId: 'demo-order-1' }} />, 'refresh-order', 'order'],
  ] as const) {
    reset('demo');
    const hq = await renderHq(path, Page as React.ComponentType);
    check(`demo HQ ${path} carries the refresh control`, requests.length === 0 && controlCheck(hq.root, id, subject), text(hq.root).slice(0, 120));
    hq.renderer.unmount();
  }
}

console.log('\norder refresh: HQ transactions (live)');
{
  reset('hq');
  responses = [json(200, { sandbox: true }), json(200, { items: [orderRow('TH-HQ1')], next_cursor: null })];
  const page = await renderHq('/transactions', PaymentsTransactions);
  const hqRequests = () => requests.filter((request) => request.url.includes('/api/billing/hq/transactions'));
  check('HQ transactions load through our API with the refresh control', hqRequests().length === 1 && controlCheck(page.root, 'refresh-transactions', 'transactions') && text(page.root).includes('TH-HQ1'), requests.map((request) => request.url).join(','));
  responses = [json(200, { items: [orderRow('TH-HQ2')], next_cursor: null })];
  await act(async () => one(page.root, 'refresh-transactions-button').props.onClick());
  await settle();
  check('HQ refresh re-reads transactions and swaps the rows', hqRequests().length === 2 && text(page.root).includes('TH-HQ2') && !text(page.root).includes('TH-HQ1'), text(page.root).slice(0, 200));
  const hqQuery = page.client.getQueryCache().findAll().find((query) => query.queryKey.includes('transactions'));
  check('HQ transactions query refetches on stale focus', hqQuery?.options.staleTime === ORDER_REFRESH_STALE_MS && hqQuery?.options.refetchOnWindowFocus === true);
  page.renderer.unmount();
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall order refresh checks passed');
