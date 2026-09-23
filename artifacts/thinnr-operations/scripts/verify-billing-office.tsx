import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { DateRangeProvider } from '../src/contexts/date-range';
import OfficePaymentsArea, { PickPackSettingsCard } from '../src/pages/office/payments/OfficePaymentsArea';
import { DEMO_FULFILLMENT } from '../src/pages/office/payments/demo-data';
import { RefundDialog } from '../src/components/billing/RefundDialog';
import { OFFICE_NAV_ITEMS, OFFICE_PAYMENTS_SECTIONS, isOfficeMenuPathActive } from '../src/components/layout/nav-config';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.location ??= { assign() {} };
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.confirm ??= () => true;
g.navigator ??= {};
g.navigator.clipboard ??= { writeText: async () => {} };

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (pass) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let responses: Array<() => Response> = [];
const requests: Array<{ url: string; method: string; body: any; headers?: HeadersInit }> = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers });
  const next = responses.shift();
  if (!next) throw new Error(`unexpected fetch ${url}`);
  return next();
};
const queuedFetch = g.fetch;

const account = {
  provider_id: 'office-1', stripe_account_id: 'acct_1', origin: 'created', dashboard_type: 'none',
  charges_enabled: true, payouts_enabled: true, details_submitted: true,
  requirements: { currently_due: [], past_due: [], eventually_due: [], disabled_reason: null, current_deadline: null },
  capabilities: {}, default_currency: 'usd', business_name: 'Beacon Hill', email: 'office@example.com',
  tax_enabled: false, livemode: false, last_synced_at: '2026-10-11T00:00:00Z', disconnected_at: null, created_at: '2026-10-01T00:00:00Z',
};
const status = (overrides: Record<string, unknown> = {}) => ({
  account, offered_products: 1, links: 1, sandbox: true, oauth_available: true,
  viewer: { office_role: 'owner', can_manage: true }, office: { provider_id: 'office-1', office_name: 'Beacon Hill' }, ...overrides,
});
const price = {
  product_id: 'control', slug: 'control', name: 'Control', description: '', image_url: null, active: true, floor_price_cents: 5999,
  break_even_minimum_cents: 3767, sell_price_cents: 7999, subscription_enabled: true, offered: true, below_minimum: false,
  category: 'supplement', tagline: 'Metabolic & Appetite Support', offered_cadences_weeks: [2, 4, 8], default_cadence_weeks: 4,
  subscribe_save_percent: 10, subscription_price_cents: 7199,
};

function reset(kind: 'demo' | 'owner' | 'hq' = 'owner') {
  requests.length = 0; responses = []; __setScope(null);
  if (kind === 'demo') {
    __setSession({ authStatus: 'signed-out', authRole: null, authUser: null });
    __setSupabaseSession(null);
  } else if (kind === 'hq') {
    __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' } });
    __setScope({ providerId: 'office-1', officeName: 'Beacon Hill' });
    __setSupabaseSession('hq-token');
  } else {
    __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' } });
    __setSupabaseSession('staff-token');
  }
}
async function settle(rounds = 12) { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
// Mounted exactly as OfficeApp does: a `nest` route at /payments, so every
// in-area link/navigate must be relative to that base (a bare "/payments/..."
// would double the segment, which is what the first e2e pass caught).
async function render(path: string) {
  const location = memoryLocation({ path: `/payments${path === '/' ? '' : path}`, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><DateRangeProvider><Router hook={location.hook}><Route path="/payments" nest><OfficePaymentsArea /></Route></Router></DateRangeProvider></QueryClientProvider>); });
  await settle();
  return { renderer, root: renderer.root, location };
}
const all = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => all(root, id)[0];
const text = (node: ReactTestInstance) => {
  const parts: string[] = [];
  const walk = (item: ReactTestInstance | string) => typeof item === 'string' ? parts.push(item) : item.children.forEach((child) => walk(child as ReactTestInstance | string));
  walk(node); return parts.join('');
};

