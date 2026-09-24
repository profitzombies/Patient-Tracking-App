import * as React from 'react';
import assert from 'node:assert/strict';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as setToken } from './invite-stubs/supabase';
import { __setHqData } from './a11y-stubs/hq-data';
import { PracticeLaunchGuard, launchRecoveryPath } from '../src/pages/PracticeLaunch';
import { launchKey, useLaunchWrite, type LaunchState } from '../src/hooks/use-launch';
import { AccountLocksProvider } from '../src/contexts/account-locks';
import { DateRangeProvider } from '../src/contexts/date-range';
import { TrainingDataProvider } from '../src/contexts/training-data';
import AccountDetail from '../src/pages/admin/AccountDetail';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).window = { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), getSelection: () => '' };
const state: LaunchState = {
  billingScope: 'test:acct_fixture', office: { providerId: 'fixture', officeName: 'Sample Practice' },
  canEdit: true, required: true, fullSetupRequired: true, version: 3, detailsConfirmed: true, productsConfirmed: false, completedAt: null,
  details: { officeName: 'Sample Practice', providerName: 'Sample Owner', email: 'owner@example.invalid', phone: '6175550123', address1: '1 Sample Street', address2: '', city: 'Boston', state: 'MA', postalCode: '02108' },
  security: { ready: true }, payments: { state: 'pending', sandbox: true },
  products: [{ productId: 'sample', name: 'Sample Product', enabled: true, sellPriceCents: 9000, suggestedPriceCents: 7198, minimumPriceCents: 4000, subscriptionEnabled: false, subscriptionEligible: true, existingPrice: true, available: true }],
};
let snapshot = structuredClone(state);
let failed = false;
let restartFailed = false;
const calls: { url: string; method: string; body: any; headers: any }[] = [];
globalThis.fetch = async (input, init) => {
  const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers };
  calls.push(call);
  if (failed) return new Response(JSON.stringify({ error: 'Locked or unavailable' }), { status: 403 });
  if (restartFailed && call.url.includes('/restart')) return new Response(JSON.stringify({ error: 'Restart blocked' }), { status: 409 });
  if (call.url.includes('/offboarding')) return new Response(JSON.stringify({ offboarding: { seal: { startedAt: null, completedAt: null } } }), { status: 200 });
  if (call.url.startsWith('/api/provider-accounts/fixture')) return new Response(JSON.stringify({ account: { id: 'fixture', officeName: 'Sample Practice' } }), { status: 200 });
  if (call.url.startsWith('/api/office/hq/accounts')) return new Response(JSON.stringify({ account: { id: 'fixture', officeName: 'Sample Practice', offboarding: { seal: null } } }), { status: 200 });
  if (call.url.startsWith('/api/billing/hq/providers/')) return new Response(JSON.stringify({ status: { is_connected: true, charges_enabled: true, payouts_enabled: true, details_submitted: true }, activity_30d: { collected_cents: 0, orders: 0 }, subscriptions: { active: 0 }, pending_requirements: [], recent_orders: [] }), { status: 200 });
  if (call.url.startsWith('/api/office/hq/analytics')) return new Response(JSON.stringify({ available: false }), { status: 200 });
  if (call.url.includes('/office-access/')) return new Response(JSON.stringify({
    office: { providerId: 'fixture', officeName: 'Sample Practice' },
    subscription: null,
    setup: null,
    instruments: [],
    attempts: [],
    history: [],
    policy: { monthlyPriceCents: 20000, yearlyPriceCents: 200000, includedPeriodDays: 365, gracePeriodDays: 7, normalSharePercent: 60, restrictedSharePercent: 100, maxIncludedPeriodDays: 1095 },
  }), { status: 200 });

  if (call.method !== 'GET') {
    snapshot.version++;
  }
  return new Response(JSON.stringify(snapshot), { status: 200 });
};
setToken('fixture-token');
__setScope(null);
__setHqData({ accounts: [{ id: 'fixture', officeName: 'Sample Practice', providerName: 'Sample Owner', providerRole: 'Owner', city: 'Boston', state: 'MA', status: 'active', joinedKey: '2023-01-01', email: 'owner@example.invalid' }], canManageProviderAccounts: true });
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', staffSession: { role: 'owner', staffKind: 'provider', providerId: 'fixture', idleTimeoutMinutes: 15, idleTimeoutSource: 'hq', freshCode: { needed: false } }, authUser: { id: 'owner-fixture' }, signOut() {} });
const text = (node: any): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node?.children ? text(node.children) : '';
const button = (root: ReactTestRenderer, label: string) => root.root.findAllByType('button').find((b) => text(b.props.children) === label)!;
let mounted = 0;
function RealOperations() { mounted++; return <p>REAL OPERATIONS</p>; }
async function render(path = '/patients') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path });
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<QueryClientProvider client={client}><Router hook={location.hook}><PracticeLaunchGuard><RealOperations /></PracticeLaunchGuard></Router></QueryClientProvider>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { root, client };
}
async function dispose(root: ReactTestRenderer, client?: QueryClient) { await act(async () => root.unmount()); client?.clear(); }

