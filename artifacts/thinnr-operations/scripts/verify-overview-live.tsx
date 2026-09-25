/**
 * Live Overview numbers for a signed-in office.
 *
 * Renders the REAL Overview page (and the Patients page its links open)
 * with react-test-renderer against a scripted global fetch and proves:
 *   - the MRR tile reads live billing (dash while loading, "Error" on
 *     failure, "—"/owners-only on 403, $0 honestly, populated with the
 *     active-subscription count) and never a seeded number;
 *   - the Revenue Trend switches source by auth state: live billing series
 *     for the shared range (total, prior-window delta or "no prior period",
 *     no-account empty state with a Payments setup link, error + retry);
 *   - the priority list gains "Failed Subscription Payments" from the
 *     past_due/unpaid count, linking to the filtered subscriptions page;
 *   - Active Patients, Check-ins Overdue, the attention banner and the
 *     reason cards equal the row counts the Patients page shows for the
 *     linked filters (same roster rows, same predicates — not the rollup);
 *   - the demo persona makes no request and keeps its demo labels.
 *
 * Run: pnpm --filter @workspace/thinnr-operations run test:overview-live
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { DateRangeProvider } from '../src/contexts/date-range';
import { addDaysToKey, rangeBoundsFor } from '../src/lib/date-range-keys';
import { buildLiveRevenueView, liveRevenueWindow } from '../src/lib/overview-live-revenue';
import { isActivatedRosterPatient, rosterHasReason, rosterReasonHref } from '../src/lib/roster-activity';
import type { OfficePatient, OfficeRoster, PatientActivitySignals } from '../src/lib/office-roster';
import type { OfficeDashboard, SeriesPoint } from '../src/lib/billing-types';
import Overview from '../src/pages/Overview';
import Patients from '../src/pages/Patients';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.setInterval ??= setInterval;
g.window.clearInterval ??= clearInterval;
g.navigator ??= {};

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (pass) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LIVE = rangeBoundsFor('live');
const RANGE = LIVE.defaultRange; // what DateRangeProvider hands the Overview in live mode
const AS_OF = RANGE.end;
const back = (days: number) => addDaysToKey(AS_OF, -days);

const SIGNALS: PatientActivitySignals = {
  asOfDate: AS_OF, loggedLast7: [true, true, false, true, true, false, true], loggedDays7: 5, mealStreak: 1,
  avgCalories7: 1400, avgWater7: 60, checkInStreak: 1, checkInRate30: 10, latestCheckInDate: AS_OF,
  moodCounts: { '1': 0, '2': 0, '3': 1, '4': 1, '5': 0 }, topSideEffects: [],
};
type Reasons = NonNullable<OfficePatient['operational']>['reasons'];
function patient(id: string, name: string, reasons: Reasons, activationStatus: string | null = 'activated'): OfficePatient {
  return {
    id, name, email: `${id}@example.com`, phone: null, phoneDisplay: null, activationStatus, verified: activationStatus === 'activated',
    createdAt: back(60), invitation: null,
    program: { id: 'metabolic', day: 40, stage: 'protocol', week: 6, startDate: back(40), startingWeight: 210, currentWeight: 200, goalWeight: 170, weightChange: -10, lastLogDate: null },
    operational: {
      asOfDate: AS_OF, latestActivityDate: back(1), latestDiaryDate: reasons.includes('logging_lapsed') ? back(9) : back(1), latestCheckInDate: reasons.includes('check_in_overdue') ? back(12) : AS_OF,
      latestWaterDate: null, latestWeightDate: null, latestPhotoDate: null, loggedDays7: 5, checkIns7: 1, activity: SIGNALS, followUps: [],
      // The server's verdict: a not-yet-activated row is "invited" whatever it is flagged for.
      status: activationStatus !== 'activated' ? 'invited' : reasons.length ? (reasons.includes('no_activity_14d') ? 'inactive' : 'needs_attention') : 'on_track', reasons,
    },
  } as OfficePatient;
}
// Two overdue, two lapsed, two inactive, four activated (Pia is still an
// invited row, so she is NOT an active patient even though she is flagged).
const ROSTER: OfficeRoster = {
  office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' },
  patients: [
    patient('p-ann', 'Ann Active', []),
    patient('p-bea', 'Bea Overdue', ['check_in_overdue']),
    patient('p-cal', 'Cal Both', ['check_in_overdue', 'logging_lapsed']),
    patient('p-dee', 'Dee Quiet', ['logging_lapsed', 'no_activity_14d']),
    patient('p-pia', 'Pia Pending', ['no_activity_14d'], 'pending'),
  ],
  // Deliberately NOT what the rows say: the Overview must count rows, not trust a second aggregate.
  summary: { totalPatients: 5, activePatients: 9, newEnrollments30d: 3, needsAttention: 9, inactive: 9, invited: 1, checkInsOverdue: 9, loggingLapsed: 9, asOf: AS_OF },
};
const ROLLUP = {
  scope: { kind: 'office', providerId: 'office-1', officeName: 'Beacon Hill Aesthetics' }, asOf: `${AS_OF}T12:00:00.000Z`,
  metrics: { providerCount: 1, totalPatients: 5, activePatients: 9, enrollments30d: 3, engaged7d: 3, needsAttention: 9, inactive: 9, invited: 1, watchlist: 0, loggingLapsed: 9, checkInsOverdue: 9, avgPoundsLost: 8.5,
    inbox: { openThreads: 2, waitingOnPatient: 1, closedThreads: 4, unanswered: 1, avgResponseMinutes: 42, openEscalations: 0 } },
};
const TRENDS = { office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics' }, range: RANGE, asOf: ROLLUP.asOf, definition: 'engaged = any activity', points: [] };

const WINDOW = liveRevenueWindow(RANGE);
const point = (date: string, collected: number, refunded = 0): SeriesPoint => ({ date, collected_cents: collected, net_cents: Math.round(collected * 0.6), fee_cents: Math.round(collected * 0.3), refunded_cents: refunded, orders: collected ? 1 : 0 });
function series(current: number, prior: number, refundOnLastDay = 0): SeriesPoint[] {
  const rows: SeriesPoint[] = [];
  for (let key = WINDOW.from; key <= RANGE.end; key = addDaysToKey(key, 1)) {
    const inRange = key >= RANGE.start;
    rows.push(point(key, inRange ? current : prior, inRange && key === RANGE.end ? refundOnLastDay : 0));
  }
  return rows;
}
function dashboard(overrides: Partial<OfficeDashboard> = {}): OfficeDashboard {
  return {
    balance: { available_cents: 0, pending_cents: 0 }, next_payout: null, collected_cents: 0, thinnr_fee_cents: 0, stripe_fee_cents: 0, refunded_cents: 0, net_cents: 0, orders: 0,
    active_subscriptions: 18, mrr_cents: 168_457, needs_attention_subscriptions: 2, to_ship: 0, account_connected: true,
    series: series(10_000, 8_000, 2_500), ...overrides,
  };
}

// ─── Scripted fetch ──────────────────────────────────────────────────────────

type Reply = () => Promise<Response> | Response;
const json = (status: number, body: unknown): Reply => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const never: Reply = () => new Promise<Response>(() => {});
let routes: Array<[string, Reply]> = [];
const requests: string[] = [];
g.fetch = async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push(url);
  const hit = routes.find(([prefix]) => url.startsWith(prefix));
  if (!hit) throw new Error(`unexpected fetch ${url}`);
  return hit[1]();
};
function stripeStatus(account: Record<string, unknown> | null, canManage = true) {
  const base = { stripe_account_id: 'acct_1', origin: 'created', details_submitted: true, charges_enabled: true, payouts_enabled: true, disconnected_at: null,
    requirements: { currently_due: [], past_due: [], eventually_due: [], disabled_reason: null, current_deadline: null } };
  return { account: account ? { ...base, ...account, requirements: { ...base.requirements, ...((account.requirements as object | undefined) ?? {}) } } : null,
    offered_products: 0, links: 0, sandbox: true, oauth_available: true,
    viewer: { office_role: canManage ? 'owner' : 'staff', can_manage: canManage }, office: { provider_id: 'office-1', office_name: 'Beacon Hill' } };
}
function script(overrides: Partial<Record<'roster' | 'overview' | 'trends' | 'dashboard' | 'status', Reply>> = {}) {
  requests.length = 0;
  routes = [
    ['/api/office/roster', overrides.roster ?? json(200, ROSTER)],
    ['/api/office/overview', overrides.overview ?? json(200, ROLLUP)],
    ['/api/office/engagement-trends', overrides.trends ?? json(200, TRENDS)],
    ['/api/billing/office/dashboard', overrides.dashboard ?? json(200, dashboard())],
    ['/api/billing/office/status', overrides.status ?? json(200, stripeStatus({}))],
  ];
}
function persona(kind: 'demo' | 'owner' | 'hq') {
  __setScope(null);
  if (kind === 'demo') { __setSession({ authStatus: 'signed-out', authRole: null, authUser: null }); __setSupabaseSession(null); }
  else if (kind === 'hq') { __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1', displayName: 'Harper Quinn' } }); __setScope({ providerId: 'office-1', officeName: 'Beacon Hill', providerName: 'Dr. Maya Chen, NP', providerRole: 'Owner' }); __setSupabaseSession('hq-token'); }
  else { __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1', displayName: 'Sarah Jenkins' } }); __setSupabaseSession('staff-token'); }
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

interface Rendered { renderer: ReactTestRenderer; root: ReactTestInstance; client: QueryClient }
async function settle(rounds = 12) { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
async function render(element: React.ReactElement, path = '/', settleRounds = 12): Promise<Rendered> {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <PatientSessionProvider>
          <DateRangeProvider>
            <Router hook={loc.hook}>{element}</Router>
          </DateRangeProvider>
        </PatientSessionProvider>
      </QueryClientProvider>,
    );
  });
  await settle(settleRounds);
  return { renderer, root: renderer.root, client };
}
function textOf(instance: ReactTestInstance | string): string {
  if (typeof instance === 'string') return instance;
  return instance.children.map((child) => textOf(child as ReactTestInstance | string)).join('');
}
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string')[0];
const hasTestId = (root: ReactTestInstance, id: string) => Boolean(byTestId(root, id));
/** The metric tile whose label matches: [value, change badge, detail]. */
function metric(root: ReactTestInstance, label: string): { value: string; change: string; detail: string } {
  const tile = root.findAll((node) => node.type === 'div' && typeof node.props.className === 'string' && node.props.className.startsWith('rounded-lg border border-card-border bg-card p-4'))
    .find((node) => textOf(node.findAll((child) => child.type === 'span')[0]).includes(label));
  if (!tile) throw new Error(`no ${label} tile`);
  const [value, detail] = tile.findAll((node) => node.type === 'p').map(textOf);
  const change = textOf(tile.findAll((node) => node.type === 'span')[2]);
  return { value, change, detail };
}
/** Priority cards: title → href (empty for toast buttons). */
function priorityCards(root: ReactTestInstance): Map<string, string> {
  const cards = root.findAll((node) => (node.type === 'a' || node.type === 'button') && typeof node.props.className === 'string' && node.props.className.startsWith('group flex w-full items-start gap-3 border-t'));
  return new Map(cards.map((card) => [textOf(card.findAll((node) => node.type === 'b')[0]), card.props.href ?? '']));
}
const patientRows = (root: ReactTestInstance) => root.findAll((node) => node.type === 'tr' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Open '));
function deferredReply() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => { resolve = next; });
  return {
    reply: () => promise,
    json(status: number, body: unknown) {
      resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    },
  };
}
function sequence(...replies: Reply[]): Reply {
  let index = 0;
  return () => (replies[Math.min(index++, replies.length - 1)]());
}

