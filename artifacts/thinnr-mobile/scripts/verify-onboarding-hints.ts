/**
 * Onboarding blocked-Next "what's missing" hint regression check.
 *
 * Renders the REAL onboarding step components (OnboardingFrame +
 * StepsProfile) with react-test-renderer under tsx
 * (tsconfig.onboarding-hints.json maps every native-only bare specifier to a
 * Node stub; expo-router is a recording stub) and pins the blocked-Next
 * feedback contract on the steps with distinct hint logic — goal weight,
 * weight — plus the no-hint fallback (gender):
 *   1. tapping a dimmed Next shows the step-correct hint text in the
 *      ob-next-hint ErrorBox (and re-taps never duplicate it),
 *   2. the hint tracks the CURRENT gap live (goal weight: missing → below
 *      the floor → above current weight; weight: missing ↔ out-of-range
 *      wording),
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
import React, { act, useEffect } from 'react';
// Resolves to scripts/onboarding-hints-stubs/expo-router.ts — the SAME module
// instance the components under test import, so the log below sees their calls.
import { routerLog } from 'expo-router';

import { OnboardingProvider, useOnboarding } from '../context/OnboardingContext';
import { OnboardingFrame } from '../components/onboarding/OnboardingFrame';
import { GoalWeightStep, WeightStep } from '../components/onboarding/StepsProfile';
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

const HINT_GOAL_MISSING = 'Enter your goal weight to continue.';
const HINT_GOAL_FLOOR = 'Enter a goal of at least 80 lb.';
const HINT_GOAL_ABOVE_CURRENT = 'Set a goal below your current weight of 215 lb.';

/** GoalWeightStep with a current weight on file, so the above-current rule is reachable. */
function GoalWeightWithCurrent() {
  const { answers, patch } = useOnboarding();
  useEffect(() => {
    if (answers.currentWeight !== '215') patch({ currentWeight: '215' });
  }, [answers.currentWeight, patch]);
  return React.createElement(GoalWeightStep);
}
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

  // ── 1. Goal-weight step: missing → floor → above-current wording ─────────
  {
    resetRouter();
    const r = await mount(React.createElement(GoalWeightWithCurrent));

    assertNoHint(r, 'goal: before any tap');
    assertNextBlockedButTappable(r, 'goal: empty input');

    await tap(r, 'ob-next', 'goal: blocked tap');
    assertHintText(r, 'goal: blocked tap', HINT_GOAL_MISSING);
    assertErrorBoxA11y(hintNode(r), 'goal: hint box');
    assertEqual('goal: blocked tap never advances', pushes().length, 0);

    await tap(r, 'ob-next', 'goal: second blocked tap');
    assertHintText(r, 'goal: re-tap keeps a single hint box', HINT_GOAL_MISSING);
    assertEqual('goal: re-tap still never advances', pushes().length, 0);

    // The hint tracks the CURRENT problem live.
    await typeText(r, 'ob-goal-input', '50', 'goal: below the floor');
    assertHintText(r, 'goal: below the floor swaps to the floor hint', HINT_GOAL_FLOOR);
    await typeText(r, 'ob-goal-input', '230', 'goal: above current weight');
    assertHintText(r, 'goal: above current swaps to the current-weight hint', HINT_GOAL_ABOVE_CURRENT);
    await tap(r, 'ob-next', 'goal: tap while above current');
    assertEqual('goal: above-current tap never advances', pushes().length, 0);

    // Valid input: the hint clears without another tap.
    await typeText(r, 'ob-goal-input', '180', 'goal: valid goal');
    assertNoHint(r, 'goal: hint clears once the goal is valid');
    assertNextEnabled(r, 'goal: valid goal');

    // Relapse: emptying the field re-blocks Next but must NOT resurrect the
    // hint until the patient taps again.
    await typeText(r, 'ob-goal-input', '', 'goal: cleared input');
    assertNextBlockedButTappable(r, 'goal: cleared input');
    assertNoHint(r, 'goal: relapse stays quiet until the next tap');
    await tap(r, 'ob-next', 'goal: blocked tap after relapse');
    assertHintText(r, 'goal: relapse tap shows the missing hint again', HINT_GOAL_MISSING);

    await typeText(r, 'ob-goal-input', '180', 'goal: valid again');
    assertNoHint(r, 'goal: hint clears again');
    assertEqual('goal: nothing advanced while blocked', pushes().length, 0);

    await tap(r, 'ob-next', 'goal: valid tap');
    assertEqual('goal: valid tap advances exactly once', pushes().length, 1);
    assertEqual('goal: valid tap advances to the next step', pushes()[0] ?? '', nextStepAfter('goal-weight'));

    await unmount(r);
  }

  // ── 2. Weight step (profile): missing ↔ out-of-range wording ──────────────
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

  // ── 3. No-hint fallback: a frame without nextBlockedHint hard-disables ────
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
