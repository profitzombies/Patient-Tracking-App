/**
 * Node stand-in for @/lib/supabase (see tsconfig.live-diary.json `paths`).
 *
 * The live-diary suite drives sign-in, sign-out, and account switches by
 * pushing scripted sessions through setStubSession; useSupabaseSession is a
 * real hook subscribed to that emitter so PatientAccountProvider reacts
 * exactly as it would to GoTrue's onAuthStateChange. supabase.auth
 * .getSession() hands lib/patient-data-api the current access token for its
 * bearer headers. Call setStubSession inside act() — it triggers renders.
 */
import { useEffect, useState } from 'react';

export interface StubSession {
  access_token: string;
  user: { id: string };
}

let current: StubSession | null = null;
const listeners = new Set<(next: StubSession | null) => void>();
let nextSessionGate: Promise<void> | null = null;
let releaseNextSessionGate: (() => void) | null = null;
let sessionLookupsToSkip = 0;
let rejectNextSessionLookup = false;

/** Holds the next token lookup so account-switch races can be exercised. */
export function holdNextStubSessionLookup(afterLookups = 0): () => void {
  sessionLookupsToSkip = afterLookups;
  nextSessionGate = new Promise<void>(resolve => {
    releaseNextSessionGate = resolve;
  });
  return () => {
    releaseNextSessionGate?.();
    releaseNextSessionGate = null;
  };
}

export function rejectNextStubSessionLookup(): void {
  rejectNextSessionLookup = true;
}

export function setStubSession(next: StubSession | null): void {
  current = next;
  for (const listener of [...listeners]) listener(next);
}

export const supabaseConfigured = true;

export const supabase = {
  auth: {
    async getSession() {
      if (rejectNextSessionLookup) {
        rejectNextSessionLookup = false;
        throw new Error('session lookup failed once');
      }
      if (sessionLookupsToSkip > 0) {
        sessionLookupsToSkip -= 1;
        return { data: { session: current } };
      }
      const gate = nextSessionGate;
      if (gate) {
        nextSessionGate = null;
        await gate;
      }
      return { data: { session: current } };
    },
    /** Sign-out from a screen (consent gate's "Sign out") ends the session for every listener. */
    async signOut(_options?: { scope?: 'global' | 'local' | 'others' }) {
      setStubSession(null);
      return { error: null };
    },
  },
};

/**
 * Optional cold-start emulation: while > 0, the hook reports a loading
 * session with no user for that many renders' worth of effect ticks before
 * settling on the real stub session (the real hook does exactly this while
 * AsyncStorage is read). Suites use it to prove nothing treats "loading" as
 * "signed out".
 */
let loadingTicks = 0;
export function setStubSessionLoadingTicks(ticks: number): void {
  loadingTicks = ticks;
}

export function useSupabaseSession(): {
  session: StubSession | null;
  sessionLoading: boolean;
} {
  const [session, setSession] = useState<StubSession | null>(current);
  const [loading, setLoading] = useState(loadingTicks > 0);
  useEffect(() => {
    const listener = (next: StubSession | null) => setSession(next);
    listeners.add(listener);
    setSession(current); // catch a change between first render and effect
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      loadingTicks = 0;
      setLoading(false);
    }, 5);
    return () => clearTimeout(timer);
  }, [loading]);
  return loading ? { session: null, sessionLoading: true } : { session, sessionLoading: false };
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
