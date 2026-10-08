/**
 * HQ Team invitations and removal — regression for the invite lifecycle.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:hq-team
 *
 * Renders the REAL HQ Team page (inside the REAL hq-data provider, so the
 * real lib/hq-team client does the talking) and the REAL HQ setup page under
 * react-test-renderer against a scripted global fetch, and checks:
 *
 *   - pending invitations show their expiry date and offer Resend / Cancel,
 *     while active teammates offer Remove instead;
 *   - a duplicate-record refusal, a database refusal, and a delivery failure
 *     each land in the invite dialog in their own words, not one toast;
 *   - a collision with a stalled HQ invitation offers to re-send it, and
 *     that button posts to the resend endpoint;
 *   - Resend and Cancel post to their endpoints and report the outcome;
 *   - a removal refusal stays in the confirmation dialog, and a removal
 *     whose session logout failed says so;
 *   - the setup page greets a live invitation by name, role and invited
 *     email and drives the passwordless flow, while used / cancelled /
 *     expired / unrecognised / unreachable tokens each get their own state.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { __getToastStateForTests, __resetToastStoreForTests } from '../src/hooks/use-toast';
import { registerReauthHandler } from '../src/lib/reauth';
import { HqDataProvider } from '../src/contexts/hq-data';
import Team from '../src/pages/admin/Team';
import HqSetup from '../src/pages/HqSetup';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.sessionStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const rawConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
  rawConsoleError(...args);
};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; rawConsoleError(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const ACTIVE_MEMBER = {
  id: 'hq-admin-1', authUserId: 'auth-admin-1', name: 'Dana Admin', email: 'dana@thinnr.example',
  title: 'Operations lead', role: 'admin', status: 'active', invitedAt: '2026-08-01T12:00:00Z',
  joinedAt: '2026-08-03T12:00:00Z', invitationExpiresAt: null, secondFactorPhone: null,
};
const INVITED_MEMBER = {
  id: 'hq-support-2', authUserId: null, name: 'Ingrid Invited', email: 'ingrid@thinnr.example',
  title: '', role: 'support', status: 'invited', invitedAt: '2026-09-20T12:00:00Z',
  joinedAt: null, invitationExpiresAt: '2026-09-27T12:00:00Z', secondFactorPhone: null,
};
const roster = (members: unknown[] = [ACTIVE_MEMBER, INVITED_MEMBER]) => ({ members });

// ─── Scripted fetch ──────────────────────────────────────────────────────────

interface Recorded { method: string; url: string; body: any }
let requests: Recorded[] = [];
let responses: Array<() => Response> = [];
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const boom = () => { throw new Error('network down'); };

/**
 * Requests the suite does not script: the roster the page opens with, and the
 * provider-account list the HQ provider loads alongside it. Only the calls
 * under test come out of the scripted queue, so an extra background read
 * cannot shift every later response by one.
 */
