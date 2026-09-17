export type LiveEntryDecision =
  | { kind: 'hold' }
  | { kind: 'allow' }
  | { kind: 'redirect'; href: '/onboarding/welcome' | '/patient-welcome' | '/today' | '/consent' };

export interface LiveEntryGateInput {
  modeHydrated: boolean;
  mode: 'patient' | 'staff' | null;
  accountResolving: boolean;
  accountKind: 'demo' | 'unresolved' | 'real';
  patientHydrated: boolean;
  onboardingComplete: boolean | null;
  /**
   * Whether the server holds this patient's consent for the CURRENT policy
   * version. null = unknown (older servers); treated as not satisfied so no
   * protected route opens without a recorded consent.
   */
  consentSatisfied?: boolean | null;
  /** A deletion request is pending: the account is parked on /consent. */
  deletionPending?: boolean;
  pathname: string;
  demoAdmitted?: boolean;
}

/** Routes a real account may use before consent is recorded or while a deletion is pending. */
const CONSENT_ROUTE = '/consent';

/** Routes owned by the operations persona, never by the seeded patient demo. */
function isStaffRoute(pathname: string): boolean {
  return pathname === '/' || [
    '/patients',
    '/outcomes',
    '/leaderboard',
    '/payments',
    '/training',
    '/training-course/',
    '/training-lesson/',
    '/training-teammate/',
    '/patient/',
    '/office-patient/',
    '/sell-to-patient',
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
    '/security-report',
  ].includes(pathname);
}

/**
 * Route-level policy for a signed-in patient. Unknown hydration state holds
 * the navigator; known-incomplete real accounts may use only onboarding.
 */
export function liveEntryDecision(input: LiveEntryGateInput): LiveEntryDecision {
  // Alert-email security links are deliberately public and must not wait for
  // persona, account, consent, or patient-data hydration.
  if (input.pathname === '/security-report') return { kind: 'allow' };
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
  if (input.accountKind === 'real') {
    // Consent comes before any health data is entered or read — including
    // onboarding — and a pending deletion parks the account on the same
    // screen ("keep my account" or sign out) until it is cancelled.
    const consentGate = input.consentSatisfied !== true || input.deletionPending === true;
    if (consentGate && input.pathname !== CONSENT_ROUTE) {
      return { kind: 'redirect', href: CONSENT_ROUTE };
    }
    if (!consentGate && input.pathname === CONSENT_ROUTE) {
      return {
        kind: 'redirect',
        href: input.onboardingComplete === true ? '/today' : '/onboarding/welcome',
      };
    }
    if (consentGate) return { kind: 'allow' };
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
