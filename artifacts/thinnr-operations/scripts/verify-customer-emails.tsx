/**
 * Emails card (order and patient pages): demo dataset, live list with status
 * and delivery marks, preview modal with Resend beside Close, send to a
 * different email, notification contacts, permission gating, and the
 * forbidden state. Runs under tsconfig.billing.json (DOM-free dialog stubs).
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { CustomerEmailsCard, deliveryMarks, emailStatus, isValidEmail, plainSendError, templateLabel } from '../src/components/billing/CustomerEmailsCard';
import { demoEmailDatasetForOrder } from '../src/components/billing/customer-emails-demo';
import { DEMO_ORDER_DETAILS } from '../src/pages/office/payments/demo-data';
import type { CustomerEmail, NotificationContact } from '../src/lib/billing-types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.location ??= { assign() {} };
g.navigator ??= {};

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (pass) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---- scripted fetch: handlers matched by method + path prefix, newest wins ----
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
  if (!match) throw new Error(`unexpected fetch ${method} ${url.pathname}${url.search}`);
  const { status, body } = match.handle(url, init);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

function persona(kind: 'demo' | 'owner' | 'hq-admin' | 'hq-viewer') {
  requests.length = 0; handlers.length = 0; __setScope(null);
  if (kind === 'demo') {
    __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null, claimedWorkspace: null });
    __setSupabaseSession(null);
  } else if (kind === 'owner') {
    __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null, claimedWorkspace: null });
    __setSupabaseSession('staff-token');
  } else {
    __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: kind === 'hq-admin' ? 'Admin' : 'Finance', claimedWorkspace: null });
    __setScope({ providerId: 'office-1', officeName: 'Beacon Hill' });
    __setSupabaseSession('hq-token');
  }
}
async function settle(rounds = 10) { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
async function mount(element: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}>{element}</QueryClientProvider>); });
  await settle();
  return { renderer, root: renderer.root };
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
const type = async (node: ReactTestInstance, value: string) => { await act(async () => { node.props.onChange({ target: { value } }); }); };
const submit = async (form: ReactTestInstance) => { await act(async () => { form.props.onSubmit({ preventDefault() {} }); }); await settle(); };
const dialog = (root: ReactTestInstance, id: string) => root.findAll((node) => node.type === 'div' && node.props.role === 'dialog' && node.props['data-testid'] === id)[0];

// ---- fixtures ----
const ORDER_ID = '4f2d7a4e-3c7b-4a2d-9c1e-1b4f8e2a6d10';
const PAYER = { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Maya Thompson', email: 'maya@example.com' };
const baseEmail = (overrides: Partial<CustomerEmail>): CustomerEmail => ({
  id: 'email-1', kind: 'automatic', parent_id: null, contact_id: null, template_id: 'order-confirmation', status: 'sent',
  recipient: PAYER.email, subject: 'Order TH-1001 confirmed', provider_id: 'office-1', office_name: 'Beacon Hill', payer_id: PAYER.id,
  payer_name: PAYER.name, patient_id: 'patient-1', order_id: ORDER_ID, order_number: 'TH-1001', subscription_id: null,
  attempts: 1, max_attempts: 3, last_attempt_at: '2026-09-20T15:00:00Z', next_attempt_at: null, sent_at: '2026-09-20T15:00:00Z',
  vendor_message_id: 'msg_1', error: null, requested_by: null, created_at: '2026-09-20T15:00:00Z',
  attempt_log: [{ at: '2026-09-20T15:00:00Z', outcome: 'sent', error: null, vendor_message_id: 'msg_1', recipient_domain: 'example.com' }],
  events: [
    { id: 'ev-1', event_type: 'sent', occurred_at: '2026-09-20T15:00:00Z' },
    { id: 'ev-2', event_type: 'delivered', occurred_at: '2026-09-20T15:00:05Z' },
    { id: 'ev-3', event_type: 'opened', occurred_at: '2026-09-20T16:00:00Z' },
  ],
  ...overrides,
});
const liveEmails = (): CustomerEmail[] => [
  baseEmail({}),
  baseEmail({ id: 'email-2', template_id: 'order-shipped', subject: 'On the way', status: 'retrying', attempts: 2, sent_at: null, next_attempt_at: '2026-09-21T10:00:00Z', error: 'ETIMEDOUT', events: [], created_at: '2026-09-21T09:00:00Z' }),
  baseEmail({ id: 'email-3', template_id: 'subscription-renewal-reminder', subject: 'Renewal soon', status: 'failed', attempts: 3, sent_at: null, error: '550 5.1.1 mailbox not found', events: [], created_at: '2026-09-22T09:00:00Z' }),
];
const contact = (overrides: Partial<NotificationContact> = {}): NotificationContact => ({
  id: 'contact-1', payer_id: PAYER.id, email: 'spouse@example.com', label: 'Spouse', active: true,
  created_at: '2026-09-02T15:20:00Z', removed_at: null, added_by_name: 'Dr. Harbor', ...overrides,
});
const EMAILS_PATH = '/api/billing/office/emails';
const CONTACTS_PATH = `/api/billing/office/payers/${PAYER.id}/contacts`;
const preview = { subject: 'Order TH-1001 confirmed', html: '<html><body><h1>Thanks, Maya</h1></body></html>', text: 'Thanks, Maya' };

console.log('pure helpers');
{
  check('template names are plain language', templateLabel('order-confirmation') === 'Order confirmation' && templateLabel('order-shipped') === 'Shipped' && templateLabel('subscription-renewal-reminder') === 'Renewal reminder' && templateLabel('verification-code') === 'Verification code' && templateLabel('some-new-thing') === 'Some new thing');
  check('status labels carry the attempt count while retrying', emailStatus(liveEmails()[1]).label === 'Retrying, attempt 2 of 3' && emailStatus(liveEmails()[0]).label === 'Sent' && emailStatus(liveEmails()[2]).tone === 'bad');
  check('delivery marks come from events in a fixed order', deliveryMarks(liveEmails()[0]).map((mark) => mark.label).join(',') === 'Delivered,Opened' && deliveryMarks(liveEmails()[1]).length === 0);
  check('vendor errors are said plainly', plainSendError('ETIMEDOUT') === 'The email service did not respond in time.' && plainSendError('550 5.1.1 mailbox not found') === 'The address rejected the message (mailbox not found).' && plainSendError('Something odd') === 'Something odd.' && plainSendError(null) === 'The email could not be sent.');
  check('email validation', isValidEmail('a@b.co') && !isValidEmail('nope') && !isValidEmail('a@b') && !isValidEmail(''));
}

console.log('guided demo: fixed dataset, no requests, actions disabled');
{
  persona('demo');
  const dataset = demoEmailDatasetForOrder(DEMO_ORDER_DETAILS['demo-order-2']);
  const { root, renderer } = await mount(<CustomerEmailsCard area="office" filter={{ order_id: 'demo-order-2' }} payer={DEMO_ORDER_DETAILS['demo-order-2'].payer} canAct={false} demo={dataset} />);
  const labels = all(root, 'email-template').map(text);
  check('demo lists confirmation and shipped rows without fetching', requests.length === 0 && labels.includes('Order confirmation') && labels.includes('Shipped'), labels.join(','));
  check('demo rows show delivery marks and a failed send-to-other row', all(root, 'email-mark-opened').length >= 1 && all(root, 'email-mark-clicked').length >= 1 && all(root, 'email-kind').some((node) => text(node) === 'Sent to another address') && all(root, 'email-failure').length === 1 && text(one(root, 'email-failure')).includes('mailbox not found'));
  check('demo disables send-to and retry actions', all(root, 'button-send-to-other').every((node) => node.props.disabled === true) && one(root, 'button-retry-now').props.disabled === true);
  await press(all(root, 'button-preview-email')[0]);
  const modal = dialog(root, 'dialog-email-preview');
  check('demo preview renders a sandboxed frame from the real template', Boolean(modal) && one(root, 'preview-frame').props.sandbox === '' && String(one(root, 'preview-frame').props.srcDoc).includes('<html'));
  check('demo preview keeps Resend visible but disabled beside Close', one(root, 'button-preview-resend').props.disabled === true && String(one(root, 'button-preview-resend').props.className).includes('absolute right-12 top-3'));
  await press(one(root, 'button-preview-text'));
  check('plain-text toggle swaps the frame for text', !one(root, 'preview-frame') && text(one(root, 'preview-text')).length > 20 && one(root, 'button-preview-text').props['aria-pressed'] === true);
  await press(one(root, 'button-notification-emails'));
  check('demo contacts list shows who added the address and blocks removal', Boolean(dialog(root, 'dialog-notification-contacts')) && text(one(root, 'contact-added')).includes('by Dr. Elena Park') && one(root, 'button-remove-contact').props.disabled === true && !one(root, 'form-add-contact'));
  check('demo never fetched', requests.length === 0);
  renderer.unmount();
}

console.log('office owner: live list, preview, resend');
{
  persona('owner');
  let emails = liveEmails();
  on('GET', EMAILS_PATH, () => ({ status: 200, body: { items: emails, next_cursor: null, payers: [PAYER] } }));
  on('GET', `${EMAILS_PATH}/email-1/preview`, () => ({ status: 200, body: preview }));
  on('POST', `${EMAILS_PATH}/email-1/resend`, () => {
    const row = baseEmail({ id: 'email-4', kind: 'resend', parent_id: 'email-1', created_at: '2026-09-23T12:00:00Z', sent_at: '2026-09-23T12:00:00Z', events: [] });
    emails = [row, ...emails];
    return { status: 200, body: { outcome: 'sent', email: row } };
  });
  const { root, renderer } = await mount(<CustomerEmailsCard area="office" filter={{ order_id: ORDER_ID }} payer={PAYER} canAct />);
  check('live list requests the order scope', requests[0]?.url === `${EMAILS_PATH}?order_id=${ORDER_ID}&limit=50`, requests[0]?.url);
  const statuses = all(root, 'email-status').map(text);
  check('rows show Sent, Retrying with attempt count, and Failed', statuses.join('|') === 'Sent|Retrying, attempt 2 of 3|Failed', statuses.join('|'));
  check('recipient, time, and marks render', text(all(root, 'email-recipient')[0]).includes('maya@example.com') && all(root, 'email-mark-delivered').length === 1 && all(root, 'email-mark-opened').length === 1);
  check('failed row shows the plain error and a live Retry now', text(one(root, 'email-failure')).includes('The address rejected the message') && one(root, 'button-retry-now').props.disabled !== true);
  check('owner may send to other addresses', all(root, 'button-send-to-other').every((node) => node.props.disabled !== true));

  await press(all(root, 'button-preview-email')[0]);
  await settle();
  check('preview fetched and rendered with subject and sandboxed html', requests.some((row) => row.url.startsWith(`${EMAILS_PATH}/email-1/preview`)) && Boolean(dialog(root, 'dialog-email-preview')) && text(dialog(root, 'dialog-email-preview')).includes('Order TH-1001 confirmed') && one(root, 'preview-frame').props.srcDoc === preview.html);
  check('modal carries a heading naming the email', dialog(root, 'dialog-email-preview').findAllByType('h2').some((node) => text(node).includes('Order confirmation')));
  await press(one(root, 'button-preview-resend'));
  check('Resend asks for confirmation inside the modal before sending', Boolean(one(root, 'resend-confirm')) && text(one(root, 'resend-confirm')).includes('maya@example.com') && !requests.some((row) => row.method === 'POST'));
  await press(one(root, 'button-confirm-resend'));
  await settle();
  const resendRequest = requests.find((row) => row.method === 'POST');
  check('confirming posts the resend to the address on record', resendRequest?.url === `${EMAILS_PATH}/email-1/resend`, resendRequest?.url);
  check('list refreshes with the linked resend row and the modal closes', !dialog(root, 'dialog-email-preview') && all(root, 'email-kind').some((node) => text(node) === 'Resent') && all(root, 'email-status').length === 4);

  requests.length = 0;
  on('POST', `${EMAILS_PATH}/email-3/resend`, () => ({ status: 502, body: { error: 'The address rejected the message.', outcome: 'failed' } }));
  await press(one(root, 'button-retry-now'));
  check('Retry now reuses the resend path and refreshes the list even when the send fails', requests[0]?.url === `${EMAILS_PATH}/email-3/resend` && requests.some((row) => row.method === 'GET' && row.url.startsWith(`${EMAILS_PATH}?`)), requests.map((row) => row.url).join(','));
  renderer.unmount();
}

console.log('office owner: send to a different email');
{
  persona('owner');
  on('GET', EMAILS_PATH, () => ({ status: 200, body: { items: liveEmails(), next_cursor: null, payers: [PAYER] } }));
  let sendToStatus = 400;
  on('POST', `${EMAILS_PATH}/email-1/send-to`, () => sendToStatus === 400
    ? { status: 400, body: { error: 'Enter a valid email address.', field: 'email' } }
    : { status: 200, body: { outcome: 'sent', email: baseEmail({ id: 'email-9', kind: 'send_to_other', recipient: 'other@example.com' }) } });
  const { root, renderer } = await mount(<CustomerEmailsCard area="office" filter={{ order_id: ORDER_ID }} payer={PAYER} canAct />);
  await press(all(root, 'button-send-to-other')[0]);
  const modal = dialog(root, 'dialog-send-to');
  check('send-to dialog opens for the chosen email', Boolean(modal) && text(modal).includes('order confirmation email for order TH-1001'));
  const form = modal.findByType('form');
  await type(one(root, 'input-send-to-email'), 'not-an-email');
  await submit(form);
  check('client validation blocks an invalid address without a request', text(one(root, 'send-to-error')) === 'Enter a valid email address.' && !requests.some((row) => row.method === 'POST') && one(root, 'input-send-to-email').props['aria-invalid'] === true);
  await type(one(root, 'input-send-to-email'), 'valid@example.com');
  await submit(form);
  check('server field errors land under the input', requests.some((row) => row.method === 'POST' && row.body?.email === 'valid@example.com') && text(one(root, 'send-to-error')) === 'Enter a valid email address.');
  sendToStatus = 200;
  await type(one(root, 'input-send-to-email'), 'other@example.com');
  await submit(form);
  check('a successful send closes the dialog', !dialog(root, 'dialog-send-to') && requests.filter((row) => row.method === 'POST').length === 2);
  renderer.unmount();
}

console.log('office owner: notification contacts');
{
  persona('owner');
  let contacts = [contact()];
  on('GET', EMAILS_PATH, () => ({ status: 200, body: { items: liveEmails(), next_cursor: null, payers: [PAYER] } }));
  on('GET', CONTACTS_PATH, () => ({ status: 200, body: { payer: PAYER, contacts } }));
  on('POST', CONTACTS_PATH, (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.email === 'spouse@example.com') return { status: 409, body: { error: 'That address is already on the list.', field: 'email' } };
    const added = contact({ id: 'contact-2', email: body.email, label: body.label, added_by_name: 'Dr. Harbor', created_at: '2026-09-23T12:00:00Z' });
    contacts = [...contacts, added];
    return { status: 201, body: { contact: added } };
  });
  on('DELETE', `${CONTACTS_PATH}/contact-1`, () => { contacts = contacts.filter((row) => row.id !== 'contact-1'); return { status: 200, body: { contact: contact({ active: false }) } }; });
  const { root, renderer } = await mount(<CustomerEmailsCard area="office" filter={{ order_id: ORDER_ID }} payer={PAYER} canAct />);
  await press(one(root, 'button-notification-emails'));
  check('contacts dialog lists who added each address and when', Boolean(dialog(root, 'dialog-notification-contacts')) && requests.some((row) => row.url.startsWith(CONTACTS_PATH)) && text(one(root, 'contact-added')).includes('by Dr. Harbor') && text(one(root, 'contact-added')).includes('2026'));
  const form = one(root, 'form-add-contact');
  await type(one(root, 'input-contact-email'), 'bad');
  await submit(form);
  check('add form validates locally', text(one(root, 'contact-error')) === 'Enter a valid email address.' && !requests.some((row) => row.method === 'POST'));
  await type(one(root, 'input-contact-email'), 'spouse@example.com');
  await submit(form);
  check('duplicate contact shows the server message on the field', text(one(root, 'contact-error')) === 'That address is already on the list.');
  await type(one(root, 'input-contact-email'), 'sister@example.com');
  await type(one(root, 'input-contact-label'), 'Sister');
  await submit(form);
  const addRequest = requests.filter((row) => row.method === 'POST').pop();
  check('adding posts email and label, then refreshes the list', addRequest?.body?.email === 'sister@example.com' && addRequest?.body?.label === 'Sister' && all(root, 'button-remove-contact').length === 2 && one(root, 'input-contact-email').props.value === '');
  await press(all(root, 'button-remove-contact')[0]);
  check('remove asks for confirmation first', Boolean(one(root, 'button-confirm-remove-contact')) && !requests.some((row) => row.method === 'DELETE'));
  await press(one(root, 'button-confirm-remove-contact'));
  check('confirming removes the address and refreshes', requests.some((row) => row.method === 'DELETE' && row.url.startsWith(`${CONTACTS_PATH}/contact-1`)) && all(root, 'button-remove-contact').length === 1);
  renderer.unmount();
}

console.log('permissions, HQ scope, patient scope, forbidden');
{
  persona('owner');
  on('GET', EMAILS_PATH, () => ({ status: 200, body: { items: liveEmails(), next_cursor: null, payers: [PAYER] } }));
  on('GET', CONTACTS_PATH, () => ({ status: 200, body: { payer: PAYER, contacts: [contact()] } }));
  on('GET', `${EMAILS_PATH}/email-1/preview`, () => ({ status: 200, body: preview }));
  const viewer = await mount(<CustomerEmailsCard area="office" filter={{ order_id: ORDER_ID }} payer={PAYER} canAct={false} />);
  check('view-only roles see rows but every write is disabled', all(viewer.root, 'email-status').length === 3 && all(viewer.root, 'button-send-to-other').every((node) => node.props.disabled === true) && one(viewer.root, 'button-retry-now').props.disabled === true);
  await press(all(viewer.root, 'button-preview-email')[0]);
  check('view-only preview still opens with Resend disabled', Boolean(dialog(viewer.root, 'dialog-email-preview')) && one(viewer.root, 'button-preview-resend').props.disabled === true);
  await press(viewer.root.findAll((node) => node.type === 'button' && text(node) === 'Close')[0] ?? viewer.root.findAll((node) => node.type === 'button')[0]);
  await press(one(viewer.root, 'button-notification-emails'));
  check('view-only contacts are read-only', Boolean(one(viewer.root, 'contacts-readonly')) && !one(viewer.root, 'form-add-contact') && one(viewer.root, 'button-remove-contact').props.disabled === true);
  viewer.renderer.unmount();

  persona('hq-admin');
  on('GET', '/api/billing/hq/emails', () => ({ status: 200, body: { items: liveEmails(), next_cursor: null, payers: [PAYER] } }));
  const hq = await mount(<CustomerEmailsCard area="hq" filter={{ order_id: ORDER_ID }} payer={PAYER} canAct />);
  check('HQ area calls the HQ ledger routes', requests[0]?.url.startsWith(`/api/billing/hq/emails?order_id=${ORDER_ID}`) && all(hq.root, 'email-status').length === 3, requests[0]?.url);
  hq.renderer.unmount();

  persona('hq-admin');
  on('GET', EMAILS_PATH, (url) => ({ status: 200, body: { items: liveEmails(), next_cursor: null, payers: url.searchParams.get('patient_id') ? [PAYER, { id: 'payer-legacy', name: 'Maya T.', email: 'old@example.com' }] : [PAYER] } }));
  const patient = await mount(<CustomerEmailsCard area="office" filter={{ patient_id: 'patient-1' }} canAct />);
  check('HQ drill-in on a patient scopes the office request and resolves payers from the response', requests[0]?.url === `${EMAILS_PATH}?patient_id=patient-1&limit=50&office=office-1` && Boolean(one(patient.root, 'button-notification-emails')), requests[0]?.url);
  on('GET', (url) => url.pathname.startsWith('/api/billing/office/payers/'), () => ({ status: 200, body: { payer: PAYER, contacts: [] } }));
  await press(one(patient.root, 'button-notification-emails'));
  check('multiple payers get a payer chooser in the contacts dialog', Boolean(one(patient.root, 'select-contacts-payer')) && Boolean(one(patient.root, 'contacts-empty')));
  patient.renderer.unmount();

  persona('owner');
  on('GET', EMAILS_PATH, () => ({ status: 403, body: { error: 'Forbidden' } }));
  const forbidden = await mount(<CustomerEmailsCard area="office" filter={{ patient_id: 'patient-1' }} canAct />);
  check('a 403 explains who can see emails instead of an empty card', Boolean(one(forbidden.root, 'emails-forbidden')) && text(one(forbidden.root, 'emails-forbidden')).includes('office owners and admins') && !one(forbidden.root, 'button-notification-emails') && requests.length === 1);
  forbidden.renderer.unmount();

  persona('owner');
  on('GET', EMAILS_PATH, () => ({ status: 500, body: { error: 'Ledger unavailable' } }));
  const failed = await mount(<CustomerEmailsCard area="office" filter={{ order_id: ORDER_ID }} payer={PAYER} canAct />);
  // Non-403 failures retry once with react-query's default back-off before the error state lands.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
  await settle();
  check('other failures announce and offer retry', Boolean(one(failed.root, 'emails-error')) && Boolean(one(failed.root, 'button-emails-retry')));
  failed.renderer.unmount();

  persona('owner');
  on('GET', EMAILS_PATH, () => ({ status: 200, body: { items: [], next_cursor: null, payers: [PAYER] } }));
  const empty = await mount(<CustomerEmailsCard area="office" filter={{ order_id: ORDER_ID }} payer={PAYER} canAct />);
  check('empty ledger says so and still offers notification emails', Boolean(one(empty.root, 'emails-empty')) && Boolean(one(empty.root, 'button-notification-emails')));
  empty.renderer.unmount();
}

if (failures) { console.error(`\n${failures} customer email check(s) failed.`); process.exit(1); }
console.log('\nAll customer email checks passed.');