console.log('office billing: gates and setup');
{
  reset('demo');
  const demo = await render('/');
  check('demo renders seeded payments without fetch', requests.length === 0 && all(demo.root, 'billing-demo-notice').length === 1 && text(demo.root).includes('$6,428.50'));
  const tabs = demo.root.findAll((node) => node.type === 'a' && typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('tab-payments-'));
  check(
    'overview shows every payments section as a base-relative tab',
    tabs.length === OFFICE_PAYMENTS_SECTIONS.length && tabs.every((tab) => String(tab.props.href).startsWith('/payments/') || tab.props.href === '/payments') && tabs.find((tab) => tab.props['data-testid'] === 'tab-payments-overview')?.props['aria-current'] === 'page',
    tabs.map((tab) => `${tab.props['data-testid']}→${tab.props.href}`).join(','),
  );
  check(
    "demo overview carries today's revenue, the daily chart and recent activity",
    Boolean(one(demo.root, 'section-today-revenue')) && text(one(demo.root, 'today-office-net')).length > 1 && Boolean(one(demo.root, 'chart-daily-revenue')) && Boolean(one(demo.root, 'tile-office-net')) && text(demo.root).includes('Payout to office') && one(demo.root, 'link-view-activity')?.props.href === '/payments/activity',
    text(demo.root).slice(0, 300),
  );
  demo.renderer.unmount();

  const subscriptions = await render('/subscriptions');
  check(
    'demo subscription shows failed payment recovery read-only',
    requests.length === 0
      && text(subscriptions.root).includes('Payment failed')
      && text(subscriptions.root).includes('Card declined 2 times')
      && text(subscriptions.root).includes('Retry payment')
      && text(subscriptions.root).includes('Email patient a payment link')
      && subscriptions.root.findAll((node) => node.type === 'button' && node.props.disabled === true).length >= 2,
  );
  check(
    'demo subscriptions show paused and pending states with write controls disabled',
    text(subscriptions.root).includes('Paused')
      && text(subscriptions.root).includes('Changes to Fiber ($44.99) on Nov 7, 2026')
      && subscriptions.root.findAll((node) => node.type === 'button' && text(node).includes('Change product') && node.props.disabled === true).length === 2,
  );
  subscriptions.renderer.unmount();

  const demoLinks = await render('/links');
  check(
    'demo links render expiry, use totals, product and disabled write controls',
    text(demoLinks.root).includes('1 of 1 used')
      && text(demoLinks.root).includes('Control')
      && text(demoLinks.root).includes('Expired')
      && Boolean(one(demoLinks.root, 'select-link-expiry')?.props.disabled)
      && demoLinks.root.findAll((node) => node.type === 'button' && text(node) === 'Edit' && node.props.disabled === true).length > 0,
  );
  check('demo Sell to patient action is present and disabled', one(demoLinks.root, 'button-sell-to-patient')?.props.disabled === true);
  demoLinks.renderer.unmount();

  const demoDetail = await render('/transactions/demo-order-1');
  const backLink = demoDetail.root.findAll(
    (node) => node.type === 'a' && node.props.href === '/payments/transactions' && text(node).includes('Back to transactions'),
  );
  check(
    'demo transaction renders its order detail and relative Back link',
    requests.length === 0 && text(demoDetail.root).includes('TH-D3MO01') && backLink.length === 1
      && ['Shipping method', 'Standard', 'Flat rate', 'Carrier cost', 'Pick-and-pack fee', 'Packaging', 'Emails', 'Order confirmation'].every((value) => text(demoDetail.root).includes(value))
      && all(demoDetail.root, 'emails-list').length === 1 && all(demoDetail.root, 'button-send-to-other').every((node) => node.props.disabled === true),
    `requests=${requests.length}; back=${backLink.length}; text=${text(demoDetail.root).slice(0, 180)}`,
  );
  demoDetail.renderer.unmount();

  reset();
  responses = [json(200, status({ viewer: { office_role: 'staff', can_manage: false } }))];
  const staff = await render('/');
  check('staff role receives the permission card', all(staff.root, 'status-billing-unauthorized').length === 1 && text(staff.root).includes('Only office owners and admins'));
  staff.renderer.unmount();

  reset();
  responses = [json(200, status({ account: null }))];
  const redirected = await render('/');
  check('no account redirects dashboard to get-paid', redirected.location.history.at(-1) === '/payments/get-paid', JSON.stringify(redirected.location.history));
  redirected.renderer.unmount();

  reset();
  responses = [json(200, status({ account: null }))];
  const setup = await render('/get-paid');
  check('setup shows both new and existing account choices', Boolean(one(setup.root, 'button-oauth-start')) && Boolean(one(setup.root, 'button-create-account')));
  setup.renderer.unmount();

  reset();
  responses = [json(200, status({ account: null, oauth_available: false }))];
  const noOauth = await render('/get-paid');
  check('OAuth choice is replaced by a configuration note', !one(noOauth.root, 'button-oauth-start') && Boolean(one(noOauth.root, 'oauth-unavailable')));
  noOauth.renderer.unmount();
}

