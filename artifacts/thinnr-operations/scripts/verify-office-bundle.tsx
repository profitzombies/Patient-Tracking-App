/**
 * HQ "Export entire office record" — one bundle of everything an office owns.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:office-bundle
 *
 * Renders the REAL OfficeBundleExport control (the button + confirmation the
 * HQ office account page mounts) and the shared Exports panel under
 * react-test-renderer with a scripted global fetch (session stubbed, Radix
 * dialog resolved to the DOM-free stub via tsconfig.office-bundle.json).
 * Covers:
 *   - the button follows the server's export options: HQ with provider
 *     management (office_bundle offered) sees it, anyone else does not;
 *   - opening the dialog fetches the estimate for THIS office and shows the
 *     patient count, tombstone count, and snapshot-based size (or an honest
 *     "unknown" before the first snapshot); confirm waits for the estimate;
 *   - confirming posts { kind: office_bundle, office, includeTombstones }
 *     with the checkbox state;
 *   - the dialog lists this office's bundles with patients-done/total and
 *     bytes-written progress while building, one download button per ZIP
 *     part when ready, tombstone / omitted-file notes, failed + expired copy;
 *   - a part download mints a signed link for that part (?part=N);
 *   - the Exports panel hides the bundle kind from its request dropdown but
 *     lists the job with bundle progress and per-part downloads;
 *   - the office account page mounts the control with the account id;
 *   - audit labels for both new actions.
 *
 * Pure half: bundle progress / estimate / count labels.
 */
import * as React from 'react';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DateRangeProvider } from '../src/contexts/date-range';
import { __setSession } from './a11y-stubs/session';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { bundleEstimateLabel, bundleProgressLabel, countLabel, progressLabel } from '../src/lib/export-jobs';
import { auditActionLabel } from '../src/lib/audit-labels';
import { OfficeBundleExport } from '../src/components/admin/OfficeBundleExport';
import { ExportsPanel } from '../src/components/exports/ExportsPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
// openDownload() clicks a detached anchor; record the URLs instead of a DOM.
const opened: string[] = [];
async function withDocument(run: () => Promise<void>) {
  g.document = { createElement: () => ({ set href(value: string) { opened.push(value); }, click() {}, remove() {} }), body: { appendChild() {} } };
  try { await run(); } finally { delete g.document; }
}

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  if (pass) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const one = (root: ReactTestInstance, id: string) => {
  const found = byTestId(root, id);
  if (found.length !== 1) throw new Error(`Expected one ${id}; found ${found.length}`);
  return found[0];
};
const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : textOf(child as ReactTestInstance)).join('');
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const press = async (node: ReactTestInstance) => { await act(async () => { node.props.onClick?.({ preventDefault() {} }); }); await settle(); };

// ─── Fixture ─────────────────────────────────────────────────────────────────

const OFFICE = { id: 'office-1', name: 'Lakeside Med Spa' };
const OTHER_OFFICE = { id: 'office-2', name: 'Harbor Wellness' };
const BASE_OPTIONS = [
  { kind: 'patient_activity', label: 'Patient activity', ranged: true, needsOffice: true, needsPatient: false },
  { kind: 'office_comparison', label: 'Office comparison', ranged: true, needsOffice: false, needsPatient: false },
];
const BUNDLE_OPTION = { kind: 'office_bundle', label: 'Entire office record', ranged: false, needsOffice: true, needsPatient: false };
const expires = new Date(Date.now() + 47 * 3600_000).toISOString();
const bundleJob = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'office_bundle', label: 'Entire office record', status,
  scope: { providerId: OFFICE.id, officeName: OFFICE.name, patientId: null, patientName: null },
  range: null, fileName: 'thinnr_office-bundle_lakeside-med-spa_2026-09-19_part-001.zip', sizeBytes: null, rowCount: null, error: null,
  createdAt: '2026-09-19T14:05:00Z', completedAt: null, expiresAt: expires, downloadCount: 0, downloadable: false,
  parts: null, progress: null, omittedFiles: null, includeTombstones: false, ...extra,
});
const READY_PARTS = [
  { part: 1, fileName: 'thinnr_office-bundle_lakeside-med-spa_2026-09-19_part-001.zip', sizeBytes: 64_000_000, fileCount: 412 },
  { part: 2, fileName: 'thinnr_office-bundle_lakeside-med-spa_2026-09-19_part-002.zip', sizeBytes: 21_000_000, fileCount: 130 },
  { part: 3, fileName: 'thinnr_office-bundle_lakeside-med-spa_2026-09-19_part-003.zip', sizeBytes: 90_000, fileCount: 10 },
];
const RUNNING_PROGRESS = { stage: 'patients', partsDone: 3, partsTotal: null, patientsDone: 120, patientsTotal: 480, bytesWritten: 1_288_490_189 };

