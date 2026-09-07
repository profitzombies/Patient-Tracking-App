/**
 * Medication records → reminders → dose logging (real-account mode).
 *
 * Renders the REAL PatientAccountProvider + PatientProvider under Node with
 * react-test-renderer, plus the real "Today's medications" card and the
 * account Medications section, against a scripted patient-data API. Proves:
 *
 *   1. Schedule core: daily and weekly occurrences, timezone and DST-correct
 *      due instants, dose states (upcoming / due / missed / taken / skipped),
 *      the 7-day correction window, adherence sums, and onboarding seeds.
 *   2. Reminder payloads: a Taken / Skip action or a plain tap on a
 *      medication reminder resolves to the dose it fired for (local day of
 *      the FIRE time, seconds-or-milliseconds fire stamps), never to a
 *      foreign notification.
 *   3. Device plan: the reminder plan is derived from the hydrated list
 *      (stopped / future / day-less weekly records excluded).
 *   4. Dose logging: the card lists today's doses, Taken / Skip write an
 *      occurrence-keyed log (tap again clears), earlier days inside the
 *      window are correctable, the window boundary is enforced, and an
 *      offline decision is queued then replayed with the same key.
 *   5. Medication editing: add / edit / stop from the account section land
 *      as PUTs, the list re-renders, validation errors stay local.
 *   6. Demo persona: no medications, no card, no writes.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:medication-reminders
 */
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const localStorageBacking = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => localStorageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => void localStorageBacking.set(key, String(value)),
  removeItem: (key: string) => void localStorageBacking.delete(key),
};

import React, { act } from 'react';
import { create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';

import { PatientProvider, usePatient } from '../context/PatientContext';
import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { usePatientAccount, type PatientAccountState } from '../context/PatientAccountContext';

type AccountKind = PatientAccountState['account'];
import { TodaysMedicationsCard } from '../components/patient/TodaysMedicationsCard';
import { MedicationsSection } from '../components/account/MedicationsSection';
import { setConnectivityOverride } from '../lib/connectivity';
import { localTodayKey } from '../lib/live-patient-entry';
import { reminderPlanFor } from '../lib/device-feature-core';
import { firedAtOf, reminderDoseFromResponse } from '../lib/reminder-response';
import { projectWrite, pendingEntityKeys, type QueuedWrite, type WriteProjectionState } from '../lib/patient-write-queue';
import {
  adherenceSummary,
  DOSE_CORRECTION_WINDOW_DAYS,
  doseStateFor,
  doseStatuses,
  occurrencesBetween,
  occurrencesOn,
  seedMedicationsFor,
  shiftDateKey,
  validateMedicationInput,
  weekdayOf,
  withinCorrectionWindow,
  type DoseLogRecord,
  type MedicationRecord,
} from '../lib/medication-schedule';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';
import { announcements } from './onboarding-gate-stubs/react-native';

let checks = 0;
let failures = 0;

function fail(message: string) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) fail(label);
}

