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
export type PatientDataErrorCode = 'CONSENT_REQUIRED' | 'PHOTO_ANALYSIS_OPT_IN_REQUIRED';

export class PatientDataError extends Error {
  readonly code: PatientDataErrorCode | null;
  constructor(message: string, code: PatientDataErrorCode | null = null) {
    super(message);
    this.name = 'PatientDataError';
    this.code = code;
  }
}

export function patientDataErrorCode(raw: unknown): PatientDataErrorCode | null {
  return raw === 'CONSENT_REQUIRED' || raw === 'PHOTO_ANALYSIS_OPT_IN_REQUIRED' ? raw : null;
}
