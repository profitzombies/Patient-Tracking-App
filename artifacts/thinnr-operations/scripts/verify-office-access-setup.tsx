import * as React from 'react';
import assert from 'node:assert/strict';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession as setToken } from './invite-stubs/supabase';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession } from './a11y-stubs/session';
import { OfficeAccessContent, OfficeAccessSetup, PaymentMethodForm } from '../src/components/billing/OfficeAccessSetup';
import { launchRecoveryPath } from '../src/pages/PracticeLaunch';
import { __stripeStub } from './a11y-stubs/stripe-react';
import type { OfficeAccessSnapshot } from '../src/lib/billing-types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
setToken('fixture');
__setScope(null);
let duplicate = false;
// Writes to plan/disclosure/pay can be held open (to see the working state)
// and refused (to see the rollback).
let served: OfficeAccessSnapshot | null = null;
let held: Promise<void> | null = null;
let refuse = false;
const hold = () => { let release!: () => void; held = new Promise<void>((resolve) => { release = resolve; }); return () => { held = null; release(); }; };
const calls: Array<{ url: string; method: string; scope: string | null }> = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? 'GET', scope: new Headers(init?.headers).get('X-Billing-Scope') });
  if (url.includes('/api/office/launch')) return json({ billingScope: 'scope-fixture' });
  if (url.includes('/billing/office/status')) return json({ account: null, oauth_available: true });
  if (url.includes('/billing/office/connect/create')) return json({ account: { stripe_account_id: 'acct_new' } }, 201);
  if (served && /\/access\/(plan|disclosure|pay)/.test(url)) {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (held) await held;
    if (refuse) return json({ error: 'Another session changed setup' }, 409);
    if (url.includes('/access/plan')) served = { ...served, plan: { ...served.plan, selected: body.plan } };
    if (url.includes('/access/disclosure')) served = { ...served, disclosure: { ...served.disclosure, acknowledgedAt: '2026-01-05T00:00:00Z' } };
    return json(served);
  }
  if (served && url.includes('/billing/office/access')) return json(served);
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
// A button's visible wording, read from the rendered tree (labels sit inside BusyLabel).
const label = (button: any) => text(button.children).replace(/\s+/g, ' ').trim();
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

// ---- Payment methods page: Replace only, names shown, staged bank explained ----
const named: OfficeAccessSnapshot = {
  ...base,
  instruments: base.instruments.map((item) => ({ ...item, holderName: item.slot === 'bank' ? 'Heritage Practice LLC' : 'Ada Lane' })),
};
result = await render(<OfficeAccessContent snapshot={named} refresh={() => {}} management />);
const managementButtons = result.root.root.findAllByType('button').map(label);
for (const title of ['Replace bank account', 'Replace primary card', 'Replace backup card']) {
  assert.ok(managementButtons.includes(title), `${title} is offered (non-owner staff with canManage)`);
}
assert.ok(managementButtons.every((name) => !/remove|delete|detach/i.test(name)), `no remove/delete action anywhere: ${managementButtons.join(' | ')}`);
output = text(result.root.toJSON());
output = output.replace(/\s+/g, ' ').replace(/ ([:·,.]) /g, '$1 ').replace(/ ([:,.])/g, '$1');
assert.match(output, /always keeps one bank account and two different cards/, 'the page says why there is no delete');
assert.match(output, /Name on account: Heritage Practice LLC/, 'bank shows the account-holder name');
assert.match(output, /visa •••• 4242· expires 04\/2030/, 'card shows brand, last four and expiry');
assert.match(output, /Name on card: Ada Lane/, 'card shows the cardholder name');
await act(async () => result.root.unmount()); result.client.clear();

