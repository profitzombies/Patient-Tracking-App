export type LiveEntryDecision =
  | { kind: 'hold' }
  | { kind: 'allow' }
  | { kind: 'redirect'; href: '/onboarding/welcome' | '/patient-welcome' | '/today' };

export interface LiveEntryGateInput {
  modeHydrated: boolean;
  mode: 'patient' | 'staff' | null;
  accountResolving: boolean;
  accountKind: 'demo' | 'unresolved' | 'real';
  patientHydrated: boolean;
  onboardingComplete: boolean | null;
  pathname: string;
  demoAdmitted?: boolean;
}

/** Routes owned by the operations persona, never by the seeded patient demo. */
function isStaffRoute(pathname: string): boolean {
  return pathname === '/' || [
    '/patients',
    '/outcomes',
    '/leaderboard',
    '/subscriptions',
    '/training',
    '/training-course/',
    '/training-lesson/',
    '/training-teammate/',
    '/patient/',
    '/product/',
    '/claim-account',
    '/claim-test',
  ].some(prefix => pathname.startsWith(prefix));
}

/** Entry routes that remain available while no patient session exists. */
function isPatientAccessRoute(pathname: string): boolean {
  return [
    '/patient-welcome',
    '/patient-login',
    '/patient-signup',
    '/provider-login',
    '/persona',
  ].includes(pathname);
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
  // Staff has its own protected route model. A patient mode persisted from a
  // previous visit is not proof that this device is entitled to demo data.
  if (
    input.accountKind !== 'real' &&
    !input.demoAdmitted &&
    !isStaffRoute(input.pathname) &&
    !isPatientAccessRoute(input.pathname)
  ) {
    return { kind: 'redirect', href: '/patient-welcome' };
  }
  if (
    input.accountKind === 'real' &&
    input.onboardingComplete !== true &&
    !input.pathname.startsWith('/onboarding')
  ) {
    return { kind: 'redirect', href: '/onboarding/welcome' };
  }
  if (
    input.accountKind === 'real' &&
    input.onboardingComplete === true &&
    (input.pathname.startsWith('/onboarding') || input.pathname === '/patient-welcome')
  ) {
    return { kind: 'redirect', href: '/today' };
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