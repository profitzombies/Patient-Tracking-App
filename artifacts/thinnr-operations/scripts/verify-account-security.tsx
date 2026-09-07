import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { readFileSync } from 'node:fs';
import { __setSession } from './a11y-stubs/session';
import { __setSession as setSupabaseSession } from './invite-stubs/supabase';
import Security from '../src/pages/Security';
import SecurityReport from '../src/pages/SecurityReport';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let failures = 0;
const check = (name: string, ok: boolean) => ok ? console.log(`  ok  ${name}`) : (failures++, console.error(`  FAIL ${name}`));
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : text(child as ReactTestInstance)).join('');
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4)); }); };
const fixture = {
  realm: 'staff', canChangePassword: false, contact: { phone: null, email: 's•••@x.com' }, passwordChangedAt: null, currentSessionKnown: true,
  signIns: [
    { id: 'signin-1', at: '2026-08-18T14:30:00Z', method: 'email_code', methodLabel: 'Emailed code', platform: 'web', device: 'Chrome on Mac', region: 'Austin, Texas, US', newDevice: true, current: true, active: true, revokedAt: null, revokedReason: null, reportedAt: null },
    { id: 'signin-2', at: '2026-08-12T09:10:00Z', method: 'email_code', methodLabel: 'Emailed code', platform: 'web', device: 'Safari on iPhone', region: null, newDevice: false, current: false, active: true, revokedAt: null, revokedReason: null, reportedAt: null },
  ],
  sessions: [{ ref: 'session-current1', createdAt: '2026-08-18T14:30:00Z', lastSeenAt: '2026-08-18T16:15:00Z', platform: 'web', device: 'Chrome on Mac', region: 'Austin, Texas, US', current: true, signInId: 'signin-1' }],
};
let responses: Array<[number, unknown]> = [];
const requests: Array<{ url: string; method: string; body: any }> = [];
(globalThis as any).fetch = async (input: string | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.url;
  requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
  const next = responses.shift();
  if (!next) throw new Error(`unexpected fetch ${url}`);
  return new Response(JSON.stringify(next[1]), { status: next[0], headers: { 'Content-Type': 'application/json' } });
};
async function render(element: React.ReactElement, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Router hook={memoryLocation({ path }).hook}>{element}</Router></QueryClientProvider>); });
  await settle();
  return renderer;
}
const buttonNamed = (root: ReactTestInstance, name: string) => root.findAll((node) => node.type === 'button' && text(node).includes(name))[0];
const click = async (node: ReactTestInstance) => { await act(async () => node.props.onClick?.({ preventDefault() {} })); await settle(); };

console.log('account security');
setSupabaseSession('staff-token');
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', signOut() {} });
responses = [[200, fixture]];
let view = await render(<Security />, '/security');
check('live sign-ins, sessions, Current and New device render', text(view.root).includes('Chrome on Mac') && text(view.root).includes('Safari on iPhone') && text(view.root).includes('Current') && text(view.root).includes('New device'));
responses = [[200, { ok: true }], [200, fixture]];
await click(buttonNamed(view.root, 'Sign out everywhere else'));
await click(view.root.findByProps({ 'data-testid': 'button-security-confirm' }));
check('sign out everywhere posts and refetches', requests.some((r) => r.url === '/api/security/me/sign-out-others' && r.method === 'POST') && requests.filter((r) => r.url === '/api/security/me').length === 2);
view.unmount();

let signedOut = false;
requests.length = 0;
responses = [[200, fixture]];
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', signOut() { signedOut = true; } });
view = await render(<Security />, '/security');
responses = [[200, { ok: true, signedOut: true, forcedReset: false }]];
await click(buttonNamed(view.root, "This wasn't me"));
await click(view.root.findByProps({ 'data-testid': 'button-security-confirm' }));
check("this wasn't me reports then signs out locally", requests.some((r) => r.url.endsWith('/sign-ins/signin-1/report')) && signedOut);
view.unmount();

requests.length = 0;
__setSession({ authStatus: 'signed-out', authRole: null, signOut() {} });
view = await render(<Security />, '/security');
check('demo is deterministic read-only preview', text(view.root).includes('Preview — sign in to manage your real account') && view.root.findByProps({ 'data-testid': 'button-sign-out-others' }).props.disabled && requests.length === 0);
view.unmount();

responses = [[200, { ok: true, signedOut: true, realm: 'staff', forcedReset: false }]];
view = await render(<SecurityReport />, '/security/report?token=abc123');
check('public report does nothing on open', !requests.some((r) => r.url === '/api/security/report'));
await click(view.root.findByProps({ 'data-testid': 'button-security-report-confirm' }));
check('public report posts token on confirm and shows success', requests.some((r) => r.url === '/api/security/report' && r.body?.token === 'abc123') && text(view.root).includes('Every session on that account has been signed out.'));
view.unmount();
responses = [[400, { error: 'That security link has expired.' }]];
view = await render(<SecurityReport />, '/security/report?token=expired');
await click(view.root.findByProps({ 'data-testid': 'button-security-report-confirm' }));
check('public report shows server error', text(view.root).includes('That security link has expired.'));
view.unmount();

const teamSource = readFileSync(new URL('../src/pages/OfficeTeam.tsx', import.meta.url), 'utf8');
const patientSource = readFileSync(new URL('../src/pages/PatientDetail.tsx', import.meta.url), 'utf8');
const sessionSource = readFileSync(new URL('../src/contexts/session.tsx', import.meta.url), 'utf8');
const hqTeamSource = readFileSync(new URL('../src/pages/admin/Team.tsx', import.meta.url), 'utf8');
check('HQ team panel shares the managed sessions view and sends reason', hqTeamSource.includes('fetchHqTeamMemberSessions') && hqTeamSource.includes('signOutHqTeamMember(sessionMember!.id, signOutReason)') && hqTeamSource.includes("from '@/components/team/ManagedSessions'") && teamSource.includes("from '@/components/team/ManagedSessions'"));
check('office team panel and reason are wired', teamSource.includes('fetchOfficeTeamMemberSessions') && teamSource.includes("signOutTeammate(member.id, liveOffice, signOutReason)"));
check('HQ patient card is gated and sends reason', patientSource.includes('{isHq && (') && patientSource.includes('signOutPatientSessions(id, office!, securityReason)'));
check('staff verification sends stable device headers and attaches sign-in', sessionSource.includes("'x-thinnr-device': getOrCreateDeviceId()") && sessionSource.includes("'x-thinnr-platform': 'web'") && sessionSource.includes('/api/security/me/attach'));

console.log(failures ? `\n${failures} account security check(s) failed.` : '\nAll account security checks passed.');
process.exit(failures ? 1 : 0);