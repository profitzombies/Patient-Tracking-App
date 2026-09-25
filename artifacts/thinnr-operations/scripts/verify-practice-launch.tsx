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
import { launchKey, useLaunchData, useLaunchWrite, type LaunchState } from '../src/hooks/use-launch';
import { LaunchScreen } from '../src/pages/LaunchScreen';
import { AccountLocksProvider } from '../src/contexts/account-locks';
import { DateRangeProvider } from '../src/contexts/date-range';
import { TrainingDataProvider } from '../src/contexts/training-data';
import AccountDetail from '../src/pages/admin/AccountDetail';
import { greetingName } from '../src/lib/greeting-name';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let reducedMotion = false;
(globalThis as any).window = { matchMedia: (query: string) => ({ matches: reducedMotion && query.includes('reduced-motion'), addEventListener: () => {}, removeEventListener: () => {} }), getSelection: () => '' };
const state: LaunchState = {
  billingScope: 'test:acct_fixture', office: { providerId: 'fixture', officeName: 'Sample Practice' },
  canEdit: true, required: true, fullSetupRequired: true, version: 3, detailsConfirmed: true, productsConfirmed: false, completedAt: null,
  details: { officeName: 'Sample Practice', providerName: 'Sample Owner', email: 'owner@example.invalid', phone: '6175550123', address1: '1 Sample Street', address2: '', city: 'Boston', state: 'MA', postalCode: '02108' },
  security: { ready: true, emailVerified: true, phoneVerified: false, phoneRequired: false, phoneMasked: null }, payments: { state: 'pending', sandbox: true },
  products: [{ productId: 'sample', name: 'Sample Product', enabled: true, sellPriceCents: 9000, suggestedPriceCents: 7198, minimumPriceCents: 4000, subscriptionEnabled: false, subscriptionEligible: true, existingPrice: true, available: true }],
};
let snapshot = structuredClone(state);

const accessSnapshot = {
  office: state.office, complete: true, connectAlreadyDone: true,
  steps: ['connect', 'bank', 'card_primary', 'card_backup', 'plan', 'disclosure'].map((id) => ({ id, status: 'done', detail: null })),
  connect: { state: 'ready', sandbox: true },
  instruments: [
    { slot: 'bank', kind: 'bank', brand: null, last4: '6789', expMonth: null, expYear: null, bankName: 'Sample Bank', verificationStatus: 'verified', verificationDeadline: null, addedAt: '2025-01-01T00:00:00Z' },
    { slot: 'card_primary', kind: 'card', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030, bankName: null, verificationStatus: 'verified', verificationDeadline: null, addedAt: '2025-01-01T00:00:00Z' },
    { slot: 'card_backup', kind: 'card', brand: 'mastercard', last4: '4444', expMonth: 5, expYear: 2031, bankName: null, verificationStatus: 'verified', verificationDeadline: null, addedAt: '2025-01-01T00:00:00Z' },
  ],
  plan: { selected: 'monthly', monthlyPriceCents: 20000, yearlyPriceCents: 200000, priceCents: 20000, firstChargeAt: '2026-01-01T00:00:00Z', includedPeriodDays: 365, nextPeriodEndsAt: null },
  disclosure: { text: 'Sample disclosure.', version: 1, acknowledgedAt: '2025-01-01T00:00:00Z' },
  bank: { verificationPending: false, deadline: null, overdue: false, windowHours: 48, verificationUrl: null },
  balance: { state: 'included_period', outstanding: false, amountCents: 0, graceEndsAt: null },
  canManage: false, canChoosePlan: false,
};
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

  if (call.url.startsWith('/api/billing/office/access')) return new Response(JSON.stringify(accessSnapshot), { status: 200 });
  if (call.url.includes('/second-factor/phone/start')) return new Response(JSON.stringify({ ok: true, requestId: 'req-fixture', destination: '•••-•••-7788', devCode: null }), { status: 200 });
  if (call.url.includes('/second-factor/phone/complete')) {
    snapshot.security = { ready: true, emailVerified: true, phoneVerified: true, phoneRequired: true, phoneMasked: '(•••) •••-7788' };
    return new Response(JSON.stringify({ ok: true, secondFactor: { policyRequired: true, enabled: true, phone: '•••-•••-7788', verifiedAt: '2026-01-01T00:00:00Z' } }), { status: 200 });
  }
  if (call.url.includes('/office/launch/details') && call.method === 'PUT') {
    snapshot.detailsConfirmed = true;
    snapshot.details = { ...snapshot.details, ...call.body.details };
  }

  if (call.url.includes('/office/launch/complete') && call.method === 'POST') snapshot.completedAt = '2026-02-02T00:00:00Z';
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
const scrolls: { step: string; behavior: string }[] = [];
// Only the setup-step scroll targets get a host node; every other ref stays null.
const createNodeMock = (element: { props: Record<string, unknown> }) => typeof element.props['data-setup-step'] === 'string'
  ? { scrollIntoView: (options: { behavior: string }) => scrolls.push({ step: element.props['data-setup-step'] as string, behavior: options.behavior }) }
  : null;
