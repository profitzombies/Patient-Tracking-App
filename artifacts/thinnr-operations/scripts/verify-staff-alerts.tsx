import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { AttentionBell } from '../src/components/office/AttentionBell';
import OfficeAlerts from '../src/pages/OfficeAlerts';
import { PatientAlertsCard } from '../src/pages/OfficeSettings';
import {
  OfficeApiError,
} from '../src/lib/office-api';
import {
  updateOfficeAlertSettings,
  type OfficeAlertSettings,
} from '../src/lib/office-alerts-api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.getSelection ??= () => ({ toString: () => '' });
const sessionValues = new Map<string, string>();
g.window.sessionStorage ??= {
  getItem: (key: string) => sessionValues.get(key) ?? null,
  setItem: (key: string, value: string) => sessionValues.set(key, value),
  removeItem: (key: string) => sessionValues.delete(key),
  clear: () => sessionValues.clear(),
};
g.window.dispatchEvent ??= () => true;

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => ok ? console.log(`  ok  ${name}`) : (failures += 1, console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`));
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : text(child as ReactTestInstance)).join('');
const one = (root: ReactTestInstance, id: string) => root.find((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const maybe = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string')[0];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const requests: Array<{ url: string; method: string; body: unknown }> = [];
let responses: Response[] = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : null });
  const response = responses.shift();
  if (!response) throw new Error(`Unexpected fetch: ${url}`);
  return response;
};
const settle = async () => { for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2)); }); };
async function render(node: React.ReactElement, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Router hook={memoryLocation({ path }).hook}>{node}</Router></QueryClientProvider>); });
  await settle();
  return renderer;
}

console.log('staff alerts: bell');
{
  sessionValues.clear();
  requests.length = 0;
  __setScope(null);
  __setSupabaseSession('staff-token');
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' } });
  const item = { patientId: 'pat-1', name: 'Ava Patient', reasons: [{ code: 'no_weight', label: 'No weight logged', days: 8 }], signature: 'no_weight', seen: false };
  responses = [json(200, { asOf: '2026-08-22', count: 1, total: 1, items: [item] })];
  const renderer = await render(<AttentionBell />);
  check('badge count and fetched patient render', text(one(renderer.root, 'badge-attention-count')) === '1' && text(one(renderer.root, 'attention-item-pat-1')).includes('Ava Patient'));
  responses = [json(200, { ok: true, count: 0 }), json(200, { asOf: '2026-08-22', count: 0, total: 1, items: [{ ...item, seen: true }] })];
  await act(async () => { one(renderer.root, 'button-mark-seen-pat-1').props.onClick(); });
  await settle();
  check('mark seen posts signature and drops badge', requests.some((request) => request.method === 'POST' && request.url === '/api/office/alerts/pat-1/seen' && (request.body as any).signature === 'no_weight') && !maybe(renderer.root, 'badge-attention-count'));
  renderer.unmount();
}

console.log('\nstaff alerts: demo seen persistence');
{
  sessionValues.clear();
  __setScope(null);
  __setSupabaseSession(null);
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null });
  const first = await render(<AttentionBell />);
  const initial = Number(text(one(first.root, 'badge-attention-count')));
  const mark = first.root.findAll((node) => String(node.props['data-testid'] ?? '').startsWith('button-mark-seen-'))[0];
  await act(async () => { mark.props.onClick(); });
  const reduced = Number(text(one(first.root, 'badge-attention-count')));
  await act(async () => { first.unmount(); });
  const remounted = await render(<AttentionBell />);
  check('demo mark-seen survives bell remount in session storage', reduced === initial - 1 && Number(text(one(remounted.root, 'badge-attention-count'))) === reduced);
  await act(async () => { remounted.unmount(); });
}

console.log('\nstaff alerts: digest demo');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null });
  __setSupabaseSession(null);
  const renderer = await render(<OfficeAlerts />, '/alerts');
  const before = (one(renderer.root, 'select-digest-date').props as any).value;
  check('digest groups patients by reason', renderer.root.findAll((node) => String(node.props['data-testid'] ?? '').startsWith('digest-')).length > 0);
  await act(async () => { one(renderer.root, 'button-digest-older').props.onClick(); });
  check('older-day button changes selected date', (one(renderer.root, 'select-digest-date').props as any).value !== before);
  renderer.unmount();
}

console.log('\nstaff alerts: chat flags demo');
{
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null });
  __setSupabaseSession(null);
  const renderer = await render(<OfficeAlerts />, '/alerts');
  const open = one(renderer.root, 'chat-flags-open');
  check('demo shows one sample flag with a category chip and an Open chat link', open.children.length === 1 && text(one(renderer.root, 'chat-flag-category-demo-chat-flag-1')) === 'Medication problem' && String(one(renderer.root, 'button-open-chat-demo-chat-flag-1').props.href).startsWith('/patients/'));
  await act(async () => { one(renderer.root, 'button-review-chat-demo-chat-flag-1').props.onClick(); });
  check('demo mark reviewed moves the flag under Recently reviewed', !maybe(renderer.root, 'button-review-chat-demo-chat-flag-1') && Boolean(maybe(renderer.root, 'chat-flags-reviewed')));
  renderer.unmount();
}

console.log('\nstaff alerts: chat flags live');
{
  requests.length = 0;
  __setScope(null);
  __setSupabaseSession('staff-token');
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' } });
  const flag = { id: 'flag-9', patientId: 'pat-7', patientName: 'Ava Patient', conversationId: 'conv-3', category: 'self_harm', categoryLabel: 'Thoughts of self-harm', reason: 'Expressed a wish to not wake up.', messageExcerpt: 'I wish I would not wake up', status: 'open', createdAt: '2026-08-22T15:00:00Z', reviewedAt: null, reviewedByName: null };
  // The page fetches the digest list and the flags; order is not fixed, so answer by URL.
  const byUrl = (url: string) => url.includes('/alerts/chat-flags') ? json(200, { openCount: 1, items: [flag] }) : json(200, { dates: ['2026-08-22'], latestDate: '2026-08-22', digest: { digestDate: '2026-08-22', generatedAt: '2026-08-22T12:00:00Z', timeZone: 'UTC', flaggedCount: 0, items: [] } });
  const previous = g.fetch;
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: null });
    if (url.includes('/reviewed')) return json(200, { ...flag, status: 'reviewed', reviewedAt: '2026-08-22T16:00:00Z', reviewedByName: 'Staff' });
    return byUrl(url);
  };
  const renderer = await render(<OfficeAlerts />, '/alerts');
  check('live flag renders the reason and excerpt and links to the transcript', text(one(renderer.root, 'chat-flag-flag-9')).includes('wake up') && one(renderer.root, 'button-open-chat-flag-9').props.href === '/patients/pat-7?coach=conv-3');
  check('flags are fetched with status=all', requests.some((request) => request.url === '/api/office/alerts/chat-flags?status=all'));
  await act(async () => { one(renderer.root, 'button-review-chat-flag-9').props.onClick(); });
  await settle();
  check('mark reviewed posts to the flag', requests.some((request) => request.method === 'POST' && request.url === '/api/office/alerts/chat-flags/flag-9/reviewed'));
  renderer.unmount();

  // The alert email lands on /alerts?chat=<flagId>; once flags load the page
  // jumps to the patient's record with the transcript open.
  const location = memoryLocation({ path: '/alerts?chat=flag-9', record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let linked!: ReactTestRenderer;
  await act(async () => { linked = create(<QueryClientProvider client={client}><Router hook={location.hook} searchHook={location.searchHook}><OfficeAlerts /></Router></QueryClientProvider>); });
  await settle();
  check('email deep link opens the flagged patient record', location.history.at(-1) === '/patients/pat-7?coach=conv-3');
  linked.unmount();

  // HQ drill-in may read but never review.
  __setScope({ providerId: 'office-1' } as any);
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' } });
  const hq = await render(<OfficeAlerts />, '/alerts');
  check('HQ sees the flag without a Mark reviewed button', Boolean(maybe(hq.root, 'chat-flag-flag-9')) && !maybe(hq.root, 'button-review-chat-flag-9'));
  hq.unmount();
  g.fetch = previous;
  __setScope(null);
}

console.log('\nstaff alerts: settings contract');
{
  __setSupabaseSession('staff-token');
  requests.length = 0;
  const body = { expectedVersion: 7, recipientMode: 'selected' as const, recipientMemberIds: ['owner', 'tm-2'], sendTime: '09:15', timeZone: null };
  responses = [json(200, { version: 8 })];
  await updateOfficeAlertSettings(body);
  check('settings PUT sends exact versioned body', requests[0]?.method === 'PUT' && requests[0]?.url === '/api/office/alerts/settings' && JSON.stringify(requests[0].body) === JSON.stringify(body));
  responses = [json(409, { error: 'Settings changed.' })];
  let conflict = false;
  try { await updateOfficeAlertSettings(body); } catch (error) { conflict = error instanceof OfficeApiError && error.isConflict; }
  check('409 is exposed as an OfficeApiError conflict', conflict);

  const staffSettings: OfficeAlertSettings = {
    recipientMode: 'all', recipientMemberIds: [], sendTime: '08:00', timeZone: 'America/New_York', timeZoneSource: 'office', version: 2, canEdit: false,
    me: { emailEnabled: true, pushEnabled: false, email: 'staff@example.com' },
    team: [{ id: 'owner', name: 'Owner', role: 'owner', status: 'active' }],
  };
  const renderer = await render(<PatientAlertsCard data={staffSettings} demo={false} preferenceReadOnly={false} saving={false} onSave={() => {}} onPreference={() => {}} />);
  check('staff sees read-only office values', Boolean(maybe(renderer.root, 'alert-settings-read-only')) && one(renderer.root, 'input-alert-send-time').props.disabled === true);
  check('staff can still change own email and push switches', one(renderer.root, 'switch-alert-emailEnabled').props.disabled === false && one(renderer.root, 'switch-alert-pushEnabled').props.disabled === false);
  renderer.unmount();
}

console.log(failures ? `\n${failures} staff alert check(s) failed.` : '\nAll staff alert checks passed.');
process.exit(failures ? 1 : 0);