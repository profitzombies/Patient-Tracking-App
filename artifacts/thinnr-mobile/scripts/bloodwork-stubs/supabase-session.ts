let value = {
  session: null as null | { user: { id: string }; access_token: string },
  sessionLoading: false,
};

export function setSession(next: typeof value): void {
  value = next;
}

export function useSupabaseSession() {
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
