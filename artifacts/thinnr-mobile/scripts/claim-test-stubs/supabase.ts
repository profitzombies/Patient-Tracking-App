export const TEST_ACCESS_TOKEN = 'designated-patient-token';
export let signOutCalls = 0;
export const signOutScopes: string[] = [];
export const failures = { global: false, globalReturnsError: false, local: false };
const session = { access_token: TEST_ACCESS_TOKEN };

export function resetSignOutCalls() {
  signOutCalls = 0;
  signOutScopes.length = 0;
  failures.global = false;
  failures.globalReturnsError = false;
  failures.local = false;
}

export function useSupabaseSession() {
  return {
    session,
    sessionLoading: false,
  };
}

export const supabase = {
  auth: {
    async signOut(options?: { scope?: string }) {
      signOutCalls += 1;
      const scope = options?.scope ?? 'global';
      signOutScopes.push(scope);
      if (scope === 'global' && failures.global) throw new Error('global signout');
      if (scope === 'global' && failures.globalReturnsError) return { error: new Error('global signout') };
      if (scope === 'local' && failures.local) throw new Error('local signout');
      return { error: null };
    },
  },
};