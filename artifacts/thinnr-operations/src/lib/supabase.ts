/**
 * Supabase client for the operations app.
 *
 * Auth uses the publishable key (safe to ship in the browser bundle — row
 * level security guards the data). When the env vars are absent the app
 * still boots: `supabase` is null and the sign-in screen says real auth is
 * unavailable.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** True when real auth is wired up. */
export const supabaseConfigured = Boolean(url && key);

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url as string, key as string)
  : null;

/** Map raw Supabase auth errors to calm, actionable copy. */
export function describeAuthError(raw: string): string {
  const message = raw.toLowerCase();
  if (message.includes('expired') || message.includes('invalid') || message.includes('not found')) {
    return 'That sign-in link ran out \u2014 request a fresh code and try again.';
  }
  if (message.includes('rate limit') || message.includes('too many requests')) {
    return 'Too many attempts \u2014 wait a minute and try again.';
  }
  return raw;
}
