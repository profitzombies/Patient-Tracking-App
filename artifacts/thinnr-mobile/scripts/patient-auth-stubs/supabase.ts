/**
 * Node stand-in for @/lib/supabase (see tsconfig.patient-auth.json `paths`).
 *
 * The passwordless screens' pure helpers (normalizePhone, describeAuthError)
 * are re-exported from the REAL lib so the suite exercises genuine input
 * normalization and error copy. Only the client is faked: verifyOtp records
 * the token hash the screen hands it (the whole point of the code → session
 * trade) and returns a scripted result; useSupabaseSession stays signed out
 * so the identify card renders.
 */
// eslint-disable-next-line no-restricted-imports -- resolves to the real lib (relative paths skip the alias remap)
export { describeAuthError, normalizePhone } from '../../lib/supabase';

export interface RecordedVerifyOtp {
  token_hash: string;
  type: string;
}

export const verifyOtpCalls: RecordedVerifyOtp[] = [];
export const signOutCalls: number[] = [];

let nextVerifyOtpError: { message: string } | null = null;
let stubAccessToken: string | null = null;

export function setStubAccessToken(token: string | null): void {
  stubAccessToken = token;
}

/** Make the next verifyOtp fail with this raw GoTrue-style message (one-shot). */
export function failNextVerifyOtp(message: string): void {
  nextVerifyOtpError = { message };
}

export function clearAuthStub(): void {
  verifyOtpCalls.length = 0;
  signOutCalls.length = 0;
  nextVerifyOtpError = null;
}

export const supabaseConfigured = true;

export const supabase = {
  auth: {
    async verifyOtp(params: RecordedVerifyOtp) {
      verifyOtpCalls.push({ ...params });
      if (nextVerifyOtpError) {
        const error = nextVerifyOtpError;
        nextVerifyOtpError = null;
        return { data: { session: null, user: null }, error };
      }
      return {
        data: { session: { access_token: 'test-access-token' }, user: { id: 'test-user' } },
        error: null,
      };
    },
    async signOut() {
      signOutCalls.push(Date.now());
      stubAccessToken = null;
      return { error: null };
    },
    async getSession() {
      return { data: { session: stubAccessToken ? { access_token: stubAccessToken } : null } };
    },
  },
};

/** The suite always starts signed out; sessions are proven via verifyOtpCalls. */
export function useSupabaseSession(): { session: null; sessionLoading: boolean } {
  return { session: null, sessionLoading: false };
}

// ── Session-state helpers the real lib also exports ─────────────────────────
// eslint-disable-next-line no-restricted-imports
import { stubSessionHelpers } from '../stub-session-helpers';
const sessionHelpers = stubSessionHelpers(() => () => supabase.auth.getSession());
export const {
  SESSION_RECONNECTING_MESSAGE,
  STALE_SESSION_RETRY_MS,
  SessionReconnectingError,
  isSessionReconnectingError,
  sessionStorageKey,
  sessionStorageKeyFor,
  readStoredSession,
  missingTokenMessage,
  resolveSessionAccessToken,
} = sessionHelpers;
