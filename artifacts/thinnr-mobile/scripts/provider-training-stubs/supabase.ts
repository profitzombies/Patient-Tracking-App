/**
 * Node stand-in for '@/lib/supabase' used by the provider-training suite
 * (see tsconfig.provider-training.json `paths`).
 *
 * The real module creates (or skips) the client from EXPO_PUBLIC_SUPABASE_*
 * env vars at import time. The stub makes that swappable per test case:
 * `setSupabase(null)` exercises the unconfigured state, a fake PostgREST
 * client exercises loading/error/ready. Live ESM bindings mean the hook
 * under test sees every swap.
 */
export let supabase: unknown = null;
export let supabaseConfigured = false;
let session: { user: { id: string } } | null = null;

export function setSupabase(client: unknown): void {
  supabase = client;
  supabaseConfigured = client !== null;
}

/** Mutable authenticated identity for hook-level provider training tests. */
export function setStubSession(userId: string | null): void {
  session = userId ? { user: { id: userId } } : null;
}

export function useSupabaseSession() {
  return { session, sessionLoading: false };
}

// ── Session-state helpers the real lib also exports ─────────────────────────
// eslint-disable-next-line no-restricted-imports
import { stubSessionHelpers } from '../stub-session-helpers';
const sessionHelpers = stubSessionHelpers(() => {
  const client = supabase as { auth?: { getSession?: () => Promise<{ data: { session: { access_token?: string | null } | null } }> } } | null;
  const getSession = client?.auth?.getSession;
  return getSession ? () => getSession.call(client!.auth) : null;
});
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
