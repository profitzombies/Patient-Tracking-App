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
import { QueryClient, QueryClientProvider, environmentManager } from '@tanstack/react-query';
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
// React Query decides "server" at import time, before the window shim above
// runs, and a server never arms refetchInterval timers. The live-polling
// checks below need the browser behaviour.
environmentManager.setIsServer(() => false);

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
  reactivation: null,
  reactivated: null,
};

let offboarding: any = baseOffboarding;
const posts: string[] = [];
let stateReads = 0;
let reactivateResponse: () => Response = () => new Response(JSON.stringify({ offboarding }), { status: 200, headers: { 'Content-Type': 'application/json' } });
let bundleResponse: () => Response = () => new Response(JSON.stringify({ offboarding }), { status: 202, headers: { 'Content-Type': 'application/json' } });
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (url.includes('/api/provider-accounts/office-1/offboarding/reactivate') && method === 'POST') {
    posts.push('reactivate');
    return reactivateResponse();
  }
  if (url.includes('/api/provider-accounts/office-1/offboarding/bundle') && method === 'POST') {
    posts.push('bundle');
    return bundleResponse();
  }
  if (url.includes('/api/provider-accounts/office-1/offboarding')) {
    if (method === 'GET') stateReads += 1;
    return new Response(JSON.stringify({ offboarding }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
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

const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const startedOffice = {
  ...baseOffboarding,
  status: 'offboarding',
  nextStep: 'bundle',
  started: { at: '2026-09-01T12:00:00Z', by: 'hq-1', sessionsRevoked: 4 },
};
const bundleJob = (overrides: Record<string, unknown>) => ({
  id: 'exp-1', kind: 'office_bundle', status: 'queued', fileName: 'bundle.zip', requesterKind: 'hq', requesterRole: 'admin', providerId: 'office-1',
  patientId: null, params: { offboarding: true }, error: null, sizeBytes: null, rowCount: null, createdAt: '2026-09-01T12:00:30Z', startedAt: null,
  completedAt: null, expiresAt: '2026-09-08T12:00:00Z', downloadCount: 0, downloadable: false, parts: null,
  progress: { stage: 'queued', partsDone: 0, partsTotal: null, patientsDone: 0, patientsTotal: null, bytesWritten: 0 },
  ...overrides,
});

console.log('\noffboarding stepper: bundle queued → running → ready (live polling)');
{
  offboarding = { ...startedOffice, bundle: bundleJob({}) };
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  const readsAfterMount = stateReads;
  check('queued bundle keeps step 2 current (no premature check) and step 3 upcoming', byTestId(root, 'offboarding-step-2')[0]?.props['data-state'] === 'current' && byTestId(root, 'offboarding-step-3')[0]?.props['data-state'] === 'upcoming');
  check('queued status, timing, and the minute-tick note are visible', textOf(byTestId(root, 'offboarding-bundle-status')[0]).includes('Queued') && textOf(byTestId(root, 'offboarding-bundle-timing')[0]).includes('Not started yet') && textOf(byTestId(root, 'offboarding-bundle-tick-note')[0]).includes('next minute tick'));
  check('no request button while the bundle is queued', byTestId(root, 'button-offboarding-bundle').length === 0);
  check('step 3 says it is waiting on the queued bundle', textOf(byTestId(root, 'offboarding-handover-wait')[0]).includes('queued'));
  // The server moves on; the page must pick it up without a reload.
  offboarding = { ...startedOffice, bundle: bundleJob({ status: 'running', startedAt: '2026-09-01T12:01:00Z', progress: { stage: 'patients', partsDone: 2, partsTotal: null, patientsDone: 7, patientsTotal: 12, bytesWritten: 3 * 1024 * 1024 } }) };
  await sleep(5_400);
  await settle(2);
  check('page refetched on its own while queued', stateReads > readsAfterMount, `${readsAfterMount} → ${stateReads}`);
  const progress = textOf(byTestId(root, 'offboarding-bundle-progress')[0] ?? root);
  check('running bundle shows patients packed, parts written, and bytes', progress.includes('7 of 12 patients packed') && progress.includes('2 parts written') && progress.includes('3.0 MB'), progress);
  check('running bundle shows when it started', textOf(byTestId(root, 'offboarding-bundle-timing')[0]).includes('Started'));
  check('step 2 is still current while running', byTestId(root, 'offboarding-step-2')[0]?.props['data-state'] === 'current');
  check('step 3 says it is waiting on the running build', textOf(byTestId(root, 'offboarding-handover-wait')[0]).includes('still building'));
  offboarding = {
    ...startedOffice,
    nextStep: 'handover',
    bundle: bundleJob({ status: 'ready', startedAt: '2026-09-01T12:01:00Z', completedAt: '2026-09-01T12:03:00Z', downloadable: true, parts: [{ part: 1, fileName: 'bundle_part-001.zip', sizeBytes: 10, fileCount: 3, sha256: 'a' }, { part: 2, fileName: 'bundle_part-002.zip', sizeBytes: 12, fileCount: 9, sha256: 'b' }] }),
  };
  await sleep(5_400);
  await settle(2);
  check('ready bundle marks step 2 done and lists both parts', byTestId(root, 'offboarding-step-2')[0]?.props['data-state'] === 'done' && textOf(root).includes('bundle_part-002.zip · part 2 of 2'));
  check('step 3 becomes the current step with the hand-over form', byTestId(root, 'offboarding-step-3')[0]?.props['data-state'] === 'current' && byTestId(root, 'offboarding-handover-wait').length === 0);
  const readsWhenReady = stateReads;
  await sleep(5_600);
  check('polling stops once the bundle is ready', stateReads === readsWhenReady, `${readsWhenReady} → ${stateReads}`);
  await act(async () => renderer.unmount());
}

console.log('\noffboarding stepper: failed bundle shows the error and a Request again button');
{
  posts.length = 0;
  const failedJob = bundleJob({ status: 'failed', startedAt: '2026-09-01T12:01:00Z', completedAt: '2026-09-01T12:01:05Z', error: 'This financial export has no verified frozen billing identity. Request a new export.', progress: { stage: 'failed', partsDone: 0, partsTotal: null, patientsDone: 0, patientsTotal: 0, bytesWritten: 0 } });
  offboarding = { ...startedOffice, bundle: failedJob };
  const requeued = { ...startedOffice, bundle: bundleJob({ id: 'exp-2' }) };
  bundleResponse = () => new Response(JSON.stringify({ offboarding: requeued }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  check('failed bundle keeps step 2 current with the worker error', byTestId(root, 'offboarding-step-2')[0]?.props['data-state'] === 'current' && textOf(byTestId(root, 'offboarding-bundle-error')[0] ?? root).includes('no verified frozen billing identity'));
  check('step 3 is blocked with a failure message, not a generic wait', textOf(byTestId(root, 'offboarding-handover-wait')[0]).includes('failed') && textOf(byTestId(root, 'offboarding-handover-wait')[0]).includes('request it again'));
  const retry = byTestId(root, 'button-offboarding-bundle')[0];
  check('Request again button is offered and enabled', Boolean(retry) && retry.props.disabled === false && textOf(retry).includes('Request again'));
  const readsBeforeRetry = stateReads;
  await sleep(5_400);
  check('no polling while the bundle is failed', stateReads === readsBeforeRetry, `${readsBeforeRetry} → ${stateReads}`);
  await act(async () => { retry.props.onClick(); });
  await settle();
  check('clicking posts one new bundle request', posts.filter((post) => post === 'bundle').length === 1, String(posts));
  check('the page shows the fresh queued bundle and no error', textOf(byTestId(root, 'offboarding-bundle-status')[0]).includes('Queued') && byTestId(root, 'offboarding-bundle-error').length === 0 && byTestId(root, 'button-offboarding-bundle').length === 0);
  await act(async () => renderer.unmount());
}

console.log('\noffboarding stepper: expired bundle explains itself and can be requested again');
{
  offboarding = { ...startedOffice, bundle: bundleJob({ status: 'expired', startedAt: '2026-09-01T12:01:00Z', completedAt: '2026-09-01T12:03:00Z' }) };
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  check('expired bundle has an explanation and the Request again button', textOf(byTestId(root, 'offboarding-bundle-error')[0] ?? root).includes('expired') && byTestId(root, 'button-offboarding-bundle').length === 1);
  check('step 3 names the expired state', textOf(byTestId(root, 'offboarding-handover-wait')[0]).includes('expired'));
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
  check('no reactivation panel without a preview', byTestId(root, 'office-reactivation').length === 0);
  await act(async () => renderer.unmount());
}

console.log('\noffboarding stepper: reactivation (contract renewed)');
{
  posts.length = 0;
  offboarding = {
    ...baseOffboarding,
    status: 'offboarded',
    nextStep: null,
    offboardedAt: '2026-09-08T12:00:00Z',
    certificateAvailable: true,
    reactivation: { eligible: true, reopenable: 14, lapsed: 0, destroyed: 0, earliestRetainUntil: '2033-09-08T12:00:00Z' },
  };
  const reactivated = {
    ...baseOffboarding,
    reactivated: { at: '2026-09-19T12:00:00Z', by: 'hq-1', charts: 14 },
  };
  reactivateResponse = () => new Response(JSON.stringify({ offboarding: reactivated }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  const button = byTestId(root, 'button-office-reactivate')[0];
  const panel = byTestId(root, 'office-reactivation')[0];
  check('eligible office shows the Reactivate button and what it will reopen', button?.props.disabled === false && textOf(panel).includes('reopens 14 sealed charts') && textOf(panel).includes('kept until Sep 8, 2033') && textOf(panel).includes('re-enroll through the office'));
  await act(async () => { button.props.onClick(); });
  await settle(2);
  const dialog = root.findAll((node) => node.props.role === 'dialog')[0];
  check('reactivation asks for confirmation first', Boolean(dialog) && textOf(dialog).includes('Reactivate this office?') && textOf(dialog).includes('(14)') && posts.length === 0);
  await act(async () => { byTestId(root, 'button-offboarding-confirm')[0].props.onClick(); });
  await settle();
  check('confirming posts the reactivation once', posts.length === 1, String(posts.length));
  check('stepper resets to a fresh office with the reactivation note', byTestId(root, 'offboarding-step-1')[0]?.props['data-state'] === 'current' && byTestId(root, 'button-offboarding-start')[0]?.props.disabled === false && textOf(byTestId(root, 'office-reactivated-note')[0]).includes('14 sealed charts were reopened'));
  check('no error is shown', byTestId(root, 'office-offboarding-error').length === 0);
  await act(async () => renderer.unmount());
}

console.log('\noffboarding stepper: reactivation refused after destruction');
{
  posts.length = 0;
  offboarding = {
    ...baseOffboarding,
    status: 'offboarded',
    nextStep: null,
    offboardedAt: '2026-09-08T12:00:00Z',
    certificateAvailable: true,
    reactivation: { eligible: false, reopenable: 9, lapsed: 0, destroyed: 5, earliestRetainUntil: '2033-09-08T12:00:00Z' },
  };
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  const refused = byTestId(root, 'office-reactivation-refused')[0];
  check('refusal explains what was destroyed and what is left', Boolean(refused) && textOf(refused).includes('5 charts were already destroyed') && textOf(refused).includes('9 charts remain sealed until Sep 8, 2033') && textOf(refused).includes('new account'));
  check('Reactivate button is disabled', byTestId(root, 'button-office-reactivate')[0]?.props.disabled === true && byTestId(root, 'button-office-reactivate')[0]?.props['aria-disabled'] === true);
  await act(async () => renderer.unmount());
}

console.log('\noffboarding stepper: server refusal surfaces its explanation');
{
  offboarding = {
    ...baseOffboarding,
    status: 'offboarded',
    nextStep: null,
    offboardedAt: '2026-09-08T12:00:00Z',
    certificateAvailable: true,
    reactivation: { eligible: true, reopenable: 3, lapsed: 0, destroyed: 0, earliestRetainUntil: null },
  };
  reactivateResponse = () => new Response(JSON.stringify({ error: 'This office cannot be reactivated: 1 chart sealed by this offboarding was already destroyed. 2 charts remain sealed; they cannot be reopened as a partial office. Onboard it as a new office instead.', code: 'charts_destroyed' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  const { renderer, root } = await render('/admin/accounts/office-1', <OfficeOffboarding officeId="office-1" />);
  await act(async () => { byTestId(root, 'button-office-reactivate')[0].props.onClick(); });
  await settle(2);
  await act(async () => { byTestId(root, 'button-offboarding-confirm')[0].props.onClick(); });
  await settle();
  check('409 explanation is shown verbatim', textOf(byTestId(root, 'office-offboarding-error')[0] ?? root).includes('was already destroyed'));
  check('office stays offboarded', byTestId(root, 'button-offboarding-certificate').length === 1);
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