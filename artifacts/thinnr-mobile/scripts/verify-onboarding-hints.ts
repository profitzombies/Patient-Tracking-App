/**
 * Onboarding blocked-Next "what's missing" hint regression check.
 *
 * Renders the REAL onboarding step components (OnboardingFrame +
 * StepsAccount / StepsProfile) with react-test-renderer under tsx
 * (tsconfig.onboarding-hints.json maps every native-only bare specifier to a
 * Node stub; expo-router is a recording stub) and pins the blocked-Next
 * feedback contract on the steps with distinct hint logic — contact,
 * verification code, password, weight — plus the no-hint fallback (gender):
 *   1. tapping a dimmed Next shows the step-correct hint text in the
 *      ob-next-hint ErrorBox (and re-taps never duplicate it),
 *   2. the hint tracks the CURRENT gap live (password: requirements →
 *      blocked password → confirm missing → mismatch; contact: phone ↔
 *      email wording; weight: missing ↔ out-of-range wording),
 *   3. a blocked tap NEVER advances the step (the router records no push),
 *      while valid input advances to exactly the flow's next step,
 *   4. the hint clears the moment input becomes valid, and stays hidden on
 *      a later relapse until Next is tapped again (no pre-emptive nagging),
 *   5. every ErrorBox surface carries accessibilityRole="alert" +
 *      accessibilityLiveRegion="polite", and a blocked Next stays
 *      semantically disabled (accessibilityState) while still catching taps
 *      — while a frame that configures NO hint hard-disables the button
 *      (probed with a synthetic OnboardingFrame, not a real step, so the
 *      section keeps testing the frame contract as steps gain hints).
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:onboarding-hints
 */
import React, { act } from 'react';
// Resolves to scripts/onboarding-hints-stubs/expo-router.ts — the SAME module
// instance the components under test import, so the log below sees their calls.
import { routerLog } from 'expo-router';

import { OnboardingProvider } from '../context/OnboardingContext';
import { OnboardingFrame } from '../components/onboarding/OnboardingFrame';
import { ContactStep, PasswordStep, VerifyStep } from '../components/onboarding/StepsAccount';
import { WeightStep } from '../components/onboarding/StepsProfile';
import { DEFAULT_ANSWERS, visibleSteps, type StepKey } from '../data/onboarding-data';

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