function section(name: string) {
  console.log(`\n· ${name}`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TODAY = localTodayKey();
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const DROPS_ID = '11111111-1111-4111-8111-111111111111';
const SHOT_ID = '22222222-2222-4222-8222-222222222222';
const base = { notes: null, stopDate: null, source: 'onboarding' as const, version: 'v1', updatedAt: '2026-09-01T00:00:00.000Z' };
const drops: MedicationRecord = {
  ...base, id: DROPS_ID, name: 'THINNR Protocol drops', form: 'drops', dose: '1 mL under the tongue',
  scheduleKind: 'daily', times: ['08:00', '15:00', '22:00'], weekday: null, startDate: shiftDateKey(TODAY, -20),
};
const injection: MedicationRecord = {
  ...base, id: SHOT_ID, name: 'GLP-1 injection', form: 'injection', dose: '0.5 mg',
  scheduleKind: 'weekly', times: ['09:00'], weekday: weekdayOf(TODAY), startDate: shiftDateKey(TODAY, -20),
};

// ─── Scripted patient-data API ───────────────────────────────────────────────

interface ServerStore {
  medications: Record<string, unknown>[];
  doseLogs: Record<string, unknown>[];
  receipts: Map<string, Scripted>;
}
interface ApiCall {
  method: string;
  path: string;
  token: string | null;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
  replayed: boolean;
}
type Scripted = { status: number; body: unknown };

const serverStores = new Map<string, ServerStore>();
const tokenRoles = new Map<string, { kind: string; patientId?: string }>();
const apiCalls: ApiCall[] = [];
let networkDead = false;

function storeFor(patientId: string): ServerStore {
  let store = serverStores.get(patientId);
  if (!store) {
    store = { medications: [], doseLogs: [], receipts: new Map() };
    serverStores.set(patientId, store);
  }
  return store;
}

function applyWrite(key: string, call: ApiCall, store: ServerStore): Scripted {
  if (key === 'PUT patient-data/medications') {
    const parsed = validateMedicationInput(call.body?.medication);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error, field: parsed.field } };
    const index = store.medications.findIndex(m => m.id === parsed.value.id);
    const row = { ...parsed.value, source: index >= 0 ? store.medications[index].source : 'patient', version: `v${Date.now()}` };
    if (index >= 0) store.medications[index] = row;
    else store.medications.push(row);
    return { status: 200, body: { medication: row } };
  }
  if (key === 'POST patient-data/medication-doses') {
    const body = call.body ?? {};
    store.doseLogs = store.doseLogs.filter(
      d => !(d.medicationId === body.medicationId && d.dueDate === body.dueDate && d.dueTime === body.dueTime),
    );
    if (body.status === null) return { status: 200, body: { ok: true, log: null } };
    const log = { ...body, loggedAt: new Date().toISOString() };
    store.doseLogs.push(log);
    return { status: 200, body: { ok: true, log } };
  }
  if (key === 'POST patient-data/check-ins' || key === 'POST patient-data/entries' || key === 'PUT patient-data/water' || key === 'PUT patient-data/prefs' || key === 'PUT patient-data/targets') {
    return { status: 200, body: { ok: true } };
  }
  throw new Error(`unscripted route: ${key}`);
}

function routeCall(call: ApiCall): Scripted {
  const key = `${call.method} ${call.path}`;
  if (key === 'GET claim/whoami') {
    const role = call.token ? tokenRoles.get(call.token) : undefined;
    return role ? { status: 200, body: role } : { status: 401, body: { error: 'Sign in required.' } };
  }
  const role = call.token ? tokenRoles.get(call.token) : undefined;
  if (!role || role.kind !== 'patient' || !role.patientId) return { status: role ? 403 : 401, body: { error: 'Sign in required.' } };
  const store = storeFor(role.patientId);
  if (key === 'GET patient-data/profile') {
    return {
      status: 200,
      body: {
        profile: {
          firstName: 'Dose', lastName: 'Patient', email: 'dose@example.com', phone: '+15551234567', dateOfBirth: '1990-01-15',
          heightInches: 66, startingWeight: 190, currentWeight: 185, goalWeight: 150, timezone: TZ,
          programId: 'thinnr', programStartDate: shiftDateKey(TODAY, -20), setupComplete: true,
        },
      },
    };
  }
  if (key === 'GET patient-data/state') {
    return {
      status: 200,
      body: {
        entries: [], water: {}, targets: {}, favorites: [], recents: [], checkIns: [], photos: [],
        medications: store.medications, doseLogs: store.doseLogs,
        entry: { firstName: 'Dose', programStartDate: shiftDateKey(TODAY, -20), todayKey: TODAY, programDay: 21 },
      },
    };
  }
  const receiptKey = call.idempotencyKey;
  if (receiptKey && store.receipts.has(receiptKey)) {
    call.replayed = true;
    return store.receipts.get(receiptKey)!;
  }
  const result = applyWrite(key, call, store);
  if (receiptKey && result.status < 300) store.receipts.set(receiptKey, result);
  return result;
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://thinnr.test' || !url.pathname.startsWith('/api/')) throw new Error(`unexpected fetch: ${url.href}`);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers.Authorization ?? null;
  const call: ApiCall = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: url.pathname.slice('/api/'.length),
    token: auth?.startsWith('Bearer ') ? auth.slice(7) : null,
    idempotencyKey: headers['Idempotency-Key'] ?? null,
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    replayed: false,
  };
  apiCalls.push(call);
  if (networkDead) throw new TypeError('network request failed');
  const result = routeCall(call);
  return { ok: result.status < 300, status: result.status, json: async () => result.body } as Response;
}) as typeof fetch;

