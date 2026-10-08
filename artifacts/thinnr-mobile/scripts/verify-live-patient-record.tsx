/** Runs as part of test:leaderboard: real screens and generated API hook, scripted HTTP only. */
import React, { act } from 'react';
import { create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setBaseUrl, type OfficePatientRecord } from '@workspace/api-client-react';
import { OperationsProvider } from '../context/OperationsContext';
import { setStubSession, setStubSessionLoadingTicks } from './leaderboard-stubs/supabase';
import { routerLog, router, setSearchParams } from './provider-training-stubs/expo-router';
import { liveEntryDecision } from '../lib/live-patient-entry';
import LivePatientRecord from '../app/office-patient/[id]';
import PatientsScreen from '../app/(tabs)/patients';

const STAFF = { access_token: 'staff-token', user: { id: 'staff-1' } };
const OTHER_STAFF = { access_token: 'other-token', user: { id: 'staff-2' } };
const OFFICE = { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '123456' };
const PATIENT = {
  id: 'pat-a', name: 'Casey Ortiz', email: 'casey@example.test', phone: '+15552010001',
  phoneDisplay: '(555) 201-0001', activationStatus: 'activated', verified: true,
  createdAt: '2026-06-01', invitation: null,
};
const RECORD: OfficePatientRecord = {
  office: OFFICE,
  patient: {
    identity: {
      ...PATIENT, dateOfBirth: '1987-01-20', height: '5 ft 6 in', timezone: 'America/New_York',
      claimedAt: '2026-06-02', lastLoginAt: '2026-09-07',
    },
    program: {
      id: 'program-a', startDate: '2026-06-01', startingWeight: 200, currentWeight: 180,
      goalWeight: 160, weightChange: -20, lastLogDate: '2026-09-07', day: 99, stage: 'protocol', week: 3,
    },
  },
  engagement: {
    asOfDate: '2026-09-07', loggedLast7: [false, true, true, false, true, true, true],
    loggedDays7: 5, mealStreak: 3, avgCalories7: 1250, avgWater7: 64,
    checkInStreak: 2, checkInRate30: 80, latestCheckInDate: '2026-09-07',
    moodCounts: { '1': 0, '2': 1, '3': 2, '4': 4, '5': 1 },
    topSideEffects: [{ name: 'Headache', count: 1 }],
  },
  diary: {
    entries: [{
      id: 'food-a', dateKey: '2026-09-07', meal: 'lunch', kind: 'food', name: 'Grilled Chicken',
      detail: '4 ounces', quantity: 1, calories: 190, protein: 35, carbs: 0, fat: 4,
    }],
    nutritionTotals: {
      overall: { calories: 190, protein: 35, carbs: 0, fat: 4 },
      byDate: [{ dateKey: '2026-09-07', calories: 190, protein: 35, carbs: 0, fat: 4 }],
    },
  },
  water: [{ dateKey: '2026-09-07', oz: 72 }],
  checkIns: [{ id: 'check-a', dateKey: '2026-09-07', mood: 4, weight: 180, notes: 'Feeling well today', sideEffects: ['Headache'] }],
  weights: [{ dateKey: '2026-09-05', weight: 182 }, { dateKey: '2026-09-07', weight: 180 }],
  progressPhotos: [{ id: 'photo-a', dateKey: '2026-09-07', label: 'Front view', angle: 'front', url: 'https://images.example.test/front.jpg' }],
  account: { targets: { calories: 1300, waterOz: 80 }, favorites: [], recents: [], customFoods: [], savedRecipes: [], flags: {} },
};

type Reply = { status: number; body: unknown };
type RequestLog = { url: URL; auth: string | null };
const host = (root: ReactTestInstance, id: string) =>
  root.findAll(n => typeof n.type === 'string' && n.props.testID === id)[0];
const text = (node: ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
}
async function tap(root: ReactTestInstance, id: string) {
  const node = host(root, id);
  if (!node?.props.onPress) throw new Error(`Missing pressable ${id}`);
  await act(async () => { void node.props.onPress(); });
  await settle();
}

