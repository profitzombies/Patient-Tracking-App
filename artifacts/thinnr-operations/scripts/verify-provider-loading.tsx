/**
 * Delayed-response coverage for the real Patients and PatientDetail pages.
 *
 * Run:
 *   TZ=UTC tsx --tsconfig tsconfig.provider-loading.json scripts/verify-provider-loading.tsx
 */
import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { DateRangeProvider } from '../src/contexts/date-range';
import { officeRosterQueryKey } from '../src/components/office/LiveRoster';
import type { OfficePatientDetail, OfficeRoster } from '../src/lib/office-roster';
import Patients from '../src/pages/Patients';
import PatientDetail from '../src/pages/PatientDetail';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.setInterval ??= setInterval;
g.window.clearInterval ??= clearInterval;
g.window.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= {};

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map((child) => textOf(child as ReactTestInstance | string)).join('');
}
const byTestId = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string');
const hasText = (root: ReactTestInstance, value: string) => textOf(root).includes(value);
async function settle(rounds = 4) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}

type Reply = () => Promise<Response> | Response;
const routes: Array<[string, Reply]> = [];
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function delayed() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((yes) => { resolve = yes; });
  return { reply: () => promise, resolve };
}
function setRoute(fragment: string, reply: Reply) {
  const index = routes.findIndex(([key]) => key === fragment);
  if (index >= 0) routes[index] = [fragment, reply];
  else routes.unshift([fragment, reply]);
}
g.fetch = async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const hit = routes.find(([fragment]) => url.includes(fragment));
  if (hit) return hit[1]();
  // Detail subresources are intentionally not the subject of this suite. Give
  // them honest empty envelopes so they cannot obscure the record transition.
  if (url.includes('/notifications')) return json(200, { patientId: 'unknown', outreach: { state: 'none' }, notifications: [] });
  throw new Error(`unexpected fetch ${url}`);
};

function roster(officeId: string, names: string[]): OfficeRoster {
  return {
    office: { providerId: officeId, officeName: `Office ${officeId}`, providerCode: officeId.toUpperCase() },
    patients: names.map((name, index) => ({
      id: `${officeId}-patient-${index + 1}`,
      name,
      email: `${name.toLowerCase().replace(' ', '.')}@example.com`,
      phone: null,
      phoneDisplay: null,
      activationStatus: 'activated',
      verified: true,
      createdAt: '2026-07-01T12:00:00Z',
      invitation: null,
      program: { id: 'metabolic', day: 40, stage: 'protocol', week: 6, startDate: '2026-07-01', startingWeight: 210, currentWeight: 198, goalWeight: 180, weightChange: -12, lastLogDate: '2026-09-01' },
      operational: { asOfDate: '2026-09-06', latestActivityDate: null, latestDiaryDate: null, latestCheckInDate: null, latestWaterDate: null, latestWeightDate: null, latestPhotoDate: null, loggedDays7: 0, checkIns7: 0, activity: null, followUps: [], status: 'on_track', reasons: [] },
    })),
    summary: { totalPatients: names.length, activePatients: names.length, newEnrollments30d: 0, needsAttention: 0, inactive: 0, invited: 0, checkInsOverdue: 0, loggingLapsed: 0, archived: 0, asOf: '2026-09-06' },
  } as OfficeRoster;
}
function detail(id: string, name: string, officeId = 'office-a'): OfficePatientDetail {
  return {
    office: { providerId: officeId, officeName: `Office ${officeId}`, providerCode: officeId.toUpperCase() },
    patient: {
      identity: { id, name, email: `${id}@example.com`, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true, dateOfBirth: null, height: null, timezone: 'America/New_York', createdAt: '2026-06-01T00:00:00Z', claimedAt: null, lastLoginAt: null },
      program: { id: 'metabolic', startDate: '2026-06-01', startingWeight: 210, currentWeight: 198, goalWeight: 180, weightChange: -12, lastLogDate: '2026-09-01' },
      version: '2026-09-01T00:00:00Z',
    },
    diary: { entries: [], nutritionTotals: { overall: { calories: 0, protein: 0, carbs: 0, fat: 0 }, byDate: [] } },
    water: [],
    checkIns: [],
    weights: [{ dateKey: '2026-06-01', weight: 210 }, { dateKey: '2026-09-01', weight: 198 }],
    providerNotes: [],
    staffWeights: [],
    bodyMeasurements: [],
    progressPhotos: [],
    account: { targets: { calories: null, protein: null, carbs: null, fat: null, waterOz: null }, favorites: [], recents: [], customFoods: [], savedRecipes: [], flags: {} },
  };
}

interface Mounted {
  renderer: ReactTestRenderer;
  root: ReactTestInstance;
  client: QueryClient;
  location: ReturnType<typeof memoryLocation>;
  update: () => Promise<void>;
}
async function mount(page: 'roster' | 'detail', path: string): Promise<Mounted> {
  const location = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let revision = 0;
  let renderer!: ReactTestRenderer;
  const tree = () => (
    <QueryClientProvider client={client}>
      <DateRangeProvider>
        <PatientSessionProvider>
          <Router hook={location.hook}>
            <React.Fragment key={revision}>
              {page === 'roster'
                ? <Patients />
                : <Route path="/patients/:id"><PatientDetail /></Route>}
            </React.Fragment>
          </Router>
        </PatientSessionProvider>
      </DateRangeProvider>
    </QueryClientProvider>
  );
  await act(async () => { renderer = create(tree()); });
  return {
    renderer,
    root: renderer.root,
    client,
    location,
    update: async () => { revision += 1; await act(async () => { renderer.update(tree()); }); },
  };
}

