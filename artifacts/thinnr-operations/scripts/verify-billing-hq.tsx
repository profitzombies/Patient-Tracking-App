import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { DateRangeProvider } from '../src/contexts/date-range';
import {
  ChangeProductDialog, PaymentProviderDetail, PaymentTransactionDetail, PaymentsFulfillment, PaymentsOverview,
  PaymentsProviders, PaymentsSubscriptions, PaymentsTransactions,
} from '../src/pages/admin/payments/HqPaymentsPages';
import { PaymentsActivity } from '../src/pages/admin/payments/PaymentsActivity';
import { PaymentsCatalog, SettingsCard } from '../src/pages/admin/payments/catalog/CatalogPage';
import { DEMO_CATALOG, DEMO_SUBSCRIPTIONS } from '../src/pages/admin/payments/demo-data';
import { PaymentsCatalogHistory } from '../src/pages/admin/payments/catalog/CatalogHistory';
import { ProductEditorPage } from '../src/pages/admin/payments/catalog/ProductEditor';
import { PaymentsHealthBannerView } from '../src/components/billing/PaymentsHealthBanner';
import { CADENCE_WEEKS, type HqCatalogResponse, type PaymentsHealth } from '../src/lib/billing-types';
import { AreaChart, hourLabel } from '../src/components/billing/hq/RevenueCharts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).window ??= {};
(globalThis as any).window.getSelection ??= () => ({ toString: () => '' });
(globalThis as any).window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).window.innerWidth ??= 1280;
let fetches = 0;
globalThis.fetch = async () => { fetches += 1; throw new Error('Demo pages must not fetch'); };
__setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });

let failures = 0;
const healthyPayments: PaymentsHealth = {
  sandbox: true, livemode: false, credentials_ok: true, connect_client_id_configured: true,
  public_origin: 'https://example.test',
  webhooks: { registered: true, endpoints: [], last_error: null, last_checked_at: '2026-10-13T00:00:00Z' },
  last_webhook_received_at: '2026-10-13T00:00:00Z', pending_orders_over_1h: 0,
  unprocessed_webhook_events: 0, last_reconcile_run: { at: '2026-10-13T00:00:00Z', status: 'succeeded' },
  failed_events_24h: 0,
};
{
  let healthy: ReturnType<typeof create> | undefined;
  let problem: ReturnType<typeof create> | undefined;
  let emails: ReturnType<typeof create> | undefined;
  await act(async () => {
    healthy = create(<PaymentsHealthBannerView health={{
      ...healthyPayments,
      stripe_customer_emails: { platform: 'not_applicable', accounts_off: 4, accounts_unverified: [], accounts_on: [] },
    }} />);
    emails = create(<PaymentsHealthBannerView health={{
      ...healthyPayments,
      stripe_customer_emails: { platform: 'not_applicable', accounts_off: 2, accounts_unverified: ['office-a'], accounts_on: ['office-b', 'office-c'] },
    }} />);
    problem = create(<PaymentsHealthBannerView health={{
      ...healthyPayments, webhooks: { ...healthyPayments.webhooks, registered: false },
      pending_orders_over_1h: 2, unprocessed_webhook_events: 3, last_reconcile_run: null,
    }} />);
  });
  const text = JSON.stringify(problem!.toJSON());
  const emailsText = JSON.stringify(emails!.toJSON());
  if (healthy!.toJSON() !== null || !['not registered', '2 orders are stuck pending', '3 webhook events are unprocessed', 'never run']
    .every((value) => text.includes(value))
    || !['Stripe is emailing customers for 2 connected accounts', '1 connected account has not confirmed Stripe customer emails are off']
      .every((value) => emailsText.includes(value))) {
    failures += 1;
    console.error('FAIL payments health banner states');
  } else console.log('ok payments health banner states');
  await act(async () => { healthy!.unmount(); problem!.unmount(); emails!.unmount(); });
}
async function check(name: string, path: string, Page: React.ComponentType, expected: string[]) {
  const location = memoryLocation({ path });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><Page /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const text = JSON.stringify(renderer!.toJSON());
  // The area is `nest`-mounted at /admin/payments, so every rendered link must
  // resolve under that base (never /admin/payments/admin/payments/...).
  const hrefs = renderer!.root.findAll(node => node.type === 'a' && typeof node.props.href === 'string').map(node => node.props.href as string);
  // Teammate profile links deliberately escape to the Team page.
  const badHref = hrefs.find(href => !(href.startsWith('/admin/payments') || href.startsWith('/admin/team?member=')) || href.includes('/admin/payments/admin/'));
  if (badHref) { failures += 1; console.error(`FAIL ${name}: link escapes the nested base: ${badHref}`); }
  const passed = expected.every(value => text.includes(value));
  if (!passed) { failures += 1; console.error(`FAIL ${name}: missing ${expected.filter(value => !text.includes(value)).join(', ')}`); }
  else console.log(`ok ${name}`);
  await act(async () => { renderer!.unmount(); });
}

