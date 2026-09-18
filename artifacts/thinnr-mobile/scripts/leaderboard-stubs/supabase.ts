/**
 * Node stand-in for '@/lib/supabase' used by the leaderboard suite (see
 * tsconfig.leaderboard.json `paths`).
 *
 * useSupabaseSession is a real hook subscribed to a scripted session emitter
 * (setStubSession inside act()), with optional cold-start "loading" ticks so
 * the suite can prove the tab never treats a resolving session as signed
 * out. supabase.auth.getSession() hands lib/office-roster-api the bearer;
 * refreshSession() returns whatever the suite scripted (null by default) so
 * the 401 → refresh → retry hop is inert.
 */
import { useEffect, useState } from 'react';

export interface StubSession {
  access_token: string;
  user: { id: string };
}

let current: StubSession | null = null;
let refreshResult: StubSession | null = null;
const listeners = new Set<(next: StubSession | null) => void>();

export function setStubSession(next: StubSession | null): void {
  current = next;
  for (const listener of [...listeners]) listener(next);
}

export function setStubRefreshResult(next: StubSession | null): void {
  refreshResult = next;
}

export const supabaseConfigured = true;

export const supabase = {
  auth: {
    async getSession() {
      return { data: { session: current } };
    },
    async refreshSession() {
      current = refreshResult;
      return { data: { session: current } };
    },
  },
};

let loadingTicks = 0;
export function setStubSessionLoadingTicks(ticks: number): void {
  loadingTicks = ticks;
}

export function useSupabaseSession(): { session: StubSession | null; sessionLoading: boolean } {
  const [session, setSession] = useState<StubSession | null>(current);
  const [loading, setLoading] = useState(loadingTicks > 0);
  useEffect(() => {
    const listener = (next: StubSession | null) => setSession(next);
    listeners.add(listener);
    setSession(current);
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
