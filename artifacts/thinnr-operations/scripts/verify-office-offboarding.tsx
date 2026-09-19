/**
 * HQ office offboarding in the operations app.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:office-offboarding
 *
 * Renders the real stepper and Accounts page under react-test-renderer.
 * API fetches, HQ data, session, account locks, and DOM-dependent Radix
 * controls are stubbed in the same manner as the legal-holds suite.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OfficeOffboarding } from '../src/components/admin/OfficeOffboarding';
import Accounts from '../src/pages/admin/Accounts';
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession } from './a11y-stubs/session';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}

const byTestId = (root: ReactTestInstance, id: string) => root.findAll(
  (node) => node.props['data-testid'] === id && typeof node.type === 'string',
);
const settle = async (ticks = 8) => {
  for (let index = 0; index < ticks; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
};

const baseOffboarding = {
  providerId: 'office-1',
  officeName: 'Beacon Hill Aesthetics',
  status: 'active',
  nextStep: 'start',
  legalHold: false,
  destroyAfterDays: 30,
  started: null,
  bundle: null,
  handover: null,
  seal: null,
  offboardedAt: null,
  certificateAvailable: false,
};

let offboarding: any = baseOffboarding;
g.fetch = async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/provider-accounts/office-1/offboarding')) {
    return new Response(JSON.stringify({ offboarding }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  throw new Error(`unexpected fetch GET ${url}`);
};

async function render(path: string, element: React.ReactElement) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Router hook={loc.hook}>{element}</Router>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root, loc };
}

console.log('\noffboarding stepper: active office');
{
  offboarding = { ...baseOffboarding };
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  const button = byTestId(root, 'button-offboarding-start')[0];
  check('step 1 is current and enabled', byTestId(root, 'offboarding-step-1')[0]?.props['data-state'] === 'current' && button?.props.disabled === false);
  check('later steps are upcoming', byTestId(root, 'offboarding-step-4')[0]?.props['data-state'] === 'upcoming' && byTestId(root, 'offboarding-step-5')[0]?.props['data-state'] === 'upcoming');
  await act(async () => renderer.unmount());
}

console.log('\noffboarding stepper: seal in progress');
{
  offboarding = {
    ...baseOffboarding,
    status: 'offboarding',
    nextStep: 'seal',
    started: { at: '2026-09-01T12:00:00Z', by: 'hq-1', sessionsRevoked: 4 },
    handover: { receivedBy: 'Jamie Lee', receivedOn: '2026-09-02', choice: 'retain', letterReference: 'LETTER-19', note: '', recordedAt: '2026-09-02T12:00:00Z', recordedBy: 'hq-1' },
    seal: { startedAt: '2026-09-03T12:00:00Z', retainUntil: null, completedAt: null, progress: { total: 20, sealed: 12, held: 2, pending: 5, failed: 1, destroyed: 0 } },
  };
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  const progress = byTestId(root, 'offboarding-seal-progress')[0];
  const text = progress ? textOf(progress) : '';
  check('running seal shows every operational count', text.includes('total20') && text.includes('sealed12') && text.includes('held2') && text.includes('pending5') && text.includes('failed1'), text);
  check('held charts explanation is visible', textOf(root).includes('parked behind patient legal holds'));
  await act(async () => renderer.unmount());
}

console.log('\noffboarding stepper: office legal hold');
{
  offboarding = {
    ...baseOffboarding,
    status: 'offboarding',
    nextStep: 'seal',
    legalHold: true,
    started: { at: '2026-09-01T12:00:00Z', by: 'hq-1', sessionsRevoked: 4 },
    handover: { receivedBy: 'Jamie Lee', receivedOn: '2026-09-02', choice: 'destroy', letterReference: 'LETTER-20', note: '', recordedAt: '2026-09-02T12:00:00Z', recordedBy: 'hq-1' },
  };
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  check('legal-hold warning is visible', byTestId(root, 'office-offboarding-legal-hold').length === 1);
  check('seal and complete actions are disabled', byTestId(root, 'button-offboarding-seal')[0]?.props.disabled === true && byTestId(root, 'button-offboarding-complete')[0]?.props.disabled === true);
  await act(async () => renderer.unmount());
}

console.log('\noffboarding stepper: completed office');
{
  offboarding = {
    ...baseOffboarding,
    status: 'offboarded',
    nextStep: null,
    offboardedAt: '2026-09-08T12:00:00Z',
    certificateAvailable: true,
  };
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  check('completed state shows the certificate button', byTestId(root, 'button-offboarding-certificate').length === 1 && textOf(root).includes('Offboarded on'));
  await act(async () => renderer.unmount());
}

const account = (id: string, status: 'active' | 'offboarded') => ({
  id,
  providerId: id,
  officeName: status === 'active' ? 'Beacon Hill Aesthetics' : 'Lakeview Wellness',
  providerName: status === 'active' ? 'Dr. Beacon' : 'Dr. Lake',
  providerRole: 'Physician',
  providerCode: id,
  status,
  plan: 'Core',
  address1: '1 Main St',
  address2: null,
  city: 'Boston',
  state: 'MA',
  postalCode: '02108',
  email: `${id}@example.com`,
  phone: '6175550100',
  joinedKey: '2026-01-01',
  greetingName: 'Doctor',
  activePatientCount: 3,
  newEnrollments: 0,
  recurringRevenue: 100,
  enrollmentRevenue: 0,
  activeSubscriptions: 3,
  deliveriesInWindow: 0,
  engagementRate: 0,
  avgPoundsLost: 0,
  goalCompletion: 0,
  retention: 0,
  offboarding: status === 'offboarded'
    ? { status: 'offboarded', startedAt: '2026-09-01T12:00:00Z', offboardedAt: '2026-09-08T12:00:00Z' }
    : { status: 'active', startedAt: null, offboardedAt: null },
});

console.log('\naccounts page: offboarding filter');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin' });
  __setHqData({
    accounts: [account('office-1', 'active'), account('office-2', 'offboarded')],
    accountsStatus: 'ready',
    accountsError: null,
    settingsValues: {},
  });
  const { renderer, root } = await render('/admin/accounts', <Accounts />);
  check('default Active filter hides offboarded offices', byTestId(root, 'row-account-office-1').length === 1 && byTestId(root, 'row-account-office-2').length === 0);
  const option = root.findAll((node) => node.props.role === 'option' && node.props['data-value'] === 'offboarded')[0];
  await act(async () => {
    option.props.onClick();
  });
  await settle();
  check('Offboarded filter becomes the URL-backed selection', byTestId(root, 'select-account-status')[0]?.props['data-value'] === 'offboarded');
  check('Offboarded filter shows only offboarded offices and dates', byTestId(root, 'row-account-office-1').length === 0 && byTestId(root, 'row-account-office-2').length === 1 && textOf(byTestId(root, 'row-account-office-2')[0]).includes('Started'));
  await act(async () => renderer.unmount());
}

console.log(failures === 0 ? '\nall office-offboarding checks passed' : `\n${failures} office-offboarding check(s) failed`);
process.exit(failures === 0 ? 0 : 1);