assert.equal(launchRecoveryPath('/payments/get-paid'), true);
assert.equal(launchRecoveryPath('/payments/orders'), false);
assert.equal(launchRecoveryPath('/security-bypass'), false);
assert.notDeepEqual(launchKey('a', null), launchKey('b', null));
assert.notDeepEqual(launchKey('a', 'office1'), launchKey('a', 'office2'));

let result = await render();
assert.equal(mounted, 0, 'incomplete setup must not mount operational children');
assert.match(text(result.root.toJSON()), /1\. Practice details · Confirmed/);
assert.match(text(result.root.toJSON()), /Stripe is still verifying your account/);
assert.equal(result.root.root.findAllByType('input')[0].props.value, 'Sample Practice');

// Restart Stripe setup
await act(async () => { button(result.root, 'Restart Stripe setup').props.onClick(); });
await act(async () => { button(result.root, 'Restart setup').props.onClick(); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const restartCall = calls.find(c => c.url.includes('/restart'))!;
assert.equal(restartCall.method, 'POST');
assert.deepEqual(restartCall.body, {});
assert.equal(restartCall.headers['X-Billing-Scope'], state.billingScope);

// Restart error handling
restartFailed = true;
await act(async () => { button(result.root, 'Restart Stripe setup').props.onClick(); });
await act(async () => { button(result.root, 'Restart setup').props.onClick(); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
assert.match(text(result.root.toJSON()), /Restart blocked/);
assert.match(text(result.root.toJSON()), /contact THINNR support/);
restartFailed = false;

await act(async () => { button(result.root, 'Use suggested setup').props.onClick(); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const productCall = calls.find(c => c.url.includes('/products'))!;
assert.equal(productCall.method, 'POST');
assert.equal(productCall.headers['X-Billing-Scope'], state.billingScope);
assert.equal(productCall.body.products[0].sellPriceCents, 9000, 'suggested setup preserves existing custom price');
assert.equal(productCall.body.products[0].subscriptionEnabled, false);
await dispose(result.root, result.client);

failed = true;
result = await render('/patients');
assert.equal(mounted, 0);
assert.match(text(result.root.toJSON()), /could not be loaded/);
await dispose(result.root, result.client);
failed = false;

// Legacy office does not require details/products
snapshot = { ...structuredClone(state), fullSetupRequired: false, payments: { state: 'ready', sandbox: true }, security: { ready: true }, detailsConfirmed: false, productsConfirmed: false };
result = await render();
assert.equal(button(result.root, 'Finish setup').props.disabled, false, 'Legacy office can finish setup without details or products');
assert.match(text(result.root.toJSON()), /2\s+of\s+2\s+essentials confirmed/);
await dispose(result.root, result.client);

snapshot = { ...structuredClone(state), canEdit: false };
result = await render();
assert.match(text(result.root.toJSON()), /Your practice owner completes setup/);
assert.equal(button(result.root, 'Use suggested setup'), undefined);
await dispose(result.root, result.client);

// Same-tick duplicate submits are serialized, not merely visually disabled.
let write: ReturnType<typeof useLaunchWrite>;
function Probe() { write = useLaunchWrite('complete'); return null; }
const client = new QueryClient();
let probe!: ReactTestRenderer;
await act(async () => { probe = create(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
const count = calls.length;
await act(async () => { await Promise.all([write!.save({ expectedVersion: 3 }, state.billingScope), write!.save({ expectedVersion: 3 }, state.billingScope)]); });
assert.equal(calls.length, count + 1);
assert.equal(calls.at(-1)?.headers['X-Billing-Scope'], state.billingScope);
await dispose(probe, client);

snapshot = { ...structuredClone(state), required: false };
result = await render('/');
assert.equal(mounted, 1, 'legacy offices are not forced through setup');
await dispose(result.root, result.client);

// Test HQ control (regate)
__setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Super Admin', authUser: { id: 'hq-fixture' }, signOut() {} });
const hqClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const hqLocation = memoryLocation({ path: '/admin/accounts/fixture' });
let hqRoot!: ReactTestRenderer;
await act(async () => { hqRoot = create(<QueryClientProvider client={hqClient}><Router hook={hqLocation.hook}><AccountLocksProvider><DateRangeProvider><TrainingDataProvider><Route path="/admin/accounts/:id"><AccountDetail /></Route></TrainingDataProvider></DateRangeProvider></AccountLocksProvider></Router></QueryClientProvider>); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
await act(async () => { button(hqRoot, 'Require setup again').props.onClick(); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
await act(async () => { button(hqRoot, 'Require setup').props.onClick(); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const regateCall = calls.find(c => c.url.includes('/regate'))!;
assert.equal(regateCall.method, 'POST');
assert.equal(regateCall.body.expectedVersion, snapshot.version - 1);
await dispose(hqRoot, hqClient);


console.log('Practice launch: scopes, fail-closed guard, roles, resume, contract, price preservation, duplicate submission, restart, legacy completion, and HQ control passed.');