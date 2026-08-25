/**
 * Swappable stand-in for '@/contexts/session' used by
 * scripts/verify-training-a11y.tsx (mapped via tsconfig.a11y.json).
 * The real module reads import.meta.env / Supabase; the suite just needs
 * to pose as a signed-in provider staffer or the anonymous demo persona.
 */
import type { ReactNode } from 'react';

let session: any = {
  authStatus: 'signed-out',
  authRole: null,
  providerAccountCode: null,
};

export function __setSession(next: Record<string, unknown>) {
  session = { ...session, ...next };
}

export function useSession() {
  return session;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  return children;
}
