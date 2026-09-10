import {
  liveEntryDecision,
  type LiveEntryDecision,
  type LiveEntryGateInput,
} from './live-patient-entry';

/**
 * A verified-owner recovery response can supersede stale completion flags,
 * but cannot supersede any canonical identity, hydration or privacy gate.
 */
export function bloodworkRecoveryEntryDecision(
  input: LiveEntryGateInput,
  recoveryRoute: '/consent' | '/onboarding/welcome' | null,
): LiveEntryDecision {
  if (input.accountKind !== 'real') return liveEntryDecision(input);
  return liveEntryDecision({
    ...input,
    onboardingComplete:
      recoveryRoute === '/onboarding/welcome' && input.pathname.startsWith('/onboarding')
        ? false
        : input.onboardingComplete,
    consentSatisfied:
      recoveryRoute === '/consent' && input.pathname === '/consent'
        ? false
        : input.consentSatisfied,
  });
}