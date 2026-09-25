import * as React from 'react';
import assert from 'node:assert/strict';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession as setToken } from './invite-stubs/supabase';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession } from './a11y-stubs/session';
import { OfficeAccessContent, PaymentMethodForm } from '../src/components/billing/OfficeAccessSetup';
import { launchRecoveryPath } from '../src/pages/PracticeLaunch';
import type { OfficeAccessSnapshot } from '../src/lib/billing-types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
setToken('fixture');
__setScope(null);
let duplicate = false;
const calls: Array<{ url: string; method: string; scope: string | null }> = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? 'GET', scope: new Headers(init?.headers).get('X-Billing-Scope') });
  if (url.includes('/api/office/launch')) return json({ billingScope: 'scope-fixture' });
  if (url.includes('/billing/office/status')) return json({ account: null, oauth_available: true });
  if (url.includes('/billing/office/connect/create')) return json({ account: { stripe_account_id: 'acct_new' } }, 201);
  return duplicate ? json({ error: 'Duplicate card', code: 'duplicate_card' }, 409) : json(base);
};
const base: OfficeAccessSnapshot = {
  office: { providerId: 'one', officeName: 'Heritage Practice' }, complete: false, connectAlreadyDone: true,
  steps: ['connect', 'bank', 'card_primary', 'card_backup', 'plan', 'disclosure'].map((id) => ({ id: id as any, status: id === 'bank' ? 'pending' : 'done', detail: null })),
  connect: { state: 'ready', sandbox: true },
  instruments: [
    { slot: 'bank', kind: 'bank', brand: null, last4: '6789', expMonth: null, expYear: null, bankName: 'Heritage Bank', verificationStatus: 'pending', verificationDeadline: '2026-02-03T00:00:00Z', addedAt: '2026-01-01T00:00:00Z' },
    { slot: 'card_primary', kind: 'card', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030, bankName: null, verificationStatus: 'verified', verificationDeadline: null, addedAt: '2026-01-01T00:00:00Z' },
    { slot: 'card_backup', kind: 'card', brand: 'mastercard', last4: '4444', expMonth: 5, expYear: 2031, bankName: null, verificationStatus: 'verified', verificationDeadline: null, addedAt: '2026-01-02T00:00:00Z' },
  ],
  plan: { selected: null, monthlyPriceCents: 23456, yearlyPriceCents: 234560, priceCents: 23456, firstChargeAt: '2027-04-05T00:00:00Z', includedPeriodDays: 365, nextPeriodEndsAt: null },
  disclosure: { text: 'HQ authored words.', version: 7, acknowledgedAt: null },
  bank: { verificationPending: true, deadline: '2026-02-03T00:00:00Z', overdue: false, windowHours: 48, verificationUrl: 'https://stripe.test/verify' },
  balance: { state: 'included_period', outstanding: false, amountCents: 0, graceEndsAt: null },
  canManage: true, canChoosePlan: false,
};
const text = (node: any): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node?.children ? text(node.children) : '';
const render = async (child: React.ReactNode) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<QueryClientProvider client={client}><Router hook={memoryLocation().hook}>{child}</Router></QueryClientProvider>); });
  return { root, client };
};

assert.equal(launchRecoveryPath('/patients/anything'), false, 'arbitrary routes remain absolutely gated');
let result = await render(<OfficeAccessContent snapshot={base} refresh={() => {}} />);
let output = text(result.root.toJSON());
assert.match(output, /Bank verification is pending/);
assert.match(output, /48\s+hours/);
assert.match(output, /February 3, 2026/);
assert.match(output, /\$234\.56/);
assert.match(output, /April 5, 2027/);
await act(async () => result.root.unmount()); result.client.clear();

// A brand-new office has no Stripe account, so the embedded onboarding cannot
// load yet: the owner must be offered both ways to get one right here.
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'owner-1' }, staffSession: { staffKind: 'provider' } });
result = await render(<OfficeAccessContent snapshot={{ ...base, connectAlreadyDone: false, connect: { state: 'not_started', sandbox: true } }} refresh={() => {}} />);
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
output = text(result.root.toJSON());
assert.doesNotMatch(output, /Loading secure Stripe tools|managed in the Stripe Dashboard/, 'no embedded tools before an account exists');
assert.doesNotMatch(output, /Refresh connection status/, 'nothing to refresh before an account exists');
const oauthStart = result.root.root.findAll((node) => node.props['data-testid'] === 'button-oauth-start' && typeof node.type === 'string');
assert.equal(oauthStart.length, 1, 'existing-account (OAuth) option is offered on the setup screen');
const createButton = result.root.root.findAll((node) => node.props['data-testid'] === 'button-create-account' && typeof node.type === 'string')[0];
assert.ok(createButton, 'new-account option is offered on the setup screen');
assert.equal(createButton.props.disabled, false, 'new-account option is enabled once the billing scope loads');
await act(async () => { createButton.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 20)); });
const createCall = calls.find((call) => call.url.includes('/billing/office/connect/create'));
assert.ok(createCall && createCall.method === 'POST', 'Start setup creates the connected account');
assert.equal(createCall.scope, 'scope-fixture', 'account creation carries the launch billing scope');
await act(async () => result.root.unmount()); result.client.clear();
__setSession({ authStatus: 'signed-out', authRole: null, authUser: null, staffSession: null });

result = await render(<OfficeAccessContent snapshot={{ ...base, bank: { ...base.bank, overdue: true } }} refresh={() => {}} />);
assert.match(text(result.root.toJSON()), /Bank verification is overdue/);
await act(async () => result.root.unmount()); result.client.clear();

result = await render(<OfficeAccessContent snapshot={base} refresh={() => {}} management />);
const replace = result.root.root.findAllByType('button').find((button) => text(button.props.children) === 'Replace primary card');
assert.ok(replace, 'non-owner staff can replace a card when canManage is true');
await act(async () => result.root.unmount()); result.client.clear();

duplicate = true;
result = await render(<PaymentMethodForm slot="card_backup" setupIntentId="seti_1" onDone={() => {}} onCancel={() => {}} />);
const save = result.root.root.findAllByType('button').find((button) => text(button.props.children) === 'Save payment method')!;
await act(async () => { save.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 10)); });
assert.match(text(result.root.toJSON()), /same card as the first card/i);
await act(async () => result.root.unmount()); result.client.clear();

console.log('Office access: absolute gate, first-run Stripe connect choice, duplicate card, bank window/overdue, real plan terms, and staff card management passed.');