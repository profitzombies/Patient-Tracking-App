/**
 * Staff download of a patient's full record (right-of-access copy).
 *
 *   pnpm --filter @workspace/thinnr-operations run test:patient-record-export
 *
 * Renders the REAL patient record page and the shared Exports panel under
 * react-test-renderer with a scripted global fetch (session / provider scope
 * / Radix dialog stubbed via tsconfig.patient-record-export.json). Covers:
 *   - the "Download full record" button follows the server's export options:
 *     owners/admins (patient_record offered) see it, office staff do not;
 *   - confirming posts { kind: patient_record, patientId, office } — office
 *     staff send office null, the HQ drill-in sends the scoped office id;
 *   - the dialog lists this patient's record exports with build progress
 *     while queued/running, one download button per ZIP part when ready,
 *     the omitted-files note, and failed/expired copy;
 *   - a part download mints a signed link for that part (?part=N);
 *   - the Exports panel hides patient-level kinds from its request dropdown
 *     but lists the job with the patient's name and per-part downloads;
 *   - audit labels for both new actions; the office audit filter offers them.
 *
 * Pure half: progress / part / count labels.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { DateRangeProvider } from '../src/contexts/date-range';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import type { OfficePatientDetail } from '../src/lib/office-roster';
import { countLabel, formatBytes, partLabel, progressLabel } from '../src/lib/export-jobs';
import { auditActionLabel } from '../src/lib/audit-labels';
import PatientDetail from '../src/pages/PatientDetail';
import { ExportsPanel } from '../src/components/exports/ExportsPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
// openDownload() clicks a detached anchor; record the URLs instead of a DOM.
// (A global `document` would wake the Stripe loader, so it exists only
// around the download click.)
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

const AS_OF = '2026-09-17';
const PATIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const OFFICE = { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' };
const DETAIL: OfficePatientDetail = {
  office: OFFICE,
  patient: {
    identity: { id: PATIENT_ID, name: 'Devon Records', email: null, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true, dateOfBirth: null, height: null, timezone: 'America/New_York', createdAt: '2026-06-01T00:00:00Z', claimedAt: null, lastLoginAt: null },
    program: { id: 'metabolic', startDate: '2026-06-01', startingWeight: 210, currentWeight: 198, goalWeight: 180, weightChange: -12, lastLogDate: AS_OF },
    version: '2026-09-01T00:00:00.000Z',
    deletion: null,
  },
  diary: { entries: [], nutritionTotals: { overall: { calories: 0, protein: 0, carbs: 0, fat: 0 }, byDate: [] } },
  water: [], checkIns: [], weights: [{ dateKey: '2026-06-01', weight: 210 }], providerNotes: [], staffWeights: [], bodyMeasurements: [], progressPhotos: [],
  account: { targets: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, favorites: [], recents: [], customFoods: [], savedRecipes: [], flags: {} },
} as OfficePatientDetail;

const BASE_OPTIONS = [
  { kind: 'patient_activity', label: 'Patient activity', ranged: true, needsOffice: false, needsPatient: false },
  { kind: 'training_completion', label: 'Training completion', ranged: true, needsOffice: false, needsPatient: false },
];
const RECORD_OPTION = { kind: 'patient_record', label: 'Patient full record', ranged: false, needsOffice: false, needsPatient: true };
const expires = new Date(Date.now() + 23 * 3600_000).toISOString();
const baseJob = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'patient_record', label: 'Patient full record', status,
  scope: { providerId: OFFICE.providerId, officeName: OFFICE.officeName, patientId: PATIENT_ID, patientName: 'Devon Records' },
  range: null, fileName: `patient-record-${PATIENT_ID.slice(0, 8)}-part1.zip`, sizeBytes: null, rowCount: null, error: null,
  createdAt: '2026-09-17T14:05:00Z', completedAt: null, expiresAt: expires, downloadCount: 0, downloadable: false,
  parts: null, progress: null, omittedFiles: null, ...extra,
});
const READY_PARTS = [
  { part: 1, fileName: 'patient-record-bbbbbbbb-part1.zip', sizeBytes: 871_000_000, fileCount: 214 },
  { part: 2, fileName: 'patient-record-bbbbbbbb-part2.zip', sizeBytes: 312_500_000, fileCount: 61 },
];

let available: Array<Record<string, unknown>> = [...BASE_OPTIONS, RECORD_OPTION];
let jobs: Array<Record<string, unknown>> = [];
const requests: Array<{ url: string; method: string; body: any }> = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ url, method, body });
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  const parsed = new URL(url, 'https://ops.test');
  if (parsed.pathname.endsWith('/api/exports') && method === 'GET') {
    const patient = parsed.searchParams.get('patient');
    return json({ jobs: patient ? jobs.filter((job) => (job.scope as any).patientId === patient) : jobs, available, ttlHours: 24 });
  }
  if (parsed.pathname.endsWith('/api/exports') && method === 'POST') {
    if (!available.some((option) => option.kind === body.kind)) return json({ error: "Only office owners and admins can download a patient's full record." }, 403);
    const job = baseJob(`exp-${requests.length}`, 'queued');
    jobs = [job, ...jobs];
    return json({ job }, 202);
  }
  const download = /\/api\/exports\/([^/]+)\/download-url$/.exec(parsed.pathname);
  if (download && method === 'GET') {
    const part = Number(parsed.searchParams.get('part') ?? '1');
    return json({ url: `https://signed.test/${download[1]}/part${part}.zip`, fileName: `part${part}.zip`, expiresInSeconds: 600, part });
  }
  if (url.includes('/notifications')) return json({ patientId: PATIENT_ID, outreach: { state: 'none' }, notifications: [] });
  if (url.includes('/medications')) return json({ medications: [], doseLogs: [], adherence: null, timeZone: 'UTC', today: AS_OF });
  if (url.includes('/coach-conversations') || url.includes('/coach-memories')) return json({ conversations: [], memories: [], total: 0 });
  if (url.includes('/api/office/patients/')) return json(DETAIL);
  // Other record panels (purchases, bloodwork, …) are not under test; a
  // rejected fetch parks them in their error states without masking ours.
  throw new Error(`not under test: ${method} ${url}`);
};

const renderers: ReactTestRenderer[] = [];
async function render(path: string, element: React.ReactElement) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DateRangeProvider>
          <PatientSessionProvider>
            <Router hook={loc.hook}>{element}</Router>
          </PatientSessionProvider>
        </DateRangeProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  renderers.push(renderer!);
  return { root: renderer!.root, loc };
}
const staff = () => {
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null, providerAccountCode: '483920' });
  __setScope(null);
  __setSupabaseSession('staff-token');
};
const record = () => <Route path="/patients/:id"><PatientDetail /></Route>;
const exportCalls = () => requests.filter((r) => r.url.includes('/api/exports'));

// ─── Pure half ───────────────────────────────────────────────────────────────

console.log('pure: labels');
{
  check('queued reads as waiting', progressLabel('queued', null) === 'Waiting to start');
  check('collecting stage', progressLabel('running', { stage: 'collecting', partsDone: null, partsTotal: null }) === 'Collecting the record…');
  check('writing part N of M counts the part in flight', progressLabel('running', { stage: 'writing', partsDone: 1, partsTotal: 3 }) === 'Writing part 2 of 3');
  check('all parts written reads as finishing', progressLabel('running', { stage: 'writing', partsDone: 3, partsTotal: 3 }) === 'Finishing…');
  check('unknown total still reports progress', progressLabel('running', { stage: 'writing', partsDone: 2, partsTotal: null }) === 'Writing archive · 2 parts done');
  check('part label', partLabel(READY_PARTS[1], 2) === 'Part 2 of 2 · 298.0 MB · 61 files', partLabel(READY_PARTS[1], 2));
  check('GB formatting', formatBytes(1_400_000_000) === '1.30 GB' && formatBytes(null) === null);
  check('archives count files, CSVs count rows', countLabel({ kind: 'patient_record', rowCount: 275 }) === '275 files' && countLabel({ kind: 'patient_activity', rowCount: 1 }) === '1 row' && countLabel({ kind: 'x', rowCount: null }) === null);
  check('audit labels name the patient record actions', auditActionLabel('patient_record_export_requested') === "Requested a patient's full record" && auditActionLabel('patient_record_export_downloaded') === "Downloaded a patient's full record");
}

// ─── Record page: owner/admin ───────────────────────────────────────────────

console.log('\nrecord page: owner requests, watches progress, downloads parts');
{
  staff();
  requests.length = 0;
  jobs = [];
  available = [...BASE_OPTIONS, RECORD_OPTION];
  const { root } = await render(`/patients/${PATIENT_ID}`, record());
  const listCalls = exportCalls().filter((r) => r.method === 'GET');
  check('page lists this patient\'s record exports (?patient=)', listCalls.length >= 1 && listCalls.every((r) => new URL(r.url, 'https://ops.test').searchParams.get('patient') === PATIENT_ID), listCalls.map((r) => r.url).join('|'));
  const button = one(root, 'button-download-full-record');
  check('button reads "Download full record"', textOf(button).includes('Download full record'));
  check('dialog closed until asked', byTestId(root, 'dialog-patient-record-export').length === 0);
  await press(button);
  const dialog = one(root, 'dialog-patient-record-export');
  const dialogText = textOf(dialog);
  check('dialog names the patient and what leaves the office', dialogText.includes("Download Devon Records's full record") && dialogText.includes('record-summary.pdf') && dialogText.includes('manifest.json'));
  check('dialog warns that request and downloads are audited', textOf(one(root, 'text-record-export-notice')).includes('recorded in the office audit log'));
  check('no archives yet', byTestId(root, 'text-record-exports-empty').length === 1);
  await press(one(root, 'button-record-export-confirm'));
  const post = exportCalls().find((r) => r.method === 'POST');
  check('confirm posts the patient-record request with the patient id and no office (office staff)', Boolean(post) && post!.body.kind === 'patient_record' && post!.body.patientId === PATIENT_ID && post!.body.office === null, JSON.stringify(post?.body));
  const queuedId = (jobs[0] as any).id as string;
  check('queued job appears with progress text', byTestId(root, `record-export-${queuedId}`).length === 1 && textOf(one(root, `text-record-export-progress-${queuedId}`)) === 'Waiting to start');
  check('confirm is held while an archive is in progress', one(root, 'button-record-export-confirm').props.disabled === true && textOf(one(root, 'button-record-export-confirm')).includes('Archive in progress'));

  await press(one(root, 'button-record-export-cancel'));
  check('close hides the dialog', byTestId(root, 'dialog-patient-record-export').length === 0);

  // Worker progress: running, part 2 of 2 in flight. The list polls on its
  // own interval; a fresh mount stands in for the next poll.
  jobs = [{ ...jobs[0], status: 'running', progress: { stage: 'writing', partsDone: 1, partsTotal: 2 } }];
  const second = await render(`/patients/${PATIENT_ID}`, record());
  await press(one(second.root, 'button-download-full-record'));
  check('running job shows which part is being written', textOf(one(second.root, `text-record-export-progress-${queuedId}`)) === 'Writing part 2 of 2');

  // Ready: two parts, one file missing from storage.
  jobs = [{ ...jobs[0], status: 'ready', progress: null, downloadable: true, sizeBytes: 1_183_500_000, rowCount: 275, parts: READY_PARTS, omittedFiles: 1, completedAt: '2026-09-17T14:12:00Z' }];
  const third = await render(`/patients/${PATIENT_ID}`, record());
  await press(one(third.root, 'button-download-full-record'));
  const parts = byTestId(third.root, `list-export-parts-${queuedId}`);
  check('ready job renders one download per part', parts.length === 1 && byTestId(third.root, `button-download-export-${queuedId}-part-1`).length === 1 && byTestId(third.root, `button-download-export-${queuedId}-part-2`).length === 1);
  check('part buttons carry part number, size and file count', textOf(one(third.root, `button-download-export-${queuedId}-part-1`)) === 'Part 1 of 2 · 830.7 MB · 214 files', textOf(one(third.root, `button-download-export-${queuedId}-part-1`)));
  check('omitted-file note points at the manifest', textOf(one(third.root, `text-record-export-omitted-${queuedId}`)).includes('1 stored file was not found in storage') && textOf(one(third.root, `text-record-export-omitted-${queuedId}`)).includes('manifest.json'));
  check('summary line counts files and parts', textOf(one(third.root, `record-export-${queuedId}`)).includes('275 files') && textOf(one(third.root, `record-export-${queuedId}`)).includes('2 parts'));
  check('confirm unlocks again once ready', one(third.root, 'button-record-export-confirm').props.disabled === false);
  requests.length = 0;
  opened.length = 0;
  await withDocument(() => press(one(third.root, `button-download-export-${queuedId}-part-2`)));
  const dl = requests.find((r) => r.url.includes('/download-url'));
  check('part download mints a link for that part (?part=2)', Boolean(dl) && new URL(dl!.url, 'https://ops.test').searchParams.get('part') === '2', dl?.url);
  check('the signed link is opened', opened.length === 1 && opened[0].endsWith('/part2.zip'), opened.join('|'));

  // Failed and expired copy.
  jobs = [
    { ...baseJob('exp-failed', 'failed', { error: 'Storage unavailable while writing part 1.' }) },
    { ...baseJob('exp-expired', 'expired', { expiresAt: new Date(Date.now() - 3600_000).toISOString() }) },
  ];
  const fourth = await render(`/patients/${PATIENT_ID}`, record());
  await press(one(fourth.root, 'button-download-full-record'));
  check('failed job shows the worker error', textOf(one(fourth.root, 'text-record-export-failed-exp-failed')) === 'Storage unavailable while writing part 1.');
  check('expired job explains and offers no download', textOf(one(fourth.root, 'record-export-exp-expired')).includes('expired and was removed') && byTestId(fourth.root, 'button-download-export-exp-expired').length === 0);
}

console.log('\nrecord page: office staff (not owner/admin) see no button');
{
  staff();
  requests.length = 0;
  jobs = [];
  available = [...BASE_OPTIONS];
  const { root } = await render(`/patients/${PATIENT_ID}`, record());
  check('server offers no patient_record kind → no button', byTestId(root, 'button-download-full-record').length === 0);
  check('the rest of the header still renders', byTestId(root, 'text-live-patient-name').length === 1);
}

console.log('\nrecord page: HQ drill-in sends the scoped office');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin', providerAccountCode: null });
  __setScope({ providerId: 'office-1', officeName: OFFICE.officeName, providerName: 'Dr. Beacon', providerRole: 'Owner' });
  __setSupabaseSession('hq-token');
  requests.length = 0;
  jobs = [];
  available = [{ ...RECORD_OPTION, needsOffice: true }];
  const { root } = await render(`/patients/${PATIENT_ID}`, record());
  await press(one(root, 'button-download-full-record'));
  await press(one(root, 'button-record-export-confirm'));
  const post = exportCalls().find((r) => r.method === 'POST');
  check('HQ request names the drilled-in office', Boolean(post) && post!.body.office === 'office-1' && post!.body.patientId === PATIENT_ID, JSON.stringify(post?.body));
}

console.log('\nrecord page: a refused request surfaces the server message');
{
  staff();
  requests.length = 0;
  jobs = [];
  available = [...BASE_OPTIONS, RECORD_OPTION];
  const { root } = await render(`/patients/${PATIENT_ID}`, record());
  await press(one(root, 'button-download-full-record'));
  available = [...BASE_OPTIONS]; // role changed underneath: the POST now 403s
  await press(one(root, 'button-record-export-confirm'));
  check('403 message is shown inline', textOf(one(root, 'text-record-export-error')).includes('owners and admins'), byTestId(root, 'text-record-export-error').map(textOf).join('|'));
}

// ─── Exports panel ──────────────────────────────────────────────────────────

console.log('\nexports panel: patient kinds hidden from the picker, jobs listed with parts');
{
  staff();
  requests.length = 0;
  available = [...BASE_OPTIONS, RECORD_OPTION];
  jobs = [
    { ...baseJob('exp-ready', 'ready', { downloadable: true, sizeBytes: 1_183_500_000, rowCount: 275, parts: READY_PARTS, completedAt: '2026-09-17T14:12:00Z' }) },
    { ...baseJob('exp-running', 'running', { progress: { stage: 'collecting', partsDone: null, partsTotal: null } }) },
    { id: 'exp-csv', kind: 'patient_activity', label: 'Patient activity', status: 'ready', scope: { providerId: 'office-1', officeName: OFFICE.officeName, patientId: null, patientName: null }, range: { start: '2026-09-01', end: '2026-09-17' }, fileName: 'patient-activity.csv', sizeBytes: 2048, rowCount: 12, error: null, createdAt: '2026-09-17T13:00:00Z', completedAt: '2026-09-17T13:00:05Z', expiresAt: expires, downloadCount: 0, downloadable: true, parts: null, progress: null, omittedFiles: null },
  ];
  const { root } = await render('/analytics', <ExportsPanel pinnedOffice={{ id: '', name: OFFICE.officeName }} />);
  const options = one(root, 'select-export-kind').findAll((node) => node.type === 'option').map((node) => node.props.value);
  check('request picker offers no patient-level kind', options.length === 2 && !options.includes('patient_record'), options.join(','));
  check('record job shows the patient name in its scope line', textOf(one(root, 'text-export-scope-exp-ready')).startsWith('Devon Records · Beacon Hill Aesthetics') && textOf(one(root, 'text-export-scope-exp-ready')).includes('275 files') && textOf(one(root, 'text-export-scope-exp-ready')).includes('2 parts'));
  check('record job downloads per part', byTestId(root, 'button-download-export-exp-ready-part-1').length === 1 && byTestId(root, 'button-download-export-exp-ready-part-2').length === 1 && byTestId(root, 'button-download-export-exp-ready').length === 0);
  check('running record job shows progress', textOf(one(root, 'text-export-progress-exp-running')) === 'Collecting the record…');
  check('CSV job keeps its single download and row count', byTestId(root, 'button-download-export-exp-csv').length === 1 && textOf(one(root, 'text-export-scope-exp-csv')).includes('12 rows'));
  requests.length = 0;
  await withDocument(() => press(one(root, 'button-download-export-exp-ready-part-1')));
  const dl = requests.find((r) => r.url.includes('/download-url'));
  check('panel part download requests ?part=1', Boolean(dl) && new URL(dl!.url, 'https://ops.test').searchParams.get('part') === '1', dl?.url);
}

for (const renderer of renderers) await act(async () => { renderer.unmount(); });
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll patient record export checks passed.');