let available: Array<Record<string, unknown>> = [...BASE_OPTIONS, BUNDLE_OPTION];
let jobs: Array<Record<string, unknown>> = [];
let estimate: Record<string, unknown> | { error: string; status: number } = { office: OFFICE, patientCount: 480, tombstoneCount: 12, estimatedBytes: 4_831_838_208, snapshotDate: '2026-09-18' };
const requests: Array<{ url: string; method: string; body: any }> = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ url, method, body });
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  const parsed = new URL(url, 'https://ops.test');
  if (parsed.pathname.endsWith('/api/exports/office-bundle/estimate') && method === 'GET') {
    if ('error' in estimate && 'status' in estimate) return json({ error: estimate.error }, estimate.status as number);
    return json(estimate);
  }
  if (parsed.pathname.endsWith('/api/exports') && method === 'GET') return json({ jobs, available, ttlHours: 48 });
  if (parsed.pathname.endsWith('/api/exports') && method === 'POST') {
    if (!available.some((option) => option.kind === body.kind)) return json({ error: 'Only HQ with provider management can export an entire office.' }, 403);
    const job = bundleJob(`exp-${requests.length}`, 'queued', { includeTombstones: body.includeTombstones === true });
    jobs = [job, ...jobs];
    return json({ job }, 202);
  }
  const download = /\/api\/exports\/([^/]+)\/download-url$/.exec(parsed.pathname);
  if (download && method === 'GET') {
    const part = Number(parsed.searchParams.get('part') ?? '1');
    return json({ url: `https://signed.test/${download[1]}/part${part}.zip`, fileName: `part${part}.zip`, expiresInSeconds: 600, part });
  }
  throw new Error(`not under test: ${method} ${url}`);
};

