/**
 * Payments card on the provider account page. Reads the same HQ billing
 * endpoint as the payments provider profile, so the numbers here always match
 * /admin/payments. Only HQ roles with the payments permission see it; for
 * everyone else the card is simply absent rather than an error.
 */
import { Link } from 'wouter';
import { ArrowRight } from 'lucide-react';
import { BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';
import { SandboxBadge } from '@/components/billing/primitives';
import {
  ProviderActivityTiles,
  ProviderConnectionLine,
  ProviderRecentOrders,
} from '@/components/billing/hq/ProviderPaymentsSummary';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/contexts/session';
import { canHq } from '@/data/hq/team';
import { useHqBillingScope, useHqProvider } from '@/hooks/use-billing';
import { useBillingSandbox } from '@/pages/admin/payments/use-billing-sandbox';
import { formatCents } from '@/lib/billing-format';

/**
 * The provider's billing detail, or nothing when this HQ member cannot see
 * payments. Shared by the card and by the account-metrics tiles so both read
 * one cached response.
 */
export function useAccountPayments(providerId: string | undefined) {
  const { hqRole } = useSession();
  const scope = useHqBillingScope();
  const allowed = scope.liveEnabled && canHq(hqRole, 'payments') && Boolean(providerId);
  const query = useHqProvider(allowed ? providerId ?? null : null);
  const data = allowed ? query.data : undefined;
  const tiles = data
    ? {
        collected: formatCents(data.activity_30d.collected_cents),
        subscriptions: data.subscriptions.active.toLocaleString('en-US'),
        orders: data.activity_30d.orders.toLocaleString('en-US'),
      }
    : null;
  return { allowed, query, tiles };
}

export function AccountPaymentsCard({ providerId }: { providerId: string }) {
  const { allowed, query } = useAccountPayments(providerId);
  const sandbox = useBillingSandbox();
  if (!allowed) return null;

  return (
    <SectionCard
      title="Payments"
      sub="Stripe connection, last 30 days, and recent orders for this office"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <SandboxBadge sandbox={sandbox.data?.sandbox} />
          <Link
            href={`/admin/payments/providers/${providerId}`}
            className={`${BTN_SECONDARY} h-8 px-3`}
            data-testid="link-payment-profile"
          >
            Full payment profile
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>
      }
    >
      {query.isPending ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : query.isError ? (
        <div role="alert" className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
          {query.error instanceof Error ? query.error.message : 'Payments could not be loaded.'}{' '}
          <button type="button" className="ml-1 underline" onClick={() => void query.refetch()}>
            Try again
          </button>
        </div>
      ) : query.data ? (
        <>
          <div className="border-b border-border px-4 py-3">
            <ProviderConnectionLine account={query.data.account} />
          </div>
          <div className="px-4 py-4">
            <ProviderActivityTiles activity={query.data.activity_30d} subscriptions={query.data.subscriptions} />
          </div>
          <div className="border-t border-border">
            <ProviderRecentOrders
              orders={query.data.recent_orders}
              orderHref={(orderId) => `/admin/payments/transactions/${orderId}`}
              emptyMessage={
                query.data.account
                  ? 'No orders yet. Orders appear here as soon as a patient pays through one of this office’s links.'
                  : 'Orders appear here once this office connects Stripe and shares a payment link.'
              }
            />
          </div>
        </>
      ) : null}
    </SectionCard>
  );
}