const P1: StubSession = { access_token: 'tok-p1', user: { id: 'user-p1' } };
tokenRoles.set('tok-p1', { kind: 'patient', patientId: 'p-1' });

// ─── Probe + render helpers ──────────────────────────────────────────────────

type Ctx = ReturnType<typeof usePatient>;
let ctx!: Ctx;
let account!: AccountKind;

function Probe() {
  ctx = usePatient();
  account = usePatientAccount().account;
  return null;
}

async function tick(ms = 5): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
}
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick(1);
}
async function waitFor(label: string, condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await tick(5);
  assert(label, condition());
}

async function mountLive(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      React.createElement(
        PatientAccountProvider,
        null,
        React.createElement(
          PatientProvider,
          null,
          React.createElement(Probe),
          React.createElement(TodaysMedicationsCard),
          React.createElement(MedicationsSection),
        ),
      ),
    );
  });
  await settle();
  return tree;
}

async function signIn(session: StubSession | null): Promise<void> {
  await act(async () => { setStubSession(session); });
  await settle();
}

function byTestID(tree: ReactTestRenderer, testID: string): ReactTestInstance | null {
  const found = tree.root.findAll(node => node.props?.testID === testID && typeof node.type === 'string');
  return found[0] ?? null;
}
function textOf(node: ReactTestInstance | null): string {
  if (!node) return '';
  return node
    .findAll(n => typeof n.type === 'string' && n.type === 'Text')
    .flatMap(n => React.Children.toArray(n.props.children as React.ReactNode))
    .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('');
}
async function press(tree: ReactTestRenderer, testID: string): Promise<boolean> {
  const node = byTestID(tree, testID);
  if (!node || typeof node.props.onPress !== 'function' || node.props.disabled) return false;
  await act(async () => { await node.props.onPress(); });
  await settle();
  return true;
}
async function type(tree: ReactTestRenderer, testID: string, value: string): Promise<boolean> {
  const node = byTestID(tree, testID);
  if (!node || typeof node.props.onChangeText !== 'function') return false;
  await act(async () => { node.props.onChangeText(value); });
  return true;
}
function doseCalls(): ApiCall[] {
  return apiCalls.filter(c => c.path === 'patient-data/medication-doses');
}
function medCalls(): ApiCall[] {
  return apiCalls.filter(c => c.path === 'patient-data/medications');
}
function logFor(medicationId: string, dueDate: string, dueTime: string): DoseLogRecord | undefined {
  return ctx.doseLogs.find(l => l.medicationId === medicationId && l.dueDate === dueDate && l.dueTime === dueTime);
}

// ─── The walk ────────────────────────────────────────────────────────────────