export async function verifyLivePatientRecord(): Promise<number> {
  let failures = 0;
  const check = (name: string, condition: boolean) => {
    console[condition ? 'log' : 'error'](`  ${condition ? 'ok' : 'FAIL'}  ${name}`);
    if (!condition) failures++;
  };
  let requests: RequestLog[] = [];
  let handler: (request: RequestLog) => Reply | Promise<Reply>;
  const originalFetch = globalThis.fetch;
  setBaseUrl('http://api.test');
  globalThis.fetch = async (input, init) => {
    const request = {
      url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      auth: new Headers(init?.headers).get('authorization'),
    };
    requests.push(request);
    const result = await handler(request);
    return new Response(JSON.stringify(result.body), {
      status: result.status, headers: { 'Content-Type': 'application/json' },
    });
  };
  const reset = () => {
    requests = [];
    routerLog.length = 0;
    setStubSession(STAFF);
    setSearchParams({ id: 'pat-a' });
    handler = ({ url }) => {
      if (url.pathname === '/api/office/roster') return { status: 200, body: { office: OFFICE, patients: [PATIENT] } };
      if (url.pathname.startsWith('/api/office/patients/')) return { status: 200, body: RECORD };
      throw new Error(`Unexpected request: ${url.pathname}`);
    };
  };
  const mount = async (screen: React.ReactElement) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 1, gcTime: 0 } } });
    const wrap = (element: React.ReactElement) =>
      <QueryClientProvider client={client}><OperationsProvider>{element}</OperationsProvider></QueryClientProvider>;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(wrap(screen)); });
    await settle();
    return {
      renderer,
      get root() { return renderer.root; },
      async update(element: React.ReactElement) { await act(async () => renderer.update(wrap(element))); await settle(); },
      async close() { await act(async () => renderer.unmount()); client.clear(); },
    };
  };
  try {
    console.log('\nlive patient record — real generated client');
    reset();
    const page = await mount(<LivePatientRecord />);
    check('detail GET uses selected id and session bearer, without office override',
      requests.length === 1 && requests[0].url.href === 'http://api.test/api/office/patients/pat-a' && requests[0].auth === 'Bearer staff-token');
    check('live identity, weights, diary, water, check-in and photo are visible',
      !!host(page.root, 'live-patient-record') && text(page.root).includes('Casey Ortiz') &&
      text(page.root).includes('180') && text(page.root).includes('Grilled Chicken') &&
      text(page.root).includes('72') && text(page.root).includes('Feeling well today') &&
      page.root.findAll(n => typeof n.type === 'string' && n.props.source?.uri === RECORD.progressPhotos[0].url).length > 0);
    check('no seeded disclaimer or raw serialized engagement objects',
      !/SYNTHETIC|\[object Object\]|loggedLast7|topSideEffects/.test(text(page.root)));
    await tap(page.root, 'live-patient-back');
    check('back returns to originating list', routerLog.at(-1)?.method === 'back');
    const originalBack = router.canGoBack;
    router.canGoBack = () => false;
    await tap(page.root, 'live-patient-back');
    check('direct-link back falls back to live roster', routerLog.at(-1)?.target === '/(tabs)/patients');
    router.canGoBack = originalBack;
    handler = () => ({ status: 200, body: { ...RECORD, patient: { ...RECORD.patient, identity: { ...RECORD.patient.identity, name: 'Updated Casey' } } } });
    await tap(page.root, 'live-patient-refresh');
    check('refresh renders newly fetched server values', text(page.root).includes('Updated Casey') && requests.length === 2);
    handler = () => ({ status: 403, body: { error: 'Access revoked' } });
    await tap(page.root, 'live-patient-refresh');
    check('revoked access hides cached identity and entire record, not just body',
      !!host(page.root, 'live-patient-error') && !host(page.root, 'live-patient-record') &&
      !/Casey|Grilled Chicken/.test(text(page.root)) && !host(page.root, 'live-patient-refresh'));
    await page.close();

    reset();
    for (const status of [401, 403, 404, 410, 502]) {
      requests = [];
      handler = () => ({ status, body: { error: 'Scripted failure' } });
      const denied = await mount(<LivePatientRecord />);
      check(`${status}: explicit error, never a seeded record`, !!host(denied.root, 'live-patient-error') && !host(denied.root, 'live-patient-record') && !text(denied.root).includes('SYNTHETIC'));
      if (status < 500) {
        check(`${status}: terminal access/missing state does not retry`, requests.length === 1 && !host(denied.root, 'live-patient-retry'));
      } else {
        handler = () => ({ status: 200, body: RECORD });
        await tap(denied.root, 'live-patient-retry');
        check('transient failure retry recovers to real record', !!host(denied.root, 'live-patient-record'));
      }
      await denied.close();
    }

    reset();
    setStubSession(null);
    const anonymous = await mount(<LivePatientRecord />);
    check('anonymous deep link has no live request, no refresh, and explicit sign-in state',
      requests.length === 0 && !!host(anonymous.root, 'live-patient-error') && !host(anonymous.root, 'live-patient-refresh'));
    await anonymous.close();
    reset();
    setSearchParams({});
    const missingId = await mount(<LivePatientRecord />);
    check('missing id is explicit and never requests an undefined patient', requests.length === 0 && !!host(missingId.root, 'live-patient-error'));
    await missingId.close();

    reset();
    let release!: (reply: Reply) => void;
    handler = () => new Promise(resolve => { release = resolve; });
    const loading = await mount(<LivePatientRecord />);
    check('pending request shows loading only', !!host(loading.root, 'live-patient-loading') && !host(loading.root, 'live-patient-record'));
    await act(async () => setStubSession(null));
    await act(async () => release({ status: 200, body: RECORD }));
    await settle();
    check('late response after sign-out cannot reveal patient identity', !text(loading.root).includes('Casey') && !!host(loading.root, 'live-patient-error'));
    await loading.close();

    reset();
    const switching = await mount(<LivePatientRecord />);
    handler = () => new Promise(resolve => { release = resolve; });
    await act(async () => setStubSession(OTHER_STAFF));
    await settle();
    check('new account cannot see prior account cache', !text(switching.root).includes('Casey') && !!host(switching.root, 'live-patient-loading'));
    await act(async () => release({ status: 403, body: { error: 'Wrong office' } }));
    await settle();
    check('account handoff fetch uses new bearer and denies without old data', requests.at(-1)?.auth === 'Bearer other-token' && !!host(switching.root, 'live-patient-error') && !text(switching.root).includes('Casey'));
    await switching.close();

    reset();
    const changingId = await mount(<LivePatientRecord />);
    setSearchParams({ id: 'pat/b?c' });
    handler = () => ({ status: 200, body: { ...RECORD, patient: { ...RECORD.patient, identity: { ...RECORD.patient.identity, id: 'pat/b?c', name: 'Second patient' } } } });
    await changingId.update(<LivePatientRecord />);
    check('patient id changes refetch encoded path and clear previous patient',
      requests.at(-1)?.url.pathname === '/api/office/patients/pat%2Fb%3Fc' && text(changingId.root).includes('Second patient') && !text(changingId.root).includes('Casey'));
    await changingId.close();

    reset();
    const emptyRecord = structuredClone(RECORD);
    emptyRecord.patient.program = { id: null, startDate: null, startingWeight: null, currentWeight: null, goalWeight: null, weightChange: 0, lastLogDate: null, day: null, stage: null, week: null };
    emptyRecord.patient.identity.activationStatus = null;
    emptyRecord.diary.entries = [];
    emptyRecord.weights = [];
    emptyRecord.checkIns = [];
    emptyRecord.water = [];
    emptyRecord.progressPhotos = [];
    emptyRecord.engagement = { asOfDate: '2026-09-07', loggedLast7: null, loggedDays7: null, mealStreak: null, avgCalories7: null, avgWater7: null, checkInStreak: null, checkInRate30: null, latestCheckInDate: null, moodCounts: null, topSideEffects: null };
    handler = () => ({ status: 200, body: emptyRecord });
    const empty = await mount(<LivePatientRecord />);
    check('empty histories and nullable program render without fabricated activity',
      !!host(empty.root, 'live-patient-record') && !/NaN|undefined|\bActive\b|\bnull\b/.test(text(empty.root)));
    await empty.close();

    console.log('\nroster and leaderboard share the live destination');
    reset();
    const roster = await mount(<PatientsScreen />);
    check('signed-in roster has live patient only, no seeded rows/disclaimer/filter',
      !!host(roster.root, 'live-patient-pat-a') && !host(roster.root, 'patients-list') && !/SYNTHETIC/.test(text(roster.root)) && !host(roster.root, 'status-filter-all'));
    await tap(roster.root, 'live-patient-pat-a');
    check('live roster opens identical live detail route', routerLog.at(-1)?.target === '/office-patient/pat-a');
    await act(async () => host(roster.root, 'patients-search-input').props.onChangeText('absent'));
    check('live search filters actual server patients', !host(roster.root, 'live-patient-pat-a') && /No .*match/i.test(text(roster.root)));
    await act(async () => setStubSession(null));
    await settle();
    const demoRows = roster.root.findAll(n => typeof n.type === 'string' && String(n.props.testID).startsWith('patient-row-'));
    check('signed-out roster returns to demo only without a live call', demoRows.length > 10 && text(roster.root).includes('SYNTHETIC') && requests.length === 1);
    await tap(roster.root, demoRows[0].props.testID);
    check('demo roster keeps seeded patient route', routerLog.at(-1)?.target === `/patient/${demoRows[0].props.testID.slice('patient-row-'.length)}`);
    await roster.close();
    reset();
    setStubSession(null);
    const demo = await mount(<PatientsScreen />);
    check('cold demo roster does not call office endpoints', requests.length === 0);
    await demo.close();
    reset();
    handler = () => ({ status: 403, body: { error: 'Office access required' } });
    const deniedRoster = await mount(<PatientsScreen />);
    check('denied roster never falls back to seeded patients', !host(deniedRoster.root, 'patients-list') && !/SYNTHETIC|Casey Ortiz/.test(text(deniedRoster.root)));
    await deniedRoster.close();
    reset();
    setStubSessionLoadingTicks(1);
    const resolving = await mount(<PatientsScreen />);
    check('session resolution ends on live rather than demo roster', !!host(resolving.root, 'live-patient-pat-a') && !text(resolving.root).includes('SYNTHETIC'));
    await resolving.close();
    check('global patient admission guard recognizes office record as staff route', liveEntryDecision({
      modeHydrated: true, mode: 'staff', accountResolving: false, accountKind: 'demo',
      patientHydrated: true, onboardingComplete: null,
      pathname: '/office-patient/pat-a',
    }).kind === 'allow');
  } finally {
    globalThis.fetch = originalFetch;
  }
  return failures;
}