result = await render(<OfficeAccessContent management refresh={() => {}} snapshot={{
  ...named,
  bank: { ...named.bank, verificationPending: true, replacement: { bankName: 'New Bank', last4: '1111', holderName: 'Heritage Practice LLC', deadline: '2026-02-10T00:00:00Z', verificationUrl: 'https://stripe.test/verify', addedAt: '2026-02-01T00:00:00Z' } },
}} />);
output = text(result.root.toJSON()).replace(/\s+/g, ' ');
assert.match(output, /Replacement bank waiting on test deposits/, 'a staged bank is shown beside the bank in service');
assert.match(output, /New Bank •••• 1111/, 'the staged bank is identified');
assert.match(output, /current bank stays on file and is still charged/, 'the office is told the current bank keeps working');
assert.doesNotMatch(output, /You may keep using the dashboard for/, 'the bank in service is not presented as pending');
await act(async () => result.root.unmount()); result.client.clear();

// ---- The holder name and email pre-fill, stay editable, and reach Stripe ----
result = await render(<PaymentMethodForm slot="card_primary" setupIntentId="seti_1" replacing management billingDefaults={{ name: 'Heritage Practice', email: 'owner@heritage.test' }} onDone={() => {}} onCancel={() => {}} />);
const nameInput = () => result.root.root.findAll((node) => node.type === 'input' && node.props.id === 'access-card_primary-holder-name')[0];
const emailInput = () => result.root.root.findAll((node) => node.type === 'input' && node.props.id === 'access-card_primary-holder-email')[0];
assert.equal(nameInput().props.value, 'Heritage Practice', 'name pre-fills from the practice');
assert.equal(emailInput().props.value, 'owner@heritage.test', 'email pre-fills from the practice');
await act(async () => { nameInput().props.onChange({ target: { value: '' } }); });
const saveReplacement = () => result.root.root.findAllByType('button').find((button) => label(button) === 'Save replacement card')!;
__stripeStub.setups.length = 0;
await act(async () => { saveReplacement().props.onClick(); await new Promise((resolve) => setTimeout(resolve, 10)); });
assert.match(text(result.root.toJSON()), /Enter the name on the card/, 'an empty holder name is refused before Stripe');
assert.equal(__stripeStub.setups.length, 0, 'nothing is confirmed without a name');
await act(async () => { nameInput().props.onChange({ target: { value: 'Ada Lane' } }); });
await act(async () => { saveReplacement().props.onClick(); await new Promise((resolve) => setTimeout(resolve, 10)); });
assert.deepEqual(__stripeStub.setups[0]?.confirmParams?.payment_method_data?.billing_details, { name: 'Ada Lane', email: 'owner@heritage.test' }, 'the edited name and email are saved on the payment method');
await act(async () => result.root.unmount()); result.client.clear();

duplicate = true;
result = await render(<PaymentMethodForm slot="card_backup" setupIntentId="seti_1" billingDefaults={{ name: 'Heritage Practice', email: 'owner@heritage.test' }} onDone={() => {}} onCancel={() => {}} />);
const save = result.root.root.findAllByType('button').find((button) => label(button) === 'Save payment method')!;
await act(async () => { save.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 10)); });
assert.match(text(result.root.toJSON()), /same card as the first card/i);
await act(async () => result.root.unmount()); result.client.clear();

// ---- Instant feedback: working states, optimistic plan and terms, rollback ----
duplicate = false;
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'owner-1' }, staffSession: { staffKind: 'provider' } });
const byTestId = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => typeof node.type === 'string' && node.props['data-testid'] === id)[0];
const posts = (path: string) => calls.filter((call) => call.method === 'POST' && call.url.includes(path)).length;
const tick = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const busyIn = (node: any) => node.findAll((child: any) => typeof child.type === 'string' && child.props['data-busy'] === 'true').length > 0;
served = { ...base, canChoosePlan: true };
result = await render(<OfficeAccessSetup />);
await tick();
assert.equal(byTestId(result.root, 'access-plan-yearly').props['aria-pressed'], false, 'no plan chosen yet');

