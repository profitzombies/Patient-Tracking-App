/**
 * In-memory state for the simulated new-patient onboarding flow.
 *
 * Deliberately NOT persisted: the simulation is repeatable and must never
 * touch Emma's seeded patient state or any storage key. Resetting happens
 * when the user starts a new run from the patient entry screen.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
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

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [begun, setBegun] = useState(false);
  const [furthest, setFurthest] = useState<StepKey>('welcome');
  const [answers, setAnswers] = useState<OnboardingAnswers>(freshAnswers);

  const patch = useCallback((partial: Partial<OnboardingAnswers>) => {
    setAnswers(prev => ({ ...prev, ...partial }));
  }, []);

  const reset = useCallback(() => {
    setAnswers(freshAnswers());
    setFurthest('welcome');
    setBegun(true);
  }, []);

  const advance = useCallback((key: StepKey) => {
    setFurthest(prev => (stepOrderIndex(key) > stepOrderIndex(prev) ? key : prev));
  }, []);

  const endRun = useCallback(() => {
    setBegun(false);
  }, []);

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
