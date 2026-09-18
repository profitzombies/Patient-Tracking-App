/**
 * Purchases on the patient record + roster subscription signal.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:patient-purchases
 *
 * Renders the REAL patient record page and roster under react-test-renderer
 * with a scripted global fetch (session / provider scope stubbed via
 * tsconfig.body-measurements.json). Covers:
 *   - live panel: totals, card on file, payment problem, subscription and
 *     order rows with shipment state, links into the payments area;
 *   - loading, error (retry), and 403 (owners/admins only) states;
 *   - HQ drill-in: the summary request carries ?office=;
 *   - guided demo: the same panel renders from the seeded dataset with no
 *     network calls, and links stay on the list pages;
 *   - roster: "Subscribed" chip only for true (null renders nothing), and the
 *     subscription filter keeps true rows only, seeded via ?subscription=active.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { DateRangeProvider } from '../src/contexts/date-range';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import type { OfficePatient, OfficePatientDetail, OfficeRoster } from '../src/lib/office-roster';
import { MOCK_PATIENTS, MOCK_PRODUCTS, MOCK_SUBSCRIPTIONS } from '../src/data/mock-data';
import { demoPurchasesSummary } from '../src/components/office/PatientPurchases';
import Patients from '../src/pages/Patients';
import PatientDetail from '../src/pages/PatientDetail';
import { PURCHASES_FIXTURE, PURCHASES_PATIENT_ID } from './fixtures/patient-purchases';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (pass) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => {
  const found = byTestId(root, id);
  if (found.length !== 1) throw new Error(`Expected one ${id}; found ${found.length}`);
  return found[0];
};
const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : textOf(child as ReactTestInstance)).join('');
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const hrefs = (node: ReactTestInstance) => node.findAll((n) => n.type === 'a' && typeof n.props.href === 'string').map((n) => n.props.href as string);

// ─── Fixture ─────────────────────────────────────────────────────────────────

const AS_OF = '2026-09-17';
const OTHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const UNKNOWN_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
function rosterPatient(id: string, name: string, activeSubscription: boolean | null): OfficePatient {
  return {
    id, name, email: `${id}@example.com`, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true,
    createdAt: '2026-07-01T00:00:00Z', outreach: { state: 'none' } as OfficePatient['outreach'],
    program: { id: 'metabolic', day: 60, stage: 'protocol', week: 9, startDate: '2026-07-08', startingWeight: 210, currentWeight: 200, goalWeight: 170, weightChange: -10, lastLogDate: null },
    invitation: null, activeSubscription,
    operational: { asOfDate: AS_OF, latestActivityDate: AS_OF, latestDiaryDate: AS_OF, latestWaterDate: null, latestCheckInDate: null, latestWeightDate: null, latestPhotoDate: null, loggedDays7: 3, checkIns7: 0, activity: null, status: 'on_track', reasons: [], followUps: [] },
  } as OfficePatient;
}
const ROSTER: OfficeRoster = {
  office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' },
  patients: [rosterPatient(PURCHASES_PATIENT_ID, 'Devon Subscribed', true), rosterPatient(OTHER_ID, 'Kara Cash', false), rosterPatient(UNKNOWN_ID, 'Uma Unknown', null)],
  summary: { totalPatients: 3, activePatients: 3, newEnrollments30d: 0, needsAttention: 0, attention: 0, inactive: 0, invited: 0, checkInsOverdue: 0, loggingLapsed: 0, deletionRequested: 0, deletedAccounts: 0, asOf: AS_OF },
  deletedAccounts: [],
} as OfficeRoster;
const DETAIL: OfficePatientDetail = {
  office: ROSTER.office,
  patient: {
    identity: { id: PURCHASES_PATIENT_ID, name: 'Devon Subscribed', email: null, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true, dateOfBirth: null, height: null, timezone: 'America/New_York', createdAt: '2026-06-01T00:00:00Z', claimedAt: null, lastLoginAt: null },
    program: { id: 'metabolic', startDate: '2026-06-01', startingWeight: 210, currentWeight: 198, goalWeight: 180, weightChange: -12, lastLogDate: AS_OF },
    version: '2026-09-01T00:00:00.000Z',
    deletion: null,
  },
  diary: { entries: [], nutritionTotals: { overall: { calories: 0, protein: 0, carbs: 0, fat: 0 }, byDate: [] } },
  water: [], checkIns: [], weights: [{ dateKey: '2026-06-01', weight: 210 }], providerNotes: [], staffWeights: [], bodyMeasurements: [], progressPhotos: [],
  account: { targets: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, favorites: [], recents: [], customFoods: [], savedRecipes: [], flags: {} },
} as OfficePatientDetail;

const requests: Array<{ url: string; method: string }> = [];
let summaryResponse: { status: number; body: unknown; hold?: Promise<void> } = { status: 200, body: PURCHASES_FIXTURE };
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ url, method });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/api/billing/office/patients/') && url.includes('/summary')) {
    if (summaryResponse.hold) await summaryResponse.hold;
    return json(summaryResponse.body, summaryResponse.status);
  }
  if (url.includes('/api/office/roster')) return json(ROSTER);
  if (url.includes('/notifications')) return json({ patientId: PURCHASES_PATIENT_ID, outreach: { state: 'none' }, notifications: [] });
  if (url.includes('/medications')) return json({ medications: [], doseLogs: [], adherence: null, timeZone: 'UTC', today: AS_OF });
  if (url.includes('/coach-conversations') || url.includes('/coach-memories')) return json({ conversations: [], memories: [], total: 0 });
  if (url.includes('/api/office/patients/')) return json(DETAIL);
  // Other record panels (bloodwork, coach review, …) are not under test; a
  // rejected fetch parks them in their error states without masking ours.
  throw new Error(`not under test: ${method} ${url}`);
};

const renderers: ReactTestRenderer[] = [];
async function render(path: string, element: React.ReactElement) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DateRangeProvider>
          <PatientSessionProvider>
            <Router hook={loc.hook}>{element}</Router>
          </PatientSessionProvider>
        </DateRangeProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  renderers.push(renderer!);
  return { root: renderer!.root, loc };
}
const staff = () => {
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null, providerAccountCode: '483920' });
  __setScope(null);
  __setSupabaseSession('staff-token');
};
const summaryCalls = () => requests.filter((r) => r.url.includes('/summary'));
const record = () => <Route path="/patients/:id"><PatientDetail /></Route>;

// ─── Record: live panel ──────────────────────────────────────────────────────

console.log('record: live purchases panel (office staff)');
{
  staff();
  requests.length = 0;
  summaryResponse = { status: 200, body: PURCHASES_FIXTURE };
  const { root } = await render(`/patients/${PURCHASES_PATIENT_ID}`, record());
  const calls = summaryCalls();
  check('exactly one summary request, for this patient, without ?office=', calls.length === 1 && calls[0].url.includes(`/api/billing/office/patients/${PURCHASES_PATIENT_ID}/summary`) && !calls[0].url.includes('office='), calls.map((c) => c.url).join('|'));
  const panel = one(root, 'panel-purchases');
  check('lifetime spend is the net figure with paid/refunded breakdown', textOf(one(root, 'stat-purchases-lifetime')).includes('$228.00') && textOf(one(root, 'stat-purchases-lifetime')).includes('$248.00 paid') && textOf(one(root, 'stat-purchases-lifetime')).includes('$20.00 refunded'), textOf(one(root, 'stat-purchases-lifetime')));
  check('order count comes from totals, noting the truncated list', textOf(one(root, 'stat-purchases-orders')).includes('3') && textOf(one(root, 'stat-purchases-orders')).includes('Showing the latest 2'));
  check('active subscription count', textOf(one(root, 'stat-purchases-subscriptions')).includes('2'));
  check('saved card shows brand, last4 and expiry', /Visa •••• 4242/.test(textOf(one(root, 'stat-purchases-card'))) && textOf(one(root, 'stat-purchases-card')).includes('Expires 08/2028'), textOf(one(root, 'stat-purchases-card')));
  const problem = one(root, 'purchases-payment-problem');
  check('last payment problem is announced as a status with the failure message', problem.props.role === 'status' && textOf(problem).includes('Subscription payment failed') && textOf(problem).includes('Your card was declined.'));
  check('problem links to the Stripe invoice and the subscriptions page', hrefs(problem).includes('https://invoice.stripe.com/i/test') && one(root, 'link-purchases-problem').props.href === '/payments/subscriptions');
  const sub1 = one(root, 'row-subscription-sub-1');
  check('past-due subscription row: product, cadence, next shipment, status', textOf(sub1).includes('Protocol Drops') && textOf(sub1).includes('Every 4 weeks') && textOf(sub1).includes('Next Oct 1, 2026') && textOf(sub1).includes('Payment failed'), textOf(sub1));
  const sub2 = one(root, 'row-subscription-sub-2');
  check('paused subscription reads Paused (not Active) with quantity price and end date', textOf(sub2).includes('Paused') && !textOf(sub2).includes('Active') && textOf(sub2).includes('2 × $90.00') && textOf(sub2).includes('Ends Sep 28, 2026'), textOf(sub2));
  const ord2 = one(root, 'row-order-ord-2');
  check('order row links to the transaction detail', one(root, 'link-order-ord-2').props.href === '/payments/transactions/ord-2');
  check('order row shows payment status, shipment state and tracking', textOf(ord2).includes('Paid') && textOf(ord2).includes('Shipped') && textOf(ord2).includes('USPS 9400111899223'), textOf(ord2));
  const ord1 = one(root, 'row-order-ord-1');
  check('refunded order shows the refund and delivered parcel', textOf(ord1).includes('Partially refunded') && textOf(ord1).includes('$20.00 refunded') && textOf(ord1).includes('Delivered'), textOf(ord1));
  check('header links into the payments area', one(root, 'link-purchases-payments').props.href === '/payments/transactions' && one(root, 'link-purchases-subscriptions').props.href === '/payments/subscriptions');
  check('panel is read-only: no buttons inside it', panel.findAll((n) => n.type === 'button').length === 0);
}

console.log('\nrecord: empty, loading, error, and forbidden states');
{
  staff();
  summaryResponse = { status: 200, body: { ...PURCHASES_FIXTURE, subscriptions: [], orders: [], last_payment_problem: null, saved_card: { state: 'none', brand: null, last4: null, exp_month: null, exp_year: null }, totals: { order_count: 0, lifetime_paid_cents: 0, lifetime_refunded_cents: 0, lifetime_net_cents: 0, last_paid_at: null, active_subscription_count: 0 } } };
  {
    const { root } = await render(`/patients/${PURCHASES_PATIENT_ID}`, record());
    check('no purchases: explicit empty copy and "None saved" card', byTestId(root, 'purchases-empty').length === 1 && textOf(one(root, 'stat-purchases-card')).includes('None saved') && byTestId(root, 'purchases-payment-problem').length === 0);
  }
  let release!: () => void;
  summaryResponse = { status: 200, body: PURCHASES_FIXTURE, hold: new Promise<void>((resolve) => { release = resolve; }) };
  {
    const { root } = await render(`/patients/${PURCHASES_PATIENT_ID}`, record());
    check('pending request shows the loading status, not an empty panel', byTestId(root, 'purchases-loading').length === 1 && byTestId(root, 'panel-purchases').length === 0);
    release();
    await settle();
    check('resolves into the panel', byTestId(root, 'panel-purchases').length === 1 && byTestId(root, 'purchases-loading').length === 0);
  }
  summaryResponse = { status: 500, body: { error: 'Stripe is unavailable.' } };
  {
    requests.length = 0;
    const { root } = await render(`/patients/${PURCHASES_PATIENT_ID}`, record());
    const error = one(root, 'purchases-error');
    check('server failure is retried once, then renders an alert with the message and a retry', summaryCalls().length === 2 && error.findAll((n) => n.props.role === 'alert').length === 1 && textOf(error).includes('Stripe is unavailable.') && byTestId(root, 'button-purchases-retry').length === 1, `${summaryCalls().length} ${textOf(error)}`);
    summaryResponse = { status: 200, body: PURCHASES_FIXTURE };
    const before = summaryCalls().length;
    await act(async () => { one(root, 'button-purchases-retry').props.onClick(); });
    await settle();
    check('retry refetches and swaps in the panel', summaryCalls().length === before + 1 && byTestId(root, 'panel-purchases').length === 1);
  }
  summaryResponse = { status: 403, body: { error: 'Office owners and admins only.' } };
  {
    requests.length = 0;
    const { root } = await render(`/patients/${PURCHASES_PATIENT_ID}`, record());
    const forbidden = one(root, 'purchases-forbidden');
    check('403 is not retried', summaryCalls().length === 1, String(summaryCalls().length));
    check('403 explains owner/admin visibility without an alert or retry', textOf(forbidden).includes('visible to office owners and admins') && forbidden.findAll((n) => n.props.role === 'alert').length === 0 && byTestId(root, 'button-purchases-retry').length === 0);
  }
}

console.log('\nrecord: HQ drill-in scopes the request');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Support', providerAccountCode: null });
  __setScope({ providerId: 'office-1' });
  __setSupabaseSession('hq-token');
  summaryResponse = { status: 200, body: PURCHASES_FIXTURE };
  requests.length = 0;
  const { root } = await render(`/patients/${PURCHASES_PATIENT_ID}`, record());
  const calls = summaryCalls();
  check('summary request carries ?office=<providerId>', calls.length === 1 && /[?&]office=office-1/.test(calls[0].url), calls.map((c) => c.url).join('|'));
  check('panel renders for HQ with relative payments links (wouter nests them under the drill-in)', byTestId(root, 'panel-purchases').length === 1 && one(root, 'link-order-ord-2').props.href === '/payments/transactions/ord-2');
}

// ─── Record: guided demo ─────────────────────────────────────────────────────

console.log('\nrecord: guided demo renders the panel from the seeded dataset');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null, providerAccountCode: null });
  __setScope(null);
  __setSupabaseSession(null);
  const failing = MOCK_PATIENTS.find((p) => p.status === 'overdue')!;
  const paused = MOCK_PATIENTS.find((p) => p.status === 'paused')!;
  requests.length = 0;
  {
    const { root } = await render(`/patients/${failing.id}`, record());
    check('demo: no network calls', requests.length === 0, requests.map((r) => r.url).join('|'));
    const panel = one(root, 'panel-purchases');
    const summary = demoPurchasesSummary(failing, MOCK_SUBSCRIPTIONS.find((s) => s.patientId === failing.id), MOCK_PRODUCTS);
    check('demo: lifetime spend mirrors the seeded patient revenue', textOf(one(root, 'stat-purchases-lifetime')).includes(`$${(summary.totals.lifetime_net_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`) && summary.totals.lifetime_net_cents >= failing.revenue * 100, textOf(one(root, 'stat-purchases-lifetime')));
    check('demo: overdue patient surfaces a payment problem and Payment failed status', byTestId(root, 'purchases-payment-problem').length === 1 && textOf(panel).includes('Payment failed'));
    check('demo: one subscription row per seeded product', summary.subscriptions.length === failing.products.length && failing.products.every((id) => byTestId(root, `row-subscription-${summary.subscriptions.find((s) => s.product_id === id)!.id}`).length === 1));
    check('demo: one order per seeded shipment, all delivered', summary.orders.length === MOCK_SUBSCRIPTIONS.find((s) => s.patientId === failing.id)!.shipmentHistory.length && summary.orders.length > 0 && panel.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('row-order-')).length === summary.orders.length);
    const orderLinks = panel.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('link-order-'));
    check('demo: order links stay on the transactions list (no seeded detail pages)', orderLinks.length > 0 && orderLinks.every((n) => n.props.href === '/payments/transactions'));
    check('demo: panel is read-only', panel.findAll((n) => n.type === 'button').length === 0);
  }
  {
    const { root } = await render(`/patients/${paused.id}`, record());
    const panel = one(root, 'panel-purchases');
    check('demo: paused patient reads Paused with an active subscription count', textOf(panel).includes('Paused') && !textOf(one(root, 'stat-purchases-subscriptions')).includes('0') && byTestId(root, 'purchases-payment-problem').length === 0, textOf(one(root, 'stat-purchases-subscriptions')));
  }
  check('demo: cancelled seed maps to canceled with zero active subscriptions and no card', (() => {
    const p = MOCK_PATIENTS[0];
    const s = demoPurchasesSummary(p, { ...MOCK_SUBSCRIPTIONS[0], status: 'cancelled' }, MOCK_PRODUCTS);
    return s.subscriptions.every((row) => row.status === 'canceled') && s.totals.active_subscription_count === 0 && s.saved_card.state === 'none';
  })());
}

// ─── Roster ──────────────────────────────────────────────────────────────────

console.log('\nroster: subscription chip and filter (office staff)');
{
  staff();
  requests.length = 0;
  const { root } = await render('/patients', <Patients />);
  check('chip only for the subscribed patient; false and null render nothing', byTestId(root, `chip-subscription-${PURCHASES_PATIENT_ID}`).length >= 1 && byTestId(root, `chip-subscription-${OTHER_ID}`).length === 0 && byTestId(root, `chip-subscription-${UNKNOWN_ID}`).length === 0);
  const text = textOf(root);
  check('all three patients listed before filtering', text.includes('Devon Subscribed') && text.includes('Kara Cash') && text.includes('Uma Unknown'));
  const select = one(root, 'select-subscription-filter');
  check('filter offers All purchases / Active subscription', select.findAll((n) => n.type === 'option').map((n) => n.props.value).join(',') === 'all,active');
  await act(async () => { select.props.onChange({ target: { value: 'active' } }); });
  await settle(2);
  const filtered = textOf(root);
  check('active filter keeps only the true row (unknown is excluded, not treated as false)', filtered.includes('Devon Subscribed') && !filtered.includes('Kara Cash') && !filtered.includes('Uma Unknown'));
}
{
  staff();
  const { root } = await render('/patients?subscription=active', <Patients />);
  check('?subscription=active pre-applies the filter', one(root, 'select-subscription-filter').props.value === 'active' && !textOf(root).includes('Kara Cash') && textOf(root).includes('Devon Subscribed'));
}

console.log('\nroster: guided demo derives the chip from seeded subscriptions');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null, providerAccountCode: null });
  __setScope(null);
  __setSupabaseSession(null);
  requests.length = 0;
  const { root } = await render('/patients', <Patients />);
  check('demo: no live requests', requests.length === 0);
  const open = MOCK_SUBSCRIPTIONS.filter((s) => s.status !== 'cancelled').map((s) => s.patientId);
  const chips = root.findAll((n) => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('chip-subscription-'));
  check('demo: every open seeded subscription shows the chip (table + card layouts)', chips.length > 0 && chips.every((n) => open.includes(String(n.props['data-testid']).replace('chip-subscription-', ''))));
}

await act(async () => { for (const renderer of renderers) renderer.unmount(); });
if (failures) { console.error(`\n${failures} purchases check(s) failed`); process.exit(1); }
console.log('\nAll patient purchases checks passed.');
