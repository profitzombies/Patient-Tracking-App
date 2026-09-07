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

export function setStubSession(next: StubSession | null): void {
  current = next;
  for (const listener of [...listeners]) listener(next);
}

export const supabaseConfigured = true;

export const supabase = {
  auth: {
    async getSession() {
      return { data: { session: current } };
    },
    /** Sign-out from a screen (consent gate's "Sign out") ends the session for every listener. */
    async signOut() {
      setStubSession(null);
      return { error: null };
    },
  },
};

export function useSupabaseSession(): {
  session: StubSession | null;
  sessionLoading: boolean;
} {
  const [session, setSession] = useState<StubSession | null>(current);
  useEffect(() => {
    const listener = (next: StubSession | null) => setSession(next);
    listeners.add(listener);
    setSession(current); // catch a change between first render and effect
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return { session, sessionLoading: false };
}