const tick = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const byLabel = (root: ReactTestRenderer, label: string) => root.root.findAll((node) => node.type === 'button' && node.props['aria-label'] === label)[0];
const byTestId = (root: ReactTestRenderer, id: string) => root.root.findAll((node) => typeof node.type === 'string' && node.props['data-testid'] === id)[0];
const stepState = (root: ReactTestRenderer, step: string) => root.root.findAll((node) => node.type === 'section' && node.props['data-setup-step'] === step)[0]?.props['data-state'];
function RealOperations() { mounted++; return <p>REAL OPERATIONS</p>; }
// First-time full setup now walks the step-by-step wizard (its own suite);
// the practice setup page below still serves legacy, partial and finished
// offices, so its behaviour is exercised directly on the same fixtures.
function PracticeSetupPage() {
  const query = useLaunchData();
  return query.data ? <LaunchScreen launchData={query.data} /> : <p>Checking practice setup…</p>;
}
async function render(path = '/patients', page: 'guard' | 'setup-page' = 'guard') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path });
  let root!: ReactTestRenderer;
  const body = page === 'guard' ? <PracticeLaunchGuard><RealOperations /></PracticeLaunchGuard> : <PracticeSetupPage />;
  await act(async () => { root = create(<QueryClientProvider client={client}><Router hook={location.hook}>{body}</Router></QueryClientProvider>, { createNodeMock }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { root, client };
}
async function dispose(root: ReactTestRenderer, client?: QueryClient) { await act(async () => root.unmount()); client?.clear(); }

// Greetings address titled names by title + last name, never a bare "Dr.".
assert.equal(greetingName('Dr. Jason Strotheide'), 'Dr. Strotheide');
assert.equal(greetingName('dr jason strotheide'), 'Dr. strotheide');
assert.equal(greetingName('Jason Strotheide, DC'), 'Jason');
assert.equal(greetingName('Dr. Jason Strotheide DC'), 'Dr. Strotheide');
assert.equal(greetingName('Sarah Jenkins'), 'Sarah');
assert.equal(greetingName('Dr.'), null);
assert.equal(greetingName(''), null);
assert.equal(greetingName(null), null);
assert.equal(launchRecoveryPath('/payments/get-paid'), false);
assert.equal(launchRecoveryPath('/payments/orders'), false);
assert.equal(launchRecoveryPath('/security-bypass'), false);
assert.notDeepEqual(launchKey('a', null), launchKey('b', null));
assert.notDeepEqual(launchKey('a', 'office1'), launchKey('a', 'office2'));

let result = await render();
assert.equal(mounted, 0, 'incomplete setup must not mount operational children');
assert.ok(byTestId(result.root, 'setup-wizard'), 'a first-time full-setup office is routed to the setup wizard');
assert.equal(stepState(result.root, 'details'), undefined, 'the practice setup page is not shown to a first-time office');
await dispose(result.root, result.client);

result = await render('/patients', 'setup-page');
// Already-confirmed details start folded; security that needs nothing more is
// a completed row with no link off the page and no pencil.
assert.equal(stepState(result.root, 'details'), 'folded');
assert.match(text(result.root.toJSON()), /Practice details confirmed/);
assert.equal(stepState(result.root, 'security'), 'folded');
assert.match(text(result.root.toJSON()), /Account security confirmed/);
assert.match(text(result.root.toJSON()), /Email verified · Texted code not required for your role/);
assert.doesNotMatch(text(result.root.toJSON()), /Review account security/);
assert.equal(byTestId(result.root, 'button-setup-step-security-edit'), undefined, 'completed security has no pencil');
assert.ok(byLabel(result.root, 'Edit practice details'), 'confirmed details offer a pencil');
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

// Unconfirmed details start open, fold after a successful confirm, and the
// page moves on to the next unfinished step once the fold has finished.
snapshot = { ...structuredClone(state), detailsConfirmed: false };
scrolls.length = 0;
result = await render('/patients', 'setup-page');
assert.equal(stepState(result.root, 'details'), 'open');
assert.equal(button(result.root, 'Cancel'), undefined, 'nothing confirmed yet to fold back to');
await act(async () => { result.root.root.findAllByType('input')[0].props.onChange({ target: { value: 'Renamed Practice' } }); });
await act(async () => { result.root.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }); });
await tick();
const detailsPut = calls.filter((c) => c.url.includes('/office/launch/details'));
assert.equal(detailsPut.length, 1);
assert.equal(detailsPut[0].body.details.officeName, 'Renamed Practice');
assert.equal(stepState(result.root, 'details'), 'folded', 'confirmed details fold up');
assert.match(text(result.root.toJSON()), /Practice details confirmed/);
assert.match(text(result.root.toJSON()), /3\s+of\s+4\s+essentials confirmed/);
assert.equal(scrolls.length, 0, 'scrolling waits for the fold animation');
await tick(350);
assert.deepEqual(scrolls, [{ step: 'products', behavior: 'smooth' }], 'scrolls to the next unfinished step (security done, Stripe only verifying)');

