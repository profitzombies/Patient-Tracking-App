export function useSupabaseSession() {
  return { session: null, sessionLoading: false };
}
export const supabaseConfigured = false;
export const supabase = {
  auth: {
    signInWithPassword: async () => ({ data: null, error: null }),
    signOut: async () => ({ error: null }),
  },
};
export function describeAuthError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function normalizePhone(value: string): string {
  return value;
}