console.log('\noffice billing: pick-and-pack setting');
{
  reset();
  const shippingSettings = {
    pick_pack_pass_through: null,
    effective_pick_pack_pass_through: true,
    hq_default_pick_pack_pass_through: true,
    version: 7,
    updated_at: '2026-10-11T00:00:00Z',
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let reloaded = 0;
  let owner!: ReactTestRenderer;
  await act(async () => {
    owner = create(
      <QueryClientProvider client={client}>
        <PickPackSettingsCard settings={shippingSettings} canWrite onReload={async () => { reloaded += 1; }} />
      </QueryClientProvider>,
    );
  });
  const radios = owner.root.findAll((node) => node.type === 'input' && node.props.type === 'radio');
  check('control has inherit, on and off radio states with HQ default explained',
    radios.length === 3 && radios[0].props.checked === true && text(owner.root).includes('HQ default is On'));
  await act(async () => radios[2].props.onChange());
  responses = [json(409, { error: 'settings_conflict' })];
  await act(async () => one(owner.root, 'button-save-pick-pack-setting').props.onClick());
  await settle();
  const put = requests.find((request) => request.url === '/api/billing/office/settings' && request.method === 'PUT');
  check('off choice PUTs null-inherit contract and version', JSON.stringify(put?.body) === JSON.stringify({ pick_pack_pass_through: false, expected_version: 7 }), JSON.stringify(put));
  check('409 reloads the setting before asking the owner to retry', reloaded === 1, String(reloaded));
  await act(async () => owner.unmount());

  let staff!: ReactTestRenderer;
  await act(async () => {
    staff = create(
      <QueryClientProvider client={client}>
        <PickPackSettingsCard settings={shippingSettings} canWrite={false} />
      </QueryClientProvider>,
    );
  });
  check('staff sees the effective setting read-only', staff.root.findAll((node) => node.type === 'input' && node.props.disabled === true).length === 3
    && all(staff.root, 'button-save-pick-pack-setting').length === 0
    && text(staff.root).includes('Only office owners and admins'));
  await act(async () => staff.unmount());
}

console.log('\noffice billing: prices');
{
  reset();
  responses = [json(200, status()), json(200, { products: [price], settings: { shipping_charge_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30 } })];
  const page = await render('/prices');
  const input = one(page.root, 'input-price-control');
  await act(async () => input.props.onChange({ target: { value: '30.00' } }));
  await act(async () => one(page.root, 'button-save-price-control').props.onClick());
  check('below-minimum price is rejected locally with minimum shown', requests.length === 2 && text(page.root).includes('$37.67'), JSON.stringify(requests));
  const plan = text(one(page.root, 'text-price-plan-control'));
  check('cadences and subscribe-and-save are shown read-only', plan.includes('every 2, 4 or 8 weeks · default 4') && plan.includes('subscribe and save 10% ($71.99 per renewal)'), plan);
  await act(async () => input.props.onChange({ target: { value: '82.50' } }));
  responses = [json(200, { product: { ...price, sell_price_cents: 8250 } }), json(200, status())];
  await act(async () => one(page.root, 'button-save-price-control').props.onClick());
  await settle();
  const put = requests.find((request) => request.method === 'PUT');
  check('valid price PUTs cents and subscription setting', put?.url === '/api/billing/office/prices/control' && JSON.stringify(put.body) === JSON.stringify({ sell_price_cents: 8250, subscription_enabled: true }), JSON.stringify(put));
  page.renderer.unmount();
}

console.log('\noffice billing: subscription controls');
{
  reset();
  const subscription = {
    id: 'sub-1', provider_id: 'office-1', office_name: 'Beacon Hill',
    payer: { id: 'payer-1', patient_id: 'patient-1', name: 'Maya Thompson', email: 'maya@example.com', phone: null },
    product_id: 'control', product_name: 'Control', status: 'active', unit_price_cents: 7999,
    shipping_charge_cents: 1000, application_fee_cents: 4599, current_period_end: '2026-11-07T00:00:00Z',
    cancel_at_period_end: false, canceled_at: null, payment_failure_count: 0, last_payment_failed_at: null,
    last_failure_message: null, renewals: 3, livemode: false, created_at: '2026-08-15T00:00:00Z',
    paused_at: null, pending_change: null,
  };
  const fiber = { ...price, product_id: 'fiber', slug: 'fiber', name: 'Fiber', sell_price_cents: 4499 };
  responses = [
    json(200, status()),
    json(200, { items: [subscription], next_cursor: null }),
    json(200, { products: [price, fiber], settings: { shipping_charge_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30 } }),
  ];
  const page = await render('/subscriptions');
  await act(async () => one(page.root, 'button-change-product-sub-1').props.onClick());
  responses = [json(200, {
    current: { product_id: 'control', product_name: 'Control', unit_price_cents: 7999 },
    next: { product_id: 'fiber', product_name: 'Fiber', unit_price_cents: 4499, shipping_charge_cents: 1000, application_fee_cents: 2499 },
    effective_at: '2026-11-07T00:00:00Z',
  })];
  await act(async () => one(page.root, 'select-change-product').props.onChange({ target: { value: 'fiber' } }));
  await settle();
  check(
    'change-product dialog fetches and renders the renewal quote',
    requests.some((request) => request.url === '/api/billing/office/subscriptions/sub-1/change-quote?product_id=fiber')
      && text(one(page.root, 'subscription-change-quote')).includes('Next: Fiber · $44.99')
      && text(page.root).includes('Takes effect at next renewal on Nov 7, 2026'),
  );
  responses = [json(200, { subscription: { ...subscription, pending_change: { product_id: 'fiber', product_name: 'Fiber', unit_price_cents: 4499, effective_at: '2026-11-07T00:00:00Z' } } })];
  const confirm = page.root.findAll((node) => node.type === 'button' && text(node) === 'Confirm change')[0];
  await act(async () => confirm.props.onClick());
  await settle();
  const changePost = requests.find((request) => request.method === 'POST' && request.url === '/api/billing/office/subscriptions/sub-1/change');
  check('confirming product change POSTs the frozen product_id body', JSON.stringify(changePost?.body) === JSON.stringify({ product_id: 'fiber' }), JSON.stringify(changePost));
  page.renderer.unmount();
}

console.log('\noffice billing: patient links and HQ scope');
{
  reset();
  responses = [
    json(200, status()),
    json(200, { items: [] }),
    json(200, { products: [price], settings: { shipping_charge_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30 } }),
  ];
  const links = await render('/links');
  check('link create form offers expiry, single/custom use limits, and product preselection', Boolean(one(links.root, 'select-link-expiry')) && Boolean(one(links.root, 'toggle-link-single-use')) && Boolean(one(links.root, 'input-link-max-uses')) && Boolean(one(links.root, 'select-link-product')));
  await act(async () => one(links.root, 'input-patient-search').props.onChange({ target: { value: 'Maya' } }));
  responses = [json(200, { items: [{ id: 'patient-1', name: 'Maya Thompson', email: 'maya@example.com', phone: null }] })];
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  await settle();
  await act(async () => one(links.root, 'patient-result-patient-1').props.onClick());
  responses = [
    json(200, { link: { id: 'link-1', token: 'token', url: 'https://example.com/pay/token', provider_id: 'office-1', patient_id: 'patient-1', patient_name: 'Maya Thompson', label: null, active: true, uses: 0, last_used_at: null, created_at: '2026-10-11T00:00:00Z', product_id: null, product_name: null, expires_at: null, max_uses: null, usable: true } }),
    json(200, status()), json(200, { items: [] }),
  ];
  await act(async () => one(links.root, 'button-create-patient-link').props.onClick());
  await settle();
  const post = requests.find((request) => request.method === 'POST');
  check('patient link POSTs chosen patient id and explicit default options', JSON.stringify(post?.body) === JSON.stringify({ patient_id: 'patient-1', expires_in_hours: null, max_uses: null, product_id: null }), JSON.stringify(post));
  links.renderer.unmount();

  reset('hq');
  responses = [json(200, status())];
  const hq = await render('/get-paid');
  check('HQ drill-in appends office to live calls', requests[0]?.url === '/api/billing/office/status?office=office-1', JSON.stringify(requests));
  hq.renderer.unmount();
}

console.log('\noffice billing: sell to patient');
{
  const saleProduct = {
    product_id: 'control', name: 'Control', description: 'Daily support', image_url: null,
    unit_price_cents: 7999, office_priced: true, subscription_available: true,
    subscription_cadences_weeks: [2, 4, 8], default_cadence_weeks: 4,
    subscribe_save_percent: 10, subscription_unit_price_cents: 7199,
    page: { eyebrow: '', headline: '', dek: '', highlights: [], how_it_works: [], ingredients: [], directions: '', warnings: '' },
  };
  const saleContext = {
    patient: { id: 'patient-1', name: 'Maya Thompson', email: 'maya@example.com', phone: '6175550100' },
    default_address: { name: 'Maya Thompson', line1: '10 Main St', line2: null, city: 'Boston', state: 'MA', postal_code: '02110', country: 'US', phone: '6175550100' },
    products: [saleProduct], shipping_charge_cents: 1000, subscribe_save_percent: 10,
    stripe_account_id: 'acct_1', publishable_key: 'pk_test_1', sandbox: true, available: true, unavailable_reason: null,
  };
  const subscribedLines = [{ product_id: 'control', quantity: 3, purchase: 'subscription', cadence_weeks: 8 }];
  const quote = {
    lines: [{ product_id: 'control', name: 'Control', purchase: 'subscription', quantity: 3, cadence_weeks: 8, unit_price_cents: 7199, list_price_cents: 7999, discount_cents: 2400, line_total_cents: 21597 }],
    groups: [{ kind: 'subscription', product_id: 'control', cadence_weeks: 8, quantity: 3, subtotal_cents: 21597, shipping_charge_cents: 1000, total_cents: 22597 }],
    subtotal_cents: 23997, discount_cents: 2400, shipping_charge_cents: 1000, total_cents: 22597,
  };
  const installSaleFetch = (mode: 'card' | 'partial' | 'qr') => {
    g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body, headers: init?.headers });
      if (url === '/api/billing/office/status') return json(200, status())();
      if (url === '/api/billing/office/links') return json(200, { items: [] })();
      if (url === '/api/billing/office/prices') return json(200, { products: [price], settings: {} })();
      if (url.startsWith('/api/billing/office/patients/search')) return json(200, { items: [{ id: 'patient-1', name: 'Maya Thompson', email: 'maya@example.com', phone: '6175550100' }] })();
      if (url.startsWith('/api/billing/office/sales/context')) return json(200, saleContext)();
      if (url === '/api/billing/office/sales/quote') return json(200, quote)();
      if (url === '/api/billing/office/sales' && (mode === 'card' || mode === 'partial')) return json(200, {
        cart_id: body.cart_id, status: mode === 'partial' ? 'partial' : 'paid',
        items: mode === 'partial'
          ? [
              { kind: 'one_time', order_id: 'order-paid', order_number: 'TH-PAID01', subscription_id: null, status: 'paid', client_secret: null, error: null, total_cents: 7999 },
              { kind: 'subscription', order_id: 'order-failed', order_number: 'TH-FAIL01', subscription_id: 'sub-failed', status: 'failed', client_secret: null, error: 'Card declined for this renewal.', total_cents: 14598 },
            ]
          : [{ kind: 'subscription', order_id: 'order-1', order_number: 'TH-SALE01', subscription_id: 'sub-1', status: 'paid', client_secret: null, error: null, total_cents: 22597 }],
        stripe_account_id: 'acct_1', publishable_key: 'pk_test_1', sandbox: true,
      })();
      if (url === '/api/billing/office/carts' && method === 'POST' && mode === 'qr') return json(200, {
        id: 'cart-1', token: 'cart-token', url: 'https://payments.example/pay/cart/cart-token', status: 'open', partial: false,
        patient: { id: 'patient-1', name: 'Maya Thompson' }, lines: body.lines, quote, label: null,
        expires_at: '2099-01-01T00:00:00Z', created_at: '2026-10-11T00:00:00Z', paid_at: null, orders: [],
      })();
      if (url === '/api/billing/office/carts/cart-1' && mode === 'qr') return json(200, {
        id: 'cart-1', token: 'cart-token', url: 'https://payments.example/pay/cart/cart-token', status: 'paid', partial: false,
        patient: { id: 'patient-1', name: 'Maya Thompson' }, lines: body?.lines ?? subscribedLines, quote, label: null,
        expires_at: '2099-01-01T00:00:00Z', created_at: '2026-10-11T00:00:00Z', paid_at: '2026-10-11T00:05:00Z',
        orders: [{ order_id: 'order-qr', order_number: 'TH-QR001', kind: 'subscription', status: 'paid' }],
      })();
      throw new Error(`unexpected fetch ${method} ${url}`);
    };
  };
  const openSale = async (page: Awaited<ReturnType<typeof render>>) => {
    await act(async () => one(page.root, 'input-patient-search').props.onChange({ target: { value: 'Maya' } }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await settle();
    await act(async () => one(page.root, 'patient-result-patient-1').props.onClick());
    await act(async () => one(page.root, 'button-sell-to-patient').props.onClick());
    await settle();
  };

  reset(); installSaleFetch('card');
  const card = await render('/links');
  await openSale(card);
  await act(async () => card.root.find((node) => node.props['aria-label'] === 'Select Control').props.onChange({ target: { checked: true } }));
  const purchaseSelect = card.root.findAllByType('select').find((node) => node.props.value === 'one_time')!;
  await act(async () => purchaseSelect.props.onChange({ target: { value: 'subscription' } }));
  await act(async () => card.root.find((node) => node.props['aria-label'] === 'Control cadence').props.onChange({ target: { value: '8' } }));
  await act(async () => card.root.find((node) => node.props['aria-label'] === 'Control quantity').props.onChange({ target: { value: '3' } }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); }); await settle();
  const quotePost = requests.findLast((request) => request.url === '/api/billing/office/sales/quote');
  check('sale quote sends exact patient, purchase, cadence and quantity', JSON.stringify(quotePost?.body) === JSON.stringify({ patient_id: 'patient-1', lines: subscribedLines }), JSON.stringify(quotePost?.body));
  await act(async () => card.root.find((node) => node.type === 'button' && text(node) === 'Continue').props.onClick());
  await act(async () => card.root.find((node) => node.type === 'button' && text(node) === 'Charge card here').props.onClick());
  await settle();
  const stripeForm = one(card.root, 'stripe-payment-method-form');
  await act(async () => stripeForm.props.onSubmit({ preventDefault() {} })); await settle();
  const salePost = requests.find((request) => request.url === '/api/billing/office/sales');
  const saleHeaders = new Headers(salePost?.headers);
  check('card sale sends exact body and stable Idempotency-Key', salePost?.body.patient_id === 'patient-1'
    && JSON.stringify(salePost?.body.lines) === JSON.stringify(subscribedLines)
    && salePost?.body.payment_method_id === 'pm_test_staff_sale'
    && salePost?.body.cart_id === saleHeaders.get('Idempotency-Key')
    && Boolean(saleHeaders.get('Idempotency-Key')),
  JSON.stringify(salePost));
  check('card sale renders completion order number', text(one(card.root, 'sale-completion')).includes('TH-SALE01'));
  card.renderer.unmount();

  reset(); installSaleFetch('partial');
  const partial = await render('/links');
  await openSale(partial);
  await act(async () => partial.root.find((node) => node.props['aria-label'] === 'Select Control').props.onChange({ target: { checked: true } }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); }); await settle();
  await act(async () => partial.root.find((node) => node.type === 'button' && text(node) === 'Continue').props.onClick());
  await act(async () => partial.root.find((node) => node.type === 'button' && text(node) === 'Charge card here').props.onClick());
  await settle();
  await act(async () => one(partial.root, 'stripe-payment-method-form').props.onSubmit({ preventDefault() {} })); await settle();
  const partialPanel = one(partial.root, 'sale-completion');
  const partialPost = requests.findLast((request) => request.url === '/api/billing/office/sales');
  check('partial sale names each paid and failed outcome without claiming completion',
    text(partialPanel).includes('Partly complete')
      && text(partialPanel).includes('TH-PAID01Paid')
      && text(partialPanel).includes('TH-FAIL01Failed')
      && text(partialPanel).includes('Card declined for this renewal.')
      && !text(partialPanel).includes('Sale complete'));
  await act(async () => partialPanel.find((node) => node.type === 'button' && text(node) === 'Check again').props.onClick()); await settle();
  const partialRetry = requests.findLast((request) => request.url === '/api/billing/office/sales');
  check('partial Check again reuses the same body and Idempotency-Key',
    JSON.stringify(partialRetry?.body) === JSON.stringify(partialPost?.body)
      && new Headers(partialRetry?.headers).get('Idempotency-Key') === new Headers(partialPost?.headers).get('Idempotency-Key'));
  partial.renderer.unmount();

  reset(); installSaleFetch('qr');
  const qrPage = await render('/links'); await openSale(qrPage);
  await act(async () => qrPage.root.find((node) => node.props['aria-label'] === 'Select Control').props.onChange({ target: { checked: true } }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); }); await settle();
  await act(async () => qrPage.root.find((node) => node.type === 'button' && text(node) === 'Continue').props.onClick());
  await act(async () => qrPage.root.find((node) => node.type === 'button' && text(node) === 'Show QR code').props.onClick()); await settle();
  const qrPanel = one(qrPage.root, 'sale-qr');
  check('QR path renders a data image and root-relative cart URL', qrPanel.findByType('img').props.src.startsWith('data:image/png;base64,') && text(qrPanel).includes('/pay/cart/cart-token'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3100)); }); await settle();
  check('QR poll flips the dialog to Paid and shows its order', text(one(qrPage.root, 'sale-qr')).includes('Paid') && text(one(qrPage.root, 'sale-qr')).includes('TH-QR001'));
  qrPage.renderer.unmount();
  g.fetch = queuedFetch;
}