function assertEqual(label: string, actual: string | number | boolean, expected: string | number | boolean) {
  checks += 1;
  if (actual !== expected) {
    fail(`${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

function finish(): never {
  if (failures > 0) {
    console.error(`\n✗ onboarding blocked-Next hints: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ onboarding blocked-Next hints: ${checks} checks passed`);
  process.exit(0);
}

// ── Renderer harness ─────────────────────────────────────────────────────────

interface HostNode {
  type: unknown;
  props: Record<string, any>;
  children: Array<HostNode | string>;
}

interface Mounted {
  root: { findAll(predicate: (node: HostNode) => boolean): HostNode[] };
  unmount(): void;
}

type CreateRenderer = (el: React.ReactElement) => Mounted;
let createRenderer!: CreateRenderer;

/** Steps that never advance in a section must leave the router log empty. */
function pushes(): string[] {
  return routerLog.filter(c => c.method === 'push').map(c => c.target);
}

function resetRouter() {
  routerLog.length = 0;
}

/** The step the flow advances to from `key` under the given answers. */
function nextStepAfter(key: StepKey): string {
  const steps = visibleSteps(DEFAULT_ANSWERS);
  const next = steps[steps.indexOf(key) + 1];
  return `/onboarding/${next}`;
}

async function mount(step: React.ReactElement): Promise<Mounted> {
  let renderer!: Mounted;
  await act(() => {
    renderer = createRenderer(React.createElement(OnboardingProvider, null, step));
  });
  return renderer;
}

/** Host elements only (stub components render host strings like 'Pressable'). */
function hostsByTestID(renderer: Mounted, testID: string): HostNode[] {
  return renderer.root.findAll(n => typeof n.type === 'string' && n.props?.testID === testID);
}

function mustFindOne(renderer: Mounted, testID: string, label: string): HostNode | null {
  const nodes = hostsByTestID(renderer, testID);
  if (nodes.length !== 1) {
    fail(`${label}: expected exactly one host node with testID "${testID}", found ${nodes.length}`);
    return null;
  }
  return nodes[0];
}

async function tap(renderer: Mounted, testID: string, label: string) {
  checks += 1;
  const node = mustFindOne(renderer, testID, label);
  if (!node) return;
  await act(() => {
    // The react-native stub's Pressable already swallows presses when the
    // host `disabled` prop is set, mirroring RN semantics.
    node.props.onPress?.();
  });
}

async function typeText(renderer: Mounted, testID: string, text: string, label: string) {
  checks += 1;
  const node = mustFindOne(renderer, testID, label);
  if (!node) return;
  await act(() => {
    node.props.onChangeText?.(text);
  });
}

function collectText(node: HostNode): string {
  const parts: string[] = [];
  const visit = (child: HostNode | string) => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    for (const grandchild of child.children ?? []) visit(grandchild);
  };
  visit(node);
  return parts.join('');
}

/** The ob-next-hint ErrorBox, or null while it is (correctly) hidden. */
function hintNode(renderer: Mounted): HostNode | null {
  const nodes = hostsByTestID(renderer, 'ob-next-hint');
  return nodes.length === 1 ? nodes[0] : null;
}

function assertHintText(renderer: Mounted, label: string, expected: string) {
  const nodes = hostsByTestID(renderer, 'ob-next-hint');
  assertEqual(`${label}: exactly one hint box is shown`, nodes.length, 1);
  if (nodes.length === 1) {
    assertEqual(`${label}: hint text is step-correct`, collectText(nodes[0]), expected);
  }
}

function assertNoHint(renderer: Mounted, label: string) {
  assertEqual(`${label}: no hint box is shown`, hostsByTestID(renderer, 'ob-next-hint').length, 0);
}

function assertErrorBoxA11y(node: HostNode | null, label: string) {
  if (!node) {
    fail(`${label}: error box missing, cannot check accessibility props`);
    return;
  }
  assertEqual(`${label}: carries accessibilityRole="alert"`, node.props.accessibilityRole, 'alert');
  assertEqual(
    `${label}: carries accessibilityLiveRegion="polite"`,
    node.props.accessibilityLiveRegion,
    'polite',
  );
}

/** A blocked Next: semantically disabled, but still catching taps for the hint. */
function assertNextBlockedButTappable(renderer: Mounted, label: string) {
  const next = mustFindOne(renderer, 'ob-next', label);
  checks += 1;
  if (!next) return;
  assertEqual(`${label}: Next reports accessibilityState.disabled`, next.props.accessibilityState?.disabled, true);
  assertEqual(`${label}: Next still intercepts taps (host not hard-disabled)`, next.props.disabled, false);
}

function assertNextEnabled(renderer: Mounted, label: string) {
  const next = mustFindOne(renderer, 'ob-next', label);
  checks += 1;
  if (!next) return;
  assertEqual(`${label}: Next is enabled for assistive tech`, next.props.accessibilityState?.disabled, false);
}

async function unmount(renderer: Mounted) {
  await act(() => {
    renderer.unmount();
  });
}

// ── Expected hint copy (must stay in lockstep with the step components) ─────

const HINT_CONTACT_PHONE = 'Enter a complete phone number, like (555) 123-4567, so we can text your code.';
const HINT_CONTACT_EMAIL = 'Enter a valid email address, like you@example.com, so we can send your code.';
const HINT_VERIFY = 'Enter all 6 digits of your verification code first.';
const HINT_PW_REQUIREMENTS = "Your password doesn't meet all the requirements below yet.";
const HINT_PW_BLOCKED = "That password can't be used — try something more unique.";
const HINT_PW_CONFIRM = 'Re-enter your password in the confirm field.';
const HINT_PW_MISMATCH = "The two passwords don't match yet.";
const HINT_WEIGHT_MISSING = 'Enter your current weight to continue.';
const HINT_WEIGHT_RANGE = 'Enter a weight between 80 and 500 lb.';
const ERROR_WRONG_CODE = "That code didn't match. For this demo, use 123456.";

async function main() {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  // react-test-renderer 19 prints a one-line deprecation notice; keep the
  // output readable but let every other console.error through untouched.
  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    realConsoleError(...args);
  };
  const rendererModule = (await import('react-test-renderer')) as unknown as {
    default?: { create: CreateRenderer };
    create?: CreateRenderer;
  };
  const TestRenderer = rendererModule.default ?? rendererModule;
  if (!TestRenderer.create) throw new Error('react-test-renderer did not expose create()');
  createRenderer = TestRenderer.create.bind(TestRenderer) as CreateRenderer;

  // ── 1. Contact step: phone ↔ email hints, clear-on-valid, advance ─────────
  {
    resetRouter();
    const r = await mount(React.createElement(ContactStep));

    assertNoHint(r, 'contact: before any tap');
    assertNextBlockedButTappable(r, 'contact: empty phone');

    await tap(r, 'ob-next', 'contact: blocked tap');
    assertHintText(r, 'contact: blocked tap (phone mode)', HINT_CONTACT_PHONE);
    assertErrorBoxA11y(hintNode(r), 'contact: hint box');
    assertEqual('contact: blocked tap never advances', pushes().length, 0);

    await tap(r, 'ob-next', 'contact: second blocked tap');
    assertHintText(r, 'contact: re-tap keeps a single hint box', HINT_CONTACT_PHONE);
    assertEqual('contact: re-tap still never advances', pushes().length, 0);

    // Partial input: still blocked, the hint stays up.
    await typeText(r, 'ob-contact-input', '555123', 'contact: partial phone');
    assertHintText(r, 'contact: partial phone keeps the hint', HINT_CONTACT_PHONE);

    // Valid input: the hint clears without another tap.
    await typeText(r, 'ob-contact-input', '5551234567', 'contact: full phone');
    assertNoHint(r, 'contact: hint clears once the phone number is complete');
    assertNextEnabled(r, 'contact: complete phone');

    // Relapse: emptying the field re-blocks Next but must NOT resurrect the
    // hint until the patient taps again.
    await typeText(r, 'ob-contact-input', '', 'contact: cleared input');
    assertNextBlockedButTappable(r, 'contact: cleared input');
    assertNoHint(r, 'contact: relapse stays quiet until the next tap');

    // Email mode gets its own wording.
    await tap(r, 'pill-email', 'contact: switch to email');
    await tap(r, 'ob-next', 'contact: blocked tap (email mode)');
    assertHintText(r, 'contact: blocked tap (email mode)', HINT_CONTACT_EMAIL);
    await typeText(r, 'ob-contact-input', 'emma@', 'contact: partial email');
    assertHintText(r, 'contact: partial email keeps the hint', HINT_CONTACT_EMAIL);

    await typeText(r, 'ob-contact-input', 'emma@example.com', 'contact: valid email');
    assertNoHint(r, 'contact: hint clears once the email is valid');
    assertEqual('contact: nothing advanced while blocked', pushes().length, 0);

    await tap(r, 'ob-next', 'contact: valid tap');
    assertEqual('contact: valid tap advances exactly once', pushes().length, 1);
    assertEqual('contact: valid tap advances to the next step', pushes()[0] ?? '', nextStepAfter('contact'));

    await unmount(r);
  }

  // ── 2. Verification-code step: length hint, wrong-code error, advance ─────
  {
    resetRouter();
    const r = await mount(React.createElement(VerifyStep));

    assertNoHint(r, 'verify: before any tap');
    await tap(r, 'ob-next', 'verify: blocked tap');
    assertHintText(r, 'verify: blocked tap with empty code', HINT_VERIFY);
    assertErrorBoxA11y(hintNode(r), 'verify: hint box');
    assertEqual('verify: blocked tap never advances', pushes().length, 0);

    await typeText(r, 'ob-code-input', '12345', 'verify: five digits');
    assertHintText(r, 'verify: five digits keep the hint', HINT_VERIFY);
    assertNextBlockedButTappable(r, 'verify: five digits');

    // Six WRONG digits: the blocked hint clears (input is complete), and the
    // submit path shows the step's own inline error instead — no advance.
    await typeText(r, 'ob-code-input', '654321', 'verify: wrong code');
    assertNoHint(r, 'verify: hint clears once six digits are in');
    await tap(r, 'ob-next', 'verify: submit wrong code');
    assertEqual('verify: wrong code never advances', pushes().length, 0);
    {
      const errorBox = mustFindOne(r, 'ob-code-error', 'verify: wrong-code error box');
      checks += 1;
      if (errorBox) {
        assertEqual("verify: wrong-code error text", collectText(errorBox), ERROR_WRONG_CODE);
        assertErrorBoxA11y(errorBox, 'verify: wrong-code error box');
      }
    }

    // Editing the code clears the inline error; the right code advances.
    await typeText(r, 'ob-code-input', '123456', 'verify: correct code');
    assertEqual(
      'verify: editing clears the wrong-code error',
      hostsByTestID(r, 'ob-code-error').length,
      0,
    );
    await tap(r, 'ob-next', 'verify: submit correct code');
    assertEqual('verify: correct code advances exactly once', pushes().length, 1);
    assertEqual('verify: advances to the next step', pushes()[0] ?? '', nextStepAfter('verify'));

    await unmount(r);
  }

  // ── 3. Password step: the hint tracks the current gap live ────────────────
  {
    resetRouter();
    const r = await mount(React.createElement(PasswordStep));

    await tap(r, 'ob-next', 'password: blocked tap');
    assertHintText(r, 'password: empty fields', HINT_PW_REQUIREMENTS);
    assertErrorBoxA11y(hintNode(r), 'password: hint box');

    // Still failing the checklist: same wording.
    await typeText(r, 'ob-password', 'Aa1!', 'password: too short');
    assertHintText(r, 'password: too short keeps the requirements hint', HINT_PW_REQUIREMENTS);

    // Meets the checklist but is on the blocklist: hint swaps live, and the
    // step's own inline blocked-password box appears alongside.
    await typeText(r, 'ob-password', 'Password1!', 'password: blocked password');
    assertHintText(r, 'password: blocked password swaps the hint live', HINT_PW_BLOCKED);
    {
      const blockedBox = mustFindOne(r, 'ob-password-blocked', 'password: inline blocked box');
      checks += 1;
      if (blockedBox) assertErrorBoxA11y(blockedBox, 'password: inline blocked box');
    }
    await tap(r, 'ob-next', 'password: tap while blocked password');
    assertEqual('password: blocked password never advances', pushes().length, 0);

    // Acceptable password, no confirmation yet.
    await typeText(r, 'ob-password', 'Emerald9!', 'password: strong password');
    assertHintText(r, 'password: missing confirmation', HINT_PW_CONFIRM);
    assertEqual(
      'password: inline blocked box clears for an allowed password',
      hostsByTestID(r, 'ob-password-blocked').length,
      0,
    );

    // Mismatched confirmation.
    await typeText(r, 'ob-password-confirm', 'Emerald9', 'password: mismatch');
    assertHintText(r, 'password: mismatch', HINT_PW_MISMATCH);
    await tap(r, 'ob-next', 'password: tap while mismatched');
    assertEqual('password: mismatch never advances', pushes().length, 0);

    // Match: hint clears, Next advances.
    await typeText(r, 'ob-password-confirm', 'Emerald9!', 'password: match');
    assertNoHint(r, 'password: hint clears once the passwords match');
    assertNextEnabled(r, 'password: match');
    await tap(r, 'ob-next', 'password: valid tap');
    assertEqual('password: valid tap advances exactly once', pushes().length, 1);
    assertEqual('password: advances to the next step', pushes()[0] ?? '', nextStepAfter('password'));

    await unmount(r);
  }

  // ── 4. Weight step (profile): missing ↔ out-of-range wording ──────────────
  {
    resetRouter();
    const r = await mount(React.createElement(WeightStep));

    await tap(r, 'ob-next', 'weight: blocked tap');
    assertHintText(r, 'weight: empty input', HINT_WEIGHT_MISSING);
    assertErrorBoxA11y(hintNode(r), 'weight: hint box');
    assertEqual('weight: blocked tap never advances', pushes().length, 0);

    await typeText(r, 'ob-weight-input', '20', 'weight: below range');
    assertHintText(r, 'weight: below range swaps to the bounds hint', HINT_WEIGHT_RANGE);

    await typeText(r, 'ob-weight-input', '640', 'weight: above range');
    assertHintText(r, 'weight: above range keeps the bounds hint', HINT_WEIGHT_RANGE);
    await tap(r, 'ob-next', 'weight: tap while out of range');
    assertEqual('weight: out-of-range tap never advances', pushes().length, 0);

    await typeText(r, 'ob-weight-input', '215', 'weight: valid weight');
    assertNoHint(r, 'weight: hint clears once the weight is in range');
    await tap(r, 'ob-next', 'weight: valid tap');
    assertEqual('weight: valid tap advances exactly once', pushes().length, 1);
    assertEqual('weight: advances to the next step', pushes()[0] ?? '', nextStepAfter('weight'));

    await unmount(r);
  }

  // ── 5. No-hint fallback: a frame without nextBlockedHint hard-disables ────
  // Synthetic OnboardingFrame probe (not a real step) so this section keeps
  // pinning the frame/PrimaryButton contract even as individual steps gain
  // their own hints: no hint configured → the button is truly disabled, taps
  // are swallowed, and nothing ever advances.
  {
    resetRouter();
    const r = await mount(
      React.createElement(
        OnboardingFrame,
        { stepKey: 'gender' as StepKey, title: 'No-hint probe', nextDisabled: true },
        null,
      ),
    );

    const next = mustFindOne(r, 'ob-next', 'no-hint frame: Next button');
    checks += 1;
    if (next) {
      assertEqual(
        'no-hint frame: Next reports accessibilityState.disabled',
        next.props.accessibilityState?.disabled,
        true,
      );
      assertEqual('no-hint frame: the host button is hard-disabled', next.props.disabled, true);
    }
    await tap(r, 'ob-next', 'no-hint frame: blocked tap');
    assertNoHint(r, 'no-hint frame: no hint is configured, none appears');
    assertEqual('no-hint frame: blocked tap never advances', pushes().length, 0);
    await unmount(r);

    // The same frame with Next enabled advances through the default goNext.
    const r2 = await mount(
      React.createElement(
        OnboardingFrame,
        { stepKey: 'gender' as StepKey, title: 'No-hint probe', nextDisabled: false },
        null,
      ),
    );
    await tap(r2, 'ob-next', 'no-hint frame: enabled tap');
    assertEqual('no-hint frame: enabled tap advances exactly once', pushes().length, 1);
    assertEqual('no-hint frame: advances to the next step', pushes()[0] ?? '', nextStepAfter('gender'));
    await unmount(r2);
  }

  finish();
}

main().catch(error => {
  console.error('onboarding blocked-Next hint check crashed:', error);
  process.exit(1);
});
