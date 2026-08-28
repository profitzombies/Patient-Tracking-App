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

export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          storage: AsyncStorage,
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

/**
 * Normalize a user-typed phone number to E.164. Ten digits are treated as US.
 * Returns '' when the input can't be a dialable number.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
}

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

/**
 * Live Supabase session for screens that need it. State-only updates inside
 * the auth listener (never call back into supabase there — it deadlocks).
 */
export function useSupabaseSession(): { session: Session | null; sessionLoading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState<boolean>(supabaseConfigured);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setSessionLoading(false);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setSessionLoading(false);
    });
    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return { session, sessionLoading };
}
