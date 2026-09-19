/**
 * Money and status formatting shared by every payments screen. Money is
 * integer cents on the wire; dollars exist only here and in price inputs.
 */
import type { CadenceWeeks, FulfillmentStatus, OfficeDashboard, OrderKind, OrderStatus, ProductCategory, SubscriptionStatus, WarehouseSubmission } from '@/lib/office-billing-types';

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

/**
 * Detail line under the live MRR tile — the same wording the office web
 * Overview uses: the active-subscription count, or why there is none yet.
 */
export function mrrHint(data: Pick<OfficeDashboard, 'account_connected' | 'active_subscriptions'>): string {
  if (!data.account_connected) return 'Payments not connected yet';
  const active = data.active_subscriptions;
  if (active === 0) return 'No active subscriptions';
  return `${active} active subscription${active === 1 ? '' : 's'}`;
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
  past_due: 'Payment failed',
  canceled: 'Canceled',
  unpaid: 'Payment failed',
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

const preciseFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

/** Audit-grade timestamp, to the second: "Sep 14, 2026, 3:04:09 PM". */
export function formatPreciseDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : preciseFormatter.format(date);
}

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


export const PRODUCT_CATEGORY_LABEL: Record<ProductCategory, string> = {
  drops: 'Drops',
  supplement: 'Supplement',
  bundle: 'Bundle',
};
export const CADENCE_LABEL: Record<CadenceWeeks, string> = {
  2: 'Every 2 weeks',
  4: 'Every 4 weeks',
  6: 'Every 6 weeks',
  8: 'Every 8 weeks',
  10: 'Every 10 weeks',
  12: 'Every 12 weeks',
};
/** "Every 2, 4 or 8 weeks · default 4" for list rows and office screens. */
export function cadenceSummary(offered: readonly CadenceWeeks[], fallback: CadenceWeeks): string {
  if (offered.length === 1) return `Every ${offered[0]} weeks`;
  const head = offered.slice(0, -1).join(', ');
  return `Every ${head} or ${offered[offered.length - 1]} weeks · default ${fallback}`;
}

/** Provider-facing wording for the WarehouseCraft state of a paid order (read-only on the phone). */
export const WAREHOUSE_STATE_LABEL: Record<WarehouseSubmission['state'], string> = {
  pending: 'Sending to warehouse',
  sent: 'Sent to warehouse',
  needs_attention: 'Needs attention',
  skipped: 'Not sent to warehouse',
};

export function warehouseTone(state: WarehouseSubmission['state']): PillTone {
  return state === 'sent' ? 'good' : state === 'needs_attention' ? 'bad' : state === 'pending' ? 'info' : 'neutral';
}

/** The queue line under a waiting order: where it actually is right now. */
export function warehouseWaitingLine(warehouse: WarehouseSubmission | null | undefined): string {
  if (!warehouse || warehouse.state === 'pending' || warehouse.state === 'skipped') return 'Waiting for THINNR to pack and ship.';
  if (warehouse.state === 'sent') {
    const id = warehouse.warehouse_order_id ? ` (warehouse order ${warehouse.warehouse_order_id})` : '';
    return `Sent to the warehouse ${formatDateTime(warehouse.sent_at)}${id}.`;
  }
  return 'The warehouse could not accept this order yet; THINNR HQ is fixing it.';
}
