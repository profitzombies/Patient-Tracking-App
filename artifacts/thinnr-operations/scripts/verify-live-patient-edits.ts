/**
 * Live patient-record edits regression suite (desktop provider portal).
 *
 * Behavioral half: runs the REAL src/lib/office-roster.ts mutation client
 * against a scripted global fetch — every write hits the office-scoped
 * patient path with the right verb, echoes the record version, scopes HQ
 * drill-ins to their explicit office, and maps the server's stale-save
 * (409 record_changed), permission (403), and field-keyed failures onto the
 * OfficeRosterError flags the edit surfaces branch on.
 *
 * Source half: pins the wiring a unit test can't reach — write controls sit
 * behind the shared edit gate, conflicts render a reload state instead of a
 * retry, notes announce their staff-only boundary, paused/discharged badge on
 * the roster, and the guided demo record (DemoPatientDetail) stays exactly
 * the synthetic, no-live-call path it was.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:live-patient-edits
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OfficeRosterError,
  RECORD_CHANGED_MESSAGE,
  addProviderNote,
  deleteProviderNote,
  deleteStaffWeight,
  recordStaffWeight,
  setPatientStatus,
  updatePatientProfile,
  updateStaffWeight,
} from '@/lib/office-roster';
import { __resetSupabaseStub, __setSession } from '@/lib/supabase';

let checks = 0;
function check(name: string, run: () => void | Promise<void>): Promise<void> {
  checks += 1;
  return Promise.resolve()
    .then(run)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((error) => {
      console.error(`  ✗ ${name}`);
      throw error;
    });
}

interface Recorded { url: string; method: string; headers: Record<string, string>; body: unknown }
let requests: Recorded[] = [];
let responses: Array<{ status: number; json: unknown }> = [];

global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const next = responses.shift();
  if (!next) throw new Error('fetch called with no scripted response');
  requests.push({
    url: String(input),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  return new Response(JSON.stringify(next.json), { status: next.status, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

function reset() {
  requests = [];
  responses = [];
  __resetSupabaseStub();
  __setSession('tok-1');
}

const PATIENT = { identity: { id: 'pat-1', name: 'Casey Ortiz' }, program: {}, version: '2026-01-06T08:00:00+00:00' };
const V1 = '2026-01-06T08:00:00+00:00';

async function main() {
  console.log('Mutation client against a scripted API:');

  await check('every write uses the office patient path, the right verb, and the session bearer', async () => {
    reset();
    responses = [
      { status: 200, json: { patient: PATIENT } },
      { status: 200, json: { patient: PATIENT } },
      { status: 201, json: { note: { id: 'n-1' } } },
      { status: 200, json: { deleted: true } },
      { status: 201, json: { weight: { id: 'w-1' }, patient: PATIENT } },
      { status: 200, json: { weight: { id: 'w-1' }, patient: PATIENT } },
      { status: 200, json: { deleted: true, patient: PATIENT } },
    ];
    await updatePatientProfile('pat-1', { firstName: 'Cass' }, V1);
    await setPatientStatus('pat-1', { status: 'paused', reason: 'Travel' }, V1);
    await addProviderNote('pat-1', 'Hydration discussed.');
    await deleteProviderNote('pat-1', 'n-1');
    await recordStaffWeight('pat-1', { dateKey: '2026-01-04', weight: 186.3, note: 'Office scale' });
    await updateStaffWeight('pat-1', 'w-1', { weight: 184 }, '2026-01-04T15:00:00Z');
    await deleteStaffWeight('pat-1', 'w-1', '2026-01-04T15:00:00Z');
    assert.deepEqual(requests.map((r) => [r.method, r.url]), [
      ['PATCH', '/api/office/patients/pat-1'],
      ['PATCH', '/api/office/patients/pat-1/status'],
      ['POST', '/api/office/patients/pat-1/notes'],
      ['DELETE', '/api/office/patients/pat-1/notes/n-1'],
      ['POST', '/api/office/patients/pat-1/weights'],
      ['PATCH', '/api/office/patients/pat-1/weights/w-1'],
      ['DELETE', '/api/office/patients/pat-1/weights/w-1'],
    ]);
    assert.ok(requests.every((r) => r.headers.Authorization === 'Bearer tok-1'));
    assert.ok(requests.every((r) => !r.url.includes('office=')), 'staff sessions send no office');
  });

  await check('record edits echo the version the read returned (null for legacy rows)', async () => {
    reset();
    responses = [
      { status: 200, json: { patient: PATIENT } },
      { status: 200, json: { patient: PATIENT } },
      { status: 200, json: { weight: {}, patient: PATIENT } },
      { status: 200, json: { deleted: true, patient: PATIENT } },
    ];
    await updatePatientProfile('pat-1', { email: 'cass@example.com' }, V1);
    await setPatientStatus('pat-1', { status: 'activated' }, null);
    await updateStaffWeight('pat-1', 'w-1', { note: null }, null);
    await deleteStaffWeight('pat-1', 'w-1', '2026-01-04T15:00:00Z');
    assert.deepEqual(requests[0].body, { email: 'cass@example.com', expectedVersion: V1 });
    assert.deepEqual(requests[1].body, { status: 'activated', expectedVersion: null });
    assert.deepEqual(requests[2].body, { note: null, expectedVersion: null });
    assert.deepEqual(requests[3].body, { expectedVersion: '2026-01-04T15:00:00Z' }, 'weight removal is version-guarded too');
  });

  await check('HQ drill-ins scope every write to their explicit office via the query string', async () => {
    reset();
    responses = Array.from({ length: 7 }, () => ({ status: 200, json: { patient: PATIENT, note: {}, weight: {}, deleted: true } }));
    await updatePatientProfile('pat-1', { firstName: 'Cass' }, V1, 'office-2');
    await setPatientStatus('pat-1', { status: 'paused', reason: 'x' }, V1, 'office-2');
    await addProviderNote('pat-1', 'note', 'office-2');
    await deleteProviderNote('pat-1', 'n-1', 'office-2');
    await recordStaffWeight('pat-1', { dateKey: '2026-01-04', weight: 180 }, 'office-2');
    await updateStaffWeight('pat-1', 'w-1', { weight: 179 }, null, 'office-2');
    await deleteStaffWeight('pat-1', 'w-1', null, 'office-2');
    assert.ok(requests.every((r) => r.url.endsWith('?office=office-2')), JSON.stringify(requests.map((r) => r.url)));
  });

  await check('a stale save surfaces as a conflict the UI must answer with reload, never a retry', async () => {
    reset();
    responses = [{ status: 409, json: { error: RECORD_CHANGED_MESSAGE, code: 'record_changed' } }];
    await assert.rejects(updatePatientProfile('pat-1', { firstName: 'Late' }, '1999-01-01T00:00:00Z'), (error: unknown) => {
      assert.ok(error instanceof OfficeRosterError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'record_changed');
      assert.equal(error.isConflict, true);
      assert.equal(error.isForbidden, false);
      return true;
    });
    // A unique-value 409 is NOT a conflict: it is a field error to show inline.
    reset();
    responses = [{ status: 409, json: { error: 'That email is already on a patient account. Use a different email.', field: 'email' } }];
    await assert.rejects(updatePatientProfile('pat-1', { email: 'taken@example.com' }, V1), (error: unknown) => {
      assert.ok(error instanceof OfficeRosterError);
      assert.equal(error.isConflict, false);
      assert.equal(error.field, 'email');
      return true;
    });
  });

  await check('permission denials and validation failures keep their server wording', async () => {
    reset();
    responses = [{ status: 403, json: { error: 'Your HQ role does not have permission to do this.' } }];
    await assert.rejects(addProviderNote('pat-1', 'x', 'office-1'), (error: unknown) => {
      assert.ok(error instanceof OfficeRosterError);
      assert.equal(error.isForbidden, true);
      assert.match(error.message, /does not have permission/);
      return true;
    });
    reset();
    responses = [{ status: 400, json: { error: 'Give a reason for pausing or discharging the patient.', field: 'reason' } }];
    await assert.rejects(setPatientStatus('pat-1', { status: 'paused' }, V1), (error: unknown) =>
      error instanceof OfficeRosterError && error.field === 'reason' && !error.isConflict);
    reset();
    responses = [{ status: 409, json: { error: 'A staff weigh-in already exists for that day. Correct it instead.', field: 'dateKey' } }];
    await assert.rejects(recordStaffWeight('pat-1', { dateKey: '2026-01-04', weight: 180 }), (error: unknown) =>
      error instanceof OfficeRosterError && error.field === 'dateKey' && !error.isConflict);
  });

  console.log('Page and component wiring:');

  const detailSource = readFileSync(new URL('../src/pages/PatientDetail.tsx', import.meta.url), 'utf8');
  const editsSource = readFileSync(new URL('../src/components/office/LivePatientEdits.tsx', import.meta.url), 'utf8');
  const patientsSource = readFileSync(new URL('../src/pages/Patients.tsx', import.meta.url), 'utf8');
  const filtersSource = readFileSync(new URL('../src/lib/roster-filters.ts', import.meta.url), 'utf8');
  const contractSource = readFileSync(new URL('../src/lib/office-roster.ts', import.meta.url), 'utf8');
  const demoSection = detailSource.match(/function DemoPatientDetail\(\)[\s\S]*?\n}\n/)?.[0] ?? '';
  const liveSection = detailSource.match(/function LivePatientDetail[\s\S]*?\nexport default function PatientDetail/)?.[0] ?? '';
  assert.ok(demoSection.length > 1000 && liveSection.length > 1000, 'detail page sections located');

  await check('write controls render only behind the shared edit gate (staff, or HQ Super Admin/Admin)', () => {
    assert.match(editsSource, /authRole === 'provider_staff'\) return true/);
    assert.match(editsSource, /authRole === 'hq_admin' && \(hqRole === 'Super Admin' \|\| hqRole === 'Admin'\)/);
    assert.match(liveSection, /const canEdit = useCanEditLiveRecord\(\)/);
    assert.match(liveSection, /\{canEdit && <div><EditPatientProfile/);
    assert.match(liveSection, /canRecordWeight = canEdit && activation !== null/);
    assert.match(liveSection, /\{canEdit && activation && \([\s\S]*?<PatientStatusControl/);
    assert.match(liveSection, /<ProviderNotes[^>]*canEdit=\{canEdit\}/);
    assert.match(liveSection, /\{canEdit && staff && <StaffWeightActions/);
  });

  await check('every write invalidates the detail and roster queries, and conflicts show a reload state', () => {
    assert.match(editsSource, /queryKey: livePatientQueryKey\(ctx\.office, ctx\.id\)/);
    assert.match(editsSource, /queryKey: officeRosterQueryKey\(ctx\.office\)/);
    assert.match(editsSource, /if \(error\.isConflict\) \{ setConflict\(true\); return null; \}/);
    assert.match(editsSource, /if \(error\.isForbidden\) \{ setForbidden\(error\.message\); return null; \}/);
    assert.match(editsSource, /Reload record/);
    assert.match(editsSource, /data-testid=\{testId\}/);
    for (const id of ['notice-profile-conflict', 'notice-status-conflict', 'notice-weight-conflict']) {
      assert.ok(editsSource.includes(`testId="${id}"`), id);
    }
    assert.match(liveSection, /queryKey: livePatientQueryKey\(office, id\)/);
  });

  await check('forms expose stable testids, announced errors, and the staff-only note boundary', () => {
    for (const id of [
      'button-edit-patient', 'button-edit-patient-save', 'button-change-status', 'button-status-save', 'input-status-reason',
      'button-add-provider-note', 'input-provider-note', 'button-provider-note-save', 'button-log-weight',
      'button-staff-weight-save', 'button-correct-weight-save', 'button-remove-weight',
    ]) {
      assert.ok(editsSource.includes(`data-testid="${id}"`) || liveSection.includes(`data-testid="${id}"`), id);
    }
    assert.match(editsSource, /data-testid=\{`input-edit-patient-\$\{key\}`\}/);
    assert.match(editsSource, /data-testid=\{`radio-status-\$\{value\}`\}/);
    assert.match(editsSource, /role="alert"/);
    assert.match(editsSource, /Provider notes never appear in the patient's app\./);
    assert.match(editsSource, /Paused and discharged patients stay in the roster but drop out of needs-attention outreach signals\./);
    assert.match(editsSource, /formatUsPhoneInput/);
  });

  await check('the live trend merges staff and patient readings with their source, and only staff rows get actions', () => {
    assert.match(contractSource, /source\?: 'patient' \| 'staff'/);
    assert.match(contractSource, /providerNotes: OfficeProviderNote\[\]/);
    assert.match(contractSource, /staffWeights: OfficeStaffWeight\[\]/);
    assert.match(contractSource, /version: string \| null;/);
    assert.match(liveSection, /entry\.source === 'staff' && entry\.id \? staffWeightsById\.get\(entry\.id\)/);
    assert.match(liveSection, /Patient check-in/);
    assert.match(liveSection, /data-testid=\{`weigh-in-\$\{entry\.dateKey\}-\$\{entry\.source \?\? 'patient'\}`\}/);
  });

  await check('the roster badges paused and discharged and offers them as live filters', () => {
    assert.match(contractSource, /status: 'invited' \| 'inactive' \| 'needs_attention' \| 'on_track' \| 'paused' \| 'discharged'/);
    assert.match(patientsSource, /status === 'discharged'/);
    // The status vocabulary lives in the shared filter model (the builder's
    // Status field and the quick sets); no native <select> remains on the page.
    assert.match(filtersSource, /\{ value: 'paused', label: 'Paused' \},\s*\{ value: 'discharged', label: 'Discharged' \},\s*\{ value: 'invited', label: 'Invited' \}/);
    assert.doesNotMatch(patientsSource, /<select\b/);
  });

  await check('the guided demo record is untouched: synthetic session only, no live client, no edit gate', () => {
    assert.match(detailSource, /if \(liveEnabled && id\) return <LivePatientDetail/);
    assert.match(detailSource, /return <DemoPatientDetail \/>;/);
    assert.match(demoSection, /usePatientSession\(\)/);
    assert.match(demoSection, /Synthetic record/);
    assert.match(demoSection, /addWeightEntry\(patient, \{ date: ANCHOR_ISO/);
    assert.match(demoSection, /Saved to this synthetic session\./);
    assert.doesNotMatch(demoSection, /useCanEditLiveRecord|EditPatientProfile|PatientStatusControl|ProviderNotes|StaffWeight|fetchOfficePatient|updatePatientProfile|setPatientStatus|addProviderNote|recordStaffWeight|\/api\//);
    // The demo half imports nothing from the live edit module either.
    const importBlock = detailSource.slice(0, detailSource.indexOf('function DemoPatientDetail'));
    assert.match(importBlock, /from "@\/components\/office\/LivePatientEdits"/);
    assert.doesNotMatch(demoSection, /LivePatientEdits/);
  });

  console.log(`\nLive patient edits (web) checks passed: ${checks}/${checks}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
