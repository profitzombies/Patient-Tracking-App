/**
 * Real-component regression suite for the private operations bloodwork UI.
 *
 * Uses the generated API client against a scripted fetch. Only browser portals
 * and session/provider contexts are replaced with DOM-free test stand-ins.
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { QueryClient as QueryClientType } from '@tanstack/react-query';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession, supabase } from './invite-stubs/supabase';
import { __getToastStateForTests, __resetToastStoreForTests } from '../src/hooks/use-toast';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
// The actor-switch case intentionally resolves a mutation after its observer
// has unmounted. TanStack's detached notification tick triggers React's generic
// advisory even though every render, switch, and resolution below is in act().
const rawConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
  rawConsoleError(...args);
};
const revoked: string[] = [];
const downloaded: Array<{ href: string; name: string }> = [];
let blobSequence = 0;
g.URL.createObjectURL = () => `blob:test-${++blobSequence}`;
g.URL.revokeObjectURL = (url: string) => { revoked.push(url); };
g.window ??= {};
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.getComputedStyle ??= () => ({ overflow: '' });
g.document ??= {};
g.document.body ??= {
  style: { overflow: '' },
  appendChild() {},
  removeChild() {},
};
g.document.createElement ??= (tag: string) => {
  if (tag !== 'a') return {};
  const anchor = {
    href: '',
    download: '',
    click() { downloaded.push({ href: anchor.href, name: anchor.download }); },
  };
  return anchor;
};

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { setAuthTokenGetter, setBaseUrl } = await import('@workspace/api-client-react');
const { PatientBloodwork } = await import('../src/components/bloodwork/PatientBloodwork');

setBaseUrl('http://bloodwork.test');
setAuthTokenGetter(async () => (await supabase.auth.getSession()).data.session?.access_token ?? null);

const PATIENT_A = '00000000-0000-4000-8000-000000000001';
const PATIENT_B = '00000000-0000-4000-8000-000000000002';
const REPORT = '00000000-0000-4000-8000-000000000101';
const RESULT = '00000000-0000-4000-8000-000000000201';
const FILE = '00000000-0000-4000-8000-000000000301';

type Recorded = { url: string; method: string; body: any; auth: string | null };
const requests: Recorded[] = [];
let responder: (request: Recorded) => Promise<Response>;

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const bodyText = typeof init?.body === 'string' ? init.body : '';
  const request: Recorded = {
    url,
    method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
    body: bodyText ? JSON.parse(bodyText) : null,
    auth: headers.get('authorization'),
  };
  requests.push(request);
  return responder(request);
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const list = (reports: any[], nextCursor: string | null = null) => ({ reports, nextCursor });
const report = (status: 'queued' | 'processing' | 'completed' | 'failed', overrides: Record<string, unknown> = {}) => ({
  id: REPORT,
  patientId: PATIENT_A,
  title: 'Annual Blood Panel',
  reportDate: '2026-01-01',
  uploadedAt: '2026-01-02T12:00:00Z',
  version: 1,
  kind: 'pdf',
  fileCount: 1,
  pageCount: 1,
  extractionStatus: status,
  extractionError: status === 'failed' ? 'Unreadable image' : null,
  reviewStatus: 'unreviewed',
  ...overrides,
});
const result = (overrides: Record<string, unknown> = {}) => ({
  id: RESULT,
  reportId: REPORT,
  sourceFileId: FILE,
  sourcePage: 1,
  position: 0,
  testName: 'Hemoglobin',
  valueText: '14.5',
  units: 'g/dL',
  referenceRange: '13.8–17.2',
  labFlag: null,
  uncertain: false,
  version: 1,
  reviewStatus: 'unreviewed',
  updatedAt: '2026-01-03T00:00:00Z',
  corrected: true,
  ...overrides,
});
const detail = (status: 'queued' | 'processing' | 'completed' | 'failed', results = status === 'completed' ? [result()] : []) => ({
  report: report(status),
  files: [{ id: FILE, position: 0, mimeType: 'application/pdf', size: 10, pageCount: 1, width: null, height: null }],
  results,
});

let failures = 0;
let checks = 0;
function check(name: string, condition: boolean, detailText = '') {
  checks += 1;
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detailText ? ` — ${detailText}` : ''}`);
  }
}

async function settle(rounds = 8, delay = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, delay)); });
  }
}

function textOf(node: ReactTestInstance): string {
  const out: string[] = [];
  const walk = (value: ReactTestInstance | string | number) => {
    if (typeof value === 'string' || typeof value === 'number') { out.push(String(value)); return; }
    value.children.forEach((child) => walk(child as ReactTestInstance | string | number));
  };
  walk(node);
  return out.join('');
}

const all = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const maybe = (root: ReactTestInstance, id: string) => all(root, id)[0];
const one = (root: ReactTestInstance, id: string) => {
  const found = all(root, id);
  if (found.length !== 1) throw new Error(`expected one ${id}, found ${found.length}`);
  return found[0];
};
const buttonWith = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.type === 'button' && textOf(node).includes(label))[0];
const buttonExactly = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.type === 'button' && textOf(node).trim() === label)[0];
const ariaButton = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.type === 'button' && node.props['aria-label'] === label)[0];

async function click(node: ReactTestInstance) {
  await act(async () => { node.props.onClick({ preventDefault() {} }); });
  await settle();
}
async function type(node: ReactTestInstance, value: string) {
  await act(async () => { node.props.onChange({ target: { value } }); });
}

type Rendered = { renderer: ReactTestRenderer; root: ReactTestInstance; client: QueryClientType };
async function renderBloodwork(props: { patientId?: string; office?: string | null; canEdit?: boolean } = {}): Promise<Rendered> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <PatientBloodwork
          patientId={props.patientId ?? PATIENT_A}
          office={props.office ?? null}
          canEdit={props.canEdit ?? true}
        />
      </QueryClientProvider>,
    );
  });
  return { renderer: renderer!, root: renderer!.root, client };
}

async function dispose(view: Rendered) {
  await act(async () => { view.renderer.unmount(); });
  view.client.clear();
}

function reset(actor = 'actor-a', token = 'token-a') {
  requests.length = 0;
  revoked.length = 0;
  downloaded.length = 0;
  __resetToastStoreForTests();
  __setScope(null);
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: actor } });
  __setSupabaseSession(token);
}

console.log('bloodwork UI: loading, error, and empty states');
{
  reset();
  let resolveList!: (response: Response) => void;
  responder = async () => new Promise<Response>((resolve) => { resolveList = resolve; });
  const view = await renderBloodwork();
  check('list has a distinct loading state', Boolean(maybe(view.root, 'bloodwork-list-loading')) && !maybe(view.root, 'bloodwork-list-empty'));
  await act(async () => { resolveList(json(200, list([]))); });
  await settle();
  check('successful empty response has an explicit empty state', textOf(one(view.root, 'bloodwork-list-empty')).includes('No bloodwork reports'));
  check('generated list call is absolute and authenticated', requests[0]?.url === `http://bloodwork.test/api/bloodwork/patients/${PATIENT_A}/reports` && requests[0]?.auth === 'Bearer token-a', JSON.stringify(requests[0]));
  await dispose(view);

  reset();
  responder = async () => json(503, { error: 'unavailable' });
  const broken = await renderBloodwork();
  await settle();
  check('outage renders error, never empty', Boolean(maybe(broken.root, 'bloodwork-list-error')) && !maybe(broken.root, 'bloodwork-list-empty'));
  await dispose(broken);
}

console.log('\nbloodwork UI: completed detail, history, permissions, and correction conflicts');
{
  reset();
  let correctionMode: 'success' | 'conflict' = 'success';
  const olderReport = report('completed', { id: '00000000-0000-4000-8000-000000000199', title: 'Older Panel' });
  const firstReportPage = [
    report('completed'),
    ...Array.from({ length: 19 }, (_, index) => report('completed', {
      id: `00000000-0000-4000-8000-${String(index + 110).padStart(12, '0')}`,
      title: `Panel ${index + 2}`,
    })),
  ];
  const corrections = Array.from({ length: 21 }, (_, index) => ({
    id: `correction-${index + 1}`, resultId: RESULT, actorRole: 'provider', createdAt: `2026-01-${String(Math.min(index + 4, 28)).padStart(2, '0')}T00:00:00Z`,
    before: { testName: 'Hemoglobin', valueText: index === 0 ? '14.0' : String(index), units: 'g/dL', referenceRange: '13.8–17.2', labFlag: null, uncertain: false },
    after: { testName: 'Hemoglobin', valueText: index === 0 ? '14.5' : String(index + 1), units: 'g/dL', referenceRange: '13.8–17.2', labFlag: null, uncertain: false },
    version: index + 1,
  }));
  responder = async (req) => {
    if (req.method === 'GET' && new URL(req.url).pathname.endsWith(`/patients/${PATIENT_A}/reports`)) {
      return req.url.includes('cursor=report-page-2')
        ? json(200, list([olderReport]))
        : json(200, list(firstReportPage, 'report-page-2'));
    }
    if (req.method === 'GET' && req.url.endsWith(`/reports/${REPORT}`)) return json(200, detail('completed'));
    if (req.method === 'GET' && req.url.includes(`/results/${RESULT}/corrections`)) {
      return json(200, { corrections });
    }
    if (req.method === 'PUT' && req.url.includes(`/results/${RESULT}`)) {
      return correctionMode === 'conflict'
        ? json(409, { error: 'changed' })
        : json(200, result({ testName: req.body.testName, valueText: req.body.valueText, version: 2 }));
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  };
  const view = await renderBloodwork();
  await settle();
  await click(one(view.root, `bloodwork-report-${REPORT}`));
  const completedText = textOf(one(view.root, `bloodwork-result-${RESULT}`));
  check('completed detail renders structured result values', completedText.includes('Hemoglobin') && completedText.includes('14.5') && textOf(view.root).includes('unreviewed'), completedText);
  await click(one(view.root, 'bloodwork-load-more-reports'));
  const reportRequests = requests.filter((request) => new URL(request.url).pathname.endsWith(`/patients/${PATIENT_A}/reports`));
  check('21st saved report loads with the report cursor and bearer auth', reportRequests.length === 2 && reportRequests[1].url.includes('cursor=report-page-2') && reportRequests[1].auth === 'Bearer token-a' && Boolean(maybe(view.root, `bloodwork-report-${olderReport.id}`)));
  check('loading older reports keeps the selected detail pinned', Boolean(maybe(view.root, `bloodwork-result-${RESULT}`)));
  await click(one(view.root, 'bloodwork-refresh-reports'));
  const refreshedReportRequests = requests.filter((request) => new URL(request.url).pathname.endsWith(`/patients/${PATIENT_A}/reports`));
  check('report refresh clears older pages and starts at page one', refreshedReportRequests.length === 3 && !refreshedReportRequests[2].url.includes('cursor=') && !maybe(view.root, `bloodwork-report-${olderReport.id}`) && Boolean(maybe(view.root, `bloodwork-result-${RESULT}`)));
  check('staff UI exposes no upload or delete control', !buttonExactly(view.root, 'Upload') && !buttonExactly(view.root, 'Delete'));
  await click(one(view.root, `bloodwork-history-${RESULT}`));
  check('correction history shows original and corrected values', textOf(one(view.root, `bloodwork-corrections-${RESULT}`)).includes('14.0') && textOf(one(view.root, `bloodwork-corrections-${RESULT}`)).includes('14.5'));
  check('complete correction history response renders beyond 20', textOf(one(view.root, `bloodwork-corrections-${RESULT}`)).includes('/ 21'));

  await click(ariaButton(view.root, 'Edit result'));
  await type(one(view.root, 'bloodwork-edit-test-name'), 'Hemoglobin adjusted');
  await click(one(view.root, 'bloodwork-save-correction'));
  const successfulPut = requests.find((request) => request.method === 'PUT');
  check('correction sends initiating version and bearer', successfulPut?.body.expectedVersion === 1 && successfulPut.auth === 'Bearer token-a');
  check('successful correction replaces cached row', textOf(one(view.root, `bloodwork-result-${RESULT}`)).includes('Hemoglobin adjusted'));

  correctionMode = 'conflict';
  await click(ariaButton(view.root, 'Edit result'));
  await type(one(view.root, 'bloodwork-edit-value'), '<5 private draft');
  const detailQuery = view.client.getQueryCache().findAll().find((query) => query.queryKey.includes('detail'));
  view.client.setQueryData(detailQuery!.queryKey, detail('completed', [result({ testName: 'Unseen remote name', valueText: '99', version: 3 })]));
  await settle();
  await click(one(view.root, 'bloodwork-save-correction'));
  const conflictPut = requests.filter((request) => request.method === 'PUT').at(-1);
  check('held edit submits snapshotted version after background refetch', conflictPut?.body.expectedVersion === 2);
  check('409 preserves edit mode and exact private draft', one(view.root, 'bloodwork-edit-value').props.value === '<5 private draft' && Boolean(maybe(view.root, 'bloodwork-reload-correction')));
  const conflictToast = __getToastStateForTests().toasts[0];
  check('409 is identified as a conflict', String(conflictToast?.title).includes('Conflict'));
  await click(one(view.root, 'bloodwork-reload-correction'));
  check('explicit reload replaces the held draft with latest fields', one(view.root, 'bloodwork-edit-value').props.value === '99');
  await dispose(view);

  reset();
  responder = async (req) => {
    if (req.url.endsWith('/reports')) return json(200, list([report('completed')]));
    if (req.url.includes(`/results/${RESULT}/corrections`)) return json(200, { corrections: corrections.slice(0, 2), nextCursor: null });
    if (req.url.includes('/pages/1')) return new Response('PAGE', { status: 200, headers: { 'Content-Type': 'image/png' } });
    return json(200, detail('completed'));
  };
  const readonly = await renderBloodwork({ canEdit: false });
  await settle();
  await click(one(readonly.root, `bloodwork-report-${REPORT}`));
  check('read-only staff can view detail/source but cannot edit', Boolean(buttonWith(readonly.root, 'View Source')) && !ariaButton(readonly.root, 'Edit result'));
  await click(one(readonly.root, `bloodwork-history-${RESULT}`));
  check('read-only staff can inspect correction history', textOf(one(readonly.root, `bloodwork-corrections-${RESULT}`)).includes('14.0'));
  await click(ariaButton(readonly.root, 'View page source'));
  check('read-only provenance link opens its authenticated source page', requests.some((request) => request.url.includes(`/files/${FILE}/pages/1`) && request.auth === 'Bearer token-a'));
  check('read-only staff still has no upload/delete controls', !buttonExactly(readonly.root, 'Upload') && !buttonExactly(readonly.root, 'Delete'));
  await dispose(readonly);
}

console.log('\nbloodwork UI: queued polling and failed retry');
{
  reset();
  let detailReads = 0;
  responder = async (req) => {
    if (req.url.endsWith('/reports')) return json(200, list([report('queued')]));
    if (req.url.endsWith(`/reports/${REPORT}`)) {
      detailReads += 1;
      return json(200, detail(detailReads === 1 ? 'queued' : 'completed'));
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  };
  const polling = await renderBloodwork();
  await settle();
  await click(one(polling.root, `bloodwork-report-${REPORT}`));
  check('queued detail has a processing state', Boolean(maybe(polling.root, 'bloodwork-processing')));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5100)); });
  await settle();
  check('queued detail polls and lands completed results', detailReads >= 2 && Boolean(maybe(polling.root, `bloodwork-result-${RESULT}`)), String(detailReads));
  await dispose(polling);

  reset();
  responder = async (req) => {
    if (req.method === 'GET' && req.url.endsWith('/reports')) return json(200, list([report('failed')]));
    if (req.method === 'GET' && req.url.endsWith(`/reports/${REPORT}`)) return json(200, detail('failed'));
    if (req.method === 'POST' && req.url.includes('/retry-extraction')) return json(200, report('queued'));
    throw new Error(`unexpected ${req.method} ${req.url}`);
  };
  const failed = await renderBloodwork();
  await settle();
  await click(one(failed.root, `bloodwork-report-${REPORT}`));
  check('failed extraction shows safe failure and retry', textOf(one(failed.root, 'bloodwork-extraction-failed')).includes('Unreadable image') && Boolean(buttonWith(failed.root, 'Retry Extraction')));
  await click(buttonWith(failed.root, 'Retry Extraction'));
  const retry = requests.find((request) => request.method === 'POST');
  check('retry uses generated authenticated POST and updates to processing', retry?.url.includes('/retry-extraction') === true && retry.auth === 'Bearer token-a' && Boolean(maybe(failed.root, 'bloodwork-processing')));
  await dispose(failed);
}

console.log('\nbloodwork UI: actor/scope switch and private blob lifecycle');
{
  reset();
  let resolvePut!: (response: Response) => void;
  responder = async (req) => {
    if (req.method === 'GET' && req.url.endsWith(`/patients/${PATIENT_A}/reports`)) return json(200, list([report('completed')]));
    if (req.method === 'GET' && req.url.endsWith(`/patients/${PATIENT_B}/reports?office=office-b`)) return json(200, list([]));
    if (req.method === 'GET' && req.url.endsWith(`/reports/${REPORT}`)) return json(200, detail('completed'));
    if (req.method === 'PUT') return new Promise<Response>((resolve) => { resolvePut = resolve; });
    throw new Error(`unexpected ${req.method} ${req.url}`);
  };
  const switched = await renderBloodwork();
  await settle();
  await click(one(switched.root, `bloodwork-report-${REPORT}`));
  await click(ariaButton(switched.root, 'Edit result'));
  await type(one(switched.root, 'bloodwork-edit-value'), 'actor A draft');
  await act(async () => {
    one(switched.root, 'bloodwork-save-correction').props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  __resetToastStoreForTests();
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'actor-b' } });
  __setSupabaseSession('token-b');
  await act(async () => {
    switched.renderer.update(
      <QueryClientProvider client={switched.client}>
        <PatientBloodwork patientId={PATIENT_B} office="office-b" canEdit={false} />
      </QueryClientProvider>,
    );
  });
  await settle();
  await act(async () => {
    resolvePut(json(200, result({ valueText: 'actor A draft', version: 2 })));
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  const oldPut = requests.find((request) => request.method === 'PUT');
  const newList = requests.find((request) => request.url.includes(PATIENT_B));
  check('initiating correction stays bound to actor A request', oldPut?.auth === 'Bearer token-a' && oldPut.url.includes(PATIENT_A));
  check('account/patient/office switch fetches isolated actor B list', newList?.auth === 'Bearer token-b' && newList.url.endsWith(`/patients/${PATIENT_B}/reports?office=office-b`));
  check('switch clears detail/edit and does not toast for stale completion', Boolean(maybe(switched.root, 'bloodwork-list-empty')) && !maybe(switched.root, `bloodwork-result-${RESULT}`) && __getToastStateForTests().toasts.length === 0);
  await dispose(switched);

  reset();
  let deferSource = false;
  let resolveSource!: (response: Response) => void;
  responder = async (req) => {
    if (req.url.endsWith('/reports')) return json(200, list([report('completed')]));
    if (req.url.endsWith(`/patients/${PATIENT_B}/reports?office=office-b`)) return json(200, list([]));
    if (req.url.endsWith(`/reports/${REPORT}`)) return json(200, detail('completed'));
    if (req.url.includes(`/pages/1`)) return new Response('PAGE', { status: 200, headers: { 'Content-Type': 'image/png' } });
    if (req.url.endsWith(`/files/${FILE}/source`)) {
      if (deferSource) return new Promise<Response>((resolve) => { resolveSource = resolve; });
      return new Response('PDF', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  };
  const viewer = await renderBloodwork();
  await settle();
  await click(one(viewer.root, `bloodwork-report-${REPORT}`));
  await click(buttonWith(viewer.root, 'View Source'));
  const dialog = viewer.root.findAll((node) => node.props.role === 'dialog')[0];
  const displayedBlob = viewer.root.findAll((node) => node.type === 'img' && String(node.props.src).startsWith('blob:'))[0]?.props.src;
  check('viewer fetches a bearer-protected page into a blob URL', Boolean(dialog) && requests.some((request) => request.url.includes('/pages/1') && request.auth === 'Bearer token-a') && Boolean(displayedBlob));
  await click(ariaButton(viewer.root, 'Download original source file'));
  check('download uses authenticated generated source method and local blob link', requests.some((request) => request.url.endsWith(`/files/${FILE}/source`) && request.auth === 'Bearer token-a') && downloaded[0]?.href.startsWith('blob:') && downloaded[0]?.name.endsWith('.pdf'));
  check('viewer emits no direct or anonymous source link', viewer.root.findAll((node) => node.type === 'a' && String(node.props.href ?? '').startsWith('http')).length === 0);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  check('download blob is revoked after the local click', revoked.includes(downloaded[0]?.href));
  deferSource = true;
  await act(async () => {
    ariaButton(viewer.root, 'Download original source file').props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'actor-b' } });
  __setSupabaseSession('token-b');
  await act(async () => {
    viewer.renderer.update(
      <QueryClientProvider client={viewer.client}>
        <PatientBloodwork patientId={PATIENT_B} office="office-b" canEdit={false} />
      </QueryClientProvider>,
    );
  });
  await settle();
  await act(async () => {
    resolveSource(new Response('LATE PDF', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  check('actor switch closes viewer, revokes display, and cancels late download side effects', viewer.root.findAll((node) => node.props.role === 'dialog').length === 0 && revoked.includes(displayedBlob) && downloaded.length === 1);
  await dispose(viewer);
}

setAuthTokenGetter(null);
setBaseUrl(null);

if (failures > 0) {
  console.error(`\nbloodwork UI: ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`\nbloodwork UI: ${checks}/${checks} checks passed`);
// React's browser-mode scheduler owns a MessageChannel in this DOM-free Node
// harness. Every renderer/query client is disposed above; terminate that
// scheduler handle explicitly after reporting.
process.exit(0);