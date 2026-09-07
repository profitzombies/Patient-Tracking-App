/**
 * Organization policies — HQ settings page, office Settings page, and the
 * demo page that must stay untouched.
 *
 *   TZ=UTC tsx --tsconfig tsconfig.org-policies.json scripts/verify-org-policies.tsx
 *
 * Covers:
 *   - lib/org-policy: display vocabulary and the override-precedence preview
 *     (inherit / none / custom quiet hours, blank escalation → HQ default).
 *   - the guided-demo HQ settings page keeps its seeded GroupCards and never
 *     touches the network; the office demo page holds session-only overrides.
 *   - the LIVE HQ page: one card per section with "last changed by … · when",
 *     Save posts ONLY that section's fields plus expectedVersion, a 409
 *     reloads instead of overwriting, non-admins get the access notice, and a
 *     blank number never reaches the server.
 *   - the office Settings page: effective value beside the HQ default with its
 *     source chip, overrides post with the override row's version, HQ drill-in
 *     scopes the request by office, read-only roles cannot edit, 409 reloads.
 *   - the inbox status filter rides the API (open by default) and closed
 *     threads carry the Closed chip.
 *   - the header gear routes to /settings and the nav resolves its title
 *     without adding a menu tab.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HqOrganizationSettings, OfficeSettings as OfficeSettingsDto } from '@workspace/api-client-react';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { useToast } from '../src/hooks/use-toast';
import {
  describeDays,
  describeHours,
  describeQuietHours,
  describeSectionChange,
  previewEffective,
  quietHoursOverrideFor,
} from '../src/lib/org-policy';
import { OFFICE_NAV_ITEMS, OFFICE_SETTINGS_NAV_ITEM, findActiveOfficeNavItem } from '../src/components/layout/nav-config';
import { HQ_SETTINGS_GROUPS } from '../src/data/hq/settings';
import OrgSettings from '../src/pages/admin/OrgSettings';
import OfficeSettings from '../src/pages/OfficeSettings';
import Conversations from '../src/pages/admin/Conversations';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
g.window.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
g.window.setTimeout ??= (fn: any, ms?: any) => setTimeout(fn, ms);
g.window.clearTimeout ??= (t: any) => clearTimeout(t);
g.window.setInterval ??= (fn: any, ms?: any) => setInterval(fn, ms);
g.window.clearInterval ??= (t: any) => clearInterval(t);
// Radix Switch checks `instanceof HTMLFormElement` for form resets; there is no DOM here.
g.HTMLFormElement ??= class HTMLFormElement {};
g.document ??= { title: '', querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} };

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
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
const oneByTestId = (root: ReactTestInstance, id: string) => {
  const matches = byTestId(root, id);
  if (matches.length !== 1) throw new Error(`expected exactly one [data-testid="${id}"], found ${matches.length}`);
  return matches[0];
};
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const clickEvent = () => ({ isPropagationStopped: () => false, stopPropagation() {}, preventDefault() {}, defaultPrevented: false });
const press = async (node: ReactTestInstance) => { await act(async () => { node.props.onClick(clickEvent()); }); await settle(); };
const type = async (node: ReactTestInstance, value: string) => { await act(async () => { node.props.onChange({ target: { value } }); }); await settle(1); };

// Toasts: the page fires them through the shared store; a spy component reads it.
const toasts: Array<{ title?: unknown; description?: unknown; variant?: unknown }> = [];
function ToastSpy() {
  const { toasts: current } = useToast();
  React.useEffect(() => {
    current.forEach((toast) => { if (!toasts.some((seen) => seen === toast)) toasts.push(toast); });
  }, [current]);
  return null;
}
const lastToast = () => toasts[toasts.length - 1];

// ─── Pure half ───────────────────────────────────────────────────────────────

console.log('lib/org-policy');
{
  check('quiet hours read as a 12-hour window', describeQuietHours({ start: '21:00', end: '08:00' }) === '9:00 PM to 8:00 AM');
  check('null quiet hours read as none', describeQuietHours(null) === 'No quiet hours');
  check('whole years are annotated', describeDays(730) === '730 days (2 years)' && describeDays(365) === '365 days (1 year)');
  check('odd day counts stay plain', describeDays(14) === '14 days' && describeDays(1) === '1 day');
  check('hours annotate whole days', describeHours(24) === '24 hours (1 day)' && describeHours(6) === '6 hours');
  check('untouched section reads Never changed', describeSectionChange(null) === 'Never changed');
  const stamp = describeSectionChange({ changedAt: '2026-09-07T15:40:00.000Z', changedBy: 'u1', changedByName: 'Avery Admin' });
  check('section stamp names the actor and the time', stamp.startsWith('Last changed by Avery Admin · ') && stamp.includes('Sep 7, 2026'), stamp);
  const anon = describeSectionChange({ changedAt: '2026-09-07T15:40:00.000Z', changedBy: null, changedByName: null });
  check('unknown actor still shows when', anon.startsWith('Last changed ') && !anon.includes(' by '), anon);

  const hq = { defaultQuietHours: { start: '21:00', end: '08:00' }, escalationEmail: 'care@hq.example.com' };
  const inherit = previewEffective(hq, { quietHours: { mode: 'inherit' }, escalationEmail: null });
  check('inherit → HQ window from HQ', JSON.stringify(inherit) === JSON.stringify({ quietHours: hq.defaultQuietHours, escalationEmail: 'care@hq.example.com', source: { quietHours: 'hq', escalationEmail: 'hq' } }), JSON.stringify(inherit));
  const none = previewEffective(hq, { quietHours: { mode: 'none' }, escalationEmail: '  ' });
  check('none → no quiet hours, from office; blank email still HQ', none.quietHours === null && none.source.quietHours === 'office' && none.escalationEmail === 'care@hq.example.com' && none.source.escalationEmail === 'hq');
  const custom = previewEffective(hq, { quietHours: { mode: 'custom', start: '22:00', end: '07:00' }, escalationEmail: 'front@office.example.com' });
  check('custom → office window and office email', JSON.stringify(custom) === JSON.stringify({ quietHours: { start: '22:00', end: '07:00' }, escalationEmail: 'front@office.example.com', source: { quietHours: 'office', escalationEmail: 'office' } }));
  const noHq = previewEffective({ defaultQuietHours: null, escalationEmail: null }, { quietHours: { mode: 'inherit' }, escalationEmail: null });
  check('inherit with no HQ window → none, still sourced HQ', noHq.quietHours === null && noHq.escalationEmail === null && noHq.source.quietHours === 'hq');
  check('switching to custom seeds the HQ window', JSON.stringify(quietHoursOverrideFor('custom', { mode: 'inherit' }, hq.defaultQuietHours)) === JSON.stringify({ mode: 'custom', start: '21:00', end: '08:00' }));
  check('switching to custom keeps a typed window', JSON.stringify(quietHoursOverrideFor('custom', { mode: 'custom', start: '20:00', end: '06:00' }, hq.defaultQuietHours)) === JSON.stringify({ mode: 'custom', start: '20:00', end: '06:00' }));
  check('switching to custom with no HQ window falls back to 9 PM–8 AM', JSON.stringify(quietHoursOverrideFor('custom', { mode: 'none' }, null)) === JSON.stringify({ mode: 'custom', start: '21:00', end: '08:00' }));
  check('switching away drops the window', JSON.stringify(quietHoursOverrideFor('none', { mode: 'custom', start: '20:00', end: '06:00' }, null)) === JSON.stringify({ mode: 'none' }));
}

console.log('nav-config');
{
  check('Settings is not a menu tab', !OFFICE_NAV_ITEMS.some((item) => item.path === '/settings'));
  check('/settings resolves the header title', findActiveOfficeNavItem('/settings') === OFFICE_SETTINGS_NAV_ITEM && OFFICE_SETTINGS_NAV_ITEM.label === 'Settings');
  check('other routes still resolve their own item', findActiveOfficeNavItem('/patients/abc').label === 'Patients' && findActiveOfficeNavItem('/').label === 'Overview');
}

// ─── Scripted API ────────────────────────────────────────────────────────────

const requests: Array<{ url: string; method: string; body: any }> = [];
let hqSettings: HqOrganizationSettings;
let officeSettings: OfficeSettingsDto;
let conflictNext = false;
let conversations: Array<{ id: string; status: 'open' | 'closed' }> = [];

function hqFixture(): HqOrganizationSettings {
  return {
    organizationName: 'THINNR, Inc.',
    supportEmail: 'support@thinnr.example.com',
    supportPhone: null,
    defaultTimezone: 'America/New_York',
    coachAvailable: true,
    escalationEmail: 'care@hq.example.com',
    defaultCategories: { coachOutreach: true, checkInReminders: true, officeReminders: false },
    defaultQuietHours: { start: '21:00', end: '08:00' },
    outreachCooldownDays: 14,
    outreachDailyCap: 500,
    conversationAutoCloseDays: 14,
    retention: { chatTranscriptDays: 730, progressPhotoDays: 730, notificationHistoryDays: 180, auditEventDays: 2555 },
    exportLinkHours: 24,
    version: 3,
    updatedAt: '2026-09-06T12:00:00.000Z',
    sections: {
      organization: { changedAt: '2026-09-01T10:00:00.000Z', changedBy: 'u1', changedByName: 'Avery Admin' },
      coach: null,
      notifications: { changedAt: '2026-09-06T12:00:00.000Z', changedBy: 'u2', changedByName: 'Blake Ops' },
      conversations: null,
      retention: null,
    },
  };
}

function officeFixture(): OfficeSettingsDto {
  const hq = hqFixture();
  return {
    office: { providerId: 'prov-1', officeName: 'Riverside Wellness' },
    hq,
    overrides: { quietHours: { mode: 'inherit' }, escalationEmail: null, version: 0, updatedAt: null, updatedBy: null, updatedByName: null },
    effective: { quietHours: hq.defaultQuietHours, escalationEmail: hq.escalationEmail, source: { quietHours: 'hq', escalationEmail: 'hq' } },
    canEdit: true,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ url, method, body });
  if (method === 'GET' && url.includes('/api/hq/settings')) return json(hqSettings);
  if (method === 'PUT' && url.includes('/api/hq/settings')) {
    if (conflictNext || body.expectedVersion !== hqSettings.version) {
      conflictNext = false;
      return json({ error: 'Someone else saved these settings first. Reload to see the latest values.', version: hqSettings.version }, 409);
    }
    const { expectedVersion: _v, defaultCategories, retention, ...rest } = body;
    const touched = 'coachAvailable' in body || 'escalationEmail' in body ? 'coach' : 'organizationName' in body ? 'organization' : 'conversationAutoCloseDays' in body ? 'conversations' : retention ? 'retention' : 'notifications';
    hqSettings = {
      ...hqSettings,
      ...rest,
      defaultCategories: defaultCategories ?? hqSettings.defaultCategories,
      retention: retention ?? hqSettings.retention,
      version: hqSettings.version + 1,
      sections: { ...hqSettings.sections, [touched]: { changedAt: '2026-09-07T16:00:00.000Z', changedBy: 'me', changedByName: 'Test Admin' } },
    };
    return json(hqSettings);
  }
  if (method === 'GET' && url.includes('/api/office/settings')) return json(officeSettings);
  if (method === 'PUT' && url.includes('/api/office/settings/overrides')) {
    if (conflictNext || body.expectedVersion !== officeSettings.overrides.version) {
      conflictNext = false;
      return json({ error: 'Someone else saved these overrides first.', version: officeSettings.overrides.version }, 409);
    }
    const overrides = { quietHours: body.quietHours, escalationEmail: body.escalationEmail, version: officeSettings.overrides.version + 1, updatedAt: '2026-09-07T16:00:00.000Z', updatedBy: 'me', updatedByName: 'Nurse Kim' };
    officeSettings = { ...officeSettings, overrides, effective: previewEffective(officeSettings.hq, overrides) };
    return json(officeSettings);
  }
  if (method === 'GET' && url.includes('/api/office/conversations')) {
    const status = new URL(url, 'http://local').searchParams.get('status') ?? 'open';
    const rows = conversations.filter((conv) => status === 'all' || conv.status === status);
    return json({
      conversations: rows.map((conv) => ({ id: conv.id, patientId: `pt-${conv.id}`, patientName: `Patient ${conv.id}`, thread: 'coach', messageCount: 3, lastMessageAt: '2026-09-01T00:00:00.000Z', status: conv.status })),
      total: rows.length,
      autoCloseDays: 14,
    });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

async function render(path: string, element: React.ReactElement, routePath = path) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={loc.hook}>
          <ToastSpy />
          <Route path={routePath}>{element}</Route>
        </Router>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root, loc };
}

const switchOf = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && node.props.role === 'switch' && typeof node.type === 'string')[0];

// ─── HQ settings page: demo persona ──────────────────────────────────────────

console.log('HQ settings — guided demo persona');
{
  __setSession({ authStatus: 'signed-out', authRole: null, hqRole: null, authUser: null });
  __setHqData({ settingsValues: {} });
  requests.length = 0;
  const { root } = await render('/admin/settings', <OrgSettings />);
  const groupSaves = HQ_SETTINGS_GROUPS.map((group) => byTestId(root, `button-save-${group.id}`).length);
  check('every seeded group card renders', groupSaves.every((count) => count === 1), groupSaves.join(','));
  check('no live policy cards for the demo', root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('button-save-policy-')).length === 0);
  check('demo settings never touch the network', requests.length === 0);
  check('demo header keeps the mock disclaimer', textOf(root).includes('Some features are mock only in the demo.'));
}

// ─── HQ settings page: live ──────────────────────────────────────────────────

console.log('HQ settings — signed-in non-admin');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Support', authUser: { id: 'u-support' } });
  __setSupabaseSession('hq-token');
  requests.length = 0;
  const { root } = await render('/admin/settings', <OrgSettings />);
  check('Support sees the access notice', byTestId(root, 'policy-access-notice').length === 1);
  check('Support never loads the settings', requests.length === 0);
}

console.log('HQ settings — signed-in admin');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Admin', authUser: { id: 'u-admin' } });
  __setSupabaseSession('hq-token');
  hqSettings = hqFixture();
  requests.length = 0;
  toasts.length = 0;
  const { root } = await render('/admin/settings', <OrgSettings />);
  check('live page loads the persisted settings', requests.filter((request) => request.method === 'GET' && request.url.includes('/api/hq/settings')).length === 1);
  check('demo group cards are gone for live users', root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('button-save-') && !node.props['data-testid'].startsWith('button-save-policy-')).length === 0);
  check('five policy sections, each with a Save', ['organization', 'coach', 'notifications', 'conversations', 'retention'].every((section) => byTestId(root, `button-save-policy-${section}`).length === 1));
  check('organization stamp names its last editor', textOf(oneByTestId(root, 'policy-stamp-organization')).startsWith('Last changed by Avery Admin · '));
  check('notifications stamp names its last editor', textOf(oneByTestId(root, 'policy-stamp-notifications')).startsWith('Last changed by Blake Ops · '));
  check('untouched coach section reads Never changed', textOf(oneByTestId(root, 'policy-stamp-coach')) === 'Never changed');
  check('fields show persisted values', oneByTestId(root, 'input-setting-live-org-name').props.value === 'THINNR, Inc.' && oneByTestId(root, 'input-policy-escalation-email').props.value === 'care@hq.example.com' && oneByTestId(root, 'input-policy-cooldown').props.value === 14 && oneByTestId(root, 'input-policy-retention-audit').props.value === 2555);
  check('coach switch reflects availability', switchOf(root, 'switch-policy-coach-available')?.props['aria-checked'] === true);
  check('office reminders default reflects OFF', switchOf(root, 'switch-policy-default-office')?.props['aria-checked'] === false);
  check('quiet hours enabled with the persisted window', switchOf(root, 'policy-quiet-enabled')?.props['aria-checked'] === true && oneByTestId(root, 'policy-quiet-start').props.value === '21:00');
  check('Save is disabled until something changes', oneByTestId(root, 'button-save-policy-coach').props.disabled === true);

  // Pause the coach: only the coach section's fields ride the PUT.
  await press(switchOf(root, 'switch-policy-coach-available'));
  check('flipping the coach switch arms the coach Save only', oneByTestId(root, 'button-save-policy-coach').props.disabled === false && oneByTestId(root, 'button-save-policy-notifications').props.disabled === true);
  await press(oneByTestId(root, 'button-save-policy-coach'));
  const coachPut = requests.find((request) => request.method === 'PUT');
  check('coach Save posts just the section fields with expectedVersion', coachPut !== undefined && JSON.stringify(coachPut.body) === JSON.stringify({ coachAvailable: false, escalationEmail: 'care@hq.example.com', expectedVersion: 3 }), JSON.stringify(coachPut?.body));
  check('after saving, the page refetched and the coach stamp updated', hqSettings.version === 4 && textOf(oneByTestId(root, 'policy-stamp-coach')).startsWith('Last changed by Test Admin · '));
  check('success toast confirms the live save', String(lastToast()?.title) === 'Coach & care team saved');
  check('coach Save disarms after the save lands', oneByTestId(root, 'button-save-policy-coach').props.disabled === true);

  // Notification numbers: a blank never reaches the server; a real value posts the whole section.
  await type(oneByTestId(root, 'input-policy-cooldown'), '');
  const putsBefore = requests.filter((request) => request.method === 'PUT').length;
  await press(oneByTestId(root, 'button-save-policy-notifications'));
  check('blank cooldown is blocked client-side', requests.filter((request) => request.method === 'PUT').length === putsBefore && String(lastToast()?.title) === 'Notification defaults not saved');
  await type(oneByTestId(root, 'input-policy-cooldown'), '21');
  await press(oneByTestId(root, 'button-save-policy-notifications'));
  const notifPut = requests.filter((request) => request.method === 'PUT').at(-1);
  check('notifications Save posts categories, quiet hours, cooldown, cap at the NEW version', notifPut !== undefined && JSON.stringify(notifPut.body) === JSON.stringify({
    defaultCategories: { coachOutreach: true, checkInReminders: true, officeReminders: false },
    defaultQuietHours: { start: '21:00', end: '08:00' },
    outreachCooldownDays: 21,
    outreachDailyCap: 500,
    expectedVersion: 4,
  }), JSON.stringify(notifPut?.body));

  // Stale version: the server refuses, the page reloads instead of overwriting.
  const getsBefore = requests.filter((request) => request.method === 'GET').length;
  await type(oneByTestId(root, 'input-policy-auto-close'), '30');
  // A teammate lands first: the server copy moves on (version 6, 21 days).
  hqSettings = { ...hqSettings, conversationAutoCloseDays: 21, version: hqSettings.version + 1, sections: { ...hqSettings.sections, conversations: { changedAt: '2026-09-07T16:05:00.000Z', changedBy: 'u3', changedByName: 'Casey Ops' } } };
  await press(oneByTestId(root, 'button-save-policy-conversations'));
  const stalePut = requests.filter((request) => request.method === 'PUT').at(-1);
  check('stale PUT carried the version the page read', stalePut !== undefined && stalePut.body.expectedVersion === 5 && stalePut.body.conversationAutoCloseDays === 30);
  check('409 → conflict toast and a reload of the settings', String(lastToast()?.title) === 'Someone else saved first' && requests.filter((request) => request.method === 'GET').length > getsBefore);
  check('after the conflict reload the draft shows the teammate\'s value and stamp', oneByTestId(root, 'input-policy-auto-close').props.value === 21 && hqSettings.conversationAutoCloseDays === 21 && textOf(oneByTestId(root, 'policy-stamp-conversations')).startsWith('Last changed by Casey Ops · '));

  // Server-side validation message surfaces verbatim.
  await type(oneByTestId(root, 'input-policy-export-hours'), '999');
  const realFetch = g.fetch;
  g.fetch = async (input: any, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'PUT') { requests.push({ url: String(input), method: 'PUT', body: JSON.parse(String(init?.body)) }); return json({ error: 'Export link lifetime must be between 1 and 168 hours.' }, 400); }
    return realFetch(input, init);
  };
  await press(oneByTestId(root, 'button-save-policy-retention'));
  g.fetch = realFetch;
  check('400 shows the server\'s own validation message', String(lastToast()?.description) === 'Export link lifetime must be between 1 and 168 hours.', String(lastToast()?.description));
}

// ─── Office settings page ────────────────────────────────────────────────────

console.log('office settings — guided demo persona');
{
  __setSession({ authStatus: 'signed-out', authRole: null, hqRole: null, authUser: null });
  __setScope(null);
  requests.length = 0;
  toasts.length = 0;
  const { root } = await render('/settings', <OfficeSettings />);
  check('demo page renders the seeded HQ defaults', textOf(oneByTestId(root, 'policy-coach-available')) === 'On' && textOf(oneByTestId(root, 'policy-cooldown')) === '14 days');
  check('demo effective quiet hours follow the seeded HQ window', textOf(oneByTestId(root, 'effective-quiet-hours')) === '9:00 PM to 8:00 AM');
  check('demo escalation email comes from the seeded HQ store', textOf(oneByTestId(root, 'effective-escalation-email')).includes('@'));
  await act(async () => { oneByTestId(root, 'radio-quiet-none').props.onChange(); });
  await settle(1);
  check('choosing No quiet hours previews the office value', textOf(oneByTestId(root, 'effective-quiet-hours')) === 'No quiet hours');
  await press(oneByTestId(root, 'button-save-office-overrides'));
  check('demo save is session-only with the demo toast', requests.length === 0 && String(lastToast()?.description).includes('demo session'));
  check('demo override stamp appears after the session save', byTestId(root, 'override-stamp').length === 1);
  check('demo disclaimer is on the card', textOf(root).includes('Demo session only'));
}

console.log('office settings — signed-in provider staff (manager)');
{
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', hqRole: null, providerAccountCode: 'TEST', authUser: { id: 'u-staff' } });
  __setSupabaseSession('staff-token');
  __setScope(null);
  officeSettings = officeFixture();
  requests.length = 0;
  toasts.length = 0;
  const { root } = await render('/settings', <OfficeSettings />);
  const get = requests.find((request) => request.method === 'GET');
  check('staff load their own office (no office param)', get !== undefined && get.url.includes('/api/office/settings') && !get.url.includes('office='), get?.url);
  check('title names the office', textOf(root).includes('Riverside Wellness'));
  check('effective quiet hours = HQ default with the HQ chip', textOf(oneByTestId(root, 'effective-quiet-hours')) === '9:00 PM to 8:00 AM' && textOf(root).includes('HQ default: 9:00 PM to 8:00 AM'));
  check('effective escalation = HQ default', textOf(oneByTestId(root, 'effective-escalation-email')) === 'care@hq.example.com');
  check('the rest of HQ policy is read-only text', textOf(oneByTestId(root, 'policy-daily-cap')) === '500 per day' && textOf(oneByTestId(root, 'policy-auto-close')) === '14 days' && textOf(oneByTestId(root, 'policy-retention-audit')) === '2555 days (7 years)' && textOf(oneByTestId(root, 'policy-export-hours')) === '24 hours (1 day)' && textOf(oneByTestId(root, 'policy-default-office')) === 'Off by default');
  check('no override rows yet → no stamp, Save disabled', byTestId(root, 'override-stamp').length === 0 && oneByTestId(root, 'button-save-office-overrides').props.disabled === true);

  // Custom window seeds from the HQ default; escalation email previews live.
  await act(async () => { oneByTestId(root, 'radio-quiet-custom').props.onChange(); });
  await settle(1);
  check('custom seeds the HQ window into the time inputs', oneByTestId(root, 'input-override-quiet-start').props.value === '21:00' && oneByTestId(root, 'input-override-quiet-end').props.value === '08:00');
  await type(oneByTestId(root, 'input-override-quiet-start'), '22:00');
  await type(oneByTestId(root, 'input-override-quiet-end'), '07:00');
  check('preview shows the office window', textOf(oneByTestId(root, 'effective-quiet-hours')) === '10:00 PM to 7:00 AM');
  await type(oneByTestId(root, 'input-override-escalation-email'), 'front@riverside.example.com');
  check('preview shows the office escalation email', textOf(oneByTestId(root, 'effective-escalation-email')) === 'front@riverside.example.com');
  await press(oneByTestId(root, 'button-save-office-overrides'));
  const put = requests.find((request) => request.method === 'PUT');
  check('Save posts the overrides with the row version', put !== undefined && put.url.includes('/api/office/settings/overrides') && JSON.stringify(put.body) === JSON.stringify({ expectedVersion: 0, quietHours: { mode: 'custom', start: '22:00', end: '07:00' }, escalationEmail: 'front@riverside.example.com' }), JSON.stringify(put?.body));
  check('after saving, the stamp names the staffer', textOf(oneByTestId(root, 'override-stamp')).startsWith('Set by Nurse Kim · '));
  check('saved overrides win over the HQ default', textOf(oneByTestId(root, 'effective-quiet-hours')) === '10:00 PM to 7:00 AM' && officeSettings.effective.source.quietHours === 'office');
  check('Save disarms once the saved copy matches', oneByTestId(root, 'button-save-office-overrides').props.disabled === true);

  // Back to HQ: blank email + Follow HQ, at the bumped version.
  await act(async () => { oneByTestId(root, 'radio-quiet-inherit').props.onChange(); });
  await type(oneByTestId(root, 'input-override-escalation-email'), '');
  check('preview falls back to HQ values', textOf(oneByTestId(root, 'effective-quiet-hours')) === '9:00 PM to 8:00 AM' && textOf(oneByTestId(root, 'effective-escalation-email')) === 'care@hq.example.com');
  await press(oneByTestId(root, 'button-save-office-overrides'));
  const put2 = requests.filter((request) => request.method === 'PUT').at(-1);
  check('clearing posts inherit + null at version 1', put2 !== undefined && JSON.stringify(put2.body) === JSON.stringify({ expectedVersion: 1, quietHours: { mode: 'inherit' }, escalationEmail: null }), JSON.stringify(put2?.body));

  // Stale version → conflict toast, reload.
  await act(async () => { oneByTestId(root, 'radio-quiet-none').props.onChange(); });
  conflictNext = true;
  const getsBefore = requests.filter((request) => request.method === 'GET').length;
  await press(oneByTestId(root, 'button-save-office-overrides'));
  check('409 → conflict toast and reload', String(lastToast()?.title) === 'Someone else saved first' && requests.filter((request) => request.method === 'GET').length > getsBefore);
}

console.log('office settings — HQ drill-in and read-only staff');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Support', authUser: { id: 'u-support' } });
  __setSupabaseSession('hq-token');
  __setScope({ providerId: 'prov-1', officeName: 'Riverside Wellness' });
  officeSettings = { ...officeFixture(), canEdit: false };
  requests.length = 0;
  const { root } = await render('/settings', <OfficeSettings />);
  const get = requests.find((request) => request.method === 'GET');
  check('HQ drill-in scopes the request by office', get !== undefined && get.url.includes('office=prov-1'), get?.url);
  check('read-only role: no Save, read-only marker, inputs disabled', byTestId(root, 'button-save-office-overrides').length === 0 && byTestId(root, 'override-read-only').length === 1 && oneByTestId(root, 'input-override-escalation-email').props.disabled === true);
  check('read-only role still sees the effective values', textOf(oneByTestId(root, 'effective-quiet-hours')) === '9:00 PM to 8:00 AM');

  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Admin', authUser: { id: 'u-admin' } });
  __setScope(null);
  requests.length = 0;
  const unscoped = await render('/settings', <OfficeSettings />);
  check('HQ without an office scope never calls the office endpoint nor shows demo data', requests.length === 0 && byTestId(unscoped.root, 'effective-quiet-hours').length === 0 && byTestId(unscoped.root, 'office-settings-unscoped').length === 1);
}

// ─── Inbox status filter ─────────────────────────────────────────────────────

console.log('live conversations — auto-close status');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Admin', authUser: { id: 'u-admin' } });
  __setSupabaseSession('hq-token');
  __setHqData({
    accounts: [{ id: 'acct-1', providerId: 'prov-1', officeName: 'Riverside Wellness', providerName: 'Dr. Test', providerRole: 'Owner', providerCode: 'TEST', status: 'active' }],
    findAccount: (id: string | undefined) => (id === 'acct-1' ? { id: 'acct-1', providerId: 'prov-1', officeName: 'Riverside Wellness', providerName: 'Dr. Test', providerRole: 'Owner', providerCode: 'TEST', status: 'active' } : undefined),
  });
  conversations = [{ id: 'c1', status: 'open' }, { id: 'c2', status: 'closed' }];
  requests.length = 0;
  const { root } = await render('/admin/conversations?account=acct-1', <Conversations />, '/admin/conversations');
  const first = requests.find((request) => request.url.includes('/api/office/conversations'));
  check('inbox asks for OPEN threads by default', first !== undefined && first.url.includes('status=open'), first?.url);
  check('open list hides the closed thread', textOf(root).includes('Patient c1') && !textOf(root).includes('Patient c2'));
  check('auto-close window is stated from the API', textOf(oneByTestId(root, 'text-auto-close-window')) === 'Closes after 14d quiet');
  await press(oneByTestId(root, 'filter-conversation-status-all'));
  const all = requests.filter((request) => request.url.includes('/api/office/conversations')).at(-1);
  check('All refetches with status=all', all !== undefined && all.url.includes('status=all'), all?.url);
  check('closed threads carry the Closed chip, open ones do not', byTestId(root, 'chip-conversation-closed-c2').length === 1 && byTestId(root, 'chip-conversation-closed-c1').length === 0);
  await press(oneByTestId(root, 'filter-conversation-status-closed'));
  check('Closed shows only the filed thread', !textOf(root).includes('Patient c1') && textOf(root).includes('Patient c2'));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll organization-policy checks passed.');
