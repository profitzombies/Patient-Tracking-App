/**
 * Passwordless auth screens check (mobile).
 *
 * Renders the REAL patient-login, patient-signup, and provider-login screens
 * (with the real AppModeContext, OnboardingFields, LedgerPrimitives, and the
 * real lib/auth-api client) under Node via react-test-renderer —
 * tsconfig.patient-auth.json remaps native-only modules to the shared
 * onboarding-gate stubs and @/lib/supabase to a verifyOtp-recording fake —
 * then walks every phase against a scripted auth API:
 *
 *   1. Patient login is patient-first: phone field up front, zero password
 *      inputs anywhere, signup + provider doors routing to the right screens.
 *      Local validation (unparseable phone, short code) never hits the
 *      network; the code phase surfaces the dev code and the server's
 *      neutral notice verbatim.
 *   2. A verified login code becomes a session: the client trades the
 *      server's tokenHash through supabase.auth.verifyOtp, flips the app
 *      mode, and lands on /today (patients) or / (staff). Wrong codes show
 *      the server's error and never mint; a failed mint never navigates.
 *   3. Provider login sends realm 'staff' and flips the app into staff mode.
 *   4. Signup walks office code → phone → text code → details, posting the
 *      exact payloads (normalized phone, office code, signup token); an
 *      existing phone signs straight in with no details step; a taken email
 *      shows the server's words and stays put.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:patient-auth
 */
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// AppModeContext persists through globalThis.localStorage when Platform.OS
// is 'web' — which the shared react-native stub pins — so Node needs a shim.
const localStorageBacking = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => localStorageBacking.get(key) ?? null,
  setItem: (key: string, value: string) => void localStorageBacking.set(key, String(value)),
  removeItem: (key: string) => void localStorageBacking.delete(key),
};

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import PatientLoginScreen from '../app/patient-login';
import PatientSignupScreen from '../app/patient-signup';
import ProviderLoginScreen from '../app/provider-login';
import { AppModeProvider } from '../context/AppModeContext';
import { clearRouterCalls, routerCalls } from './onboarding-gate-stubs/expo-router';
import { clearAuthStub, failNextVerifyOtp, verifyOtpCalls } from './patient-auth-stubs/supabase';

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

// ─── Scripted auth API ───────────────────────────────────────────────────────

interface ApiCall {
  path: string; // e.g. "login/start", "signup/verify"
  body: Record<string, unknown> | null;
}

type Handler = (call: ApiCall) => { status: number; body: unknown };

const apiCalls: ApiCall[] = [];
const handlers = new Map<string, Handler>();

function onApi(path: string, handler: Handler) {
  handlers.set(path, handler);
}

function callsTo(path: string): ApiCall[] {
  return apiCalls.filter(call => call.path === path);
}

function resetApi() {
  apiCalls.length = 0;
  handlers.clear();
}

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  const match = url.match(/^https:\/\/thinnr\.test\/api\/auth\/(.+)$/);
  if (!match) throw new Error(`unexpected fetch: ${url}`);
  const call: ApiCall = {
    path: match[1],
    body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
  };
  apiCalls.push(call);
  const handler = handlers.get(call.path);
  if (!handler) {
    fail(`no scripted handler for /auth/${call.path}`);
    return { status: 500, json: async () => ({ error: 'unscripted' }) };
  }
  const result = handler(call);
  return { status: result.status, json: async () => result.body };
}) as typeof fetch;

// ─── Render + drive helpers ──────────────────────────────────────────────────

type Tree = ReactTestRenderer;

async function renderScreen(Screen: React.ComponentType): Promise<Tree> {
  clearRouterCalls();
  clearAuthStub();
  localStorageBacking.clear();
  let tree!: Tree;
  await act(async () => {
    tree = create(React.createElement(AppModeProvider, null, React.createElement(Screen)));
  });
  return tree;
}

function nodes(tree: Tree, testID: string) {
  return tree.root.findAllByProps({ testID }).filter(node => typeof node.type === 'string');
}

function exists(tree: Tree, testID: string): boolean {
  return nodes(tree, testID).length > 0;
}

