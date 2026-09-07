/**
 * Office Team page — self-service staff administration regression.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:office-team
 *
 * Renders the REAL OfficeTeam page under react-test-renderer (session /
 * scope contexts and the three document-bound Radix primitives stubbed via
 * tsconfig.office-admin.json, global fetch scripted) and checks:
 *
 *   - the guided demo (signed-out) renders the demo notice and never calls
 *     the live endpoint; a resolving session shows the loading state;
 *   - an owner sees the account holder plus every teammate with role and
 *     status chips, invited/joined dates, and per-row actions — except the
 *     owner's own row, which is locked as "Your login";
 *   - an admin cannot touch owner rows (locked "Owner") and the role picker
 *     offers no Owner option; a staff-role teammate gets the server's 403
 *     notice as a permission state, not an error state;
 *   - invite validates locally (no request on blank fields), then POSTs the
 *     trimmed body and closes; a server field error lands on that field;
 *   - change role PATCHes {role}; Save is disabled while the role is
 *     unchanged;
 *   - deactivate / reactivate / sign-out confirm first, POST the right
 *     verb, and the toast explains the session outcome (complete vs failed);
 *   - a last-owner 409 from the server surfaces as a destructive toast with
 *     the server's own words; the HQ drill-in appends ?office=<id>.
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
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { __getToastStateForTests, __resetToastStoreForTests } from '../src/hooks/use-toast';
import type { OfficeTeam, OfficeTeamMember } from '../src/lib/office-team';
import OfficeTeamPage from '../src/pages/OfficeTeam';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};

// Query/mutation settling happens across timers the suite drives by hand;
// React's act() advisory for those async ticks is noise here, not a defect.
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

function member(id: string, name: string, overrides: Partial<OfficeTeamMember> = {}): OfficeTeamMember {
  return {
    id, name, email: `${id}@beaconhill.example`, role: 'staff', status: 'active',
    invitedAt: '2026-08-01T15:00:00Z', claimedAt: '2026-08-02T09:30:00Z', isSelf: false, ...overrides,
  };
}

const MEMBERS: OfficeTeamMember[] = [
  member('tm-owner', 'Olivia Owner', { role: 'owner', isSelf: true }),
  member('tm-admin', 'Adam Admin', { role: 'admin' }),
  member('tm-staff', 'Sam Staff', { role: 'staff' }),
  member('tm-invited', 'Ivy Invited', { status: 'invited', claimedAt: null }),
  member('tm-disabled', 'Dee Disabled', { status: 'disabled' }),
];

function teamAs(role: 'owner' | 'admin', selfId: string): OfficeTeam {
  return {
    office: { id: 'office-1', name: 'Beacon Hill Aesthetics' },
    me: { role, kind: 'team_member', teamMemberId: selfId },
    accountOwner: { name: 'Dr. Priya Raman', email: 'priya@beaconhill.example', status: 'active' },
    members: MEMBERS.map((m) => ({ ...m, isSelf: m.id === selfId })),
  };
}

// ─── Scripted fetch ──────────────────────────────────────────────────────────

interface Recorded { method: string; url: string; body: unknown; auth: string | null }
const requests: Recorded[] = [];
let responses: Array<() => Response> = [];
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get('authorization') });
  const next = responses.shift();
  if (!next) throw new Error(`unexpected fetch ${url}`);
  return next();
};

// ─── Render helpers ──────────────────────────────────────────────────────────

interface Rendered { renderer: ReactTestRenderer; root: ReactTestInstance }

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function renderTeam(): Promise<Rendered> {
  const loc = memoryLocation({ path: '/team', record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={loc.hook}>
          <OfficeTeamPage />
        </Router>
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
const click = async (node: ReactTestInstance) => {
  await act(async () => {
    if (typeof node.props.onClick === 'function') { node.props.onClick({ preventDefault() {} }); return; }
    // A submit button: fire the enclosing form's onSubmit, as a browser would.
    let cursor: ReactTestInstance | null = node.parent;
    while (cursor && cursor.type !== 'form') cursor = cursor.parent;
    if (!cursor) throw new Error('button has no onClick and no enclosing form');
    cursor.props.onSubmit({ preventDefault() {} });
  });
  await settle();
};
const type = async (node: ReactTestInstance, value: string) => { await act(async () => { node.props.onChange({ target: { value } }); }); };
const pickOption = async (root: ReactTestInstance, value: string) => {
  const option = root.find((node) => node.props.role === 'option' && node.props['data-value'] === value);
  await act(async () => { option.props.onClick(); });
};
const lastToast = () => { const toasts = __getToastStateForTests().toasts; return toasts[0]; };
const toastText = () => { const t = lastToast(); return t ? `${String(t.title ?? '')} | ${String(t.description ?? '')}` : ''; };

function reset(status: 'signed-in' | 'signed-out' | 'loading' = 'signed-in') {
  requests.length = 0;
  responses = [];
  __resetToastStoreForTests();
  __setScope(null);
  __setSupabaseSession(status === 'signed-in' ? 'staff-token' : null);
  __setSession(status === 'signed-in'
    ? { authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'auth-owner' } }
    : { authStatus: status, authRole: null, authUser: null });
}

// ─── Persona states ──────────────────────────────────────────────────────────

console.log('office team: persona states');
{
  reset('signed-out');
  const { root, renderer } = await renderTeam();
  check('demo persona: demo notice, no invite button, no request', Boolean(maybe(root, 'status-team-demo')) && !maybe(root, 'button-invite') && requests.length === 0);
  renderer.unmount();

  reset('loading');
  const loading = await renderTeam();
  check('resolving session: loading state, no request', Boolean(maybe(loading.root, 'status-team-loading')) && requests.length === 0);
  loading.renderer.unmount();

  reset();
  responses = [json(403, { error: 'Only office owners and admins can manage the team.' })];
  const staff = await renderTeam();
  const notice = maybe(staff.root, 'status-team-unauthorized');
  check('staff-role teammate: 403 lands as a permission notice with the server text', Boolean(notice) && textOf(notice!).includes('Only office owners and admins') && !maybe(staff.root, 'status-team-error') && !maybe(staff.root, 'button-invite'), notice ? textOf(notice) : 'no notice');
  check('staff-role teammate: the request carried the bearer and no office id', requests.length === 1 && requests[0].auth === 'Bearer staff-token' && requests[0].url === '/api/office/team', JSON.stringify(requests));
  staff.renderer.unmount();

  reset();
  const outage = json(502, { error: 'Could not load the team right now.' });
  responses = [outage, outage, outage];
  const broken = await renderTeam();
  // Non-permission failures retry twice (1s + 2s back-off) before settling.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3400)); });
  await settle();
  const errorBox = maybe(broken.root, 'status-team-error');
  check('server error: retried twice, then error state with the server message and a retry button', requests.length === 3 && Boolean(errorBox) && textOf(errorBox!).includes('Could not load the team right now.') && errorBox!.findAll((n) => n.type === 'button').length === 1, `${requests.length} requests; ${errorBox ? textOf(errorBox) : 'no error box'}`);
  broken.renderer.unmount();
}

// ─── Owner roster ────────────────────────────────────────────────────────────

console.log('\noffice team: owner roster');
{
  reset();
  responses = [json(200, teamAs('owner', 'tm-owner'))];
  const { root, renderer } = await renderTeam();

  const holder = maybe(root, 'row-team-account-owner');
  check('account holder row: owner chip, active, "Account holder" instead of actions', Boolean(holder) && textOf(holder!).includes('Dr. Priya Raman') && textOf(holder!).includes('Owner') && textOf(holder!).includes('Active') && textOf(holder!).includes('Account holder'));
  check('every teammate renders as a row', MEMBERS.every((m) => Boolean(maybe(root, `row-team-${m.id}`))));

  const self = one(root, 'row-team-tm-owner');
  check('own row: "(you)", locked as "Your login", no action buttons', textOf(self).includes('(you)') && textOf(self).includes('Your login') && self.findAll((n) => n.type === 'button').length === 0, textOf(self));

  const admin = one(root, 'row-team-tm-admin');
  check('admin row: Admin chip, Change role + Sign out + Deactivate', textOf(admin).includes('Admin') && Boolean(maybe(admin, 'button-edit-tm-admin')) && Boolean(maybe(admin, 'button-sign-out-tm-admin')) && Boolean(maybe(admin, 'button-deactivate-tm-admin')));
  const invited = one(root, 'row-team-tm-invited');
  check('invited row: Invited chip, no Sign out (never signed in), joined shows dash', textOf(invited).includes('Invited') && !maybe(invited, 'button-sign-out-tm-invited') && Boolean(maybe(invited, 'button-deactivate-tm-invited')) && textOf(invited).includes('—'));
  const disabled = one(root, 'row-team-tm-disabled');
  check('deactivated row: Deactivated chip, Reactivate only', textOf(disabled).includes('Deactivated') && Boolean(maybe(disabled, 'button-reactivate-tm-disabled')) && !maybe(disabled, 'button-deactivate-tm-disabled') && !maybe(disabled, 'button-sign-out-tm-disabled'));
  check('subheading counts people and names the office', root.findAll((n) => typeof n.type === 'string' && textOf(n) === '6 people · Beacon Hill Aesthetics').length > 0);

  // Invite: local validation, then POST.
  await click(one(root, 'button-invite'));
  check('invite dialog opens', root.findAll((n) => n.props.role === 'dialog').length === 1);
  await click(one(root, 'button-invite-submit'));
  check('blank invite: validation messages, no request', textOf(root).includes('First name is required.') && textOf(root).includes('Enter a valid email address.') && requests.length === 1);
  await type(one(root, 'input-invite-first-name'), '  Nora ');
  await type(one(root, 'input-invite-last-name'), 'Newhire');
  await type(one(root, 'input-invite-email'), ' Nora@BeaconHill.example ');
  await pickOption(root, 'admin');
  check('owner sees the Owner option in the invite role picker', root.findAll((n) => n.props.role === 'option' && n.props['data-value'] === 'owner').length === 1);
  responses = [
    json(400, { error: 'That email already has a login in this office.', field: 'email' }),
  ];
  await click(one(root, 'button-invite-submit'));
  const invitePost = requests[1];
  check('invite POSTs the trimmed body with the chosen role', invitePost?.method === 'POST' && invitePost.url === '/api/office/team/invitations' && JSON.stringify(invitePost.body) === JSON.stringify({ firstName: 'Nora', lastName: 'Newhire', email: 'Nora@BeaconHill.example', role: 'admin' }), JSON.stringify(invitePost));
  const emailInput = one(root, 'input-invite-email');
  check('server field error lands on the email field and keeps the dialog open', emailInput.props['aria-invalid'] === true && textOf(root).includes('That email already has a login in this office.') && root.findAll((n) => n.props.role === 'dialog').length === 1);
  responses = [
    json(200, { member: member('tm-new', 'Nora Newhire', { role: 'admin', status: 'invited', claimedAt: null }) }),
    json(200, { ...teamAs('owner', 'tm-owner'), members: [...MEMBERS, member('tm-new', 'Nora Newhire', { role: 'admin', status: 'invited', claimedAt: null })] }),
  ];
  await click(one(root, 'button-invite-submit'));
  check('successful invite: success toast, dialog closes, roster refreshes with the new row', toastText().includes('Invite sent to Nora Newhire') && toastText().includes('Admin') && root.findAll((n) => n.props.role === 'dialog').length === 0 && Boolean(maybe(root, 'row-team-tm-new')), toastText());

  // Change role.
  __resetToastStoreForTests();
  await click(one(root, 'button-edit-tm-staff'));
  check('role dialog opens on the member with Save disabled while unchanged', root.findAll((n) => n.props.role === 'dialog').length === 1 && one(root, 'button-edit-submit').props.disabled === true && textOf(root).includes('Change Sam Staff’s role'));
  await pickOption(root, 'admin');
  check('picking a new role enables Save', one(root, 'button-edit-submit').props.disabled === false);
  responses = [
    json(200, { member: member('tm-staff', 'Sam Staff', { role: 'admin' }) }),
    json(200, teamAs('owner', 'tm-owner')),
  ];
  await click(one(root, 'button-edit-submit'));
  const patch = requests.find((r) => r.method === 'PATCH');
  check('role change PATCHes {role} to the member route', patch?.url === '/api/office/team/tm-staff' && JSON.stringify(patch.body) === JSON.stringify({ role: 'admin' }), JSON.stringify(patch));
  check('role change toast names the member and the new role', toastText().includes('Sam Staff is now Admin'), toastText());

  // Deactivate with a failed session invalidation.
  __resetToastStoreForTests();
  await click(one(root, 'button-deactivate-tm-admin'));
  const confirmBox = root.findAll((n) => n.props.role === 'alertdialog');
  check('deactivate asks first and explains reactivation', confirmBox.length === 1 && textOf(confirmBox[0]).includes('Deactivate Adam Admin?') && textOf(confirmBox[0]).includes('reactivate them later'));
  responses = [
    json(200, { member: member('tm-admin', 'Adam Admin', { role: 'admin', status: 'disabled' }), sessionInvalidation: 'failed' }),
    json(200, teamAs('owner', 'tm-owner')),
  ];
  await click(one(root, 'button-status-confirm'));
  const deactivate = requests.find((r) => r.url.endsWith('/tm-admin/deactivate'));
  check('deactivate POSTs the deactivate verb', deactivate?.method === 'POST', JSON.stringify(requests.map((r) => `${r.method} ${r.url}`)));
  check('failed sign-out is said honestly: access off, session ends on next request', toastText().includes('Adam Admin deactivated') && toastText().includes('ends on its next request') && !toastText().includes('every signed-in device was signed out'), toastText());
  check('confirmation closes after the action', root.findAll((n) => n.props.role === 'alertdialog').length === 0);

  // Reactivate.
  __resetToastStoreForTests();
  await click(one(root, 'button-reactivate-tm-disabled'));
  responses = [
    json(200, { member: member('tm-disabled', 'Dee Disabled', { status: 'active' }), sessionInvalidation: 'not_applicable' }),
    json(200, teamAs('owner', 'tm-owner')),
  ];
  await click(one(root, 'button-status-confirm'));
  check('reactivate POSTs the reactivate verb and says no re-invite is needed', requests.some((r) => r.url.endsWith('/tm-disabled/reactivate') && r.method === 'POST') && toastText().includes('Dee Disabled reactivated') && toastText().includes('existing login'), toastText());

  // Sign out everywhere, complete.
  __resetToastStoreForTests();
  await click(one(root, 'button-sign-out-tm-staff'));
  responses = [
    json(200, { member: member('tm-staff', 'Sam Staff'), sessionInvalidation: 'complete' }),
    json(200, teamAs('owner', 'tm-owner')),
  ];
  await click(one(root, 'button-status-confirm'));
  check('sign out POSTs the sign-out verb and reports success', requests.some((r) => r.url.endsWith('/tm-staff/sign-out') && r.method === 'POST') && toastText().includes('Sam Staff') && toastText().toLowerCase().includes('signed out'), toastText());

  // Last-owner guard is the server's word.
  __resetToastStoreForTests();
  await click(one(root, 'button-edit-tm-admin'));
  await pickOption(root, 'owner');
  responses = [json(409, { error: 'The last remaining owner cannot be demoted.' })];
  // (The server would only say this when demoting an owner; the page must
  // relay any 409 verbatim regardless of which transition triggered it.)
  await click(one(root, 'button-edit-submit'));
  const failedToast = lastToast();
  check('409 from the server is a destructive toast quoting the server', failedToast?.variant === 'destructive' && String(failedToast?.description).includes('The last remaining owner cannot be demoted.'), toastText());

  renderer.unmount();
}

// ─── Admin limits + HQ drill-in ──────────────────────────────────────────────

console.log('\noffice team: admin limits and HQ drill-in');
{
  reset();
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'auth-admin' } });
  responses = [json(200, teamAs('admin', 'tm-admin'))];
  const { root, renderer } = await renderTeam();
  const ownerRow = one(root, 'row-team-tm-owner');
  check('admin: owner rows are locked ("Owner"), no action buttons', textOf(ownerRow).includes('Owner') && ownerRow.findAll((n) => n.type === 'button').length === 0, textOf(ownerRow));
  check('admin: own row locked as "Your login"', textOf(one(root, 'row-team-tm-admin')).includes('Your login'));
  check('admin: can still manage staff rows', Boolean(maybe(root, 'button-edit-tm-staff')) && Boolean(maybe(root, 'button-deactivate-tm-staff')));
  await click(one(root, 'button-invite'));
  check('admin: invite role picker offers no Owner option', root.findAll((n) => n.props.role === 'option' && n.props['data-value'] === 'owner').length === 0 && root.findAll((n) => n.props.role === 'option' && n.props['data-value'] === 'admin').length === 1);
  renderer.unmount();

  reset();
  __setSupabaseSession('hq-token');
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'auth-hq' } });
  __setScope({ providerId: 'office-1', officeName: 'Beacon Hill Aesthetics' });
  responses = [json(200, { ...teamAs('owner', 'nobody'), me: { role: 'owner', kind: 'hq', teamMemberId: null } })];
  const hq = await renderTeam();
  check('HQ drill-in: names the office with ?office=', requests[0]?.url === '/api/office/team?office=office-1' && requests[0].auth === 'Bearer hq-token', JSON.stringify(requests));
  check('HQ drill-in: renders the roster with no self row locked', Boolean(maybe(hq.root, 'row-team-tm-owner')) && !textOf(hq.root).includes('Your login'));
  hq.renderer.unmount();

  reset();
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'auth-hq' } });
  __setScope(null);
  const unscoped = await renderTeam();
  check('HQ without an office in scope: unauthorized notice, no request', Boolean(maybe(unscoped.root, 'status-team-unauthorized')) && requests.length === 0);
  unscoped.renderer.unmount();
}

console.log(failures === 0 ? '\nAll office team checks passed.' : `\n${failures} office team check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
