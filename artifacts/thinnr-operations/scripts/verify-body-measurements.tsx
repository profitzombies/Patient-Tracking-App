/**
 * Body measurements — table math, Log a Visit validation, and the card on
 * both patient records (guided demo + live).
 *
 *   pnpm --filter @workspace/thinnr-operations run test:body-measurements
 *
 * Pure half: lib/body-measurements — inches parsing (positive, one decimal,
 * plausible range), the whole-form rule (a visit needs at least one
 * measurement), and the visit-by-area table (newest first, dash for
 * unmeasured, change since the FIRST visit that measured each area).
 *
 * Rendered half (react-test-renderer, contexts stubbed via
 * tsconfig.body-measurements.json):
 *   - LogVisitForm: inline errors land beside their field, a valid submit
 *     hands the parsed draft to onSave, a server field error is shown beside
 *     that area;
 *   - MeasurementTableView: columns newest first, dashes, change strings;
 *   - the REAL PatientDetail page as the guided demo persona renders the
 *     seeded visits with a Log a Visit button and session-held removals;
 *   - the REAL PatientDetail page as signed-in staff renders the API's visit
 *     list, hides the button until the patient has connected / for read-only roles, and removals call the
 *     office-scoped DELETE with the visit's version.
 *
 * Parity: the mobile app's seeded visits are byte-identical per patient.
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
import { MOCK_PATIENTS } from '../src/data/mock-data';
import { MOCK_PATIENTS as MOBILE_PATIENTS } from '../../thinnr-mobile/data/mock-data';
import { BODY_AREAS as MOBILE_BODY_AREAS } from '../../thinnr-mobile/data/body-measurements';
import {
  BODY_AREAS,
  buildMeasurementTable,
  formatInchesChange,
  parseInchesInput,
  totalInchesChange,
  validateVisitForm,
  type MeasurementVisit,
} from '../src/lib/body-measurements';
import { LogVisitForm, MeasurementTableView, summarizeVisits, type SaveOutcome } from '../src/components/patient/BodyMeasurements';
import type { OfficePatientDetail } from '../src/lib/office-roster';
import PatientDetail from '../src/pages/PatientDetail';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.confirm = () => true;

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
const oneByTestId = (root: ReactTestInstance, id: string) => {
  const matches = byTestId(root, id);
  if (matches.length !== 1) throw new Error(`expected exactly one [data-testid="${id}"], found ${matches.length}`);
  return matches[0];
};
const settle = async (ticks = 10) => { for (let i = 0; i < ticks; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

// ─── Pure half ───────────────────────────────────────────────────────────────

console.log('lib/body-measurements');
{
  check('ten areas in the agreed order', BODY_AREAS.map((area) => area.label).join(', ') === 'Neck, Chest, Left arm, Right arm, Waist, Hips, Left thigh, Right thigh, Left calf, Right calf');
  check('blank input is blank, not zero', parseInchesInput('  ').kind === 'blank');
  check('one decimal accepted and rounded', JSON.stringify(parseInchesInput('34.5')) === JSON.stringify({ kind: 'value', value: 34.5 }));
  check('integer accepted', JSON.stringify(parseInchesInput('40')) === JSON.stringify({ kind: 'value', value: 40 }));
  check('two decimals rejected', parseInchesInput('34.55').kind === 'error');
  check('zero rejected', parseInchesInput('0').kind === 'error');
  check('negative rejected', parseInchesInput('-3').kind === 'error');
  check('text rejected', parseInchesInput('abc').kind === 'error');
  check('out of range rejected', parseInchesInput('0.5').kind === 'error' && parseInchesInput('121').kind === 'error');
  check('boundary values accepted', parseInchesInput('1').kind === 'value' && parseInchesInput('120').kind === 'value');

  const today = '2026-09-06';
  const empty = validateVisitForm({ dateKey: today, note: '', inches: {} }, today);
  check('no measurements → form-level error, no value', empty.value === null && typeof empty.errors.measurements === 'string');
  const future = validateVisitForm({ dateKey: '2026-09-07', note: '', inches: { waist: '34' } }, today);
  check('future date rejected', future.value === null && typeof future.errors.dateKey === 'string');
  const mixed = validateVisitForm({ dateKey: today, note: '  ok  ', inches: { waist: '34.5', hips: '', neck: '14.25' } }, today);
  check('bad area keyed by area, others untouched', mixed.value === null && typeof mixed.errors.neck === 'string' && mixed.errors.waist === undefined && mixed.errors.measurements === undefined);
  const valid = validateVisitForm({ dateKey: today, note: '  Light clothing  ', inches: { waist: '34.5', hips: '', neck: '14' } }, today);
  check('valid form → trimmed note + measured areas only', JSON.stringify(valid.value) === JSON.stringify({ dateKey: today, note: 'Light clothing', measurements: { neck: 14, waist: 34.5 } }));
  const longNote = validateVisitForm({ dateKey: today, note: 'x'.repeat(501), inches: { waist: '34' } }, today);
  check('note capped at 500', longNote.value === null && typeof longNote.errors.note === 'string');

  const visits: MeasurementVisit[] = [
    { id: 'v1', dateKey: '2026-06-01', note: 'Baseline', measurements: { waist: 36, hips: 41, neck: 14.5 } },
    { id: 'v3', dateKey: '2026-09-01', note: null, measurements: { waist: 33.5, neck: 14 } },
    { id: 'v2', dateKey: '2026-07-15', note: null, measurements: { waist: 34.5, hips: 40, chest: 40 } },
  ];
  const table = buildMeasurementTable(visits);
  check('columns newest first', table.visits.map((visit) => visit.id).join(',') === 'v3,v2,v1');
  check('one row per area in order', table.rows.map((row) => row.key).join(',') === BODY_AREAS.map((area) => area.key).join(','));
  const waist = table.rows.find((row) => row.key === 'waist')!;
  check('waist: values newest first with change since first visit', JSON.stringify(waist.cells) === JSON.stringify([
    { visitId: 'v3', value: 33.5, change: -2.5 },
    { visitId: 'v2', value: 34.5, change: -1.5 },
    { visitId: 'v1', value: 36, change: null },
  ]));
  const chest = table.rows.find((row) => row.key === 'chest')!;
  check('chest: first measured on the middle visit is that area\'s baseline; others null', JSON.stringify(chest.cells) === JSON.stringify([
    { visitId: 'v3', value: null, change: null },
    { visitId: 'v2', value: 40, change: null },
    { visitId: 'v1', value: null, change: null },
  ]));
  const hips = table.rows.find((row) => row.key === 'hips')!;
  check('hips: unmeasured on newest → null, not zero', hips.cells[0].value === null && hips.cells[1].change === -1);
  check('never-measured area → all null', table.rows.find((row) => row.key === 'leftCalf')!.cells.every((cell) => cell.value === null && cell.change === null));
  check('change formatting uses a real minus sign', formatInchesChange(-1.5) === '−1.5 in' && formatInchesChange(0.4) === '+0.4 in' && formatInchesChange(0) === '0.0 in');
  check('total change sums each area\'s latest change', totalInchesChange(table) === -2.5 + -1 + -0.5);
  check('summary: lost inches', summarizeVisits(visits).includes('4.0 in lost'));
  check('summary: single visit', summarizeVisits([visits[0]]).includes('1 visit') && summarizeVisits([visits[0]]).includes('second visit'));
  check('empty table has no columns but keeps rows', buildMeasurementTable([]).visits.length === 0 && buildMeasurementTable([]).rows.length === BODY_AREAS.length);
}

console.log('seed parity with the mobile app');
{
  check('BODY_AREAS identical on web and mobile', JSON.stringify(BODY_AREAS) === JSON.stringify(MOBILE_BODY_AREAS));
  const mobileById = new Map(MOBILE_PATIENTS.map((patient) => [patient.id, patient]));
  const mismatched = MOCK_PATIENTS.filter((patient) => JSON.stringify(patient.bodyMeasurements) !== JSON.stringify(mobileById.get(patient.id)?.bodyMeasurements));
  check('every demo patient carries the same visits on both apps', mismatched.length === 0, mismatched.map((patient) => patient.id).join(','));
  check('every demo patient has 2–3 visits, each with ≥1 measurement', MOCK_PATIENTS.every((patient) => patient.bodyMeasurements.length >= 2 && patient.bodyMeasurements.length <= 3 && patient.bodyMeasurements.every((visit) => Object.keys(visit.measurements).length >= 1)));
  check('some follow-up visits skip areas (dashes appear in demos)', MOCK_PATIENTS.some((patient) => patient.bodyMeasurements.slice(1).some((visit) => Object.keys(visit.measurements).length < BODY_AREAS.length)));
  check('follow-ups shrink the waist', MOCK_PATIENTS.every((patient) => {
    const withWaist = patient.bodyMeasurements.filter((visit) => visit.measurements.waist !== undefined);
    return withWaist.length < 2 || withWaist.at(-1)!.measurements.waist! < withWaist[0].measurements.waist!;
  }));
  check('seeded values are one-decimal inches within range', MOCK_PATIENTS.every((patient) => patient.bodyMeasurements.every((visit) => Object.values(visit.measurements).every((value) => Math.abs(Math.round(value * 10) - value * 10) < 1e-6 && value >= 1 && value <= 120))));
  check('visit ids are patient-scoped and dates are date keys', MOCK_PATIENTS.every((patient) => patient.bodyMeasurements.every((visit) => visit.id.startsWith(`${patient.id}-visit-`) && /^\d{4}-\d{2}-\d{2}$/.test(visit.dateKey))));
}

// ─── Rendered: form ──────────────────────────────────────────────────────────

const TODAY = '2026-09-06';

async function renderForm(onSave: (draft: unknown) => Promise<SaveOutcome>) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => { renderer = create(<LogVisitForm todayKey={TODAY} onSave={onSave} onCancel={() => {}} />); });
  return renderer!;
}
const type = async (root: ReactTestInstance, id: string, value: string) => { await act(async () => { oneByTestId(root, id).props.onChange({ target: { value } }); }); };
const submit = async (root: ReactTestInstance) => { await act(async () => { await oneByTestId(root, 'form-visit').props.onSubmit({ preventDefault() {} }); }); await settle(2); };

console.log('LogVisitForm');
{
  const saved: unknown[] = [];
  const renderer = await renderForm(async (draft) => { saved.push(draft); return { ok: true }; });
  const root = renderer.root;
  check('date defaults to today', oneByTestId(root, 'input-visit-dateKey').props.value === TODAY && oneByTestId(root, 'input-visit-dateKey').props.max === TODAY);
  check('one inches input per area, decimal keyboard', BODY_AREAS.every((area) => byTestId(root, `input-visit-${area.key}`).length === 1 && oneByTestId(root, `input-visit-${area.key}`).props.inputMode === 'decimal'));

  await submit(root);
  check('empty submit: form-level error, nothing saved', saved.length === 0 && root.findAll((node) => node.props.role === 'alert').some((node) => textOf(node).includes('at least one')));

  await type(root, 'input-visit-waist', '34.55');
  await type(root, 'input-visit-neck', '14');
  await submit(root);
  const waistInput = oneByTestId(root, 'input-visit-waist');
  check('bad waist: inline error beside the field, aria-invalid, nothing saved', saved.length === 0 && waistInput.props['aria-invalid'] === true && root.findAll((node) => node.props.id === waistInput.props['aria-describedby']).some((node) => textOf(node).includes('one decimal')));
  check('good neck untouched by the waist error', oneByTestId(root, 'input-visit-neck').props['aria-invalid'] === undefined);

  await type(root, 'input-visit-waist', '34.5');
  check('typing clears the inline error', oneByTestId(root, 'input-visit-waist').props['aria-invalid'] === undefined);
  await type(root, 'input-visit-note', '  Over light clothing ');
  await submit(root);
  check('valid submit hands the parsed draft to onSave', JSON.stringify(saved[0]) === JSON.stringify({ dateKey: TODAY, note: 'Over light clothing', measurements: { neck: 14, waist: 34.5 } }), JSON.stringify(saved[0]));
  check('form resets after a successful save', oneByTestId(root, 'input-visit-waist').props.value === '' && oneByTestId(root, 'input-visit-note').props.value === '');

  const server = await renderForm(async () => ({ ok: false, field: 'hips', message: 'Hips looks unusually large.' }));
  await type(server.root, 'input-visit-hips', '60');
  await submit(server.root);
  check('server field error lands beside its area', oneByTestId(server.root, 'input-visit-hips').props['aria-invalid'] === true && textOf(server.root).includes('Hips looks unusually large.'));
  const generic = await renderForm(async () => ({ ok: false, message: 'Try again later.' }));
  await type(generic.root, 'input-visit-hips', '40');
  await submit(generic.root);
  check('unkeyed server error shows at form level', generic.root.findAll((node) => node.props.role === 'alert').some((node) => textOf(node) === 'Try again later.'));
}

console.log('MeasurementTableView');
{
  const visits: MeasurementVisit[] = [
    { id: 'a', dateKey: '2026-06-01', note: 'Baseline', measurements: { waist: 36, hips: 41 }, recordedByName: 'Dr. Sarah Jenkins' },
    { id: 'b', dateKey: '2026-08-01', note: null, measurements: { waist: 34.5 } },
  ];
  const removed: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => { renderer = create(<MeasurementTableView visits={visits} patientName="Test Patient" onRemove={(visit) => removed.push(visit.id)} />); });
  const root = renderer!.root;
  const heads = root.findAll((node) => node.type === 'th' && node.props.scope === 'col').map(textOf);
  check('header columns newest first with dates', heads[1].includes('Aug 1, 2026') && heads[2].includes('Jun 1, 2026') && heads[2].includes('Dr. Sarah Jenkins'));
  check('waist newest cell shows value and −1.5 in', textOf(oneByTestId(root, 'cell-waist-b')).includes('34.5') && textOf(oneByTestId(root, 'cell-waist-b')).includes('−1.5 in'));
  check('waist baseline cell labelled first recorded', textOf(oneByTestId(root, 'cell-waist-a')).includes('First recorded'));
  check('hips newest cell is a dash, not zero', textOf(oneByTestId(root, 'cell-hips-b')) === '—' && !textOf(oneByTestId(root, 'cell-hips-b')).includes('0'));
  check('never-measured rows still render with dashes', textOf(oneByTestId(root, 'cell-leftCalf-a')) === '—');
  check('ten rows', root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('row-measurement-')).length === BODY_AREAS.length);
  await act(async () => { oneByTestId(root, 'button-remove-visit-b').props.onClick(); });
  check('remove action reports the visit', removed.join(',') === 'b');
  let readOnly: ReactTestRenderer | undefined;
  await act(async () => { readOnly = create(<MeasurementTableView visits={visits} patientName="Test Patient" />); });
  check('without onRemove there are no remove buttons', readOnly!.root.findAll((node) => node.type === 'button').length === 0);
}

// ─── Rendered: patient record page ───────────────────────────────────────────

const requests: Array<{ url: string; method: string; body: unknown }> = [];
let liveDetail: OfficePatientDetail;
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? 'GET';
  requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (method === 'GET' && url.includes('/notifications')) {
    return new Response(JSON.stringify({ patientId: liveDetail.patient.id, outreach: { state: 'none' }, notifications: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (method === 'GET' && url.includes('/api/office/patients/')) {
    return new Response(JSON.stringify(liveDetail), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (method === 'DELETE' && url.includes('/measurements/')) {
    const id = url.split('/measurements/')[1];
    liveDetail = { ...liveDetail, bodyMeasurements: liveDetail.bodyMeasurements.filter((visit) => visit.id !== id) };
    return new Response(JSON.stringify({ deleted: true, patient: liveDetail.patient }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (method === 'POST' && url.endsWith('/measurements')) {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const visit = { id: 'new-visit', dateKey: body.dateKey, note: body.note ?? null, measurements: body.measurements, recordedByName: 'Test Staffer', createdAt: '2026-09-06T15:00:00.000Z', version: '2026-09-06T15:00:00.000Z' };
    liveDetail = { ...liveDetail, bodyMeasurements: [visit, ...liveDetail.bodyMeasurements] };
    return new Response(JSON.stringify({ visit, patient: liveDetail.patient }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/api/office/roster')) {
    return new Response(JSON.stringify({ office: liveDetail.office, patients: [], summary: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

function liveFixture(activationStatus: string | null): OfficePatientDetail {
  return {
    office: { providerId: 'prov-1', officeName: 'Test Office', providerCode: 'TEST' },
    patient: {
      identity: { id: 'pt-1', name: 'Rowan Test', email: null, phone: null, phoneDisplay: null, activationStatus, verified: true, dateOfBirth: null, height: null, timezone: 'America/New_York', createdAt: '2026-06-01T00:00:00Z', claimedAt: null, lastLoginAt: null },
      program: { id: 'prog-1', startDate: '2026-06-01', startingWeight: 210, currentWeight: 198, goalWeight: 180, weightChange: -12, lastLogDate: '2026-09-05' },
      version: '2026-09-01T00:00:00.000Z',
    },
    diary: { entries: [], nutritionTotals: { overall: { calories: 0, protein: 0, carbs: 0, fat: 0 }, byDate: [] } },
    water: [],
    checkIns: [],
    weights: [{ dateKey: '2026-06-01', weight: 210 }, { dateKey: '2026-09-01', weight: 198 }],
    providerNotes: [],
    staffWeights: [],
    bodyMeasurements: [
      { id: 'lv-2', dateKey: '2026-08-15', note: null, measurements: { waist: 35, hips: 42.5 }, recordedByName: 'Nurse Kim', createdAt: '2026-08-15T14:00:00Z', version: '2026-08-15T14:00:00.000Z' },
      { id: 'lv-1', dateKey: '2026-06-01', note: 'Baseline', measurements: { waist: 37.5, hips: 44, neck: 15 }, recordedByName: 'Nurse Kim', createdAt: '2026-06-01T14:00:00Z', version: '2026-06-01T14:00:00.000Z' },
    ],
    progressPhotos: [],
    account: { targets: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, favorites: [], recents: [], customFoods: [], savedRecipes: [], flags: {} },
  };
}

async function renderRecord(path: string) {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DateRangeProvider>
          <PatientSessionProvider>
            <Router hook={loc.hook}>
              <Route path="/patients/:id"><PatientDetail /></Route>
            </Router>
          </PatientSessionProvider>
        </DateRangeProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root };
}

console.log('demo record (guided persona)');
{
  __setSession({ authStatus: 'signed-out', authRole: null, hqRole: null });
  __setScope(null);
  const patient = MOCK_PATIENTS[0];
  const { root } = await renderRecord(`/patients/${patient.id}`);
  const before = requests.length;
  check('Log a Visit button present for the demo record', byTestId(root, 'button-log-visit').length === 1);
  check('seeded visits render as columns, newest first', root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('column-visit-')).map((node) => node.props['data-testid'].replace('column-visit-', '')).join(',') === [...patient.bodyMeasurements].reverse().map((visit) => visit.id).join(','));
  const newest = patient.bodyMeasurements.at(-1)!;
  const first = patient.bodyMeasurements[0];
  const waistChange = newest.measurements.waist! - first.measurements.waist!;
  check('waist change since first visit shows on the newest column', textOf(oneByTestId(root, `cell-waist-${newest.id}`)).includes(formatInchesChange(Math.round(waistChange * 10) / 10)));
  const skipped = patient.bodyMeasurements.flatMap((visit) => BODY_AREAS.filter((area) => visit.measurements[area.key] === undefined).map((area) => ({ visit, area })))[0];
  check('an unmeasured area renders a dash', skipped !== undefined && textOf(oneByTestId(root, `cell-${skipped.area.key}-${skipped.visit.id}`)) === '—');
  await act(async () => { oneByTestId(root, `button-remove-visit-${newest.id}`).props.onClick(); });
  await settle(2);
  check('removing a demo visit drops its column for the session', byTestId(root, `column-visit-${newest.id}`).length === 0 && byTestId(root, `column-visit-${first.id}`).length === 1);
  check('demo record made no live calls', requests.length === before);
}

console.log('live record (signed-in staff)');
{
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', hqRole: null, providerAccountCode: 'TEST' });
  __setSupabaseSession('staff-token');
  __setScope(null);
  liveDetail = liveFixture('activated');
  requests.length = 0;
  const { root } = await renderRecord('/patients/pt-1');
  check('live record fetched the office patient detail', requests.some((request) => request.method === 'GET' && request.url.includes('/api/office/patients/pt-1')));
  check('card renders the API visits newest first', root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('column-visit-')).map((node) => node.props['data-testid']).join(',') === 'column-visit-lv-2,column-visit-lv-1');
  check('waist −2.5 in since the first live visit', textOf(oneByTestId(root, 'cell-waist-lv-2')).includes('−2.5 in'));
  check('neck unmeasured on the newest live visit → dash', textOf(oneByTestId(root, 'cell-neck-lv-2')) === '—');
  check('staff can log a visit on an active record', byTestId(root, 'button-log-visit').length === 1);
  await act(async () => { oneByTestId(root, 'button-remove-visit-lv-2').props.onClick(); });
  await settle();
  const del = requests.find((request) => request.method === 'DELETE');
  check('remove calls the office-scoped DELETE with the visit version', del !== undefined && del.url.endsWith('/api/office/patients/pt-1/measurements/lv-2') && JSON.stringify(del.body) === JSON.stringify({ expectedVersion: '2026-08-15T14:00:00.000Z' }), JSON.stringify(del));
  check('after removal the record is refetched and the column is gone', byTestId(root, 'column-visit-lv-2').length === 0 && byTestId(root, 'column-visit-lv-1').length === 1);

  // Like weigh-ins, visits wait until the patient has connected (no activation yet → no Log a Visit).
  liveDetail = liveFixture(null);
  const pending = await renderRecord('/patients/pt-1');
  check('not-yet-connected record: visits still shown, Log a Visit hidden, no remove actions', byTestId(pending.root, 'column-visit-lv-1').length === 1 && byTestId(pending.root, 'button-log-visit').length === 0 && pending.root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('button-remove-visit-')).length === 0);

  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Support', providerAccountCode: null });
  __setScope({ providerId: 'prov-1' });
  liveDetail = liveFixture('activated');
  const support = await renderRecord('/patients/pt-1');
  check('HQ Support (read-only) sees the visits but no Log a Visit button', byTestId(support.root, 'column-visit-lv-2').length === 1 && byTestId(support.root, 'button-log-visit').length === 0);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll body-measurement checks passed.');
