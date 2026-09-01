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
