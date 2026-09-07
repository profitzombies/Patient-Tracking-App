/**
 * Operations medication record smoke/regression checks.
 *
 * The broader behavioral contract is exercised through the real component
 * with a scripted fetch, matching the other live-patient suites.
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { DateRangeProvider } from '../src/contexts/date-range';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import { MOCK_PATIENTS } from '../src/data/mock-data';
import PatientDetail from '../src/pages/PatientDetail';
import { LiveMedications } from '../src/components/office/LiveMedications';
import type { OfficePatientMedications } from '../src/lib/office-roster';
import type { MedicationRecord } from '../src/lib/medication-schedule';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
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
const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

const medication: MedicationRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Protocol drops',
  form: 'drops',
  dose: '1 mL',
  scheduleKind: 'daily',
  times: ['08:00', '15:00', '22:00'],
  weekday: null,
  notes: 'With water',
  startDate: '2026-08-01',
  stopDate: null,
  source: 'office',
  version: 'v1',
};
const days = Array.from({ length: 30 }, (_, index) => {
  const dateKey = new Date(Date.UTC(2026, 7, 8 + index)).toISOString().slice(0, 10);
  return { dateKey, due: index === 29 ? 3 : 0, taken: index === 29 ? 2 : 0, skipped: 0, missed: index === 29 ? 1 : 0 };
});
let payload: OfficePatientMedications = {
  medications: [medication],
  doseLogs: [],
  adherence: { fromDate: days[0].dateKey, toDate: days[29].dateKey, due: 3, taken: 2, skipped: 0, missed: 1, rate: 67, days },
  timeZone: 'UTC',
  today: days[29].dateKey,
};
const requests: Array<{ method: string; url: string; body: any }> = [];
let conflictNext = false;
(globalThis as any).fetch = async (input: unknown, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ method, url, body });
  if (!url.includes('/medications')) throw new Error(`unexpected fetch ${method} ${url}`);
  if (method === 'GET') return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (conflictNext) {
    conflictNext = false;
    return new Response(JSON.stringify({ error: 'This record changed.', code: 'record_changed' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }
  if (method === 'POST') {
    const added: MedicationRecord = { ...body.medication, id: '22222222-2222-4222-8222-222222222222', source: 'office', version: 'v2' };
    payload = { ...payload, medications: [...payload.medications, added] };
    return new Response(JSON.stringify({ ...payload, medication: added }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
  if (method === 'PATCH') {
    const id = url.split('/medications/')[1]?.split('?')[0];
    const index = payload.medications.findIndex((m) => m.id === id);
    const { expectedVersion: _v, ...patch } = body;
    const changed = { ...payload.medications[index], ...patch, version: 'v3' };
    payload = { ...payload, medications: payload.medications.map((m, i) => i === index ? changed : m) };
    return new Response(JSON.stringify({ ...payload, medication: changed }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`Unexpected ${method}`);
};

const patient = {
  identity: { id: 'pt-1', name: 'Test Patient', email: null, phone: null, phoneDisplay: null, activationStatus: null, verified: false, dateOfBirth: null, height: null, timezone: 'UTC', createdAt: null, claimedAt: null, lastLoginAt: null },
  program: { id: null, startDate: null, startingWeight: null, currentWeight: null, goalWeight: null, weightChange: null, lastLogDate: null },
  version: null,
};
async function render(canEdit: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><LiveMedications patient={patient} office={null} canEdit={canEdit} /></QueryClientProvider>);
  });
  await settle();
  return renderer!;
}

console.log('LiveMedications');
__setSupabaseSession('staff-token');
{
  requests.length = 0;
  const renderer = await render(true);
  const root = renderer.root;
  check('GET renders a medication row', byTestId(root, `medication-row-${medication.id}`).length === 1);
  check('schedule uses friendly clock labels', textOf(root).includes('Daily at 8:00 AM, 3:00 PM, 10:00 PM'));
  check('adherence headline is explicit', textOf(one(root, 'medication-adherence')).includes('Taken 2 of 3 due'));
  check('adherence renders exactly 30 day cells', one(root, 'medication-adherence').findAll((node) => typeof node.props['aria-label'] === 'string').length === 30);
  check('day cell labels expose taken and missed counts', one(root, 'medication-adherence').findAll((node) => String(node.props['aria-label']).includes('2 taken') && String(node.props['aria-label']).includes('1 missed')).length === 1);

  await act(async () => { one(root, 'button-add-medication').props.onClick(); });
  await act(async () => { one(root, 'input-medication-name').props.onChange({ target: { value: 'Vitamin D' } }); });
  await act(async () => { one(root, 'input-medication-time-0').props.onChange({ target: { value: 'breakfast' } }); });
  await act(async () => { await one(root, 'medication-form').props.onSubmit({ preventDefault() {} }); });
  check('bad time is inline and sends nothing', byTestId(root, 'medication-form-error').length === 1 && requests.filter((request) => request.method === 'POST').length === 0);
  await act(async () => { one(root, 'input-medication-time-0').props.onChange({ target: { value: '8:00 AM' } }); });
  await act(async () => { await one(root, 'medication-form').props.onSubmit({ preventDefault() {} }); });
  await settle();
  const post = requests.find((request) => request.method === 'POST');
  check('add normalizes time and daily weekday', post?.body.medication.times[0] === '08:00' && post?.body.medication.weekday === null, JSON.stringify(post?.body));
  check('add response appears in the list', byTestId(root, 'medication-row-22222222-2222-4222-8222-222222222222').length === 1);

  // Edit the new record to weekly: only changed fields + expectedVersion ride the PATCH.
  const addedId = '22222222-2222-4222-8222-222222222222';
  await act(async () => { one(root, `button-edit-medication-${addedId}`).props.onClick(); });
  check('edit form pre-fills the record', one(root, 'input-medication-name').props.value === 'Vitamin D');
  await act(async () => { root.findAll((node) => node.props.id === 'medication-weekly' && typeof node.type === 'string')[0].props.onChange(); });
  await act(async () => { one(root, 'select-medication-weekday').props.onChange({ target: { value: '4' } }); });
  await act(async () => { await one(root, 'medication-form').props.onSubmit({ preventDefault() {} }); });
  await settle();
  const patch = requests.filter((request) => request.method === 'PATCH').at(-1);
  check('edit PATCH carries only changed fields + expectedVersion', patch !== undefined && patch.url.includes(`/medications/${addedId}`)
    && JSON.stringify(Object.keys(patch.body).sort()) === JSON.stringify(['expectedVersion', 'scheduleKind', 'weekday']) && patch.body.expectedVersion === 'v2' && patch.body.weekday === 4, JSON.stringify(patch?.body));
  check('edited row shows the weekly schedule', textOf(one(root, `medication-row-${addedId}`)).includes('Weekly on Thursday at 8:00 AM'));

  // Stop: confirm first, then PATCH { stopDate: today, expectedVersion }.
  await act(async () => { one(root, `button-stop-medication-${medication.id}`).props.onClick(); });
  await settle();
  check('stop asks for confirmation before writing', byTestId(root, `button-confirm-stop-${medication.id}`).length === 1 && requests.filter((r) => r.method === 'PATCH').length === 1);
  await act(async () => { one(root, `button-confirm-stop-${medication.id}`).props.onClick(); });
  await settle();
  const stopPatch = requests.filter((request) => request.method === 'PATCH').at(-1);
  check('confirmed stop PATCHes today as the stop date with the version', stopPatch?.url.includes(`/medications/${medication.id}`) === true
    && JSON.stringify(stopPatch?.body) === JSON.stringify({ stopDate: payload.today, expectedVersion: 'v1' }), JSON.stringify(stopPatch?.body));
  check('stopped record moves under Stopped with no Stop button', textOf(root).includes('Stopped') && byTestId(root, `button-stop-medication-${medication.id}`).length === 0 && textOf(one(root, `medication-row-${medication.id}`)).includes('Stopped'));

  // A stale save (409) never overwrites: the notice shows and the list reloads.
  const getsBefore = requests.filter((r) => r.method === 'GET').length;
  conflictNext = true;
  await act(async () => { one(root, `button-edit-medication-${addedId}`).props.onClick(); });
  await act(async () => { one(root, 'input-medication-dose').props.onChange({ target: { value: '4000 IU' } }); });
  await act(async () => { await one(root, 'medication-form').props.onSubmit({ preventDefault() {} }); });
  await settle();
  check('409 shows the record-changed notice and refetches', textOf(root).includes('This record changed') && requests.filter((r) => r.method === 'GET').length > getsBefore);
  check('409 left the local record untouched', textOf(one(root, `medication-row-${addedId}`)).includes('Vitamin D') && !textOf(one(root, `medication-row-${addedId}`)).includes('4000 IU'));

  renderer.unmount();
  const readOnly = await render(false);
  check('read-only hides all medication write buttons', readOnly.root.findAll((node) => node.type === 'button').length === 0);
  readOnly.unmount();
}

console.log('demo persona (guided demo record)');
{
  __setSession({ authStatus: 'signed-out', authRole: null, hqRole: null });
  __setScope(null);
  __setSupabaseSession(null);
  const before = requests.length;
  const loc = memoryLocation({ path: `/patients/${MOCK_PATIENTS[0].id}`, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReturnType<typeof create>;
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
  check('demo record shows no medication card', byTestId(renderer.root, 'live-medications').length === 0 && byTestId(renderer.root, 'detail-medication-adherence').length === 0);
  check('demo record made no medication calls', requests.length === before);
  renderer.unmount();
}

if (failures) { console.error(`\n${failures} medication check(s) failed`); process.exit(1); }
console.log('\nAll medication checks passed.');