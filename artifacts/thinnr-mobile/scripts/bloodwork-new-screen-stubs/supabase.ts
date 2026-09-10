export const state: {
  userId: string;
  token: string | null;
  refreshCalls: number;
  refreshResult: { error: Error | null; data: { session: object | null } };
} = {
  userId: 'user-a',
  token: 'test-access-token',
  refreshCalls: 0,
  refreshResult: { error: null, data: { session: {} } },
};

export function resetSupabase(): void {
  state.userId = 'user-a';
  state.token = 'test-access-token';
  state.refreshCalls = 0;
  state.refreshResult = { error: null, data: { session: {} } };
}

export function useSupabaseSession() {
  return {
    session: state.token
      ? { user: { id: state.userId }, access_token: state.token }
      : null,
  };
}

export const supabase = {
  auth: {
    async refreshSession() {
      state.refreshCalls += 1;
      return state.refreshResult;
    },
  },
};