console.log('\nReal provider page delayed-response suite');
__setSupabaseSession('staff-token');

// Real Patients page: delayed success, empty, failure, and same-scope refresh.
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', hqRole: null, authUser: { id: 'staff-1', displayName: 'Staff' } });
__setScope(null);
const firstRoster = delayed();
setRoute('/api/office/roster', firstRoster.reply);
const rosterPage = await mount('roster', '/patients');
check('real roster shows layout skeleton while pending', byTestId(rosterPage.root, 'loading-patient-roster').length === 1);
check('real roster loading region has one announcement', byTestId(rosterPage.root, 'loading-patient-roster')[0].findAllByProps({ role: 'status' }).length === 1);
check('real roster pending does not print a zero lifetime count', !hasText(rosterPage.root, 'Showing 0 lifetime records'));
firstRoster.resolve(json(200, roster('office-a', ['Ava Able', 'Ben Bright'])));
await settle();
check('real roster delayed success renders rows', hasText(rosterPage.root, 'Ava Able') && hasText(rosterPage.root, 'Showing 2 lifetime records'));

const rosterRefresh = delayed();
setRoute('/api/office/roster', rosterRefresh.reply);
await act(async () => { void rosterPage.client.invalidateQueries({ queryKey: officeRosterQueryKey(null) }); });
check('real same-office refresh keeps current rows', hasText(rosterPage.root, 'Ava Able') && byTestId(rosterPage.root, 'loading-patient-roster').length === 0);
rosterRefresh.resolve(json(200, roster('office-a', ['Ava Able', 'Ben Bright', 'Cam Clear'])));
await settle();
check('real same-office refresh commits replacement', hasText(rosterPage.root, 'Cam Clear') && hasText(rosterPage.root, 'Showing 3 lifetime records'));

// A real HQ office switch changes the query scope. It must show shapes rather
// than office A's cached names until office B answers.
__setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Support', authUser: { id: 'hq-1', displayName: 'HQ' } });
__setScope({ providerId: 'office-b' });
const officeB = delayed();
setRoute('/api/office/roster?office=office-b', officeB.reply);
await rosterPage.update();
check('real office switch isolates cached roster', byTestId(rosterPage.root, 'loading-patient-roster').length === 1 && !hasText(rosterPage.root, 'Ava Able'));
officeB.resolve(json(200, roster('office-b', [])));
await settle();
check('real empty roster replaces pending shapes', byTestId(rosterPage.root, 'loading-patient-roster').length === 0 && hasText(rosterPage.root, 'No patients found'));

__setScope({ providerId: 'office-c' });
setRoute('/api/office/roster?office=office-c', () => json(403, { error: 'Roster access denied' }));
await rosterPage.update();
await settle();
check('real roster failure/denial remains an alert', rosterPage.root.findAllByProps({ role: 'alert' }).some((node) => hasText(node, 'Roster access denied')));
await act(async () => { rosterPage.renderer.unmount(); });

// Real PatientDetail page: delayed success/failure plus route and office scope
// switches using the same mounted QueryClient.
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', hqRole: null, authUser: { id: 'staff-1', displayName: 'Staff' } });
__setScope(null);
const patientA = delayed();
setRoute('/api/office/patients/patient-a', patientA.reply);
const detailPage = await mount('detail', '/patients/patient-a');
check('real detail shows layout skeleton while pending', byTestId(detailPage.root, 'loading-patient-detail').length === 1);
check('real detail loading region has one announcement', byTestId(detailPage.root, 'loading-patient-detail')[0].findAllByProps({ role: 'status' }).length === 1);
const summaryCells = byTestId(detailPage.root, 'loading-patient-detail')[0].findAll((node) => node.type === 'div' && node.props.className === 'bg-card p-4');
check('detail skeleton matches four summary cells', summaryCells.length === 4, String(summaryCells.length));
patientA.resolve(json(200, detail('patient-a', 'Patient Alpha')));
await settle();
check('real detail delayed success renders record', hasText(detailPage.root, 'Patient Alpha') && byTestId(detailPage.root, 'loading-patient-detail').length === 0);

const patientB = delayed();
setRoute('/api/office/patients/patient-b', patientB.reply);
await act(async () => { detailPage.location.navigate('/patients/patient-b'); });
check('real patient route switch isolates prior detail', byTestId(detailPage.root, 'loading-patient-detail').length === 1 && !hasText(detailPage.root, 'Patient Alpha'));
patientB.resolve(json(404, { error: 'Patient record unavailable' }));
await settle();
check('real detail failure remains an alert', detailPage.root.findAllByProps({ role: 'alert' }).some((node) => hasText(node, 'Patient record unavailable')));

__setSession({ authStatus: 'signed-in', authRole: 'hq_admin', hqRole: 'Support', authUser: { id: 'hq-1', displayName: 'HQ' } });
__setScope({ providerId: 'office-z' });
const officeZ = delayed();
setRoute('/api/office/patients/patient-a?office=office-z', officeZ.reply);
await act(async () => { detailPage.location.navigate('/patients/patient-a'); });
await detailPage.update();
check('real detail office switch isolates prior office', byTestId(detailPage.root, 'loading-patient-detail').length === 1 && !hasText(detailPage.root, 'Patient Alpha'));
officeZ.resolve(json(200, detail('patient-a', 'Patient Zeta', 'office-z')));
await settle();
check('real detail office response renders only its patient', hasText(detailPage.root, 'Patient Zeta') && !hasText(detailPage.root, 'Patient Alpha'));

await act(async () => { detailPage.renderer.unmount(); });
if (failures) {
  console.error(`\n${failures} provider loading check(s) failed.`);
  process.exit(1);
}
console.log('\nAll real provider loading checks passed.');