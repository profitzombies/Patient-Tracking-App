import { Link } from 'wouter';
import { Clock, ShieldAlert } from 'lucide-react';
import { useOfficeBillingScope, useOfficeBillingStatus } from '@/hooks/use-billing';
import { formatLocalDate } from '@/lib/local-time';
import { stripeConnectStatus } from '@/lib/stripe-connect-status';

/**
 * Overview banner for an office whose Stripe account is submitted but not
 * fully enabled yet: either Stripe is still reviewing it, or Stripe has asked
 * for more since the office finished setup. Only the office's own owners and
 * admins see it (they are the ones who can finish Stripe's steps); demo mode,
 * HQ drill-ins, and fully enabled accounts show nothing.
 */
export function StripeReviewBanner() {
  const { liveEnabled, liveOffice } = useOfficeBillingScope();
  // Only the office's own signed-in staff: no status read in demo or for HQ.
  return liveEnabled && liveOffice === null ? <OfficeStripeReviewBanner /> : null;
}

function OfficeStripeReviewBanner() {
  const { data } = useOfficeBillingStatus();
  if (!data?.viewer.can_manage) return null;
  const status = stripeConnectStatus(data.account);
  if (status !== 'reviewing' && status !== 'needs_info') return null;

  if (status === 'needs_info') {
    const deadline = data.account?.requirements.current_deadline;
    return (
      <div data-testid="banner-stripe-needs-info" role="status"
        className="mb-6 flex flex-col gap-3 rounded-lg border border-warn-border bg-warn-bg px-4 py-3.5 text-sm text-foreground shadow-soft sm:flex-row sm:items-center">
        <ShieldAlert size={17} className="shrink-0 text-warn" aria-hidden="true" />
        <span>
          <b className="text-navy">Stripe needs a few more details from you.</b>{' '}
          Stripe has asked for more information, such as documents or bank details, before it can finish turning on your payments.
          {deadline ? ` Please send them by ${formatLocalDate(deadline)}.` : ''}
        </span>
        <Link href="/payments/get-paid" data-testid="link-stripe-needs-info"
          className="whitespace-nowrap text-xs font-bold text-warn underline underline-offset-4 transition-colors hover:text-navy sm:ml-auto">
          Finish Stripe's steps
        </Link>
      </div>
    );
  }
  return (
    <div data-testid="banner-stripe-reviewing" role="status"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-accent-border bg-accent px-4 py-3.5 text-sm text-foreground shadow-soft sm:flex-row sm:items-center">
      <Clock size={17} className="shrink-0 text-primary" aria-hidden="true" />
      <span>
        <b className="text-navy">Stripe is reviewing your details.</b>{' '}
        There's nothing you need to do right now. {data.account?.charges_enabled
          ? 'Patients can already pay you; payouts to your bank start once Stripe finishes.'
          : 'Patients can pay you once Stripe finishes.'} We'll show you here if Stripe needs anything else.
      </span>
      <Link href="/payments/get-paid" data-testid="link-stripe-reviewing"
        className="whitespace-nowrap text-xs font-bold text-primary underline underline-offset-4 transition-colors hover:text-navy sm:ml-auto">
        View Stripe status
      </Link>
    </div>
  );
}
