/**
 * HQ testing hard-delete panel: permission gating, preview listing, the
 * typed-name + fresh-code gate on the delete button, busy state, result
 * summary with Stripe outcomes, and server-error handling.
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TestingHardDelete, useCanHardDelete } from '../src/components/admin/TestingHardDelete';
import { registerReauthHandler } from '../src/lib/reauth';
import { sessionState } from './testing-hard-delete-stubs/session';
import { __setSession } from './invite-stubs/supabase';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}
const byTestId = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => byTestId(root, id)[0];
const text = (node: ReactTestInstance | undefined): string =>
  !node ? '' : node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
const settle = async (ticks = 6) => {
  for (let index = 0; index < ticks; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
};

// ── fetch double ───────────────────────────────────────────────────────────
interface Call { method: string; url: string; body: unknown }
const calls: Call[] = [];
let postResponder: () => Promise<{ status: number; body: unknown }> = async () => ({ status: 500, body: {} });
const providerPreview = {
  kind: 'provider', id: 'office-1', name: 'Harbor Test Spa', providerName: 'Dr. A',
  staffLogins: 3, hqMembersKept: 1, patients: 2, patientLogins: 1,
  stripeAccounts: [{ accountId: 'acct_created', origin: 'created', mode: 'test', archived: false },
    { accountId: 'acct_linked', origin: 'oauth', mode: 'test', archived: true }],
  accessPlan: { state: 'active', savedPaymentMethods: 2 },
};
const patientPreview = {
  kind: 'patient', id: 'p-1', name: 'Pat One', providerId: 'office-1', officeName: 'Harbor Test Spa',
  hasLogin: true, hqMemberKept: false, activeSubscriptions: 1,
};
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
  let status = 200;
  let body: unknown;
  if (method === 'GET') body = url.includes('/patients/') ? patientPreview : providerPreview;
  else ({ status, body } = await postResponder());
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};
__setSession('hq-token');

let reauthAnswer = true;
let reauthPrompts = 0;
registerReauthHandler(async () => { reauthPrompts += 1; return reauthAnswer; });

async function mount(kind: 'provider' | 'patient', onDeleted: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let renderer!: ReactTestRenderer;
  const id = kind === 'provider' ? 'office-1' : 'p-1';
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <TestingHardDelete kind={kind} targetId={id} label={kind === 'provider' ? 'Harbor Test Spa' : 'Pat One'} onDeleted={onDeleted} />
      </QueryClientProvider>,
    );
  });
  return renderer;
}

console.log('\npermission gate');
{
  const seen: boolean[] = [];
  function Probe() { seen.push(useCanHardDelete()); return null; }
  const cases: Array<[string, string | null, string | null, boolean]> = [
    ['signed-in', 'hq_admin', 'Admin', true],
    ['signed-in', 'hq_admin', 'Super Admin', true],
    ['signed-in', 'hq_admin', 'Support', false],
    ['signed-in', 'hq_admin', 'Clinical', false],
    ['signed-in', 'provider_staff', null, false],
    ['signed-in', 'patient', null, false],
    ['signed-out', 'hq_admin', 'Admin', false],
  ];
  for (const [authStatus, authRole, hqRole, expected] of cases) {
    Object.assign(sessionState, { authStatus, authRole, hqRole });
    seen.length = 0;
    let r!: ReactTestRenderer;
    await act(async () => { r = create(<Probe />); });
    check(`${authRole}/${hqRole ?? '-'} (${authStatus}) → ${expected ? 'allowed' : 'hidden'}`, seen.at(-1) === expected);
    await act(async () => r.unmount());
  }
  Object.assign(sessionState, { authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Admin' });
}

console.log('\nprovider dialog gating');
{
  let deleted = 0;
  const renderer = await mount('provider', () => { deleted += 1; });
  const root = renderer.root;
  const section = one(root, 'section-hard-delete-provider');
  check('section is labeled as a testing override that is not HIPAA compliant',
    text(section).includes('Delete provider permanently (testing override)') && text(section).includes('not HIPAA compliant'));
  check('dialog is closed and nothing is fetched until opened', byTestId(root, 'dialog-hard-delete-provider').length === 0 && calls.length === 0);

  await act(async () => { one(root, 'button-hard-delete-provider').props.onClick(); });
  await settle();
  const list = text(one(root, 'list-hard-delete-preview'));
  check('preview is fetched from the HQ testing-delete route', calls[0]?.method === 'GET' && calls[0]?.url === '/api/hq/testing-delete/providers/office-1');
  check('preview lists the office, staff logins, patients and Stripe accounts',
    list.includes('Harbor Test Spa') && list.includes('3 staff logins') && list.includes('1 HQ team member keep') &&
    list.includes('2 patients') && list.includes('acct_created') && list.includes('deleted in Stripe') &&
    list.includes('acct_linked') && list.includes('disconnected') && list.includes('2 saved card or bank records'), list);

  const confirm = () => one(root, 'button-hard-delete-provider-confirm');
  check('delete starts disabled', confirm().props.disabled === true);
  await act(async () => { one(root, 'input-hard-delete-provider-name').props.onChange({ target: { value: 'Harbor Spa' } }); });
  check('a wrong name keeps it disabled', confirm().props.disabled === true);
  await act(async () => { one(root, 'input-hard-delete-provider-name').props.onChange({ target: { value: '  harbor   TEST spa ' } }); });
  check('the right name alone (no fresh code) keeps it disabled', confirm().props.disabled === true);

  reauthAnswer = false;
  await act(async () => { one(root, 'button-hard-delete-provider-verify').props.onClick(); });
  await settle(2);
  check('a cancelled code prompt keeps it disabled and says why',
    confirm().props.disabled === true && text(one(root, 'hard-delete-provider-error')).includes('fresh sign-in code') && reauthPrompts === 1);

  reauthAnswer = true;
  await act(async () => { one(root, 'button-hard-delete-provider-verify').props.onClick(); });
  await settle(2);
  check('name + fresh code enables delete', confirm().props.disabled === false && byTestId(root, 'hard-delete-provider-verified').length === 1);

  await act(async () => { one(root, 'input-hard-delete-provider-name').props.onChange({ target: { value: 'Harbor' } }); });
  check('editing the name away disables it again', confirm().props.disabled === true);
  await act(async () => { one(root, 'input-hard-delete-provider-name').props.onChange({ target: { value: 'Harbor Test Spa' } }); });

  // Server refusal (e.g. Stripe cancel failure) → error, outcomes shown, no navigation.
  postResponder = async () => ({ status: 502, body: { error: 'Stripe would not cancel a patient subscription. Nothing was deleted.',
    stripe: [{ kind: 'patient_subscriptions', result: 'not_reachable', count: 1 }] } });
  await act(async () => { confirm().props.onClick(); });
  await settle();
  check('a server refusal shows the error and Stripe detail, stays open, no navigation',
    text(one(root, 'hard-delete-provider-error')).includes('Nothing was deleted') &&
    byTestId(root, 'hard-delete-provider-failed-stripe').length === 1 && deleted === 0 &&
    byTestId(root, 'dialog-hard-delete-provider').length === 1);

  let release!: () => void;
  postResponder = () => new Promise((resolve) => {
    release = () => resolve({ status: 200, body: {
      kind: 'provider', id: 'office-1', name: 'Harbor Test Spa',
      stripe: [
        { kind: 'connected_account', accountId: 'acct_created', origin: 'created', archived: false, result: 'deleted' },
        { kind: 'connected_account', accountId: 'acct_linked', origin: 'oauth', archived: true, result: 'disconnected' },
        { kind: 'access_payment_method', paymentMethodId: 'pm_1', result: 'removed' },
        { kind: 'access_plan', result: 'cancelled', state: 'active' },
      ],
      logins: { deleted: 3, alreadyGone: 0, keptHqMembers: 1, failed: [] },
      files: { deleted: 7, failed: [] },
      rows: { providers: 1, patients: 2, billing_orders: 4 },
    } });
  });
  await act(async () => { confirm().props.onClick(); });
  await settle(2);
  check('busy state disables the button and says Deleting…', confirm().props.disabled === true && text(confirm()) === 'Deleting…');
  const post = calls.filter((c) => c.method === 'POST').at(-1);
  check('POST carries the typed name to the provider route',
    post?.url === '/api/hq/testing-delete/providers/office-1' && (post?.body as { confirmName?: string })?.confirmName === 'Harbor Test Spa');
  await act(async () => { release(); });
  await settle();
  const summary = text(one(root, 'hard-delete-result'));
  check('result summary reports rows, logins, files and each Stripe outcome',
    summary.includes('7 database records') && summary.includes('3 logins removed') && summary.includes('1 HQ team member kept') &&
    summary.includes('7 stored files') && summary.includes('acct_created was deleted in Stripe') &&
    summary.includes('acct_linked belongs to the office, so it was disconnected') &&
    summary.includes('pm_1 was removed') && summary.includes('plan (active) was cancelled'), summary);
  check('navigation waits for the HQ user to read the result', deleted === 0);
  await act(async () => { one(root, 'button-hard-delete-provider-done').props.onClick(); });
  check('Back to accounts closes and hands off navigation', deleted === 1 && byTestId(root, 'dialog-hard-delete-provider').length === 0);
  await act(async () => renderer.unmount());
}

console.log('\npatient dialog');
{
  let deleted = 0;
  calls.length = 0;
  const renderer = await mount('patient', () => { deleted += 1; });
  const root = renderer.root;
  check('patient section is labeled as a testing override',
    text(one(root, 'section-hard-delete-patient')).includes('Delete patient permanently (testing override)'));
  await act(async () => { one(root, 'button-hard-delete-patient').props.onClick(); });
  await settle();
  const list = text(one(root, 'list-hard-delete-preview'));
  check('patient preview names the patient, office, login and subscriptions',
    calls[0]?.url === '/api/hq/testing-delete/patients/p-1' && list.includes('Pat One') && list.includes('Harbor Test Spa') &&
    list.includes('Their login, email and phone number') && list.includes('1 active subscription'), list);
  const confirm = () => one(root, 'button-hard-delete-patient-confirm');
  await act(async () => { one(root, 'button-hard-delete-patient-verify').props.onClick(); });
  await settle(2);
  check('fresh code alone (no name) keeps it disabled', confirm().props.disabled === true);
  await act(async () => { one(root, 'input-hard-delete-patient-name').props.onChange({ target: { value: 'pat one' } }); });
  check('name + code enables patient delete', confirm().props.disabled === false);
  postResponder = async () => ({ status: 200, body: {
    kind: 'patient', id: 'p-1', name: 'Pat One',
    stripe: [{ kind: 'patient_subscriptions', result: 'cancelled', count: 1 }],
    logins: { deleted: 1, alreadyGone: 0, keptHqMembers: 0, failed: [] }, files: { deleted: 2, failed: [] }, rows: { patients: 1 },
  } });
  await act(async () => { confirm().props.onClick(); });
  await settle();
  check('patient result reports the cancelled subscription', text(one(root, 'hard-delete-result')).includes('1 patient subscription cancelled in Stripe'));
  await act(async () => { one(root, 'button-hard-delete-patient-done').props.onClick(); });
  check('Back to patients hands off navigation', deleted === 1);
  await act(async () => renderer.unmount());
}

console.log(failures === 0 ? '\nall testing hard-delete checks passed' : `\n${failures} testing hard-delete check(s) failed`);
if (failures > 0) process.exitCode = 1;