async function typeText(tree: Tree, testID: string, value: string) {
  const input = nodes(tree, testID).find(node => typeof node.props.onChangeText === 'function');
  if (!input) {
    fail(`no text input ${testID}`);
    return;
  }
  await act(async () => {
    (input.props.onChangeText as (v: string) => void)(value);
  });
}

function inputValue(tree: Tree, testID: string): string | undefined {
  const input = nodes(tree, testID).find(node => 'value' in node.props);
  return input?.props.value as string | undefined;
}

async function press(tree: Tree, testID: string) {
  const target = nodes(tree, testID).find(node => typeof node.props.onPress === 'function');
  if (!target) {
    fail(`no pressable ${testID}`);
    return;
  }
  if (target.props.disabled === true) {
    fail(`pressable ${testID} is disabled`);
    return;
  }
  await act(async () => {
    await (target.props.onPress as () => unknown)();
  });
}

type RenderedNode = { children?: (RenderedNode | string)[] } | string | null;

function textOf(tree: Tree): string {
  const parts: string[] = [];
  const walk = (node: RenderedNode | RenderedNode[]) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (node.children) walk(node.children);
  };
  walk(tree.toJSON() as RenderedNode | RenderedNode[]);
  return parts.join(' ');
}

function errorText(tree: Tree, testID: string): string {
  // ErrorBox receives its copy via the `message` prop; findAllByProps also
  // returns the composite wrapper, so read the prop rather than the subtree.
  return tree.root
    .findAllByProps({ testID })
    .map(node => String((node.props as { message?: unknown }).message ?? ''))
    .join(' ');
}

function passwordInputCount(tree: Tree): number {
  return tree.root.findAll(
    node => typeof node.type === 'string' && node.props?.secureTextEntry === true,
  ).length;
}

function appMode(): string | null {
  return localStorageBacking.get('thinnr_app_mode_v1') ?? null;
}

function navigated(method: 'push' | 'replace', target: string): boolean {
  return routerCalls.some(call => call.method === method && call.target === target);
}

// ─── Scenarios: patient login ────────────────────────────────────────────────

async function scenarioPatientFirstSurface() {
  section('patient login is patient-first, passwordless, with both doors');
  resetApi();
  const tree = await renderScreen(PatientLoginScreen);

  assert('phone field is the primary surface', exists(tree, 'login-phone'));
  assert('no password input anywhere on the screen', passwordInputCount(tree) === 0);
  assert('no email field before the fallback toggle', !exists(tree, 'login-email'));
  assert('provider door renders at the bottom', exists(tree, 'login-provider'));
  assert('demo door stays available', exists(tree, 'login-demo'));

  await press(tree, 'login-provider');
  assert('provider door opens the staff login screen', navigated('push', '/provider-login'));

  await press(tree, 'login-signup');
  assert('signup link opens the signup flow', navigated('push', '/patient-signup'));
  assert('surface interactions never touch the network', apiCalls.length === 0);
  tree.unmount();
}

async function scenarioPatientLoginLocalValidation() {
  section('patient login validates the phone locally before any network call');
  resetApi();
  const tree = await renderScreen(PatientLoginScreen);

  await typeText(tree, 'login-phone', 'abc');
  await press(tree, 'login-submit');
  assert('unparseable phone stays local', apiCalls.length === 0);
  assert(
    'unparseable phone explains itself',
    errorText(tree, 'login-error').includes('cell phone number'),
  );
  assert('screen stays on the identify phase', !exists(tree, 'login-otp'));
  tree.unmount();
}

