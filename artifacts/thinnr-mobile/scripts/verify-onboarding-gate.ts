/**
 * Onboarding "blocked Next explains itself" gate check.
 *
 * Two layers keep a gated onboarding step from ever swallowing a tapped Next
 * without saying why:
 *
 *   1. Static guard — scans every <OnboardingFrame> usage in the app source
 *      and fails if one passes nextDisabled without nextBlockedHint (hideNext
 *      frames are exempt: they render their own CTAs, so there is no Next to
 *      stall). A new step cannot ship a silent stall, and spread props that
 *      would defeat the scan are rejected outright.
 *
 *   2. Runtime check — renders every gated step (the REAL components and the
 *      real OnboardingContext) with react-test-renderer under tsx
 *      (tsconfig.onboarding-gate.json maps native-only modules to Node stubs)
 *      and walks the patient journey per step:
 *        - tapping the blocked Next surfaces the ob-next-hint ErrorBox with a
 *          non-empty, on-screen message (alert role + polite live region for
 *          screen readers) and does NOT navigate;
 *        - while still blocked, the hint stays up and tracks the current
 *          problem (e.g. out-of-range weight, impossible date);
 *        - a valid selection/entry clears the hint;
 *        - Next then advances with exactly one router.push to the correct
 *          next step for the current answers.
 *
 * The layers are tied together: the static scan's set of gated stepKeys must
 * exactly match the steps the runtime section covers, so introducing a gated
 * step without extending this suite fails loudly too.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:onboarding-gate
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import React, { act } from 'react';

import { OnboardingProvider, useOnboarding } from '../context/OnboardingContext';
import { type OnboardingAnswers, type StepKey } from '../data/onboarding-data';
import {
  BirthdayStep,
  GenderStep,
  GoalWeightStep,
  ProgramStep,
  StartedStep,
  WeightStep,
} from '../components/onboarding/StepsProfile';
import { InjectionDayStep } from '../components/onboarding/StepsPrefs';
import { AllergiesStep, DietStep } from '../components/onboarding/StepsDiet';
import { clearRouterCalls, routerCalls } from './onboarding-gate-stubs/expo-router';

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

function finish(): never {
  if (failures > 0) {
    console.error(`\n✗ onboarding blocked-Next gate: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ onboarding blocked-Next gate: ${checks} checks passed`);
  process.exit(0);
}

// ─── 1. Static guard: nextDisabled ⇒ nextBlockedHint ────────────────────────

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.expo', 'dist', 'scripts', 'server', 'assets']);

function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        collectTsxFiles(path.join(dir, entry.name), out);
      }
    } else if (entry.name.endsWith('.tsx')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

interface FrameUsage {
  file: string; // relative to the artifact root
  line: number; // 1-based
  attrs: string | null; // null = opening tag could not be parsed
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Extracts the attribute text of each <OnboardingFrame ...> opening tag.
 * Tracks quotes and brace depth so `>` inside attribute expressions (arrow
 * functions, comparisons) never terminates the tag early.
 */
function extractFrameUsages(file: string, source: string): FrameUsage[] {
  const usages: FrameUsage[] = [];
  const tag = '<OnboardingFrame';
  const rel = path.relative(ROOT, file);
  let from = 0;
  for (;;) {
    const start = source.indexOf(tag, from);
    if (start === -1) break;
    from = start + tag.length;
    const after = source[start + tag.length];
    if (after !== undefined && /[A-Za-z0-9_]/.test(after)) continue; // e.g. <OnboardingFrameProps

    let brace = 0;
    let quote: '"' | "'" | '`' | null = null;
    let end = -1;
    for (let i = start + tag.length; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') {
          i += 1;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '{') {
        brace += 1;
      } else if (ch === '}') {
        brace -= 1;
      } else if (ch === '>' && brace === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) {
      usages.push({ file: rel, line: lineOf(source, start), attrs: null });
      break;
    }
    usages.push({ file: rel, line: lineOf(source, start), attrs: source.slice(start + tag.length, end) });
    from = end + 1;
  }
  return usages;
}

const STEP_KEY_LITERAL = /\bstepKey\s*=\s*(?:"([^"]*)"|\{\s*(?:'([^']*)'|"([^"]*)")\s*\})/;

