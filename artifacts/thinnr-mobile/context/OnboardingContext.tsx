/**
 * State for the new-patient onboarding flow.
 *
 * The DEMO persona's run is a repeatable in-memory simulation: nothing
 * persists, nothing touches Emma's seeded patient state or any storage key,
 * and resetting happens when the user starts a new run from the patient
 * entry screen — exactly as before accounts existed.
 *
 * A REAL signed-in patient gets the same screens, but every legitimate
 * advance saves the answers gathered so far to the account (a partial flag
 * merge), and finishing the run marks onboarding complete and derives the
 * notification preferences — so the answers survive reload and reinstall.
 * Saves go through the patient store's gated flag queue: they wait for the
 * account's server truth (never racing hydration), newer answers coalesce
 * over older ones while a push is in flight, and a failed push surfaces a
 * retryable sync notice instead of being dropped. Onboarding itself still
 * never blocks on the network.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { router, type Href } from 'expo-router';
import {
  DEFAULT_ANSWERS,
  stepOrderIndex,
  visibleSteps,
  type OnboardingAnswers,
  type StepKey,
} from '@/data/onboarding-data';
import { usePatientAccount, type PatientFlagsWrite } from './PatientAccountContext';
import { usePatientOptional } from './PatientContext';

interface OnboardingContextValue {
  /** True while a run is live (guards deep links; cleared after completion). */
  begun: boolean;
  answers: OnboardingAnswers;
  /** Furthest step (in flow order) the user has legitimately reached. */
  furthest: StepKey;
  patch: (partial: Partial<OnboardingAnswers>) => void;
  /** Fresh answers + mark the run as begun. */
  reset: () => void;
  /** Record that the user advanced to `key` through the flow. */
  advance: (key: StepKey) => void;
  /** End the run after completion so stale history redirects to a fresh start. */
  endRun: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function freshAnswers(): OnboardingAnswers {
  return { ...DEFAULT_ANSWERS, diets: [...DEFAULT_ANSWERS.diets] };
}

/**
 * Rebuild answers from the account's stored copy. Only known answer keys
 * apply (defaults fill the rest), and stored notification prefs — the
 * finished run's derived truth — override their answer keys when present.
 */
function restoredAnswers(
  raw: Record<string, unknown>,
  prefs: Record<string, unknown> | null,
): OnboardingAnswers {
  const base = freshAnswers() as unknown as Record<string, unknown>;
  const source: Record<string, unknown> = prefs ? { ...raw, ...prefs } : raw;
  for (const key of Object.keys(base)) {
    if (!(key in source)) continue;
    if (key === 'diets') {
      const diets = source[key];
      if (Array.isArray(diets)) base[key] = diets.filter(d => typeof d === 'string');
    } else {
      base[key] = source[key];
    }
  }
  return base as unknown as OnboardingAnswers;
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { account } = usePatientAccount();
  const [begun, setBegun] = useState(false);
  const [furthest, setFurthest] = useState<StepKey>('welcome');
  const [answers, setAnswers] = useState<OnboardingAnswers>(freshAnswers);

  // Mirrors `answers` synchronously: a screen patches and advances in the
  // same tick, so the save that rides the advance must see the just-patched
  // values, not the state from the previous render.
  const answersRef = useRef(answers);
  const accountRef = useRef(account);
  accountRef.current = account;

  // The patient store owns the actual write (gated on server truth, with a
  // retryable notice on failure). Optional so the standalone Node suite
  // mounts — OnboardingProvider without PatientProvider — still work; in
  // the app the root layout always nests this provider inside it.
  const patient = usePatientOptional();
  const saveFlagsRef = useRef<((flags: Partial<PatientFlagsWrite>) => void) | null>(null);
  saveFlagsRef.current = patient?.saveOnboardingFlags ?? null;

  const pushFlags = useCallback((flags: Partial<PatientFlagsWrite>) => {
    if (accountRef.current.kind !== 'real') return;
    saveFlagsRef.current?.(flags);
  }, []);

  // A signed-in patient's saved answers come back with account hydration
  // (reload, reinstall, new device). Reconcile once per account key: a key
  // change first resets to fresh answers so one account's answers never
  // show under another (or under the demo persona), then the account's
  // stored answers apply. Never touches a live run, and the demo persona —
  // which has no hydration — behaves exactly as before accounts existed.
  const hydratedFlags = patient?.hydratedFlags ?? null;
  const accountId = account.kind === 'real' ? account.patientId : null;
  const reconcileKeyRef = useRef<string | null>(null);
  const appliedServerRef = useRef(false);
  useEffect(() => {
    const key = accountId ?? 'demo';
    if (reconcileKeyRef.current !== key) {
      const firstMount = reconcileKeyRef.current === null;
      reconcileKeyRef.current = key;
      appliedServerRef.current = false;
      if (!firstMount && !begun) {
        answersRef.current = freshAnswers();
        setAnswers(answersRef.current);
        setFurthest('welcome');
      }
    }
    if (!accountId || !hydratedFlags || appliedServerRef.current) return;
    appliedServerRef.current = true;
    if (begun || !hydratedFlags.onboardingAnswers) return;
    answersRef.current = restoredAnswers(
      hydratedFlags.onboardingAnswers,
      hydratedFlags.notificationPrefs,
    );
    setAnswers(answersRef.current);
  }, [accountId, hydratedFlags, begun]);

  const patch = useCallback((partial: Partial<OnboardingAnswers>) => {
    answersRef.current = { ...answersRef.current, ...partial };
    setAnswers(answersRef.current);
  }, []);

  const reset = useCallback(() => {
    answersRef.current = freshAnswers();
    setAnswers(answersRef.current);
    setFurthest('welcome');
    setBegun(true);
  }, []);

  const advance = useCallback(
    (key: StepKey) => {
      setFurthest(prev => (stepOrderIndex(key) > stepOrderIndex(prev) ? key : prev));
      pushFlags({ onboardingAnswers: answersRef.current });
    },
    [pushFlags],
  );

  const endRun = useCallback(() => {
    setBegun(false);
    const final = answersRef.current;
    pushFlags({
      onboardingAnswers: final,
      onboardingComplete: true,
      notificationPrefs: {
        notifications: final.notifications,
        reminderMorning: final.reminderMorning,
        reminderAfternoon: final.reminderAfternoon,
        reminderEvening: final.reminderEvening,
      },
    });
  }, [pushFlags]);

  const value = useMemo<OnboardingContextValue>(
    () => ({ begun, answers, furthest, patch, reset, advance, endRun }),
    [begun, answers, furthest, patch, reset, advance, endRun],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used within OnboardingProvider');
  return ctx;
}

/**
 * Position of a step within the currently visible flow (conditional steps
 * collapse based on answers), plus navigation helpers.
 */
export function useOnboardingFlow(current: StepKey) {
  const { answers, advance } = useOnboarding();
  const steps = visibleSteps(answers);
  const index = steps.indexOf(current);

  const goNext = useCallback(() => {
    const next = steps[index + 1];
    if (next) {
      advance(next);
      router.push(`/onboarding/${next}` as Href);
    }
  }, [steps, index, advance]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/patient-entry' as Href);
  }, []);

  const stepNumber = index + 1;
  const stepCount = steps.length;
  return {
    stepNumber,
    stepCount,
    progress: stepCount > 0 ? (stepNumber / stepCount) * 100 : 0,
    goNext,
    goBack,
  };
}
