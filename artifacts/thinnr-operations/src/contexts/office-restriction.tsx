/**
 * Is this office narrowed for nonpayment, and what may it still reach?
 *
 * The server decides — every office-scoped request is refused by the shared
 * scope resolver unless it falls inside the narrowed surface. This context is
 * the client's copy of that answer: it hides what cannot be used, sends direct
 * URL attempts to an explanation, and keeps the pay action one click away.
 *
 * It is NOT the account lock (which ends portal access) and NOT offboarding.
 * Those keep their own screens and their own meanings.
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface OfficeRestriction {
  restricted: boolean;
  /** The non-punitive explanation the server sends with the refusal. */
  message: string | null;
}

const OfficeRestrictionContext = createContext<OfficeRestriction>({ restricted: false, message: null });

export function OfficeRestrictionProvider(
  { value, children }: { value: OfficeRestriction; children: ReactNode },
) {
  return <OfficeRestrictionContext.Provider value={value}>{children}</OfficeRestrictionContext.Provider>;
}

export function useOfficeRestriction(): OfficeRestriction {
  return useContext(OfficeRestrictionContext);
}

/**
 * The office paths that survive the narrowing, mirroring the server's list:
 * the office's own account and payment pages, patient subscriptions, Stripe
 * payouts and connection, and patient data export (which lives on the account
 * page while the rest of the workspace is closed).
 *
 * `/security` stays reachable for the same reason the server leaves it open —
 * a staffer must still be able to manage their own sign-in.
 */
export const RESTRICTED_OFFICE_PATHS = [
  '/account',
  '/subscriptions',
  '/payments/subscriptions',
  '/payments/payouts',
  '/payments/settings',
  '/payments/get-paid',
  '/security',
] as const;

/** True when a restricted office may open this location. */
export function isRestrictedOfficePath(location: string): boolean {
  return RESTRICTED_OFFICE_PATHS.some((path) => location === path || location.startsWith(`${path}/`));
}
