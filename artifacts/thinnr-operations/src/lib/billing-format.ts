/**
 * Money and status formatting shared by every payments screen. Money is
 * integer cents on the wire; dollars exist only here and in price inputs.
 */
import type { FulfillmentStatus, OrderKind, OrderStatus, SubscriptionStatus } from '@/lib/billing-types';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatCents(cents: number | null | undefined, options?: { signed?: boolean; blank?: string }): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return options?.blank ?? '—';
  const text = usd.format(Math.abs(cents) / 100);
  if (cents < 0) return `−${text}`;
  return options?.signed && cents > 0 ? `+${text}` : text;
}

/** "59.99" → 5999; rejects blanks, negatives, and more than two decimals. */
export function parseDollarsToCents(input: string): { ok: true; cents: number } | { ok: false; error: string } {
  const trimmed = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!trimmed) return { ok: false, error: 'Enter an amount.' };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { ok: false, error: 'Use dollars and cents, like 59.99.' };
  const [whole, fraction = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 0) return { ok: false, error: 'Enter a valid amount.' };
  return { ok: true, cents };
}

export function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Pending',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
  disputed: 'Disputed',
  canceled: 'Canceled',
};

export const ORDER_KIND_LABEL: Record<OrderKind, string> = {
  one_time: 'One-time',
  subscription_initial: 'Subscription (first order)',
  subscription_renewal: 'Subscription renewal',
};

export const FULFILLMENT_LABEL: Record<FulfillmentStatus, string> = {
  to_ship: 'To ship',
  shipped: 'Shipped',
  canceled: 'Canceled',
};

export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  incomplete: 'Awaiting payment',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
  unpaid: 'Unpaid',
};

export type PillTone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export function orderStatusTone(status: OrderStatus): PillTone {
  switch (status) {
    case 'paid':
      return 'good';
    case 'pending':
      return 'info';
    case 'failed':
    case 'disputed':
      return 'bad';
    case 'refunded':
    case 'partially_refunded':
    case 'canceled':
      return 'warn';
  }
}

export function fulfillmentTone(status: FulfillmentStatus): PillTone {
  return status === 'shipped' ? 'good' : status === 'canceled' ? 'neutral' : 'warn';
}

export function subscriptionTone(status: SubscriptionStatus): PillTone {
  switch (status) {
    case 'active':
      return 'good';
    case 'incomplete':
      return 'info';
    case 'past_due':
    case 'unpaid':
      return 'bad';
    case 'canceled':
      return 'neutral';
  }
}

export function accountStatusLabel(account: {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements: { currently_due: string[]; past_due: string[]; disabled_reason: string | null };
  disconnected_at: string | null;
} | null): { label: string; tone: PillTone } {
  if (!account) return { label: 'Not set up', tone: 'neutral' };
  if (account.disconnected_at) return { label: 'Disconnected', tone: 'bad' };
  if (account.requirements.disabled_reason) return { label: 'Restricted', tone: 'bad' };
  if (account.requirements.past_due.length > 0) return { label: 'Action overdue', tone: 'bad' };
  if (account.charges_enabled && account.payouts_enabled) {
    return account.requirements.currently_due.length > 0
      ? { label: 'Active, info needed', tone: 'warn' }
      : { label: 'Active', tone: 'good' };
  }
  if (account.charges_enabled) return { label: 'Charges on, payouts pending', tone: 'warn' };
  if (account.details_submitted) return { label: 'Under review', tone: 'info' };
  return { label: 'Setup incomplete', tone: 'warn' };
}

const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormatter.format(date);
}

/** Requirement keys from Stripe ("individual.verification.document") → readable. */
export function humanizeRequirement(key: string): string {
  return key
    .replace(/^individual\./, 'Owner ')
    .replace(/^company\./, 'Business ')
    .replace(/^business_profile\./, 'Business profile ')
    .replace(/^external_account$/, 'Bank account')
    .replace(/^tos_acceptance\./, 'Terms of service ')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}
