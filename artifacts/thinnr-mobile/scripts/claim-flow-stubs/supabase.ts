/**
 * Node stand-in for @/lib/supabase (see tsconfig.claim-flow.json `paths`).
 *
 * The claim screen's pure helpers (normalizePhone, describeAuthError) are
 * re-exported from the REAL lib so the suite exercises genuine input
 * normalization. Only the client is faked: signInWithPassword records the
 * credentials the screen hands it and returns a scripted result, and
 * getSession returns a stable access token for the add-phone Bearer calls.
 */
// eslint-disable-next-line no-restricted-imports -- resolves to the real lib (relative paths skip the alias remap)
export { describeAuthError, normalizePhone } from '../../lib/supabase';

export interface RecordedSignIn {
  email?: string;
  phone?: string;
  password: string;
}

export const signInCalls: RecordedSignIn[] = [];

export const TEST_ACCESS_TOKEN = 'test-access-token';

let nextSignInError: { message: string } | null = null;

/** Make the next signInWithPassword fail with this message (one-shot). */
export function failNextSignIn(message: string): void {
  nextSignInError = { message };
}

export function clearSignInCalls(): void {
  signInCalls.length = 0;
  nextSignInError = null;
}

export const supabaseConfigured = true;

export const supabase = {
  auth: {
    async signInWithPassword(credentials: RecordedSignIn) {
      signInCalls.push({ ...credentials });
      if (nextSignInError) {
        const error = nextSignInError;
        nextSignInError = null;
        return { data: { session: null, user: null }, error };
      }
      return {
        data: {
          session: { access_token: TEST_ACCESS_TOKEN },
          user: { id: 'test-user' },
        },
        error: null,
      };
    },
    async getSession() {
      return { data: { session: { access_token: TEST_ACCESS_TOKEN } } };
    },
  },
};

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
