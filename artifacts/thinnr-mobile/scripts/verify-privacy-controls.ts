/**
 * Consent gating + the account screen's Privacy & data controls (task check).
 *
 * Renders the REAL PatientAccountProvider + PatientProvider under Node via
 * react-test-renderer (tsconfig.privacy-controls.json remaps native-only
 * modules to the shared stubs) with the consent screen and the account
 * screen's PrivacyDataControls mounted underneath, against a scripted
 * patient-data API whose privacy block behaves like the server:
 *
 *   1. Route admission: a real account with no consent (or consent on an
 *      older policy version) is parked on /consent — before onboarding —
 *      and a pending deletion parks it there too; demo never is.
 *   2. Consent screen: the three required agreements gate the button, the
 *      write carries the required version + app version + platform, and a
 *      successful record unlocks routes without a rehydrate. A policy bump
 *      re-prompts with the "updated terms" framing. Sign out is available.
 *   3. Export: request → in-flight status → ready with a download that
 *      resolves a short-lived URL and hands it to the platform; expired and
 *      failed archives read honestly and allow a new request.
 *   4. Deletion: typed confirmation gates the request; the pending state
 *      shows the grace countdown and "Keep my account" cancels it; signing
 *      in during the grace period lands on the consent screen's keep/sign
 *      out fork.
 *   5. The demo persona sees one unavailable card and makes zero privacy
 *      network calls; server errors surface with the server's words.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:privacy-controls
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
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { PatientProvider, usePatient, usePatientSyncNotice } from '../context/PatientContext';
import { PatientAccountProvider } from '../context/PatientAccountProvider';
import { usePatientAccount, type PatientAccountState } from '../context/PatientAccountContext';
import {
  ACCOUNT_CLOSED_MESSAGE,
  liveEntryDecision,
} from '../lib/live-patient-entry';
import { describeExport, graceDaysRemaining, parsePrivacyState } from '../lib/patient-privacy';
import ConsentScreen from '../app/consent';
import { PrivacyDataControls } from '../components/account/PrivacyDataControls';
import { setStubSession, type StubSession } from './live-diary-stubs/supabase';
import { openedUrls } from './onboarding-gate-stubs/react-native';
import { routerCalls } from './onboarding-gate-stubs/expo-router';

let checks = 0;
let failures = 0;
function fail(message: string) { failures += 1; console.error(`  FAIL  ${message}`); }
function assert(label: string, condition: boolean) { checks += 1; if (!condition) fail(label); }
function section(name: string) { console.log(`\n· ${name}`); }

// ─── Scripted server ────────────────────────────────────────────────────────

const REQUIRED_VERSION = '2026-09-01';
let requiredVersion = REQUIRED_VERSION;

interface ConsentRow { policyVersion: string; photoAnalysis: boolean; recordedAt: string; appVersion?: string; platform?: string }
interface ExportRow { id: string; status: 'queued' | 'running' | 'ready' | 'failed' | 'expired'; requestedAt: string; completedAt: string | null; expiresAt: string; sizeBytes: number | null; error: string | null }
interface Store {
  consents: ConsentRow[];
  exports: ExportRow[];
  deletion: {
    requestedAt: string;
    purgeAfter: string;
    status: 'pending' | 'held';
  } | null;
  onboardingComplete: boolean;
}

const stores = new Map<string, Store>();
function storeFor(patientId: string): Store {
  let store = stores.get(patientId);
  if (!store) { store = { consents: [], exports: [], deletion: null, onboardingComplete: true }; stores.set(patientId, store); }
  return store;
}
const tokenRoles = new Map<string, { kind: string; patientId?: string }>();
interface ApiCall { method: string; path: string; token: string | null; body: Record<string, unknown> | null }
const apiCalls: ApiCall[] = [];
const failNext = new Map<string, { status: number; body: unknown }>();
let exportSeq = 0;
// Grace countdowns are computed against the device clock, so the fixture rides it too.
const NOW = Date.now();

function privacyBlock(store: Store) {
  const latest = store.consents[store.consents.length - 1];
  const job = store.exports[store.exports.length - 1];
  return {
    consent: {
      requiredVersion,
      recordedVersion: latest?.policyVersion ?? null,
      satisfied: latest?.policyVersion === requiredVersion,
      photoAnalysis: latest ? latest.photoAnalysis : null,
      recordedAt: latest?.recordedAt ?? null,
    },
    export: job ?? null,
    deletion: store.deletion,
    deletionPolicy: { graceDays: 7, retentionYears: 8 },
  };
}

function routeCall(call: ApiCall): { status: number; body: unknown } {
  const key = `${call.method} ${call.path}`;
  const scripted = failNext.get(key);
  if (scripted) { failNext.delete(key); return scripted; }
  if (key === 'GET claim/whoami') {
    const role = call.token ? tokenRoles.get(call.token) : undefined;
    return role ? { status: 200, body: role } : { status: 401, body: { error: 'Sign in required.' } };
  }
  const role = call.token ? tokenRoles.get(call.token) : undefined;
  if (!role?.patientId) return { status: 401, body: { error: 'Sign in required.' } };
  const store = storeFor(role.patientId);
  const profile = { firstName: 'Pat', lastName: 'Example', email: `${role.patientId}@example.com`, phone: '+15550001010', dateOfBirth: '1985-04-03', heightInches: 66, startingWeight: 205, currentWeight: 191, goalWeight: 165, timezone: 'America/New_York', programId: 'glp1', programStartDate: '2026-08-20', setupComplete: store.onboardingComplete };
  // Like the real server: every data route refuses until the CURRENT policy
  // version is on record; only the privacy/consent/deletion routes are exempt.
  const consent = privacyBlock(store).consent;
  const exempt = key === 'GET patient-data/privacy' || key === 'PUT patient-data/consent' || key === 'POST patient-data/deletion' || key === 'DELETE patient-data/deletion';
  if (!consent.satisfied && !exempt) {
    return { status: 403, body: { error: 'Please review and accept the current terms before continuing.', code: 'CONSENT_REQUIRED', consent } };
  }
  if (key === 'GET patient-data/profile') return { status: 200, body: { profile } };
  if (key === 'GET patient-data/state') {
    return { status: 200, body: { entries: [], water: {}, targets: {}, favorites: [], recents: [], customFoods: [], savedRecipes: [], photos: [], checkIns: [], flags: { nudgeOptOut: false, nudgeEngaged: false, nudgeLastSentKey: null, nudgeLastCrossingKey: null, onboardingComplete: store.onboardingComplete }, entry: { firstName: 'Pat', programStartDate: '2026-08-20', todayKey: '2026-09-07', programDay: 19 }, mediaToken: `mt-${role.patientId}`, privacy: privacyBlock(store) } };
  }
  if (key === 'GET patient-data/privacy') return { status: 200, body: privacyBlock(store) };
  if (key === 'PUT patient-data/consent') {
    const body = call.body ?? {};
    if (body.policyVersion !== requiredVersion) return { status: 409, body: { error: 'Please review the latest policy version.', code: 'POLICY_VERSION_OUTDATED', requiredVersion } };
    if (body.terms !== true || body.privacy !== true || body.healthData !== true) return { status: 400, body: { error: 'All required agreements must be accepted.' } };
    store.consents.push({ policyVersion: String(body.policyVersion), photoAnalysis: body.photoAnalysis === true, recordedAt: new Date(NOW).toISOString(), appVersion: typeof body.appVersion === 'string' ? body.appVersion : undefined, platform: typeof body.platform === 'string' ? body.platform : undefined });
    return { status: 200, body: { consent: privacyBlock(store).consent } };
  }
  if (key === 'GET patient-data/export') return { status: 200, body: { export: store.exports[store.exports.length - 1] ?? null } };
  if (key === 'POST patient-data/export') {
    if (store.deletion) return { status: 409, body: { error: 'Account deletion is pending.' } };
    exportSeq += 1;
    const row: ExportRow = { id: `00000000-0000-4000-8000-0000000000${String(exportSeq).padStart(2, '0')}`, status: 'queued', requestedAt: new Date(NOW).toISOString(), completedAt: null, expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(), sizeBytes: null, error: null };
    store.exports.push(row);
    return { status: 202, body: { export: row } };
  }
  const download = /^patient-data\/export\/([^/]+)\/download-url$/.exec(call.path);
  if (call.method === 'GET' && download) {
    const row = store.exports.find(r => r.id === decodeURIComponent(download[1]));
    if (!row) return { status: 404, body: { error: 'Export not found.' } };
    if (row.status !== 'ready') return { status: 409, body: { error: 'Your archive isn’t ready yet.' } };
    return { status: 200, body: { url: `https://bucket.test/signed/${row.id}?sig=abc`, expiresInSeconds: 300, fileName: `thinnr-data-export-${row.id.slice(0, 8)}.zip` } };
  }
  if (key === 'POST patient-data/deletion') {
    if (call.body?.confirm !== 'DELETE') return { status: 400, body: { error: 'Type DELETE to confirm.' } };
    store.deletion ??= {
      status: 'pending',
      requestedAt: new Date(NOW).toISOString(),
      purgeAfter: new Date(NOW + 7 * 86_400_000).toISOString(),
    };
    return { status: 202, body: { deletion: store.deletion } };
  }
  if (key === 'DELETE patient-data/deletion') {
    const cancelled = store.deletion !== null;
    store.deletion = null;
    return { status: 200, body: { cancelled, deletion: null } };
  }
  if (key === 'POST patient-data/presence') {
    // Account-layer presence heartbeat (real accounts only); not a diary write.
    return { status: 200, body: { ok: true } };
  }
  throw new Error(`unscripted route: ${key}`);
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://thinnr.test' || !url.pathname.startsWith('/api/')) throw new Error(`unexpected fetch: ${url.href}`);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers.Authorization ?? null;
  const call: ApiCall = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname.slice('/api/'.length), token: auth?.startsWith('Bearer ') ? auth.slice(7) : null, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null };
  apiCalls.push(call);
  const result = routeCall(call);
  return { ok: result.status < 300, status: result.status, json: async () => result.body } as Response;
}) as typeof fetch;

const P1: StubSession = { access_token: 'tok-p1', user: { id: 'user-p1' } };
tokenRoles.set('tok-p1', { kind: 'patient', patientId: 'p-1' });
const callsTo = (path: string, method?: string) => apiCalls.filter(c => c.path === path && (!method || c.method === method));

// ─── Render helpers ─────────────────────────────────────────────────────────

type Ctx = ReturnType<typeof usePatient>;
let ctx!: Ctx;
let account!: PatientAccountState;
let notice: ReturnType<typeof usePatientSyncNotice> = null;
function Probe() { ctx = usePatient(); account = usePatientAccount(); notice = usePatientSyncNotice(); return null; }

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); });
}
async function mount(screen: React.ComponentType | null): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(PatientAccountProvider, null, React.createElement(PatientProvider, null, React.createElement(Probe), screen ? React.createElement(screen) : null)));
  });
  await settle();
  return tree;
}
async function unmount(tree: ReactTestRenderer) { await act(async () => { tree.unmount(); }); }
async function signIn(session: StubSession | null) { await act(async () => { setStubSession(session); }); await settle(); }

const hosts = (t: ReactTestRenderer, id: string) => t.root.findAllByProps({ testID: id }).filter(n => typeof n.type === 'string');
const has = (t: ReactTestRenderer, id: string) => hosts(t, id).length > 0;
async function press(t: ReactTestRenderer, id: string) {
  const n = hosts(t, id).find(x => typeof x.props.onPress === 'function');
  if (!n) throw new Error(`missing press ${id}`);
  await act(async () => { n.props.onPress(); });
  await settle();
}
async function type(t: ReactTestRenderer, id: string, value: string) {
  const n = hosts(t, id).find(x => typeof x.props.onChangeText === 'function');
  if (!n) throw new Error(`missing input ${id}`);
  await act(async () => { n.props.onChangeText(value); });
}
function textOf(t: ReactTestRenderer, id: string): string {
  const flatten = (node: unknown): string => Array.isArray(node) ? node.map(flatten).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in (node as object) ? flatten((node as { props: { children?: unknown } }).props.children) : '';
  return hosts(t, id).map(n => flatten(n.props.children)).join('');
}
const btnLabel = (t: ReactTestRenderer, id: string) => t.root.findAllByProps({ testID: id }).map(n => n.props.label).find(x => typeof x === 'string') as string | undefined;
const btnDisabled = (t: ReactTestRenderer, id: string) => t.root.findAllByProps({ testID: id }).map(n => n.props.disabled).find(x => typeof x === 'boolean') as boolean | undefined;

const gate = (overrides: Partial<Parameters<typeof liveEntryDecision>[0]>) => liveEntryDecision({
  modeHydrated: true, mode: 'patient', accountResolving: false, accountKind: 'real', patientHydrated: true,
  onboardingComplete: true, consentSatisfied: true, deletionPending: false, pathname: '/today', ...overrides,
});
const gateFromCtx = (pathname: string) => gate({
  onboardingComplete: ctx.hydratedFlags?.onboardingComplete ?? null,
  consentSatisfied: ctx.hydratedPrivacy?.consent.satisfied ?? null,
  deletionPending: ctx.hydratedPrivacy?.deletion !== null && ctx.hydratedPrivacy?.deletion !== undefined,
  pathname,
});
const redirectTo = (d: ReturnType<typeof liveEntryDecision>) => (d.kind === 'redirect' ? d.href : d.kind);

// ─── The walk ────────────────────────────────────────────────────────────────

async function main() {
  section('route policy: consent before anything, deletion parks the account');
  assert('missing consent → /consent from Today', redirectTo(gate({ consentSatisfied: false })) === '/consent');
  assert('unknown consent (older server) is NOT satisfied', redirectTo(gate({ consentSatisfied: null })) === '/consent');
  assert('consent comes before onboarding', redirectTo(gate({ consentSatisfied: false, onboardingComplete: false, pathname: '/onboarding/welcome' })) === '/consent');
  assert('consent route itself allowed while unmet', redirectTo(gate({ consentSatisfied: false, pathname: '/consent' })) === 'allow');
  assert('satisfied consent leaves /consent for Today', redirectTo(gate({ pathname: '/consent' })) === '/today');
  assert('satisfied consent with onboarding pending leaves /consent for onboarding', redirectTo(gate({ pathname: '/consent', onboardingComplete: false })) === '/onboarding/welcome');
  assert('pending deletion parks a consented account', redirectTo(gate({ deletionPending: true })) === '/consent');
  assert('pending deletion allows the consent route', redirectTo(gate({ deletionPending: true, pathname: '/consent' })) === 'allow');
  assert('normal account still allowed on Today', redirectTo(gate({})) === 'allow');
  assert('demo persona never sees the consent gate', redirectTo(gate({ accountKind: 'demo', demoAdmitted: true, consentSatisfied: null, onboardingComplete: null })) === 'allow');
  assert('unhydrated real account holds', redirectTo(gate({ patientHydrated: false, consentSatisfied: null })) === 'hold');

  section('parser: shapes and honest failures');
  const parsed = parsePrivacyState({ consent: { requiredVersion: 'v2', recordedVersion: 'v1', satisfied: true, photoAnalysis: false, recordedAt: null }, export: null, deletion: null });
  assert('satisfied is recomputed from versions, never trusted alone', parsed.consent.satisfied === false && parsed.consent.photoAnalysis === false);
  assert('older/demo privacy data defaults retention to seven years', parsed.deletionPolicy.retentionYears === 7);
  const held = parsePrivacyState({
    consent: { requiredVersion: 'v2', recordedVersion: 'v2', satisfied: true },
    export: null,
    deletion: { status: 'held', requestedAt: '2026-09-01T00:00:00.000Z', purgeAfter: '2026-09-14T00:00:00.000Z' },
    deletionPolicy: { graceDays: 7, retentionYears: 9 },
  });
  assert('held closure parses with the supplied retention years', held.deletion?.status === 'held' && held.deletionPolicy.retentionYears === 9);
  let threw = false;
  try { parsePrivacyState({ consent: { requiredVersion: 'v2' }, export: { id: 'x' }, deletion: null }); } catch { threw = true; }
  assert('malformed export throws', threw);
  assert('grace days round up', graceDaysRemaining('2026-09-14T12:00:00.000Z', new Date('2026-09-07T12:00:00.001Z')) === 7 && graceDaysRemaining('2026-09-07T11:00:00.000Z', new Date('2026-09-07T12:00:00.000Z')) === 0);
  assert('expired ready archive reads as expired', describeExport({ id: 'a', status: 'ready', requestedAt: 'x', completedAt: 'x', expiresAt: '2000-01-01T00:00:00.000Z', sizeBytes: 10, error: null }).includes('expired'));

  section('consent screen: first visit');
  let tree = await mount(ConsentScreen);
  await signIn(P1);
  assert('hydrated real account with no consent', account.account.kind === 'real' && ctx.hydratedPrivacy?.consent.satisfied === false && ctx.hydratedPrivacy?.consent.recordedVersion === null);
  assert('server refused the data slice (CONSENT_REQUIRED) → privacy fetched from the exempt route, no error notice', callsTo('patient-data/state').length === 1 && callsTo('patient-data/privacy').length === 1 && ctx.hydrated && notice === null && ctx.hydratedFlags === null);
  assert('gate parks on /consent', redirectTo(gateFromCtx('/today')) === '/consent');
  assert('first-visit framing', textOf(tree, 'consent-title') === 'Your data, your say.');
  assert('version stamp visible', textOf(tree, 'consent-version').includes(REQUIRED_VERSION) && textOf(tree, 'consent-version').includes('1.0.0-test'));
  assert('agree disabled until required boxes', btnDisabled(tree, 'consent-agree') === true);
  await press(tree, 'consent-agree');
  assert('blocked agree explains and sends nothing', has(tree, 'consent-error') && callsTo('patient-data/consent').length === 0);
  await press(tree, 'consent-terms');
  await press(tree, 'consent-privacy');
  assert('two of three still disabled', btnDisabled(tree, 'consent-agree') === true);
  await press(tree, 'consent-health');
  assert('all required → enabled', btnDisabled(tree, 'consent-agree') === false);
  await press(tree, 'consent-photo'); // opt out of the optional item
  failNext.set('PUT patient-data/consent', { status: 503, body: { error: 'Consent service is briefly unavailable.' } });
  await press(tree, 'consent-agree');
  assert('server failure surfaces the server words and keeps the gate', textOf(tree, 'consent-error').includes('briefly unavailable') && ctx.hydratedPrivacy?.consent.satisfied === false);
  await press(tree, 'consent-agree');
  const consentCall = callsTo('patient-data/consent', 'PUT').pop();
  assert('consent write carries version, agreements, app version, platform', consentCall?.body?.policyVersion === REQUIRED_VERSION && consentCall.body.terms === true && consentCall.body.privacy === true && consentCall.body.healthData === true && consentCall.body.photoAnalysis === false && consentCall.body.appVersion === '1.0.0-test' && consentCall.body.platform === 'web');
  assert('recorded consent unlocks routes and rehydrates the refused data slice', ctx.hydratedPrivacy?.consent.satisfied === true && ctx.hydratedPrivacy.consent.photoAnalysis === false && redirectTo(gateFromCtx('/consent')) === '/today' && callsTo('patient-data/state').length === 2 && ctx.hydratedFlags?.onboardingComplete === true && ctx.hydrated);
  await unmount(tree);

  section('consent screen: policy version bump re-prompts');
  requiredVersion = '2026-12-01';
  tree = await mount(ConsentScreen);
  assert('new version = not satisfied on hydrate', ctx.hydratedPrivacy?.consent.satisfied === false && ctx.hydratedPrivacy?.consent.recordedVersion === REQUIRED_VERSION && redirectTo(gateFromCtx('/today')) === '/consent');
  assert('update framing names both versions', textOf(tree, 'consent-title') === 'Please review the updated terms.' && textOf(tree, 'consent-version').includes('2026-12-01'));
  await press(tree, 'consent-terms'); await press(tree, 'consent-privacy'); await press(tree, 'consent-health');
  await press(tree, 'consent-agree');
  assert('re-consent recorded on the new version', ctx.hydratedPrivacy?.consent.satisfied === true && ctx.hydratedPrivacy.consent.recordedVersion === '2026-12-01' && storeFor('p-1').consents.length === 2);
  assert('a version bump keeps the earlier photo opt-out (never silently flips it on)', ctx.hydratedPrivacy?.consent.photoAnalysis === false);
  await unmount(tree);

  section('account controls: export lifecycle');
  const privacyCallsBefore = apiCalls.length;
  tree = await mount(PrivacyDataControls);
  assert('controls render for a consented real account', has(tree, 'privacy-controls') && !has(tree, 'privacy-unavailable'));
  assert('consent status reads recorded version', textOf(tree, 'privacy-consent-status').includes('2026-12-01'));

  section('account controls: photo analysis is a live choice');
  assert('status reads the photo choice and offers the opposite', textOf(tree, 'privacy-consent-status').includes('Photo analysis: off') && btnLabel(tree, 'privacy-photo-analysis-toggle') === 'Turn photo analysis on');
  await press(tree, 'privacy-photo-analysis-toggle');
  const toggleCall = callsTo('patient-data/consent', 'PUT').pop();
  assert('toggle re-records the CURRENT version with the new choice (required items stay agreed)', toggleCall?.body?.policyVersion === '2026-12-01' && toggleCall.body.photoAnalysis === true && toggleCall.body.terms === true && toggleCall.body.healthData === true);
  assert('choice lands in context and the label flips', ctx.hydratedPrivacy?.consent.photoAnalysis === true && textOf(tree, 'privacy-consent-status').includes('Photo analysis: on') && btnLabel(tree, 'privacy-photo-analysis-toggle') === 'Turn photo analysis off');
  failNext.set('PUT patient-data/consent', { status: 503, body: { error: 'Consent service is briefly unavailable.' } });
  await press(tree, 'privacy-photo-analysis-toggle');
  assert('a failed toggle keeps the old choice and shows the server words', ctx.hydratedPrivacy?.consent.photoAnalysis === true && textOf(tree, 'privacy-error').includes('briefly unavailable'));
  assert('no export yet: request offered, no download', btnLabel(tree, 'privacy-export-request') === 'Request my data' && !has(tree, 'privacy-export-download'));
  await press(tree, 'privacy-export-request');
  assert('request posted and in-flight state shown', callsTo('patient-data/export', 'POST').length === 1 && ctx.hydratedPrivacy?.export?.status === 'queued' && btnDisabled(tree, 'privacy-export-request') === true && textOf(tree, 'privacy-export-status').includes('putting your archive together'));
  // The worker finishes; the poll (or a reload) picks it up.
  const job = storeFor('p-1').exports[0];
  Object.assign(job, { status: 'ready', completedAt: new Date(NOW).toISOString(), sizeBytes: 20_480 });
  await unmount(tree);
  tree = await mount(PrivacyDataControls);
  assert('ready archive offers a download with size', has(tree, 'privacy-export-download') && textOf(tree, 'privacy-export-status').includes('20 KB'));
  await press(tree, 'privacy-export-download');
  assert('download resolves a signed URL and opens it', callsTo(`patient-data/export/${job.id}/download-url`).length === 1 && openedUrls[openedUrls.length - 1] === `https://bucket.test/signed/${job.id}?sig=abc`);
  assert('a new export can be requested after a ready one', btnLabel(tree, 'privacy-export-request') === 'Request a new export' && btnDisabled(tree, 'privacy-export-request') === false);
  await unmount(tree);
  Object.assign(job, { status: 'failed', error: 'Archive build failed.' });
  tree = await mount(PrivacyDataControls);
  assert('failed archive reads honestly, no download', textOf(tree, 'privacy-export-status').includes('didn’t finish') && !has(tree, 'privacy-export-download'));
  await unmount(tree);
  Object.assign(job, { status: 'expired', error: null });
  tree = await mount(PrivacyDataControls);
  assert('expired archive reads honestly', textOf(tree, 'privacy-export-status').includes('expired') && !has(tree, 'privacy-export-download'));

  section('account controls: deletion with confirmation, grace, cancel');
  assert('no confirm panel before the first tap', !has(tree, 'privacy-deletion-confirm'));
  await press(tree, 'privacy-deletion-start');
  assert('typed confirmation required', has(tree, 'privacy-deletion-confirm') && btnDisabled(tree, 'privacy-deletion-submit') === true);
  assert(
    'closure confirmation names removed app data and the retained medical record',
    textOf(tree, 'privacy-deletion-confirm').includes('login and devices') &&
      textOf(tree, 'privacy-deletion-confirm').includes('AI coach chats') &&
      textOf(tree, 'privacy-deletion-confirm').includes('food diary') &&
      textOf(tree, 'privacy-deletion-confirm').includes('preferences') &&
      textOf(tree, 'privacy-deletion-confirm').includes('required by law') &&
      textOf(tree, 'privacy-deletion-confirm').includes('weights and measurements') &&
      textOf(tree, 'privacy-deletion-confirm').includes('medications') &&
      textOf(tree, 'privacy-deletion-confirm').includes('labs') &&
      textOf(tree, 'privacy-deletion-confirm').includes('progress photos') &&
      textOf(tree, 'privacy-deletion-confirm').includes('care-team messages') &&
      textOf(tree, 'privacy-deletion-confirm').includes('orders') &&
      textOf(tree, 'privacy-deletion-confirm').includes('for 8 years') &&
      btnLabel(tree, 'privacy-deletion-submit') === 'Close my account',
  );
  await type(tree, 'privacy-deletion-confirm-input', 'delete me');
  assert('wrong phrase stays disabled', btnDisabled(tree, 'privacy-deletion-submit') === true);
  await press(tree, 'privacy-deletion-submit');
  assert('blocked submit explains, sends nothing', has(tree, 'privacy-error') && callsTo('patient-data/deletion', 'POST').length === 0);
  await type(tree, 'privacy-deletion-confirm-input', 'delete');
  assert('case-insensitive match enables', btnDisabled(tree, 'privacy-deletion-submit') === false);
  await press(tree, 'privacy-deletion-back');
  assert('never mind closes the panel', !has(tree, 'privacy-deletion-confirm') && callsTo('patient-data/deletion', 'POST').length === 0);
  await press(tree, 'privacy-deletion-start');
  await type(tree, 'privacy-deletion-confirm-input', 'DELETE');
  await press(tree, 'privacy-deletion-submit');
  const deletionCall = callsTo('patient-data/deletion', 'POST').pop();
  assert('request carries the explicit confirmation', deletionCall?.body?.confirm === 'DELETE');
  assert('pending state shows the closure countdown', has(tree, 'privacy-deletion-pending') && ctx.hydratedPrivacy?.deletion?.status === 'pending' && textOf(tree, 'privacy-deletion-pending').includes('account closes in 7 days'));
  assert('export request disabled while deletion pending', btnDisabled(tree, 'privacy-export-request') === true);
  assert('pending deletion now parks routes', redirectTo(gateFromCtx('/today')) === '/consent');
  await press(tree, 'privacy-deletion-cancel');
  assert('cancel clears the request server-side and locally', callsTo('patient-data/deletion', 'DELETE').length === 1 && storeFor('p-1').deletion === null && ctx.hydratedPrivacy?.deletion === null && !has(tree, 'privacy-deletion-pending') && redirectTo(gateFromCtx('/today')) === 'allow');
  await unmount(tree);

  section('sign-in during the grace period: keep or sign out');
  storeFor('p-1').deletion = { status: 'held', requestedAt: new Date(NOW).toISOString(), purgeAfter: new Date(NOW + 3 * 86_400_000).toISOString() };
  tree = await mount(ConsentScreen);
  assert('hydration surfaces the held closure and parks on /consent', ctx.hydratedPrivacy?.deletion?.status === 'held' && redirectTo(gateFromCtx('/today')) === '/consent');
  assert('consent screen shows the held closure fork', has(tree, 'consent-deletion-pending') && textOf(tree, 'consent-deletion-pending').includes('account closes in 3 days') && has(tree, 'consent-keep-account') && has(tree, 'consent-sign-out') && !has(tree, 'consent-agree'));
  await press(tree, 'consent-keep-account');
  assert('keep my account cancels and reopens the app', storeFor('p-1').deletion === null && ctx.hydratedPrivacy?.deletion === null && redirectTo(gateFromCtx('/consent')) === '/today');
  await unmount(tree);
  storeFor('p-1').deletion = { status: 'pending', requestedAt: new Date(NOW).toISOString(), purgeAfter: new Date(NOW + 3 * 86_400_000).toISOString() };
  tree = await mount(ConsentScreen);
  await press(tree, 'consent-sign-out');
  assert('sign out leaves the deletion pending and ends the session', storeFor('p-1').deletion !== null && account.account.kind !== 'real');
  await unmount(tree);
  const privacyCallPaths = apiCalls.slice(privacyCallsBefore).map(c => c.path);
  assert('privacy writes only ever hit the patient-data routes (plus session re-resolution)', privacyCallPaths.every(p => p.startsWith('patient-data/') || p === 'claim/whoami'));

  section('demo persona: unavailable, zero network');
  const before = apiCalls.length;
  tree = await mount(PrivacyDataControls);
  assert('demo shows the unavailable card only', has(tree, 'privacy-unavailable') && !has(tree, 'privacy-controls') && textOf(tree, 'privacy-unavailable').includes('guided demo'));
  assert('demo never touches the privacy routes', apiCalls.length === before && ctx.hydratedPrivacy === null);
  await unmount(tree);

  section('sealed account resolution: neutral message and local sign-out');
  failNext.set('GET claim/whoami', {
    status: 404,
    body: { error: 'This account was closed.', code: 'account_closed' },
  });
  tree = await mount(null);
  await signIn(P1);
  assert(
    'account_closed signs the device out and routes to patient login',
    account.account.kind !== 'real' &&
      routerCalls.some(call => call.method === 'replace' && call.target === '/patient-login'),
  );
  assert(
    'closed-account copy is neutral and allows same-phone signup',
    ACCOUNT_CLOSED_MESSAGE === 'This account was closed. You can create a new account with the same phone number.',
  );
  await unmount(tree);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
