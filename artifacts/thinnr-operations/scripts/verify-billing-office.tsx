import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import OfficePaymentsArea from '../src/pages/office/payments/OfficePaymentsArea';

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
const requests: Array<{ url: string; method: string; body: any }> = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : null });
  const next = responses.shift();
  if (!next) throw new Error(`unexpected fetch ${url}`);
  return next();
};

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
  product_id: 'control', slug: 'control', name: 'Control', active: true, floor_price_cents: 5999,
  break_even_minimum_cents: 3767, sell_price_cents: 7999, subscription_enabled: true, offered: true, below_minimum: false,
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
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Router hook={location.hook}><Route path="/payments" nest><OfficePaymentsArea /></Route></Router></QueryClientProvider>); });
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
  demo.renderer.unmount();

  const demoDetail = await render('/transactions/demo-order-1');
  const backLink = demoDetail.root.findAll(
    (node) => node.type === 'a' && node.props.href === '/payments/transactions' && text(node).includes('Back to transactions'),
  );
  check(
    'demo transaction renders its order detail and relative Back link',
    requests.length === 0 && text(demoDetail.root).includes('TH-D3MO01') && backLink.length === 1,
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

console.log('\noffice billing: prices');
{
  reset();
  responses = [json(200, status()), json(200, { products: [price], settings: { shipping_charge_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30 } })];
  const page = await render('/prices');
  const input = one(page.root, 'input-price-control');
  await act(async () => input.props.onChange({ target: { value: '30.00' } }));
  await act(async () => one(page.root, 'button-save-price-control').props.onClick());
  check('below-minimum price is rejected locally with minimum shown', requests.length === 2 && text(page.root).includes('$37.67'), JSON.stringify(requests));
  await act(async () => input.props.onChange({ target: { value: '82.50' } }));
  responses = [json(200, { product: { ...price, sell_price_cents: 8250 } }), json(200, status())];
  await act(async () => one(page.root, 'button-save-price-control').props.onClick());
  await settle();
  const put = requests.find((request) => request.method === 'PUT');
  check('valid price PUTs cents and subscription setting', put?.url === '/api/billing/office/prices/control' && JSON.stringify(put.body) === JSON.stringify({ sell_price_cents: 8250, subscription_enabled: true }), JSON.stringify(put));
  page.renderer.unmount();
}

console.log('\noffice billing: patient links and HQ scope');
{
  reset();
  responses = [json(200, status()), json(200, { items: [] })];
  const links = await render('/links');
  await act(async () => one(links.root, 'input-patient-search').props.onChange({ target: { value: 'Maya' } }));
  responses = [json(200, { items: [{ id: 'patient-1', name: 'Maya Thompson', email: 'maya@example.com', phone: null }] })];
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  await settle();
  await act(async () => one(links.root, 'patient-result-patient-1').props.onClick());
  responses = [
    json(200, { link: { id: 'link-1', token: 'token', url: 'https://example.com/pay/token', provider_id: 'office-1', patient_id: 'patient-1', patient_name: 'Maya Thompson', label: null, active: true, uses: 0, last_used_at: null, created_at: '2026-10-11T00:00:00Z' } }),
    json(200, status()), json(200, { items: [] }),
  ];
  await act(async () => one(links.root, 'button-create-patient-link').props.onClick());
  await settle();
  const post = requests.find((request) => request.method === 'POST');
  check('patient link POSTs chosen patient id', JSON.stringify(post?.body) === JSON.stringify({ patient_id: 'patient-1' }), JSON.stringify(post));
  links.renderer.unmount();

  reset('hq');
  responses = [json(200, status())];
  const hq = await render('/get-paid');
  check('HQ drill-in appends office to live calls', requests[0]?.url === '/api/billing/office/status?office=office-1', JSON.stringify(requests));
  hq.renderer.unmount();
}

console.log(failures ? `\n${failures} office billing check(s) failed.` : '\nAll office billing checks passed.');
process.exit(failures ? 1 : 0);