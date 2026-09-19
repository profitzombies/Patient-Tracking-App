/**
 * Typed failure for the live patient-data rail. Kept dependency-free so
 * contexts can `instanceof` it without pulling the network client (and its
 * Expo/Supabase imports) into Node-run suites.
 */

/**
 * Machine-readable refusal codes the server attaches to some failures.
 * CONSENT_REQUIRED — the account has not accepted the current policy
 * version; every data route refuses until it does (the consent screen is
 * the only way forward). PHOTO_ANALYSIS_OPT_IN_REQUIRED — the patient
 * declined optional photo analysis, so photo features are off server-side.
 */
export type PatientDataErrorCode =
  | 'CONSENT_REQUIRED'
  | 'PHOTO_ANALYSIS_OPT_IN_REQUIRED'
  | 'account_closed'
  | 'program_ended';

/**
 * Where a failure came from, so the offline write queue can decide whether
 * a retry could ever succeed:
 *   network  — no response at all (offline, DNS, timeout): retry later.
 *   http     — the server answered; `status` says whether it's worth retrying.
 *   config   — this build can't reach the rail at all (no base URL / auth).
 *   signedOut — no session token: retry once the patient is signed in again.
 */
export type PatientDataFailureKind = 'network' | 'http' | 'config' | 'signedOut';

export class PatientDataError extends Error {
  readonly code: PatientDataErrorCode | null;
  readonly kind: PatientDataFailureKind;
  /** HTTP status when the server answered; null for network/config failures. */
  readonly status: number | null;
  /** Form field named by a structured server refusal, when present. */
  readonly field: string | null;
  constructor(
    message: string,
    code: PatientDataErrorCode | null = null,
    options: { kind?: PatientDataFailureKind; status?: number | null; field?: string | null } = {},
  ) {
    super(message);
    this.name = 'PatientDataError';
    this.code = code;
    this.kind = options.kind ?? (typeof options.status === 'number' ? 'http' : 'network');
    this.status = typeof options.status === 'number' ? options.status : null;
    this.field = typeof options.field === 'string' ? options.field : null;
  }
}

export function patientDataErrorCode(raw: unknown): PatientDataErrorCode | null {
  return raw === 'CONSENT_REQUIRED' ||
    raw === 'PHOTO_ANALYSIS_OPT_IN_REQUIRED' ||
    raw === 'account_closed' ||
    raw === 'program_ended'
    ? raw
    : null;
}