/** Returns the set of gated (nextDisabled, non-hideNext) stepKeys found. */
function runStaticGuard(): Map<string, string> {
  const gated = new Map<string, string>(); // stepKey -> "file:line"
  const files = collectTsxFiles(ROOT);
  let frameCount = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('<OnboardingFrame')) continue;
    for (const usage of extractFrameUsages(file, source)) {
      frameCount += 1;
      const where = `${usage.file}:${usage.line}`;
      if (usage.attrs === null) {
        fail(`static guard: could not parse the <OnboardingFrame> opening tag at ${where}`);
        continue;
      }
      const attrs = usage.attrs;
      const hasDisabled = /\bnextDisabled\b/.test(attrs);
      const hasHint = /\bnextBlockedHint\b/.test(attrs);
      const hideNextExempt =
        /\bhideNext\b/.test(attrs) && !/\bhideNext\s*=\s*\{\s*false\s*\}/.test(attrs);
      const hasSpread = /\{\s*\.\.\./.test(attrs);

      if (hasSpread) {
        fail(
          `static guard: spread props on <OnboardingFrame> at ${where} defeat the nextDisabled/nextBlockedHint check — pass both explicitly`,
        );
        continue;
      }
      if (!hasDisabled || hideNextExempt) continue;

      checks += 1;
      if (!hasHint) {
        failures += 1;
        console.error(
          `  FAIL  static guard: <OnboardingFrame> at ${where} passes nextDisabled without nextBlockedHint — a blocked Next would stall silently`,
        );
      }

      const key = STEP_KEY_LITERAL.exec(attrs);
      const literal = key?.[1] ?? key?.[2] ?? key?.[3];
      if (!literal) {
        fail(
          `static guard: gated <OnboardingFrame> at ${where} needs a literal stepKey so the runtime suite can cover it`,
        );
        continue;
      }
      gated.set(literal, where);
    }
  }

  assert('static guard: found <OnboardingFrame> usages to scan (rename breaks the guard)', frameCount > 0);
  assert('static guard: found at least one gated step', gated.size > 0);
  return gated;
}

// ─── 2. Runtime harness ──────────────────────────────────────────────────────

