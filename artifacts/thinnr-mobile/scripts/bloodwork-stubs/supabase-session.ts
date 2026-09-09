let value = {
  session: null as null | { user: { id: string }; access_token: string },
  sessionLoading: false,
};

export function setSession(next: typeof value): void {
  value = next;
}

export function useSupabaseSession() {
  return value;
}