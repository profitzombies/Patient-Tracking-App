import type { ReactNode } from 'react';
import { PANEL_LABEL } from '@/components/patient/heritage';
import { StatusPill } from '@/components/billing/primitives';
import { formatDateTime } from '@/lib/billing-format';
import type { ConnectedAccount, StripeCustomerEmailsState } from '@/lib/billing-types';

/**
 * Connection-health check for Stripe's own customer emails. THINNR sends
 * every receipt, shipping, and subscription email itself, so the healthy
 * state is "off". Accounts THINNR creates have no Stripe Dashboard and can
 * never turn them on; an office that connected its own Stripe account keeps
 * an "unverified" warning until HQ confirms the Dashboard setting.
 */
export function customerEmailsLabel(state: StripeCustomerEmailsState): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (state === 'off') return { label: 'Off (THINNR sends them)', tone: 'good' };
  if (state === 'on') return { label: 'On in Stripe', tone: 'bad' };
  return { label: 'Not verified', tone: 'warn' };
}

export function StripeCustomerEmailsFlag({ account }: { account: Pick<ConnectedAccount, 'stripe_customer_emails'> }) {
  const chip = customerEmailsLabel(account.stripe_customer_emails);
  return (
    <div>
      <p className={PANEL_LABEL}>Stripe emails</p>
      <StatusPill tone={chip.tone} testId="stripe-customer-emails">{chip.label}</StatusPill>
    </div>
  );
}

/** Explanatory row shown when the account is anything but confirmed off. */
export function StripeCustomerEmailsNotice({ account, action }: { account: ConnectedAccount; action?: ReactNode }) {
  if (account.stripe_customer_emails === 'off') return null;
  const on = account.stripe_customer_emails === 'on';
  return (
    <div
      role="status"
      data-testid="stripe-customer-emails-notice"
      className={`flex flex-col gap-2 rounded-xl border px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between ${on ? 'border-red-300 bg-red-50 text-red-950' : 'border-amber-300 bg-amber-50 text-navy'}`}
    >
      <div className="min-w-0">
        <p className="font-semibold">{on ? 'Stripe is emailing your customers.' : 'Confirm Stripe’s customer emails are off.'}</p>
        <p className="mt-0.5">
          {account.stripe_customer_emails_note ??
            'THINNR sends every receipt and subscription email; Stripe’s own customer emails should stay off in the Stripe Dashboard.'}
          {account.stripe_customer_emails_checked_at ? ` Last checked ${formatDateTime(account.stripe_customer_emails_checked_at)}.` : ''}
        </p>
      </div>
      {action}
    </div>
  );
}
