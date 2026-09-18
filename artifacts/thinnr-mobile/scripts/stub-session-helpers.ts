/**
 * Shared additions for the Node stand-ins of '@/lib/supabase'.
 *
 * The real lib distinguishes a session that is merely waiting on a refresh
 * ("stale": still stored on the phone) from a signed-out state. Suites drive
 * their stubs through an explicit session value, so a stub never holds a
 * stale copy: readStoredSession answers null and every helper reduces to the
 * plain "token or signed out" reading the suites already relied on. Spread
 * `stubSessionHelpers(...)` into a stub's exports to keep it loadable by the
 * modules that import these names.
 */

export const SESSION_RECONNECTING_MESSAGE =
  'Reconnecting to your account. Check your connection and try again.';
export const STALE_SESSION_RETRY_MS = 15_000;

export class SessionReconnectingError extends Error {
  constructor() {
    super(SESSION_RECONNECTING_MESSAGE);
    this.name = 'SessionReconnectingError';
  }
}

export function isSessionReconnectingError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionReconnectingError';
}

export type StubSessionTokenState =
  | { kind: 'token'; token: string }
  | { kind: 'stale' }
  | { kind: 'signedOut' };

type SessionLookup = () => Promise<{ data: { session: { access_token?: string | null } | null } }>;

/** Pass a lazy lookup so stubs whose client is swapped at runtime stay correct. */
export function stubSessionHelpers(getSession: () => SessionLookup | null) {
  return {
    SESSION_RECONNECTING_MESSAGE,
    STALE_SESSION_RETRY_MS,
    SessionReconnectingError,
    isSessionReconnectingError,
    sessionStorageKey: 'sb-stub-auth-token',
    sessionStorageKeyFor: (url: string) => `sb-${url.replace(/^[a-z]+:\/\//i, '').split(/[/:?#.]/)[0]}-auth-token`,
    async readStoredSession() {
      return null;
    },
    async missingTokenMessage(signedOutMessage: string) {
      return signedOutMessage;
    },
    async resolveSessionAccessToken(): Promise<StubSessionTokenState> {
      const lookup = getSession();
      if (!lookup) return { kind: 'signedOut' };
      const { data } = await lookup();
      const token = data.session?.access_token;
      return token ? { kind: 'token', token } : { kind: 'signedOut' };
    },
  };
}
