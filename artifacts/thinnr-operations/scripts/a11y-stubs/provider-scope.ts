/**
 * Swappable stand-in for '@/contexts/provider-scope' used by
 * scripts/verify-training-a11y.tsx (mapped via tsconfig.a11y.json).
 * Null scope = standalone office app (not the HQ drill-in).
 */
import type { ReactNode } from 'react';

let scope: any = null;

export function __setScope(next: unknown) {
  scope = next;
}

export function useProviderScope() {
  return scope;
}

export function ProviderScopeProvider({ children }: { children: ReactNode }) {
  return children;
}
