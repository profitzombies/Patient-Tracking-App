/**
 * Swappable stand-in for '@/contexts/hq-data' used by the a11y suites
 * (mapped via tsconfig.a11y.json). The real provider fetches the live
 * directory through Supabase-backed queries; the suites just need a
 * controllable in-memory account list.
 */
import type { ReactNode } from 'react';

let value: any = {
  accounts: [],
  accountsStatus: 'ready',
  accountsError: null,
  addAccount: async () => {
    throw new Error('addAccount is not available in the a11y suite');
  },
  findAccount: (id: string | undefined) => value.accounts.find((account: any) => account.id === id),
  settingsValues: {},
};

export function __setHqData(next: Record<string, unknown>) {
  value = { ...value, ...next };
}

export function useHqData() {
  return value;
}

export function HqDataProvider({ children }: { children: ReactNode }) {
  return children;
}