async function scenarioPatientPhoneLogin() {
  section('patient phone login: code phase, wrong code, then a real session');
  resetApi();
  let verifyCalls = 0;
  onApi('login/start', () => ({
    status: 200,
    body: {
      ok: true,
      requestId: 'req-1',
      message: 'If that matches an account, a code is on its way.',
      devCode: '654321',
    },
  }));
  onApi('login/verify', () => {
    verifyCalls += 1;
    if (verifyCalls === 1) {
      return {
        status: 400,
        body: { error: 'That code didn’t match or has expired. Request a fresh one.' },
      };
    }
    return { status: 200, body: { ok: true, realm: 'patient', tokenHash: 'th-patient-1' } };
  });

  const tree = await renderScreen(PatientLoginScreen);
  await typeText(tree, 'login-phone', '813-555-1234');
  await press(tree, 'login-submit');

  const start = callsTo('login/start')[0];
  assert('start carries the patient realm', start?.body?.realm === 'patient');
  assert('start sends the normalized E.164 phone', start?.body?.identifier === '+18135551234');
  assert('code phase renders', exists(tree, 'login-otp'));
  assert('dev-mode code is surfaced inline', textOf(tree).includes('654321'));
  assert(
    'the server’s neutral notice is shown verbatim',
    textOf(tree).includes('If that matches an account'),
  );
  assert('no password input in the code phase', passwordInputCount(tree) === 0);

  await typeText(tree, 'login-otp', '111111');
  await press(tree, 'login-verify');
  assert(
    'wrong code shows the server’s error',
    errorText(tree, 'login-error').includes('didn’t match or has expired'),
  );
  assert('wrong code never mints a session', verifyOtpCalls.length === 0);
  assert('wrong code never navigates', routerCalls.length === 0);

  await typeText(tree, 'login-otp', '654321');
  await press(tree, 'login-verify');
  const verify = callsTo('login/verify')[1];
  assert('verify posts the requestId + code', verify?.body?.requestId === 'req-1' && verify?.body?.code === '654321');
  assert(
    'the tokenHash is traded through verifyOtp as an email token',
    verifyOtpCalls.length === 1 &&
      verifyOtpCalls[0].token_hash === 'th-patient-1' &&
      verifyOtpCalls[0].type === 'email',
  );
  assert('app mode flips to patient', appMode() === 'patient');
  assert('login lands on the patient home', navigated('replace', '/today'));
  tree.unmount();
}

async function scenarioPatientShortCodeStaysLocal() {
  section('a short code is rejected locally without spending a verify attempt');
  resetApi();
  onApi('login/start', () => ({
    status: 200,
    body: { ok: true, requestId: 'req-1', message: null, devCode: '654321' },
  }));

  const tree = await renderScreen(PatientLoginScreen);
  await typeText(tree, 'login-phone', '8135551234');
  await press(tree, 'login-submit');
  await typeText(tree, 'login-otp', '123');
  await press(tree, 'login-verify');
  assert('short code shows the 6-digit hint', errorText(tree, 'login-error').includes('6-digit'));
  assert('short code never reaches the server', callsTo('login/verify').length === 0);
  tree.unmount();
}

async function scenarioPatientEmailFallback() {
  section('the email fallback sends an email identifier in the patient realm');
  resetApi();
  onApi('login/start', () => ({
    status: 200,
    body: { ok: true, requestId: 'req-9', message: null, devCode: '111222' },
  }));

  const tree = await renderScreen(PatientLoginScreen);
  await press(tree, 'login-switch-channel');
  assert('toggle swaps the phone field for email', exists(tree, 'login-email') && !exists(tree, 'login-phone'));

  await press(tree, 'login-submit');
  assert('empty email stays local', apiCalls.length === 0);
  assert('empty email explains itself', errorText(tree, 'login-error').includes('email'));

  await typeText(tree, 'login-email', '  Casey@Example.com ');
  await press(tree, 'login-submit');
  const start = callsTo('login/start')[0];
  assert('email start keeps the patient realm', start?.body?.realm === 'patient');
  assert('email is trimmed before sending', start?.body?.identifier === 'Casey@Example.com');
  assert('code phase renders for the email channel', exists(tree, 'login-otp'));
  tree.unmount();
}

async function scenarioPatientResendUsesFreshRequest() {
  section('resend swaps in a fresh requestId and clears the typed code');
  resetApi();
  let starts = 0;
  onApi('login/start', () => {
    starts += 1;
    return {
      status: 200,
      body: { ok: true, requestId: `req-${starts}`, message: null, devCode: '654321' },
    };
  });
  onApi('login/verify', () => ({
    status: 200,
    body: { ok: true, realm: 'patient', tokenHash: 'th-fresh' },
  }));

  const tree = await renderScreen(PatientLoginScreen);
  await typeText(tree, 'login-phone', '8135551234');
  await press(tree, 'login-submit');
  await typeText(tree, 'login-otp', '999999');
  await press(tree, 'login-resend');
  assert('resend fires a second start', callsTo('login/start').length === 2);
  assert('resend clears the typed code', inputValue(tree, 'login-otp') === '');

  await typeText(tree, 'login-otp', '654321');
  await press(tree, 'login-verify');
  assert('verify uses the fresh requestId', callsTo('login/verify')[0]?.body?.requestId === 'req-2');
  tree.unmount();
}

