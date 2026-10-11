/**
 * Bloodwork-only recovery rail.
 *
 * The API client deliberately does not turn an authorization response into a
 * user-facing message.  This module is the small mobile seam that translates
 * the bloodwork contract into an action while keeping a selected file in
 * memory for the same account.  Draft files are never serialized or put in
 * AsyncStorage: they are private cache/blob copies owned by the screen.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { usePatient } from '@/context/PatientContext';
import { useSupabaseSession } from '@/lib/supabase';
import {
  disposeBloodworkDraftFiles,
  type BloodworkDraftFile,
} from '@/lib/bloodwork-media';

export type BloodworkRecoveryCode =
  | 'PATIENT_SETUP_REQUIRED'
  | 'CONSENT_REQUIRED'
  | 'PATIENT_ACCOUNT_UNAVAILABLE'
  | 'SESSION_REQUIRED'
  | 'ACCOUNT_LOOKUP_UNAVAILABLE';

export type BloodworkRecoveryAction =
  | 'setup'
  | 'consent'
  | 'account'
  | 'sign_in'
  | 'retry'
  | 'none';

export type BloodworkDocumentCode =
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'TYPE_MISMATCH'
  | 'CORRUPT_FILE'
  | 'ENCRYPTED_PDF'
  | 'TOO_MANY_PAGES'
  | 'IMAGE_TOO_LARGE'
  | 'PAGE_OUT_OF_RANGE'
  | 'RENDER_FAILED'
  | 'PROCESSING_TIMEOUT'
  | 'PROCESSING_LIMIT'
  | 'PROCESSING_BUSY';

export interface BloodworkRecovery {
  code: BloodworkRecoveryCode | null;
  documentCode?: BloodworkDocumentCode;
  action: BloodworkRecoveryAction;
  title: string;
  message: string;
  actionLabel: string | null;
  /** A 404/unauthorized patient response must not identify another account. */
  neutral: boolean;
}

export interface BloodworkDraftRequest {
  fingerprint: string;
  id: string;
}

export interface RetainedBloodworkDraft {
  /** `${session user id}:${patient id}`; never just a patient id. */
  accountKey: string;
  files: readonly BloodworkDraftFile[];
  title: string;
  reportDate: string;
  request: BloodworkDraftRequest;
}

let retainedDraft: RetainedBloodworkDraft | null = null;
let pendingRecoveryRoute: {
  route: '/consent' | '/onboarding/welcome';
  accountKey: string;
} | null = null;
const recoveryRouteListeners = new Set<() => void>();
function notifyRecoveryRoute(): void {
  for (const listener of recoveryRouteListeners) listener();
}
function subscribeRecoveryRoute(listener: () => void): () => void {
  recoveryRouteListeners.add(listener);
  return () => { recoveryRouteListeners.delete(listener); };
}

export function useBloodworkRecoveryRoute(accountKey: string | null): '/consent' | '/onboarding/welcome' | null {
  return useSyncExternalStore(
    subscribeRecoveryRoute,
    () => getBloodworkRecoveryRoute(accountKey),
    () => null,
  );
}

export function setBloodworkRecoveryRoute(
  route: '/consent' | '/onboarding/welcome',
  accountKey: string,
): void {
  if (!accountKey || accountKey === 'unavailable') return;
  pendingRecoveryRoute = { route, accountKey };
  notifyRecoveryRoute();
}

export function getBloodworkRecoveryRoute(accountKey: string | null): '/consent' | '/onboarding/welcome' | null {
  return pendingRecoveryRoute?.accountKey === accountKey ? pendingRecoveryRoute.route : null;
}

export function clearBloodworkRecoveryRoute(
  route?: '/consent' | '/onboarding/welcome',
  accountKey?: string,
): void {
  if (
    pendingRecoveryRoute &&
    (!route || pendingRecoveryRoute.route === route) &&
    (!accountKey || pendingRecoveryRoute.accountKey === accountKey)
  ) {
    pendingRecoveryRoute = null;
    notifyRecoveryRoute();
  }
}

/**
 * Reads the in-memory draft only when it belongs to the current authenticated
 * account.  The returned file objects are intentionally not cloned: cloning
 * would not clone ownership of their cache/blob bytes.
 */
export function readRetainedBloodworkDraft(accountKey: string): RetainedBloodworkDraft | null {
  if (!accountKey || accountKey === 'unavailable' || retainedDraft?.accountKey !== accountKey) {
    return null;
  }
  return retainedDraft;
}

/**
 * Keeps a recoverable draft alive across the global consent/setup/session
 * redirect.  Callers should pass the selected files, not picker/provider URIs.
 */
export function retainBloodworkDraft(draft: RetainedBloodworkDraft): void {
  retainedDraft = {
    ...draft,
    files: [...draft.files],
  };
}

/**
 * Forgets a draft.  `disposeFiles: false` is used when the screen still owns
 * the files but the patient edited the draft, so normal screen cleanup can
 * dispose them exactly once.
 */
