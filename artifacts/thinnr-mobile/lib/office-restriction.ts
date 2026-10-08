/**
 * Restricted for nonpayment, in the provider app.
 *
 * The narrowed office keeps the surfaces it needs to pay its bill, manage the
 * patient subscriptions that fund it, keep Stripe payouts moving, and take
 * its patient records. Everything else is refused by the server; this policy
 * is the client's copy of the same map, so staff never tap into a wall.
 *
 * It is NOT the account lock and NOT offboarding — those end access entirely
 * and keep their own screens.
 */

/** Non-punitive: what still works and what to do, not what went wrong. */
export const OFFICE_RESTRICTED_STAFF_MESSAGE =
  "This part of THINNR is unavailable until your office's account is paid. " +
  'Patient subscriptions, payments and patient data export stay open.';

/** The office's own THINNR account and payment screen. */
export const OFFICE_ACCESS_ROUTE = '/office-account';

/**
 * Staff routes a restricted office may still open. Session and account
 * plumbing (sign-in, persona, security) stays out of this list on purpose —
 * it is never narrowed, the same way the server leaves it open.
 */
const RESTRICTED_ALLOWED_STAFF_ROUTES = [
  OFFICE_ACCESS_ROUTE,
  '/payments/subscriptions',
  '/payments/payouts',
  '/payments/settings',
  '/payments/get-paid',
];

/** Staff routes that are never narrowed (sign-in, persona switch, security). */
const NEVER_RESTRICTED_ROUTES = [
  '/persona',
  '/provider-login',
  '/patient-welcome',
  '/patient-login',
  '/security',
  '/security-report',
  '/claim-account',
];

/** True when a restricted office may open this staff route. */
export function isRestrictedAllowedStaffRoute(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return [...RESTRICTED_ALLOWED_STAFF_ROUTES, ...NEVER_RESTRICTED_ROUTES].some(
    (allowed) => path === allowed || path.startsWith(`${allowed}/`),
  );
}

export interface StaffRestrictionInput {
  /** Staff mode is the only mode this policy applies to. */
  mode: 'patient' | 'staff' | null;
  /** False until the office's access state is known — never narrow on a guess. */
  restricted: boolean;
  pathname: string;
}

/** Whether this screen must be replaced by the explanation. */
export function staffRouteBlocked(input: StaffRestrictionInput): boolean {
  if (input.mode !== 'staff' || !input.restricted) return false;
  return !isRestrictedAllowedStaffRoute(input.pathname);
}