// Refused plan: highlighted at once, working state, one request, then rolled back with a reason beside the plan.
let release = hold();
refuse = true;
await act(async () => { byTestId(result.root, 'access-plan-yearly').props.onClick(); byTestId(result.root, 'access-plan-yearly').props.onClick(); });
await tick(5);
assert.equal(byTestId(result.root, 'access-plan-yearly').props['aria-pressed'], true, 'the choice shows the moment it is clicked');
assert.ok(busyIn(byTestId(result.root, 'access-plan-yearly')), 'the chosen plan shows its working state');
assert.equal(byTestId(result.root, 'access-plan-monthly').props.disabled, true, 'no second choice while one is saving');
assert.match(text(result.root.toJSON()), /office price is\s+\$2,345\.60/, 'the office price follows the new plan at once');
assert.equal(posts('/access/plan'), 1, 'a double click sends one request');
await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 20)); });
assert.equal(byTestId(result.root, 'access-plan-yearly').props['aria-pressed'], false, 'a refused plan goes back');
assert.match(text(result.root.toJSON()), /Your plan choice was not saved/);

// Accepted plan stays chosen.
refuse = false;
await act(async () => { byTestId(result.root, 'access-plan-monthly').props.onClick(); await new Promise((resolve) => setTimeout(resolve, 20)); });
assert.equal(byTestId(result.root, 'access-plan-monthly').props['aria-pressed'], true, 'a saved plan stays chosen');
assert.doesNotMatch(text(result.root.toJSON()), /Your plan choice was not saved/, 'the old failure clears on the next save');

// Terms: "Acknowledged" with a check at once; a refusal puts the button back with a reason.
const acknowledgeButton = () => result.root.root.findAllByType('button').find((button) => text(button.props.children) === 'Acknowledge disclosure');
release = hold();
refuse = true;
await act(async () => { acknowledgeButton()!.props.onClick(); });
await tick(5);
assert.ok(byTestId(result.root, 'access-disclosure-acknowledged'), 'acknowledged shows the moment it is clicked');
assert.match(text(byTestId(result.root, 'access-disclosure-acknowledged')), /Saving…/);
await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 20)); });
assert.equal(byTestId(result.root, 'access-disclosure-acknowledged'), undefined, 'a refused acknowledgment goes back');
assert.ok(acknowledgeButton(), 'the office can try again');
assert.match(text(result.root.toJSON()), /Your acceptance was not saved/);
refuse = false;
await act(async () => { acknowledgeButton()!.props.onClick(); await new Promise((resolve) => setTimeout(resolve, 20)); });
assert.ok(byTestId(result.root, 'access-disclosure-acknowledged'), 'a saved acknowledgment stays');
assert.doesNotMatch(text(byTestId(result.root, 'access-disclosure-acknowledged')), /Saving…/);
await act(async () => result.root.unmount()); result.client.clear();

// Paying a balance: working state and a single charge request.
served = { ...base, balance: { state: 'grace', outstanding: true, amountCents: 23456, graceEndsAt: '2026-02-10T00:00:00Z' } as OfficeAccessSnapshot['balance'] };
result = await render(<OfficeAccessSetup management />);
await tick();
const payButton = () => result.root.root.findAllByType('button').find((button) => /Pay|Paying/.test(label(button)))!;
release = hold();
await act(async () => { payButton().props.onClick(); payButton().props.onClick(); });
await tick(5);
assert.ok(busyIn(payButton()) && /Paying…/.test(label(payButton())), 'paying shows its working state');
assert.equal(payButton().props.disabled, true);
assert.equal(posts('/access/pay'), 1, 'a double click charges once');
await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 20)); });
await act(async () => result.root.unmount()); result.client.clear();
served = null;
__setSession({ authStatus: 'signed-out', authRole: null, authUser: null, staffSession: null });

console.log('Office access: instant plan/terms feedback with rollback, single-press working states, absolute gate, first-run Stripe connect choice, duplicate card, bank window/overdue, real plan terms, staff card management, Replace-only payment methods with holder names, and a staged replacement bank passed.');