console.log('\noffice billing: activity, refunds and fulfillment status');
{
  reset('demo');
  const activity = await render('/activity');
  check('demo activity lists seeded ledger lines without fetch', requests.length === 0 && text(activity.root).includes('TH-D3MO02') && text(activity.root).includes('Dispute opened'));
  await act(async () => one(activity.root, 'select-activity-kind').props.onChange({ target: { value: 'payout' } }));
  await settle();
  check('activity type filter rides the query string base-relatively', activity.location.history.at(-1) === '/payments/activity?kind=payout' && text(activity.root).includes('Payout to office') && !text(activity.root).includes('Dispute opened'), JSON.stringify(activity.location.history));
  activity.renderer.unmount();

  const refunds = await render('/refunds');
  const refundRows = all(refunds.root, 'row-refund-demo-refund-1').concat(all(refunds.root, 'row-refund-demo-dispute-1'));
  check('demo refunds show the refund and the open dispute with a notice', requests.length === 0 && refundRows.length === 2 && Boolean(one(refunds.root, 'notice-open-disputes')) && text(refunds.root).includes('Response due'));
  check('disputes notice makes the office responsible and demo embeds no Stripe element', text(refunds.root).includes('Respond to disputes below before the due date') && Boolean(one(refunds.root, 'demo-disputes-placeholder')) && !one(refunds.root, 'stripe-disputes-list'));
  const openLink = refunds.root.findAll((node) => node.type === 'a' && node.props['aria-label'] === 'Open order TH-D3MO03 (dispute)')[0];
  check('refund rows link to the transaction where the refund action lives', openLink?.props.href === '/payments/transactions/demo-order-3', String(openLink?.props.href));
  await act(async () => one(refunds.root, 'filter-refunds-refund').props.onClick());
  await settle();
  check('refund kind filter narrows the list', all(refunds.root, 'row-refund-demo-dispute-1').length === 0 && all(refunds.root, 'row-refund-demo-refund-1').length === 1 && refunds.location.history.at(-1) === '/payments/refunds?kind=refund');
  refunds.renderer.unmount();

  const fulfillment = await render('/fulfillment');
  check('demo fulfillment starts on the to-ship queue', requests.length === 0 && text(fulfillment.root).includes('TH-D3MO01') && !text(fulfillment.root).includes('TH-D3MO02'));
  await act(async () => one(fulfillment.root, 'filter-fulfillment-shipped').props.onClick());
  await settle();
  check('shipped queue shows carrier and tracking, read-only', text(fulfillment.root).includes('TH-D3MO02') && text(fulfillment.root).includes('USPS') && fulfillment.root.findAll((node) => node.type === 'button' && text(node).includes('Mark shipped')).length === 0);
  check('demo fulfillment predates warehouse submission and shows no warehouse state', all(fulfillment.root, 'text-warehouse-demo-order-1').length === 0 && !text(fulfillment.root).includes('warehouse'));
  fulfillment.renderer.unmount();

  // Live queue: WarehouseCraft state is read-only for offices (no retry), but says where each order is.
  reset();
  const liveOrder = (id: string, warehouse: Record<string, unknown> | null) => ({
    ...DEMO_FULFILLMENT[0], id, order_number: `TH-${id.toUpperCase()}`, fulfillment_status: 'to_ship', warehouse,
  });
  const sent = { state: 'sent', warehouse_order_id: '1436188', warehouse_status: 'Imported', sent_at: '2026-10-11T14:04:00Z', error: null, attempts: 1, next_attempt_at: null, last_attempt_at: '2026-10-11T14:04:00Z' };
  const rejected = { ...sent, state: 'needs_attention', warehouse_order_id: null, warehouse_status: null, sent_at: null, error: 'ItemSKU not recognized: CONTROL-OLD' };
  const queued = { ...sent, state: 'pending', warehouse_order_id: null, warehouse_status: null, sent_at: null, attempts: 0, last_attempt_at: null, next_attempt_at: '2026-10-11T14:06:00Z' };
  responses = [json(200, status()), json(200, { items: [liveOrder('a1', sent), liveOrder('a2', rejected), liveOrder('a3', queued), liveOrder('a4', null)], next_cursor: null })];
  const liveQueue = await render('/fulfillment');
  await settle();
  const queueText = text(liveQueue.root);
  const warehouseText = (id: string) => text(one(liveQueue.root, `text-warehouse-${id}`) ?? liveQueue.root);
  check('live queue shows the warehouse id and timestamp for a sent order', warehouseText('a1').includes('Sent to warehouse') && warehouseText('a1').includes('Warehouse order 1436188') && queueText.includes('Sent to the warehouse Oct 11, 2026'), warehouseText('a1'));
  check('live queue shows a rejected order as needs attention with HQ handling it', warehouseText('a2').includes('Needs attention') && queueText.includes('THINNR HQ is fixing it'), warehouseText('a2'));
  check('live queue shows a queued order as sending, and pre-warehouse orders stay plain', warehouseText('a3').includes('Sending to warehouse') && all(liveQueue.root, 'text-warehouse-a4').length === 0 && queueText.includes('Waiting for THINNR to pack and ship.'), warehouseText('a3'));
  check('offices never see the warehouse error text or a retry action', !queueText.includes('CONTROL-OLD') && liveQueue.root.findAll((node) => node.type === 'button' && /retry/i.test(text(node))).length === 0);
  liveQueue.renderer.unmount();

  // Status feed states: the warehouse's raw status and a back-order badge on the to-ship queue; the delivered date on the shipped queue.
  reset();
  const feedShipment = (status: 'processing' | 'shipped' | 'delivered', extra: Record<string, unknown> = {}) => ({
    status, source: 'provider', delivered_at: status === 'delivered' ? '2026-10-14T19:20:00Z' : null, back_ordered: false, warehouse_status: 'Imported', warehouse_status_at: '2026-10-11T15:00:00Z', ...extra,
  });
  responses = [json(200, status()), json(200, { items: [
    { ...liveOrder('b1', sent), shipment: feedShipment('processing', { warehouse_status: 'Being Fulfilled' }) },
    { ...liveOrder('b2', sent), shipment: feedShipment('processing', { back_ordered: true, warehouse_status: 'Back Order' }) },
  ], next_cursor: null })];
  const feedQueue = await render('/fulfillment');
  await settle();
  check('the to-ship queue shows the raw warehouse status and when it was seen', text(one(feedQueue.root, 'text-warehouse-feed-b1')).includes('Warehouse status: Being Fulfilled') && text(one(feedQueue.root, 'text-warehouse-feed-b1')).includes('seen Oct 11, 2026'), text(one(feedQueue.root, 'text-warehouse-feed-b1') ?? feedQueue.root));
  check('a back-ordered order carries a badge and only that order does', Boolean(one(feedQueue.root, 'pill-back-ordered-b2')) && text(one(feedQueue.root, 'pill-back-ordered-b2')) === 'Back-ordered' && !one(feedQueue.root, 'pill-back-ordered-b1'));
  feedQueue.renderer.unmount();

  reset();
  const shippedOrder = (id: string, shipment: Record<string, unknown> | null) => ({
    ...liveOrder(id, { ...sent, warehouse_status: 'Shipped' }), fulfillment_status: 'shipped', tracking_number: '9400111899223857000', carrier: 'USPS', shipped_at: '2026-10-12T17:00:00Z', shipment,
  });
  responses = [json(200, status()), json(200, { items: [shippedOrder('c1', feedShipment('delivered', { warehouse_status: 'Closed' })), shippedOrder('c2', feedShipment('shipped', { warehouse_status: 'Shipped' }))], next_cursor: null })];
  const deliveredQueue = await render('/fulfillment?status=shipped');
  await settle();
  const deliveredText = text(deliveredQueue.root);
  check('a delivered order shows Delivered with the date and still lists when it shipped', text(one(deliveredQueue.root, 'text-delivered-c1')) === 'Delivered Oct 14, 2026' && deliveredText.includes('Shipped Oct 12, 2026'), text(one(deliveredQueue.root, 'text-delivered-c1') ?? deliveredQueue.root));
  check('a shipped-but-not-delivered order shows no delivered line', !one(deliveredQueue.root, 'text-delivered-c2') && deliveredText.includes('9400111899223857000'));
  deliveredQueue.renderer.unmount();

  reset();
  const today = { date: '2026-10-11', time_zone: 'America/New_York', current_hour: 10, hours: Array.from({ length: 24 }, (_, hour) => ({ hour, collected_cents: hour === 9 ? 8999 : 0, refunded_cents: 0, net_cents: hour === 9 ? 8999 : 0, fee_cents: hour === 9 ? 4599 : 0, profit_cents: hour === 9 ? 4109 : 0, orders: hour === 9 ? 1 : 0 })), collected_cents: 8999, net_cents: 8999, fee_cents: 4599, profit_cents: 4109, refunded_cents: 0, orders: 1 };
  const dashboard = { balance: { available_cents: 100, pending_cents: 0 }, next_payout: null, collected_cents: 8999, refunded_cents: 0, net_cents: 4109, thinnr_fee_cents: 4599, stripe_fee_cents: 291, orders: 1, active_subscriptions: 0, needs_attention_subscriptions: 0, to_ship: 1, series: [] };
  // Status, then dashboard / today / activity in whatever order the hooks fire: every response is keyed by URL below.
  const byUrl: Record<string, () => Response> = {
    '/api/billing/office/status': json(200, status()),
    '/api/billing/office/overview/today': json(200, today),
    '/api/billing/office/dashboard': json(200, dashboard),
    '/api/billing/office/activity': json(200, { items: [], next_cursor: null }),
  };
  const previousFetch = g.fetch;
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: null });
    const handler = byUrl[url.split('?')[0]];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler();
  };
  const live = await render('/');
  const todayCall = requests.find((request) => request.url.startsWith('/api/billing/office/overview/today'));
  const dashboardCall = requests.find((request) => request.url.startsWith('/api/billing/office/dashboard'));
  check("live overview asks for today's revenue with the viewer time zone and the shared date range", Boolean(todayCall?.url.includes('tz=')) && Boolean(dashboardCall?.url.includes('from=')) && Boolean(dashboardCall?.url.includes('to=')), JSON.stringify(requests.map((r) => r.url)));
  check('live today section labels the profit line as office net', text(one(live.root, 'today-office-net')) === '$41.09' && text(live.root).includes('Office net'), text(one(live.root, 'today-office-net') ?? live.root).slice(0, 80));
  live.renderer.unmount();
  g.fetch = previousFetch;
}

