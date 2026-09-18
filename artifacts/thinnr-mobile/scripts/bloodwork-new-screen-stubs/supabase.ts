export const state: {
  userId: string;
  token: string | null;
  refreshCalls: number;
  refreshResult: { error: Error | null; data: { session: object | null } };
} = {
  userId: 'user-a',
  token: 'test-access-token',
  refreshCalls: 0,
  refreshResult: { error: null, data: { session: {} } },
};

export function resetSupabase(): void {
  state.userId = 'user-a';
  state.token = 'test-access-token';
  state.refreshCalls = 0;
  state.refreshResult = { error: null, data: { session: {} } };
}

export function useSupabaseSession() {
  return {
    session: state.token
      ? { user: { id: state.userId }, access_token: state.token }
      : null,
  };
}

export const supabase = {
  auth: {
    async refreshSession() {
      state.refreshCalls += 1;
      return state.refreshResult;
    },
  },
};

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