// ─── Pure: live revenue view ─────────────────────────────────────────────────

console.log('live revenue view');
{
  const days = WINDOW.dayCount;
  check('window spans the prior equal-length range plus the selection', WINDOW.to === RANGE.end && addDaysToKey(WINDOW.from, days) === RANGE.start && days === 30);
  const view = buildLiveRevenueView(RANGE, series(10_000, 8_000, 2_500));
  check('total sums the selected range only', view.totalCents === 10_000 * days && view.priorTotalCents === 8_000 * days);
  check('delta compares against the prior window', view.deltaPct !== null && Math.abs(view.deltaPct - 25) < 1e-9);
  check('net subtracts same-day refunds (a day can go negative)', view.net[view.net.length - 1] === 7_500 && view.gross[view.gross.length - 1] === 10_000 && view.dates[0] === RANGE.start);
  const first = buildLiveRevenueView(RANGE, series(10_000, 0));
  check('no prior revenue → null delta, never an invented percentage', first.deltaPct === null && first.priorTotalCents === null && first.totalCents === 10_000 * days);
  const sparse = buildLiveRevenueView(RANGE, [point(RANGE.end, 5_000)]);
  check('missing days fill with zero', sparse.dates.length === days && sparse.totalCents === 5_000 && sparse.gross.filter((value) => value === 0).length === days - 1);
  const negative = buildLiveRevenueView(RANGE, [point(RANGE.start, 0, 4_000)]);
  check('refund-only day nets below zero', negative.net[0] === -4_000 && negative.gross[0] === 0);
}