export async function clearRetainedBloodworkDraft(
  accountKey?: string,
  options: { disposeFiles?: boolean } = {},
): Promise<void> {
  if (!retainedDraft) return;
  if (accountKey && retainedDraft.accountKey !== accountKey) return;
  const draft = retainedDraft;
  retainedDraft = null;
  if (options.disposeFiles !== false) {
    await disposeBloodworkDraftFiles(draft.files);
  }
}

/** Clears every private copy, used only when the auth or patient identity changes. */
export async function clearAllRetainedBloodworkDrafts(): Promise<void> {
  clearBloodworkRecoveryRoute();
  await clearRetainedBloodworkDraft();
}

function recoveryFor(
  code: BloodworkRecoveryCode | null,
  action: BloodworkRecoveryAction,
): BloodworkRecovery {
  switch (code) {
    case 'PATIENT_SETUP_REQUIRED':
      return {
        code,
        action: 'setup',
        title: 'Finish setting up your account',
        message: 'Complete your patient setup before saving this report. Your selected file, title, and date will stay on this account.',
        actionLabel: 'Finish setup',
        neutral: false,
      };
    case 'CONSENT_REQUIRED':
      return {
        code,
        action: 'consent',
        title: 'Review consent to continue',
        message: 'Review and accept the current consent choices before saving this report. Your draft will stay on this account.',
        actionLabel: 'Review consent',
        neutral: false,
      };
    case 'PATIENT_ACCOUNT_UNAVAILABLE':
      return {
        code,
        action: 'account',
        title: 'We couldn’t confirm your patient account',
        message: 'Try resolving your patient account again. We will keep this report draft here and will not move it to another patient.',
        actionLabel: 'Try account again',
        neutral: false,
      };
    case 'SESSION_REQUIRED':
      return {
        code,
        action: 'sign_in',
        title: 'Refresh your sign-in',
        message: 'Your sign-in needs refreshing before this private report can be saved. Refresh it to continue without losing this draft.',
        actionLabel: 'Refresh sign-in',
        neutral: false,
      };
    case 'ACCOUNT_LOOKUP_UNAVAILABLE':
      return {
        code,
        action: 'retry',
        title: 'Account service temporarily unavailable',
        message: 'We couldn’t confirm your account right now. Try again in a moment; your selected report stays here.',
        actionLabel: 'Try again',
        neutral: false,
      };
    default:
      return {
        code: null,
        action,
        title: action === 'none' ? 'Report unavailable' : 'Report not saved',
        message:
          action === 'none'
            ? 'This report is not available to the current patient account.'
            : 'We couldn’t save this report right now. Try again in a moment.',
        actionLabel: action === 'none' ? null : 'Try again',
        neutral: action === 'none',
      };
  }
}

const DOCUMENT_CODES = new Set<BloodworkDocumentCode>([
  'EMPTY_FILE',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_TYPE',
  'TYPE_MISMATCH',
  'CORRUPT_FILE',
  'ENCRYPTED_PDF',
  'TOO_MANY_PAGES',
  'IMAGE_TOO_LARGE',
  'PAGE_OUT_OF_RANGE',
  'RENDER_FAILED',
  'PROCESSING_TIMEOUT',
  'PROCESSING_LIMIT',
  'PROCESSING_BUSY',
]);

function documentRecovery(
  documentCode: BloodworkDocumentCode | null,
  status: number | null,
): BloodworkRecovery {
  const message =
    documentCode === 'FILE_TOO_LARGE' || status === 413
      ? 'This file is over the 20 MB limit. Choose a smaller PDF or image.'
      : documentCode === 'EMPTY_FILE'
        ? 'The selected file is empty. Choose the original PDF or image again.'
        : documentCode === 'UNSUPPORTED_TYPE' || documentCode === 'TYPE_MISMATCH'
          ? 'That file type is not supported. Choose a PDF or image file.'
          : documentCode === 'ENCRYPTED_PDF'
            ? 'This PDF is password-protected. Choose an unlocked copy.'
            : documentCode === 'TOO_MANY_PAGES'
              ? 'This PDF has too many pages. Choose a shorter report.'
              : documentCode === 'IMAGE_TOO_LARGE'
                ? 'This image is too large to process. Choose a smaller image.'
                : 'This file could not be processed. Check that it is a valid PDF or image and choose it again.';
  return {
    code: null,
    ...(documentCode ? { documentCode } : {}),
    action: 'none',
    title: 'Check the selected file',
    message,
    actionLabel: null,
    neutral: false,
  };
}

