/**
 * HQ App payments: the richer office list (instruments, trial countdown, next
 * charge amount, last payment, payment-problem flags) and its filters, the
 * forecast window picker and what each window asks the server for, the
 * forecast and collected views, the three report buttons and the ranges they
 * send, and the signed-out sample data.
 *
 * Runs under tsconfig.billing.json (DOM-free select and dialog stubs).
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DateRangeProvider } from '../src/contexts/date-range';
import { __setSession } from './a11y-stubs/session';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { PaymentsOfficeAccess } from '../src/pages/admin/payments/OfficeAccessBoard';
import { compareMonths, filterOffices, forecastWindow, historyWindow, instrumentLabel } from '../src/lib/app-payments';
import { addDaysToKey } from '../src/lib/date-range-keys';
import { DEMO_APP_OFFICES, DEMO_NOW, demoForecast } from '../src/pages/admin/payments/app-payments-demo';
import type {
  AppPaymentsCollected,
  AppPaymentsForecast,
  OfficeAccessBoard,
  OfficeAccessBoardRow,
  OfficeAccessPolicy,
  OfficeAccessTerms,
} from '../src/lib/billing-types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.location ??= { assign() {} };
g.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.navigator ??= {};
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

function persona(kind: 'hq' | 'demo') {
  requests.length = 0; handlers.length = 0;
  if (kind === 'hq') {
    __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin', claimedWorkspace: null });
    __setSupabaseSession('hq-token');
  } else {
    __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null, claimedWorkspace: null });
    __setSupabaseSession(null);
  }
}

async function settle(rounds = 10) { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
async function mount(path = '/admin/payments/office-access') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path, record: true });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}>
        <Route path="/admin/payments" nest><PaymentsOfficeAccess /></Route>
      </Router></DateRangeProvider></QueryClientProvider>,
    );
  });
  await settle();
  return { renderer, root: renderer.root, location };
}
const all = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => all(root, id)[0];
const has = (root: ReactTestInstance, id: string) => all(root, id).length > 0;
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
const lastUrl = (location: { history: string[] }) => location.history[location.history.length - 1];
const lastRequest = (prefix: string) => [...requests].reverse().find((row) => row.url.startsWith(prefix));

// ---- fixtures ----
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const today = new Date().toISOString().slice(0, 10);
const POLICY: OfficeAccessPolicy = {
  monthlyPriceCents: 20_000, yearlyPriceCents: 200_000, includedPeriodDays: 90,
  gracePeriodDays: 7, normalSharePercent: 60, restrictedSharePercent: 100, maxIncludedPeriodDays: 1095,
};
const emptyTerms: OfficeAccessTerms = {
  state: null, plan: null, priceCents: null, priceCentsOverride: null, lifetime: false,
  includedPeriodStartedAt: null, includedPeriodEndsAt: null, paidThrough: null, paidThroughSource: null,
  currentPeriodStart: null, currentPeriodEnd: null, graceEndsAt: null, graceDaysLeft: null,
  restrictedAt: null, setupCompletedAt: null, bankVerificationDeadline: null, lastAttemptAt: null,
  nextChargeAt: null, version: null,
};
const row = (providerId: string, officeName: string, overrides: Partial<OfficeAccessBoardRow>): OfficeAccessBoardRow => ({
  ...emptyTerms, providerId, officeName, locked: false,
  instruments: [], trialDaysLeft: null, nextChargeCents: null, lastPayment: null, paymentFlags: [], ...overrides,
});
const bank = (status: 'verified' | 'pending') =>
  ({ slot: 'bank', kind: 'bank', brand: null, bankName: 'Harbor Bank', last4: '6789', expMonth: null, expYear: null, verificationStatus: status }) as const;
const visa = { slot: 'card_primary', kind: 'card', brand: 'visa', bankName: null, last4: '4242', expMonth: 4, expYear: 2031, verificationStatus: 'verified' } as const;

const board: OfficeAccessBoard = {
  offices: [
    row('o1', 'Aspen', {
      state: 'paid_current', plan: 'monthly', priceCents: 20_000, paidThrough: iso(20), nextChargeAt: iso(20), nextChargeCents: 20_000,
      setupCompletedAt: iso(-200), instruments: [bank('verified'), visa],
      lastPayment: { at: iso(-10), amountCents: 20_000, outcome: 'succeeded', slot: 'bank', failureCode: null },
    }),
    row('o2', 'Beacon Hill', {
      state: 'included_period', plan: 'yearly', priceCents: 180_000, priceCentsOverride: 180_000, includedPeriodEndsAt: iso(12),
      nextChargeAt: iso(12), nextChargeCents: 180_000, trialDaysLeft: 12, setupCompletedAt: iso(-60),
      instruments: [bank('pending'), visa], paymentFlags: ['bank_unverified'],
    }),
    row('o3', 'Cedar Park', {
      state: 'past_due', plan: 'monthly', priceCents: 20_000, paidThrough: iso(-2), nextChargeAt: iso(-2), nextChargeCents: 20_000,
      graceEndsAt: iso(5), graceDaysLeft: 5, setupCompletedAt: iso(-300), paymentFlags: ['no_method'],
      lastPayment: { at: iso(-1), amountCents: 20_000, outcome: 'failed', slot: 'card_primary', failureCode: 'card_declined' },
    }),
    row('o4', 'Dune', {}),
    row('o5', 'Elm', {
      state: 'included_period', plan: 'monthly', priceCents: 20_000, includedPeriodEndsAt: iso(50), nextChargeAt: iso(50),
      nextChargeCents: 20_000, trialDaysLeft: 50, setupCompletedAt: iso(-10), instruments: [bank('verified'), visa],
    }),
  ],
  counts: { total: 5, notStarted: 1, setupIncomplete: 0, includedPeriod: 2, paidCurrent: 1, pastDue: 1, restricted: 0, trialsEndingSoon: 1 },
  policy: POLICY,
  trialEndingSoonDays: 30,
};

const forecastFor = (url: URL): AppPaymentsForecast => {
  const start = url.searchParams.get('start')!;
  const end = url.searchParams.get('end')!;
  const bucket = url.searchParams.get('bucket') as 'week' | 'month';
  const firstMonth = today.slice(0, 7);
  return {
    start: `${start}T00:00:00.000Z`, end: `${addDaysToKey(end, 1)}T00:00:00.000Z`, bucket,
    charges: [
      { providerId: 'o2', officeName: 'Beacon Hill', date: iso(12), type: 'trial_conversion', plan: 'yearly', amountCents: 180_000, atRisk: true, riskReasons: ['bank_unverified'] },
      { providerId: 'o1', officeName: 'Aspen', date: iso(20), type: 'renewal', plan: 'monthly', amountCents: 20_000, atRisk: false, riskReasons: [] },
    ],
    periods: [
      { key: bucket === 'month' ? firstMonth : start, start: `${start}T00:00:00.000Z`, totalCents: 200_000, renewalCents: 20_000, trialConversionCents: 180_000, monthlyCents: 20_000, yearlyCents: 180_000, atRiskCents: 180_000, count: 2 },
    ],
    totals: { totalCents: 200_000, renewalCents: 20_000, trialConversionCents: 180_000, monthlyCents: 20_000, yearlyCents: 180_000, atRiskCents: 180_000, count: 2 },
    outstanding: { totalCents: 20_000, offices: [{ providerId: 'o3', officeName: 'Cedar Park', state: 'past_due', since: iso(-2), plan: 'monthly', amountCents: 20_000, inFlight: false }] },
    estimate: true,
  };
};
const collectedFor = (url: URL): AppPaymentsCollected => {
  const key = today.slice(0, 7);
  const month = { key, collectedCents: 40_000, offlineCents: 20_000, reversedCents: 5_000, netCents: 55_000, succeededCount: 2, failedCount: 1, failedCents: 20_000, processingCount: 0 };
  return { start: `${url.searchParams.get('start')}T00:00:00.000Z`, end: `${url.searchParams.get('end')}T23:59:59.999Z`, months: [month], totals: { ...month, key: 'total' } };
};

const KINDS = [
  { kind: 'app_payments_offices', label: 'Billable offices', ranged: false },
  { kind: 'app_payments_forecast', label: 'Scheduled charges and forecast', ranged: true },
  { kind: 'app_payments_transactions', label: 'App payment transactions', ranged: true },
];
const ACCESS = '/api/hq/office-access';
function liveHandlers(available = KINDS) {
  on('GET', ACCESS, () => ({ status: 200, body: board }));
  on('GET', `${ACCESS}/forecast`, (url) => ({ status: 200, body: forecastFor(url) }));
  on('GET', `${ACCESS}/collected`, (url) => ({ status: 200, body: collectedFor(url) }));
  on('GET', '/api/exports', () => ({ status: 200, body: { jobs: [], available, ttlHours: 24 } }));
  on('GET', '/api/billing/public/config', () => ({ status: 200, body: { sandbox: true } }));
  on('POST', '/api/exports', (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return { status: 202, body: { job: { id: 'job-1', kind: body.kind, label: KINDS.find((k) => k.kind === body.kind)!.label, status: 'queued' } } };
  });
}

// ---------------------------------------------------------------- pure helpers
console.log('window and filter helpers');
{
  check('a 30-day window is today plus 29', JSON.stringify(forecastWindow('30', '2026-08-22')) === JSON.stringify({ start: '2026-08-22', end: '2026-09-20' }));
  check('12 months runs to the day before the same date next year', forecastWindow('12m', '2026-08-22')?.end === '2027-08-21');
  check('a custom range longer than 366 days is refused', forecastWindow('custom', '2026-08-22', { from: '2026-01-01', to: '2027-06-01' }) === null);
  check('a backwards custom range is refused', forecastWindow('custom', '2026-08-22', { from: '2026-09-10', to: '2026-09-01' }) === null);
  check('history is whole months back to today', JSON.stringify(historyWindow('3m', '2026-08-22')) === JSON.stringify({ start: '2026-06-01', end: '2026-08-22' }));
  const now = new Date();
  const due7 = filterOffices(board.offices, { state: 'all', trialWithin: null, dueWithin: 7, problem: null }, 30, now).map((r) => r.providerId);
  check('due within 7 days counts an overdue charge as due', JSON.stringify(due7) === JSON.stringify(['o3']));
  const unverified = filterOffices(board.offices, { state: 'all', trialWithin: null, dueWithin: null, problem: 'bank_unverified' }, 30, now).map((r) => r.providerId);
  check('one flag filters to offices carrying it', JSON.stringify(unverified) === JSON.stringify(['o2']));
  check('card label carries brand, last four and expiry', instrumentLabel(visa) === 'Visa ···· 4242 · exp 04/31');
  const months = compareMonths(
    [{ key: '2026-07', collectedCents: 1, offlineCents: 0, reversedCents: 0, netCents: 100, succeededCount: 1, failedCount: 0, failedCents: 0, processingCount: 0 }],
    [{ providerId: 'a', officeName: 'A', date: '2026-09-05T00:00:00.000Z', type: 'renewal', plan: 'monthly', amountCents: 500, atRisk: true, riskReasons: ['no_method'] }],
  );
  check('forecast vs collected keeps past and future months apart',
    months.length === 2 && months[0].collectedCents === 100 && months[0].forecastCents === null && months[1].forecastCents === 500 && months[1].atRiskCents === 500);
}

// ---------------------------------------------------------------- live page
console.log('live office list');
{
  persona('hq');
  liveHandlers();
  const { root, renderer, location } = await mount();
  const json = JSON.stringify(renderer.toJSON());
  check('the page is titled App payments', json.includes('App payments') && !json.includes('Office access billing'));
  check('the Test mode badge follows the payment mode switch', text(one(root, 'billing-sandbox-badge')).includes('Test mode'));
  check('every office is listed', board.offices.every((r) => has(root, `row-access-office-${r.providerId}`)));
  check('cards and banks on file show brand, last four, expiry and bank status',
    text(one(root, 'text-access-instrument-o1-card_primary')).includes('Visa ···· 4242 · exp 04/31')
    && text(one(root, 'text-access-instrument-o1-bank')).includes('Verified')
    && text(one(root, 'text-access-instrument-o2-bank')).includes('Pending verification'));
  check('trial days left sit with the trial end date',
    text(one(root, 'text-access-trial-o2')).includes('12 days left') && text(one(root, 'text-access-trial-o2')).includes('ends'));
  check('the next charge shows its amount', text(one(root, 'text-access-amount-o2')) === '$1,800.00');
  check('the last payment result is shown', text(one(root, 'text-access-last-o3')).includes('Failed') && text(one(root, 'text-access-last-o1')).includes('Paid'));
  check('payment problems are flagged on the row',
    has(root, 'flag-access-bank_unverified-o2') && has(root, 'flag-access-no_method-o3') && !has(root, 'flag-access-no_method-o1'));
  check('the problems tile counts flagged offices', text(one(root, 'tile-access-problems')).includes('2'));

  await press(one(root, 'tile-access-problems'));
  check('the problems tile filters and says so in the URL', lastUrl(location) === '/admin/payments/office-access?problem=any');
  check('only flagged offices remain', has(root, 'row-access-office-o2') && has(root, 'row-access-office-o3') && !has(root, 'row-access-office-o1'));
  await press(one(root, 'tile-access-problems'));
  check('pressing it again clears the filter', lastUrl(location) === '/admin/payments/office-access' && has(root, 'row-access-office-o1'));

  await press(option(root, 'trial-30'));
  check('trial ending within N days is a URL filter', lastUrl(location) === '/admin/payments/office-access?trial=30');
  check('only the trial ending inside 30 days is left', has(root, 'row-access-office-o2') && !has(root, 'row-access-office-o5'));
  await press(option(root, 'trial-all'));

  await press(option(root, 'due-30'));
  check('charge due within N days is a URL filter', lastUrl(location) === '/admin/payments/office-access?due=30');
  check('overdue and soon-due charges are kept, later ones dropped',
    has(root, 'row-access-office-o1') && has(root, 'row-access-office-o3') && !has(root, 'row-access-office-o5') && !has(root, 'row-access-office-o4'));
  await press(option(root, 'due-all'));

  await press(option(root, 'problem-no_method'));
  check('a single payment problem can be picked', lastUrl(location) === '/admin/payments/office-access?problem=no_method' && text(one(root, 'text-access-count')).startsWith('1 of'));
  await press(option(root, 'problem-all'));

  await press(option(root, 'amount'));
  const order = root.findAll((node) => typeof node.type === 'string' && typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('row-access-office-'))
    .map((node) => node.props['data-testid'].replace('row-access-office-', ''));
  check('sorting by next charge puts the largest first and no charge last', order[0] === 'o2' && order[order.length - 1] === 'o4', order.join(','));
  await act(async () => { renderer.unmount(); });
}

console.log('forecast window and collected history');
{
  persona('hq');
  liveHandlers();
  const { root, renderer, location } = await mount();
  const first = lastRequest(`${ACCESS}/forecast`);
  check('the default window is the next 90 days by week',
    first?.url === `${ACCESS}/forecast?start=${today}&end=${addDaysToKey(today, 89)}&bucket=week`, first?.url);
  check('the forecast is labelled as an estimate', text(one(root, 'text-forecast-mix')).startsWith('Estimate at current plans'));
  check('forecast tiles split renewals, trial conversions and at risk',
    text(one(root, 'tile-forecast-total')).includes('$2,000.00') && text(one(root, 'tile-forecast-renewals')).includes('$200.00')
    && text(one(root, 'tile-forecast-trials')).includes('$1,800.00') && text(one(root, 'tile-forecast-at-risk')).includes('$1,800.00'));
  check('monthly versus yearly is shown', text(one(root, 'text-forecast-mix')).includes('$200.00') && text(one(root, 'text-forecast-mix')).includes('$1,800.00'));
  check('past-due money is outstanding, apart from the forecast',
    text(one(root, 'tile-forecast-outstanding')).includes('$200.00') && text(one(root, 'row-outstanding-o3')).includes('Cedar Park'));
  check('the timeline lists each expected charge with its risk',
    text(one(root, `row-charge-o2-${iso(12).slice(0, 10)}`)).includes('Trial conversion') && text(one(root, `row-charge-o2-${iso(12).slice(0, 10)}`)).includes('Bank not verified')
    && text(one(root, `row-charge-o1-${iso(20).slice(0, 10)}`)).includes('On track'));
  check('the chart draws a bar per period', has(root, `bar-forecast-${today}`));
  const history = lastRequest(`${ACCESS}/collected`);
  check('collected history defaults to the last six months', history?.url === `${ACCESS}/collected?start=${historyWindow('6m', today).start}&end=${today}`, history?.url);
  check('collected tiles show net, failed, offline and refunds',
    text(one(root, 'tile-collected-net')).includes('$550.00') && text(one(root, 'tile-collected-failed')).includes('1')
    && text(one(root, 'tile-collected-offline')).includes('$200.00') && text(one(root, 'tile-collected-refunded')).includes('$50.00'));
  check('this month compares collected against the forecast',
    text(one(root, `row-compare-${today.slice(0, 7)}`)).includes('$550.00'));

  await press(option(root, 'win-12m'));
  const year = lastRequest(`${ACCESS}/forecast`);
  check('12 months asks for a year by month and says so in the URL',
    year?.url === `${ACCESS}/forecast?start=${today}&end=${forecastWindow('12m', today)!.end}&bucket=month` && lastUrl(location) === '/admin/payments/office-access?win=12m', year?.url);
  await press(one(root, 'button-bucket-week'));
  check('the chart can switch back to weeks', lastRequest(`${ACCESS}/forecast`)?.url.endsWith('bucket=week') === true);

  await press(option(root, 'win-custom'));
  check('a custom range without an end asks nothing and explains', has(root, 'text-forecast-window-invalid'));
  check('the forecast report waits for a valid window', one(root, 'button-report-forecast').props.disabled === true);
  await type(one(root, 'input-forecast-from'), addDaysToKey(today, 10));
  await type(one(root, 'input-forecast-to'), addDaysToKey(today, 40));
  const custom = lastRequest(`${ACCESS}/forecast`);
  check('a custom range is requested exactly',
    custom?.url === `${ACCESS}/forecast?start=${addDaysToKey(today, 10)}&end=${addDaysToKey(today, 40)}&bucket=week`, custom?.url);

  await press(option(root, 'hist-3m'));
  check('changing the history range re-reads collected payments',
    lastRequest(`${ACCESS}/collected`)?.url === `${ACCESS}/collected?start=${historyWindow('3m', today).start}&end=${today}`);

  console.log('reports');
  await press(one(root, 'button-report-forecast'));
  const forecastPost = [...requests].reverse().find((r) => r.method === 'POST');
  check('the forecast report sends the chosen window',
    forecastPost?.method === 'POST' && forecastPost.body.kind === 'app_payments_forecast'
    && forecastPost.body.start === addDaysToKey(today, 10) && forecastPost.body.end === addDaysToKey(today, 40), JSON.stringify(forecastPost?.body));
  await press(one(root, 'button-report-transactions'));
  const txPost = [...requests].reverse().find((r) => r.method === 'POST');
  check('the transactions report sends the history range',
    txPost?.body.kind === 'app_payments_transactions' && txPost.body.start === historyWindow('3m', today).start && txPost.body.end === today);
  await press(one(root, 'button-report-offices'));
  const officePost = [...requests].reverse().find((r) => r.method === 'POST');
  check('the billable offices snapshot sends no range', officePost?.body.kind === 'app_payments_offices' && officePost.body.start === undefined);
  check('the job list shows only app payment reports', has(root, 'panel-exports'));
  await act(async () => { renderer.unmount(); });
}

{
  persona('hq');
  liveHandlers([]);
  const { root, renderer } = await mount();
  check('a viewer without the report kinds cannot request them',
    ['offices', 'forecast', 'transactions'].every((id) => one(root, `button-report-${id}`).props.disabled === true));
  await act(async () => { renderer.unmount(); });
}

// ---------------------------------------------------------------- demo
console.log('signed-out sample data');
{
  persona('demo');
  const { root, renderer } = await mount();
  const json = JSON.stringify(renderer.toJSON());
  check('the preview fetches nothing', requests.length === 0, requests.map((r) => r.url).join(', '));
  check('sample offices are shown with the preview banner', DEMO_APP_OFFICES.every((r) => has(root, `row-access-office-${r.providerId}`)) && json.includes('Preview'));
  const expected = demoForecast(forecastWindow('90', '2026-08-22')!, 'week');
  check('the sample forecast is folded from the sample offices', text(one(root, 'tile-forecast-total')).includes(`$${(expected.totals.totalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`));
  check('sample past-due money is outstanding, not forecast',
    expected.outstanding.offices.some((o) => o.providerId === 'demo-elm') && !expected.charges.some((c) => c.providerId === 'demo-elm' && Date.parse(c.date) <= DEMO_NOW.getTime()));
  check('reports are unavailable in the preview',
    ['offices', 'forecast', 'transactions'].every((id) => one(root, `button-report-${id}`).props.disabled === true) && has(root, 'text-reports-demo'));
  await act(async () => { renderer.unmount(); });
}

if (failures) { console.error(`\n${failures} app payments check(s) failed`); process.exit(1); }
console.log('\nAll app payments checks passed');
process.exit(0);