// Pencil reopens with the saved values; Cancel folds without saving.
await act(async () => { byLabel(result.root, 'Edit practice details').props.onClick({ stopPropagation() {} }); });
assert.equal(stepState(result.root, 'details'), 'open');
assert.equal(result.root.root.findAllByType('input')[0].props.value, 'Renamed Practice');
await act(async () => { result.root.root.findAllByType('input')[0].props.onChange({ target: { value: 'Unsaved draft' } }); });
await act(async () => { button(result.root, 'Cancel').props.onClick(); });
assert.equal(stepState(result.root, 'details'), 'folded');
assert.equal(calls.filter((c) => c.url.includes('/office/launch/details')).length, 1, 'Cancel does not save');
// The folded row itself also reopens; the discarded draft is gone and a
// second confirm folds it back up.
await act(async () => { byTestId(result.root, 'setup-step-details-folded').props.onClick(); });
assert.equal(result.root.root.findAllByType('input')[0].props.value, 'Renamed Practice');
await act(async () => { result.root.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }); });
await tick();
assert.equal(calls.filter((c) => c.url.includes('/office/launch/details')).length, 2);
assert.equal(stepState(result.root, 'details'), 'folded');
await dispose(result.root, result.client);

// Security that is not ready is handled right here: add the phone (formatted,
// "+1" hidden), enter the texted code, then the step folds and the page moves
// on. Reduced motion jumps instantly.
snapshot = { ...structuredClone(state), security: { ready: false, emailVerified: true, phoneVerified: false, phoneRequired: true, phoneMasked: null } };
scrolls.length = 0;
reducedMotion = true;
result = await render('/patients', 'setup-page');
assert.equal(stepState(result.root, 'security'), 'open');
assert.match(text(result.root.toJSON()), /Account security · Action required/);
assert.match(text(result.root.toJSON()), /Email verified at sign-in/);
assert.match(text(result.root.toJSON()), /2\s+of\s+4\s+essentials confirmed/);
assert.equal(byTestId(result.root, 'button-launch-phone-send').props.disabled, true, 'send waits for 10 digits');
await act(async () => { byTestId(result.root, 'input-launch-phone').props.onChange({ target: { value: '+1 555 123 4567' } }); });
assert.equal(byTestId(result.root, 'input-launch-phone').props.value, '(555) 123-4567');
assert.equal(byTestId(result.root, 'button-launch-phone-send').props.disabled, false);
await act(async () => { result.root.root.findAll((node) => node.type === 'form' && node.findAll((child) => child.props['data-testid'] === 'input-launch-phone').length > 0)[0].props.onSubmit({ preventDefault() {} }); });
await tick();
assert.deepEqual(calls.filter((c) => c.url.includes('/phone/start')).at(-1)?.body, { phone: '+15551234567' });
assert.match(text(result.root.toJSON()), /Enter the code texted to\s+•••-•••-7788/);
await act(async () => { byTestId(result.root, 'input-launch-phone-code').props.onChange({ target: { value: '12-34-56' } }); });
assert.equal(byTestId(result.root, 'input-launch-phone-code').props.value, '123456');
await act(async () => { result.root.root.findAll((node) => node.type === 'form' && node.findAll((child) => child.props['data-testid'] === 'input-launch-phone-code').length > 0)[0].props.onSubmit({ preventDefault() {} }); });
await tick(40);
assert.deepEqual(calls.filter((c) => c.url.includes('/phone/complete')).at(-1)?.body, { requestId: 'req-fixture', code: '123456' });
assert.equal(stepState(result.root, 'security'), 'folded', 'verified security folds');
assert.match(text(result.root.toJSON()), /Email verified · Texts to \(•••\) •••-7788/);
assert.match(text(result.root.toJSON()), /3\s+of\s+4\s+essentials confirmed/);
assert.deepEqual(scrolls, [{ step: 'products', behavior: 'auto' }], 'reduced motion jumps without animating');
reducedMotion = false;
await dispose(result.root, result.client);

