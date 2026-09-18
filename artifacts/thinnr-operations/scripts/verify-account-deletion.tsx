/**
 * Staff visibility of patient-initiated account deletion.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:account-deletion
 *
 * Rendered against the REAL pages under react-test-renderer (session /
 * scope / HQ-directory contexts stubbed via tsconfig.account-deletion.json,
 * global fetch scripted):
 *
 *   Roster (office staff)
 *     - a patient inside the deletion grace period keeps their row and gets
 *       a "Deletes in N days" chip; other rows carry no chip;
 *     - purged accounts arrive as PII-free tombstones and render only in a
 *       separate "Deleted accounts" section — never as roster rows, never
 *       with a name or contact;
 *     - the guided demo renders neither.
 *
 *   Record (office staff)
 *     - a pending deletion renders an alert banner with the countdown;
 *     - a purged id (HTTP 410) renders the record-removed notice with the
 *       tombstone facts and no clinical sections.
 *
 *   HQ account deletions
 *     - Admin sees the status summary, failed rows with their last error and
 *       step outcomes, and a Retry button that re-queues via the API;
 *     - only failed rows get Retry; the demo persona sees the unavailable note
 *       and makes no request.
 *
 * Pure half: the grace-countdown helper rounds up, never goes negative, and
 * reads "Deletion requested" when no schedule is loaded.
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
import { __setHqData } from './a11y-stubs/hq-data';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import type { DeletedAccount, OfficePatient, OfficePatientDetail, OfficeRoster } from '../src/lib/office-roster';
import { describeGrace, graceDaysLeft } from '../src/components/office/AccountDeletion';
import Patients from '../src/pages/Patients';
import PatientDetail from '../src/pages/PatientDetail';
import PatientDeletions from '../src/pages/admin/PatientDeletions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
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
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

// ─── Fixture ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const iso = (offsetDays: number) => new Date(NOW + offsetDays * 86_400_000).toISOString();
const AS_OF = new Date(NOW).toISOString().slice(0, 10);
const PENDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const PURGED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

function patient(id: string, name: string, extra: Partial<OfficePatient> = {}): OfficePatient {
  return {
    id, name, email: `${id}@example.com`, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true,
    createdAt: '2026-07-01T00:00:00Z', outreach: { state: 'none' } as OfficePatient['outreach'],
    program: { id: 'metabolic', day: 60, stage: 'protocol', week: 9, startDate: '2026-07-08', startingWeight: 210, currentWeight: 200, goalWeight: 170, weightChange: -10, lastLogDate: null },
    invitation: null,
    operational: { asOfDate: AS_OF, latestActivityDate: AS_OF, latestDiaryDate: AS_OF, latestWaterDate: null, latestCheckInDate: null, latestWeightDate: null, latestPhotoDate: null, loggedDays7: 3, checkIns7: 0, activity: null, status: 'on_track', reasons: [], followUps: [] },
    ...extra,
  } as OfficePatient;
}

const TOMBSTONE: DeletedAccount = { id: PURGED_ID, requestedAt: iso(-9), purgedAt: iso(-2), wasActivated: true, programId: 'metabolic', enrolledOn: '2026-05-02' };

const ROSTER: OfficeRoster = {
  office: { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' },
  patients: [
    patient('pat-plain', 'Kara Keeps'),
    patient(PENDING_ID, 'Devon Departing', { deletion: { state: 'requested', requestedAt: iso(-2), purgeAfter: iso(5) } }),
  ],
  summary: { totalPatients: 2, activePatients: 2, newEnrollments30d: 0, needsAttention: 0, attention: 0, inactive: 0, invited: 0, checkInsOverdue: 0, loggingLapsed: 0, deletionRequested: 1, deletedAccounts: 1, asOf: AS_OF },
  deletedAccounts: [TOMBSTONE],
};

function detailFixture(deletion: OfficePatientDetail['patient']['deletion']): OfficePatientDetail {
  return {
    office: ROSTER.office,
    patient: {
      identity: { id: PENDING_ID, name: 'Devon Departing', email: null, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true, dateOfBirth: null, height: null, timezone: 'America/New_York', createdAt: '2026-06-01T00:00:00Z', claimedAt: null, lastLoginAt: null },
      program: { id: 'metabolic', startDate: '2026-06-01', startingWeight: 210, currentWeight: 198, goalWeight: 180, weightChange: -12, lastLogDate: AS_OF },
      version: '2026-09-01T00:00:00.000Z',
      deletion,
    },
    diary: { entries: [], nutritionTotals: { overall: { calories: 0, protein: 0, carbs: 0, fat: 0 }, byDate: [] } },
    water: [], checkIns: [], weights: [{ dateKey: '2026-06-01', weight: 210 }], providerNotes: [], staffWeights: [], bodyMeasurements: [], progressPhotos: [],
    account: { targets: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, favorites: [], recents: [], customFoods: [], savedRecipes: [], flags: {} },
  } as OfficePatientDetail;
}

const failedDeletion = {
  id: 'del-failed', patientId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', providerId: 'office-1', status: 'failed', requestedAt: iso(-10), purgeAfter: iso(-3),
  cancelledAt: null, startedAt: iso(-3), purgedAt: null, attempts: 8, nextAttemptAt: null, lastError: 'object storage: delete patients/ccc…/photos/3.jpg returned 503',
  steps: { storage: { error: 'delete returned 503' }, rows: { ok: true }, auth: {} },
};
const purgedDeletion = {
  id: 'del-purged', patientId: PURGED_ID, providerId: 'office-1', status: 'purged', requestedAt: iso(-9), purgeAfter: iso(-2),
  cancelledAt: null, startedAt: iso(-2), purgedAt: iso(-2), attempts: 1, nextAttemptAt: null, lastError: null,
  steps: { storage: { ok: true, deleted: 12 }, rows: { ok: true }, auth: { ok: true } },
};
const pendingDeletion = {
  id: 'del-pending', patientId: PENDING_ID, providerId: 'office-1', status: 'pending', requestedAt: iso(-2), purgeAfter: iso(5),
  cancelledAt: null, startedAt: null, purgedAt: null, attempts: 0, nextAttemptAt: null, lastError: null, steps: {},
};
let hqDeletions = [failedDeletion, purgedDeletion, pendingDeletion];
const hqSummary = () => ({ pending: 0, cancelled: 0, purging: 0, purged: 0, failed: 0, ...Object.fromEntries(['pending', 'cancelled', 'purging', 'purged', 'failed'].map((s) => [s, hqDeletions.filter((d) => d.status === s).length])) });

const requests: Array<{ url: string; method: string }> = [];
let recordResponse: { status: number; body: unknown } = { status: 200, body: detailFixture({ state: 'requested', requestedAt: iso(-2), purgeAfter: iso(5) }) };
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ url, method });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/api/office/roster')) return json(ROSTER);
  if (url.includes('/notifications')) return json({ patientId: PENDING_ID, outreach: { state: 'none' }, notifications: [] });
  if (url.includes('/api/office/patients/')) return json(recordResponse.body, recordResponse.status);
  const retry = /\/api\/hq\/patient-deletions\/([^/]+)\/retry$/.exec(url);
  if (retry && method === 'POST') {
    const row = hqDeletions.find((d) => d.id === decodeURIComponent(retry[1]));
    if (!row) return json({ error: 'Deletion request not found.' }, 404);
    if (row.status !== 'failed') return json({ error: 'Only a failed purge can be retried.' }, 409);
    const updated = { ...row, status: 'pending', nextAttemptAt: iso(0), lastError: null };
    hqDeletions = hqDeletions.map((d) => (d.id === row.id ? updated : d));
    return json({ deletion: updated });
  }
  if (url.includes('/api/hq/patient-deletions')) {
    const status = new URL(url, 'https://ops.test').searchParams.get('status');
    return json({ deletions: hqDeletions.filter((d) => !status || d.status === status), summary: hqSummary() });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

async function render(path: string, element: React.ReactElement) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
  return { renderer: renderer!, root: renderer!.root, loc };
}

const rosterRows = (root: ReactTestInstance) => root.findAll((node) => node.type === 'tr' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Open '));

// ─── Pure half ───────────────────────────────────────────────────────────────

console.log('grace countdown helper');
{
  const at = new Date('2026-09-07T12:00:00Z');
  check('rounds partial days up', graceDaysLeft({ state: 'requested', requestedAt: 'x', purgeAfter: '2026-09-14T11:00:00Z' }, at) === 7);
  check('never negative once overdue', graceDaysLeft({ state: 'requested', requestedAt: 'x', purgeAfter: '2026-09-01T00:00:00Z' }, at) === 0 && describeGrace({ state: 'requested', requestedAt: 'x', purgeAfter: '2026-09-01T00:00:00Z' }, at) === 'Deletion due today');
  check('no schedule reads as requested', describeGrace({ state: 'requested', requestedAt: 'x', purgeAfter: null }, at) === 'Deletion requested');
  check('singular day', describeGrace({ state: 'requested', requestedAt: 'x', purgeAfter: '2026-09-08T11:00:00Z' }, at) === 'Deletes in 1 day');
}

// ─── Roster ──────────────────────────────────────────────────────────────────

console.log('\nroster: grace-period chip and tombstone section (signed-in staff)');
{
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null });
  __setScope(null);
  __setSupabaseSession('staff-token');
  const { root } = await render('/patients', <Patients />);
  const rows = rosterRows(root);
  check('both live patients remain roster rows; the tombstone is not a row', rows.length === 2 && !rows.some((row) => String(row.props['aria-label']).includes(PURGED_ID)), `rows=${rows.length}`);
  check('pending patient carries the countdown chip', byTestId(root, `chip-deletion-${PENDING_ID}`).some((chip) => textOf(chip) === 'Deletes in 5 days'), byTestId(root, `chip-deletion-${PENDING_ID}`).map(textOf).join('|'));
  check('the other patient carries no chip', byTestId(root, 'chip-deletion-pat-plain').length === 0);
  const section = byTestId(root, 'deleted-accounts');
  check('deleted accounts section renders once with the tombstone', section.length === 1 && byTestId(root, `deleted-account-${PURGED_ID}`).length === 1);
  const sectionText = section.length ? textOf(section[0]) : '';
  check('tombstone row shows enrolment, program and purge date only', sectionText.includes('Former patient') && sectionText.includes('METABOLIC') && sectionText.includes('Enrolled May 2, 2026') && sectionText.includes('Purged'));
  check('no PII in the section (no email, no name)', !sectionText.includes('@') && !sectionText.includes('Devon') && !sectionText.includes('Kara'));
  check('lifetime count reflects live rows only', textOf(root).includes('Showing 2 lifetime records'));
}

console.log('\nroster: guided demo renders neither');
{
  const before = requests.length;
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  __setSupabaseSession(null);
  const { root } = await render('/patients', <Patients />);
  check('demo: no live requests', requests.length === before);
  check('demo: no deletion chips or tombstone section', byTestId(root, 'deleted-accounts').length === 0 && root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('chip-deletion-')).length === 0);
}

// ─── Record ──────────────────────────────────────────────────────────────────

console.log('\nrecord: pending deletion banner');
{
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null, providerAccountCode: '483920' });
  __setSupabaseSession('staff-token');
  const { root } = await render(`/patients/${PENDING_ID}`, <Route path="/patients/:id"><PatientDetail /></Route>);
  const banner = byTestId(root, 'patient-deletion-banner');
  check('banner renders as an alert', banner.length === 1 && banner[0].props.role === 'alert');
  const text = banner.length ? textOf(banner[0]) : '';
  check('banner names the countdown and that only the patient can cancel', text.includes('permanently removed in 5 days') && text.includes('Only the patient can cancel'));
  check('record content still present during the grace period', byTestId(root, 'text-live-patient-name').length === 1);
}

console.log('\nrecord: purged (410) view');
{
  recordResponse = { status: 410, body: { error: 'This patient deleted their account. Their record has been permanently removed.', deleted: TOMBSTONE } };
  const { root } = await render(`/patients/${PURGED_ID}`, <Route path="/patients/:id"><PatientDetail /></Route>);
  const notice = byTestId(root, 'patient-record-deleted');
  check('record-removed notice renders', notice.length === 1);
  const text = notice.length ? textOf(notice[0]) : '';
  check('notice carries the server message and tombstone facts', text.includes('permanently removed') && text.includes('Enrolled') && text.includes('Purged') && text.includes('Requested'));
  check('no clinical sections or name on a purged record', byTestId(root, 'text-live-patient-name').length === 0 && !textOf(root).includes('Devon'));
  check('a back link to the roster is offered', root.findAll((node) => node.type === 'a' && node.props.href === '/patients').length === 1);
}

// ─── HQ ──────────────────────────────────────────────────────────────────────

console.log('\nHQ account deletions: admin view and retry');
{
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, hqRole: 'Admin' });
  __setHqData({ accounts: [{ id: 'office-1', officeName: 'Beacon Hill Aesthetics' }] });
  __setSupabaseSession('hq-token');
  const { root } = await render('/admin/audit/deletions', <PatientDeletions />);
  check('summary counts one failed purge', textOf(byTestId(root, 'metric-deletions-failed')[0]) === '1');
  const failedRow = byTestId(root, 'row-deletion-del-failed');
  check('failed row renders its last error and step outcomes', failedRow.length === 1 && textOf(failedRow[0]).includes('returned 503') && textOf(failedRow[0]).includes('storage: failed') && textOf(failedRow[0]).includes('rows: done') && textOf(failedRow[0]).includes('automatic retries exhausted'));
  check('office name resolves from the directory, patient shown by id only', textOf(failedRow[0]).includes('Beacon Hill Aesthetics') && textOf(failedRow[0]).includes('cccccccc-cccc') && !textOf(root).includes('@'));
  check('only the failed row offers Retry', byTestId(root, 'button-retry-deletion-del-failed').length === 1 && byTestId(root, 'button-retry-deletion-del-purged').length === 0 && byTestId(root, 'button-retry-deletion-del-pending').length === 0);
  await act(async () => { byTestId(root, 'button-retry-deletion-del-failed')[0].props.onClick(); });
  await settle();
  const retryCalls = requests.filter((r) => r.method === 'POST' && r.url.includes('/patient-deletions/del-failed/retry'));
  check('retry posts to the API once', retryCalls.length === 1, `calls=${retryCalls.length}`);
  check('after retry the row is pending again and the failed count drops', textOf(byTestId(root, 'metric-deletions-failed')[0]) === '0' && byTestId(root, 'button-retry-deletion-del-failed').length === 0 && textOf(byTestId(root, 'row-deletion-del-failed')[0]).includes('Pending'));
}

console.log('\nHQ account deletions: demo persona');
{
  const before = requests.length;
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
  __setSupabaseSession(null);
  const { root } = await render('/admin/audit/deletions', <PatientDeletions />);
  check('demo note shown, no table, no request', byTestId(root, 'text-deletions-demo-note').length === 1 && byTestId(root, 'deletions-summary').length === 0 && requests.length === before);
}

console.log(failures === 0 ? '\nall account-deletion checks passed' : `\n${failures} account-deletion check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
