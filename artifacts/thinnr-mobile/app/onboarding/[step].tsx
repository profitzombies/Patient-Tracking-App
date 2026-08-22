/**
 * Dynamic route for every simulated-onboarding step. The step order and
 * conditional visibility live in data/onboarding-data.ts; this file only
 * maps step keys to their screens and guards stale deep links.
 */
import React from 'react';
import { Redirect, useLocalSearchParams, usePathname, type Href } from 'expo-router';
import { useOnboarding } from '@/context/OnboardingContext';
import { guardTarget, isStepAccessible, type StepKey } from '@/data/onboarding-data';
import {
  ContactStep,
  FaceIdStep,
  PasswordStep,
  ProviderCodeStep,
  VerifyStep,
  WelcomeStep,
} from '@/components/onboarding/StepsAccount';
import {
  BirthdayStep,
  GenderStep,
  GoalWeightStep,
  HeightStep,
  ProgramStep,
  StartDateStep,
  StartedStep,
  WeightStep,
} from '@/components/onboarding/StepsProfile';
import {
  CompleteStep,
  DietsStep,
  HealthAppStep,
  NotificationsStep,
  ReminderAfternoonStep,
  ReminderEveningStep,
  ReminderMorningStep,
} from '@/components/onboarding/StepsPrefs';

const REGISTRY: Record<StepKey, React.ComponentType> = {
  welcome: WelcomeStep,
  contact: ContactStep,
  verify: VerifyStep,
  'provider-code': ProviderCodeStep,
  'face-id': FaceIdStep,
  password: PasswordStep,
  height: HeightStep,
  weight: WeightStep,
  gender: GenderStep,
  birthday: BirthdayStep,
  program: ProgramStep,
  started: StartedStep,
  'start-date': StartDateStep,
  'goal-weight': GoalWeightStep,
  'health-app': HealthAppStep,
  notifications: NotificationsStep,
  'reminder-morning': ReminderMorningStep,
  'reminder-afternoon': ReminderAfternoonStep,
  'reminder-evening': ReminderEveningStep,
  diets: DietsStep,
  complete: CompleteStep,
};

export default function OnboardingStepScreen() {
  const { step } = useLocalSearchParams<{ step: string }>();
  const { begun, answers, furthest } = useOnboarding();
  const pathname = usePathname();

  const key = (Array.isArray(step) ? step[0] : step) as StepKey | undefined;
  const StepComponent = key ? REGISTRY[key] : undefined;

  // Only the active route may issue redirects; screens re-rendering during a
  // transition away (e.g. completion navigating to /today) render nothing so
  // they can't hijack the navigation in flight.
  const isActive = key !== undefined && pathname === `/onboarding/${key}`;

  if (!StepComponent) {
    return isActive ? <Redirect href="/onboarding/welcome" /> : null;
  }
  // No live run (never started, or ended after completion): restart fresh.
  if (!begun && key !== 'welcome') {
    return isActive ? <Redirect href="/onboarding/welcome" /> : null;
  }
  // Block deep links that skip ahead and stale routes hidden by answer changes.
  if (begun && !isStepAccessible(answers, furthest, key!)) {
    if (!isActive) return null;
    return <Redirect href={`/onboarding/${guardTarget(answers, furthest)}` as Href} />;
  }

  return <StepComponent />;
}
