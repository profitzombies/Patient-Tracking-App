/**
 * Patient billing screen contract check. It renders the real account and
 * patient providers, while the HTTP boundary and browser are scripted.
 */
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
};

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import BillingScreen from '../app/billing';
import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { PatientProvider } from '../context/PatientContext';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';
import { routerCalls, clearRouterCalls, setSearchParams } from './onboarding-gate-stubs/expo-router';

const opened: string[] = [];
let confirms = 0;
(globalThis as Record<string, unknown>).window = {
  open: (url: string) => { opened.push(url); return {}; },
  alert: () => undefined,
  confirm: () => { confirms += 1; return true; },
};

let checks = 0;
let failures = 0;
function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) { failures += 1; console.error(`  FAIL  ${label}`); }
}
function section(label: string) { console.log(`\n· ${label}`); }

type Call = { method: string; path: string; auth: string | null; body: Record<string, unknown> | null };
const calls: Call[] = [];
let overviewFailure = false;
let paymentsAvailable = true;
let canceled = false;

const product = { product_id: 'prod-1', name: 'Control', description: 'Daily support.', image_url: null, unit_price_cents: 6999, subscription_available: true };
const order = { id: 'order-1', order_number: 'TH-1001', kind: 'one_time', status: 'paid', fulfillment_status: 'shipped', total_cents: 7999, refunded_cents: 0, item_count: 1, items_label: 'Control', created_at: '2026-09-01T12:00:00Z', paid_at: '2026-09-01T12:01:00Z', receipt_available: true };
const subscription = () => ({ id: 'sub-1', product_name: 'Control', unit_price_cents: 6999, shipping_charge_cents: 1000, status: 'active', paused: false, current_period_end: '2026-10-01T12:00:00Z', cancel_at_period_end: canceled, last_hosted_invoice_url: null, last_failure_message: null });
const overview = () => ({
  office: { provider_id: 'office-1', office_name: 'Harbor Health', payments_available: paymentsAvailable },
  products: paymentsAvailable ? [product] : [],
  shipping_charge_cents: 1000,
  orders: [order],
  subscriptions: [subscription()],
});
const profile = { firstName: 'Pat', lastName: 'Example', email: 'pat@example.com', phone: '+15550001010', dateOfBirth: '1985-04-03', heightInches: 66, startingWeight: 205, currentWeight: 191, goalWeight: 165, timezone: 'America/New_York', programId: 'glp1', programStartDate: '2026-08-20', setupComplete: true };
const patientState = { entries: [], water: {}, targets: {}, favorites: [], recents: [], customFoods: [], catalogFoods: [], savedRecipes: [], photos: [], checkIns: [], medications: [], doseLogs: [], flags: { nudgeOptOut: false, nudgeEngaged: false, nudgeLastSentKey: null, nudgeLastCrossingKey: null, onboardingComplete: true }, entry: { firstName: 'Pat', programStartDate: '2026-08-20', todayKey: '2026-09-07', programDay: 19 }, profile };

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.slice('/api/'.length);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const call: Call = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path,
    auth: headers.Authorization ?? null,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null,
  };
  calls.push(call);
  let status = 200;
  let body: unknown;
  if (path === 'claim/whoami') body = { kind: 'patient', patientId: 'patient-1' };
  else if (path.startsWith('patient-data/state')) body = patientState;
  else if (path === 'patient-data/profile') body = { profile };
  else if (path === 'patient-data/billing/overview') {
    if (overviewFailure) { status = 503; body = { error: 'Payments are briefly unavailable.' }; }
    else body = overview();
  } else if (path === 'patient-data/billing/checkout-link') body = { url: 'https://pay.test/link', token: 'link', expires_at: null };
  else if (path === 'patient-data/billing/orders/order-1/receipt') body = { order_number: 'TH-1001', receipt_url: 'https://stripe.test/receipt', invoice_url: null, invoice_pdf_url: null };
  else if (path === 'patient-data/billing/subscriptions/sub-1/cancel') { canceled = true; body = subscription(); }
  else throw new Error(`Unscripted request: ${call.method} ${path}`);
  return {
    ok: status < 300,
    status,
    headers: new Headers(path.startsWith('patient-data/billing/')
      ? { 'X-Billing-Scope': 'test:acct_office1' }
      : undefined),
    json: async () => body,
  } as Response;
}) as typeof fetch;