async function scenarioPatientMintFailureNeverNavigates() {
  section('a failed session mint surfaces calm copy and never navigates');
  resetApi();
  onApi('login/start', () => ({
    status: 200,
    body: { ok: true, requestId: 'req-1', message: null, devCode: '654321' },
  }));
  onApi('login/verify', () => ({
    status: 200,
    body: { ok: true, realm: 'patient', tokenHash: 'th-doomed' },
  }));

  const tree = await renderScreen(PatientLoginScreen);
  await typeText(tree, 'login-phone', '8135551234');
  await press(tree, 'login-submit');
  await typeText(tree, 'login-otp', '654321');
  failNextVerifyOtp('Token has expired or is invalid');
  await press(tree, 'login-verify');
  assert(
    'the mint failure maps to the calm expired-code copy',
    errorText(tree, 'login-error').includes('didn’t match or has expired'),
  );
  assert('a failed mint never navigates', routerCalls.length === 0);
  assert('a failed mint never flips the app mode', appMode() === null);
  tree.unmount();
}

// ─── Scenarios: provider login ───────────────────────────────────────────────

async function scenarioProviderLogin() {
  section('provider login sends realm staff and flips the app into staff mode');
  resetApi();
  onApi('login/start', () => ({
    status: 200,
    body: {
      ok: true,
      requestId: 'req-staff-1',
      message: 'If that address has an account, a sign-in code is on its way.',
      devCode: '424242',
    },
  }));
  onApi('login/verify', () => ({
    status: 200,
    body: { ok: true, realm: 'staff', tokenHash: 'th-staff-1' },
  }));

  const tree = await renderScreen(ProviderLoginScreen);
  assert('staff door is labeled provider access', textOf(tree).includes('PROVIDER ACCESS'));
  assert('no password input on the staff door', passwordInputCount(tree) === 0);

  await typeText(tree, 'provider-email', 'nope');
  await press(tree, 'provider-send');
  assert('a bad email stays local', apiCalls.length === 0);
  assert('bad email explains itself', errorText(tree, 'provider-error').includes('work email'));

  await typeText(tree, 'provider-email', 'rivera@clinic.example');
  await press(tree, 'provider-send');
  const start = callsTo('login/start')[0];
  assert('staff start carries the staff realm', start?.body?.realm === 'staff');
  assert('staff start sends the email', start?.body?.identifier === 'rivera@clinic.example');
  assert('code phase renders with the dev code', textOf(tree).includes('424242'));

  await typeText(tree, 'provider-otp', '424242');
  await press(tree, 'provider-verify');
  assert(
    'staff tokenHash is traded through verifyOtp',
    verifyOtpCalls.length === 1 && verifyOtpCalls[0].token_hash === 'th-staff-1',
  );
  assert('app mode flips to staff', appMode() === 'staff');
  assert('staff login lands on the staff home', navigated('replace', '/'));
  tree.unmount();
}

async function scenarioProviderBackDoor() {
  section('the staff door backs out to the patient-first sign-in');
  resetApi();
  const tree = await renderScreen(ProviderLoginScreen);
  await press(tree, 'provider-back-login');
  assert('back returns to the patient login', navigated('replace', '/patient-login'));
  tree.unmount();
}

// ─── Scenarios: patient signup ───────────────────────────────────────────────

