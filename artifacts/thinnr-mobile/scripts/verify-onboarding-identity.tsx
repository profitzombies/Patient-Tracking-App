/**
 * "Tell us about you" (real-account identity step) regression check.
 *
 * Renders the REAL OnboardingProvider, WelcomeStep, and IdentityStep with
 * react-test-renderer under tsx (tsconfig.onboarding-identity.json maps the
 * native modules to the onboarding-gate stubs and the patient store to a
 * profile-carrying stub) and pins:
 *   1. the welcome screen's fresh-start reset keeps the on-file name, email,
 *      and phone, so the identity step opens prefilled;
 *   2. a +1-stored phone matches however it is retyped (10 digits, dashes,
 *      parentheses, +1 prefix) and an on-file gmail.com address is accepted
 *      regardless of case/spacing — both show "Confirmed", not a send button;
 *   3. an untouched, prefilled step continues with exactly one push;
 *   4. the blocked-Next message names the one failing field, and a valid
 *      email is never called invalid;
 *   5. the demo persona's run is unchanged (fresh, empty answers; no
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
import { StubPatientProvider } from './onboarding-identity-stubs/patient-context';

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

const realAccount: PatientAccountState = {
  resolving: false,
  account: { kind: 'real', patientId: 'patient-identity-test', api: {} as PatientDataApi },
  accountNotice: null,
  retryResolve: () => {},
};

async function mount(accountState: PatientAccountState, profile: PatientProfile | null): Promise<Renderer> {
  clearRouterCalls();
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

  // ── 1. Welcome reset keeps the on-file identity; step opens prefilled ─────
  {
    const r = await mount(realAccount, ON_FILE);
    assertEqual('prefill applies before the run begins', onboarding.answers.name, 'Maya Reyes');
    await show('welcome');
    assert('welcome starts a fresh run', onboarding.begun);
    assertEqual('reset keeps the on-file name', onboarding.answers.name, 'Maya Reyes');
    assertEqual('reset keeps the on-file email', onboarding.answers.email, 'maya.reyes@gmail.com');
    assertEqual('reset keeps the on-file phone (display mask)', onboarding.answers.phone, '(555) 123-4567');
    assertEqual('identity follows welcome for real accounts', visibleSteps(onboarding.answers, true)[1], 'identity');

    await show('identity');
    const root = r.root;
    assertEqual('name input is prefilled', inputValue(root, 'ob-name-input'), 'Maya Reyes');
    assertEqual('email input is prefilled', inputValue(root, 'ob-email-input'), 'maya.reyes@gmail.com');
    assertEqual('phone input is prefilled', inputValue(root, 'ob-phone-input'), '(555) 123-4567');
    assertEqual('email shows Confirmed', hosts(root, 'ob-email-confirmed').length, 1);
    assertEqual('phone shows Confirmed', hosts(root, 'ob-phone-confirmed').length, 1);
    assertEqual('no email send button when confirmed', hosts(root, 'ob-verify-email').length, 0);
    assertEqual('no text send button when confirmed', hosts(root, 'ob-verify-phone').length, 0);
    assert(
      'Confirmed badge is labelled for screen readers',
      hosts(root, 'ob-email-confirmed')[0]?.props.accessibilityLabel === 'Email confirmed',
    );

    // ── 2. Retyped formats still match what is on file ─────────────────────
    for (const typed of ['5551234567', '+1 (555) 123-4567', '555-123-4567', '15551234567']) {
      await typeText(root, 'ob-phone-input', typed);
      assertEqual(`retyped "${typed}" shows in the US mask`, inputValue(root, 'ob-phone-input'), '(555) 123-4567');
      assertEqual(`retyped "${typed}" stays Confirmed`, hosts(root, 'ob-phone-confirmed').length, 1);
      assertEqual(`retyped "${typed}" hides the text button`, hosts(root, 'ob-verify-phone').length, 0);
    }
    await typeText(root, 'ob-email-input', ' Maya.Reyes@Gmail.com ');
    assertEqual('gmail retyped with case/space stays Confirmed', hosts(root, 'ob-email-confirmed').length, 1);

    // ── 3. Untouched details continue ──────────────────────────────────────
    await tap(root, 'ob-identity-next');
    assertEqual('no hint on a valid Next', hintText(root), null);
    assertEqual('valid Next advances exactly once', pushes().length, 1);
    assertEqual('advances to the next real-account step', pushes()[0], '/onboarding/height');
    await act(async () => r.unmount());
  }

  // ── 4. Per-field blocked-Next messages ────────────────────────────────────
  {
    const r = await mount(realAccount, ON_FILE);
    await show('welcome');
    await show('identity');
    const root = r.root;

    await typeText(root, 'ob-name-input', 'Maya');
    await tap(root, 'ob-identity-next');
    assertEqual('single-word name → name message', hintText(root), 'Enter your first and last name.');
    assertEqual('blocked name never advances', pushes().length, 0);

    await typeText(root, 'ob-name-input', 'Maya Reyes');
    assertEqual('hint clears once the name is fixed', hintText(root), null);

    await typeText(root, 'ob-email-input', 'maya@');
    await tap(root, 'ob-identity-next');
    assertEqual(
      'malformed email → email message',
      hintText(root),
      'Enter a valid email address, like you@example.com.',
    );
    assertEqual('no send button for a malformed email', hosts(root, 'ob-verify-email').length, 0);

    await typeText(root, 'ob-email-input', 'maya.new@gmail.com');
    assertEqual('a new gmail address offers the email code', hosts(root, 'ob-verify-email').length, 1);
    assertEqual('a new gmail address is not Confirmed', hosts(root, 'ob-email-confirmed').length, 0);
    const emailHint = hintText(root) ?? '';
    assert('a valid gmail address is never called invalid', !/valid email/i.test(emailHint));
    assert('changed email → names the email code step', /email code/i.test(emailHint));

    await typeText(root, 'ob-email-input', 'maya.reyes@gmail.com');
    await typeText(root, 'ob-phone-input', '555123');
    assertEqual(
      'partial phone → phone message',
      hintText(root),
      'Enter a complete phone number, like (555) 123-4567.',
    );
    assertEqual('email back on file shows Confirmed again', hosts(root, 'ob-email-confirmed').length, 1);

    await typeText(root, 'ob-phone-input', '5559876543');
    const phoneHint = hintText(root) ?? '';
    assert('changed phone → names the text code step', /text code/i.test(phoneHint));
    assert('changed phone hint never mentions email', !/email/i.test(phoneHint));
    assertEqual('a changed phone offers the text code', hosts(root, 'ob-verify-phone').length, 1);
    await tap(root, 'ob-identity-next');
    assertEqual('unconfirmed phone never advances', pushes().length, 0);

    await typeText(root, 'ob-phone-input', '(555) 123-4567');
    assertEqual('hint clears when everything matches', hintText(root), null);
    await tap(root, 'ob-identity-next');
    assertEqual('then Next advances', pushes().length, 1);
    await act(async () => r.unmount());
  }

  // ── 5. Demo persona: unchanged fresh run ──────────────────────────────────
  {
    const r = await mount(DEMO_ACCOUNT_STATE, ON_FILE);
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
