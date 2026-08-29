/**
 * Claim-your-account flow check (mobile).
 *
 * Renders the REAL app/claim-account.tsx screen (with the real
 * AppModeContext, OnboardingFields, and LedgerPrimitives) under Node via
 * react-test-renderer — tsconfig.claim-flow.json remaps native-only modules
 * to the shared onboarding-gate stubs and @/lib/supabase to a recording
 * fake — then walks every phase against a scripted claim API:
 *
 *   1. Identify validates locally (empty / unparseable phone → no network),
 *      sends normalized payloads, and shows the neutral privacy note that
 *      never confirms whether an account exists.
 *   2. Code phase surfaces the dev-mode code inline, absorbs wrong-code
 *      errors, resends with a fresh requestId, and — on the clinic dup-email
 *      409 — dead-ends with Start over (no retry path).
 *   3. Birthday phase masks MM/DD/YYYY as you type, rejects impossible dates
 *      locally, sends ISO, and treats a mismatch 409 as a one-shot dead end.
 *   4. Password phase gates the submit on the live 4-rule checklist, then
 *      complete → auto sign-in with exactly the server-returned identifier →
 *      whoami routing: staff see the "web tools" hand-off, patients get
 *      Continue-to-companion, and phone-less patients get the add-phone
 *      offer whose verify round-trip carries the session Bearer token.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:claim-flow
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

import ClaimAccountScreen from '../app/claim-account';
import { AppModeProvider } from '../context/AppModeContext';
import { clearRouterCalls, routerCalls } from './onboarding-gate-stubs/expo-router';
import {
  clearSignInCalls,
  failNextSignIn,
  normalizePhone,
  signInCalls,
  TEST_ACCESS_TOKEN,
} from './claim-flow-stubs/supabase';

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

// ─── Scripted claim API ──────────────────────────────────────────────────────

interface ApiCall {
  path: string; // e.g. "identify", "add-phone/verify"
  method: string;
  body: Record<string, unknown> | null;
  auth: string | null;
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

globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  const url = String(input);
  const match = url.match(/^https:\/\/thinnr\.test\/api\/claim\/(.+)$/);
  if (!match) throw new Error(`unexpected fetch: ${url}`);
  const call: ApiCall = {
    path: match[1],
    method: init?.method ?? 'GET',
    body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    auth: init?.headers?.Authorization ?? null,
  };
  apiCalls.push(call);
  const handler = handlers.get(call.path);
  if (!handler) {
    fail(`no scripted handler for /claim/${call.path}`);
    return { status: 500, json: async () => ({ error: 'unscripted' }) };
  }
  const result = handler(call);
  return { status: result.status, json: async () => result.body };
}) as typeof fetch;

// ─── Render + drive helpers ──────────────────────────────────────────────────

type Tree = ReactTestRenderer;

async function renderScreen(): Promise<Tree> {
  clearRouterCalls();
  clearSignInCalls();
  let tree!: Tree;
  await act(async () => {
    tree = create(
      React.createElement(AppModeProvider, null, React.createElement(ClaimAccountScreen)),
    );
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

function isDisabled(tree: Tree, testID: string): boolean {
  const target = nodes(tree, testID).find(node => typeof node.props.onPress === 'function');
  if (!target) return false;
  if (target.props.disabled === true) return true;
  const state = target.props.accessibilityState as { disabled?: boolean } | undefined;
  return state?.disabled === true;
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

function errorText(tree: Tree): string {
  // ErrorBox receives its copy via the `message` prop; findAllByProps also
  // returns the composite wrapper, so read the prop rather than the subtree.
  return tree.root
    .findAllByProps({ testID: 'claim-error' })
    .map(node => String((node.props as { message?: unknown }).message ?? ''))
    .join(' ');
}

// Shared happy-path fragments -------------------------------------------------

const GOOD_PASSWORD = 'Passable!Nine';

async function completeToPassword(tree: Tree, password: string) {
  await typeText(tree, 'claim-password', password);
  await typeText(tree, 'claim-password-confirm', password);
  await press(tree, 'claim-password-submit');
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

async function scenarioIdentifyLocalValidation() {
  section('identify validates locally before any network call');
  resetApi();
  const tree = await renderScreen();

  assert('identify phase shows the neutral privacy note', textOf(tree).includes('For your privacy we never confirm'));

  await press(tree, 'claim-identify-submit');
  assert('empty identifier surfaces an inline error', errorText(tree).length > 0 || textOf(tree).includes('Enter the email or mobile number'));
  assert('empty identifier sends nothing', apiCalls.length === 0);

  await typeText(tree, 'claim-identifier', 'abc');
  await press(tree, 'claim-identify-submit');
  assert('unparseable phone stays local', apiCalls.length === 0);
  assert('unparseable phone explains itself', textOf(tree).includes('mobile number'));
  tree.unmount();
}

async function scenarioProviderResetHappyPath() {
  section('provider reset: identify → code (resend, wrong code) → password → auto sign-in → staff hand-off');
  resetApi();
  let requestCounter = 0;
  onApi('identify', () => {
    requestCounter += 1;
    return {
      status: 200,
      body: { ok: true, requestId: `req-${requestCounter}`, devCode: requestCounter === 1 ? '111111' : '222222' },
    };
  });
  onApi('verify', call => {
    if (call.body?.code !== '222222') {
      return { status: 401, body: { error: 'That code didn’t match. Check it and try again.' } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        claimToken: 'tok-provider',
        accountType: 'provider',
        masked: 'd•••@c•••.com',
        next: 'password',
        mode: 'reset',
      },
    };
  });
  onApi('complete', () => ({
    status: 200,
    body: { ok: true, signIn: { method: 'email', identifier: 'dr.reyes@clinic.test' } },
  }));
  onApi('whoami', () => ({
    status: 200,
    body: { kind: 'provider', name: 'Elena Reyes', hasPhone: true, hasEmail: true },
  }));

  const tree = await renderScreen();
  await typeText(tree, 'claim-identifier', 'dr.reyes@clinic.test');
  await press(tree, 'claim-identify-submit');

  assert('identify posts the email as typed', callsTo('identify')[0]?.body?.identifier === 'dr.reyes@clinic.test');
  assert('code phase shows the dev-mode code inline', exists(tree, 'claim-dev-code') && textOf(tree).includes('111111'));

  await typeText(tree, 'claim-code', '999999');
  await press(tree, 'claim-code-submit');
  assert('wrong code surfaces the server message', errorText(tree).includes('didn’t match'));

  await press(tree, 'claim-resend');
  assert('resend re-identifies with the same identifier', callsTo('identify').length === 2 && callsTo('identify')[1]?.body?.identifier === 'dr.reyes@clinic.test');
  assert('resend confirms itself', textOf(tree).includes('We sent a fresh code.'));
  assert('resend swaps in the fresh dev code', textOf(tree).includes('222222'));

  await typeText(tree, 'claim-code', '222222');
  await press(tree, 'claim-code-submit');
  assert('verify carries the FRESH requestId', callsTo('verify').at(-1)?.body?.requestId === 'req-2');
  assert('reset mode titles the password step accordingly', textOf(tree).includes('Set a new password'));
  assert('password step shows the masked identifier', textOf(tree).includes('d•••@c•••.com'));

  await typeText(tree, 'claim-password', 'short');
  assert('unmet checklist keeps submit disabled', isDisabled(tree, 'claim-password-submit'));
  assert('checklist lists all four rules', ['At least 8 characters', 'An uppercase letter', 'A lowercase letter', 'A symbol'].every(rule => textOf(tree).includes(rule)));

  await typeText(tree, 'claim-password', GOOD_PASSWORD);
  await typeText(tree, 'claim-password-confirm', `${GOOD_PASSWORD}typo`);
  assert('mismatched confirm keeps submit disabled', isDisabled(tree, 'claim-password-submit'));
  assert('mismatch hint appears under the confirm box', textOf(tree).includes('These don’t match yet.'));
  await press(tree, 'claim-password-submit');
  assert('pressing while mismatched explains the fix', textOf(tree).includes('Both password boxes need to match.'));
  assert('no complete call fires while mismatched', callsTo('complete').length === 0);

  await completeToPassword(tree, GOOD_PASSWORD);
  assert('complete posts the claim token + password + confirmation', (() => {
    const call = callsTo('complete')[0];
    return call?.body?.claimToken === 'tok-provider' && call?.body?.password === GOOD_PASSWORD && call?.body?.passwordConfirm === GOOD_PASSWORD;
  })());
  assert('auto sign-in uses exactly the server-returned email', signInCalls.length === 1 && signInCalls[0].email === 'dr.reyes@clinic.test' && signInCalls[0].password === GOOD_PASSWORD);
  assert('whoami rides the fresh session token', callsTo('whoami')[0]?.auth === `Bearer ${TEST_ACCESS_TOKEN}`);
  assert('staff land on the web hand-off, not the patient CTA', textOf(tree).includes('operations') && !exists(tree, 'claim-done-continue') && !exists(tree, 'claim-offer-phone'));
  assert('done phase greets by first name', textOf(tree).includes('Welcome back, Elena'));

  await press(tree, 'claim-done-back');
  assert('staff Back to sign in returns to the login screen', routerCalls.some(call => call.method === 'replace' && call.target === '/patient-login'));
  tree.unmount();
}

async function scenarioPatientBirthdayPath() {
  section('patient shared-phone: normalized identify → birthday mask/one-shot → companion hand-off');
  resetApi();
  const rawPhone = '(555) 010-4477';
  const normalized = normalizePhone(rawPhone);
  assert('fixture phone normalizes', typeof normalized === 'string' && normalized.length > 0);

  onApi('identify', () => ({ status: 200, body: { ok: true, requestId: 'req-p1' } }));
  onApi('verify', () => ({
    status: 200,
    body: { ok: true, claimToken: 'tok-patient', accountType: 'patient', masked: '•••4477', next: 'birthday' },
  }));
  onApi('birthday', call =>
    call.body?.birthday === '1975-04-23'
      ? { status: 200, body: { ok: true, mode: 'create', masked: '•••4477' } }
      : { status: 409, body: { error: 'We couldn’t verify your account. Contact your clinic and they’ll get you set up.' } },
  );
  onApi('complete', () => ({
    status: 200,
    body: { ok: true, signIn: { method: 'phone', identifier: normalized } },
  }));
  onApi('whoami', () => ({
    status: 200,
    body: { kind: 'patient', name: 'Rosa Delgado', hasPhone: true, hasEmail: false },
  }));

  const tree = await renderScreen();
  await typeText(tree, 'claim-identifier', rawPhone);
  assert('typed US phone is displayed in the familiar local format', inputValue(tree, 'claim-identifier') === '(555) 010-4477');
  await press(tree, 'claim-identify-submit');
  assert('identify posts the NORMALIZED phone', callsTo('identify')[0]?.body?.identifier === normalized);
  assert('no devCode → no test-mode box', !exists(tree, 'claim-dev-code'));

  await typeText(tree, 'claim-code', '333333');
  await press(tree, 'claim-code-submit');
  assert('multi-match patients are routed to the birthday check', exists(tree, 'claim-birthday'));
  assert('birthday phase warns it is one try', textOf(tree).includes('one try'));

  await typeText(tree, 'claim-birthday', '04231975');
  assert('birthday input masks as MM/DD/YYYY', inputValue(tree, 'claim-birthday') === '04/23/1975');

  await typeText(tree, 'claim-birthday', '02302000');
  await press(tree, 'claim-birthday-submit');
  assert('impossible dates are rejected locally', callsTo('birthday').length === 0);

  await typeText(tree, 'claim-birthday', '04231975');
  await press(tree, 'claim-birthday-submit');
  assert('birthday posts ISO', callsTo('birthday')[0]?.body?.birthday === '1975-04-23');
  assert('create mode titles the password step', textOf(tree).includes('Create your password'));

  await completeToPassword(tree, GOOD_PASSWORD);
  assert('auto sign-in uses the phone credential', signInCalls.length === 1 && signInCalls[0].phone === normalized && !signInCalls[0].email);
  assert('patients with a phone see no add-phone offer', !exists(tree, 'claim-offer-phone'));
  assert('patient done phase offers the companion', exists(tree, 'claim-done-continue'));

  await press(tree, 'claim-done-continue');
  assert('Continue routes into the patient app', routerCalls.some(call => call.method === 'replace' && call.target === '/today'));
  tree.unmount();
}

async function scenarioPatientAddPhone() {
  section('phone-less patient: add-phone offer → Bearer-tokened verify → offer clears');
  resetApi();
  onApi('identify', () => ({ status: 200, body: { ok: true, requestId: 'req-e1', devCode: '444444' } }));
  onApi('verify', () => ({
    status: 200,
    body: { ok: true, claimToken: 'tok-email-patient', accountType: 'patient', masked: 'r•••@h•••.com', next: 'password', mode: 'create' },
  }));
  onApi('complete', () => ({
    status: 200,
    body: { ok: true, signIn: { method: 'email', identifier: 'rosa@home.test' } },
  }));
  onApi('whoami', () => ({
    status: 200,
    body: { kind: 'patient', name: 'Rosa Delgado', hasPhone: false, hasEmail: true },
  }));
  onApi('add-phone', () => ({ status: 200, body: { ok: true, requestId: 'ph-1', devCode: '555555' } }));
  onApi('add-phone/verify', call =>
    call.body?.code === '555555'
      ? { status: 200, body: { ok: true } }
      : { status: 401, body: { error: 'That code didn’t match.' } },
  );

  const tree = await renderScreen();
  await typeText(tree, 'claim-identifier', 'rosa@home.test');
  await press(tree, 'claim-identify-submit');
  await typeText(tree, 'claim-code', '444444');
  await press(tree, 'claim-code-submit');
  await completeToPassword(tree, GOOD_PASSWORD);

  assert('phone-less patient sees the add-phone offer', exists(tree, 'claim-offer-phone'));
  await press(tree, 'claim-offer-phone');

  const rawPhone = '555 010 9911';
  const normalized = normalizePhone(rawPhone);
  await typeText(tree, 'claim-new-phone', rawPhone);
  assert('add-phone field formats ten digits without asking for +1', inputValue(tree, 'claim-new-phone') === '(555) 010-9911');
  await press(tree, 'claim-add-phone-submit');
  assert('add-phone posts the normalized number under the session token', (() => {
    const call = callsTo('add-phone')[0];
    return call?.body?.phone === normalized && call?.auth === `Bearer ${TEST_ACCESS_TOKEN}`;
  })());
  assert('phone dev code shows in test mode', exists(tree, 'claim-phone-dev-code') && textOf(tree).includes('555555'));

  await typeText(tree, 'claim-phone-code', '555555');
  await press(tree, 'claim-phone-code-submit');
  assert('add-phone verify carries requestId + Bearer token', (() => {
    const call = callsTo('add-phone/verify')[0];
    return call?.body?.requestId === 'ph-1' && call?.auth === `Bearer ${TEST_ACCESS_TOKEN}`;
  })());
  assert('phone added confirmation lands on done', textOf(tree).includes('Phone added'));
  assert('offer disappears once a phone exists', !exists(tree, 'claim-offer-phone'));
  assert('companion CTA still present after add-phone', exists(tree, 'claim-done-continue'));
  tree.unmount();
}

async function scenarioClinicDeadEnds() {
  section('clinic dead-ends: dup-email 409 at verify and birthday one-shot both remove the retry path');
  resetApi();
  onApi('identify', () => ({ status: 200, body: { ok: true, requestId: 'req-d1', devCode: '666666' } }));
  onApi('verify', () => ({
    status: 409,
    body: { error: 'We couldn’t verify your account automatically. Contact your clinic and they’ll get you set up.' },
  }));

  let tree = await renderScreen();
  await typeText(tree, 'claim-identifier', 'shared@clinic.test');
  await press(tree, 'claim-identify-submit');
  await typeText(tree, 'claim-code', '666666');
  await press(tree, 'claim-code-submit');
  assert('dup-email 409 surfaces the clinic message', errorText(tree).includes('Contact your clinic'));
  assert('dead end removes the verify button', !exists(tree, 'claim-code-submit'));
  assert('dead end removes resend', !exists(tree, 'claim-resend'));
  assert('dead end offers Start over', exists(tree, 'claim-start-over'));

  await press(tree, 'claim-start-over');
  assert('Start over returns to a clean identify phase', exists(tree, 'claim-identifier') && inputValue(tree, 'claim-code') === undefined);
  tree.unmount();

  resetApi();
  onApi('identify', () => ({ status: 200, body: { ok: true, requestId: 'req-d2' } }));
  onApi('verify', () => ({
    status: 200,
    body: { ok: true, claimToken: 'tok-d2', accountType: 'patient', masked: '•••0000', next: 'birthday' },
  }));
  onApi('birthday', () => ({
    status: 409,
    body: { error: 'We couldn’t verify your account. Contact your clinic and they’ll get you set up.' },
  }));

  tree = await renderScreen();
  await typeText(tree, 'claim-identifier', '+15550100000');
  await press(tree, 'claim-identify-submit');
  await typeText(tree, 'claim-code', '123123');
  await press(tree, 'claim-code-submit');
  await typeText(tree, 'claim-birthday', '01011990');
  await press(tree, 'claim-birthday-submit');
  assert('birthday mismatch is one-shot', callsTo('birthday').length === 1);
  assert('birthday dead end removes its submit', !exists(tree, 'claim-birthday-submit'));
  assert('birthday dead end offers Start over', exists(tree, 'claim-start-over'));
  tree.unmount();
}

async function scenarioSignInFailureStaysRecoverable() {
  section('sign-in failure after complete keeps the user informed on the password step');
  resetApi();
  onApi('identify', () => ({ status: 200, body: { ok: true, requestId: 'req-s1', devCode: '777777' } }));
  onApi('verify', () => ({
    status: 200,
    body: { ok: true, claimToken: 'tok-s1', accountType: 'team_member', masked: 'f•••@c•••.com', next: 'password', mode: 'create' },
  }));
  onApi('complete', () => ({
    status: 200,
    body: { ok: true, signIn: { method: 'email', identifier: 'front@clinic.test' } },
  }));

  const tree = await renderScreen();
  await typeText(tree, 'claim-identifier', 'front@clinic.test');
  await press(tree, 'claim-identify-submit');
  await typeText(tree, 'claim-code', '777777');
  await press(tree, 'claim-code-submit');

  failNextSignIn('Invalid login credentials');
  await completeToPassword(tree, GOOD_PASSWORD);
  assert('failed auto sign-in surfaces a friendly error', errorText(tree).length > 0);
  assert('failed auto sign-in stays on the password phase', exists(tree, 'claim-password-submit'));
  tree.unmount();
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  await scenarioIdentifyLocalValidation();
  await scenarioProviderResetHappyPath();
  await scenarioPatientBirthdayPath();
  await scenarioPatientAddPhone();
  await scenarioClinicDeadEnds();
  await scenarioSignInFailureStaysRecoverable();

  if (failures > 0) {
    console.error(`\n✗ claim flow: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`\n✓ claim flow: ${checks} checks passed`);
  process.exit(0);
}

void main();