interface TestInstance {
  type: unknown; // string for host elements, function for components
  props: Record<string, unknown>;
  children: Array<TestInstance | string>;
  findAllByProps(props: Record<string, unknown>): TestInstance[];
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

function renderStep(Step: React.ComponentType, prep?: Partial<OnboardingAnswers>): Renderer {
  clearRouterCalls();
  let renderer!: Renderer;
  act(() => {
    renderer = createRenderer(
      React.createElement(
        OnboardingProvider,
        null,
        React.createElement(Probe),
        React.createElement(Step),
      ),
    );
  });
  if (prep) {
    act(() => {
      onboarding.patch(prep);
    });
  }
  return renderer;
}

/**
 * Finds the HOST element for a testID (deepest match). Component elements
 * higher up carry the raw pre-wrap props (e.g. PrimaryButton's unwrapped
 * onPress/disabled), so tapping them would bypass the real press wiring.
 */
function pressableByTestID(root: TestInstance, testID: string): TestInstance | null {
  const hosts = root
    .findAllByProps({ testID })
    .filter(i => typeof i.type === 'string' && typeof i.props.onPress === 'function');
  return hosts[hosts.length - 1] ?? null;
}

/** Simulates a native tap; RN swallows presses on `disabled` pressables. */
function tap(root: TestInstance, testID: string, label: string): boolean {
  const el = pressableByTestID(root, testID);
  if (!el) {
    fail(`${label}: pressable "${testID}" not found`);
    return false;
  }
  if (el.props.disabled === true) return false;
  act(() => {
    (el.props.onPress as () => void)();
  });
  return true;
}

function typeText(root: TestInstance, testID: string, value: string, label: string): void {
  const inputs = root
    .findAllByProps({ testID })
    .filter(i => typeof i.type === 'string' && typeof i.props.onChangeText === 'function');
  const el = inputs[inputs.length - 1];
  if (!el) {
    fail(`${label}: input "${testID}" not found`);
    return;
  }
  act(() => {
    (el.props.onChangeText as (v: string) => void)(value);
  });
}

function textContent(node: TestInstance | string): string {
  if (typeof node === 'string') return node;
  return (node.children ?? []).map(textContent).join('');
}

interface HintView {
  present: boolean;
  message: string;
  renderedText: string;
  alertRole: boolean;
  politeLive: boolean;
}

function readHint(root: TestInstance): HintView {
  const matches = root.findAllByProps({ testID: 'ob-next-hint' });
  if (matches.length === 0) {
    return { present: false, message: '', renderedText: '', alertRole: false, politeLive: false };
  }
  const box = matches.find(i => typeof i.props.message === 'string');
  const view = matches.find(i => i.props.accessibilityRole !== undefined);
  return {
    present: true,
    message: (box?.props.message as string) ?? '',
    renderedText: view ? textContent(view) : '',
    alertRole: view?.props.accessibilityRole === 'alert',
    politeLive: view?.props.accessibilityLiveRegion === 'polite',
  };
}

function nextSemanticallyDisabled(root: TestInstance): boolean {
  const el = root
    .findAllByProps({ testID: 'ob-next' })
    .find(i => (i.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled !== undefined);
  return (el?.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true;
}

const pushes = () => routerCalls.filter(c => c.method === 'push');

// ─── 3. Gated step specs ─────────────────────────────────────────────────────

interface BlockedPhase {
  label: string;
  mutate: (root: TestInstance) => void;
  /** Distinctive fragment the live hint must contain (case-insensitive). */
  hintContains: string;
}

interface GatedStepSpec {
  key: StepKey;
  component: React.ComponentType;
  /** Answers patched before interacting (step visibility / prerequisites). */
  prep?: Partial<OnboardingAnswers>;
  expectedNext: StepKey;
  /** Inputs that stay blocked — the hint must track each problem live. */
  blockedPhases?: BlockedPhase[];
  makeValid: (root: TestInstance) => void;
}

const SPECS: GatedStepSpec[] = [
  {
    key: 'weight',
    component: WeightStep,
    expectedNext: 'gender',
    blockedPhases: [
      {
        label: 'out-of-range weight',
        mutate: root => typeText(root, 'ob-weight-input', '20', 'weight out of range'),
        hintContains: 'between 80 and 500',
      },
    ],
    makeValid: root => typeText(root, 'ob-weight-input', '185', 'weight valid'),
  },
  {
    key: 'gender',
    component: GenderStep,
    expectedNext: 'birthday',
    makeValid: root => tap(root, 'ob-gender-female', 'gender valid'),
  },
  {
    key: 'birthday',
    component: BirthdayStep,
    expectedNext: 'program',
    blockedPhases: [
      {
        label: 'impossible date',
        mutate: root => {
          tap(root, 'ob-month-2', 'birthday month');
          typeText(root, 'ob-day-input', '30', 'birthday day');
          typeText(root, 'ob-year-input', '1990', 'birthday year');
        },
        hintContains: 'valid date',
      },
    ],
    makeValid: root => typeText(root, 'ob-day-input', '12', 'birthday valid'),
  },
  {
    key: 'program',
    component: ProgramStep,
    expectedNext: 'started',
    makeValid: root => tap(root, 'ob-program-thinnr', 'program valid'),
  },
  {
    key: 'started',
    component: StartedStep,
    prep: { program: 'thinnr' },
    // Every medication program confirms its start date next, started or not.
    expectedNext: 'start-date',
    makeValid: root => tap(root, 'ob-started-yes', 'started valid'),
  },
  {
    key: 'goal-weight',
    component: GoalWeightStep,
    prep: { currentWeight: '200' },
    expectedNext: 'health-app',
    blockedPhases: [
      {
        label: 'goal above current weight',
        mutate: root => typeText(root, 'ob-goal-input', '250', 'goal above current'),
        hintContains: 'below your current weight',
      },
    ],
    makeValid: root => typeText(root, 'ob-goal-input', '150', 'goal valid'),
  },
  {
    // GLP-1 patients pick right away (the THINNR protocol locks the picker;
    // that branch is covered by the diet suite).
    key: 'diet',
    component: DietStep,
    prep: { program: 'glp1', gender: 'male' },
    expectedNext: 'allergies',
    blockedPhases: [
      {
        label: 'diet picked, activity level missing',
        mutate: root => tap(root, 'ob-diet-just_tracking', 'diet picked'),
        hintContains: 'activity level',
      },
      {
        label: 'screened diet with its safety question open',
        mutate: root => {
          tap(root, 'ob-diet-keto', 'keto picked');
          tap(root, 'ob-activity-moderate', 'activity picked');
        },
        hintContains: 'safety question',
      },
    ],
    makeValid: root => tap(root, 'ob-screen-medication-no', 'medication answered'),
  },
  {
    key: 'allergies',
    component: AllergiesStep,
    expectedNext: 'restrictions',
    makeValid: root => tap(root, 'ob-allergies-none', 'allergies none'),
  },
  {
    key: 'injection-day',
    component: InjectionDayStep,
    prep: { program: 'glp1' },
    expectedNext: 'diet',
    makeValid: root => tap(root, 'ob-injection-day-1', 'injection day valid'),
  },
];

// ─── 4. Run ──────────────────────────────────────────────────────────────────

async function main() {
  const gatedKeys = runStaticGuard();

  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  // react-test-renderer 19 prints a one-line deprecation notice; keep the
  // output readable but let every other console.error through untouched.
  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    realConsoleError(...args);
  };
  const rendererModule = (await import('react-test-renderer')) as unknown as {
    default?: { create?: (el: React.ReactElement) => Renderer };
    create?: (el: React.ReactElement) => Renderer;
  };
  const TestRenderer = rendererModule.default ?? rendererModule;
  if (!TestRenderer.create) throw new Error('react-test-renderer did not expose create()');
  createRenderer = TestRenderer.create.bind(TestRenderer);

  // The static scan and the runtime specs must agree exactly, so a future
  // gated step cannot ship without runtime coverage (and stale specs die).
  const covered = new Set<string>(SPECS.map(s => s.key));
  for (const [key, where] of gatedKeys) {
    assert(
      `coverage: gated step "${key}" (${where}) has a runtime spec — add one to verify-onboarding-gate.ts when introducing a gated step`,
      covered.has(key),
    );
  }
  for (const key of covered) {
    assert(
      `coverage: runtime spec "${key}" still matches a gated <OnboardingFrame> in the source — remove stale specs`,
      gatedKeys.has(key),
    );
  }

  // Per-step journey: blocked tap explains → input fixes → Next advances.
  for (const spec of SPECS) {
    const label = `step "${spec.key}"`;
    const renderer = renderStep(spec.component, spec.prep);
    const root = renderer.root;

    assert(`${label}: renders its Next button`, pressableByTestID(root, 'ob-next') !== null);
    assert(`${label}: starts blocked (semantically disabled Next)`, nextSemanticallyDisabled(root));
    assert(`${label}: shows no hint before any tap`, !readHint(root).present);

    const delivered = tap(root, 'ob-next', label);
    assert(`${label}: blocked Next still catches the tap (no pointer swallow)`, delivered);

    const hint = readHint(root);
    assert(`${label}: blocked tap surfaces the ob-next-hint ErrorBox`, hint.present);
    assert(`${label}: hint message is non-empty`, hint.message.trim().length > 0);
    assert(`${label}: hint text is rendered on screen`, hint.renderedText.includes(hint.message));
    assert(`${label}: hint announces as a polite alert live region`, hint.alertRole && hint.politeLive);
    assert(`${label}: blocked tap never navigates`, routerCalls.length === 0);

    for (const phase of spec.blockedPhases ?? []) {
      phase.mutate(root);
      const live = readHint(root);
      assert(`${label} · ${phase.label}: still blocked`, nextSemanticallyDisabled(root));
      assert(`${label} · ${phase.label}: hint stays up while blocked`, live.present);
      assert(
        `${label} · ${phase.label}: hint explains the current problem (contains "${phase.hintContains}")`,
        live.message.toLowerCase().includes(phase.hintContains.toLowerCase()),
      );
      assert(`${label} · ${phase.label}: still no navigation`, routerCalls.length === 0);
    }

    spec.makeValid(root);
    assert(`${label}: valid input clears the hint`, !readHint(root).present);
    assert(`${label}: valid input enables Next`, !nextSemanticallyDisabled(root));
    assert(`${label}: nothing navigated while typing/selecting`, routerCalls.length === 0);

    const advanced = tap(root, 'ob-next', label);
    assert(`${label}: enabled Next accepts the tap`, advanced);
    const p = pushes();
    assert(
      `${label}: Next advances once to /onboarding/${spec.expectedNext}` +
        (p.length ? ` (saw ${p.map(c => c.target).join(', ')})` : ' (saw no navigation)'),
      p.length === 1 && p[0].target === `/onboarding/${spec.expectedNext}`,
    );
    assert(`${label}: advancing leaves no hint behind`, !readHint(root).present);

    act(() => renderer.unmount());
  }

  // Re-block behavior: a hint never lingers from a previous blocked round,
  // and a fresh blocked tap re-arms it (allergies can toggle back to empty).
  {
    const label = 'step "allergies" re-block';
    const renderer = renderStep(AllergiesStep);
    const root = renderer.root;

    // Arm the hint first: the blocked tap flips the frame's internal
    // show-hint state to true...
    tap(root, 'ob-next', label);
    assert(`${label}: blocked tap shows the hint`, readHint(root).present);

    // ...so that after going valid, the frame MUST reset that state — if it
    // only hid the hint while enabled, re-blocking would resurrect stale
    // guidance without any tap.
    tap(root, 'ob-allergy-opt-milk', label);
    assert(`${label}: adding an allergy enables Next`, !nextSemanticallyDisabled(root));
    assert(`${label}: adding an allergy clears the hint`, !readHint(root).present);
    assert(`${label}: a catalog allergy defaults to mild`, onboarding.answers.allergies[0]?.severity === 'mild');
    tap(root, 'ob-allergy-item-milk-severe', label);
    assert(`${label}: severity can be raised to severe`, onboarding.answers.allergies[0]?.severity === 'severe');
    tap(root, 'ob-allergy-opt-milk', label); // toggle back off — blocked again
    assert(`${label}: clearing the selection re-blocks Next`, nextSemanticallyDisabled(root));
    assert(`${label}: re-blocking alone shows no stale hint`, !readHint(root).present);

    const delivered = tap(root, 'ob-next', label);
    const hint = readHint(root);
    assert(
      `${label}: a fresh blocked tap re-surfaces the hint`,
      delivered && hint.present && hint.message.trim().length > 0,
    );
    assert(`${label}: still no navigation`, routerCalls.length === 0);

    tap(root, 'ob-allergies-none', label);
    assert(`${label}: "None" clears the hint`, !readHint(root).present);
    tap(root, 'ob-next', label);
    const p = pushes();
    assert(
      `${label}: Next then advances to /onboarding/restrictions`,
      p.length === 1 && p[0].target === '/onboarding/restrictions',
    );

    act(() => renderer.unmount());
  }

  // The THINNR protocol locks the picker: the step explains, asks only for
  // activity level, and leaves the diet unset.
  {
    const label = 'step "diet" locked by the protocol';
    const renderer = renderStep(DietStep, { program: 'thinnr', started: 'no', startOffsetDays: 0 });
    const root = renderer.root;
    assert(`${label}: shows the lock explanation`, root.findAllByProps({ testID: 'ob-diet-locked' }).length > 0);
    assert(`${label}: renders no diet cards`, root.findAllByProps({ testID: 'ob-diet-just_tracking' }).length === 0);
    assert(`${label}: still waits for the activity level`, nextSemanticallyDisabled(root));
    tap(root, 'ob-activity-light', label);
    assert(`${label}: activity level alone unlocks Next`, !nextSemanticallyDisabled(root));
    tap(root, 'ob-next', label);
    const p = pushes();
    assert(
      `${label}: advances to /onboarding/allergies with no diet picked`,
      p.length === 1 && p[0].target === '/onboarding/allergies' && onboarding.answers.dietSlug === null,
    );
    act(() => renderer.unmount());
  }

  finish();
}

main().catch(error => {
  console.error('onboarding blocked-Next gate crashed:', error);
  process.exit(1);
});
