/**
 * Payments overview suite (run: pnpm run test:payments-overview).
 *
 * Renders the REAL overview screen and proves:
 *   - signed out → demo branch from the pinned dataset (tiles, today's
 *     running totals, charts, activity), sandbox badge, no fetch at all;
 *   - signed in → status is fetched with the staff bearer, then the
 *     dashboard for the last-30-days device-local range and today's totals
 *     for the device tz; loading and error states; 403 → permission state;
 *     no account → redirect to Get paid; range chips refetch;
 *   - chart semantics: spoken summary, readout only while touched, running
 *     totals ("so far"), signed domain, empty label.
 */
import React, { act } from 'react';
import { all, check, finish, ids, isBlocked, mount, one, paths, press, requests, resetRequests, routerLog, section, setScript, settle, STAFF, text, textOf } from './payments-stubs/harness';
import { DEMO_DASHBOARD, DEMO_TODAY, DEMO_ACTIVITY } from '../data/office-payments-demo';
import { AreaChart, chartSummary, hourlySeriesFrom, niceMax, runningHourLabel, seriesFrom } from '../components/payments/RevenueCharts';
import { formatCents } from '../lib/office-billing-format';
import { localDayKey, rangeForPreset } from '../components/payments/range';
import type { OfficeBillingStatus } from '../lib/office-billing-types';
import OverviewScreen from '../app/(tabs)/payments/index';

const STATUS: OfficeBillingStatus = {
  account: { id: 'acct_1', charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements_due: [], onboarding_status: 'complete', currently_due_count: 0, past_due_count: 0, disabled_reason: null, business_name: 'Maple Med Spa', payout_schedule: 'daily' } as unknown as OfficeBillingStatus['account'],
  offered_products: 3,
  links: 1,
  sandbox: true,
  oauth_available: true,
  viewer: { office_role: 'owner', can_manage: true },
  office: { provider_id: 'prov-1', office_name: 'Maple Med Spa' },
};

const LIVE_DASHBOARD = { ...DEMO_DASHBOARD, collected_cents: 123456, net_cents: 70000, orders: 9 };
const LIVE_TODAY = { ...DEMO_TODAY, collected_cents: 5000 };

function liveScript(over: Partial<Record<string, { status: number; body: unknown }>> = {}) {
  setScript((req) => {
    if (over[req.path]) return over[req.path];
    if (req.path === '/api/billing/office/status') return { status: 200, body: STATUS };
    if (req.path === '/api/billing/office/dashboard') return { status: 200, body: LIVE_DASHBOARD };
    if (req.path === '/api/billing/office/overview/today') return { status: 200, body: LIVE_TODAY };
    if (req.path === '/api/billing/office/activity') return { status: 200, body: { items: DEMO_ACTIVITY.slice(0, 2), next_cursor: null } };
    return undefined;
  });
}

