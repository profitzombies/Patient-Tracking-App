export function useSupabaseSession() {
  return { session: null, sessionLoading: false };
}
export const supabaseConfigured = false;
export const supabase = {
  auth: {
    signInWithPassword: async () => ({ data: null, error: null }),
    signOut: async () => ({ error: null }),
  },
};
export function describeAuthError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function normalizePhone(value: string): string {
  return value;
}

// ── Session-state helpers the real lib also exports ─────────────────────────
// eslint-disable-next-line no-restricted-imports
import { stubSessionHelpers } from '../stub-session-helpers';
const sessionHelpers = stubSessionHelpers(() => null);
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
