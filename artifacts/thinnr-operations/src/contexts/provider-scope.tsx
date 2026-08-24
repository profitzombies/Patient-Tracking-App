/**
 * Provider scope for the HQ office drill-in.
 *
 * When a THINNR HQ admin opens one provider account's office dashboard, the
 * existing office screens render inside this provider — scoped to that one
 * account — instead of being duplicated. The office pages read their data
 * through the useScoped* hooks (src/data/scoped-data.ts), which pass the
 * program-wide singletons through untouched when no scope is present, so the
 * standalone office demo stays bit-identical.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { ProviderAccount } from '@/data/hq/accounts';

const ProviderScopeContext = createContext<ProviderAccount | null>(null);

export function ProviderScopeProvider({ account, children }: { account: ProviderAccount; children: ReactNode }) {
  return <ProviderScopeContext.Provider value={account}>{children}</ProviderScopeContext.Provider>;
}

/** The provider account being viewed, or null in the plain office demo. */
export function useProviderScope(): ProviderAccount | null {
  return useContext(ProviderScopeContext);
}
