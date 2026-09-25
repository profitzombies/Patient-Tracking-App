/**
 * Supabase client for the mobile app — the real front door for patients.
 *
 * Sessions persist in AsyncStorage so the app reopens signed in. When the
 * EXPO_PUBLIC_ vars are absent the client is null and the app runs demo-only;
 * screens check `supabaseConfigured` and say so instead of failing quietly.
 *
 * Phone + password is fully wired but lights up only once Twilio Verify is
 * connected in the Supabase dashboard — until then the server declines and
 * `describeAuthError` turns that into plain words.
 */
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * Where supabase-js persists the session. This is byte-identical to the
 * library's own default (`sb-<project-ref>-auth-token`), spelled out so the
 * app can read the stored session itself (see readStoredSession) without a
 * key change that would sign every installed phone out.
 */
export function sessionStorageKeyFor(url: string): string {
  const host = url.replace(/^[a-z]+:\/\//i, '').split(/[/:?#]/)[0] ?? '';
  return `sb-${host.split('.')[0]}-auth-token`;
}

export const sessionStorageKey: string | null = supabaseUrl ? sessionStorageKeyFor(supabaseUrl) : null;

export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseKey && sessionStorageKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          storage: AsyncStorage,
          storageKey: sessionStorageKey,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      })
    : null;

export const supabaseConfigured = supabase !== null;

