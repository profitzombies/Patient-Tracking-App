import type { ConnectedAccount } from './billing-types';

/**
 * Where an office's connected Stripe account stands, in the terms the office
 * acts on. Mirrors the API's practice-launch payment state: once the form is
 * submitted (and the account is neither disconnected nor rejected) setup may
 * finish; anything Stripe asks for afterwards is surfaced on the Overview.
 *
 * - not_submitted: the office still has to finish Stripe's form.
 * - reviewing: submitted; Stripe is verifying and has asked for nothing new.
 * - needs_info: submitted, but Stripe has asked for more details since.
 * - enabled: charges and payouts on with nothing due.
 * - rejected / disconnected: cannot be used; only THINNR support can help.
 */
export type StripeConnectStatus = 'none' | 'not_submitted' | 'reviewing' | 'needs_info' | 'enabled' | 'rejected' | 'disconnected';

type AccountFacts = Pick<ConnectedAccount, 'details_submitted' | 'charges_enabled' | 'payouts_enabled' | 'disconnected_at'> & {
  requirements?: Partial<ConnectedAccount['requirements']> | null;
};

/** Stripe disabled reasons that mean the account cannot be used (keep in step with the API). */
export function stripeAccountRejected(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && (reason.startsWith('rejected.') || reason === 'listed' || reason === 'platform_paused');
}

export function stripeConnectStatus(account: AccountFacts | null | undefined): StripeConnectStatus {
  if (!account) return 'none';
  if (account.disconnected_at) return 'disconnected';
  const requirements = account.requirements ?? {};
  const reason = requirements.disabled_reason ?? null;
  if (stripeAccountRejected(reason)) return 'rejected';
  if (!account.details_submitted) return 'not_submitted';
  const due = (requirements.currently_due?.length ?? 0) + (requirements.past_due?.length ?? 0) > 0;
  // A requirements.* reason other than pending verification means Stripe is
  // waiting on the office, even when it has not itemised what yet.
  if (due || (reason && reason.startsWith('requirements.') && reason !== 'requirements.pending_verification')) return 'needs_info';
  if (account.charges_enabled && account.payouts_enabled) return 'enabled';
  return 'reviewing';
}

/** The office has done its part of Stripe's form: setup may continue. */
export function stripeFormSubmitted(account: AccountFacts | null | undefined): boolean {
  const status = stripeConnectStatus(account);
  return status === 'reviewing' || status === 'needs_info' || status === 'enabled';
}
