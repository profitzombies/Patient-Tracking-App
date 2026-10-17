/**
 * App-access entitlement seam — whether the signed-in patient's premium AI
 * features (coach, photo/menu reads, barcode lookup) are available, plus
 * the one upgrade sheet every locked entry point opens.
 *
 * The DEFAULT value is "unknown, unlocked, no-op": trees that render
 * without AppAccessProvider (Node suites, previews, demo/signed-out
 * sessions) behave exactly as before the lock existed. The root layout
 * mounts AppAccessProvider (./AppAccessProvider.tsx) to swap in the live
 * reader for real accounts.
 *
 * Dependency-light on purpose — react plus erased type imports only — so
 * the coach context, tab bar and scan screens can import it under every
 * suite's stub map.
 */
import { createContext, useContext } from 'react';
import type { AppAccessEntitlement, PatientAppAccess } from '@/lib/app-access';

export interface AppAccessState {
  /** The last server answer for this account; null while unknown or not applicable. */
  access: PatientAppAccess | null;
  /** True only when the server said the premium features are locked. */
  locked: boolean;
  /** Re-reads the entitlement (no-op without a real account). */
  refresh: () => Promise<void>;
  /** Shows the upgrade sheet (price, what comes back, open checkout). */
  openUpgradeSheet: () => void;
  /**
   * A premium request answered 402 upgrade-required: lock now with the
   * attached entitlement (stale local state must never win over the
   * server), open the sheet, and re-read for the checkout link.
   */
  reportUpgradeRequired: (entitlement: AppAccessEntitlement | null) => void;
}

export const DEFAULT_APP_ACCESS_STATE: AppAccessState = {
  access: null,
  locked: false,
  refresh: async () => {},
  openUpgradeSheet: () => {},
  reportUpgradeRequired: () => {},
};

export const AppAccessContext = createContext<AppAccessState>(DEFAULT_APP_ACCESS_STATE);

export function useAppAccess(): AppAccessState {
  return useContext(AppAccessContext);
}