let rosterBody: unknown = roster();
function ambient(method: string, url: string): Response | null {
  if (method === 'GET' && url.startsWith('/api/hq-team')) {
    return new Response(JSON.stringify(rosterBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (method === 'GET' && url.startsWith('/api/provider-accounts')) {
    return new Response(JSON.stringify({ accounts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return null;
}

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
  const background = ambient(method, url);
  if (background) return background;
  const next = responses.shift();
  if (!next) throw new Error(`unexpected fetch ${method} ${url}`);
  return next();
};

// ─── Render helpers ──────────────────────────────────────────────────────────

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
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

const byTestId = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => {
  const all = byTestId(root, id);
  if (all.length !== 1) throw new Error(`expected exactly one ${id}, found ${all.length}`);
  return all[0];
};
const maybe = (root: ReactTestInstance, id: string) => byTestId(root, id)[0];
const click = async (node: ReactTestInstance) => {
  await act(async () => {
    if (typeof node.props.onClick === 'function') { node.props.onClick({ preventDefault() {} }); return; }
    let cursor: ReactTestInstance | null = node.parent;
    while (cursor && cursor.type !== 'form') cursor = cursor.parent;
    if (!cursor) throw new Error('button has no onClick and no enclosing form');
    cursor.props.onSubmit({ preventDefault() {} });
  });
  await settle();
};
const type = async (node: ReactTestInstance, value: string) => {
  await act(async () => { node.props.onChange({ target: { value } }); });
};
const toastText = () => {
  const toast = __getToastStateForTests().toasts[0];
  return toast ? `${String(toast.title ?? '')} | ${String(toast.description ?? '')}` : '';
};

function signedInAsHqAdmin() {
  requests = [];
  responses = [];
  __resetToastStoreForTests();
  rosterBody = roster();
  __setSupabaseSession('hq-token');
  __setSession({
    authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Admin',
    authUser: { id: 'auth-admin-1' }, supabaseEnabled: true,
  });
}

async function renderTeam(): Promise<{ renderer: ReactTestRenderer; root: ReactTestInstance }> {
  const loc = memoryLocation({ path: '/admin/team', record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={loc.hook}>
          <HqDataProvider><Team /></HqDataProvider>
        </Router>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root };
}

/** Open the invite dialog with a filled-in form, ready to submit. */
async function openInvite(root: ReactTestInstance) {
  await click(one(root, 'button-invite'));
  await type(one(root, 'input-invite-name'), 'Nina Newhire');
  await type(one(root, 'input-invite-email'), 'nina@thinnr.example');
}

// ─── Roster ──────────────────────────────────────────────────────────────────

console.log('hq team: roster');
{
  signedInAsHqAdmin();
  const { root, renderer } = await renderTeam();
  const invitedRow = textOf(one(root, `text-joined-${INVITED_MEMBER.id}`));
  check('pending invitation shows its expiry date',
    invitedRow.includes('Invitation pending') && invitedRow.includes('Sep 27, 2026'), invitedRow);
  check('pending invitation offers resend and cancel, not remove',
    Boolean(maybe(root, `button-resend-${INVITED_MEMBER.id}`)) &&
    Boolean(maybe(root, `button-cancel-invite-${INVITED_MEMBER.id}`)) &&
    !maybe(root, `button-remove-${INVITED_MEMBER.id}`));
  check('active teammate offers remove, not invitation actions',
    Boolean(maybe(root, `button-remove-${ACTIVE_MEMBER.id}`)) &&
    !maybe(root, `button-resend-${ACTIVE_MEMBER.id}`));
  renderer.unmount();
}

// ─── Invite failures ─────────────────────────────────────────────────────────

console.log('hq team: invite failures name their cause');
{
  signedInAsHqAdmin();
  responses = [json(409, { error: 'That email already belongs to a provider staff account at Beacon Hill Aesthetics.' })];
  const { root, renderer } = await renderTeam();
  await openInvite(root);
  await click(one(root, 'button-invite-submit'));
  check('duplicate record names the record holding the email',
    textOf(one(root, 'text-invite-error')).includes('provider staff account'),
    textOf(one(root, 'text-invite-error')));
  check('duplicate keeps the dialog open with no resend offer', !maybe(root, 'button-invite-resend'));
  renderer.unmount();
}

{
  signedInAsHqAdmin();
  responses = [json(409, { error: 'hq_invite_team_member: the invitation expiry cannot exceed seven days', source: 'database' })];
  const { root, renderer } = await renderTeam();
  await openInvite(root);
  await click(one(root, 'button-invite-submit'));
  check('database refusal passes its own words through',
    textOf(one(root, 'text-invite-error')).includes('cannot exceed seven days'));
  renderer.unmount();
}

{
  signedInAsHqAdmin();
  responses = [json(200, { member: { ...INVITED_MEMBER, id: 'hq-new-3', name: 'Nina Newhire', email: 'nina@thinnr.example' }, invitation: 'failed' })];
  const { root, renderer } = await renderTeam();
  await openInvite(root);
  await click(one(root, 'button-invite-submit'));
  const delivery = textOf(one(root, 'text-invite-error'));
  check('delivery failure says the member exists but the email did not go out',
    delivery.includes('was added') && delivery.includes('email provider refused'), delivery);
  renderer.unmount();
}

console.log('hq team: a stalled invitation can be re-sent');
{
  signedInAsHqAdmin();
  responses = [
    json(409, {
      error: 'Ingrid Invited already has a pending HQ invitation at that address.',
      resendable: { memberId: INVITED_MEMBER.id, name: 'Ingrid Invited', state: 'pending' },
    }),
    json(200, { member: { ...INVITED_MEMBER, invitationExpiresAt: '2026-10-04T12:00:00Z' }, invitation: 'sent' }),
  ];
  const { root, renderer } = await renderTeam();
  await openInvite(root);
  await click(one(root, 'button-invite-submit'));
  check('stalled HQ collision offers to re-send instead of refusing',
    Boolean(maybe(root, 'button-invite-resend')) &&
    textOf(one(root, 'text-invite-error')).includes('pending HQ invitation'));
  await click(one(root, 'button-invite-resend'));
  const resent = requests[requests.length - 1];
  check('the offer posts to the resend endpoint',
    resent.method === 'POST' && resent.url === `/api/hq-team/${INVITED_MEMBER.id}/invitations/resend`, resent.url);
  check('a re-sent invitation closes the dialog and confirms', !maybe(root, 'text-invite-error') && toastText().includes('New invitation sent'));
  renderer.unmount();
}

// ─── Roster invitation actions ───────────────────────────────────────────────

console.log('hq team: roster invitation actions');
{
  signedInAsHqAdmin();
  responses = [json(200, { member: { ...INVITED_MEMBER, invitationExpiresAt: '2026-10-04T12:00:00Z' }, invitation: 'sent' })];
  const { root, renderer } = await renderTeam();
  await click(one(root, `button-resend-${INVITED_MEMBER.id}`));
  check('resend posts and refreshes the expiry on the roster',
    requests.some((entry) => entry.url === `/api/hq-team/${INVITED_MEMBER.id}/invitations/resend`) &&
    textOf(one(root, `text-joined-${INVITED_MEMBER.id}`)).includes('Oct 4, 2026'),
    textOf(one(root, `text-joined-${INVITED_MEMBER.id}`)));
  renderer.unmount();
}

{
  signedInAsHqAdmin();
  responses = [json(200, { member: INVITED_MEMBER, invitation: 'not_configured' })];
  const { root, renderer } = await renderTeam();
  await click(one(root, `button-resend-${INVITED_MEMBER.id}`));
  check('a resend whose email failed says so', toastText().includes('not configured'), toastText());
  renderer.unmount();
}

{
  signedInAsHqAdmin();
  responses = [json(200, { ok: true })];
  const { root, renderer } = await renderTeam();
  rosterBody = roster([ACTIVE_MEMBER]);
  await click(one(root, `button-cancel-invite-${INVITED_MEMBER.id}`));
  await click(one(root, 'button-cancel-invite-confirm'));
  check('cancel posts to the cancel endpoint and drops the row',
    requests.some((entry) => entry.url === `/api/hq-team/${INVITED_MEMBER.id}/invitations/cancel`) &&
    !maybe(root, `row-team-${INVITED_MEMBER.id}`));
  check('cancel confirms in plain words', toastText().includes('invitation cancelled'), toastText());
  renderer.unmount();
}

// ─── Removal ─────────────────────────────────────────────────────────────────

console.log('hq team: removal explains itself');
{
  signedInAsHqAdmin();
  responses = [
    json(409, { error: 'The sole Super Admin cannot be removed or demoted.' }),
  ];
  const { root, renderer } = await renderTeam();
  await click(one(root, `button-remove-${ACTIVE_MEMBER.id}`));
  await click(one(root, 'button-remove-confirm'));
  check('a refusal stays in the confirmation dialog in the server\'s words',
    Boolean(maybe(root, 'text-remove-error')) &&
    textOf(one(root, 'text-remove-error')).includes('sole Super Admin'));
  renderer.unmount();
}

{
  signedInAsHqAdmin();
  responses = [json(200, { revoked: true, sessionInvalidation: 'failed' })];
  const { root, renderer } = await renderTeam();
  rosterBody = roster([INVITED_MEMBER]);
  await click(one(root, `button-remove-${ACTIVE_MEMBER.id}`));
  await click(one(root, 'button-remove-confirm'));
  check('a revoked member whose devices stayed signed in is reported',
    toastText().includes('were not signed out'), toastText());
  check('the removed row leaves the roster anyway', !maybe(root, `row-team-${ACTIVE_MEMBER.id}`));
  renderer.unmount();
}

{
  signedInAsHqAdmin();
  responses = [json(200, { revoked: true, sessionInvalidation: 'complete' })];
  const { root, renderer } = await renderTeam();
  await click(one(root, `button-remove-${ACTIVE_MEMBER.id}`));
  await click(one(root, 'button-remove-confirm'));
  check('a clean removal says access and sessions are gone',
    toastText().includes('removed') && toastText().includes('sessions ended'), toastText());
  renderer.unmount();
}

{
  signedInAsHqAdmin();
  // The server asks for a fresh code first; the sheet answers, and the
  // removal must go again by itself rather than stranding the administrator.
  let prompted = 0;
  const release = registerReauthHandler(async () => { prompted += 1; return true; });
  responses = [
    json(401, { code: 'reauth_required', error: "Confirm it's you with a fresh code to continue." }),
    json(200, { revoked: true, sessionInvalidation: 'complete' }),
  ];
  const { root, renderer } = await renderTeam();
  rosterBody = roster([INVITED_MEMBER]);
  await click(one(root, `button-remove-${ACTIVE_MEMBER.id}`));
  await click(one(root, 'button-remove-confirm'));
  const removals = requests.filter((entry) => entry.method === 'DELETE' || entry.url.endsWith(`/api/hq-team/${ACTIVE_MEMBER.id}`));
  check('a fresh-code challenge opens the sheet and the removal retries after it',
    prompted === 1 && removals.length === 2 && toastText().includes('removed'),
    `prompted=${prompted} removals=${removals.length} toast=${toastText()}`);
  release();
  renderer.unmount();
}

{
  signedInAsHqAdmin();
  // Sheet dismissed: the removal stops and says what is still needed.
  const release = registerReauthHandler(async () => false);
  responses = [json(401, { code: 'reauth_required', error: "Confirm it's you with a fresh code to continue." })];
  const { root, renderer } = await renderTeam();
  await click(one(root, `button-remove-${ACTIVE_MEMBER.id}`));
  await click(one(root, 'button-remove-confirm'));
  check('a dismissed fresh-code sheet leaves the reason in the dialog',
    Boolean(maybe(root, 'text-remove-error')) &&
    textOf(one(root, 'text-remove-error')).toLowerCase().includes('fresh code'),
    textOf(maybe(root, 'text-remove-error') ?? root).slice(0, 120));
  release();
  renderer.unmount();
}

// ─── Setup page ──────────────────────────────────────────────────────────────

const SIGN_IN_STUB = {
  authStatus: 'signed-out', authRole: null, authUser: null, supabaseEnabled: true,
  requestStaffCode: async () => ({ requestId: 'email-request', message: null, devCode: null, error: null }),
  verifyStaffCode: async () => ({ error: null, secondFactor: null }),
  startStaffPhoneStep: async () => ({ error: null, requestId: 'sms-request', destination: null, devCode: null }),
  verifyStaffPhoneCode: async () => ({ error: null }),
};

async function renderSetup(token = 'setup-token'): Promise<{ renderer: ReactTestRenderer; root: ReactTestInstance }> {
  const loc = memoryLocation({ path: `/hq-setup?token=${token}`, record: true });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<Router hook={loc.hook}><HqSetup /></Router>);
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root };
}

console.log('hq setup page');
{
  requests = [];
  __resetToastStoreForTests();
  __setSession(SIGN_IN_STUB);
  const codeRequests: string[] = [];
  __setSession({ ...SIGN_IN_STUB, requestStaffCode: async (address: string) => {
    codeRequests.push(address);
    return { requestId: 'email-request', message: null, devCode: null, error: null };
  } });
  responses = [json(200, {
    state: 'pending', name: 'Ingrid Invited', email: 'ingrid@thinnr.example',
    role: 'support', title: 'Support specialist', expiresAt: '2026-09-27T12:00:00Z',
  })];
  const { root, renderer } = await renderSetup();
  check('the lookup posts the token, unauthenticated',
    requests[0].method === 'POST' && requests[0].url === '/api/hq-team/invitation/lookup' &&
    requests[0].body.token === 'setup-token');
  check('a live invitation greets by name, role and invited email',
    textOf(one(root, 'text-setup-greeting')).includes('Ingrid Invited') &&
    textOf(one(root, 'text-setup-role')) === 'Support' &&
    textOf(one(root, 'text-setup-email')) === 'ingrid@thinnr.example');
  await click(one(root, 'button-setup-send-code'));
  check('the code goes to the invited address, not a typed one',
    codeRequests.length === 1 && codeRequests[0] === 'ingrid@thinnr.example', codeRequests.join());
  check('the code step takes over after the email is sent', Boolean(maybe(root, 'input-setup-otp')));
  renderer.unmount();
}

for (const [state, expected] of [
  ['used', 'already been used'],
  ['cancelled', 'was cancelled'],
  ['expired', 'has expired'],
  ['unknown', 'isn’t valid'],
] as const) {
  requests = [];
  __setSession(SIGN_IN_STUB);
  responses = [json(200, { state })];
  const { root, renderer } = await renderSetup();
  const shown = textOf(root);
  check(`a ${state} token gets its own message and tells them to ask for a resend`,
    shown.includes(expected) && /resend|sign-in page/i.test(shown), shown.slice(0, 140));
  check(`a ${state} token offers no sign-in form`, !maybe(root, 'button-setup-send-code'));
  renderer.unmount();
}

{
  requests = [];
  __setSession(SIGN_IN_STUB);
  responses = [boom];
  const { root, renderer } = await renderSetup();
  check('an unreachable lookup says so instead of claiming the link is dead',
    textOf(one(root, 'text-setup-dead-end')).includes('couldn’t check'));
  renderer.unmount();
}

{
  requests = [];
  __setSession(SIGN_IN_STUB);
  responses = [];
  const loc = memoryLocation({ path: '/hq-setup', record: true });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => { renderer = create(<Router hook={loc.hook}><HqSetup /></Router>); });
  await settle();
  check('a link with no token never calls the lookup',
    requests.length === 0 && textOf(one(renderer!.root, 'text-setup-dead-end')).includes('isn’t valid'));
  renderer!.unmount();
}

if (failures > 0) {
  rawConsoleError(`\n${failures} HQ team check(s) failed.`);
  process.exit(1);
}
console.log('\nAll HQ team invitation checks passed.');