// Stripe's OAuth callback lands on /payments/get-paid, which this screen
// covers while setup is unfinished: the result must still reach the owner
// and the one-shot query must be dropped so a reload does not repeat it.
snapshot = { ...structuredClone(state), payments: { state: 'not_started', sandbox: true } };
{
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path: '/payments/get-paid?error=access_denied', record: true });
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<QueryClientProvider client={client}><Router hook={location.hook} searchHook={location.searchHook}><PracticeLaunchGuard><RealOperations /></PracticeLaunchGuard></Router></QueryClientProvider>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(mounted, 0, 'an OAuth return does not open the workspace early');
  assert.ok(byTestId(root, 'wizard-connect-signin-failed'), 'the wizard reopens its connect step with the failed sign-in');
  assert.match(text(root.toJSON()), /access_denied/);
  assert.equal(location.history!.at(-1), '/setup', 'the one-shot OAuth result is removed from the URL');
  await dispose(root, client);
}
// The practice setup page (legacy, partial and finished offices) keeps its own notice.
snapshot = structuredClone(state);
{
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path: '/payments/get-paid?error=access_denied', record: true });
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<QueryClientProvider client={client}><Router hook={location.hook} searchHook={location.searchHook}><PracticeSetupPage /></Router></QueryClientProvider>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(text(root.toJSON()), /Stripe connection was not completed:\s+access_denied/);
  assert.equal(location.history!.at(-1), '/payments/get-paid', 'the one-shot OAuth result is removed from the URL');
  await dispose(root, client);
}

failed = true;
result = await render('/patients');
assert.equal(mounted, 0);
assert.match(text(result.root.toJSON()), /could not be loaded/);
await dispose(result.root, result.client);
failed = false;

// Legacy office does not require details/products
snapshot = { ...structuredClone(state), fullSetupRequired: false, payments: { state: 'ready', sandbox: true }, detailsConfirmed: false, productsConfirmed: false };
result = await render();
assert.equal(button(result.root, 'Finish setup').props.disabled, false, 'Legacy office can finish setup without details or products');
assert.match(text(result.root.toJSON()), /2\s+of\s+2\s+essentials confirmed/);
await dispose(result.root, result.client);