async function scenarioSignupOfficeValidation() {
  section('signup validates the provider code locally and surfaces lookup misses');
  resetApi();
  let lookups = 0;
  onApi('signup/office', () => {
    lookups += 1;
    if (lookups === 1) {
      return {
        status: 404,
        body: { error: 'That provider code didn’t match an active office. Double-check it with your provider.' },
      };
    }
    return { status: 200, body: { ok: true, officeName: 'Bayshore Slim Clinic' } };
  });

  const tree = await renderScreen(PatientSignupScreen);
  assert('no password input anywhere in signup', passwordInputCount(tree) === 0);

  await typeText(tree, 'signup-code', '12');
  await press(tree, 'signup-lookup');
  assert('a short code stays local', apiCalls.length === 0);
  assert('short code explains the format', errorText(tree, 'signup-error').includes('5 or 6 digit'));

  await typeText(tree, 'signup-code', '99999');
  await press(tree, 'signup-lookup');
  assert('a lookup miss shows the server’s words', errorText(tree, 'signup-error').includes('didn’t match an active office'));
  assert('a miss stays on the office step', exists(tree, 'signup-code'));

  await typeText(tree, 'signup-code', '654321');
  await press(tree, 'signup-lookup');
  assert('a hit advances to the phone step', exists(tree, 'signup-phone'));
  assert('the office name is shown before any code is sent', textOf(tree).includes('Bayshore Slim Clinic'));
  tree.unmount();
}

async function scenarioSignupFullFlow() {
  section('signup end to end: office → phone → text code → details → session');
  resetApi();
  onApi('signup/office', () => ({ status: 200, body: { ok: true, officeName: 'Bayshore Slim Clinic' } }));
  onApi('signup/start', () => ({
    status: 200,
    body: {
      ok: true,
      requestId: 'req-su-1',
      message: 'If that number can join this office, a code is on its way.',
      devCode: '135790',
    },
  }));
  onApi('signup/verify', () => ({
    status: 200,
    body: { ok: true, mode: 'new', signupToken: 'a'.repeat(64) },
  }));
  onApi('signup/complete', () => ({ status: 200, body: { ok: true, tokenHash: 'th-signup-1' } }));

  const tree = await renderScreen(PatientSignupScreen);
  await typeText(tree, 'signup-code', '654321');
  await press(tree, 'signup-lookup');
  await typeText(tree, 'signup-phone', '813-555-0101');
  await press(tree, 'signup-send');

  const start = callsTo('signup/start')[0];
  assert('signup start carries the office code', start?.body?.code === '654321');
  assert('signup start sends the normalized phone', start?.body?.phone === '+18135550101');
  assert('verify step shows the dev code', textOf(tree).includes('135790'));

  await typeText(tree, 'signup-otp', '135790');
  await press(tree, 'signup-verify');
  assert('a new phone advances to the details step', exists(tree, 'signup-name'));
  assert('no session is minted before details are in', verifyOtpCalls.length === 0);

  await press(tree, 'signup-complete');
  assert('empty name stays local', callsTo('signup/complete').length === 0);
  assert('empty name explains itself', errorText(tree, 'signup-error').includes('name'));

  await typeText(tree, 'signup-name', 'Riley Newcomer');
  await typeText(tree, 'signup-email', 'riley@example.com');
  await press(tree, 'signup-complete');
  const complete = callsTo('signup/complete')[0];
  assert(
    'complete posts the signup token + details',
    complete?.body?.signupToken === 'a'.repeat(64) &&
      complete?.body?.name === 'Riley Newcomer' &&
      complete?.body?.email === 'riley@example.com',
  );
  assert(
    'the account’s first session is minted from the returned tokenHash',
    verifyOtpCalls.length === 1 && verifyOtpCalls[0].token_hash === 'th-signup-1',
  );
  assert('signup flips the app into patient mode', appMode() === 'patient');
  assert('signup lands on the patient home', navigated('replace', '/today'));
  tree.unmount();
}

async function scenarioSignupExistingPhoneSignsIn() {
  section('an existing phone signs straight in at verify — no duplicate account');
  resetApi();
  onApi('signup/office', () => ({ status: 200, body: { ok: true, officeName: 'Bayshore Slim Clinic' } }));
  onApi('signup/start', () => ({
    status: 200,
    body: { ok: true, requestId: 'req-su-2', message: null, devCode: '246802' },
  }));
  onApi('signup/verify', () => ({
    status: 200,
    body: { ok: true, mode: 'existing', tokenHash: 'th-existing-1' },
  }));

  const tree = await renderScreen(PatientSignupScreen);
  await typeText(tree, 'signup-code', '654321');
  await press(tree, 'signup-lookup');
  await typeText(tree, 'signup-phone', '8135550101');
  await press(tree, 'signup-send');
  await typeText(tree, 'signup-otp', '246802');
  await press(tree, 'signup-verify');

  assert('the details step is skipped entirely', !exists(tree, 'signup-name'));
  assert(
    'the existing account’s tokenHash mints the session',
    verifyOtpCalls.length === 1 && verifyOtpCalls[0].token_hash === 'th-existing-1',
  );
  assert('existing phone lands on the patient home', navigated('replace', '/today'));
  assert('no complete call is ever made', callsTo('signup/complete').length === 0);
  tree.unmount();
}

