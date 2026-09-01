export type LiveEntryDecision =
  | { kind: 'hold' }
  | { kind: 'allow' }
  | { kind: 'redirect'; href: '/onboarding/welcome' };

export interface LiveEntryGateInput {
  modeHydrated: boolean;
  mode: 'patient' | 'staff' | null;
  accountResolving: boolean;
  accountKind: 'demo' | 'unresolved' | 'real';
  patientHydrated: boolean;
  onboardingComplete: boolean | null;
  pathname: string;
}

/**
 * Route-level policy for a signed-in patient. Unknown hydration state holds
 * the navigator; known-incomplete real accounts may use only onboarding.
 */
export function liveEntryDecision(input: LiveEntryGateInput): LiveEntryDecision {
  if (
    !input.modeHydrated ||
    input.accountResolving ||
    (input.accountKind === 'real' && !input.patientHydrated)
  ) {
    return { kind: 'hold' };
  }
  if (
    input.mode === 'patient' &&
    input.accountKind === 'real' &&
    input.onboardingComplete !== true &&
    !input.pathname.startsWith('/onboarding')
  ) {
    return { kind: 'redirect', href: '/onboarding/welcome' };
  }
  return { kind: 'allow' };
}

/** Device-local calendar day, intentionally independent of the demo anchor. */
export function localTodayKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}