// Stripe still verifying ("pending") does not hold the office: Finish setup
// is available, and finishing from /setup takes the owner into the workspace
// instead of leaving them on a screen that looks unchanged.
{
  // A partial-setup office keeps the practice setup page behind the guard
  // (first-time full setup walks the wizard, whose suite covers the same rule).
  snapshot = { ...structuredClone(state), fullSetupRequired: false, productsConfirmed: true, payments: { state: 'pending', sandbox: true } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path: '/setup', record: true });
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<QueryClientProvider client={client}><Router hook={location.hook}><PracticeLaunchGuard><RealOperations /></PracticeLaunchGuard></Router></QueryClientProvider>, { createNodeMock }); });
  await tick();
  assert.match(text(root.toJSON()), /2\s+of\s+2\s+essentials confirmed/);
  assert.equal(button(root, 'Finish setup').props.disabled, false, 'pending Stripe verification can finish setup');
  await act(async () => { button(root, 'Finish setup').props.onClick(); });
  await tick();
  assert.ok(calls.some((c) => c.url.includes('/office/launch/complete')), 'finish posts the completion');
  assert.equal(location.history!.at(-1), '/', 'finishing moves into the workspace');
  assert.equal(mounted, 1, 'the dashboard loads underneath the hand-off');
  assert.ok(byTestId(root, 'setup-handoff'), 'finishing shows the "configuring your account" hand-off');
  assert.match(text(root.toJSON()), /Configuring your account/);
  const bar = root.root.findAll((node) => typeof node.type === 'string' && node.props.role === 'progressbar')[0];
  assert.ok(bar.props['aria-valuenow'] < 100, 'the bar starts part-way at most');
  await tick(2600);
  const mid = root.root.findAll((node) => typeof node.type === 'string' && node.props.role === 'progressbar')[0];
  assert.ok(mid.props['aria-valuenow'] > 30 && mid.props['aria-valuenow'] < 80, 'the bar fills over about five seconds');
  assert.ok(byTestId(root, 'setup-handoff'), 'still covering half-way through');
  await tick(2900);
  assert.equal(byTestId(root, 'setup-handoff'), undefined, 'the hand-off clears after about five seconds');
  assert.equal(mounted, 1, 'the dashboard stayed mounted, not reloaded');
  await dispose(root, client);
  mounted = 0;

  // A cached "incomplete" from an earlier visit does not replay the cover when
  // the fresh answer says setup was already finished.
  {
    snapshot = { ...structuredClone(state), productsConfirmed: true, payments: { state: 'pending', sandbox: true } };
    const cached = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const tree = () => <QueryClientProvider client={cached}><Router hook={memoryLocation({ path: '/' }).hook}><PracticeLaunchGuard><RealOperations /></PracticeLaunchGuard></Router></QueryClientProvider>;
    let first!: ReactTestRenderer;
    await act(async () => { first = create(tree(), { createNodeMock }); });
    await tick();
    assert.equal(mounted, 0, 'still incomplete on the first visit');
    await act(async () => { first.unmount(); });
    snapshot = { ...snapshot, completedAt: '2026-02-02T00:00:00Z' };
    let again!: ReactTestRenderer;
    await act(async () => { again = create(tree(), { createNodeMock }); });
    await tick();
    assert.equal(byTestId(again, 'setup-handoff'), undefined, 'no hand-off for setup finished elsewhere');
    assert.equal(mounted, 1, 'the workspace opens directly');
    await dispose(again, cached);
    mounted = 0;
  }

  // Coming back to /setup after it is done offers a way out, not a dead button.
  snapshot = { ...structuredClone(state), productsConfirmed: true, completedAt: '2026-02-02T00:00:00Z' };
  result = await render('/setup');
  assert.equal(button(result.root, 'Finish setup'), undefined);
  assert.ok(byTestId(result.root, 'link-setup-go-to-dashboard'), 'completed setup links to the dashboard');
  await dispose(result.root, result.client);
}

snapshot = { ...structuredClone(state), canEdit: false };
result = await render('/patients', 'setup-page');
assert.match(text(result.root.toJSON()), /Your practice owner completes setup/);
assert.equal(button(result.root, 'Use suggested setup'), undefined);
assert.equal(stepState(result.root, 'details'), 'folded', 'read-only viewers see the same folded state');
assert.equal(byLabel(result.root, 'Edit practice details'), undefined, 'read-only viewers cannot reopen to edit');
await dispose(result.root, result.client);

// HQ inspecting an office reads the workspace it came to see; only the office
// itself is held at the setup screen.
snapshot = { ...structuredClone(state), canEdit: false, hqInspection: true } as LaunchState;
result = await render('/patients');
assert.equal(mounted, 1, 'HQ inspection is never forced through the office setup');
await dispose(result.root, result.client);
mounted = 0;

// An HQ setup override opens the workspace for the office itself.
snapshot = { ...structuredClone(state), completedAt: '2026-02-01T00:00:00Z', setupOverride: { active: true, at: '2026-02-01T00:00:00Z', note: 'Demo account' } } as LaunchState;
result = await render('/patients');
assert.equal(mounted, 1, 'an overridden office reaches the workspace');
await dispose(result.root, result.client);
mounted = 0;

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

// HQ setup override: one office is waived deliberately, with its own version check.
await act(async () => { button(hqRoot, 'Override setup').props.onClick(); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
await act(async () => { button(hqRoot, 'Turn on override').props.onClick(); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const overrideCall = calls.find(c => c.url.includes('/override'))!;
assert.equal(overrideCall.method, 'POST');
assert.match(overrideCall.url, /office=fixture/);
assert.equal(overrideCall.body.enabled, true);
assert.equal(overrideCall.body.expectedVersion, snapshot.version - 1);
await dispose(hqRoot, hqClient);


console.log('Practice launch: scopes, fail-closed guard, folding steps, inline security, scroll-to-next, OAuth return notice, roles, resume, contract, price preservation, duplicate submission, restart, legacy completion, and HQ control passed.');
