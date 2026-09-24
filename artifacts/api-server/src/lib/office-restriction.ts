/**
 * Restricted for nonpayment — an office lifecycle state of its own.
 *
 * It is NOT the THINNR account lock and NOT offboarding. Those end portal
 * access entirely and keep their exact meanings (`officeIsActive`, the lock
 * notice, the offboarded message) untouched. A restricted office is *narrowed*
 * instead: its patients are mid-program and still need the product, so the
 * office keeps only the surfaces it needs to pay its bill, manage the patient
 * subscriptions that fund it, and take its patient records with it.
 *
 * The state itself belongs to the access-billing engine: a restriction starts
 * when the recovery window closes with no successful payment and ends the
 * moment a payment lands. Nothing here decides it — this module reads it and
 * names what survives it, once, for every route.
 */
import { getBillingModeStatus } from "../billing/mode-state";
import { accessIsRestricted } from "../billing/office-access/state";
import { findAccessSubscription } from "../billing/office-access/subscription";
import { currentBillingIdentity, runWithBillingIdentity } from "../billing/stripe-environment";

/** Non-punitive: it says what still works and what to do, not what went wrong. */
export const OFFICE_RESTRICTED_STAFF_MESSAGE =
  "This part of THINNR is unavailable until your office's account is paid. " +
  "Patient subscriptions, payments and patient data export stay open.";

/** The one list of what an office keeps while restricted. */
export const OFFICE_RESTRICTED_CAPABILITIES = [
  /** The office's own THINNR access: what is owed, and paying it. */
  "office_access_billing",
  /** The patient subscription list and its management actions. */
  "patient_subscriptions",
  /** Stripe payouts and the connected-account pages. */
  "payouts_and_connect",
  /** Patient data export. */
  "patient_data_export",
] as const;

export type OfficeRestrictedCapability = (typeof OFFICE_RESTRICTED_CAPABILITIES)[number];

/**
 * Server-side truth for the narrowed surface, keyed on the request path so
 * every office-scoped route inherits it from the shared scope resolver
 * instead of deciding for itself.
 *
 * Session and account plumbing (sign-in, security, claim) stays open for the
 * same reason the launch gate leaves it open: a staffer must still be able to
 * sign in, prove a fresh code, and reach the screens that explain the state.
 */
const RESTRICTED_ALLOWED_PATHS: RegExp[] = [
  /^\/office\/access(?:\/|$)/,
  /^\/billing\/office\/status(?:\/|$)/,
  /^\/billing\/office\/connect(?:\/|$)/,
  /^\/billing\/oauth(?:\/|$)/,
  /^\/billing\/office\/payouts(?:\/|$)/,
  /^\/billing\/office\/subscriptions(?:\/|$)/,
  /^\/exports(?:\/|$)/,
  /^\/(?:security|staff-session|auth|claim)(?:\/|$)/,
];

/** True for the requests a restricted office may still make. */
export function isRestrictedAllowedPath(url: string): boolean {
  const path = url.split("?")[0].replace(/^\/api/, "");
  return RESTRICTED_ALLOWED_PATHS.some((allowed) => allowed.test(path));
}

/**
 * Whether this office is restricted for nonpayment right now.
 *
 * Derived from the subscription row's dates (never the cached state column),
 * so recovery lifts the restriction on the very next request with no HQ
 * action. An office with no access subscription row was never billed and is
 * never restricted.
 *
 * A failure reading the engine is not a restriction: narrowing an office that
 * has paid would be far worse than briefly missing one that has not, and the
 * charge path enforces the share independently.
 */
export async function officeRestrictedForNonpayment(providerId: string, now = new Date()): Promise<boolean> {
  try {
    const row = await accessSubscription(providerId);
    return row ? accessIsRestricted(row, now) : false;
  } catch {
    return false;
  }
}

/**
 * The office's access subscription, read from the right Stripe scope.
 *
 * Most callers of this policy are not billing routes — the office scope
 * resolver, the patient care-team thread — so no identity is pinned on the
 * request. The subscription table is scope-isolated like every other
 * Stripe-derived table, so those callers resolve the workspace's selected
 * scope first rather than reading across scopes.
 */
async function accessSubscription(providerId: string) {
  if (currentBillingIdentity()) return findAccessSubscription(providerId);
  const selected = await getBillingModeStatus();
  return runWithBillingIdentity(
    { mode: selected.mode, platformAccountId: selected.platformAccountId },
    () => findAccessSubscription(providerId),
  );
}