console.log('\noffice billing: cancel safeguard');
{
  reset();
  const subscription = {
    id: 'sub-9', provider_id: 'office-1', office_name: 'Beacon Hill',
    payer: { id: 'payer-1', patient_id: 'patient-1', name: 'Maya Thompson', email: 'maya@example.com', phone: null },
    product_id: 'control', product_name: 'Control', status: 'active', unit_price_cents: 7999,
    shipping_charge_cents: 1000, application_fee_cents: 4599, current_period_end: '2026-11-07T00:00:00Z',
    cancel_at_period_end: false, canceled_at: null, payment_failure_count: 0, last_payment_failed_at: null,
    last_failure_message: null, renewals: 3, livemode: false, created_at: '2026-08-15T00:00:00Z',
    paused_at: null, pending_change: null,
  };
  responses = [
    json(200, status()),
    json(200, { items: [subscription], next_cursor: null }),
    json(200, { products: [price], settings: { shipping_charge_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30 } }),
  ];
  const page = await render('/subscriptions');
  check('subscription row shows started date, renewal count and a single actions menu', text(one(page.root, 'subscription-row-sub-9')).includes('Aug 15, 2026') && Boolean(one(page.root, 'button-subscription-actions-sub-9')) && page.root.findAll((node) => node.type === 'button' && text(node) === 'Cancel').length === 0);
  await act(async () => one(page.root, 'button-cancel-subscription-sub-9').props.onClick());
  const confirm = () => one(page.root, 'button-cancel-subscription-confirm');
  check('cancel dialog opens disarmed with period-end selected', confirm()?.props.disabled === true && one(page.root, 'radio-cancel-period-end').props.checked === true && text(page.root).includes('Type CANCEL'));
  await act(async () => one(page.root, 'input-cancel-confirm').props.onChange({ target: { value: 'cancel me' } }));
  check('wrong word keeps the button disarmed', confirm().props.disabled === true);
  await act(async () => one(page.root, 'radio-cancel-now').props.onChange());
  await act(async () => one(page.root, 'input-cancel-confirm').props.onChange({ target: { value: 'cancel' } }));
  check('typing CANCEL (any case) arms the button with the chosen timing', confirm().props.disabled === false && text(confirm()) === 'Cancel now');
  responses = [json(200, { subscription: { ...subscription, status: 'canceled', canceled_at: '2026-10-11T00:00:00Z' } }), json(200, status()), json(200, { items: [] }), json(200, { products: [price], settings: {} })];
  await act(async () => confirm().props.onClick());
  await settle();
  const post = requests.find((request) => request.method === 'POST' && request.url.includes('/subscriptions/sub-9/cancel'));
  check('armed confirm POSTs the immediate cancel and closes the dialog', JSON.stringify(post?.body) === JSON.stringify({ at_period_end: false }) && !one(page.root, 'button-cancel-subscription-confirm'), JSON.stringify(post));
  page.renderer.unmount();
}

