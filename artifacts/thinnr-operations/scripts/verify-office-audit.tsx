/**
 * Audit pages — office-scoped audit trail and the HQ audit log's name
 * resolution / office picker.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:office-audit
 *
 * Renders the REAL OfficeAudit and HQ Audit pages under react-test-renderer
 * (session / scope / hq-data contexts and the document-bound Radix
 * primitives stubbed via tsconfig.office-admin.json, global fetch
 * scripted) and checks:
 *
 * Office page
 *   - demo persona → notice, no request; resolving → loading;
 *   - staff-role 403 → permission notice (not an error box, no filters);
 *   - rows show human-readable actor / action / target names and metadata
 *     details; the page text never contains a raw provider or user id;
 *   - denials render in the destructive style; internal record ids (noteId)
 *     are hidden from the office view;
 *   - the action picker lists only the server's office-visible actions and
 *     filtering re-queries with ?action=; date inputs re-query with
 *     from/to and a backwards window is refused client-side;
 *   - pagination: range text, Prev disabled on page 0, Next advances the
 *     offset and Prev returns; HQ drill-in appends ?office=<id>.
 *
 * HQ page
 *   - the office picker is a named list built from the HQ directory whose
 *     value is the provider id, and choosing one filters with ?provider=;
 *   - rows show actorName / officeName / targetName with raw ids as fine
 *     print, and actions are labeled from the shared label table.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import type { OfficeAuditEvent, OfficeAuditPage } from '../src/lib/office-audit';
import OfficeAuditPageView from '../src/pages/OfficeAudit';
import HqAudit from '../src/pages/admin/Audit';
import { AUDIT_ACTION_LABELS } from '../src/lib/audit-labels';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};

const rawConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
  rawConsoleError(...args);
};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const RAW_IDS = ['office-1', 'auth-user-7', 'pt-91', 'tm-4'];
const OFFICE_ACTIONS = ['patient_note_added', 'office_team_deactivated', 'data_export_downloaded', 'access_denied', 'patient_record_viewed', 'bloodwork_report_opened', 'conversation_transcript_opened'];
const BILLING_ACTIONS = [
  'billing_refund_issued', 'billing_subscription_cancelled', 'billing_subscription_payment_retried',
  'billing_subscription_payment_email_sent', 'billing_order_fulfillment_updated', 'billing_prices_updated',
  'billing_payment_link_created', 'billing_payment_link_updated', 'billing_connect_started',
  'billing_connect_completed', 'billing_connect_disconnected', 'billing_settings_updated', 'billing_sandbox_reset',
  'billing_product_created', 'billing_product_updated', 'billing_product_archived', 'billing_product_floor_updated',
];
check('every billing audit action has a label', BILLING_ACTIONS.every((action) => Boolean(AUDIT_ACTION_LABELS[action])));

function event(id: number, overrides: Partial<OfficeAuditEvent> = {}): OfficeAuditEvent {
  return {
    id, occurredAt: `2026-09-0${(id % 6) + 1}T14:${String(id).padStart(2, '0')}:00Z`, action: 'patient_note_added',
    actorName: 'Sam Front Desk', actorKind: 'team_member', targetName: 'Patient: Casey Ortiz', targetKind: 'patient',
    metadata: { noteId: 'n-1' }, ...overrides,
  };
}

const EVENTS: OfficeAuditEvent[] = [
  event(1),
  event(2, { action: 'office_team_deactivated', actorName: 'Dr. Priya Raman', actorKind: 'provider', targetName: 'Teammate: Dee Disabled', targetKind: 'team_member', metadata: { role: 'staff', status: 'disabled' } }),
  event(3, { action: 'data_export_downloaded', actorName: 'Adam Admin', targetName: 'Export: Patients (CSV)', targetKind: 'export', metadata: { kind: 'patients', rows: 42 } }),
  event(4, { action: 'access_denied', actorName: 'Sam Front Desk', targetName: 'Protected route: GET /office/team', targetKind: 'route', metadata: { reason: 'permission', route: '/office/team', method: 'GET', status: 403 } }),
  event(5, { action: 'bloodwork_report_opened', actorName: 'Nurse Kim', metadata: { reportId: 'rep-0000-secret' } }),
  event(6, { action: 'conversation_transcript_opened', actorName: 'Nurse Kim', metadata: { thread: 'care_team', conversationId: 'conv-0000-secret' } }),
];

function page(events: OfficeAuditEvent[], total: number): OfficeAuditPage {
  return { office: { name: 'Beacon Hill Aesthetics' }, actions: OFFICE_ACTIONS, events, total };
}

// ─── Scripted fetch ──────────────────────────────────────────────────────────

interface Recorded { method: string; url: string; auth: string | null }
const requests: Recorded[] = [];
let responses: Array<() => Response> = [];
let fallback: ((url: string) => Response) | null = null;
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url, auth: headers.get('authorization') });
  const next = responses.shift();
  if (next) return next();
  if (fallback) return fallback(url);
  throw new Error(`unexpected fetch ${url}`);
};

// ─── Render helpers ──────────────────────────────────────────────────────────

interface Rendered { renderer: ReactTestRenderer; root: ReactTestInstance }

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function render(element: React.ReactElement, path: string): Promise<Rendered> {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={loc.hook}>{element}</Router>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root };
}

function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}

const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => { const all = byTestId(root, id); if (all.length !== 1) throw new Error(`expected exactly one ${id}, found ${all.length}`); return all[0]; };
const maybe = (root: ReactTestInstance, id: string) => byTestId(root, id)[0];
const click = async (node: ReactTestInstance) => { await act(async () => { node.props.onClick({ preventDefault() {} }); }); await settle(); };
const type = async (node: ReactTestInstance, value: string) => { await act(async () => { node.props.onChange({ target: { value } }); }); await settle(); };
const optionsOf = (trigger: ReactTestInstance) => {
  // The stub renders the listbox as a sibling of the trigger inside the
  // Select provider: climb until the subtree holds the options.
  let scope: ReactTestInstance | null = trigger.parent;
  while (scope && scope.findAll((node) => node.props.role === 'option').length === 0) scope = scope.parent;
  if (!scope) throw new Error('no options near this trigger');
  return scope.findAll((node) => node.props.role === 'option').map((node) => ({ value: String(node.props['data-value']), label: textOf(node), node }));
};
const pick = async (trigger: ReactTestInstance, value: string) => {
  const option = optionsOf(trigger).find((o) => o.value === value);
  if (!option) throw new Error(`no option ${value}`);
  await act(async () => { option.node.props.onClick(); });
  await settle();
};
const lastUrl = () => requests[requests.length - 1]?.url ?? '';
const decoded = (url: string) => decodeURIComponent(url);

function reset(status: 'signed-in' | 'signed-out' | 'loading' = 'signed-in') {
  requests.length = 0;
  responses = [];
  fallback = null;
  __setScope(null);
  __setSupabaseSession(status === 'signed-in' ? 'staff-token' : null);
  __setSession(status === 'signed-in'
    ? { authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'auth-user-7' }, hqRole: null }
    : { authStatus: status, authRole: null, authUser: null, hqRole: null });
}

// ─── Office audit: persona states ────────────────────────────────────────────

console.log('office audit: persona states');
{
  reset('signed-out');
  const demo = await render(<OfficeAuditPageView />, '/audit');
  check('demo persona: notice, no filters, no request', Boolean(maybe(demo.root, 'status-audit-demo')) && !maybe(demo.root, 'select-audit-action') && requests.length === 0);
  demo.renderer.unmount();

  reset('loading');
  const loading = await render(<OfficeAuditPageView />, '/audit');
  check('resolving session: loading state, no request', Boolean(maybe(loading.root, 'status-audit-loading')) && requests.length === 0);
  loading.renderer.unmount();

  reset();
  responses = [json(403, { error: 'Only office owners and admins can see the audit trail.' })];
  const staff = await render(<OfficeAuditPageView />, '/audit');
  const notice = maybe(staff.root, 'status-audit-unauthorized');
  check('staff-role teammate: 403 is a permission notice with the server text; filters hidden', Boolean(notice) && textOf(notice!).includes('Only office owners and admins') && !maybe(staff.root, 'status-audit-error') && !maybe(staff.root, 'select-audit-action'), notice ? textOf(notice) : 'none');
  check('first request: bearer token, limit/offset only, no office id', requests.length === 1 && requests[0].auth === 'Bearer staff-token' && requests[0].url === '/api/office/audit-events?limit=50&offset=0', JSON.stringify(requests));
  staff.renderer.unmount();
}

// ─── Office audit: rows, filters, pagination ─────────────────────────────────

console.log('\noffice audit: rows, filters, pagination');
{
  reset();
  const firstPage = page(EVENTS, 120);
  fallback = (url) => {
    const params = new URL(url, 'http://x').searchParams;
    const offset = Number(params.get('offset') ?? 0);
    const action = params.get('action');
    if (offset >= 50) return json(200, page([event(51, { actorName: 'Second Page Actor' })], 120))();
    if (action) return json(200, page(EVENTS.filter((e) => e.action === action), 1))();
    if (params.get('from') || params.get('to')) return json(200, page([EVENTS[1]], 1))();
    return json(200, firstPage)();
  };
  const { root, renderer } = await render(<OfficeAuditPageView />, '/audit');
  const table = one(root, 'table-office-audit');
  check('six rows render, newest first as served', EVENTS.every((e) => Boolean(maybe(root, `row-audit-${e.id}`))) && table.findAll((n) => n.type === 'tr').length === 7);
  const pageText = textOf(root);
  check('office name shown as the card subtitle', pageText.includes('Beacon Hill Aesthetics'));
  check('rows use human-readable names, actions and targets', pageText.includes('Dr. Priya Raman') && pageText.includes('Deactivated a teammate') && pageText.includes('Teammate: Dee Disabled') && pageText.includes('Patient: Casey Ortiz') && pageText.includes('Downloaded a data export'), pageText.slice(0, 400));
  check('no raw provider / user / record id appears anywhere on the page', RAW_IDS.every((id) => !pageText.includes(id)) && !pageText.includes('n-1'), pageText);
  check('record-access reads render with plain labels and the thread, never the report or conversation id', pageText.includes('Opened lab report') && pageText.includes('Opened a conversation transcript') && textOf(one(root, 'row-audit-6')).includes('Thread:care team') && !pageText.includes('-secret'), textOf(one(root, 'row-audit-6')));
  const denial = one(root, 'row-audit-4');
  check('denied attempt renders in the destructive style with the route and reason', denial.findAll((n) => typeof n.props.className === 'string' && n.props.className.includes('text-destructive')).length === 1 && textOf(denial).includes('Reason:permission') && textOf(denial).includes('Route:/office/team') && textOf(denial).includes('Status:403'), textOf(denial));
  check('metadata renders as labeled details (role / status / rows)', textOf(one(root, 'row-audit-2')).includes('Role:staff') && textOf(one(root, 'row-audit-2')).includes('Status:disabled') && textOf(one(root, 'row-audit-3')).includes('Rows:42'));
  check('range text and pager: 1–6 of 120, Prev disabled, Next enabled', textOf(one(root, 'text-audit-range')).startsWith('Showing 1–6 of 120') && one(root, 'button-audit-prev').props.disabled === true && one(root, 'button-audit-next').props.disabled === false, textOf(one(root, 'text-audit-range')));

  // Action picker lists exactly the office-visible set.
  const actionTrigger = one(root, 'select-audit-action');
  const options = optionsOf(actionTrigger);
  check('action picker: "All actions" + the server\'s office-visible actions, labeled', options[0].label === 'All actions' && options.slice(1).map((o) => o.value).join(',') === OFFICE_ACTIONS.join(',') && options.some((o) => o.label === 'Deactivated a teammate') && !options.some((o) => o.value === 'hq_team_revoked'), options.map((o) => `${o.value}=${o.label}`).join(' | '));
  await pick(actionTrigger, 'office_team_deactivated');
  check('choosing an action re-queries with ?action= from offset 0', lastUrl() === '/api/office/audit-events?limit=50&offset=0&action=office_team_deactivated' && byTestId(root, 'row-audit-2').length === 1 && !maybe(root, 'row-audit-1'), lastUrl());
  await pick(one(root, 'select-audit-action'), '__all__');
  check('"All actions" clears the action filter', !lastUrl().includes('action='), lastUrl());

  // Date window.
  await type(one(root, 'input-audit-from'), '2026-09-01');
  await type(one(root, 'input-audit-to'), '2026-09-03');
  check('date inputs re-query with from/to', decoded(lastUrl()).includes('from=2026-09-01') && decoded(lastUrl()).includes('to=2026-09-03'), lastUrl());
  const before = requests.length;
  await type(one(root, 'input-audit-to'), '2026-08-01');
  check('a backwards window is refused client-side (no request, inline notice, last good page kept)', requests.length === before && Boolean(maybe(root, 'status-audit-invalid-window')) && Boolean(maybe(root, 'row-audit-2')), `${requests.length - before} new requests; ${textOf(root).slice(-300)}`);
  const clear = root.find((n) => n.type === 'button' && textOf(n) === 'Clear');
  await click(clear);
  check('Clear resets every filter', lastUrl() === '/api/office/audit-events?limit=50&offset=0', lastUrl());

  // Pagination.
  await click(one(root, 'button-audit-next'));
  check('Next requests offset 50 and renders the second page', lastUrl() === '/api/office/audit-events?limit=50&offset=50' && Boolean(maybe(root, 'row-audit-51')) && textOf(one(root, 'text-audit-range')).startsWith('Showing 51–51 of 120') && one(root, 'button-audit-prev').props.disabled === false, lastUrl());
  await click(one(root, 'button-audit-prev'));
  check('Prev returns to the first page', Boolean(maybe(root, 'row-audit-1')) && one(root, 'button-audit-prev').props.disabled === true);
  renderer.unmount();

  // Empty and outage states.
  reset();
  fallback = () => json(200, page([], 0))();
  const empty = await render(<OfficeAuditPageView />, '/audit');
  check('empty office: empty state inside the table, pager shows 0', Boolean(maybe(empty.root, 'status-audit-empty')) && one(empty.root, 'button-audit-next').props.disabled === true);
  empty.renderer.unmount();

  reset();
  fallback = () => json(502, { error: 'Could not load the audit trail right now.' })();
  const broken = await render(<OfficeAuditPageView />, '/audit');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3400)); });
  await settle();
  const errorBox = maybe(broken.root, 'status-audit-error');
  check('outage: error state with the server message and a retry button', Boolean(errorBox) && textOf(errorBox!).includes('Could not load the audit trail right now.') && errorBox!.findAll((n) => n.type === 'button').length === 1);
  broken.renderer.unmount();

  // HQ drill-in.
  reset();
  __setSupabaseSession('hq-token');
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'auth-hq' }, hqRole: 'Admin' });
  __setScope({ providerId: 'office-1', officeName: 'Beacon Hill Aesthetics' });
  fallback = () => json(200, page(EVENTS, 4))();
  const hq = await render(<OfficeAuditPageView />, '/audit');
  check('HQ drill-in names the office with ?office= and renders the rows', requests[0]?.url === '/api/office/audit-events?limit=50&offset=0&office=office-1' && requests[0].auth === 'Bearer hq-token' && Boolean(maybe(hq.root, 'row-audit-1')), JSON.stringify(requests));
  hq.renderer.unmount();
}

// ─── HQ audit: office picker + names ─────────────────────────────────────────

console.log('\nhq audit: office picker and name resolution');
{
  reset();
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'auth-hq' }, hqRole: 'Admin' });
  __setHqData({ accounts: [
    { id: 'office-2', officeName: 'Willow Creek Wellness' },
    { id: 'office-1', officeName: 'Beacon Hill Aesthetics' },
  ] });
  const hqEvents = [
    { id: 11, occurredAt: '2026-09-05T10:00:00Z', action: 'office_team_role_changed', actorUserId: 'auth-user-7', actorKind: 'team_member', providerId: 'office-1', targetKind: 'team_member', targetId: 'tm-4', requestId: 'req-1', metadata: { role: 'admin' }, actorName: 'Adam Admin', officeName: 'Beacon Hill Aesthetics', targetName: 'Teammate: Sam Staff' },
    { id: 12, occurredAt: '2026-09-05T09:00:00Z', action: 'knowledge_document_deleted', actorUserId: 'auth-hq', actorKind: 'hq', providerId: null, targetKind: 'knowledge_document', targetId: 'kd-1', requestId: null, metadata: { size: 2048, contentType: 'application/pdf' }, actorName: 'Avery HQ', officeName: null, targetName: 'Knowledge document: Program FAQ' },
    { id: 13, occurredAt: '2026-09-05T08:00:00Z', action: 'access_denied', actorUserId: 'auth-user-7', actorKind: 'team_member', providerId: 'office-1', targetKind: 'route', targetId: 'GET /office/audit-events', requestId: null, metadata: { reason: 'permission', route: '/office/audit-events', method: 'GET', status: 403 }, actorName: 'Sam Staff', officeName: 'Beacon Hill Aesthetics', targetName: 'Protected route: GET /office/audit-events' },
  ];
  fallback = (url) => {
    const params = new URL(url, 'http://x').searchParams;
    const provider = params.get('provider');
    const events = provider ? hqEvents.filter((e) => e.providerId === provider) : hqEvents;
    return json(200, { events, total: events.length })();
  };
  const { root, renderer } = await render(<HqAudit />, '/admin/audit');
  check('HQ list loads unfiltered', requests.length === 1 && decoded(requests[0].url).startsWith('/api/hq/audit-events?') && !requests[0].url.includes('provider='), JSON.stringify(requests));
  const text = textOf(root);
  check('rows show actor names, office names and target names', text.includes('Adam Admin') && text.includes('Beacon Hill Aesthetics') && text.includes('Teammate: Sam Staff') && text.includes('Avery HQ') && text.includes('Knowledge document: Program FAQ'), text.slice(0, 500));
  check('raw office / target ids stay as HQ fine print (names are the headline)', text.includes('office-1') && text.includes('tm-4') && textOf(one(root, 'text-actor-11')) === 'Adam Admin' && textOf(one(root, 'text-office-11')) === 'Beacon Hill Aesthetics');
  check('actions are labeled from the shared table, denials destructive', text.includes('Changed a teammate role') && text.includes('Deleted a knowledge document') && root.findAll((n) => typeof n.props.className === 'string' && n.props.className.includes('text-destructive') && textOf(n) === 'Was refused access').length === 1, text);
  check('HQ-only event without an office shows a dash, never an id', !maybe(root, 'text-office-12') && text.includes('Avery HQHQ staff—'));

  const officeTrigger = one(root, 'select-audit-office');
  const officeOptions = optionsOf(officeTrigger);
  check('office picker: "All offices" + directory names sorted, values are provider ids', officeOptions.map((o) => `${o.value}=${o.label}`).join('|') === '__all__=All offices|office-1=Beacon Hill Aesthetics|office-2=Willow Creek Wellness', officeOptions.map((o) => `${o.value}=${o.label}`).join('|'));
  check('the picker is a select, not a free-text id box', root.findAll((n) => n.type === 'input' && /provider/i.test(String(n.props.placeholder ?? ''))).length === 0);
  await pick(officeTrigger, 'office-1');
  check('choosing an office filters with ?provider=<id> and drops the HQ-only row', lastUrl().includes('provider=office-1') && Boolean(maybe(root, 'text-actor-11')) && !maybe(root, 'text-actor-12'), lastUrl());
  const actionTrigger = one(root, 'select-audit-action');
  check('action picker is the labeled full vocabulary', optionsOf(actionTrigger).some((o) => o.value === 'hq_team_revoked' && o.label === 'Revoked HQ access') && optionsOf(actionTrigger).some((o) => o.value === 'access_denied'));
  await pick(actionTrigger, 'access_denied');
  check('action + office filters combine in one request', lastUrl().includes('provider=office-1') && lastUrl().includes('action=access_denied'), lastUrl());
  renderer.unmount();
}

console.log(failures === 0 ? '\nAll audit page checks passed.' : `\n${failures} audit page check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
