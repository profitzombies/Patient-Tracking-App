/**
 * "Confirm your details" (real-account identity step) regression check.
 *
 * Renders the REAL OnboardingProvider, WelcomeStep, and IdentityStep with
 * react-test-renderer under tsx (tsconfig.onboarding-identity.json maps the
 * native modules to the onboarding-gate stubs and the patient store to a
 * profile-carrying stub) and pins:
 *   1. the welcome reset keeps the on-file name, email, and phone; with both
 *      contacts verified the page is a plain review (name summary, two
 *      Verified badges, no code actions) and one Confirm advances once;
 *   2. phone verified at signup, email pending → only "Send email code";
 *      Confirm explains the email code; the code verifies and Confirm then
 *      advances — no text code is ever requested;
 *   3. email verified (email invite), phone pending → only "Send text code";
 *   4. the name is a read-only summary; Edit opens it, a one-word name blocks
 *      Confirm with a name message, and an edited name is what gets saved;
 *   5. a contact on file but never proven with a code still needs one, and a
 *      missing name opens the field on arrival;
 *   6. the demo persona's run is unchanged (fresh, empty answers; no
 *      identity step in its flow).
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:onboarding-identity
 */
import React, { act, useState } from 'react';

import { OnboardingProvider, useOnboarding } from '../context/OnboardingContext';
import {
  DEMO_ACCOUNT_STATE,
  PatientAccountContext,
  type PatientAccountState,
  type PatientDataApi,
  type PatientProfile,
} from '../context/PatientAccountContext';
import { IdentityStep, WelcomeStep } from '../components/onboarding/StepsAccount';
import {
  contactsMatch,
  DEFAULT_ANSWERS,
  formatUsPhone,
  visibleSteps,
} from '../data/onboarding-data';
import { clearRouterCalls, routerCalls } from './onboarding-gate-stubs/expo-router';
import { setupSaves, StubPatientProvider } from './onboarding-identity-stubs/patient-context';

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

