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

export function setSupabase(client: unknown): void {
  supabase = client;
  supabaseConfigured = client !== null;
}
