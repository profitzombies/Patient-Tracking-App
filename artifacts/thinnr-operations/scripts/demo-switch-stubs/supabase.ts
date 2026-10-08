/**
 * Stand-in for '@/lib/supabase' used by scripts/verify-demo-switch.tsx
 * (mapped via tsconfig.demo-switch.json). The real module builds a client
 * from import.meta.env at load, which plain Node lacks. It starts configured
 * with nobody signed in — what a signed-out visitor of the published app
 * meets — and the suite can switch it to unconfigured. Exports are live
 * bindings, so a tree mounted after the switch sees the new values.
 */
const signedOutClient = {
  auth: {
    async getSession() {
      return { data: { session: null }, error: null };
    },
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signOut() {
      return { error: null };
    },
  },
};

export let supabaseConfigured = true;
export let supabase: any = signedOutClient;

export function __setConfigured(next: boolean) {
  supabaseConfigured = next;
  supabase = next ? signedOutClient : null;
}

export function describeAuthError(raw: string): string {
  return raw;
}
