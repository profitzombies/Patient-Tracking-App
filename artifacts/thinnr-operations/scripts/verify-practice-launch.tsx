import * as React from 'react';
import assert from 'node:assert/strict';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as setToken } from './invite-stubs/supabase';
import { PracticeLaunchGuard, launchRecoveryPath } from '../src/pages/PracticeLaunch';
import { SampleTour } from '../src/pages/LaunchTourBoundary';
import { launchKey, useLaunchWrite, type LaunchState } from '../src/hooks/use-launch';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const state: LaunchState = {
  billingScope: 'test:acct_fixture', office: { providerId: 'fixture', officeName: 'Sample Practice' },
  canEdit: true, required: true, version: 3, detailsConfirmed: true, productsConfirmed: false, completedAt: null,
  details: { officeName: 'Sample Practice', providerName: 'Sample Owner', email: 'owner@example.invalid', phone: '6175550123', address1: '1 Sample Street', address2: '', city: 'Boston', state: 'MA', postalCode: '02108' },
  security: { ready: true }, payments: { state: 'pending', sandbox: true },
  products: [{ productId: 'sample', name: 'Sample Product', enabled: true, sellPriceCents: 9000, suggestedPriceCents: 7198, minimumPriceCents: 4000, subscriptionEnabled: false, subscriptionEligible: true, existingPrice: true, available: true }],
  tour: { step: 0, status: 'not_started' },
};
let snapshot = structuredClone(state);
let failed = false;
const calls: { url: string; method: string; body: any; headers: any }[] = [];
globalThis.fetch = async (input, init) => {
  const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers };
  calls.push(call);
  assert.ok(call.url.startsWith('/api/office/launch'), `Unexpected business request: ${call.url}`);
  if (failed) return new Response(JSON.stringify({ error: 'Locked or unavailable' }), { status: 403 });
  if (call.method !== 'GET') {
    if (call.url.includes('/tour')) snapshot.tour = call.body;
    else snapshot.version++;
  }
  return new Response(JSON.stringify(snapshot), { status: 200 });
};
setToken('fixture-token');
__setScope(null);
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'owner-fixture' }, signOut() {} });
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
assert.match(text(result.root.toJSON()), /Stripe verification pending/);
assert.equal(result.root.root.findAllByType('input')[0].props.value, 'Sample Practice');
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
snapshot = { ...structuredClone(state), canEdit: false };
result = await render();
assert.match(text(result.root.toJSON()), /Your practice owner completes setup/);
assert.equal(button(result.root, 'Use suggested setup'), undefined);
await dispose(result.root, result.client);

snapshot = { ...structuredClone(state), tour: { step: 0, status: 'active' } };
result = await render();
assert.match(text(result.root.toJSON()), /Guided tour — sample data/);
assert.equal(mounted, 0);
await dispose(result.root, result.client);

// Exercise every sample action without mounting the launch hooks or making a fetch.
const before = calls.length;
let step = 0; let exits = 0;
let tour!: ReactTestRenderer;
const progress: unknown[] = [];
const props = () => ({ step, busy: false, onExit: () => { exits++; }, onProgress: async (next: number, status: any) => { progress.push({ next, status }); step = next; tour.update(<SampleTour {...props()} />); } });
await act(async () => { tour = create(<SampleTour {...props()} />); });
await act(async () => { button(tour, 'Open sample profile').props.onClick(); });
assert.match(text(tour.toJSON()), /176 lb/);
await act(async () => { button(tour, 'Next').props.onClick(); });
assert.match(text(tour.toJSON()), /AI coach/);
await act(async () => { button(tour, 'Next').props.onClick(); });
await act(async () => { tour.root.findByType('textarea').props.onChange({ target: { value: 'Practice reply' } }); });
await act(async () => { tour.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
assert.match(text(tour.toJSON()), /Sample reply — not sent/);
await act(async () => { button(tour, 'Next').props.onClick(); });
await act(async () => { button(tour, 'Simulate full refund').props.onClick(); });
assert.match(text(tour.toJSON()), /No money moved/);
await act(async () => { button(tour, 'Next').props.onClick(); });
await act(async () => { button(tour, 'Preview sample lesson').props.onClick(); });
assert.match(text(tour.toJSON()), /no training completion recorded/);
await act(async () => { button(tour, 'Next').props.onClick(); });
await act(async () => { button(tour, 'Find invitations and signup code').props.onClick(); });
assert.match(text(tour.toJSON()), /SAMPLE — NOT VALID/);
await act(async () => { button(tour, 'Finish tour').props.onClick(); });
assert.equal(exits, 1);
assert.equal(calls.length, before, 'sample actions must not perform network requests');
await dispose(tour);

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
console.log('Practice launch: scopes, fail-closed guard, roles, resume, contract, price preservation, duplicate submission and six-step no-business-write tour passed.');