function assertEqual(label: string, actual: unknown, expected: unknown) {
  checks += 1;
  if (actual !== expected) {
    fail(`${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────────

interface TestInstance {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<TestInstance | string>;
  findAll(predicate: (node: TestInstance) => boolean): TestInstance[];
}
interface Renderer {
  root: TestInstance;
  unmount(): void;
}
let createRenderer!: (el: React.ReactElement) => Renderer;

type Onboarding = ReturnType<typeof useOnboarding>;
let onboarding!: Onboarding;
function Probe(): null {
  onboarding = useOnboarding();
  return null;
}

type Screen = 'none' | 'welcome' | 'identity';
let showScreen!: (screen: Screen) => void;
function Screens() {
  const [screen, setScreen] = useState<Screen>('none');
  showScreen = setScreen;
  if (screen === 'welcome') return <WelcomeStep />;
  if (screen === 'identity') return <IdentityStep />;
  return null;
}

const ON_FILE: PatientProfile = {
  firstName: 'Maya',
  lastName: 'Reyes',
  email: 'maya.reyes@gmail.com',
  phone: '+15551234567',
  dateOfBirth: null,
  heightInches: null,
  startingWeight: null,
  currentWeight: null,
  goalWeight: null,
  timezone: null,
  programId: null,
  programStartDate: null,
  setupComplete: false,
};

const VERIFIED: PatientProfile = { ...ON_FILE, emailVerified: true, phoneVerified: true };
const PHONE_ONLY: PatientProfile = { ...ON_FILE, emailVerified: false, phoneVerified: true };
const EMAIL_ONLY: PatientProfile = { ...ON_FILE, emailVerified: true, phoneVerified: false };

/** Every profile-contact call the step makes, in order. */
const apiCalls: Array<{ method: string; input: Record<string, unknown> }> = [];
/** The profile the next successful code check returns. */
let verifiedProfile: PatientProfile = VERIFIED;

const stubApi = {
  requestProfileVerification: async (input: { kind: 'email' | 'phone'; value: string }) => {
    apiCalls.push({ method: 'request', input });
    return { requestId: `req-${input.kind}`, message: 'sent', devCode: '123456' };
  },
  verifyProfileContact: async (input: { requestId: string; code: string }) => {
    apiCalls.push({ method: 'verify', input });
    return { profile: verifiedProfile };
  },
} as unknown as PatientDataApi;

const realAccount: PatientAccountState = {
  resolving: false,
  account: { kind: 'real', patientId: 'patient-identity-test', api: stubApi },
  accountNotice: null,
  retryResolve: () => {},
};

async function mount(accountState: PatientAccountState, profile: PatientProfile | null): Promise<Renderer> {
  clearRouterCalls();
  apiCalls.length = 0;
  setupSaves.length = 0;
  let renderer!: Renderer;
  await act(async () => {
    renderer = createRenderer(
      <PatientAccountContext.Provider value={accountState}>
        <StubPatientProvider initialProfile={profile}>
          <OnboardingProvider>
            <Probe />
            <Screens />
          </OnboardingProvider>
        </StubPatientProvider>
      </PatientAccountContext.Provider>,
    );
  });
  return renderer;
}

async function show(screen: Screen) {
  await act(async () => {
    showScreen(screen);
  });
}

function hosts(root: TestInstance, testID: string): TestInstance[] {
  return root.findAll(n => typeof n.type === 'string' && n.props?.testID === testID);
}

function inputValue(root: TestInstance, testID: string): string {
  const el = hosts(root, testID).find(n => typeof n.props.onChangeText === 'function');
  return (el?.props.value as string | undefined) ?? '<missing>';
}

async function typeText(root: TestInstance, testID: string, value: string) {
  const el = hosts(root, testID).find(n => typeof n.props.onChangeText === 'function');
  if (!el) {
    fail(`input "${testID}" not found`);
    return;
  }
  await act(async () => {
    (el.props.onChangeText as (v: string) => void)(value);
  });
}

async function tap(root: TestInstance, testID: string) {
  const all = hosts(root, testID).filter(n => typeof n.props.onPress === 'function');
  const el = all[all.length - 1];
  if (!el) {
    fail(`pressable "${testID}" not found`);
    return;
  }
  if (el.props.disabled === true) return;
  await act(async () => {
    (el.props.onPress as () => void)();
  });
}

function textOf(node: TestInstance | string): string {
  if (typeof node === 'string') return node;
  return (node.children ?? []).map(textOf).join('');
}

function hintText(root: TestInstance): string | null {
  const box = hosts(root, 'ob-identity-hint');
  return box.length ? textOf(box[0]) : null;
}

function has(root: TestInstance, testID: string): boolean {
  return hosts(root, testID).length > 0;
}

/** Order of the contact rows on the page. */
function rowOrder(root: TestInstance): string[] {
  return root
    .findAll(n => typeof n.type === 'string' && /^ob-(email|phone)-row$/.test(String(n.props?.testID)))
    .map(n => String(n.props.testID).replace(/^ob-|-row$/g, ''))
    .filter((v, i, all) => all.indexOf(v) === i);
}

async function openStep(profile: PatientProfile): Promise<Renderer> {
  const r = await mount(realAccount, profile);
  await show('welcome');
  await show('identity');
  return r;
}

const pushes = () => routerCalls.filter(c => c.method === 'push').map(c => c.target);

// ─── Suite ───────────────────────────────────────────────────────────────────

async function main() {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    realConsoleError(...args);
  };
  const mod = (await import('react-test-renderer')) as unknown as {
    default?: { create: typeof createRenderer };
    create?: typeof createRenderer;
  };
  const TestRenderer = mod.default ?? mod;
  if (!TestRenderer.create) throw new Error('react-test-renderer did not expose create()');
  createRenderer = TestRenderer.create.bind(TestRenderer) as typeof createRenderer;

  // ── 0. Pure contact comparison ─────────────────────────────────────────────
  for (const typed of ['5551234567', '(555) 123-4567', '555-123-4567', '+1 555 123 4567', '15551234567']) {
    assert(`phone "${typed}" matches +15551234567`, contactsMatch('phone', typed, '+15551234567'));
  }
  assert('a different phone never matches', !contactsMatch('phone', '5559876543', '+15551234567'));
  assert('empty phones never match', !contactsMatch('phone', '', ''));
  assert('gmail matches regardless of case/space', contactsMatch('email', '  Maya.Reyes@GMAIL.com ', 'maya.reyes@gmail.com'));
  assert('empty emails never match', !contactsMatch('email', '', null));
  assertEqual('stored +1 phone displays in the US mask', formatUsPhone('+15551234567'), '(555) 123-4567');

  // ── 1. Both verified: a plain review with one Confirm ─────────────────────
  {
    const r = await mount(realAccount, VERIFIED);
    assertEqual('prefill applies before the run begins', onboarding.answers.name, 'Maya Reyes');
    await show('welcome');
    assert('welcome starts a fresh run', onboarding.begun);
    assertEqual('reset keeps the on-file name', onboarding.answers.name, 'Maya Reyes');
    assertEqual('reset keeps the on-file email', onboarding.answers.email, 'maya.reyes@gmail.com');
    assertEqual('reset keeps the on-file phone (display mask)', onboarding.answers.phone, '(555) 123-4567');
    assertEqual('identity follows welcome for real accounts', visibleSteps(onboarding.answers, true)[1], 'identity');

    await show('identity');
    const root = r.root;
    assertEqual('name is a read-only summary', textOf(hosts(root, 'ob-name-summary')[0] ?? ''), 'Maya Reyes');
    assert('no name field until Edit', !has(root, 'ob-name-input'));
    assert('an Edit affordance is offered', has(root, 'ob-name-edit'));
    assertEqual('email shows Verified', hosts(root, 'ob-email-confirmed').length, 1);
    assertEqual('phone shows Verified', hosts(root, 'ob-phone-confirmed').length, 1);
    assertEqual('verified email is shown', textOf(hosts(root, 'ob-email-value')[0] ?? ''), 'maya.reyes@gmail.com');
    assertEqual('verified phone is shown in the mask', textOf(hosts(root, 'ob-phone-value')[0] ?? ''), '(555) 123-4567');
    assert('no contact inputs on a review', !has(root, 'ob-email-input') && !has(root, 'ob-phone-input'));
    assert('no code actions on a review', !has(root, 'ob-verify-email') && !has(root, 'ob-verify-phone'));
    assert(
      'Verified badge is labelled for screen readers',
      hosts(root, 'ob-email-confirmed')[0]?.props.accessibilityLabel === 'Email verified',
    );
    const confirm = hosts(root, 'ob-identity-next').find(n => typeof n.props.onPress === 'function');
    assertEqual('the one action reads Confirm', confirm ? textOf(confirm) : null, 'Confirm');

    await tap(root, 'ob-identity-next');
    assertEqual('no hint on a valid Confirm', hintText(root), null);
    assertEqual('Confirm advances exactly once', pushes().length, 1);
    assertEqual('advances to the next real-account step', pushes()[0], '/onboarding/height');
    assertEqual('no code is sent for a verified review', apiCalls.length, 0);
    await act(async () => r.unmount());
  }

  // ── 2. Phone verified at signup, email pending → email code only ──────────
  {
    verifiedProfile = VERIFIED;
    const r = await openStep(PHONE_ONLY);
    const root = r.root;
    assertEqual('phone shows Verified', hosts(root, 'ob-phone-confirmed').length, 1);
    assert('no text code for the signup-verified phone', !has(root, 'ob-verify-phone'));
    assertEqual('email is prefilled', inputValue(root, 'ob-email-input'), 'maya.reyes@gmail.com');
    assert('email offers the email code', has(root, 'ob-verify-email'));
    assert('email is not Verified yet', !has(root, 'ob-email-confirmed'));
    assertEqual('verified phone reads first, pending email last', rowOrder(root).join(','), 'phone,email');

    await tap(root, 'ob-identity-next');
    assertEqual('pending email blocks Confirm', pushes().length, 0);
    assert('the hint names the email code', /email code/i.test(hintText(root) ?? ''));

    await typeText(root, 'ob-email-input', 'maya@');
    assertEqual('malformed email → email message', hintText(root), 'Enter a valid email address, like you@example.com.');
    await typeText(root, 'ob-email-input', 'Maya.Reyes@Gmail.com ');

    await tap(root, 'ob-verify-email');
    assertEqual('one code request', apiCalls.length, 1);
    assertEqual('it is an email code', apiCalls[0]?.input.kind, 'email');
    assertEqual('for the canonical email', apiCalls[0]?.input.value, 'maya.reyes@gmail.com');
    assert('the code field appears', has(root, 'ob-profile-code'));
    assert('the hint now asks for the emailed code', /6-digit code/i.test(hintText(root) ?? ''));

    await tap(root, 'ob-confirm-profile-code');
    assertEqual('the code is checked once', apiCalls.filter(c => c.method === 'verify').length, 1);
    assertEqual('email now shows Verified', hosts(root, 'ob-email-confirmed').length, 1);
    assert('the code field closes', !has(root, 'ob-profile-code'));
    assertEqual('hint clears once everything is verified', hintText(root), null);
    assert('no text code was ever requested', !apiCalls.some(c => c.input.kind === 'phone'));

    await tap(root, 'ob-identity-next');
    assertEqual('then Confirm advances', pushes().length, 1);
    await act(async () => r.unmount());
  }

  // ── 3. Email verified (email invite), phone pending → text code only ──────
  {
    verifiedProfile = VERIFIED;
    const r = await openStep(EMAIL_ONLY);
    const root = r.root;
    assertEqual('email shows Verified', hosts(root, 'ob-email-confirmed').length, 1);
    assert('no email code for the invite-verified email', !has(root, 'ob-verify-email'));
    assertEqual('phone is prefilled in the mask', inputValue(root, 'ob-phone-input'), '(555) 123-4567');
    assert('phone offers the text code', has(root, 'ob-verify-phone'));
    assertEqual('verified email reads first, pending phone last', rowOrder(root).join(','), 'email,phone');

    await tap(root, 'ob-identity-next');
    const phoneHint = hintText(root) ?? '';
    assert('the hint names the text code', /text code/i.test(phoneHint));
    assert('the phone hint never mentions email', !/email/i.test(phoneHint));
    await typeText(root, 'ob-phone-input', '555123');
    assertEqual('partial phone → phone message', hintText(root), 'Enter a complete phone number, like (555) 123-4567.');

    await typeText(root, 'ob-phone-input', '+1 555 123 4567');
    assertEqual('retyped phone keeps the mask', inputValue(root, 'ob-phone-input'), '(555) 123-4567');
    await tap(root, 'ob-verify-phone');
    assertEqual('it is a text code', apiCalls[0]?.input.kind, 'phone');
    assertEqual('for the canonical phone', apiCalls[0]?.input.value, '+15551234567');

    await typeText(root, 'ob-phone-input', '5559876543');
    assert('changing the phone drops the stale code', !has(root, 'ob-profile-code'));
    await typeText(root, 'ob-phone-input', '5551234567');
    await tap(root, 'ob-verify-phone');
    await tap(root, 'ob-confirm-profile-code');
    assertEqual('phone now shows Verified', hosts(root, 'ob-phone-confirmed').length, 1);
    await tap(root, 'ob-identity-next');
    assertEqual('then Confirm advances', pushes().length, 1);
    await act(async () => r.unmount());
  }

  // ── 4. Editing the name ────────────────────────────────────────────────────
  {
    const r = await openStep(VERIFIED);
    const root = r.root;
    await tap(root, 'ob-name-edit');
    assertEqual('Edit opens the name, prefilled', inputValue(root, 'ob-name-input'), 'Maya Reyes');
    await typeText(root, 'ob-name-input', 'Maya');
    assert('Done is withheld for a one-word name', !has(root, 'ob-name-done'));
    await tap(root, 'ob-identity-next');
    assertEqual('one-word name → name message', hintText(root), 'Enter your first and last name.');
    assertEqual('blocked name never advances', pushes().length, 0);

    await typeText(root, 'ob-name-input', 'Maya Reyes-Cole');
    assertEqual('hint clears once the name is fixed', hintText(root), null);
    await tap(root, 'ob-name-done');
    assertEqual('Done returns to the summary', textOf(hosts(root, 'ob-name-summary')[0] ?? ''), 'Maya Reyes-Cole');
    assert('the field closes', !has(root, 'ob-name-input'));

    await tap(root, 'ob-identity-next');
    assertEqual('edited name confirms and advances', pushes().length, 1);
    const saved = setupSaves[setupSaves.length - 1] as { profile?: { firstName?: string; lastName?: string } } | undefined;
    assertEqual('the edited first name is saved', saved?.profile?.firstName, 'Maya');
    assertEqual('the edited last name is saved', saved?.profile?.lastName, 'Reyes-Cole');
    assertEqual('editing the name sends no code', apiCalls.length, 0);
    await act(async () => r.unmount());
  }

  // ── 5. Unproven contacts still need codes; a missing name opens the field ─
  {
    const r = await openStep(ON_FILE);
    const root = r.root;
    assert('an unproven on-file email is not Verified', !has(root, 'ob-email-confirmed'));
    assert('an unproven on-file phone is not Verified', !has(root, 'ob-phone-confirmed'));
    assert('both code actions are offered', has(root, 'ob-verify-email') && has(root, 'ob-verify-phone'));
    await tap(root, 'ob-identity-next');
    assertEqual('unproven contacts never advance', pushes().length, 0);
    await act(async () => r.unmount());

    const r2 = await openStep({ ...VERIFIED, firstName: '', lastName: '' });
    assert('a missing name opens the field on arrival', has(r2.root, 'ob-name-input'));
    assert('no empty summary is shown', !has(r2.root, 'ob-name-summary'));
    await act(async () => r2.unmount());
  }

  // ── 6. Demo persona: unchanged fresh run ──────────────────────────────────
  {
    const r = await mount(DEMO_ACCOUNT_STATE, VERIFIED);
    await show('welcome');
    assert('demo welcome starts a run', onboarding.begun);
    assertEqual('demo run starts with an empty name', onboarding.answers.name, DEFAULT_ANSWERS.name);
    assertEqual('demo run starts with an empty email', onboarding.answers.email, DEFAULT_ANSWERS.email);
    assertEqual('demo run starts with an empty phone', onboarding.answers.phone, DEFAULT_ANSWERS.phone);
    assert('demo flow has no identity step', !visibleSteps(onboarding.answers).includes('identity'));
    assertEqual('demo flow still goes welcome → contact', visibleSteps(onboarding.answers)[1], 'contact');
    await act(async () => r.unmount());
  }

  if (failures > 0) {
    console.error(`\n✗ onboarding identity step: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ onboarding identity step: ${checks} checks passed`);
  process.exit(0);
}

main().catch(error => {
  console.error('onboarding identity check crashed:', error);
  process.exit(1);
});
