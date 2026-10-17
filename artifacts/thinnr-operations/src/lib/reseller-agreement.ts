/**
 * The reseller agreement date on an HQ account, and where it puts the start
 * of billing.
 *
 * Leadership expects a THINNR reseller's access billing to begin one reseller
 * included period (the organization's setting, 365 days by default) after the
 * office signs its reseller agreement — not after the owner happens to first
 * sign in. HQ records the date on the account; the server anchors the office's
 * included period to it. This module only turns the date into the words the
 * Add Account form, the account page and the access card show next to it.
 */
import { getGetHqSettingsQueryKey, useGetHqSettings } from '@workspace/api-client-react';
import { useSession } from '@/contexts/session';

const DAY_MS = 86_400_000;
/** The organization default when the live setting has not loaded (or cannot be read). */
export const DEFAULT_RESELLER_INCLUDED_PERIOD_DAYS = 365;

/** A calendar date (`YYYY-MM-DD`) as the UTC midnight that starts it; null for anything else. */
export function agreementDateAt(signedOn: string | null | undefined): Date | null {
  if (!signedOn || !/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) return null;
  const at = new Date(`${signedOn}T00:00:00.000Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === signedOn ? at : null;
}

/** The day billing starts for an agreement signed on `signedOn`: the date plus the reseller period. */
export function billingStartsAt(signedOn: string | null | undefined, includedPeriodDays: number): Date | null {
  const at = agreementDateAt(signedOn);
  return at ? new Date(at.getTime() + includedPeriodDays * DAY_MS) : null;
}

/** Today as the `YYYY-MM-DD` the date input's `max` wants (the HQ user's own calendar day). */
export function todayIsoDate(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** A calendar date as HQ reads it ("Jan 15, 2026"), never shifted by the browser's time zone. */
export function formatCalendarDate(signedOn: string | null | undefined): string {
  const at = agreementDateAt(signedOn);
  return at ? at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
}

/** An instant as the calendar day it falls on in UTC — the agreement math is UTC-day based. */
export function formatUtcDay(at: Date | string | null | undefined): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  if (!date || !Number.isFinite(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * One sentence for the "Billing starts" line beside the date field: the
 * computed day, or that it already passed (the office is billed at the next
 * pass once its payment setup is complete — never restricted on day one).
 */
export function describeBillingStart(signedOn: string | null | undefined, includedPeriodDays: number, now: Date = new Date()): string | null {
  const starts = billingStartsAt(signedOn, includedPeriodDays);
  if (!starts) return null;
  const day = formatUtcDay(starts);
  return starts.getTime() <= now.getTime()
    ? `Billing starts ${day} — already passed, so the first charge runs at the next billing pass once payment setup is complete.`
    : `Billing starts ${day} (${includedPeriodDays} days after the agreement).`;
}

/**
 * The organization's reseller included period, for the HQ admins who can
 * manage accounts (the same role the settings read needs). Falls back to the
 * default while loading or when the setting cannot be read, and says so.
 */
export function useResellerIncludedPeriodDays(): { days: number; confirmed: boolean } {
  const { authStatus, hqRole, authUser } = useSession();
  const enabled = authStatus === 'signed-in' && (hqRole === 'Admin' || hqRole === 'Super Admin');
  const { data } = useGetHqSettings({
    query: { enabled, queryKey: [...getGetHqSettingsQueryKey(), authUser?.id], staleTime: 5 * 60_000 },
  });
  const days = data?.accessBilling?.includedPeriodDays;
  return typeof days === 'number' && Number.isFinite(days) && days >= 0
    ? { days, confirmed: true }
    : { days: DEFAULT_RESELLER_INCLUDED_PERIOD_DAYS, confirmed: false };
}