// Recommended React Native wiring: only refresh tokens while the app is
// foregrounded. Web tabs handle this themselves.
if (supabase && Platform.OS !== 'web') {
  AppState.addEventListener('change', state => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

/** Re-exported so existing callers keep importing it from here. */
export { normalizePhone } from './phone';

/** Map raw Supabase auth errors to calm, actionable copy. */
export function describeAuthError(error: { message?: string; status?: number } | null): string {
  const raw = (error?.message ?? '').toLowerCase();
  if (raw.includes('invalid login credentials')) {
    return 'That didn’t match an account. Check the details, or create an account below.';
  }
  if (raw.includes('email not confirmed')) {
    return 'Almost there — open the confirmation link we emailed you, then sign in.';
  }
  if (raw.includes('already registered') || raw.includes('already been registered')) {
    return 'An account already exists with those details. Sign in instead.';
  }
  if (raw.includes('password should be')) {
    return 'Passwords need at least 8 characters.';
  }
  if (raw.includes('known to be weak') || raw.includes('easy to guess') || raw.includes('pwned')) {
    return 'That password shows up in lists of leaked passwords — pick something more unique.';
  }
  if (
    raw.includes('phone_provider_disabled') ||
    raw.includes('phone signups are disabled') ||
    raw.includes('phone logins are disabled') ||
    raw.includes('unsupported phone provider') ||
    raw.includes('error sending confirmation sms') ||
    (raw.includes('phone') && raw.includes('disabled')) ||
    (raw.includes('sms') && raw.includes('provider'))
  ) {
    return 'Phone sign-in isn’t switched on yet — text verification is still being connected. Use email for now.';
  }
  if (raw.includes('token has expired') || raw.includes('otp_expired') || raw.includes('invalid otp')) {
    return 'That code didn’t match or has expired. Request a fresh one.';
  }
  if (error?.status === 429 || raw.includes('rate limit') || raw.includes('too many requests')) {
    return 'Too many attempts — give it a minute, then try again.';
  }
  if (raw.includes('failed to fetch') || raw.includes('network')) {
    return 'Couldn’t reach the sign-in service. Check your connection and try again.';
  }
  return error?.message || 'Something went wrong. Try again.';
}

// ── Stored sessions that could not be refreshed yet ──────────────────────────
//
// supabase-js keeps the persisted session through retryable refresh failures
// (offline, GoTrue 5xx, gateway 52x) and only removes it on a definitive
// refusal (revoked or reused refresh token). But once the ACCESS token has
// expired, getSession() and the INITIAL_SESSION event answer `session: null`
// while the refresh keeps failing — indistinguishable from "signed out" to a
// caller that only looks at the session. Every cold start after an hour away
// begins with an expired access token, so a patient opening the app in a
// dead spot would land on the sign-in card and pay for a fresh text-message
// code. The helpers below read the persisted session directly so the app can
// tell "signed in, reconnecting" from "signed out".

/** How often a held stale session asks supabase-js to try the refresh again. */
export const STALE_SESSION_RETRY_MS = 15_000;

function looksLikeSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { access_token?: unknown; refresh_token?: unknown; user?: unknown };
  return (
    typeof candidate.access_token === 'string' &&
    typeof candidate.refresh_token === 'string' &&
    !!candidate.user &&
    typeof candidate.user === 'object'
  );
}

/**
 * The session supabase-js has persisted, whether or not its access token is
 * still valid. Null when nothing is stored (never signed in, signed out, or
 * the refresh token was definitively refused). Storage failures read as
 * null too: the caller then behaves exactly as before this helper existed.
 */
export async function readStoredSession(): Promise<Session | null> {
  if (!sessionStorageKey) return null;
  try {
    const raw = await AsyncStorage.getItem(sessionStorageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return looksLikeSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** What a screen says when the bearer is missing only because a refresh is pending. */
export const SESSION_RECONNECTING_MESSAGE =
  'Reconnecting to your account. Check your connection and try again.';

/**
 * Thrown by strict token getters while a stored session waits on its refresh.
 * Identified by name (not instanceof) so modules that must stay free of the
 * Supabase import can still recognise it.
 */
export class SessionReconnectingError extends Error {
  constructor() {
    super(SESSION_RECONNECTING_MESSAGE);
    this.name = 'SessionReconnectingError';
  }
}

export function isSessionReconnectingError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionReconnectingError';
}

/**
 * The message for a missing bearer: "reconnecting" while a session is still
 * stored on this phone, otherwise the caller's signed-out wording.
 */
export async function missingTokenMessage(signedOutMessage: string): Promise<string> {
  return (await readStoredSession()) ? SESSION_RECONNECTING_MESSAGE : signedOutMessage;
}

export type SessionTokenState =
  /** A usable bearer for the API. */
  | { kind: 'token'; token: string }
  /** Signed in on this phone, but the refresh has not succeeded yet. */
  | { kind: 'stale' }
  /** Nothing stored: the patient is signed out (or sign-in is not configured). */
  | { kind: 'signedOut' };

/**
 * Bearer for API calls, distinguishing a transient refresh failure from a
 * real signed-out state so data fetchers surface "reconnecting" rather than
 * "sign in again".
 */
export async function resolveSessionAccessToken(): Promise<SessionTokenState> {
  if (!supabase) return { kind: 'signedOut' };
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) return { kind: 'token', token };
  return (await readStoredSession()) ? { kind: 'stale' } : { kind: 'signedOut' };
}

export interface SupabaseSessionState {
  /** The live session, or the last persisted one while a refresh is pending. */
  session: Session | null;
  sessionLoading: boolean;
  /**
   * True while `session` is the persisted copy whose access token could not
   * be refreshed yet (offline or auth service trouble). The patient is still
   * signed in on this phone; API calls will fail as network errors until the
   * refresh lands, at which point this flips back to false.
   */
  sessionStale: boolean;
}

/**
 * Live Supabase session for screens that need it. State-only updates inside
 * the auth listener (never call back into supabase there — it deadlocks).
 *
 * Only two things end a held session here: supabase-js reporting SIGNED_OUT
 * (explicit sign-out, security revoke, or a refresh token GoTrue refused
 * outright) or the persisted copy disappearing from storage. A refresh that
 * merely could not reach the server keeps the patient signed in and retries.
 */
export function useSupabaseSession(): SupabaseSessionState {
  const [state, setState] = useState<SupabaseSessionState>({
    session: null,
    sessionLoading: supabaseConfigured,
    sessionStale: false,
  });

  useEffect(() => {
    const client = supabase;
    if (!client) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const live = (session: Session) => {
      if (cancelled) return;
      setState({ session, sessionLoading: false, sessionStale: false });
    };
    const signedOut = () => {
      if (cancelled) return;
      setState({ session: null, sessionLoading: false, sessionStale: false });
    };
    // A null answer is only "signed out" once storage agrees. Otherwise hold
    // the persisted session as stale and keep asking for the refresh; the
    // TOKEN_REFRESHED event (or a SIGNED_OUT after a definitive refusal)
    // settles it.
    const reconcile = async () => {
      const stored = await readStoredSession();
      if (cancelled) return;
      if (!stored) {
        signedOut();
        return;
      }
      setState(prev =>
        prev.session && prev.sessionStale ? prev : { session: stored, sessionLoading: false, sessionStale: true },
      );
      if (retry) clearTimeout(retry);
      retry = setTimeout(() => {
        retry = null;
        if (cancelled) return;
        void client.auth.getSession().then(({ data }) => {
          if (cancelled) return;
          if (data.session) live(data.session);
          else void reconcile();
        });
      }, STALE_SESSION_RETRY_MS);
    };

    void client.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) live(data.session);
      else void reconcile();
    });
    const { data: subscription } = client.auth.onAuthStateChange((event, next) => {
      if (next) {
        live(next);
      } else if (event === 'SIGNED_OUT') {
        signedOut();
      } else {
        // INITIAL_SESSION with no session: same storage check as getSession.
        void reconcile();
      }
    });
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      subscription.subscription.unsubscribe();
    };
  }, []);

  return state;
}
