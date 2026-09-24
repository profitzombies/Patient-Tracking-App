/**
 * What an office narrowed for nonpayment sees.
 *
 * Three pieces, kept together because they say the same thing in three
 * places: the route gate that sends a blocked area (menu click OR typed URL)
 * to an explanation, the explanation itself, and the persistent banner above
 * the pages that still work.
 *
 * None of them is a security boundary — the server refuses the blocked
 * surface on its own. They exist so staff are never left tapping into a wall,
 * and so the payment that lifts the restriction is always one click away.
 */
import { AlertCircle, CreditCard } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import type { ReactNode } from 'react';
import { useOfficeAccess } from '@/hooks/use-office-access';
import { isRestrictedOfficePath, useOfficeRestriction } from '@/contexts/office-restriction';
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/patient/heritage';

/** The fallback wording, used until the server's own message arrives. */
export const RESTRICTED_FALLBACK_MESSAGE =
  "This part of THINNR is unavailable until your office's account is paid. "
  + 'Patient subscriptions, payments and patient data export stay open.';

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Blocked areas resolve to the explanation, by menu click or by typed URL.
 * The allowed pages render exactly as they always do.
 */
export function RestrictedRoutes({ children }: { children: ReactNode }) {
  const { restricted } = useOfficeRestriction();
  const [location] = useLocation();
  if (!restricted || isRestrictedOfficePath(location)) return <>{children}</>;
  return <RestrictedAreaScreen />;
}

/**
 * Where a blocked area lands while the office is restricted. Explains the
 * state without scolding, and puts the payment one click away.
 */
export function RestrictedAreaScreen() {
  const restriction = useOfficeRestriction();
  const access = useOfficeAccess();
  const price = money(access.data?.price_cents);
  return (
    <div className="mx-auto max-w-[720px] space-y-5 px-5 py-10 md:px-8">
      <section
        className="rounded-lg border border-card-border bg-card p-6 shadow-soft"
        data-testid="screen-office-restricted"
      >
        <span className="grid h-10 w-10 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
          <AlertCircle size={20} />
        </span>
        <h1 className="mt-4 font-serif text-xl font-bold tracking-[-.01em] text-navy">
          This part of THINNR is paused
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground" data-testid="text-restricted-message">
          {restriction.message ?? RESTRICTED_FALLBACK_MESSAGE}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Nothing has been deleted, and your patients keep using their app. Everything returns the
          moment the account is paid — no call to THINNR needed.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/account" className={`${BTN_PRIMARY} h-10 px-4`} data-testid="link-restricted-pay">
            <CreditCard size={15} aria-hidden="true" />
            Pay now{price ? ` — ${price}` : ''}
          </Link>
          <Link href="/subscriptions" className={`${BTN_SECONDARY} h-10 px-4`} data-testid="link-restricted-open-subscriptions">
            Patient subscriptions
          </Link>
        </div>
      </section>
    </div>
  );
}

/** The persistent banner restricted staff see above every allowed page. */
export function RestrictedBanner() {
  const restriction = useOfficeRestriction();
  if (!restriction.restricted) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e6c9a8] bg-[#fdf4e7] px-4 py-2.5"
      data-testid="banner-office-restricted"
    >
      <p className="text-xs leading-relaxed text-[#7a4a12]">
        {restriction.message ?? RESTRICTED_FALLBACK_MESSAGE}
      </p>
      <Link href="/account" className={`${BTN_PRIMARY} h-8 shrink-0 px-3`} data-testid="link-banner-pay">
        Pay now
      </Link>
    </div>
  );
}