console.log('\noffice billing: refund dialog');
{
  const order = {
    id: 'order-1', order_number: 'TH-0001', provider_id: 'office-1', office_name: 'Beacon Hill',
    payer: { id: 'payer-1', patient_id: 'patient-1', name: 'Maya Thompson', email: 'maya@example.com', phone: null },
    kind: 'one_time', status: 'paid', fulfillment_status: 'shipped', total_cents: 8999, application_fee_cents: 4599,
    item_count: 1, items_label: 'Control', livemode: false, created_at: '2026-10-01T00:00:00Z', paid_at: '2026-10-01T00:00:00Z',
    items: [{ id: 'item-1', product_id: 'control', product_name: 'Control', quantity: 1, unit_price_cents: 7999, floor_price_cents: 5999, thinnr_share_cents: 3000, hard_cost_cents: 1000 }],
    shipping_address: null, subscription_id: null, tracking_number: null, carrier: null, shipped_at: null, shipped_by_name: null, canceled_reason: null,
    fees: { subtotal_cents: 7999, shipping_charge_cents: 1000, tax_cents: 0, total_cents: 8999, thinnr_share_cents: 3000, application_fee_cents: 4599, application_fee_collected_cents: 4599, stripe_fee_cents: 291, stripe_fee_estimate_cents: 291, office_net_cents: 4109, office_net_estimate_cents: 4109 },
    refunds: [
      { id: 'refund-1', stripe_refund_id: 're_1', amount_cents: 500, reason: 'goodwill', status: 'succeeded', requested_by_name: 'Staff', created_at: '2026-10-02T00:00:00Z' },
      { id: 'refund-2', stripe_refund_id: 're_2', amount_cents: 4000, reason: 'oops', status: 'failed', requested_by_name: 'Staff', created_at: '2026-10-03T00:00:00Z' },
    ],
    disputes: [], ledger: [], stripe: { account_id: 'acct_1', invoice_id: null, payment_intent_id: 'pi_1', charge_id: 'ch_1', balance_transaction_id: null },
  } as any;
  const confirmed: Array<[number | undefined, string]> = [];
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<RefundDialog order={order} open onOpenChange={() => {}} onConfirm={(cents, reason) => confirmed.push([cents, reason])} pending={false} />); });
  const root = renderer.root;
  const options = one(root, 'select-refund-preset').findAllByType('option').map((node) => text(node));
  check('presets preview everything remaining, product and product plus shipping', JSON.stringify(options) === JSON.stringify(['Everything remaining · $84.99', 'Product only · $79.99', 'Custom amount']) || JSON.stringify(options) === JSON.stringify(['Everything remaining · $84.99', 'Product only · $79.99', 'Product + shipping · $84.99', 'Custom amount']), JSON.stringify(options));
  check('failed refunds do not reduce the remainder (matches the server)', text(root).includes('Up to $84.99'));
  check('amount opens at the remainder with a dollar prefix', one(root, 'input-refund-amount').props.value === '84.99' && text(root).includes('$'));
  await act(async () => one(root, 'select-refund-preset').props.onChange({ target: { value: 'product' } }));
  check('choosing a preset fills the amount', one(root, 'input-refund-amount').props.value === '79.99');
  await act(async () => one(root, 'input-refund-amount').props.onChange({ target: { value: '9' } }));
  await act(async () => one(root, 'input-refund-amount').props.onBlur());
  check('blur formats 9 as 9.00 and flips the preset to custom', one(root, 'input-refund-amount').props.value === '9.00' && one(root, 'select-refund-preset').props.value === 'custom');
  await act(async () => one(root, 'input-refund-amount').props.onChange({ target: { value: '90' } }));
  check('over the remainder shows the red box and marks the field invalid', Boolean(one(root, 'refund-over-max')) && one(root, 'input-refund-amount').props['aria-invalid'] === true && text(one(root, 'refund-over-max')).includes('$84.99'));
  check('issue refund stays disabled until the acknowledgement is checked', one(root, 'button-refund-confirm').props.disabled === true);
  await act(async () => one(root, 'checkbox-refund-acknowledge').props.onChange({ target: { checked: true } }));
  await act(async () => one(root, 'button-refund-confirm').props.onClick());
  check('acknowledged but over-max click explains instead of submitting', confirmed.length === 0 && text(root).includes('Enter no more than $84.99'));
  await act(async () => one(root, 'input-refund-amount').props.onChange({ target: { value: '9' } }));
  await act(async () => one(root, 'input-refund-reason').props.onChange({ target: { value: 'Broken seal' } }));
  await act(async () => one(root, 'button-refund-confirm').props.onClick());
  check('valid partial refund submits cents and reason', JSON.stringify(confirmed) === JSON.stringify([[900, 'Broken seal']]), JSON.stringify(confirmed));
  await act(async () => one(root, 'select-refund-preset').props.onChange({ target: { value: 'remaining' } }));
  await act(async () => one(root, 'button-refund-confirm').props.onClick());
  check('everything-remaining still sends the exact acknowledged cents', JSON.stringify(confirmed[1]) === JSON.stringify([8499, 'Broken seal']), JSON.stringify(confirmed));
  const footer = root.findAll((node) => node.type === 'button' && (text(node) === 'Cancel' || text(node) === 'Issue refund'));
  check('footer buttons share one size', footer.length === 2 && footer.every((node) => String(node.props.className).includes('h-9 px-3.5')));
  await act(async () => { renderer.unmount(); });
}

console.log('\noffice billing: side menu sections');
{
  const payments = OFFICE_NAV_ITEMS.find((item) => item.path === '/payments');
  check('Payments menu item lists every section as a child', JSON.stringify(payments?.children) === JSON.stringify(OFFICE_PAYMENTS_SECTIONS));
  check(
    'menu matcher lights the parent anywhere in the area, children only on their own page',
    isOfficeMenuPathActive('/payments', '/payments/refunds') && isOfficeMenuPathActive('/payments/refunds', '/payments/refunds') && !isOfficeMenuPathActive('/payments/refunds', '/payments/activity') && isOfficeMenuPathActive('/payments/transactions', '/payments/transactions/abc') && !isOfficeMenuPathActive('/payments/activity', '/payments'),
  );
}

console.log(failures ? `\n${failures} office billing check(s) failed.` : '\nAll office billing checks passed.');
process.exit(failures ? 1 : 0);