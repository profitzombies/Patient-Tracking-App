/**
 * Supabase client for the operations app.
 *
 * Auth uses the publishable key (safe to ship in the browser bundle — row
 * level security guards the data). When the env vars are absent the app
 * still boots: `supabase` is null, the sign-in screen says real auth is
 * unavailable, and the demo bypass keeps working.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** True when real auth is wired up; the demo bypass works either way. */
export const supabaseConfigured = Boolean(url && key);

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url as string, key as string)
  : null;

/** Map raw Supabase auth errors to calm, actionable copy. */
export function describeAuthError(raw: string): string {
  const message = raw.toLowerCase();
  if (message.includes('invalid login credentials')) {
    return 'That email/phone and password combination doesn\u2019t match an account.';
  }
  if (message.includes('email not confirmed')) {
    return 'Almost there \u2014 open the confirmation link we emailed you, then sign in.';
  }
  if (message.includes('user already registered')) {
    return 'That account already exists \u2014 sign in instead.';
  }
  if (message.includes('password should be at least')) {
    return 'Passwords need at least 8 characters.';
  }
  if (message.includes('known to be weak') || message.includes('easy to guess') || message.includes('pwned')) {
    return 'That password shows up in lists of leaked passwords \u2014 pick something more unique.';
  }
  if (
    message.includes('sms') ||
    message.includes('phone provider') ||
    message.includes('unsupported phone') ||
    message.includes('phone_provider') ||
    (message.includes('phone') && (message.includes('disabled') || message.includes('not enabled')))
  ) {
    return 'Text-message verification isn\u2019t switched on yet \u2014 it activates once Twilio Verify is connected in Supabase. Use email for now.';
  }
  if (message.includes('rate limit') || message.includes('too many requests')) {
    return 'Too many attempts \u2014 wait a minute and try again.';
  }
  return raw;
}

/**
 * Best-effort E.164 normalization; ten bare digits are treated as US.
 * Supabase requires the country code, so "+1 (555) 123-4567" → "+15551234567".
 */
export function normalizePhone(input: string): string {
  const compact = input.trim().replace(/[^\d+]/g, '');
  if (compact.startsWith('+')) return '+' + compact.slice(1).replace(/\D/g, '');
  const bare = compact.replace(/\D/g, '');
  if (bare.length === 10) return '+1' + bare;
  if (bare.length === 11 && bare.startsWith('1')) return '+' + bare;
  return bare.length > 0 ? '+' + bare : '';
}