async function main() {
  // ── 1 · Schedule core ──────────────────────────────────────────────────────
  section('schedule core: occurrences, timezone + DST, dose states, correction window, adherence, seeds');
  const early: MedicationRecord = { ...drops, startDate: '2026-01-01' };
  const daily = occurrencesOn(early, '2026-03-08', 'America/New_York');
  assert('three daily occurrences on a scheduled day', daily.length === 3 && daily.map(o => o.dueTime).join(',') === '08:00,15:00,22:00');
  assert('spring-forward day: 08:00 local is 12:00Z (EDT)', daily[0].dueAt === '2026-03-08T12:00:00.000Z');
  assert('day before DST: 08:00 local is 13:00Z (EST)', occurrencesOn(early, '2026-03-07', 'America/New_York')[0].dueAt === '2026-03-07T13:00:00.000Z');
  assert('fall-back day keeps the wall-clock time', occurrencesOn(early, '2026-11-01', 'America/New_York')[2].dueAt === '2026-11-02T03:00:00.000Z');
  assert('same wall time in another zone is a different instant', occurrencesOn(early, '2026-03-08', 'America/Los_Angeles')[0].dueAt === '2026-03-08T15:00:00.000Z');
  const wed: MedicationRecord = { ...injection, weekday: 3, startDate: '2026-01-01' };
  assert('weekly fires on its weekday only', occurrencesOn(wed, '2026-09-09', 'UTC').length === 1 && occurrencesOn(wed, '2026-09-10', 'UTC').length === 0);
  assert('nothing before start or after stop', occurrencesOn({ ...early, startDate: '2026-09-10' }, '2026-09-09', 'UTC').length === 0
    && occurrencesOn({ ...early, stopDate: '2026-09-08' }, '2026-09-09', 'UTC').length === 0
    && occurrencesOn({ ...early, stopDate: '2026-09-08' }, '2026-09-08', 'UTC').length === 3);
  const week = occurrencesBetween([early, wed], '2026-09-07', '2026-09-13', 'UTC');
  assert('a week of both records = 21 daily + 1 weekly, sorted by instant', week.length === 22
    && week.every((o, i) => i === 0 || o.dueAt >= week[i - 1].dueAt));
  const occ = daily[0];
  assert('upcoming before due', doseStateFor(occ, null, new Date('2026-03-08T11:00:00Z')) === 'upcoming');
  assert('due inside the grace window', doseStateFor(occ, null, new Date('2026-03-08T12:30:00Z')) === 'due');
  assert('missed after the grace window', doseStateFor(occ, null, new Date('2026-03-08T20:00:00Z')) === 'missed');
  const takenLog: DoseLogRecord = { id: 'l1', medicationId: DROPS_ID, dueDate: '2026-03-08', dueTime: '08:00', status: 'taken', source: 'reminder', loggedAt: '' };
  assert('a log wins over the clock', doseStateFor(occ, takenLog, new Date('2026-03-08T20:00:00Z')) === 'taken');
  assert('correction window is today back 7 days inclusive', withinCorrectionWindow('2026-09-07', '2026-09-07') && withinCorrectionWindow('2026-08-31', '2026-09-07')
    && !withinCorrectionWindow('2026-08-30', '2026-09-07') && !withinCorrectionWindow('2026-09-08', '2026-09-07'));
  const logs = [takenLog, { ...takenLog, id: 'l2', dueTime: '15:00', status: 'skipped' as const }];
  const statuses = doseStatuses([early], logs, '2026-03-08', '2026-03-08', 'America/New_York', new Date('2026-03-09T12:00:00Z'));
  assert('statuses reflect logs and the clock', statuses.map(s => s.state).join(',') === 'taken,skipped,missed');
  const summary = adherenceSummary([early], logs, '2026-03-08', '2026-03-08', 'America/New_York', new Date('2026-03-09T12:00:00Z'));
  assert('adherence sums taken / skipped / missed', summary.taken === 1 && summary.skipped === 1 && summary.missed === 1 && summary.due === 3 && summary.rate === 33);
  const partial = adherenceSummary([early], logs, '2026-03-08', '2026-03-08', 'America/New_York', new Date('2026-03-08T20:00:00Z'));
  assert('future occurrences are not yet due', partial.due === 2 && partial.missed === 0);
  let n = 0;
  const seedThinnr = seedMedicationsFor({ programId: 'thinnr', startDate: '2026-09-01', dailyTimes: ['08:00', '15:00', '22:00'] }, () => `id-${++n}`);
  assert('THINNR program seeds one daily record with the three reminder times', seedThinnr.length === 1 && seedThinnr[0].scheduleKind === 'daily' && seedThinnr[0].times.join(',') === '08:00,15:00,22:00');
  const seedGlp = seedMedicationsFor({ programId: 'glp1', startDate: '2026-09-01', injectionWeekday: 4, injectionTime: '09:30' }, () => `id-${++n}`);
  assert('GLP-1 seeds a weekly injection on the chosen day', seedGlp.length === 1 && seedGlp[0].scheduleKind === 'weekly' && seedGlp[0].weekday === 4 && seedGlp[0].times[0] === '09:30');
  assert('GLP-1 without a day and "none" seed nothing', seedMedicationsFor({ programId: 'glp1', startDate: '2026-09-01' }, () => 'x').length === 0
    && seedMedicationsFor({ programId: 'none', startDate: '2026-09-01' }, () => 'x').length === 0);

  // ── 2 · Reminder response → dose intent ───────────────────────────────────
  section('reminder responses: actions, taps, fire-day, stamp units, foreign payloads');
  const fired = Date.UTC(2026, 8, 7, 1, 30); // 2026-09-06 21:30 New York
  const content = { data: { feature: 'medication-reminder', medicationId: DROPS_ID, dueTime: '22:00', weekday: null } };
  const taken = reminderDoseFromResponse({ actionIdentifier: 'taken', notification: { date: fired, request: { content } } }, 'America/New_York');
  assert('Taken action logs the due day the reminder FIRED on (not the tap day)', taken?.status === 'taken' && taken.log.dueDate === '2026-09-06' && taken.log.dueTime === '22:00' && taken.log.source === 'reminder');
  const skipped = reminderDoseFromResponse({ actionIdentifier: 'skipped', notification: { date: fired / 1000, request: { content } } }, 'America/New_York');
  assert('Skip action with an iOS seconds stamp resolves the same day', skipped?.status === 'skipped' && skipped.log.dueDate === '2026-09-06');
  const tap = reminderDoseFromResponse({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { date: fired, request: { content } } }, 'America/New_York');
  assert('a plain tap carries no status (opens the check-in card)', tap !== null && tap.status === null && tap.log.medicationId === DROPS_ID);
  assert('foreign notifications are ignored', reminderDoseFromResponse({ actionIdentifier: 'taken', notification: { date: fired, request: { content: { data: { route: '/today' } } } } }, 'UTC') === null
    && reminderDoseFromResponse({ actionIdentifier: 'taken', notification: { date: fired, request: { content: { data: { feature: 'medication-reminder', medicationId: DROPS_ID, dueTime: 'noon' } } } } }, 'UTC') === null);
  assert('missing fire stamps fall back to now', Math.abs(firedAtOf(undefined).getTime() - Date.now()) < 5000 && Math.abs(firedAtOf(0).getTime() - Date.now()) < 5000);

  // ── 3 · Queue projection of medication writes ──────────────────────────────
  section('write queue: medication and dose payloads project and key');
  const emptyProjection: WriteProjectionState = {
    addedEntries: [], waterOverrides: {}, addedCheckIns: [], photos: [], favorites: [], customFoods: [], savedRecipes: [], recents: [],
    targetOverrides: {}, nudgeOptOut: false, nudgeEngaged: false, nudgeLastSentKey: null, nudgeLastCrossingKey: null, medications: [drops], doseLogs: [takenLog],
  };
  const item = (payload: QueuedWrite['payload']): QueuedWrite => ({ id: 'q', payload, summary: 'q', createdAt: 0, attempts: 0, nextAttemptAt: 0, status: 'pending', lastError: null });
  const upserted = projectWrite(emptyProjection, item({ kind: 'medication', medication: { ...drops, dose: '2 mL' } }));
  assert('medication write upserts by id', upserted.medications.length === 1 && upserted.medications[0].dose === '2 mL');
  const added = projectWrite(emptyProjection, item({ kind: 'medication', medication: injection }));
  assert('new medication write appends', added.medications.length === 2);
  const replaced = projectWrite(emptyProjection, item({ kind: 'doseLog', log: { id: 'l9', medicationId: DROPS_ID, dueDate: '2026-03-08', dueTime: '08:00', status: 'skipped', source: 'check_in' }, loggedAt: 'now' }));
  assert('dose write replaces the occurrence', replaced.doseLogs.length === 1 && replaced.doseLogs[0].status === 'skipped');
  const cleared = projectWrite(emptyProjection, item({ kind: 'doseLog', log: { id: 'l9', medicationId: DROPS_ID, dueDate: '2026-03-08', dueTime: '08:00', status: null, source: 'check_in' }, loggedAt: 'now' }));
  assert('null status clears the occurrence', cleared.doseLogs.length === 0);
  const keys = pendingEntityKeys([item({ kind: 'medication', medication: drops }), item({ kind: 'doseLog', log: { id: 'l9', medicationId: DROPS_ID, dueDate: '2026-03-08', dueTime: '08:00', status: 'taken', source: 'reminder' }, loggedAt: 'now' })]);
  assert('pending keys are per medication and per occurrence', keys.has(`medication:${DROPS_ID}`) && keys.has(`dose:${DROPS_ID}:2026-03-08:08:00`));

  // ── 4 · Real account: hydrate, card, log, correct, offline ────────────────
  section('real account: hydrated list drives the card and the device plan');
  const store = storeFor('p-1');
  store.medications = [drops, injection];
  setConnectivityOverride(true);
  const tree = await mountLive();
  await signIn(P1);
  await waitFor('hydrated both medications', () => account.kind === 'real' && ctx.medications.length === 2);
  assert('demo-free doseLogs start empty', ctx.doseLogs.length === 0);
  const plan = reminderPlanFor(ctx.medications, true, ctx.todayKey);
  assert('device plan from the hydrated list: 3 daily + 1 weekly', plan.items.length === 4 && plan.items.filter(i => i.weekday !== null).length === 1);
  assert('card renders today with four dose rows', byTestID(tree, 'today-medications') !== null
    && byTestID(tree, `dose-row-${DROPS_ID}-08:00`) !== null && byTestID(tree, `dose-row-${SHOT_ID}-09:00`) !== null);
  assert('rows name the medication and dose', textOf(byTestID(tree, `dose-row-${SHOT_ID}-09:00`)).includes('GLP-1 injection · 0.5 mg'));

  section('dose logging: taken, clear, skip, correction window, offline replay');
  announcements.length = 0;
  assert('Taken tap accepted', await press(tree, `dose-taken-${DROPS_ID}-08:00`));
  await waitFor('taken log lands locally', () => logFor(DROPS_ID, TODAY, '08:00')?.status === 'taken');
  await waitFor('taken POST reached the server', () => doseCalls().length === 1);
  const first = doseCalls()[0];
  assert('POST carries occurrence + status + check_in source', first.body?.medicationId === DROPS_ID && first.body?.dueDate === TODAY && first.body?.dueTime === '08:00' && first.body?.status === 'taken' && first.body?.source === 'check_in');
  assert('row shows Taken', textOf(byTestID(tree, `dose-row-${DROPS_ID}-08:00`)).includes('Taken'));
  assert('decision announced', announcements.some(a => a.includes('marked taken')));
  assert('Taken again clears', await press(tree, `dose-taken-${DROPS_ID}-08:00`));
  await waitFor('cleared locally', () => logFor(DROPS_ID, TODAY, '08:00') === undefined);
  await waitFor('clear POST has null status', () => doseCalls().length === 2 && doseCalls()[1].body?.status === null);
  assert('Skip tap accepted', await press(tree, `dose-skipped-${SHOT_ID}-09:00`));
  await waitFor('skip replaces the occurrence', () => logFor(SHOT_ID, TODAY, '09:00')?.status === 'skipped' && ctx.doseLogs.length === 1);
  assert('Taken after Skip replaces rather than duplicates', await press(tree, `dose-taken-${SHOT_ID}-09:00`));
  await waitFor('one log per occurrence', () => logFor(SHOT_ID, TODAY, '09:00')?.status === 'taken' && ctx.doseLogs.length === 1);
  await waitFor('server holds exactly one row for the occurrence', () => store.doseLogs.filter(d => d.medicationId === SHOT_ID).length === 1 && store.doseLogs.find(d => d.medicationId === SHOT_ID)?.status === 'taken');

  assert('day switcher steps back', await press(tree, 'today-medications-prev'));
  assert('yesterday label + drops rows (weekly shot absent)', textOf(byTestID(tree, 'today-medications-day')) === 'Yesterday'
    && byTestID(tree, `dose-row-${DROPS_ID}-22:00`) !== null && byTestID(tree, `dose-row-${SHOT_ID}-09:00`) === null);
  const yesterday = shiftDateKey(TODAY, -1);
  assert('late entry for yesterday accepted', await press(tree, `dose-taken-${DROPS_ID}-22:00`));
  await waitFor('correction lands on yesterday', () => logFor(DROPS_ID, yesterday, '22:00')?.status === 'taken' && doseCalls().at(-1)?.body?.dueDate === yesterday);
  for (let i = 0; i < DOSE_CORRECTION_WINDOW_DAYS + 3; i += 1) await press(tree, 'today-medications-prev');
  const earliest = shiftDateKey(TODAY, -DOSE_CORRECTION_WINDOW_DAYS);
  const earliestLabel = new Date(`${earliest}T12:00:00.000Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  assert('cannot step past the 7-day window', textOf(byTestID(tree, 'today-medications-day')) === earliestLabel && byTestID(tree, 'today-medications-prev')?.props.disabled === true);
  assert('earliest day still correctable', await press(tree, `dose-skipped-${DROPS_ID}-08:00`));
  await waitFor('window-edge correction persisted', () => logFor(DROPS_ID, earliest, '08:00')?.status === 'skipped');
  for (let i = 0; i < DOSE_CORRECTION_WINDOW_DAYS + 3; i += 1) await press(tree, 'today-medications-next');
  assert('forward stops at today', textOf(byTestID(tree, 'today-medications-day')) === 'Today' && byTestID(tree, 'today-medications-next')?.props.disabled === true);

  const before = doseCalls().length;
  await act(async () => { setConnectivityOverride(false); });
  await settle();
  assert('offline Taken accepted locally', await press(tree, `dose-taken-${DROPS_ID}-15:00`));
  await waitFor('offline decision shows immediately', () => logFor(DROPS_ID, TODAY, '15:00')?.status === 'taken');
  assert('nothing sent while offline', doseCalls().length === before);
  await act(async () => { setConnectivityOverride(true); });
  await waitFor('reconnect replays the queued dose', () => doseCalls().length === before + 1 && store.doseLogs.some(d => d.medicationId === DROPS_ID && d.dueTime === '15:00' && d.status === 'taken'));
  assert('replayed write rides an idempotency key', doseCalls().at(-1)?.idempotencyKey !== null);

  // ── 5 · Account section: add / edit / stop ────────────────────────────────
  section('account medications: add, validation, edit, stop');
  assert('section lists both records', byTestID(tree, `medication-row-${DROPS_ID}`) !== null && byTestID(tree, `medication-row-${SHOT_ID}`) !== null
    && textOf(byTestID(tree, `medication-row-${SHOT_ID}`)).includes('Weekly'));
  assert('open add form', await press(tree, 'account-medication-add'));
  assert('form mounted', byTestID(tree, 'medication-form') !== null);
  await type(tree, 'medication-name', 'Vitamin D3');
  await press(tree, 'medication-form-capsule');
  await type(tree, 'medication-dose', '2000 IU');
  await type(tree, 'medication-time-0', 'breakfast');
  const medsBefore = medCalls().length;
  assert('save with a bad time', await press(tree, 'medication-save'));
  assert('bad time is rejected locally with no PUT', byTestID(tree, 'medication-form-error') !== null && medCalls().length === medsBefore);
  await type(tree, 'medication-time-0', '7:30 AM');
  assert('save valid', await press(tree, 'medication-save'));
  await waitFor('new medication in context', () => ctx.medications.some(m => m.name === 'Vitamin D3' && m.times[0] === '07:30' && m.form === 'capsule' && m.dose === '2000 IU'));
  await waitFor('PUT landed', () => medCalls().length === medsBefore + 1 && store.medications.some(m => m.name === 'Vitamin D3'));
  assert('form closed and list grew', byTestID(tree, 'medication-form') === null && tree.root.findAll(n => typeof n.props?.testID === 'string' && n.props.testID.startsWith('medication-row-') && typeof n.type === 'string').length === 3);
  const vit = ctx.medications.find(m => m.name === 'Vitamin D3')!;
  assert('today card gained the new dose row', byTestID(tree, `dose-row-${vit.id}-07:30`) !== null);
  assert('reminder plan gains the new alarm', reminderPlanFor(ctx.medications, true, ctx.todayKey).items.some(i => i.data.medicationId === vit.id && i.hour === 7 && i.minute === 30));

  assert('open edit', await press(tree, `medication-edit-${vit.id}`));
  assert('edit form pre-fills', byTestID(tree, 'medication-name')?.props.value === 'Vitamin D3' && byTestID(tree, 'medication-time-0')?.props.value === '7:30 AM');
  await press(tree, 'medication-time-add');
  await type(tree, 'medication-time-1', '7:30 PM');
  assert('save edit', await press(tree, 'medication-save'));
  await waitFor('edit lands with two times', () => ctx.medications.find(m => m.id === vit.id)?.times.join(',') === '07:30,19:30');
  await waitFor('edit PUT keeps the id', () => medCalls().at(-1)?.body?.medication != null && (medCalls().at(-1)!.body!.medication as { id: string }).id === vit.id);

  assert('stop the injection', await press(tree, `medication-stop-${SHOT_ID}`));
  await waitFor('stop sets today as the stop date', () => ctx.medications.find(m => m.id === SHOT_ID)?.stopDate === TODAY);
  assert('stopped record moves to the STOPPED group with no stop button', byTestID(tree, `medication-stop-${SHOT_ID}`) === null && textOf(byTestID(tree, `medication-row-${SHOT_ID}`)).includes('Stopped'));
  assert('a stop dated today still fires today, gone tomorrow', reminderPlanFor(ctx.medications, true, ctx.todayKey).items.some(i => i.data.medicationId === SHOT_ID)
    && !reminderPlanFor(ctx.medications, true, shiftDateKey(ctx.todayKey, 1)).items.some(i => i.data.medicationId === SHOT_ID));
  assert('stop announced with its reminder consequence', announcements.some(a => a.includes('stopped') && a.includes('reminders are cancelled')));

  // ── 6 · Demo persona untouched ─────────────────────────────────────────────
  section('demo persona: no medications, no card, no writes');
  const callsBefore = apiCalls.length;
  await signIn(null);
  await waitFor('back to the demo persona', () => account.kind === 'demo');
  assert('demo has no medications or dose logs', ctx.medications.length === 0 && ctx.doseLogs.length === 0);
  assert('card and section render nothing actionable for the demo', byTestID(tree, 'today-medications') === null && byTestID(tree, 'account-medications-empty') !== null);
  let demoLogged = true;
  await act(async () => { demoLogged = await ctx.logDose({ medicationId: DROPS_ID, dueDate: TODAY, dueTime: '08:00', status: 'taken', source: 'check_in' }); });
  assert('demo dose log is refused', demoLogged === false);
  assert('no API traffic from the demo', apiCalls.filter(c => c.method !== 'GET').length === apiCalls.slice(0, callsBefore).filter(c => c.method !== 'GET').length);

  await act(async () => { tree.unmount(); });

  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