const renderers: ReactTestRenderer[] = [];
async function render(element: React.ReactElement) {
  const loc = memoryLocation({ path: `/admin/accounts/${OFFICE.id}`, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DateRangeProvider>
          <Router hook={loc.hook}>{element}</Router>
        </DateRangeProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  renderers.push(renderer!);
  return { root: renderer!.root };
}
const hq = () => {
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin', providerAccountCode: null });
  __setSupabaseSession('hq-token');
};
const control = (office = OFFICE) => <OfficeBundleExport officeId={office.id} officeName={office.name} />;
const exportCalls = () => requests.filter((r) => r.url.includes('/api/exports'));

// ─── Pure half ───────────────────────────────────────────────────────────────

console.log('pure: labels');
{
  check('bundle progress names patients, parts, and bytes', progressLabel('running', RUNNING_PROGRESS as any) === 'Packing patient records · 120 of 480 patients · 3 parts · 1.20 GB written', progressLabel('running', RUNNING_PROGRESS as any));
  check('before the count lands the label stays generic', bundleProgressLabel({ stage: 'patients', partsDone: 0, partsTotal: null, patientsDone: 0, patientsTotal: null, bytesWritten: 0 }) === 'Packing patient records…');
  check('office stage names the business records', bundleProgressLabel({ stage: 'office', partsDone: 4, partsTotal: null }).startsWith('Writing office records'));
  check('queued bundles read as waiting', progressLabel('queued', RUNNING_PROGRESS as any) === 'Waiting to start');
  check('estimate label cites the snapshot', bundleEstimateLabel({ estimatedBytes: 4_831_838_208, snapshotDate: '2026-09-18' }) === "About 4.50 GB (this office's share of the Sep 18 size snapshot)", bundleEstimateLabel({ estimatedBytes: 4_831_838_208, snapshotDate: '2026-09-18' }));
  check('no snapshot → honest unknown', bundleEstimateLabel({ estimatedBytes: null, snapshotDate: null }).startsWith('Size unknown'));
  check('bundles count files', countLabel({ kind: 'office_bundle', rowCount: 552 }) === '552 files');
  check('audit labels for both actions', auditActionLabel('office_bundle_export_requested').includes('entire office') && auditActionLabel('office_bundle_export_downloaded').toLowerCase().includes('bundle'));
}

// ─── Office account page control ─────────────────────────────────────────────

console.log('\ncontrol: HQ with provider management sees the button and confirms with the estimate');
{
  hq();
  requests.length = 0;
  jobs = [];
  available = [...BASE_OPTIONS, BUNDLE_OPTION];
  const { root } = await render(control());
  check('button renders when the server offers office_bundle', byTestId(root, 'button-export-office-record').length === 1);
  check('estimate is not fetched until the dialog opens', !requests.some((r) => r.url.includes('/office-bundle/estimate')));
  await press(one(root, 'button-export-office-record'));
  const est = requests.find((r) => r.url.includes('/office-bundle/estimate'));
  check('opening fetches the estimate for this office', Boolean(est) && new URL(est!.url, 'https://ops.test').searchParams.get('office') === OFFICE.id, est?.url);
  check('patient and tombstone counts shown', textOf(one(root, 'text-office-bundle-patients')) === '480 patient records · 12 purged patients on file as tombstones', textOf(one(root, 'text-office-bundle-patients')));
  check('size estimate shown', textOf(one(root, 'text-office-bundle-size')).startsWith('About 4.50 GB'), textOf(one(root, 'text-office-bundle-size')));
  check('notice names HQ-only links and the 48 h expiry', textOf(one(root, 'text-office-bundle-notice')).includes('HQ-only') && textOf(one(root, 'text-office-bundle-notice')).includes('48 hours'));
  check('empty history copy', byTestId(root, 'text-office-bundles-empty').length === 1);
  check('confirm enabled once the estimate landed', one(root, 'button-office-bundle-confirm').props.disabled === false);

  // Tick the tombstones box, then confirm.
  await act(async () => { one(root, 'checkbox-office-bundle-tombstones').props.onChange({ target: { checked: true } }); });
  await press(one(root, 'button-office-bundle-confirm'));
  const post = exportCalls().find((r) => r.method === 'POST');
  check('confirm posts the bundle kind for this office with tombstones', Boolean(post) && post!.body.kind === 'office_bundle' && post!.body.office === OFFICE.id && post!.body.includeTombstones === true, JSON.stringify(post?.body));
  const queuedId = jobs[0].id as string;
  check('the queued job lists immediately', byTestId(root, `office-bundle-${queuedId}`).length === 1 && textOf(one(root, `text-office-bundle-progress-${queuedId}`)) === 'Waiting to start');
  check('summary notes the tombstones', textOf(one(root, `text-office-bundle-summary-${queuedId}`)).includes('with tombstones'));
  check('confirm locks while a bundle is in flight', one(root, 'button-office-bundle-confirm').props.disabled === true && textOf(one(root, 'button-office-bundle-confirm')).includes('in progress'));

  await press(one(root, 'button-office-bundle-cancel'));
  check('close hides the dialog', byTestId(root, 'dialog-office-bundle-export').length === 0);

  // The build progresses: patients done / total and bytes written. The list
  // polls on its own interval; a fresh mount stands in for the next poll.
  jobs = [{ ...jobs[0], status: 'running', progress: RUNNING_PROGRESS }];
  const second = await render(control());
  await press(one(second.root, 'button-export-office-record'));
  check('running bundle shows patients done / total and bytes', textOf(one(second.root, `text-office-bundle-progress-${queuedId}`)) === 'Packing patient records · 120 of 480 patients · 3 parts · 1.20 GB written', textOf(one(second.root, `text-office-bundle-progress-${queuedId}`)));

  // Ready: per-part downloads, omitted-files note.
  jobs = [{ ...jobs[0], status: 'ready', progress: null, downloadable: true, sizeBytes: 85_090_000, rowCount: 552, parts: READY_PARTS, omittedFiles: 2, completedAt: '2026-09-19T14:40:00Z' }];
  const third = await render(control());
  const { root: ready } = third;
  await press(one(ready, 'button-export-office-record'));
  check('ready bundle offers one download per part', [1, 2, 3].every((n) => byTestId(ready, `button-download-export-${queuedId}-part-${n}`).length === 1) && byTestId(ready, `button-download-export-${queuedId}`).length === 0);
  check('summary shows files, size, and parts', textOf(one(ready, `text-office-bundle-summary-${queuedId}`)).includes('552 files') && textOf(one(ready, `text-office-bundle-summary-${queuedId}`)).includes('3 parts'));
  check('omitted-file note', textOf(one(ready, `text-office-bundle-omitted-${queuedId}`)).startsWith('2 stored files were not found'));
  check('confirm unlocks again once ready', one(ready, 'button-office-bundle-confirm').props.disabled === false);
  requests.length = 0;
  opened.length = 0;
  await withDocument(() => press(one(ready, `button-download-export-${queuedId}-part-3`)));
  const dl = requests.find((r) => r.url.includes('/download-url'));
  check('part download mints a link for that part (?part=3)', Boolean(dl) && new URL(dl!.url, 'https://ops.test').searchParams.get('part') === '3', dl?.url);
  check('the signed link is opened', opened.length === 1 && opened[0].endsWith('/part3.zip'), opened.join('|'));

  // Failed and expired copy.
  jobs = [
    bundleJob('exp-failed', 'failed', { error: 'Storage unavailable while writing part 4.' }),
    bundleJob('exp-expired', 'expired', { expiresAt: new Date(Date.now() - 3600_000).toISOString() }),
  ];
  const again = await render(control());
  await press(one(again.root, 'button-export-office-record'));
  check('failed bundle shows the worker error', textOf(one(again.root, 'text-office-bundle-failed-exp-failed')) === 'Storage unavailable while writing part 4.');
  check('expired bundle explains and offers no download', textOf(one(again.root, 'office-bundle-exp-expired')).includes('expired and was removed') && byTestId(again.root, 'button-download-export-exp-expired').length === 0);
}

console.log('\ncontrol: only this office\'s bundles are listed');
{
  hq();
  jobs = [
    bundleJob('exp-mine', 'ready', { downloadable: true, parts: [READY_PARTS[0]], sizeBytes: 64_000_000, rowCount: 412 }),
    bundleJob('exp-theirs', 'ready', { downloadable: true, parts: [READY_PARTS[0]], sizeBytes: 64_000_000, rowCount: 412, scope: { providerId: OTHER_OFFICE.id, officeName: OTHER_OFFICE.name, patientId: null, patientName: null } }),
  ];
  const { root } = await render(control());
  await press(one(root, 'button-export-office-record'));
  check('other offices\' bundles stay out of this dialog', byTestId(root, 'office-bundle-exp-mine').length === 1 && byTestId(root, 'office-bundle-exp-theirs').length === 0);
}

console.log('\ncontrol: no size snapshot yet, and an estimate failure');
{
  hq();
  jobs = [];
  estimate = { office: OFFICE, patientCount: 1, tombstoneCount: 0, estimatedBytes: null, snapshotDate: null };
  const { root } = await render(control());
  await press(one(root, 'button-export-office-record'));
  check('singular patient, no tombstone clause', textOf(one(root, 'text-office-bundle-patients')) === '1 patient record');
  check('size reads as unknown before the first snapshot', textOf(one(root, 'text-office-bundle-size')).startsWith('Size unknown'));
  check('confirm still enabled (the count is known)', one(root, 'button-office-bundle-confirm').props.disabled === false);

  estimate = { error: 'Could not estimate that export right now.', status: 502 };
  const failed = await render(control());
  await press(one(failed.root, 'button-export-office-record'));
  await settle(20);
  check('estimate failure is shown and blocks confirm', textOf(one(failed.root, 'text-office-bundle-estimate')).includes('Could not estimate') && one(failed.root, 'button-office-bundle-confirm').props.disabled === true, textOf(one(failed.root, 'text-office-bundle-estimate')));
  estimate = { office: OFFICE, patientCount: 480, tombstoneCount: 12, estimatedBytes: 4_831_838_208, snapshotDate: '2026-09-18' };
}

console.log('\ncontrol: hidden without the office_bundle option; refused requests surface the server message');
{
  hq();
  jobs = [];
  available = [...BASE_OPTIONS];
  const { root } = await render(control());
  check('server offers no office_bundle kind → no button', byTestId(root, 'button-export-office-record').length === 0);

  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null, providerAccountCode: '483920' });
  const staff = await render(control());
  check('office staff never see it', byTestId(staff.root, 'button-export-office-record').length === 0);

  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null, providerAccountCode: null });
  requests.length = 0;
  const demo = await render(control());
  check('signed-out (demo) renders nothing and never calls the API', byTestId(demo.root, 'button-export-office-record').length === 0 && requests.length === 0);

  hq();
  available = [...BASE_OPTIONS, BUNDLE_OPTION];
  const refused = await render(control());
  await press(one(refused.root, 'button-export-office-record'));
  available = [...BASE_OPTIONS]; // access changed underneath: the POST now 403s
  await press(one(refused.root, 'button-office-bundle-confirm'));
  check('403 message is shown inline', textOf(one(refused.root, 'text-office-bundle-error')).includes('provider management'), byTestId(refused.root, 'text-office-bundle-error').map(textOf).join('|'));
}

