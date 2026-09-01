/**
 * Controllable supabase stub for the invite-patients suite ONLY (see
 * tsconfig.invite-patients.json). The real module reads import.meta.env at
 * load, which doesn't exist under Node/tsx.
 */

type Session = { access_token: string } | null;

let session: Session = null;
let refreshResult: Session = null;

export const stubCalls = { refreshes: 0 };

export function __setSession(token: string | null): void {
  session = token ? { access_token: token } : null;
}

export function __setRefreshResult(token: string | null): void {
  refreshResult = token ? { access_token: token } : null;
}

export function __resetSupabaseStub(): void {
  session = null;
  refreshResult = null;
  stubCalls.refreshes = 0;
}

export const supabaseConfigured = true;

export const supabase = {
  auth: {
    async getSession() {
      return { data: { session } };
    },
    async refreshSession() {
      stubCalls.refreshes += 1;
      session = refreshResult;
      return { data: { session } };
    },
  },
};
