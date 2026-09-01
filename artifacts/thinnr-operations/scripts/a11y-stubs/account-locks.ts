/**
 * Swappable stand-in for '@/contexts/account-locks' used by the a11y suites
 * (mapped via tsconfig.a11y.json). The real provider reads lock state from
 * the API; the suites just need a settable locked-id set.
 */
import type { ReactNode } from 'react';

let lockedIds = new Set<string>();

export function __setLockedAccounts(ids: string[]) {
  lockedIds = new Set(ids);
}

export function useAccountLocks() {
  return {
    locks: [] as unknown[],
    isLocked: (id: string | null | undefined) => (id ? lockedIds.has(id) : false),
    lockAccount: async () => false,
    unlockAccount: async () => false,
  };
}

export function AccountLocksProvider({ children }: { children: ReactNode }) {
  return children;
}
