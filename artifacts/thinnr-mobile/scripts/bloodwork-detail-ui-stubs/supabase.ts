export function useSupabaseSession() {
  return { session: { user: { id: 'user-a' }, access_token: 'token-a' } };
}