const KNOWN_CODES = new Set<BloodworkRecoveryCode>([
  'PATIENT_SETUP_REQUIRED',
  'CONSENT_REQUIRED',
  'PATIENT_ACCOUNT_UNAVAILABLE',
  'SESSION_REQUIRED',
  'ACCOUNT_LOOKUP_UNAVAILABLE',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Reads both generated ApiError.data and plain test/server errors.  No
 * transport text is copied into the UI: raw `HTTP 404 ...` is never an
 * acceptable bloodwork message.
 */
export function classifyBloodworkError(error: unknown): BloodworkRecovery {
  const source = asRecord(error);
  const data = asRecord(source?.data) ?? source;
  const rawCode = data?.code;
  const code = typeof rawCode === 'string' && KNOWN_CODES.has(rawCode as BloodworkRecoveryCode)
    ? rawCode as BloodworkRecoveryCode
    : null;
  const status = typeof source?.status === 'number' ? source.status : null;
  if (code) return recoveryFor(code, 'retry');
  const rawDocumentCode = data?.code;
  const documentCode =
    typeof rawDocumentCode === 'string' && DOCUMENT_CODES.has(rawDocumentCode as BloodworkDocumentCode)
      ? rawDocumentCode as BloodworkDocumentCode
      : null;
  if (documentCode || status === 413 || status === 422) {
    return documentRecovery(documentCode, status);
  }

  // 404 is intentionally neutral.  It can mean a wrong patient id, a
  // disabled account, or no office access; the patient app must not disclose
  // which one, and must not call it a corrupt PDF.
  if (status === 404) return recoveryFor(null, 'none');

  // A bare 401 from an older server is still safely recoverable as sign-in.
  if (status === 401) return recoveryFor('SESSION_REQUIRED', 'sign_in');
  // Dependency outages remain retryable even when an older server omitted its
  // machine-readable ACCOUNT_LOOKUP_UNAVAILABLE code.
  if (status === 503) return recoveryFor('ACCOUNT_LOOKUP_UNAVAILABLE', 'retry');
  return recoveryFor(null, 'retry');
}

export interface BloodworkEntryStateInput {
  accountKind: 'signed-out' | 'unresolved' | 'real';
  accountResolving: boolean;
  patientHydrated: boolean;
  onboardingComplete: boolean | null;
  consentSatisfied: boolean | null;
}

/**
 * Mirrors the server-confirmed entry policy used by the global navigator.
 * This is checked again at the bloodwork entry/save boundary so a stale
 * screen cannot submit after setup or consent has changed.
 */
export function bloodworkEntryRecovery(
  input: BloodworkEntryStateInput,
): BloodworkRecovery | null {
  if (input.accountKind === 'signed-out') return null;
  if (input.accountResolving || input.accountKind === 'unresolved' || !input.patientHydrated) {
    return recoveryFor('ACCOUNT_LOOKUP_UNAVAILABLE', 'retry');
  }
  if (input.consentSatisfied !== true) return recoveryFor('CONSENT_REQUIRED', 'consent');
  if (input.onboardingComplete !== true) return recoveryFor('PATIENT_SETUP_REQUIRED', 'setup');
  return null;
}

/**
 * Root-mounted lifecycle rail. A route redirect must not dispose a
 * same-account recovery draft, but a real sign-out or identity switch must
 * dispose its private cache/blob copies even if New Report is already gone.
 */
export function BloodworkDraftLifecycle(): null {
  const { session } = useSupabaseSession();
  const { account, resolving } = usePatientAccount();
  const patient = usePatient();
  const previousUser = useRef<string | null>(null);
  const settledAccount = useRef<string | null>(null);

  useEffect(() => {
    const userId = session?.user.id ?? null;
    if (!userId) {
      if (previousUser.current !== null || settledAccount.current !== null) {
        void clearAllRetainedBloodworkDrafts();
      }
      clearBloodworkRecoveryRoute();
      previousUser.current = null;
      settledAccount.current = null;
      return;
    }

    if (previousUser.current !== null && previousUser.current !== userId) {
      void clearAllRetainedBloodworkDrafts();
      clearBloodworkRecoveryRoute();
      settledAccount.current = null;
    }
    previousUser.current = userId;

    // An unresolved lookup is a transient state for this same user. Keep the
    // draft through it so the offered account retry cannot lose the report.
    if (resolving || account.kind === 'unresolved') return;

    const nextAccount =
      account.kind === 'real' ? `${userId}:${account.patientId}` : `other:${userId}`;
    if (settledAccount.current !== null && settledAccount.current !== nextAccount) {
      void clearAllRetainedBloodworkDrafts();
    }
    settledAccount.current = nextAccount;
  }, [account, resolving, session?.user.id]);

  useEffect(() => {
    if (
      pendingRecoveryRoute?.route === '/onboarding/welcome' &&
      patient.hydratedPrivacy?.consent.satisfied !== true
    ) {
      setBloodworkRecoveryRoute('/consent', pendingRecoveryRoute.accountKey);
      return;
    }
    if (
      pendingRecoveryRoute?.route === '/consent' &&
      patient.hydratedPrivacy?.consent.satisfied === true
    ) {
      clearBloodworkRecoveryRoute();
    }
    if (
      pendingRecoveryRoute?.route === '/onboarding/welcome' &&
      patient.hydratedFlags?.onboardingComplete === true
    ) {
      clearBloodworkRecoveryRoute();
    }
  }, [
    patient.hydratedFlags?.onboardingComplete,
    patient.hydratedPrivacy?.consent.satisfied,
  ]);

  return null;
}