// ─── Rendered: signed-in owner, populated ────────────────────────────────────

const days = WINDOW.dayCount;
console.log('\nowner · populated');
{
  persona('owner'); script();
  const { renderer, root } = await render(<Overview />);
  const text = textOf(root);
  check('no demo wording on a real office', !text.includes('Demo projection') && !text.includes('Synthetic finance') && !text.includes('not live'));
  const mrr = metric(root, 'MRR');
  check('MRR tile from live billing ($1,684.57 → $1.7k)', mrr.value === '$1.7k' && mrr.change === 'Live billing' && mrr.detail === '18 active subscriptions', JSON.stringify(mrr));
  const dashboardCall = requests.find((url) => url.startsWith('/api/billing/office/dashboard'));
  check('one dashboard request spanning prior + current window', requests.filter((url) => url.startsWith('/api/billing/office/dashboard')).length === 1 && dashboardCall!.includes(`from=${WINDOW.from}`) && dashboardCall!.includes(`to=${RANGE.end}`), dashboardCall);
  check('revenue section is the live one with the chart', hasTestId(root, 'section-revenue-live') && hasTestId(root, 'chart-revenue-live') && text.includes('Live billing'));
  const totalText = textOf(byTestId(root, 'text-revenue-total'));
  const expectedTotal = `$${((10_000 * days) / 100 / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  check(`revenue total is the live range total (${expectedTotal})`, totalText === expectedTotal, totalText);
  check('delta vs prior window is +25.0%', textOf(byTestId(root, 'text-revenue-delta')).includes('25.0%') && textOf(byTestId(root, 'text-revenue-range')).includes(`vs prior ${days} days`));
  check('chart readout hidden at rest (readout only while engaged)', !text.includes('Gross collected:') && root.findAll((node) => node.props['data-testid'] === 'chart-revenue-live').length === 1);
  const cards = priorityCards(root);
  check('failed subscription payments card links to the filtered subscriptions page', cards.get('Failed Subscription Payments') === '/payments/subscriptions?status=needs_attention' && text.includes('2 subscriptions have a failed renewal payment'), JSON.stringify([...cards]));
  check('reason cards link to the roster filters', cards.get('Missed Check-ins') === rosterReasonHref('check_in_overdue') && cards.get('Logging Lapsed') === rosterReasonHref('logging_lapsed') && cards.get('Inactive Patients') === rosterReasonHref('no_activity_14d'));
  const overdue = ROSTER.patients.filter((row) => rosterHasReason(row, 'check_in_overdue')).length;
  const lapsed = ROSTER.patients.filter((row) => rosterHasReason(row, 'logging_lapsed')).length;
  const inactive = ROSTER.patients.filter((row) => rosterHasReason(row, 'no_activity_14d')).length;
  const active = ROSTER.patients.filter(isActivatedRosterPatient).length;
  check('card bodies count the roster rows, not the rollup', text.includes(`${overdue} patients missed their scheduled protocol check-in`) && text.includes(`${lapsed} patients have stopped logging`) && text.includes(`${inactive} patients have no recent activity`) && overdue === 2 && lapsed === 2 && inactive === 2 && active === 4);
  const activeTile = metric(root, 'Active Patients');
  check('Active Patients = activated roster rows (4), not the rollup (9)', activeTile.value === '4' && activeTile.detail === '3 new this month', JSON.stringify(activeTile));
  const overdueTile = metric(root, 'Check-ins Overdue');
  check('Check-ins Overdue = roster rows flagged (2), not the rollup (9)', overdueTile.value === '2', JSON.stringify(overdueTile));
  const banner = byTestId(root, 'banner-overdue');
  check('attention banner counts the same rows and links to the same filter', Boolean(banner) && textOf(banner).includes('2 patients need attention') && banner.findAll((node) => node.type === 'a')[0].props.href === rosterReasonHref('check_in_overdue'));
  check('logging compliance uses the roster count', text.includes('2 lapsed'));
  check('inbox tiles still come from the rollup', text.includes('Open threads') && text.includes('42 min'));
  renderer.unmount();
}

console.log('\nowner · Patients page agrees with every Overview link');
{
  persona('owner');
  for (const [path, expected] of [
    ['/patients?status=active', 4],
    [rosterReasonHref('check_in_overdue'), 2],
    [rosterReasonHref('logging_lapsed'), 2],
    [rosterReasonHref('no_activity_14d'), 2],
  ] as Array<[string, number]>) {
    script();
    const { renderer, root } = await render(<Patients />, path);
    const rows = patientRows(root).length;
    check(`${path} lists ${expected} patient${expected === 1 ? '' : 's'}`, rows === expected, `saw ${rows}`);
    renderer.unmount();
  }
}

console.log('\nowner · billing states');
{
  persona('owner'); script({ dashboard: never });
  let { renderer, root } = await render(<Overview />);
  check('loading: shaped metric and chart placeholders, no seeded number', hasTestId(root, 'loading-metric-mrr') && hasTestId(root, 'revenue-loading') && !textOf(root).includes('$1.7k'));
  check('loading: Active Patients still live from the roster', metric(root, 'Active Patients').value === '4');
  renderer.unmount();

  script({ dashboard: json(500, { error: 'Payments temporarily unavailable.' }) });
  ({ renderer, root } = await render(<Overview />));
  let mrr = metric(root, 'MRR');
  check('error: "Error" like the other live tiles', mrr.value === 'Error' && mrr.detail === 'Failed to load' && hasTestId(root, 'revenue-error') && textOf(byTestId(root, 'text-revenue-total')) === 'Error', JSON.stringify(mrr));
  check('error: retry control present and no failed-payments card is invented', textOf(byTestId(root, 'revenue-error')).includes('Try again') && !priorityCards(root).has('Failed Subscription Payments'));
  check('error: reason cards still render from the roster', priorityCards(root).has('Missed Check-ins'));
  renderer.unmount();

  script({ dashboard: json(403, { error: 'Only office owners and admins can view payments.' }) });
  ({ renderer, root } = await render(<Overview />));
  mrr = metric(root, 'MRR');
  check('403 (staff role): owners-only notice, not an error', mrr.value === '—' && mrr.detail === 'Owners and admins only' && hasTestId(root, 'revenue-forbidden') && !hasTestId(root, 'revenue-error'), JSON.stringify(mrr));
  renderer.unmount();

  script({ dashboard: json(200, dashboard({ active_subscriptions: 0, mrr_cents: 0, needs_attention_subscriptions: 0, series: series(0, 0) })) });
  ({ renderer, root } = await render(<Overview />));
  mrr = metric(root, 'MRR');
  check('zero: $0 with an honest detail line', mrr.value === '$0' && mrr.detail === 'No active subscriptions', JSON.stringify(mrr));
  check('zero: empty chart label, no delta, no failed-payments card', textOf(root).includes('No payments in this range yet') && textOf(byTestId(root, 'text-revenue-delta')) === 'No prior period to compare' && !priorityCards(root).has('Failed Subscription Payments'));
  renderer.unmount();

  script({ dashboard: json(200, dashboard({ series: series(10_000, 0) })) });
  ({ renderer, root } = await render(<Overview />));
  check('pre-dataset prior window: "No prior period to compare" instead of a delta', textOf(byTestId(root, 'text-revenue-delta')) === 'No prior period to compare' && textOf(byTestId(root, 'text-revenue-range')).includes('Gross collected'));
  renderer.unmount();

  script({ dashboard: json(200, dashboard({ account_connected: false, active_subscriptions: 0, mrr_cents: 0, needs_attention_subscriptions: 0, series: series(0, 0) })) });
  ({ renderer, root } = await render(<Overview />));
  mrr = metric(root, 'MRR');
  const setup = byTestId(root, 'link-payments-setup');
  check('no account: $0 + not-connected detail, empty state links to Payments setup', mrr.value === '$0' && mrr.detail === 'Payments not connected yet' && hasTestId(root, 'revenue-no-account') && setup?.props.href === '/payments/get-paid' && !hasTestId(root, 'chart-revenue-live'), JSON.stringify(mrr));
  renderer.unmount();

  script({ dashboard: json(200, dashboard({ needs_attention_subscriptions: 1 })) });
  ({ renderer, root } = await render(<Overview />));
  check('singular failed-payment copy', textOf(root).includes('1 subscription has a failed renewal payment'));
  renderer.unmount();
}

console.log('\nowner · roster states');
{
  persona('owner'); script({ roster: never });
  let { renderer, root } = await render(<Overview />);
  check('roster loading: shaped tiles and rows, MRR independent', hasTestId(root, 'loading-metric-active-patients') && hasTestId(root, 'loading-metric-check-ins-overdue') && hasTestId(root, 'loading-priority-items') && hasTestId(root, 'loading-watchlist') && metric(root, 'MRR').value === '$1.7k');
  renderer.unmount();
  script({ roster: json(500, { error: 'Roster unavailable.' }) });
  ({ renderer, root } = await render(<Overview />));
  check('roster error: "Error" on the count tiles, no banner', metric(root, 'Active Patients').value === 'Error' && metric(root, 'Check-ins Overdue').value === 'Error' && !hasTestId(root, 'banner-overdue') && textOf(root).includes('Failed to load priority items.'));
  renderer.unmount();
}

console.log('\nowner · independently delayed resources');
{
  persona('owner');
  const roster = deferredReply();
  const overview = deferredReply();
  const trends = deferredReply();
  const billing = deferredReply();
  script({ roster: roster.reply, overview: overview.reply, trends: trends.reply, dashboard: billing.reply });
  const { renderer, root } = await render(<Overview />, '/', 1);
  check('each unresolved resource owns its placeholder', hasTestId(root, 'loading-inbox') && hasTestId(root, 'loading-engagement') && hasTestId(root, 'loading-metric-mrr') && hasTestId(root, 'loading-metric-active-patients') && hasTestId(root, 'loading-watchlist'));
  const skeletonRows = (id: string) => byTestId(root, id).findAll((node) =>
    node.type === 'div'
    && typeof node.props.className === 'string'
    && node.props.className.includes('flex items-center gap-3')
    && (node.props.className.includes('p-4') || node.props.className.includes('p-2.5')),
  ).length;
  const chartHeight = (id: string) => byTestId(root, id).findAll((node) =>
    node.type === 'div' && typeof node.props.style?.height === 'number',
  )[0]?.props.style.height;
  check(
    'loading shapes reserve section-sized space without clipped overflow',
    chartHeight('revenue-loading') === 220
      && chartHeight('loading-engagement') === 190
      && skeletonRows('loading-protocol-stages') === 3
      && skeletonRows('loading-priority-items') === 1
      && skeletonRows('loading-logging-compliance') === 1
      && skeletonRows('loading-watchlist') === 3,
  );

  overview.json(200, ROLLUP);
  await settle();
  check('overview success replaces only inbox loading', !hasTestId(root, 'loading-inbox') && textOf(root).includes('42 min') && hasTestId(root, 'loading-engagement') && hasTestId(root, 'loading-metric-mrr') && hasTestId(root, 'loading-watchlist'));

  trends.json(200, TRENDS);
  await settle();
  check('empty engagement is explicit and leaves other requests pending', textOf(root).includes('No engagement data available for this range.') && !hasTestId(root, 'loading-engagement') && hasTestId(root, 'loading-metric-mrr') && hasTestId(root, 'loading-watchlist'));

  billing.json(500, { error: 'Payments temporarily unavailable.' });
  await settle();
  check('finance error is genuine and isolated from roster loading', metric(root, 'MRR').value === 'Error' && hasTestId(root, 'revenue-error') && hasTestId(root, 'loading-watchlist'));

  roster.json(200, { ...ROSTER, patients: [], summary: { ...ROSTER.summary, totalPatients: 0, activePatients: 0, newEnrollments30d: 0 } });
  await settle();
  check('empty roster shows genuine zeroes, not demo rows', metric(root, 'Active Patients').value === '0' && metric(root, 'Check-ins Overdue').value === '0' && textOf(root).includes('No patients in this provider view.') && !textOf(root).includes('Ann Active'));
  renderer.unmount();
}

console.log('\nowner · background refresh');
{
  persona('owner');
  const rosterRefresh = deferredReply();
  const overviewRefresh = deferredReply();
  const trendsRefresh = deferredReply();
  const billingRefresh = deferredReply();
  script({
    roster: sequence(json(200, ROSTER), rosterRefresh.reply),
    overview: sequence(json(200, ROLLUP), overviewRefresh.reply),
    trends: sequence(json(200, TRENDS), trendsRefresh.reply),
    dashboard: sequence(json(200, dashboard()), billingRefresh.reply),
  });
  const { renderer, root, client } = await render(<Overview />);
  await act(async () => { void client.invalidateQueries(); });
  await settle(1);
  check('same-scope refresh keeps resolved content instead of skeletons', metric(root, 'MRR').value === '$1.7k' && metric(root, 'Active Patients').value === '4' && textOf(root).includes('Ann Active') && !hasTestId(root, 'loading-inbox') && !hasTestId(root, 'revenue-loading') && !hasTestId(root, 'loading-watchlist'));
  rosterRefresh.json(200, ROSTER);
  overviewRefresh.json(200, ROLLUP);
  trendsRefresh.json(200, TRENDS);
  billingRefresh.json(200, dashboard());
  await settle();
  renderer.unmount();
}

console.log('\nHQ drill-in · office switch isolation');
{
  persona('hq');
  const nextRoster = deferredReply();
  const nextOverview = deferredReply();
  const nextTrends = deferredReply();
  const nextBilling = deferredReply();
  script({
    roster: sequence(json(200, ROSTER), nextRoster.reply),
    overview: sequence(json(200, ROLLUP), nextOverview.reply),
    trends: sequence(json(200, TRENDS), nextTrends.reply),
    dashboard: sequence(json(200, dashboard()), nextBilling.reply),
  });
  const rendered = await render(<Overview />);
  __setScope({ providerId: 'office-2', officeName: 'Second Office', providerName: 'Dr. New Owner', providerRole: 'Owner' });
  await act(async () => { rendered.renderer.update(
    <QueryClientProvider client={rendered.client}>
      <PatientSessionProvider><DateRangeProvider><Router hook={memoryLocation({ path: '/' }).hook}><Overview /></Router></DateRangeProvider></PatientSessionProvider>
    </QueryClientProvider>,
  ); });
  await settle(1);
  const switchedText = textOf(rendered.root);
  check('office switch never paints the previous office while next scope loads', hasTestId(rendered.root, 'loading-inbox') && hasTestId(rendered.root, 'loading-metric-mrr') && hasTestId(rendered.root, 'loading-watchlist') && !switchedText.includes('$1.7k') && !switchedText.includes('Ann Active'));
  nextRoster.json(200, { ...ROSTER, office: { ...ROSTER.office, providerId: 'office-2', officeName: 'Second Office' }, patients: [] });
  nextOverview.json(200, { ...ROLLUP, scope: { kind: 'office', providerId: 'office-2', officeName: 'Second Office' } });
  nextTrends.json(200, { ...TRENDS, office: { providerId: 'office-2', officeName: 'Second Office' } });
  nextBilling.json(200, dashboard({ active_subscriptions: 0, mrr_cents: 0, series: series(0, 0) }));
  await settle();
  rendered.renderer.unmount();
}

console.log('\nHQ drill-in');
{
  persona('hq'); script();
  const { renderer, root } = await render(<Overview />);
  const dashboardCall = requests.find((url) => url.startsWith('/api/billing/office/dashboard')) ?? '';
  check('dashboard request carries ?office= for the drilled-in account', dashboardCall.includes('office=office-1'), dashboardCall);
  check('HQ sees the same live tiles', metric(root, 'MRR').value === '$1.7k' && metric(root, 'Active Patients').value === '4');
  renderer.unmount();
}

console.log('\nStripe review banner');
{
  const banners = (root: ReactTestInstance) => ({ reviewing: hasTestId(root, 'banner-stripe-reviewing'), needsInfo: hasTestId(root, 'banner-stripe-needs-info') });
  const linkHref = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && node.props.href !== undefined)[0]?.props.href;
  persona('owner');

  script({ status: json(200, stripeStatus({ charges_enabled: false, payouts_enabled: false, requirements: { disabled_reason: 'requirements.pending_verification' } })) });
  let { renderer, root } = await render(<Overview />);
  let text = textOf(root);
  check('reviewing: calm "Stripe is reviewing" banner', banners(root).reviewing && !banners(root).needsInfo && text.includes('Stripe is reviewing your details.') && text.includes("There's nothing you need to do right now"), text.slice(0, 300));
  check('reviewing: links to Get paid', linkHref(root, 'link-stripe-reviewing') === '/payments/get-paid', String(linkHref(root, 'link-stripe-reviewing')));
  renderer.unmount();

  script({ status: json(200, stripeStatus({ charges_enabled: false, payouts_enabled: false, requirements: { currently_due: ['individual.verification.document'], disabled_reason: 'requirements.past_due', current_deadline: '2026-10-20T16:00:00Z' } })) });
  ({ renderer, root } = await render(<Overview />));
  text = textOf(root);
  check('needs more info: separate "needs more from you" banner', banners(root).needsInfo && !banners(root).reviewing && text.includes('Stripe needs a few more details from you.'));
  check('needs more info: states the deadline', text.includes('Please send them by') && text.includes('2026'), text.slice(0, 400));
  check('needs more info: button to finish Stripe\'s steps on Get paid', linkHref(root, 'link-stripe-needs-info') === '/payments/get-paid' && text.includes("Finish Stripe's steps"));
  renderer.unmount();

  script({ status: json(200, stripeStatus({ requirements: { past_due: ['external_account'] } })) });
  ({ renderer, root } = await render(<Overview />));
  check('past-due items on an enabled account still ask for more', banners(root).needsInfo);
  renderer.unmount();

  script({ status: json(200, stripeStatus({ charges_enabled: true, payouts_enabled: false })) });
  ({ renderer, root } = await render(<Overview />));
  text = textOf(root);
  check('charges on, payouts pending: reviewing copy says patients can already pay', banners(root).reviewing && text.includes('Patients can already pay you'));
  renderer.unmount();

  script();
  ({ renderer, root } = await render(<Overview />));
  check('fully enabled account: no banner', !banners(root).reviewing && !banners(root).needsInfo && requests.some((url) => url.startsWith('/api/billing/office/status')));
  renderer.unmount();

  script({ status: json(200, stripeStatus({ charges_enabled: false, payouts_enabled: false }, false)) });
  ({ renderer, root } = await render(<Overview />));
  check('staff who cannot manage payments: no banner', !banners(root).reviewing && !banners(root).needsInfo);
  renderer.unmount();

  script({ status: json(500, { error: 'offline' }) });
  ({ renderer, root } = await render(<Overview />));
  check('status read failing: no banner, page still renders', !banners(root).reviewing && !banners(root).needsInfo && metric(root, 'Active Patients').value === '4');
  renderer.unmount();

  persona('hq'); script({ status: json(200, stripeStatus({ charges_enabled: false, payouts_enabled: false })) });
  ({ renderer, root } = await render(<Overview />));
  check('HQ drill-in: no banner and no status read', !banners(root).reviewing && !requests.some((url) => url.startsWith('/api/billing/office/status')), requests.join(', '));
  renderer.unmount();

  persona('demo'); script({ status: json(200, stripeStatus({ charges_enabled: false, payouts_enabled: false })) });
  ({ renderer, root } = await render(<Overview />));
  check('demo: no banner and no status read', !banners(root).reviewing && !banners(root).needsInfo && requests.length === 0, requests.join(', '));
  renderer.unmount();
}

console.log('\ndemo persona');
{
  persona('demo'); script();
  const { renderer, root } = await render(<Overview />);
  const text = textOf(root);
  check('no live request at all', requests.length === 0, requests.join(', '));
  check('demo labels intact', metric(root, 'MRR').change === 'Demo projection' && metric(root, 'MRR').detail === 'Synthetic finance · not live' && text.includes('Demo projection') && !text.includes('Live billing'));
  check('demo revenue section is the bar chart, not the live one', !hasTestId(root, 'section-revenue-live') && hasTestId(root, 'row-trend-labels'));
  const cards = priorityCards(root);
  check('demo priority cards are toast buttons (no hrefs)', cards.size === 3 && [...cards.values()].every((href) => href === ''));
  renderer.unmount();
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall overview-live checks passed');