async function scenarioSignupEmailTakenStaysPut() {
  section('a taken email shows the server’s words and keeps the details step');
  resetApi();
  onApi('signup/office', () => ({ status: 200, body: { ok: true, officeName: 'Bayshore Slim Clinic' } }));
  onApi('signup/start', () => ({
    status: 200,
    body: { ok: true, requestId: 'req-su-3', message: null, devCode: '112233' },
  }));
  onApi('signup/verify', () => ({
    status: 200,
    body: { ok: true, mode: 'new', signupToken: 'b'.repeat(64) },
  }));
  onApi('signup/complete', () => ({
    status: 409,
    body: {
      error: 'That email is already on a patient account. Use it to sign in instead, or enter a different one.',
      field: 'email',
    },
  }));

  const tree = await renderScreen(PatientSignupScreen);
  await typeText(tree, 'signup-code', '654321');
  await press(tree, 'signup-lookup');
  await typeText(tree, 'signup-phone', '8135550101');
  await press(tree, 'signup-send');
  await typeText(tree, 'signup-otp', '112233');
  await press(tree, 'signup-verify');
  await typeText(tree, 'signup-name', 'Riley Newcomer');
  await typeText(tree, 'signup-email', 'taken@example.com');
  await press(tree, 'signup-complete');

  assert(
    'the taken-email error is the server’s copy',
    errorText(tree, 'signup-error').includes('already on a patient account'),
  );
  assert('the details step survives the rejection', exists(tree, 'signup-complete'));
  assert('no session is minted on a rejected complete', verifyOtpCalls.length === 0);
  assert('no navigation on a rejected complete', routerCalls.length === 0);
  tree.unmount();
}

async function scenarioSignupBackNavigation() {
  section('back steps retreat one phase at a time without losing the office');
  resetApi();
  onApi('signup/office', () => ({ status: 200, body: { ok: true, officeName: 'Bayshore Slim Clinic' } }));

  const tree = await renderScreen(PatientSignupScreen);
  await typeText(tree, 'signup-code', '654321');
  await press(tree, 'signup-lookup');
  assert('phone step reached', exists(tree, 'signup-phone'));

  await press(tree, 'signup-back');
  assert('back from phone returns to the office step', exists(tree, 'signup-code'));
  assert('the typed code is preserved', inputValue(tree, 'signup-code') === '654321');

  await press(tree, 'signup-back');
  assert('back from the office step leaves for the login screen', navigated('replace', '/patient-login'));
  tree.unmount();
}

// ─── Runner ──────────────────────────────────────────────────────────────────

let finished = false;

process.on('beforeExit', () => {
  if (!finished) {
    console.error('\nFAIL verify-patient-auth: the suite ended without finishing (dangling await?)');
    process.exit(1);
  }
});

async function main() {
  await scenarioPatientFirstSurface();
  await scenarioPatientLoginLocalValidation();
  await scenarioPatientPhoneLogin();
  await scenarioPatientShortCodeStaysLocal();
  await scenarioPatientEmailFallback();
  await scenarioPatientResendUsesFreshRequest();
  await scenarioPatientMintFailureNeverNavigates();
  await scenarioProviderLogin();
  await scenarioProviderBackDoor();
  await scenarioSignupOfficeValidation();
  await scenarioSignupFullFlow();
  await scenarioSignupExistingPhoneSignsIn();
  await scenarioSignupEmailTakenStaysPut();
  await scenarioSignupBackNavigation();

  finished = true;
  console.log(`\n${checks} checks, ${failures} failures`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(error => {
  finished = true;
  console.error('\nverify-patient-auth crashed:', error);
  process.exit(1);
});
