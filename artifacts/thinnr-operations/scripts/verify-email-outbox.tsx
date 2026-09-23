/**
 * HQ Email outbox page: guided demo with no requests, live list with the
 * summary strip and delivery marks, URL-persisted filters (cursor drops on a
 * new criterion, paging pushes), the tracking-not-enabled state, preview
 * modal reuse with Resend, and send-to-other from the outbox. Runs under
 * tsconfig.billing.json (DOM-free dialog stubs).
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { PaymentsEmailOutbox } from '../src/pages/admin/payments/PaymentsEmailOutbox';
import { PAYMENT_SECTIONS } from '../src/pages/admin/payments/shared';
import type { CustomerEmail, CustomerEmailList } from '../src/lib/billing-types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.location ??= { assign() {} };
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.window.innerWidth ??= 1280;
g.navigator ??= {};

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
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, 'http://test.local');
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ method, url: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : null });
  const match = handlers.find((row) => row.method === method && row.test(url));
  if (!match) return new Response(JSON.stringify({ error: `unexpected ${method} ${url.pathname}` }), { status: 404, headers: { 'content-type': 'application/json' } });
  const { status, body } = match.handle(url, init);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};
function persona(kind: 'demo' | 'hq-admin' | 'hq-clinical') {
  requests.length = 0; handlers.length = 0;
  if (kind === 'demo') {
    __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null, claimedWorkspace: null });
    __setSupabaseSession(null);
    return;
  }
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: kind === 'hq-admin' ? 'Admin' : 'Clinical', claimedWorkspace: null });
  __setSupabaseSession('hq-token');
  on('GET', '/api/billing/public/config', () => ({ status: 200, body: { sandbox: true, publishable_key: 'pk_test', mode: 'test' } }));
  on('GET', '/api/billing/hq/providers', () => ({ status: 200, body: { items: [
    { provider_id: 'office-1', office_name: 'Beacon Hill', provider_name: 'Dr. Harbor', account: null, offered_products: 3, orders_30d: 4, collected_30d_cents: 0, fees_30d_cents: 0 },
    { provider_id: 'office-2', office_name: 'Northgate', provider_name: 'Dr. Lane', account: null, offered_products: 2, orders_30d: 1, collected_30d_cents: 0, fees_30d_cents: 0 },
  ] } }));
}
async function settle(rounds = 10) { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
async function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const location = memoryLocation({ path, record: true });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={location.hook}>
          <Route path="/admin/payments" nest><PaymentsEmailOutbox /></Route>
        </Router>
      </QueryClientProvider>,
    );
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
const submit = async (form: ReactTestInstance) => { await act(async () => { form.props.onSubmit({ preventDefault() {} }); }); await settle(); };
const dialog = (root: ReactTestInstance, id: string) => root.findAll((node) => node.type === 'div' && node.props.role === 'dialog' && node.props['data-testid'] === id)[0];

// ---- fixtures ----
const NO_DELIVERY: CustomerEmail['delivery'] = { delivered_at: null, delayed_at: null, bounced_at: null, complained_at: null, opened_at: null, clicked_at: null, last_event_type: null, last_event_at: null };
const email = (overrides: Partial<CustomerEmail>): CustomerEmail => ({
  id: 'email-1', kind: 'automatic', parent_id: null, contact_id: null, template_id: 'order-confirmation', status: 'sent',
  recipient: 'maya@example.com', subject: 'Order TH-1001 confirmed', provider_id: 'office-1', office_name: 'Beacon Hill', payer_id: 'payer-1',
  payer_name: 'Maya Thompson', patient_id: 'patient-1', order_id: 'order-1', order_number: 'TH-1001', subscription_id: null,
  attempts: 1, max_attempts: 3, last_attempt_at: '2026-09-20T15:00:00Z', next_attempt_at: null, sent_at: '2026-09-20T15:00:00Z',
  vendor_message_id: 'msg_1', error: null, requested_by: null, created_at: '2026-09-20T15:00:00Z', attempt_log: [], events: [],
  delivery: { ...NO_DELIVERY, delivered_at: '2026-09-20T15:00:05Z', opened_at: '2026-09-20T16:00:00Z', last_event_type: 'opened', last_event_at: '2026-09-20T16:00:00Z' },
  ...overrides,
});
const ROWS = [
  email({}),
  email({ id: 'email-2', template_id: 'order-shipped', provider_id: 'office-2', office_name: 'Northgate', payer_name: 'Liam Ortiz', recipient: 'liam@example.com', order_number: 'TH-1002', order_id: 'order-2', created_at: '2026-09-21T09:00:00Z', sent_at: '2026-09-21T09:00:00Z', delivery: { ...NO_DELIVERY, delivered_at: '2026-09-21T09:00:04Z', clicked_at: '2026-09-21T10:00:00Z', last_event_type: 'clicked', last_event_at: '2026-09-21T10:00:00Z' } }),
  email({ id: 'email-3', template_id: 'subscription-renewal-reminder', status: 'failed', attempts: 3, sent_at: null, error: '550 mailbox not found', created_at: '2026-09-22T09:00:00Z', delivery: NO_DELIVERY }),
];
const SUMMARY = { total: 3, sent: 2, failed: 1, bounced: 0, opened: 1, clicked: 1, truncated: false };
const TRACKING_ON = { vendor: 'resend', configured: true, last_event_at: '2026-09-21T10:00:00Z' };
const list = (overrides: Partial<CustomerEmailList> = {}): CustomerEmailList => ({ items: ROWS, next_cursor: null, payers: [], summary: SUMMARY, tracking: TRACKING_ON, ...overrides });
const EMAILS = '/api/billing/hq/emails';
const lastList = () => [...requests].reverse().find((row) => row.method === 'GET' && row.url.startsWith(`${EMAILS}?`))?.url ?? '';

console.log('navigation');
{
  check('Email outbox sits in the payments section tabs', PAYMENT_SECTIONS.some((section) => section.path === '/emails' && section.label === 'Email outbox'));
}

console.log('guided demo: fixed dataset, no requests, actions disabled');
{
  persona('demo');
  const { root } = await mount('/admin/payments/emails');
  const rows = all(root, 'outbox-table')[0].findAll((node) => node.type === 'tr' && String(node.props['data-testid'] ?? '').startsWith('outbox-row-'));
  check('demo renders rows from the order demo dataset without fetching', requests.length === 0 && rows.length > 3, `${requests.length} requests, ${rows.length} rows`);
  check('demo summary strip shows counts, not the not-enabled note', text(one(root, 'summary-sent')).match(/\d/) !== null && !text(one(root, 'summary-opened')).includes('Tracking') && all(root, 'text-outbox-tracking-off').length === 0);
  check('demo shows delivery marks per row', all(root, 'outbox-mark-opened').length >= 1 && all(root, 'outbox-mark-clicked').length >= 1);
  check('demo disables send-to', all(root, 'button-outbox-send-to').every((node) => node.props.disabled === true));
  await press(all(root, 'button-outbox-preview')[0]);
  check('demo preview opens the shared modal with Resend disabled', Boolean(dialog(root, 'dialog-email-preview')) && one(root, 'button-preview-resend').props.disabled === true && Boolean(one(root, 'preview-frame')));
}

console.log('live list: summary, marks, filters in the URL');
{
  persona('hq-admin');
  on('GET', EMAILS, (url) => {
    const q = url.searchParams.get('q');
    const items = q === 'liam' ? [ROWS[1]] : ROWS;
    return { status: 200, body: list({ items, summary: q === 'liam' ? { ...SUMMARY, total: 1, sent: 1, failed: 0, opened: 0 } : SUMMARY, next_cursor: url.searchParams.get('cursor') ? null : 'cursor-2' }) };
  });
  const { root, location } = await mount('/admin/payments/emails?status=sent&template=order-shipped');
  check('first request carries the URL filters, the summary flag and the page size', lastList().includes('status=sent') && lastList().includes('template=order-shipped') && lastList().includes('summary=1') && lastList().includes('limit=50'), lastList());
  check('filter controls reflect the URL', one(root, 'select-outbox-status').props.value === 'sent' && one(root, 'select-outbox-template').props.value === 'order-shipped');
  check('rows show time, payer, office, template, recipient, status', text(one(root, 'outbox-payer')) === 'Maya Thompson' && text(one(root, 'outbox-office')) === 'Beacon Hill' && text(one(root, 'outbox-recipient')) === 'maya@example.com' && all(root, 'outbox-status').map(text).join(',') === 'Sent,Sent,Failed');
  check('delivery column shows the vendor facts per row', all(root, 'outbox-row-email-1')[0].findAll((n) => n.props['data-testid'] === 'outbox-mark-opened').length === 1 && all(root, 'outbox-row-email-2')[0].findAll((n) => n.props['data-testid'] === 'outbox-mark-clicked').length === 1 && text(all(root, 'outbox-row-email-3')[0].findAll((n) => n.props['data-testid'] === 'outbox-delivery')[0]) === '—');
  check('summary strip counts the whole filter', text(one(root, 'summary-sent')).includes('2') && text(one(root, 'summary-failed')).includes('1') && text(one(root, 'summary-opened')).includes('1') && text(one(root, 'summary-clicked')).includes('1') && text(one(root, 'summary-bounced')).includes('0'));
  check('office filter lists the providers', one(root, 'select-outbox-office').findAll((n) => n.type === 'option').map((n) => n.props.value).join(',') === ',office-1,office-2');
  check('opens are described as indicative', text(root).includes('pixel-based'));

  // paging pushes the cursor; a new criterion drops it and returns to the first page
  await press(one(root, 'button-outbox-next'));
  check('Older pushes the cursor into the URL and requests it', location.history.at(-1) === '/admin/payments/emails?status=sent&template=order-shipped&cursor=cursor-2' && lastList().includes('cursor=cursor-2'), location.history.at(-1));
  check('cursor page offers Newest and no further Older', Boolean(one(root, 'button-outbox-first')) && !one(root, 'button-outbox-next'));
  await type(one(root, 'input-outbox-search'), 'liam');
  check('typing a search replaces the URL, keeps other filters, drops the cursor', location.history.at(-1) === '/admin/payments/emails?status=sent&template=order-shipped&q=liam' && !lastList().includes('cursor='), location.history.at(-1));
  check('search results replace the rows and the strip', all(root, 'outbox-payer').map(text).join(',') === 'Liam Ortiz' && text(one(root, 'summary-sent')).includes('1'));
  await type(one(root, 'select-outbox-office'), 'office-2');
  await type(one(root, 'input-outbox-from'), '2026-09-01');
  check('office and date filters land in the URL and the request', location.history.at(-1)?.includes('provider_id=office-2') === true && lastList().includes('from=2026-09-01') && lastList().includes('provider_id=office-2'), lastList());
}

console.log('tracking not enabled');
{
  persona('hq-admin');
  on('GET', EMAILS, () => ({ status: 200, body: list({ summary: { ...SUMMARY, opened: 0, clicked: 0, bounced: 0 }, tracking: { vendor: 'resend', configured: false, last_event_at: null } }) }));
  const { root } = await mount('/admin/payments/emails');
  check('strip says Tracking not enabled instead of zeros for delivery counts', text(one(root, 'summary-opened')).includes('Tracking not enabled') && text(one(root, 'summary-clicked')).includes('Tracking not enabled') && text(one(root, 'summary-bounced')).includes('Tracking not enabled') && text(one(root, 'summary-sent')).includes('2'));
  check('note names the secret and the dashboard switches', text(one(root, 'text-outbox-tracking-off')).includes('RESEND_WEBHOOK_SECRET') && text(one(root, 'text-outbox-tracking-off')).includes('open and click tracking'));
  check('delivery column says not enabled on every row', all(root, 'outbox-tracking-off').length === ROWS.length && all(root, 'outbox-mark-opened').length === 0);

  persona('hq-admin');
  on('GET', EMAILS, () => ({ status: 200, body: list({ tracking: { vendor: 'resend', configured: true, last_event_at: null } }) }));
  const waiting = await mount('/admin/payments/emails');
  check('configured but silent: note points at the webhook URL', text(one(waiting.root, 'text-outbox-tracking-off')).includes('/api/email/webhooks/resend'));
}

console.log('actions: resend from the preview, send to another address');
{
  persona('hq-admin');
  on('GET', EMAILS, () => ({ status: 200, body: list() }));
  on('GET', `${EMAILS}/email-1/preview`, () => ({ status: 200, body: { subject: 'Order TH-1001 confirmed', html: '<html><body>Thanks</body></html>', text: 'Thanks' } }));
  on('POST', `${EMAILS}/email-1/resend`, () => ({ status: 200, body: { outcome: 'sent', email: email({ id: 'email-9', kind: 'resend', parent_id: 'email-1' }) } }));
  on('POST', `${EMAILS}/email-2/send-to`, () => ({ status: 200, body: { outcome: 'sent', email: email({ id: 'email-10', kind: 'send_to_other', parent_id: 'email-2', recipient: 'other@example.com' }) } }));
  const { root } = await mount('/admin/payments/emails');
  await press(all(root, 'button-outbox-preview')[0]);
  check('preview modal opens with the rendered email and Resend enabled', Boolean(dialog(root, 'dialog-email-preview')) && Boolean(one(root, 'preview-frame')) && one(root, 'button-preview-resend').props.disabled === false);
  await press(one(root, 'button-preview-resend'));
  await press(one(root, 'button-confirm-resend'));
  const listCallsBefore = requests.filter((row) => row.method === 'GET' && row.url.startsWith(`${EMAILS}?`)).length;
  check('resend posts to the HQ ledger, closes the modal, and refreshes the list', requests.some((row) => row.method === 'POST' && row.url === `${EMAILS}/email-1/resend`) && !dialog(root, 'dialog-email-preview') && listCallsBefore >= 2, `${listCallsBefore} list calls`);
  await press(all(root, 'button-outbox-send-to')[1]);
  check('send-to dialog opens for the chosen row', Boolean(dialog(root, 'dialog-send-to')) && text(dialog(root, 'dialog-send-to')).includes('TH-1002'));
  await type(one(root, 'input-send-to-email'), 'other@example.com');
  await submit(dialog(root, 'dialog-send-to').findAll((n) => n.type === 'form')[0]);
  const sendTo = requests.find((row) => row.method === 'POST' && row.url === `${EMAILS}/email-2/send-to`);
  check('send-to posts the address and closes', sendTo?.body?.email === 'other@example.com' && !dialog(root, 'dialog-send-to'));
}

console.log('departments outside Payments are refused');
{
  persona('hq-clinical');
  on('GET', EMAILS, () => ({ status: 200, body: list() }));
  const { root } = await mount('/admin/payments/emails');
  check('Clinical never sees the outbox or requests the ledger', all(root, 'outbox-table').length === 0 && !requests.some((row) => row.url.startsWith(EMAILS)), requests.map((row) => row.url).join(','));
}

console.log('errors');
{
  persona('hq-admin');
  on('GET', EMAILS, () => ({ status: 500, body: { error: 'ledger unavailable' } }));
  const { root } = await mount('/admin/payments/emails');
  const alert = root.findAll((node) => node.type === 'div' && node.props.role === 'alert')[0];
  check('a failed list shows the error with a retry, never an empty table', Boolean(alert) && all(root, 'outbox-table').length === 0);
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('email outbox suite passed');
