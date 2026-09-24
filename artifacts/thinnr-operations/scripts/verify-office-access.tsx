/**
 * HQ office access billing: the display vocabulary, the account page's access
 * card (state, plan and price, key dates, instruments, failed attempts and an
 * attributed history), the HQ actions and what each one sends, the paid-through
 * suggestion, and the board's filters and sort.
 *
 * Runs under tsconfig.billing.json (DOM-free select and dialog stubs).
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { AccountAccessBillingCard } from '../src/components/admin/office-access/AccessBillingCard';
import { PaymentsOfficeAccess, filterBoard } from '../src/pages/admin/payments/OfficeAccessBoard';
import {
  ACCESS_STATE_LABELS,
  accessStateLabel,
  accessStateTone,
  daysUntil,
  sortBoard,
  suggestedPaidThrough,
  termEndDate,
  toDateInput,
  trialEndingSoon,
} from '../src/lib/office-access';
import type {
  OfficeAccessBoard,
  OfficeAccessBoardRow,
  OfficeAccessDetail,
  OfficeAccessPolicy,
  OfficeAccessTerms,
} from '../src/lib/billing-types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.location ??= { assign() {} };
g.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.navigator ??= {};
// Radix's Switch sniffs for an enclosing form; nothing here is in one.
g.HTMLFormElement ??= class HTMLFormElement {};

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (pass) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---- scripted fetch ----
type Handler = (url: URL, init?: RequestInit) => { status: number; body: unknown };
const handlers: Array<{ method: string; test: (url: URL) => boolean; handle: Handler }> = [];
const requests: Array<{ method: string; url: string; body: any }> = [];
const on = (method: string, test: string | ((url: URL) => boolean), handle: Handler) =>
  handlers.unshift({ method, test: typeof test === 'string' ? (url) => url.pathname === test : test, handle });
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = new URL(raw, 'http://test.local');
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ method, url: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : null });
  const match = handlers.find((row) => row.method === method && row.test(url));
  if (!match) throw new Error(`unexpected fetch ${method} ${url.pathname}${url.search}`);
  const { status, body } = match.handle(url, init);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

function persona(kind: 'hq' | 'provider' | 'demo') {
  requests.length = 0; handlers.length = 0;
  if (kind === 'hq') {
    __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin', claimedWorkspace: null });
    __setSupabaseSession('hq-token');
  } else if (kind === 'provider') {
    __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null, claimedWorkspace: null });
    __setSupabaseSession('staff-token');
  } else {
    __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null, claimedWorkspace: null });
    __setSupabaseSession(null);
  }
}

async function settle(rounds = 10) { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
async function mount(element: React.ReactElement, path = '/admin/accounts/office-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path, record: true });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><Router hook={location.hook}>{element}</Router></QueryClientProvider>);
  });
  await settle();
  return { renderer, root: renderer.root, location };
}
const all = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => all(root, id)[0];
const text = (node: ReactTestInstance | undefined) => {
  if (!node) return '';
  const parts: string[] = [];
  const walk = (item: ReactTestInstance | string) => typeof item === 'string' ? parts.push(item) : item.children.forEach((child) => walk(child as ReactTestInstance | string));
  walk(node); return parts.join('');
};
const press = async (node: ReactTestInstance) => { await act(async () => { node.props.onClick?.({ preventDefault() {} }); }); await settle(); };
const type = async (node: ReactTestInstance, value: string) => { await act(async () => { node.props.onChange({ target: { value } }); }); await settle(); };
const option = (root: ReactTestInstance, value: string) =>
  root.findAll((node) => node.type === 'button' && node.props.role === 'option' && node.props['data-value'] === value)[0];

// ---- fixtures ----
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const POLICY: OfficeAccessPolicy = {
  monthlyPriceCents: 20_000, yearlyPriceCents: 200_000, includedPeriodDays: 365,
  gracePeriodDays: 7, normalSharePercent: 60, restrictedSharePercent: 100, maxIncludedPeriodDays: 1095,
};
const emptyTerms: OfficeAccessTerms = {
  state: null, plan: null, priceCents: null, priceCentsOverride: null, lifetime: false,
  includedPeriodStartedAt: null, includedPeriodEndsAt: null, paidThrough: null, paidThroughSource: null,
  currentPeriodStart: null, currentPeriodEnd: null, graceEndsAt: null, graceDaysLeft: null,
  restrictedAt: null, setupCompletedAt: null, bankVerificationDeadline: null, lastAttemptAt: null,
  nextChargeAt: null, version: null,
};
const terms = (overrides: Partial<OfficeAccessTerms>): OfficeAccessTerms => ({ ...emptyTerms, ...overrides });
const boardRow = (providerId: string, officeName: string, overrides: Partial<OfficeAccessBoardRow>): OfficeAccessBoardRow => ({
  ...emptyTerms, providerId, officeName, locked: false, ...overrides,
});

const restrictedTerms = terms({
  state: 'restricted', plan: 'monthly', priceCents: 15_000, priceCentsOverride: 15_000,
  includedPeriodStartedAt: iso(-400), includedPeriodEndsAt: iso(-30), setupCompletedAt: iso(-390),
  graceEndsAt: iso(-3), graceDaysLeft: 0, restrictedAt: iso(-3), lastAttemptAt: iso(-3),
  nextChargeAt: iso(-30), version: 4,
});

const detail = (overrides: Partial<OfficeAccessDetail> = {}): OfficeAccessDetail => ({
  office: { providerId: 'office-1', officeName: 'Beacon Hill' },
  subscription: restrictedTerms,
  setup: { complete: false, missing: ['card_backup'], bankVerificationPending: false, bankVerificationDeadline: null, bankVerificationOverdue: false },
  instruments: [
    { id: 'inst-1', slot: 'bank', kind: 'bank', brand: null, last4: '6789', bankName: 'Harbor Bank', expMonth: null, expYear: null, verificationStatus: 'verified', verificationDeadline: null, removedAt: null },
    { id: 'inst-2', slot: 'card_primary', kind: 'card', brand: 'visa', last4: '4242', bankName: null, expMonth: 4, expYear: 2031, verificationStatus: 'verified', verificationDeadline: null, removedAt: null },
  ],
  attempts: [
    { id: 'attempt-1', periodStart: iso(-30), periodEnd: iso(0), cycle: 2, slot: 'card_primary', plan: 'monthly', amountCents: 15_000, status: 'failed', failureCode: 'card_declined', failureMessage: 'The card was declined.', settledAt: null, failedAt: iso(-3), createdAt: iso(-3) },
  ],
  history: [
    { id: 'event-1', event: 'restricted', fromState: 'past_due', toState: 'restricted', actorKind: 'system', actorUserId: null, actorName: null, detail: {}, createdAt: iso(-3) },
    { id: 'event-2', event: 'terms_changed', fromState: null, toState: null, actorKind: 'hq', actorUserId: 'hq-1', actorName: 'Dana Reeve', detail: { priceCentsOverride: 15_000 }, createdAt: iso(-40) },
  ],
  policy: POLICY,
  ...overrides,
});

const ACCESS = '/api/hq/office-access';
const DETAIL_PATH = `${ACCESS}/office-1`;

console.log('display vocabulary');
{
  check('an office nothing has touched reads as not started', accessStateLabel(null) === ACCESS_STATE_LABELS.not_started && accessStateTone(null) === 'neutral');
  check('a restriction reads as bad, a grace window as a warning', accessStateTone('restricted') === 'bad' && accessStateTone('past_due') === 'warn');
  check('a month from the 31st lands on the last day of a short month', toDateInput(termEndDate('monthly', new Date('2027-01-31T00:00:00Z'))) === '2027-02-28');
  check('a year on is the same day next year', toDateInput(termEndDate('yearly', new Date('2027-03-10T00:00:00Z'))) === '2028-03-10');
  const now = new Date('2027-05-01T00:00:00Z');
  check('a term suggestion starts from today when nothing is paid', suggestedPaidThrough('monthly', null, now) === '2027-06-01');
  check('a term suggestion extends existing paid access rather than overwriting it',
    suggestedPaidThrough('yearly', terms({ paidThrough: '2027-09-30T00:00:00Z' }), now) === '2028-09-30');
  check('a past paid-through date does not push the suggestion backwards',
    suggestedPaidThrough('monthly', terms({ paidThrough: '2026-01-01T00:00:00Z' }), now) === '2027-06-01');
  check('days left never go negative', daysUntil(iso(-5)) === 0 && daysUntil(null) === null && daysUntil(iso(9)) === 9);
  check('a lifetime office never counts as a trial ending soon',
    trialEndingSoon(terms({ lifetime: true, includedPeriodEndsAt: iso(5) }), 30) === false
    && trialEndingSoon(terms({ includedPeriodEndsAt: iso(5) }), 30) === true
    && trialEndingSoon(terms({ includedPeriodEndsAt: iso(80) }), 30) === false
    && trialEndingSoon(terms({ includedPeriodEndsAt: iso(-1) }), 30) === false);
}

console.log('board filtering and sorting');
{
  const rows = [
    boardRow('o1', 'Aspen', { state: 'paid_current', plan: 'monthly', priceCents: 20_000, paidThrough: iso(20), nextChargeAt: iso(20) }),
    boardRow('o2', 'Beacon Hill', { state: 'restricted', plan: 'monthly', priceCents: 20_000, restrictedAt: iso(-3) }),
    boardRow('o3', 'Cedar Park', { state: 'included_period', includedPeriodEndsAt: iso(10), nextChargeAt: iso(10) }),
    boardRow('o4', 'Dune', {}),
    boardRow('o5', 'Elm', { state: 'past_due', graceEndsAt: iso(2), graceDaysLeft: 2, nextChargeAt: iso(-1) }),
  ];
  check('filtering by a state keeps only that state', filterBoard(rows, 'restricted', 30).map((row) => row.providerId).join() === 'o2');
  check('"not started" is its own filter, not an empty state', filterBoard(rows, 'not_started', 30).map((row) => row.providerId).join() === 'o4');
  check('trials ending soon filter on the included period', filterBoard(rows, 'ending_soon', 30).map((row) => row.providerId).join() === 'o3');
  check('no filter keeps every office', filterBoard(rows, 'all', 30).length === 5);
  check('attention order puts restricted and grace first, nothing-yet last',
    sortBoard(rows, 'attention').map((row) => row.providerId).join() === 'o2,o5,o3,o1,o4');
  check('by name is alphabetical', sortBoard(rows, 'name').map((row) => row.officeName).join() === 'Aspen,Beacon Hill,Cedar Park,Dune,Elm');
  check('by next date sorts dateless offices last', sortBoard(rows, 'next').map((row) => row.providerId).join() === 'o5,o3,o1,o2,o4');
}

console.log('the account page card');
{
  persona('hq');
  on('GET', DETAIL_PATH, () => ({ status: 200, body: detail() }));
  const { root, renderer } = await mount(<AccountAccessBillingCard providerId="office-1" />);
  check('the access state is named and explained', text(one(root, 'chip-access-state')) === 'Restricted'
    && text(one(root, 'text-access-state-meaning')).includes('recovery window closed unpaid'));
  check('the plan, price and its override are shown', text(one(root, 'text-access-price')).includes('Monthly')
    && text(one(root, 'text-access-price')).includes('$150.00') && text(one(root, 'text-access-price')).includes('own price'));
  check('the dates that decide access are shown', Boolean(one(root, 'text-access-included-ends')) && Boolean(one(root, 'text-access-grace'))
    && Boolean(one(root, 'text-access-restricted-since')));
  check('instruments on file are listed and the missing one is named',
    text(one(root, 'row-access-instrument-bank')).includes('Harbor Bank')
    && text(one(root, 'row-access-instrument-card_primary')).includes('4242')
    && text(one(root, 'text-access-setup-missing')).includes('Backup card')
    && text(one(root, 'text-access-setup-missing')).includes('office completes this itself'));
  check('a failed attempt shows why it failed',
    text(one(root, 'row-access-attempt-attempt-1')).includes('$150.00')
    && text(one(root, 'text-access-attempt-failure-attempt-1')) === 'The card was declined.');
  check('history names who changed what',
    text(one(root, 'row-access-history-event-2')).includes('Plan or price changed')
    && text(one(root, 'row-access-history-event-2')).includes('Dana Reeve')
    && text(one(root, 'row-access-history-event-1')).includes('Automatic'));
  check('the board is one link away', one(root, 'link-access-board')?.props.href === '/admin/payments/office-access');
  await act(async () => { renderer.unmount(); });
}

{
  persona('hq');
  on('GET', DETAIL_PATH, () => ({ status: 200, body: detail({ subscription: null, setup: null, instruments: [], attempts: [], history: [] }) }));
  const { root, renderer } = await mount(<AccountAccessBillingCard providerId="office-1" />);
  check('an office with no subscription work says so instead of showing zeros',
    text(one(root, 'chip-access-state')) === 'Not started'
    && text(one(root, 'text-access-not-started')).includes('No access subscription exists')
    && text(one(root, 'text-access-price')).includes('Not set')
    && text(one(root, 'text-access-no-attempts')).includes('No access charge has been attempted')
    && text(one(root, 'text-access-no-history')).includes('Nothing has changed'));
  check('nothing on file says HQ cannot add it', text(one(root, 'text-access-no-instruments')).includes('HQ cannot add them'));
  await act(async () => { renderer.unmount(); });
}

{
  persona('provider');
  const { root, renderer } = await mount(<AccountAccessBillingCard providerId="office-1" />);
  check('a provider-side account sees no access card and asks for nothing',
    all(root, 'chip-access-state').length === 0 && requests.length === 0);
  await act(async () => { renderer.unmount(); });
}

console.log('HQ actions');
{
  persona('hq');
  on('GET', DETAIL_PATH, () => ({ status: 200, body: detail() }));
  on('POST', `${DETAIL_PATH}/paid-through`, () => ({ status: 200, body: { subscription: terms({ state: 'paid_current', paidThrough: iso(200), paidThroughSource: 'hq_migration' }) } }));
  const { root, renderer } = await mount(<AccountAccessBillingCard providerId="office-1" />);

  await press(one(root, 'button-access-paid-through'));
  check('the paid-through dialog opens with a suggestion already filled in',
    Boolean(one(root, 'dialog-access-action')) && one(root, 'input-access-paid-through')?.props.value === suggestedPaidThrough('monthly', restrictedTerms));
  await press(one(root, 'button-access-term-yearly'));
  check('picking a year suggests the date a year out', one(root, 'input-access-paid-through')?.props.value === suggestedPaidThrough('yearly', restrictedTerms));
  await type(one(root, 'input-access-paid-through'), '2027-12-31');
  check('the date can still be typed by hand', one(root, 'input-access-paid-through')?.props.value === '2027-12-31');
  check('the effect is stated in plain language before applying',
    text(one(root, 'text-access-action-effect')).includes('paid for access through')
    && text(one(root, 'text-access-action-effect')).includes('add its own bank account and cards'));
  await press(option(root, 'offline'));
  await press(one(root, 'button-access-paid-through-apply'));
  const paidThrough = requests.find((request) => request.url === `${DETAIL_PATH}/paid-through`);
  check('the recorded date and its source are sent', paidThrough?.body.paidThrough === '2027-12-31' && paidThrough?.body.source === 'offline',
    JSON.stringify(paidThrough?.body));
  check('the dialog closes once the change lands', all(root, 'dialog-access-action').length === 0);
  await act(async () => { renderer.unmount(); });
}

{
  persona('hq');
  on('GET', DETAIL_PATH, () => ({ status: 200, body: detail() }));
  on('POST', `${DETAIL_PATH}/offline-payment`, () => ({ status: 200, body: { subscription: terms({ state: 'paid_current', paidThrough: iso(30), paidThroughSource: 'offline' }) } }));
  on('POST', `${DETAIL_PATH}/reset-trial`, () => ({ status: 200, body: { subscription: terms({ state: 'included_period', includedPeriodEndsAt: iso(365) }) } }));
  on('POST', `${DETAIL_PATH}/included-period`, () => ({ status: 200, body: { subscription: terms({ state: 'included_period', lifetime: true }) } }));
  on('POST', `${DETAIL_PATH}/terms`, () => ({ status: 200, body: { subscription: terms({ state: 'restricted', plan: 'yearly', priceCents: 200_000 }) } }));
  const { root, renderer } = await mount(<AccountAccessBillingCard providerId="office-1" />);

  await press(one(root, 'button-access-offline'));
  check('an offline payment for a restricted office says the restriction clears',
    text(one(root, 'text-access-action-effect')).includes('stops being restricted'));
  await type(one(root, 'input-access-paid-through'), '2027-02-28');
  await press(one(root, 'button-access-offline-apply'));
  const offline = requests.find((request) => request.url === `${DETAIL_PATH}/offline-payment`);
  check('the offline payment sends the date and the amount', offline?.body.paidThrough === '2027-02-28' && offline?.body.amountCents === 15_000,
    JSON.stringify(offline?.body));

  await press(one(root, 'button-access-reset'));
  check('the reset dialog offers the standard included period and says where it lands',
    one(root, 'input-access-reset-days')?.props.value === 365 && text(one(root, 'text-access-action-effect')).includes('restarts today'));
  await type(one(root, 'input-access-reset-days'), '45');
  await press(one(root, 'button-access-reset-apply'));
  check('a trial reset sends the fresh period', requests.find((request) => request.url === `${DETAIL_PATH}/reset-trial`)?.body.days === 45);

  await press(one(root, 'button-access-included'));
  await type(one(root, 'input-access-included-ends'), toDateInput(new Date(Date.now() + 1200 * DAY)));
  check('an included period beyond three years is refused before it is sent',
    one(root, 'button-access-included-apply')?.props.disabled === true
    && root.findAll((node) => node.props.role === 'alert').some((node) => text(node).includes('more than 3 years')));
  await press(one(root, 'switch-access-lifetime'));
  check('lifetime states what it means', text(one(root, 'text-access-action-effect')).includes('no access charge, ever'));
  await press(one(root, 'button-access-included-apply'));
  check('lifetime is sent on its own', requests.find((request) => request.url === `${DETAIL_PATH}/included-period`)?.body.lifetime === true);

  await press(one(root, 'button-access-price'));
  await press(one(root, 'switch-access-price-override'));
  await press(option(root, 'yearly'));
  check('dropping the override says the office goes back to the standard price',
    text(one(root, 'text-access-action-effect')).includes('standard yearly price')
    && text(one(root, 'text-access-action-effect')).includes('$2,000.00'));
  await press(one(root, 'button-access-price-apply'));
  const termsSent = requests.find((request) => request.url === `${DETAIL_PATH}/terms`);
  check('clearing the override sends a null price', termsSent?.body.plan === 'yearly' && termsSent?.body.priceCentsOverride === null,
    JSON.stringify(termsSent?.body));
  await act(async () => { renderer.unmount(); });
}

{
  persona('hq');
  on('GET', DETAIL_PATH, () => ({ status: 200, body: detail() }));
  on('POST', `${DETAIL_PATH}/reset-trial`, () => ({ status: 403, body: { error: 'Only HQ payments admins can change office access.' } }));
  const { root, renderer } = await mount(<AccountAccessBillingCard providerId="office-1" />);
  await press(one(root, 'button-access-reset'));
  await press(one(root, 'button-access-reset-apply'));
  check('a refused change leaves the dialog open rather than pretending it applied', all(root, 'dialog-access-action').length === 1);
  await act(async () => { renderer.unmount(); });
}

console.log('the billing board');
const board: OfficeAccessBoard = {
  offices: [
    boardRow('o1', 'Aspen', { state: 'paid_current', plan: 'monthly', priceCents: 20_000, paidThrough: iso(20), nextChargeAt: iso(20) }),
    boardRow('o2', 'Beacon Hill', { state: 'restricted', plan: 'monthly', priceCents: 15_000, priceCentsOverride: 15_000, restrictedAt: iso(-3), locked: true }),
    boardRow('o3', 'Cedar Park', { state: 'included_period', includedPeriodEndsAt: iso(10), nextChargeAt: iso(10) }),
    boardRow('o4', 'Dune', {}),
    boardRow('o5', 'Elm', { state: 'past_due', graceEndsAt: iso(2), graceDaysLeft: 2, nextChargeAt: iso(-1) }),
  ],
  counts: { total: 5, notStarted: 1, setupIncomplete: 0, includedPeriod: 1, paidCurrent: 1, pastDue: 1, restricted: 1, trialsEndingSoon: 1 },
  policy: POLICY,
  trialEndingSoonDays: 30,
};
{
  persona('hq');
  on('GET', ACCESS, () => ({ status: 200, body: board }));
  const { root, renderer, location } = await mount(
    <Route path="/admin/payments" nest><PaymentsOfficeAccess /></Route>,
    '/admin/payments/office-access',
  );
  check('every live office is listed', board.offices.every((row) => Boolean(one(root, `row-access-office-${row.providerId}`))));
  check('at-risk counts are across the top',
    text(one(root, 'tile-access-past_due')).includes('1') && text(one(root, 'tile-access-restricted')).includes('1')
    && text(one(root, 'tile-access-ending_soon')).includes('1') && text(one(root, 'tile-access-not_started')).includes('1'));
  check('an office with no subscription work reads as not started, not as zero',
    text(one(root, 'chip-access-state-o4')) === 'Not started' && text(one(root, 'text-access-next-o4')) === '—');
  check('a locked office is marked as well as its access state', text(one(root, 'row-access-office-o2')).includes('Locked'));
  check('each row links to the office account page',
    root.findAll((node) => node.type === 'a' && node.props.href === '/admin/accounts/o2').length === 1);

  await press(one(root, 'tile-access-restricted'));
  check('a count tile filters the board and says so in the URL',
    location.history[location.history.length - 1] === '/admin/payments/office-access?state=restricted');
  check('only the restricted office is left', Boolean(one(root, 'row-access-office-o2')) && all(root, 'row-access-office-o1').length === 0);

  await act(async () => { one(root, 'select-access-sort').parent!.props.children; });
  await press(option(root, 'name'));
  check('the sort choice is in the URL too',
    location.history[location.history.length - 1] === '/admin/payments/office-access?state=restricted&sort=name');

  await press(option(root, 'setup_incomplete'));
  check('a state nobody is in says so plainly', text(one(root, 'text-access-board-empty')).includes('No office is in that state'));
  await act(async () => { renderer.unmount(); });
}

{
  persona('demo');
  const { root, renderer } = await mount(
    <Route path="/admin/payments" nest><PaymentsOfficeAccess /></Route>,
    '/admin/payments/office-access',
  );
  check('the signed-out preview shows the board heading and fetches nothing',
    JSON.stringify(renderer.toJSON()).includes('Office access billing') && requests.length === 0);
  check('no office rows are invented for the preview', all(root, 'row-access-office-o1').length === 0);
  await act(async () => { renderer.unmount(); });
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll office access checks passed');
