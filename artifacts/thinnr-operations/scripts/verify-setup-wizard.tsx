import * as React from 'react';
import assert from 'node:assert/strict';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as setToken } from './invite-stubs/supabase';
import { __setHqData } from './a11y-stubs/hq-data';
import { __stripeStub } from './a11y-stubs/stripe-react';
import { PracticeLaunchGuard, wizardEligible } from '../src/pages/PracticeLaunch';
import { firstUnfinishedStep, nextStep, previousStep } from '../src/components/launch/wizard/steps';
import { DUPLICATE_CARD_MESSAGE } from '../src/components/launch/wizard/PaymentStep';
import type { LaunchState } from '../src/hooks/use-launch';
import type { OfficeAccessSnapshot } from '../src/lib/billing-types';

/**
 * The first-time setup wizard, rendered through the real practice-launch
 * guard against a scripted server: routing, resume, security auto-skip, both
 * Stripe paths and switching (including the locked case), the required plan,
 * card collection with duplicate rejection, activation and the finish screen.
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const assigned: string[] = [];
let reducedMotion = false;
(globalThis as any).window = {
  matchMedia: (query: string) => ({ matches: reducedMotion && query.includes('reduced-motion'), addEventListener: () => {}, removeEventListener: () => {} }),
  getSelection: () => '', scrollTo: () => {},
  location: { assign: (url: string) => { assigned.push(url); }, search: '' },
};
setToken('fixture');
__setScope(null);
__setHqData({ accounts: [], canManageProviderAccounts: false });
const owner = { authStatus: 'signed-in', authRole: 'provider_staff', staffSession: { role: 'owner', staffKind: 'provider', providerId: 'fixture', idleTimeoutMinutes: 15, idleTimeoutSource: 'hq', freshCode: { needed: false } }, authUser: { id: 'owner-fixture' }, signOut() {} };
__setSession(owner);

const baseLaunch: LaunchState = {
  billingScope: 'test:acct_fixture', office: { providerId: 'fixture', officeName: 'Sample Practice' },
  canEdit: true, required: true, fullSetupRequired: true, version: 3, detailsConfirmed: false, productsConfirmed: true, completedAt: null,
  details: { officeName: 'Sample Practice', providerName: 'Sample Owner', email: 'owner@example.invalid', phone: '6175550123', address1: '1 Sample Street', address2: '', city: 'Boston', state: 'MA', postalCode: '02108' },
  security: { ready: true, emailVerified: true, phoneVerified: false, phoneRequired: false, phoneMasked: null },
  payments: { state: 'not_started', sandbox: true }, products: [],
};
const bankItem = { slot: 'bank', kind: 'bank', brand: null, last4: '6789', expMonth: null, expYear: null, bankName: 'Sample Bank', verificationStatus: 'verified', verificationDeadline: null, addedAt: '2026-09-01T00:00:00Z' } as const;
const cardItem = (slot: 'card_primary' | 'card_backup', last4: string) => ({ slot, kind: 'card', brand: 'visa', last4, expMonth: 4, expYear: 2030, bankName: null, verificationStatus: 'verified', verificationDeadline: null, addedAt: '2026-09-01T00:00:00Z' } as const);
const baseAccess: OfficeAccessSnapshot = {
  office: baseLaunch.office, complete: false, connectAlreadyDone: false,
  steps: ['connect', 'bank', 'card_primary', 'card_backup', 'plan', 'disclosure'].map((id) => ({ id: id as any, status: 'pending', detail: null })),
  connect: { state: 'not_started', sandbox: true }, instruments: [],
  plan: { selected: null, monthlyPriceCents: 20000, yearlyPriceCents: 200000, priceCents: null as any, firstChargeAt: null, includedPeriodDays: 365, nextPeriodEndsAt: null },
  disclosure: { text: 'HQ authored access terms.', version: 4, acknowledgedAt: null },
  bank: { verificationPending: false, deadline: null, overdue: false, windowHours: 48, verificationUrl: null },
  balance: { state: 'included_period', outstanding: false, amountCents: 0, graceEndsAt: null },
  canManage: true, canChoosePlan: true,
};

let launch = structuredClone(baseLaunch);
let access = structuredClone(baseAccess);
let account: any = null;
let restartLocked = false;
let planFails = false;
let planGate: Promise<void> | null = null;
const calls: { url: string; method: string; body: any; scope: string | null }[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, method, body, scope: new Headers(init?.headers).get('X-Billing-Scope') });
  if (url.startsWith('/api/office/launch/details')) { launch.detailsConfirmed = true; launch.details = { ...launch.details, ...body.details }; launch.version++; return json(launch); }
  if (url.startsWith('/api/office/launch/complete')) { launch.completedAt = '2026-09-25T12:00:00Z'; launch.version++; access.plan.firstChargeAt = '2027-09-25T12:00:00Z'; return json(launch); }
  if (url.startsWith('/api/office/launch')) return json(launch);
  if (url.startsWith('/api/billing/office/status')) return json({ account, oauth_available: true });
  if (url.startsWith('/api/billing/office/connect/create')) {
    launch.payments.state = 'action_required';
    account = { stripe_account_id: 'acct_new', origin: 'created', business_name: null };
    return json({ account }, 201);
  }
  if (url.startsWith('/api/billing/office/connect/restart')) {
    if (restartLocked) return json({ error: 'This Stripe account already has payments moving through it.' }, 409);
    launch.payments.state = 'not_started'; account = null;
    return json({ restarted: true });
  }
  if (url.startsWith('/api/billing/office/connect/oauth/start')) return json({ url: 'https://connect.stripe.test/oauth/authorize' });
  if (url.startsWith('/api/billing/office/access/plan')) {
    if (planGate) await planGate;
    if (planFails) return json({ error: 'Plan could not be saved' }, 500);
    access.plan.selected = body.plan;
    access.plan.priceCents = body.plan === 'monthly' ? 20000 : 200000;
    return json(access);
  }
  if (url.startsWith('/api/billing/office/access/setup-intent')) return json({ clientSecret: `seti_secret_${body.slot}`, setupIntentId: `seti_${body.slot}`, publishableKey: 'pk_test_fixture' });
  if (url.startsWith('/api/billing/office/access/instruments')) {
    if (body.slot === 'card_backup' && body.paymentMethodId === 'pm_same') return json({ error: 'Duplicate card', code: 'duplicate_card' }, 409);
    access.instruments = [...access.instruments.filter((item) => item.slot !== body.slot),
      body.slot === 'bank' ? { ...bankItem } : cardItem(body.slot, body.slot === 'card_primary' ? '4242' : '1881')] as any;
    return json(access);
  }
  if (url.startsWith('/api/billing/office/access/disclosure')) { access.disclosure.acknowledgedAt = '2026-09-25T12:00:00Z'; return json(access); }
  if (url.startsWith('/api/billing/office/access')) return json(access);
  if (url.includes('/offboarding')) return json({ offboarding: { seal: { startedAt: null, completedAt: null } } });
  return json({});
};

const text = (node: any): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node?.children ? text(node.children) : '';
const tick = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const byTestId = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => typeof node.type === 'string' && node.props['data-testid'] === id)[0];
const press = async (root: ReactTestRenderer, id: string, ms = 30) => {
  const node = byTestId(root, id);
  assert.ok(node, `${id} is on screen`);
  assert.notEqual(node.props.disabled, true, `${id} is enabled`);
  await act(async () => { node.props.onClick(); });
  await tick(ms);
};
const currentStep = (root: ReactTestRenderer) => ['details', 'security', 'connect', 'plan', 'payment', 'review', 'done']
  .find((step) => byTestId(root, `wizard-step-${step}`));
let mounted = 0;
function RealOperations() { mounted++; return <p>REAL OPERATIONS</p>; }
async function render(path = '/patients') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path, record: true });
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<QueryClientProvider client={client}><Router hook={location.hook} searchHook={location.searchHook}><PracticeLaunchGuard><RealOperations /></PracticeLaunchGuard></Router></QueryClientProvider>); });
  await tick(40);
  return { root, client, location };
}
async function dispose(root: ReactTestRenderer, client: QueryClient) { await act(async () => root.unmount()); client.clear(); }
const reset = (launchPatch: Partial<LaunchState> = {}, accessPatch: Partial<OfficeAccessSnapshot> = {}) => {
  launch = { ...structuredClone(baseLaunch), ...structuredClone(launchPatch) } as LaunchState;
  access = { ...structuredClone(baseAccess), ...structuredClone(accessPatch) } as OfficeAccessSnapshot;
  account = null; restartLocked = false; planFails = false; planGate = null; calls.length = 0; assigned.length = 0; mounted = 0;
};

// ---- Routing: only first-time full setup gets the wizard ----
assert.equal(wizardEligible(baseLaunch), true);
assert.equal(wizardEligible({ ...baseLaunch, fullSetupRequired: false }), false, 'partial-setup offices keep the practice setup page');
assert.equal(wizardEligible({ ...baseLaunch, completedAt: '2026-01-01T00:00:00Z' }), false, 'finished offices keep the practice setup page');
reset({ fullSetupRequired: false });
let view = await render();
assert.equal(byTestId(view.root, 'setup-wizard'), undefined, 'a partial-setup office is not sent to the wizard');
await dispose(view.root, view.client);
reset({ completedAt: '2026-01-01T00:00:00Z' });
view = await render();
assert.equal(byTestId(view.root, 'setup-wizard'), undefined);
assert.equal(mounted > 0, true, 'a finished office reaches the app');
await dispose(view.root, view.client);

// ---- Step order logic ----
{
  const facts = { launch: structuredClone(baseLaunch), access: structuredClone(baseAccess) };
  assert.equal(firstUnfinishedStep(facts), 'details');
  assert.equal(nextStep('details', facts, false), 'connect', 'security that is ready is skipped going forward');
  assert.equal(nextStep('details', facts, true), 'security', 'read-only viewers can still look at every screen');
  assert.equal(previousStep('connect'), 'security');
  facts.launch.security = { ...facts.launch.security, ready: false, phoneRequired: true };
  assert.equal(nextStep('details', facts, false), 'security');
}

// ---- A fresh office: details → (security auto-skipped) → connect ----
reset();
view = await render('/patients');
assert.equal(mounted, 0, 'the app never mounts behind the wizard');
assert.ok(byTestId(view.root, 'setup-wizard'), 'a new office lands in the wizard');
assert.equal(view.location.history!.at(-1), '/setup', 'the wizard lives at /setup');
assert.equal(currentStep(view.root), 'details');
assert.match(text(view.root.toJSON()), /Setting up\s+Sample Practice/);
const securityDot = view.root.root.findAll((node) => node.type === 'li' && node.props['data-step'] === 'security')[0];
assert.equal(securityDot.props['data-done'], 'true', 'ready security already shows as finished in the step indicator');
assert.equal(byTestId(view.root, 'wizard-detail-city').props.value, 'Boston');
await act(async () => { byTestId(view.root, 'wizard-detail-city').props.onChange({ target: { value: 'Cambridge' } }); });
await press(view.root, 'wizard-continue', 40);
const detailsCall = calls.find((call) => call.url.startsWith('/api/office/launch/details'))!;
assert.equal(detailsCall.method, 'PUT');
assert.equal(detailsCall.body.details.city, 'Cambridge');
assert.equal(detailsCall.body.expectedVersion, 3);
assert.equal(currentStep(view.root), 'connect', 'security that is already set is skipped automatically');
assert.ok(byTestId(view.root, 'wizard-connect-new') && byTestId(view.root, 'wizard-connect-existing'), 'both Stripe choices are offered');
assert.equal(byTestId(view.root, 'wizard-continue').props.disabled, true, 'Continue waits for a Stripe choice');
await press(view.root, 'wizard-back');
assert.equal(currentStep(view.root), 'details', 'Back skips the finished security screen too');
await dispose(view.root, view.client);

// ---- Security that still needs a texted code is handled in the wizard ----
reset({ detailsConfirmed: true, security: { ready: false, emailVerified: true, phoneVerified: false, phoneRequired: true, phoneMasked: null } });
view = await render();
assert.equal(currentStep(view.root), 'security', 'resume lands on the first unfinished step');
assert.ok(byTestId(view.root, 'input-launch-phone'), 'the phone is verified right here');
assert.equal(byTestId(view.root, 'wizard-continue').props.disabled, true);
assert.equal(byTestId(view.root, 'wizard-security-done'), undefined);
await dispose(view.root, view.client);

// ---- New Stripe account in-page, then switch to an existing one ----
reset({ detailsConfirmed: true });
view = await render();
assert.equal(currentStep(view.root), 'connect');
await press(view.root, 'wizard-connect-new', 60);
const createCall = calls.find((call) => call.url.startsWith('/api/billing/office/connect/create'))!;
assert.equal(createCall.method, 'POST');
assert.equal(createCall.scope, 'test:acct_fixture', 'account creation carries the billing scope');
assert.ok(byTestId(view.root, 'wizard-connect-embed'), 'Stripe onboarding is embedded on this page');
assert.match(text(view.root.toJSON()), /Loading secure Stripe setup/, 'a branded loading screen shows while Stripe loads');
assert.equal(assigned.length, 0, 'creating a new account never leaves the page');
await press(view.root, 'wizard-connect-switch-existing-ask');
assert.match(text(view.root.toJSON()), /cancels the unfinished new account/);
await press(view.root, 'wizard-connect-switch-existing-confirm', 60);
assert.ok(calls.some((call) => call.url.startsWith('/api/billing/office/connect/restart') && call.method === 'POST' && call.scope === 'test:acct_fixture'), 'switching cancels the unfinished account first');
assert.deepEqual(assigned, ['https://connect.stripe.test/oauth/authorize'], 'then makes the one trip to Stripe sign-in');
await dispose(view.root, view.client);

// ---- Switching is locked once the account has financial history ----
reset({ detailsConfirmed: true, payments: { state: 'action_required', sandbox: true } });
account = { stripe_account_id: 'acct_busy', origin: 'created', business_name: null };
restartLocked = true;
view = await render();
await press(view.root, 'wizard-connect-switch-existing-ask');
await press(view.root, 'wizard-connect-switch-existing-confirm', 60);
assert.ok(byTestId(view.root, 'wizard-connect-locked'), 'a refused restart locks switching');
assert.match(text(view.root.toJSON()), /payments moving through it/);
assert.match(text(view.root.toJSON()), /contact THINNR support/);
assert.equal(assigned.length, 0, 'a locked account never sends the office to Stripe sign-in');
await dispose(view.root, view.client);

// ---- Coming back from Stripe sign-in without finishing ----
reset({ detailsConfirmed: true });
view = await render('/payments/get-paid?error=Stripe%20sign-in%20was%20cancelled');
assert.equal(currentStep(view.root), 'connect', 'the OAuth return reopens the connect step');
assert.equal(view.location.history!.at(-1), '/setup', 'the one-shot result is removed from the address bar');
assert.ok(byTestId(view.root, 'wizard-connect-signin-failed'));
assert.match(text(view.root.toJSON()), /Stripe sign-in was cancelled/);
assert.ok(byTestId(view.root, 'wizard-connect-retry-signin'), '"Try signing in again" is offered');
await press(view.root, 'wizard-connect-create-instead', 60);
assert.ok(calls.some((call) => call.url.startsWith('/api/billing/office/connect/create')), '"Create a new account instead" creates one here');
assert.ok(byTestId(view.root, 'wizard-connect-embed'));
await dispose(view.root, view.client);

// ---- Submitted Stripe account: move on to the plan, which is required ----
reset({ detailsConfirmed: true, payments: { state: 'pending', sandbox: true } });
account = { stripe_account_id: 'acct_new', origin: 'created', business_name: null };
view = await render();
assert.equal(currentStep(view.root), 'plan', 'a submitted Stripe account resumes at the plan');
await press(view.root, 'wizard-back');
assert.ok(byTestId(view.root, 'wizard-connect-pending'));
assert.ok(byTestId(view.root, 'wizard-connect-locked'), 'a submitted account can no longer be switched here');
await press(view.root, 'wizard-continue');
assert.equal(currentStep(view.root), 'plan');
assert.equal(byTestId(view.root, 'wizard-continue').props.disabled, true, 'a plan must be chosen before continuing');
assert.match(text(byTestId(view.root, 'wizard-plan-savings')), /\$400/, 'the yearly savings are called out');
// Instant selected state while the save is still in flight.
let release!: () => void;
planGate = new Promise((resolve) => { release = resolve; });
await act(async () => { byTestId(view.root, 'wizard-plan-yearly').props.onClick(); });
assert.equal(byTestId(view.root, 'wizard-plan-yearly').props['data-selected'], 'true', 'the pick shows immediately');
assert.equal(byTestId(view.root, 'wizard-continue').props.disabled, true, 'Continue waits for the server to keep the choice');
await act(async () => { release(); });
await tick(40);
planGate = null;
assert.equal(access.plan.selected, 'yearly');
assert.equal(byTestId(view.root, 'wizard-plan-yearly').props['data-selected'], 'true');
assert.match(text(byTestId(view.root, 'wizard-plan-terms')), /Free access: 365 days\. Your first charge of \$2,000/);
// A failed save puts the old choice back.
planFails = true;
await act(async () => { byTestId(view.root, 'wizard-plan-monthly').props.onClick(); });
await tick(40);
assert.equal(byTestId(view.root, 'wizard-plan-monthly').props['data-selected'], 'false', 'a failed save reverts the pick');
assert.equal(byTestId(view.root, 'wizard-plan-yearly').props['data-selected'], 'true');
planFails = false;
await press(view.root, 'wizard-continue');
assert.equal(currentStep(view.root), 'payment');

// ---- Payment details: bank + first card, backup card in its own section ----
assert.match(text(byTestId(view.root, 'wizard-no-charge')), /Nothing is charged until your free access ends/);
assert.match(text(byTestId(view.root, 'wizard-no-charge')), /365\s+days/);
assert.ok(byTestId(view.root, 'wizard-backup-section'), 'the backup card has its own section');
assert.doesNotMatch(text(view.root.toJSON()), /cancel anytime/i, 'no cancellation promise the terms do not make');
assert.equal(byTestId(view.root, 'wizard-continue').props.disabled, true);
await press(view.root, 'wizard-add-bank');
assert.match(text(byTestId(view.root, 'wizard-bank-form')), /Secure Stripe Payment Element/, 'the bank uses Stripe\'s embedded bank flow');
await press(view.root, 'wizard-save-bank', 40);
assert.ok(calls.some((call) => call.url.startsWith('/api/billing/office/access/instruments') && call.body.slot === 'bank' && call.body.setupIntentId === 'seti_bank'));
await press(view.root, 'wizard-add-card_primary');
const cardForm = text(byTestId(view.root, 'wizard-card-form-card_primary'));
assert.match(cardForm, /Card number field/);
assert.doesNotMatch(cardForm, /Payment Element/, 'cards use card-only fields');
await press(view.root, 'wizard-save-card_primary', 40);
assert.deepEqual(__stripeStub.cardSetups.at(-1), { clientSecret: 'seti_secret_card_primary' });
assert.ok(byTestId(view.root, 'wizard-instrument-card_primary'));
__stripeStub.paymentMethod = 'pm_same';
await press(view.root, 'wizard-add-card_backup');
await press(view.root, 'wizard-save-card_backup', 40);
assert.match(text(view.root.toJSON()), new RegExp(DUPLICATE_CARD_MESSAGE.replace(/\./g, '\\.')), 'the backup cannot be the first card');
assert.equal(byTestId(view.root, 'wizard-continue').props.disabled, true);
__stripeStub.paymentMethod = 'pm_fixture';
await press(view.root, 'wizard-save-card_backup', 40);
assert.ok(byTestId(view.root, 'wizard-instrument-card_backup'));
await press(view.root, 'wizard-continue');
assert.equal(currentStep(view.root), 'review');

// ---- Review, activate, finish ----
assert.match(text(byTestId(view.root, 'wizard-disclosure')), /HQ authored access terms/);
const summary = text(byTestId(view.root, 'wizard-review-summary'));
assert.match(summary, /Yearly/);
assert.match(summary, /ending in\s+6789/);
assert.match(summary, /ending in\s+4242/);
assert.match(summary, /ending in\s+1881/);
assert.equal(byTestId(view.root, 'wizard-activate').props.disabled, true, 'terms must be accepted first');
await dispose(view.root, view.client);

// Stripe still verifying (pending) is enough to activate; an unsubmitted account is not.
launch.payments.state = 'action_required';
view = await render();
assert.equal(currentStep(view.root), 'connect', 'an unsubmitted Stripe account sends the office back to connect');
await dispose(view.root, view.client);
launch.payments.state = 'pending';
view = await render();
assert.equal(currentStep(view.root), 'review', 'everything but activation done resumes at review');
assert.equal(byTestId(view.root, 'wizard-activate').props.disabled, true, 'terms must be accepted first');
await act(async () => { byTestId(view.root, 'wizard-acknowledge').props.onChange({ target: { checked: true } }); });
await press(view.root, 'wizard-activate', 60);
const disclosureCall = calls.find((call) => call.url.startsWith('/api/billing/office/access/disclosure'))!;
assert.deepEqual(disclosureCall.body, { version: 4 });
const completeCall = calls.find((call) => call.url.startsWith('/api/office/launch/complete'))!;
assert.equal(completeCall.method, 'POST');
assert.equal(completeCall.scope, 'test:acct_fixture');
assert.ok(calls.indexOf(disclosureCall) < calls.indexOf(completeCall), 'terms are recorded before activation');
assert.equal(currentStep(view.root), 'done', '"You\'re all set" follows activation');
assert.equal(mounted, 0, 'the finish screen stays until the office moves on');
assert.match(text(view.root.toJSON()), /You're all set/);
assert.match(text(view.root.toJSON()), /Suggested prices are saved/);
await press(view.root, 'wizard-enter-app', 40);
assert.equal(byTestId(view.root, 'setup-wizard'), undefined);
assert.ok(mounted > 0, 'the office enters the app');
assert.equal(view.location.history!.at(-1), '/');
assert.ok(byTestId(view.root, 'setup-handoff'), 'the "configuring your account" hand-off covers the dashboard after the finish screen');
await dispose(view.root, view.client);

// ---- Read-only: non-owner staff and HQ inspection ----
reset({ canEdit: false, detailsConfirmed: true });
view = await render();
assert.equal(currentStep(view.root), 'details', 'read-only viewers start at the beginning');
assert.ok(byTestId(view.root, 'wizard-read-only'));
await press(view.root, 'wizard-continue');
assert.equal(currentStep(view.root), 'security', 'read-only viewers can page through every screen');
await press(view.root, 'wizard-continue');
assert.equal(byTestId(view.root, 'wizard-connect-new').props.disabled, true, 'read-only viewers cannot start Stripe setup');
await dispose(view.root, view.client);

reset({ canEdit: false, hqInspection: true } as Partial<LaunchState>);
view = await render('/patients');
assert.equal(byTestId(view.root, 'setup-wizard'), undefined, 'HQ inspecting an office reads its workspace');
assert.ok(mounted > 0);
await dispose(view.root, view.client);
view = await render('/setup');
assert.ok(byTestId(view.root, 'setup-wizard'), 'HQ sees the wizard at /setup');
assert.ok(byTestId(view.root, 'wizard-read-only'));
assert.match(text(byTestId(view.root, 'wizard-read-only')), /HQ|THINNR/);
await dispose(view.root, view.client);

// ---- Reduced motion ----
reset({ detailsConfirmed: true });
reducedMotion = true;
view = await render();
assert.equal(currentStep(view.root), 'connect');
reducedMotion = false;
await dispose(view.root, view.client);

console.log('Setup wizard: routing, step order and resume, security auto-skip, new/existing Stripe paths with switching and lock, OAuth return, required optimistic plan, bank/card collection with duplicate rejection, activation, finish, and read-only views passed.');
