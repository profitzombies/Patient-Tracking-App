/**
 * Account & billing — the office's own THINNR access.
 *
 * Two jobs:
 *   * Show what the office owes and let ANY staff member pay it. Nonpayment
 *     is not an owner-only problem, so the pay action is never role-gated.
 *   * Stay usable while the workspace is narrowed for nonpayment. This page,
 *     patient subscriptions, Stripe payouts/connection, and patient data
 *     export are what a restricted office keeps — so the export panel lives
 *     here too, where it is reachable with the rest of the workspace closed.
 */
import { CreditCard, Loader2 } from 'lucide-react';
import { Link } from 'wouter';
import { useMemo } from 'react';
import { useSession } from '@/contexts/session';
import { useProviderScope } from '@/contexts/provider-scope';
import { useOfficeAccess, usePayOfficeAccess, type OfficeAccessState } from '@/hooks/use-office-access';
import { useOfficeRestriction } from '@/contexts/office-restriction';
import { BTN_PRIMARY, BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';
import { ExportsPanel, type ExportOfficeOption } from '@/components/exports/ExportsPanel';

function money(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function day(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATE_LABELS: Record<string, string> = {
  included: 'Included period',
  active: 'Paid and active',
  grace: 'Payment overdue',
  restricted: 'Access narrowed for nonpayment',
  cancelled: 'Cancelled',
};

/** The pay-now card: status, what is owed, and the button any staffer may press. */
export function OfficeAccessCard({ access }: { access: OfficeAccessState | undefined }) {
  const pay = usePayOfficeAccess();
  const result = pay.data;
  return (
    <SectionCard
      title="THINNR access"
      sub="Your office's subscription to the THINNR platform."
      action={
        <button
          type="button"
          className={`${BTN_PRIMARY} h-9 px-3.5`}
          onClick={() => pay.mutate()}
          disabled={pay.isPending}
          data-testid="button-pay-office-access"
        >
          {pay.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <CreditCard size={14} aria-hidden="true" />}
          {pay.isPending ? 'Charging…' : 'Pay now'}
        </button>
      }
    >
      <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="mt-0.5 font-semibold text-foreground" data-testid="text-access-state">
            {access?.state ? STATE_LABELS[access.state] ?? access.state : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Amount</dt>
          <dd className="mt-0.5 font-semibold text-foreground" data-testid="text-access-price">
            {access?.lifetime ? 'Lifetime access' : money(access?.price_cents ?? null)}
            {access?.plan && !access.lifetime ? ` / ${access.plan === 'yearly' ? 'year' : 'month'}` : ''}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Paid through</dt>
          <dd className="mt-0.5 text-foreground">{day(access?.paid_through ?? null)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Recovery window ends</dt>
          <dd className="mt-0.5 text-foreground">{day(access?.grace_ends_at ?? null)}</dd>
        </div>
      </dl>
      {pay.isError && (
        <p role="alert" className="border-t border-border px-5 py-3 text-xs text-destructive" data-testid="text-pay-error">
          {pay.error instanceof Error ? pay.error.message : 'That payment could not be started.'}
        </p>
      )}
      {result?.paid && (
        <p role="status" className="border-t border-border px-5 py-3 text-xs text-foreground" data-testid="text-pay-success">
          Payment received — full access is restored.
        </p>
      )}
      {result?.pending && (
        <p role="status" className="border-t border-border px-5 py-3 text-xs text-foreground" data-testid="text-pay-pending">
          Your payment is processing. Access opens as soon as it settles.
        </p>
      )}
    </SectionCard>
  );
}

export default function OfficeAccess() {
  const access = useOfficeAccess();
  const scope = useProviderScope();
  const { claimedWorkspace } = useSession();
  const restriction = useOfficeRestriction();
  const pinnedOffice: ExportOfficeOption = useMemo(
    () => (scope
      ? { id: scope.providerId, name: scope.officeName }
      : { id: '', name: claimedWorkspace?.officeName ?? 'your office' }),
    [scope, claimedWorkspace],
  );

  return (
    <div className="mx-auto max-w-[900px] space-y-5 px-5 py-7 md:px-8">
      <div>
        <h1 className="font-serif text-[32px] font-bold leading-tight tracking-[-.01em] text-navy" data-testid="text-page-title">
          Account &amp; billing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your office&rsquo;s THINNR access, and the patient data you can take with you.
        </p>
      </div>
      {access.isError && (
        <p role="alert" className="text-xs text-destructive" data-testid="text-access-error">
          {access.error instanceof Error ? access.error.message : 'Account status could not be loaded.'}
        </p>
      )}
      <OfficeAccessCard access={access.data} />
      {restriction.restricted && (
        <SectionCard title="What stays open" sub="While the account is unpaid.">
          <ul className="space-y-1.5 px-5 py-4 text-xs text-foreground">
            <li>
              <Link href="/subscriptions" className="font-semibold text-primary hover:underline" data-testid="link-restricted-subscriptions">
                Patient subscriptions
              </Link>{' '}
              — view and manage every patient plan.
            </li>
            <li>
              <Link href="/payments/payouts" className="font-semibold text-primary hover:underline" data-testid="link-restricted-payouts">
                Payouts and Stripe connection
              </Link>{' '}
              — your money keeps moving.
            </li>
            <li>Patient data export — request it below.</li>
          </ul>
        </SectionCard>
      )}
      <ExportsPanel pinnedOffice={pinnedOffice} title="Export patient data" />
    </div>
  );
}