async function settle() {
  for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); });
}
async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<PatientAccountProvider><PatientProvider><BillingScreen /></PatientProvider></PatientAccountProvider>);
  });
  await settle();
  return tree;
}
async function unmount(tree: ReactTestRenderer) { await act(async () => tree.unmount()); }
function hosts(tree: ReactTestRenderer, id: string) {
  return tree.root.findAllByProps({ testID: id }).filter(node => typeof node.type === 'string');
}
function has(tree: ReactTestRenderer, id: string) { return hosts(tree, id).length > 0; }
function text(tree: ReactTestRenderer, id: string): string {
  const flatten = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(flatten).join('');
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (value && typeof value === 'object' && 'children' in value) return flatten((value as { children?: unknown }).children);
    if (value && typeof value === 'object' && 'props' in value) return flatten((value as { props: { children?: unknown } }).props.children);
    return '';
  };
  return hosts(tree, id).map(node => flatten(node.children)).join('');
}
async function press(tree: ReactTestRenderer, id: string) {
  const node = hosts(tree, id).find(candidate => typeof candidate.props.onPress === 'function');
  if (!node) throw new Error(`Missing button ${id}`);
  await act(async () => node.props.onPress());
  await settle();
}
const billingCalls = () => calls.filter(call => call.path.startsWith('patient-data/billing/'));
const session: StubSession = { access_token: 'patient-token', user: { id: 'user-1' } };

async function main() {
  section('signed out is offline and renders nothing');
  setStubSession(null);
  let tree = await mount();
  assert('signed-out mount makes no billing request and shows no office, products or purchase links', billingCalls().length === 0 && !has(tree, 'card-office') && !has(tree, 'button-open-orders') && !has(tree, 'button-open-subscriptions') && !has(tree, 'text-billing-error') && opened.length === 0);
  await unmount(tree);

  section('real overview and actions');
  await act(async () => setStubSession(session));
  tree = await mount();
  const firstOverview = billingCalls().find(call => call.path.endsWith('/overview'));
  assert('overview uses bearer and renders products plus purchase links', firstOverview?.auth === 'Bearer patient-token' && has(tree, 'button-order-prod-1') && has(tree, 'button-open-orders') && has(tree, 'button-open-subscriptions'));
  clearRouterCalls();
  await press(tree, 'button-open-orders');
  await press(tree, 'button-open-subscriptions');
  assert('purchase links route to the Orders and Subscriptions screens', routerCalls.some(call => call.target === '/orders') && routerCalls.some(call => call.target === '/my-subscriptions'));
  await press(tree, 'button-order-prod-1');
  const checkout = billingCalls().find(call => call.path.endsWith('/checkout-link'));
  assert('Order posts product id and opens returned URL', checkout?.method === 'POST' && checkout.body?.product_id === 'prod-1' && opened.includes('https://pay.test/link'));
  await unmount(tree);

  section('email deep link: /billing?subscription=sub-1&action=skip');
  setSearchParams({ subscription: 'sub-1', action: 'skip' });
  clearRouterCalls();
  tree = await mount();
  assert('a subscription link hands off to that subscription screen with the action intact', routerCalls.some(call => call.method === 'replace' && call.target === '/my-subscriptions/sub-1?action=skip'));
  await unmount(tree);
  setSearchParams({ subscription: 'sub-1' });
  clearRouterCalls();
  tree = await mount();
  assert('a plain manage link opens the subscription without an action', routerCalls.some(call => call.method === 'replace' && call.target === '/my-subscriptions/sub-1'));
  await unmount(tree);
  setSearchParams({});
  clearRouterCalls();

  section('failure, retry, and unavailable office');
  overviewFailure = true;
  tree = await mount();
  assert('overview failure uses ErrorBox and Retry', text(tree, 'text-billing-error').includes('briefly unavailable') && has(tree, 'button-billing-retry'));
  overviewFailure = false;
  await press(tree, 'button-billing-retry');
  assert('Retry refetches and recovers', !has(tree, 'text-billing-error') && has(tree, 'card-office'));
  await unmount(tree);
  paymentsAvailable = false;
  tree = await mount();
  assert('unavailable office has plain notice and no checkout buttons', text(tree, 'card-office').includes('isn’t taking payments') && !has(tree, 'button-open-checkout') && !has(tree, 'button-order-prod-1'));
  await unmount(tree);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });