export type LiveEntryDecision =
  | { kind: 'hold' }
  | { kind: 'allow' }
  | { kind: 'redirect'; href: '/onboarding/welcome' | '/patient-welcome' | '/today' | '/consent' };

export interface LiveEntryGateInput {
  modeHydrated: boolean;
  mode: 'patient' | 'staff' | null;
  accountResolving: boolean;
  accountKind: 'signed-out' | 'unresolved' | 'real';
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
}

export const ACCOUNT_CLOSED_MESSAGE =
  'This account was closed. You can create a new account with the same phone number.';

export const PROGRAM_ENDED_MESSAGE = 'This program has ended. Contact your provider.';

/** The office came back (reactivation) but this login was retired when its chart was sealed. */
export const REENROLL_REQUIRED_MESSAGE =
  'Your office has rejoined THINNR, but this login was retired when the program ended. Contact the office to re-enroll.';

export function isAccountClosedResolutionError(
  error: unknown,
): error is { code: 'account_closed'; status: 404 } {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { code?: unknown; status?: unknown };
  return failure.code === 'account_closed' && failure.status === 404;
}

export function isReenrollRequiredResolutionError(
  error: unknown,
): error is { code: 'reenroll_required'; status: 404 } {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { code?: unknown; status?: unknown };
  return failure.code === 'reenroll_required' && failure.status === 404;
}

export function isProgramEndedResolutionError(
  error: unknown,
): error is { code: 'program_ended'; status: 403 } {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { code?: unknown; status?: unknown };
  return failure.code === 'program_ended' && failure.status === 403;
}

/** Routes a real account may use before consent is recorded or while a deletion is pending. */
const CONSENT_ROUTE = '/consent';

/** Routes owned by the operations persona, never by a patient session. */
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
    '/program-ended',
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
  if (input.pathname === '/security-report' || input.pathname === '/program-ended') {
    return { kind: 'allow' };
  }
  if (
    !input.modeHydrated ||
    input.accountResolving ||
    (input.accountKind === 'real' && !input.patientHydrated)
  ) {
    return { kind: 'hold' };
  }
  // Staff has its own protected route model. A patient mode persisted from a
  // previous visit is not proof that this device is entitled to patient data:
  // only a resolved real account opens protected patient routes.
  if (
    input.accountKind !== 'real' &&
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

/** Device-local calendar day, intentionally independent of the fixed data anchor. */
export function localTodayKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