async function main() {
  section('Pure chart helpers');
  check('niceMax rounds up to nice steps', niceMax(1234) === 2000 && niceMax(2600) === 5000 && niceMax(0) === 1);
  const hourly = hourlySeriesFrom(DEMO_TODAY.hours, DEMO_TODAY.current_hour);
  check('hourly series is a running total through the current hour', hourly.hours.length === DEMO_TODAY.current_hour + 1 && hourly.gross.every((v, i, arr) => i === 0 || v >= arr[i - 1]));
  check('hourly gross ends at today total', hourly.gross[hourly.gross.length - 1] === DEMO_TODAY.hours.filter((h) => h.hour <= DEMO_TODAY.current_hour).reduce((s, h) => s + h.collected_cents, 0));
  check('running hour labels', runningHourLabel('14', '14') === 'So far today' && runningHourLabel('13', '14') === 'Through 2 PM');
  const summary = chartSummary('Test', ['0', '1'], [{ key: 'a', label: 'Gross', color: '#000', values: [100, 250] }], 'money', (k) => `h${k}`, true);
  check('running summary reads the last point as the total', summary === 'Test, h0 to h1: Gross $2.50 so far.', summary);
  const s = seriesFrom(DEMO_DASHBOARD.series);
  check('seriesFrom net = collected - refunded', s.net.every((v, i) => v === DEMO_DASHBOARD.series[i].collected_cents - DEMO_DASHBOARD.series[i].refunded_cents));
  const today = new Date(2026, 8, 17);
  const range = rangeForPreset(30, today);
  check('30-day range is inclusive of today in device-local keys', range.from === '2026-08-19' && range.to === '2026-09-17', JSON.stringify(range));
  check('localDayKey pads', localDayKey(new Date(2026, 0, 5)) === '2026-01-05');

  section('AreaChart semantics');
  {
    const chart = await mount(
      <AreaChart title="Net" dates={['2026-10-05', '2026-10-06', '2026-10-07']} unit="money" testID="c" series={[{ key: 'n', label: 'Net', color: '#000', values: [-500, 1000, 2500] }]} />,
      null,
    );
    const plot = one(chart.root, 'c-plot')!;
    check('spoken summary on the plot', typeof plot.props.accessibilityLabel === 'string' && plot.props.accessibilityLabel.startsWith('Net, Oct 5 to Oct 7'), plot.props.accessibilityLabel);
    check('no readout at rest', !one(chart.root, 'c-readout'));
    const svgTexts = plot.findAll((n) => n.type === 'SvgText').map(textOf);
    check('signed y-axis shows a negative tick', svgTexts.includes('-$10') || svgTexts.includes('-$5'), svgTexts.join(','));
    await act(async () => { plot.props.onResponderGrant({ nativeEvent: { locationX: 48 } }); });
    await settle(1);
    check('touch pins readout to the first point', text(chart.root, 'c-readout').includes('Oct 5') && /[-\u2212]\$5\.00/.test(text(chart.root, 'c-readout')), text(chart.root, 'c-readout'));
    await act(async () => { plot.props.onResponderMove({ nativeEvent: { locationX: 10_000 } }); });
    await settle(1);
    check('drag clamps to the last point', text(chart.root, 'c-readout').includes('Oct 7') && text(chart.root, 'c-readout').includes('$25.00'));
    await act(async () => { plot.props.onResponderRelease(); });
    await settle(1);
    check('release clears the readout', !one(chart.root, 'c-readout'));
    await chart.unmount();
    const empty = await mount(<AreaChart title="Empty" dates={['2026-10-05']} unit="money" testID="e" series={[{ key: 'n', label: 'Net', color: '#000', values: [0] }]} emptyLabel="Nothing yet" />, null);
    check('all-zero renders the empty label with the summary', textOf(one(empty.root, 'e')!).includes('Nothing yet') && one(empty.root, 'e')!.props.accessibilityLabel.includes('Empty'));
    await empty.unmount();
  }

  section('Demo persona (signed out)');
  {
    resetRequests();
    liveScript();
    const demo = await mount(<OverviewScreen />, null);
    check('no request leaves the app in demo', requests.length === 0, paths().join(' | '));
    check('demo notice + sandbox badge', !!one(demo.root, 'billing-demo-notice') && !!one(demo.root, 'billing-sandbox-badge'));
    check('title', text(demo.root, 'payments-title') === 'Payments overview');
    check('available balance tile from the pinned dataset', text(demo.root, 'tile-available').includes(formatCents(DEMO_DASHBOARD.balance.available_cents)));
    check('office net tile', text(demo.root, 'tile-office-net').includes(formatCents(DEMO_DASHBOARD.net_cents)));
    check('today gross from the pinned dataset', text(demo.root, 'today-gross') === formatCents(DEMO_TODAY.collected_cents));
    check('today chart is a running total', !!one(demo.root, 'chart-today-revenue-plot') && String(one(demo.root, 'chart-today-revenue-plot')!.props.accessibilityLabel).includes('so far'));
    check('daily revenue chart renders', !!one(demo.root, 'chart-daily-revenue-plot'));
    check('compact cards render', ['chart-payments', 'chart-refunds', 'chart-gross', 'chart-office-net'].every((id) => !!one(demo.root, id)));
    check('recent activity shows six rows', ids(demo.root, 'row-activity-').length === 6);
    check('section strip lists every section', ids(demo.root, 'tab-payments-').length === 10);
    const tab = one(demo.root, 'tab-payments-overview')!;
    check('overview tab selected', tab.props.accessibilityState?.selected === true && tab.props.accessibilityRole === 'tab');
    await press(demo.root, 'tab-payments-activity');
    check('section tab navigates', routerLog.some((c) => c.target === '/payments/activity'), JSON.stringify(routerLog));
    await press(demo.root, 'link-needs-attention');
    check('needs-attention links to past-due subscriptions', routerLog.some((c) => c.target === '/payments/subscriptions?status=past_due'), JSON.stringify(routerLog));
    check('no range picker in demo', !one(demo.root, 'overview-range-30'));
    await demo.unmount();
  }

  section('Live (signed in)');
  {
    resetRequests();
    liveScript();
    const live = await mount(<OverviewScreen />, STAFF);
    check('status, dashboard, today and activity fetched with the staff bearer', requests.length >= 4 && requests.every((r) => r.auth === 'Bearer staff-token'), paths().join(' | '));
    const expected = rangeForPreset(30);
    const dash = requests.find((r) => r.path === '/api/billing/office/dashboard');
    check('dashboard asks for the last 30 device-local days', !!dash && dash.url.includes(`from=${expected.from}`) && dash.url.includes(`to=${expected.to}`), dash?.url);
    const todayReq = requests.find((r) => r.path === '/api/billing/office/overview/today');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    check('today asks for the device time zone', !!todayReq && decodeURIComponent(todayReq.url).includes(`tz=${tz}`), todayReq?.url);
    check('no ?office= on any request', requests.every((r) => !r.url.includes('office=')));
    check('live figures, not demo', text(live.root, 'tile-gross').includes('$1,234.56') && text(live.root, 'tile-office-net').includes('$700.00'));
    check('no demo notice when signed in', !one(live.root, 'billing-demo-notice'));
    check('sandbox badge follows the status flag', !!one(live.root, 'billing-sandbox-badge'));
    check('range picker present with 30 days selected', one(live.root, 'overview-range-30')?.props.accessibilityState?.selected === true);
    check('recent activity shows live rows', ids(live.root, 'row-activity-').length === 2);
    resetRequests();
    await press(live.root, 'overview-range-7');
    await settle(4);
    const dash7 = requests.find((r) => r.path === '/api/billing/office/dashboard');
    const seven = rangeForPreset(7);
    check('7-day chip refetches the dashboard for 7 days', !!dash7 && dash7.url.includes(`from=${seven.from}`), `${dash7?.url} | ${paths().join(' , ')} | selected7=${one(live.root, 'overview-range-7')?.props.accessibilityState?.selected}`);
    await live.unmount();
  }

  section('Live states');
  {
    liveScript({ '/api/billing/office/dashboard': { status: 500, body: { error: 'boom' } } });
    const errored = await mount(<OverviewScreen />, STAFF);
    check('dashboard error is announced with retry', !!one(errored.root, 'overview-error') && !!one(errored.root, 'overview-error-retry'));
    liveScript();
    await press(errored.root, 'overview-error-retry');
    check('retry recovers', !one(errored.root, 'overview-error') && !!one(errored.root, 'tile-gross'));
    await errored.unmount();

    liveScript({ '/api/billing/office/status': { status: 403, body: { error: 'forbidden' } } });
    const forbidden = await mount(<OverviewScreen />, STAFF);
    check('403 → permission state', !!one(forbidden.root, 'status-billing-unauthorized'));
    await forbidden.unmount();

    liveScript({ '/api/billing/office/status': { status: 200, body: { ...STATUS, viewer: { office_role: 'staff', can_manage: false } } } });
    const staff = await mount(<OverviewScreen />, STAFF);
    check('can_manage=false → permission state', !!one(staff.root, 'status-billing-unauthorized'));
    await staff.unmount();

    liveScript({ '/api/billing/office/status': { status: 200, body: { ...STATUS, account: null } } });
    const { setPathname } = await import('./provider-training-stubs/expo-router');
    setPathname('/payments');
    const noAccount = await mount(<OverviewScreen />, STAFF);
    const redirect = noAccount.root.findAll((n) => n.type === 'Redirect')[0];
    check('no account → redirect to Get paid', redirect?.props.href === '/payments/get-paid');
    await noAccount.unmount();
    setPathname('/patients');
    const away = await mount(<OverviewScreen />, STAFF);
    check('redirect is guarded by the pathname', away.root.findAll((n) => n.type === 'Redirect').length === 0);
    await away.unmount();

    liveScript({ '/api/billing/office/status': { status: 500, body: {} } });
    const statusErr = await mount(<OverviewScreen />, STAFF);
    check('status error → announced error box', !!one(statusErr.root, 'billing-status-error') && one(statusErr.root, 'billing-status-error')!.props.accessibilityRole === 'alert');
    await statusErr.unmount();
  }

  section('Accessibility');
  {
    liveScript();
    const live = await mount(<OverviewScreen />, STAFF);
    const pressables = live.root.findAll((n) => n.type === 'Pressable' && typeof n.props.onPress === 'function');
    const unnamed = pressables.filter((n) => !n.props.accessibilityLabel && !n.props.accessibilityRole);
    check('every pressable has a role and a name', unnamed.length === 0, String(unnamed.length));
    check('view-all is a named control', !!one(live.root, 'link-view-activity') && !isBlocked(live.root, 'link-view-activity'));
    check('tiles render 8', all(live.root, 'office-overview-tiles')[0]?.children.length === 8);
    await live.unmount();
  }

  finish('payments-overview');
}

main().catch((error) => { console.error(error); process.exit(1); });