// ─── Exports panel ──────────────────────────────────────────────────────────

console.log('\nexports panel: bundle kind hidden from the picker, jobs listed with progress and parts');
{
  hq();
  requests.length = 0;
  available = [...BASE_OPTIONS, BUNDLE_OPTION];
  jobs = [
    bundleJob('exp-ready', 'ready', { downloadable: true, sizeBytes: 85_090_000, rowCount: 552, parts: READY_PARTS, includeTombstones: true, completedAt: '2026-09-19T14:40:00Z' }),
    bundleJob('exp-running', 'running', { progress: RUNNING_PROGRESS }),
  ];
  const { root } = await render(<ExportsPanel officeOptions={[OFFICE, OTHER_OFFICE]} />);
  const options = one(root, 'select-export-kind').findAll((node) => node.type === 'option').map((node) => node.props.value);
  check('request picker offers no office_bundle kind', options.length === 2 && !options.includes('office_bundle'), options.join(','));
  check('bundle job scope line names the office, files, parts, and tombstones', textOf(one(root, 'text-export-scope-exp-ready')).startsWith(OFFICE.name) && textOf(one(root, 'text-export-scope-exp-ready')).includes('552 files') && textOf(one(root, 'text-export-scope-exp-ready')).includes('3 parts') && textOf(one(root, 'text-export-scope-exp-ready')).includes('tombstones'), textOf(one(root, 'text-export-scope-exp-ready')));
  check('bundle job downloads per part', [1, 2, 3].every((n) => byTestId(root, `button-download-export-exp-ready-part-${n}`).length === 1) && byTestId(root, 'button-download-export-exp-ready').length === 0);
  check('running bundle shows patients done / total and bytes', textOf(one(root, 'text-export-progress-exp-running')) === 'Packing patient records · 120 of 480 patients · 3 parts · 1.20 GB written');
}

// ─── Office account page wiring ─────────────────────────────────────────────

console.log('\naccount page: mounts the control with the office account');
{
  const source = readFileSync(new URL('../src/pages/admin/AccountDetail.tsx', import.meta.url), 'utf8');
  check('AccountDetail imports the control', source.includes("import { OfficeBundleExport } from '@/components/admin/OfficeBundleExport'"));
  check('AccountDetail renders it with the account id and name', /<OfficeBundleExport officeId=\{account\.id\} officeName=\{account\.officeName\} \/>/.test(source));
}

for (const renderer of renderers) await act(async () => { renderer.unmount(); });
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll office bundle checks passed.');
