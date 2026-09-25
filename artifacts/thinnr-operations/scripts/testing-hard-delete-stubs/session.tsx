/** Mutable session stand-in for verify-testing-hard-delete.tsx only. */
export const sessionState = {
  authStatus: 'signed-in' as string,
  authRole: 'hq_admin' as string | null,
  hqRole: 'Admin' as string | null,
};
export function useSession() {
  return { ...sessionState, authUser: { id: 'hq-1' } };
}