await check('overview demo', '/admin/payments', PaymentsOverview, [
  'Live payments appear here once HQ is signed in', 'Jenkins Wellness', 'Gross collected', 'Net collected', 'THINNR profit', 'Payments processed',
  'Daily revenue', 'Payments per day', 'Refunds per day', 'View all activity', 'Payment received', 'TH-D3MO01',
  "Today's revenue", 'Sep 24 so far, running total by hour', 'THINNR fees', '4 PM',
  'Subscriptions needing attention',
]);
await check('subscription dunning demo', '/admin/payments/subscriptions', PaymentsSubscriptions, [
  'Payment failed', 'Card declined ', 'Retry payment', 'Email patient a payment link',
  'Paused', 'Resume', 'Pause', 'Change product', 'Changes to Detox', 'Oct 13, 2026',
]);
await check('activity demo rows', '/admin/payments/activity?kind=refund', PaymentsActivity, [
  'Refund issued', 'TH-D3MO03', 'Beacon Hill Aesthetics', 'All offices', 'Payment reports',
]);

{
  // Demo exposes every subscription write affordance, but none can invoke a mutation.
  const location = memoryLocation({ path: '/admin/payments/subscriptions' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><PaymentsSubscriptions /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const writes = renderer!.root.findAll(node =>
    node.type === 'button' && ['Pause', 'Resume', 'Change product', 'Cancel subscription…', 'Retry payment', 'Email patient a payment link'].includes(String(node.children.join(''))));
  const problems = [
    writes.length < 12 ? `expected demo write controls on every eligible row, found ${writes.length}` : '',
    writes.some(button => !button.props.disabled) ? 'a demo subscription write control is enabled' : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL subscription demo mutation guard: ${problems.join('; ')}`); }
  else console.log('ok subscription demo mutation guard');
  await act(async () => { renderer!.unmount(); });
}

{
  let chosen = '';
  let confirmed = 0;
  const row = DEMO_SUBSCRIPTIONS[1];
  const quote = {
    current: { product_id: row.product_id, product_name: row.product_name, unit_price_cents: row.unit_price_cents },
    next: { product_id: 'catalog-3', product_name: 'Detox', unit_price_cents: 8999, shipping_charge_cents: 1000, application_fee_cents: 4599 },
    effective_at: '2026-10-13T00:00:00Z',
  };
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(
      <ChangeProductDialog
        open row={row} productId="catalog-3"
        products={DEMO_CATALOG.products}
        quote={quote} pendingQuote={false} quoteError={null} pendingChange={false}
        onOpenChange={() => undefined}
        onProductChange={(id) => { chosen = id; }}
        onConfirm={() => { confirmed += 1; }}
      />,
    );
  });
  const text = JSON.stringify(renderer!.toJSON());
  const select = renderer!.root.find(node => node.type === 'select');
  const confirm = renderer!.root.find(node => node.type === 'button' && String(node.children.join('')) === 'Confirm product change');
  await act(async () => { select.props.onChange({ target: { value: 'catalog-4' } }); confirm.props.onClick(); });
  const problems = [
    !['Current product price', 'Current shipping', 'Current THINNR fee', 'Next product price', 'Next shipping', 'Next THINNR fee', 'Effective date', '$89.99', 'Oct 13, 2026'].every(value => text.includes(value))
      ? 'quote does not show the complete current/next fee comparison' : '',
    chosen !== 'catalog-4' ? `product selection reported ${chosen || '(nothing)'}` : '',
    confirmed !== 1 ? `confirm callback ran ${confirmed} times` : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL change product quote dialog: ${problems.join('; ')}`); }
  else console.log('ok change product quote dialog');
  await act(async () => { renderer!.unmount(); });
}

{
  // Overview: activity rows are real links to the transaction, and the chart carries a spoken summary.
  const location = memoryLocation({ path: '/admin/payments', record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><PaymentsOverview /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const rowLink = renderer!.root.findAll(node => node.type === 'a' && node.props.href === '/admin/payments/transactions/demo-order-1');
  const chart = renderer!.root.findAll(node => node.type === 'svg' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Daily revenue'));
  const small = renderer!.root.findAll(node => ['chart-payments', 'chart-refunds', 'chart-gross', 'chart-net'].includes(node.props['data-testid']));
  // Today's chart: hourly x keys through the demo's 4 PM; running totals (every series
  // non-decreasing); the readout card appears only once the chart is engaged
  // (keyboard here), never pinned to the last slot at rest.
  const today = renderer!.root.findAll(node => node.type === 'svg' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith("Today's revenue"));
  const restingReadout = renderer!.root.findAll(node => node.props['data-testid'] === 'chart-today-revenue-readout');
  const restingCrosshair = today.length ? today[0].findAll(node => node.type === 'circle') : [];
  const todayPaths = today.length ? today[0].findAll(node => node.type === 'path' && node.props.fill === 'none').map(node => String(node.props.d)) : [];
  // SVG y grows downward, so a rising running total means y never increases left to
  // right. Gross must be strictly a running total; net after refunds may step down in a
  // refund hour, but no series may ever fall back to the baseline once it has left it
  // (the old per-hour chart spiked and returned to zero).
  const pathYs = (d: string) => [...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map(m => Number(m[1]));
  const grossYs = todayPaths.length ? pathYs(todayPaths[0]) : [];
  const baseline = Math.max(...grossYs);
  const todayMonotone = todayPaths.length === 4
    && grossYs.every((v, i) => i === 0 || v <= grossYs[i - 1] + 0.05)
    && todayPaths.every(d => { const ys = pathYs(d); const left = ys.findIndex(v => v < baseline - 0.05); return left === -1 || ys.slice(left).every(v => v < baseline - 0.05); });
  if (today.length) await act(async () => { today[0].props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} }); });
  const todayReadout = renderer!.root.findAll(node => node.props['data-testid'] === 'chart-today-revenue-readout');
  const readoutHeader = todayReadout.length ? String(todayReadout[0].findAll(node => node.type === 'p')[0]?.children.join('')) : '';
  const readoutText = todayReadout.length ? JSON.stringify(todayReadout[0].children.map(child => typeof child === 'string' ? child : '')) : '';
  const readoutLabels = ['Gross collected', 'Net after refunds', 'THINNR fees', 'THINNR profit'].filter(label =>
    todayReadout.length && todayReadout[0].findAll(node => node.type === 'dt' && String(node.children.at(-1)) === label).length === 1);
  const todayGross = renderer!.root.findAll(node => node.props['data-testid'] === 'today-gross').map(node => String(node.children.join('')));
  const hourLabels = today.length ? today[0].findAll(node => node.type === 'text').map(node => String(node.children.join(''))) : [];
  const row = renderer!.root.find(node => node.props['data-testid'] === 'row-activity-activity-1' && node.type === 'tr');
  await act(async () => { row.props.onClick({ defaultPrevented: false, target: { closest: () => null } }); });
  const navigated = location.history.at(-1) ?? '';
  const problems = [
    rowLink.length === 0 ? 'activity row lacks a transaction link' : '',
    chart.length !== 1 ? `expected one daily revenue chart, found ${chart.length}` : '',
    small.length !== 4 ? `expected four small charts, found ${small.length}` : '',
    today.length !== 1 ? `expected one today chart, found ${today.length}` : '',
    restingReadout.length !== 0 || restingCrosshair.length !== 0 ? `today chart pins a readout at rest (${restingReadout.length} cards, ${restingCrosshair.length} dots)` : '',
    !todayMonotone ? `today series are not running totals: ${todayPaths.join(' | ')}` : '',
    readoutLabels.length !== 4 ? `today readout lists ${readoutLabels.join(', ') || 'nothing'} after keyboard engagement (${readoutText})` : '',
    !readoutHeader.startsWith('Through ') ? `today readout header reads "${readoutHeader}" (expected "Through <hour>")` : '',
    todayGross[0] !== '$1,289.90' ? `today gross tile shows ${todayGross[0] ?? '(missing)'}` : '',
    !hourLabels.includes('12 AM') || !hourLabels.includes('4 PM') || hourLabels.some(label => /^[A-Z][a-z]{2} \d/.test(label)) ? `today axis labels: ${hourLabels.join(' | ')}` : '',
    navigated !== '/admin/payments/transactions/demo-order-1' ? `row click navigated to ${navigated || '(nowhere)'}` : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL overview charts and activity links: ${problems.join('; ')}`); }
  else console.log('ok overview charts and activity links');
  await act(async () => { renderer!.unmount(); });
}
await check('providers demo rows', '/admin/payments/providers', PaymentsProviders, ['Jenkins Wellness', 'Beacon Hill Aesthetics', 'below minimum']);
await check('transactions demo rows', '/admin/payments/transactions', PaymentsTransactions, ['TH-D3MO01', 'Maya Thompson', 'Subscription renewal']);
await check('fulfillment demo rows', '/admin/payments/fulfillment?status=to_ship', PaymentsFulfillment, ['TH-D3MO01', 'Mark shipped', 'Copy address']);
await check('catalog demo rows', '/admin/payments/catalog', PaymentsCatalog, [
  'Control', 'Maintenance + Detox Stack', 'Add product', 'Active products', 'Program settings', 'Card fee rate', '"2.90"', '/admin/payments/catalog/products/new',
  'Metabolic & Appetite Support', 'Supplement · Every 2, 4, 6, 8, 10 or 12 weeks · default 4', 'Drops · Every 4, 8 or 12 weeks · default 4', 'Subscribe and save',
]);
await check('catalog history demo rows', '/admin/payments/catalog/history', PaymentsCatalogHistory, [
  'Office price changed', 'Jenkins Wellness', 'Alex Morgan', '/admin/team?member=hq-1', 'floor $109.99 → $119.99', 'price $79.99 → $84.99', ':27',
]);
await check(
  'product editor demo page',
  '/admin/payments/catalog/products/catalog-1',
  () => <ProductEditorPage params={{ productId: 'catalog-1' }} />,
  ['Control', 'Back to product catalog', 'Pictures', 'Fee math', 'Retire', 'Archive', 'Drag pictures here', 'Browse files',
    'Product page', 'Metabolic & Appetite Support', 'Dietary Supplement · 60 Vegetarian Capsules', 'Helps support healthy appetite**',
    'African Mango — Helps support healthy appetite and metabolic function.**', 'Where can I get Control?', 'Subscription plans', 'Every 12 weeks',
    'Subscribe and save is on: every cadence is quoted 10% under the office price.'],
);
await check(
  'provider detail back link',
  '/admin/payments/providers/jenkins',
  () => <PaymentProviderDetail params={{ providerId: 'jenkins' }} />,
  ['Jenkins Wellness', 'Back to providers', 'Collected · 30d', 'Active subscriptions', 'Recent orders', 'TH-D3MO01'],
);
await check(
  'transaction detail back link',
  '/admin/payments/transactions/demo-order-1',
  () => <PaymentTransactionDetail params={{ orderId: 'demo-order-1' }} />,
  ['TH-D3MO01', 'Back to transactions'],
);

{
  // New-product page: fee math updates live as the floor is typed, using the demo program settings.
  const location = memoryLocation({ path: '/admin/payments/catalog/products/new' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><ProductEditorPage params={{}} /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const floor = renderer!.root.find(node => node.props['data-testid'] === 'input-catalog-floor' && node.type === 'input');
  await act(async () => { floor.props.onChange({ target: { value: '59.99' } }); });
  const text = JSON.stringify(renderer!.toJSON());
  const problems = [
    !text.includes('$35.99') || !text.includes('$37.67') ? 'expected $35.99 share and $37.67 office minimum' : '',
    !text.includes('Save the product first') ? 'upload zone should wait for the first save' : '',
    !text.includes('Add product') ? 'primary action should read Add product' : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL new product live fee math: ${problems.join('; ')}`); }
  else console.log('ok new product live fee math');
  await act(async () => { renderer!.unmount(); });
}

{
  // Product-page editor round-trip: the line-based fields parse back into the
  // exact structures the API stores, and the cadence rules are enforced before save.
  const { parseFacts, factsToText, parseFaqs, faqsToText, parseLines } = await import('../src/pages/admin/payments/catalog/ProductEditor');
  const control = DEMO_CATALOG.products[0];
  const boost = DEMO_CATALOG.products[6];
  const roundTrips = [
    JSON.stringify(parseFacts(factsToText(control.facts))) === JSON.stringify(control.facts),
    JSON.stringify(parseFacts(factsToText(boost.facts))) === JSON.stringify(boost.facts),
    JSON.stringify(parseFaqs(faqsToText(boost.faqs))) === JSON.stringify(boost.faqs),
    JSON.stringify(parseLines(control.benefits.join('\n'))) === JSON.stringify(control.benefits),
    JSON.stringify(parseFacts('Creatine Monohydrate — 5 g — helps support lean muscle**')) === JSON.stringify([{ name: 'Creatine Monohydrate', detail: '5 g — helps support lean muscle**' }]),
  ];
  const location = memoryLocation({ path: '/admin/payments/catalog/products/catalog-1' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><ProductEditorPage params={{ productId: 'catalog-1' }} /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const byId = (id: string) => renderer!.root.find(node => node.props['data-testid'] === id && ['input', 'select', 'textarea', 'button'].includes(String(node.type)));
  const checked = () => CADENCE_WEEKS.filter(weeks => byId(`checkbox-cadence-${weeks}`).props.checked);
  const initial = checked().join(',');
  // Uncheck everything but 4 and 8, then pick 8 as the default.
  for (const weeks of [2, 6, 10, 12]) await act(async () => { byId(`checkbox-cadence-${weeks}`).props.onChange({ target: { checked: false } }); });
  await act(async () => { byId('select-default-cadence').props.onChange({ target: { value: '8' } }); });
  const trimmed = checked().join(',');
  const defaultAfter = byId('select-default-cadence').props.value;
  const disabledOptions = byId('select-default-cadence').findAll(node => node.type === 'option' && node.props.disabled).map(node => node.props.value);
  // Coach suggestion rules ride the same editor: the demo seed is pre-filled and each control is editable.
  const coachInitial = { signals: ['off_plan_meals', 'stall'].every(id => byId(`checkbox-coach-signal-${id}`).props.checked), avoidClear: !byId('checkbox-coach-avoid-bloodwork_kidney_flag').props.checked, phrasing: String(byId('input-coach-phrasing').props.value) };
  await act(async () => { byId('checkbox-coach-signal-low_protein').props.onChange({ target: { checked: true } }); });
  await act(async () => { byId('checkbox-coach-avoid-bloodwork_kidney_flag').props.onChange({ target: { checked: true } }); });
  await act(async () => { byId('checkbox-coach-bloodwork-covered').props.onChange({ target: { checked: true } }); });
  const coachAfter = { lowProtein: byId('checkbox-coach-signal-low_protein').props.checked === true, avoid: byId('checkbox-coach-avoid-bloodwork_kidney_flag').props.checked === true, covered: byId('checkbox-coach-bloodwork-covered').props.checked === true };
  // Conversation topics (what the patient says that makes the product fair to mention) are HQ-edited too: one per line, pre-filled from the seed.
  const topicsInitial = String(byId('input-coach-topics').props.value);
  await act(async () => { byId('input-coach-topics').props.onChange({ target: { value: 'Appetite\nlate night snacking' } }); });
  const topicsAfter = String(byId('input-coach-topics').props.value);
  // Dropping the default's cadence must be caught before any save.
  await act(async () => { byId('checkbox-cadence-8').props.onChange({ target: { checked: false } }); });
  const saveButton = renderer!.root.find(node => node.type === 'button' && String(node.children.join('')) === 'Save changes');
  await act(async () => { saveButton.props.onClick(); });
  const alertText = JSON.stringify(renderer!.root.findAll(node => node.props.role === 'alert').map(node => JSON.stringify(node.children)));
  const problems = [
    roundTrips.some(ok => !ok) ? `field round-trips failed: ${roundTrips.map(ok => (ok ? 'ok' : 'FAIL')).join(',')}` : '',
    initial !== '2,4,6,8,10,12' ? `expected every cadence offered initially, got ${initial}` : '',
    trimmed !== '4,8' ? `expected 4,8 offered after unchecking, got ${trimmed}` : '',
    Number(defaultAfter) !== 8 ? `default should be 8, got ${defaultAfter}` : '',
    disabledOptions.join(',') !== '2,6,10,12' ? `unoffered cadences should be disabled as defaults, got ${disabledOptions.join(',')}` : '',
    !alertText.includes('default cadence must be one of the offered cadences') ? `expected the default-cadence error, got ${alertText}` : '',
    !coachInitial.signals || !coachInitial.avoidClear || !coachInitial.phrasing.includes('hunger, cravings') ? `coach suggestion section should pre-fill the seeded Control rule, got ${JSON.stringify(coachInitial)}` : '',
    !coachAfter.lowProtein || !coachAfter.avoid || !coachAfter.covered ? `coach suggestion controls should toggle, got ${JSON.stringify(coachAfter)}` : '',
    topicsInitial.split('\n')[0] !== 'appetite' || !topicsInitial.includes('portion control') ? `coach topics should pre-fill the seeded Control topics one per line, got ${JSON.stringify(topicsInitial)}` : '',
    topicsAfter !== 'Appetite\nlate night snacking' ? `coach topics textarea should be editable, got ${JSON.stringify(topicsAfter)}` : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL product page editor: ${problems.join('; ')}`); }
  else console.log('ok product page editor');
  await act(async () => { renderer!.unmount(); });
}

{
  // Subscribe-and-save: the percent field follows the switch, and the saved body carries both.
  const location = memoryLocation({ path: '/admin/payments/catalog' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (data: HqCatalogResponse) => (
    <QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><SettingsCard data={data} canWrite demo={false} /></Router></DateRangeProvider></QueryClientProvider>
  );
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(tree({ ...DEMO_CATALOG, settings: { ...DEMO_CATALOG.settings, subscribe_save_enabled: false, subscribe_save_percent: 15 } })); });
  const toggle = () => renderer!.root.find(node => node.props['data-testid'] === 'checkbox-settings-subscribe-save' && node.type === 'input');
  const percent = () => renderer!.root.find(node => node.props['data-testid'] === 'input-settings-subscribe-save-percent' && node.type === 'input');
  const offState = { checked: toggle().props.checked, disabled: percent().props.disabled, value: percent().props.value };
  await act(async () => { toggle().props.onChange({ target: { checked: true } }); });
  const onState = { checked: toggle().props.checked, disabled: percent().props.disabled };
  await act(async () => { percent().props.onChange({ target: { value: '95' } }); });
  await act(async () => { renderer!.root.find(node => node.props['data-testid'] === 'button-settings-save').props.onClick(); });
  const tooHigh = JSON.stringify(renderer!.root.findAll(node => node.props.role === 'alert').map(node => JSON.stringify(node.children)));
  const text = JSON.stringify(renderer!.toJSON());
  const problems = [
    offState.checked !== false || offState.disabled !== true || offState.value !== '15' ? `off state wrong: ${JSON.stringify(offState)}` : '',
    onState.checked !== true || onState.disabled !== false ? `on state wrong: ${JSON.stringify(onState)}` : '',
    !tooHigh.includes('whole number from 0 to 90') ? `95% should be refused before saving, got ${tooHigh}` : '',
    !text.includes('quoted at the office price minus this discount') ? 'on-state help copy missing' : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL subscribe-and-save settings: ${problems.join('; ')}`); }
  else console.log('ok subscribe-and-save settings');
  await act(async () => { renderer!.unmount(); });
}

{
  // Catalog reorder: arrow keys on a row handle move it, and the demo never fetches.
  const location = memoryLocation({ path: '/admin/payments/catalog' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/admin/payments" nest><PaymentsCatalog /></Route></Router></DateRangeProvider></QueryClientProvider>);
  });
  const rowsBefore = renderer!.root.findAll(node => node.type === 'tr' && typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('row-catalog-')).map(node => node.props['data-testid']);
  const handle = renderer!.root.find(node => node.props['data-testid'] === 'handle-catalog-catalog-2' && node.type === 'button');
  await act(async () => { handle.props.onKeyDown({ key: 'ArrowUp', preventDefault() {} }); });
  const rowsAfter = renderer!.root.findAll(node => node.type === 'tr' && typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('row-catalog-')).map(node => node.props['data-testid']);
  const archive = renderer!.root.findAll(node => node.props['data-testid'] === 'button-archive-catalog-1' && node.type === 'button');
  const problems = [
    rowsBefore[1] !== 'row-catalog-catalog-2' ? `expected catalog-2 second, got ${rowsBefore[1]}` : '',
    rowsAfter[0] !== 'row-catalog-catalog-2' ? `ArrowUp should move catalog-2 first, got ${rowsAfter[0]}` : '',
    archive.length !== 1 ? 'expected an Archive button on the first row' : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL catalog reorder: ${problems.join('; ')}`); }
  else console.log('ok catalog reorder');
  await act(async () => { renderer!.unmount(); });
}

{
  // Program settings: a dirty form keeps the version it was filled from when the
  // server moves on (save must 409, never overwrite), an untouched form follows the server.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const v1 = DEMO_CATALOG;
  const v2 = { ...v1, settings: { ...v1.settings, version: v1.settings.version + 1, shipping_charge_cents: v1.settings.shipping_charge_cents + 100 } };
  const tree = (data: typeof v1) => <QueryClientProvider client={client}><SettingsCard data={data} canWrite demo={false} /></QueryClientProvider>;
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(tree(v1)); });
  const input = () => renderer!.root.find(node => node.props['data-testid'] === 'input-settings-shipping-charge' && node.type === 'input');
  const before = input().props.value;
  await act(async () => { input().props.onChange({ target: { value: '12.34' } }); });
  await act(async () => { renderer!.update(tree(v2)); });
  const dirtyValue = input().props.value;
  const notice = renderer!.root.findAll(node => node.props['data-testid'] === 'text-settings-behind');
  await act(async () => { renderer!.root.find(node => node.props['data-testid'] === 'button-settings-discard').props.onClick(); });
  const afterDiscard = input().props.value;
  const noticeAfter = renderer!.root.findAll(node => node.props['data-testid'] === 'text-settings-behind');
  await act(async () => { renderer!.unmount(); });
  // Untouched form: server change flows straight into the fields.
  await act(async () => { renderer = create(tree(v1)); });
  await act(async () => { renderer!.update(tree(v2)); });
  const untouched = input().props.value;
  const untouchedNotice = renderer!.root.findAll(node => node.props['data-testid'] === 'text-settings-behind');
  await act(async () => { renderer!.unmount(); });
  const expectedV2 = (v2.settings.shipping_charge_cents / 100).toFixed(2);
  const problems = [
    dirtyValue !== '12.34' ? `dirty field was overwritten by the server change (${dirtyValue})` : '',
    notice.length !== 1 ? `expected the behind notice while dirty, found ${notice.length}` : '',
    afterDiscard !== expectedV2 ? `discard should load ${expectedV2}, got ${afterDiscard}` : '',
    noticeAfter.length !== 0 ? 'behind notice should clear after discarding' : '',
    untouched !== expectedV2 ? `untouched form should follow the server (${untouched} vs ${expectedV2}, started ${before})` : '',
    untouchedNotice.length !== 0 ? 'untouched form should not show the behind notice' : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL settings baseline: ${problems.join('; ')}`); }
  else console.log('ok settings baseline');
}

{
  // A running net that dips below zero (refund of an older order before today's
  // first sale) must plot BELOW the baseline with a signed axis — never clamped to $0.
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<AreaChart title="Signed" dates={['0', '1', '2']} unit="money" running formatLabel={hourLabel} testId="chart-signed"
      series={[{ key: 'net', label: 'Net', color: '#000', values: [-4000, -4000, 6000] }]} />);
  });
  const svg = renderer!.root.find(node => node.type === 'svg');
  const labels = svg.findAll(node => node.type === 'text').map(node => String(node.children.join('')));
  const line = String(svg.findAll(node => node.type === 'path' && node.props.fill === 'none')[0]?.props.d ?? '');
  const ys = [...line.matchAll(/[ML][\d.]+,([\d.]+)/g)].map(m => Number(m[1]));
  const zeroLine = svg.findAll(node => node.type === 'line' && node.props.strokeDasharray === undefined && node.props.x1 !== node.props.x2)[0];
  const zeroY = Number(zeroLine?.props.y1);
  const problems = [
    !labels.some(label => label.startsWith('-$')) ? `axis lacks a negative tick: ${labels.join(' | ')}` : '',
    !(ys[0] > zeroY && ys[2] < zeroY) ? `negative point should sit below the zero line (ys ${ys.join(',')}, zero ${zeroY})` : '',
    !svg.props['aria-label'].includes('Net $60.00 so far') ? `running summary reads "${svg.props['aria-label']}"` : '',
  ].filter(Boolean);
  if (problems.length) { failures += 1; console.error(`FAIL signed chart domain: ${problems.join('; ')}`); }
  else console.log('ok signed chart domain');
  await act(async () => { renderer!.unmount(); });
}

if (fetches !== 0) { failures += 1; console.error(`FAIL demo issued ${fetches} fetch request(s)`); }
console.log(failures === 0 ? 'All HQ billing checks passed.' : `${failures} HQ billing check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
