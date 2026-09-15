/**
 * Full payment activity feed: every ledger line across every office, with a
 * kind filter, provider filter and date range, paginated with "Load more".
 * Filters live in the query string so a filtered view can be shared.
 */
import { useLocation } from 'wouter';
import { AdminPage } from '@/components/admin/primitives';
import { ActivityTable } from '@/components/billing/hq/ActivityTable';
import { BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { Skeleton } from '@/components/ui/skeleton';
import { ExportsPanel } from '@/components/exports/ExportsPanel';
import { useHqActivity, useHqProviders } from '@/hooks/use-billing';
import { DEMO_ACTIVITY, DEMO_PROVIDERS } from './demo-data';
import { ErrorBox, Gate, Header, Preview, useUrlFilters } from './shared';
import { useBillingSandbox } from './use-billing-sandbox';

const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All activity' },
  { value: 'sale', label: 'Payments received' },
  { value: 'refund', label: 'Refunds' },
  { value: 'dispute_opened', label: 'Disputes opened' },
  { value: 'dispute_won', label: 'Disputes won' },
  { value: 'dispute_lost', label: 'Disputes lost' },
  { value: 'payout', label: 'Payouts to offices' },
  { value: 'fee_discrepancy', label: 'Fee discrepancies' },
];

export function PaymentsActivity() {
  return <Gate>{(demo) => <ActivityBody demo={demo} />}</Gate>;
}

function ActivityBody({ demo }: { demo: boolean }) {
  const url = useUrlFilters('/activity');
  const [, navigate] = useLocation();
  const filters = Object.fromEntries(url.params.entries());
  const query = useHqActivity(filters);
  const providers = useHqProviders();
  const sandbox = useBillingSandbox();
  const providerRows = demo ? DEMO_PROVIDERS : (providers.data?.items ?? []);
  const rows = demo
    ? DEMO_ACTIVITY.filter((row) => (!filters.kind || row.kind === filters.kind) && (!filters.provider_id || row.provider_id === filters.provider_id))
    : (query.data?.pages.flatMap((page) => page.items) ?? []);
  const field = `${INPUT_CLASS} h-9`;
  return (
    <AdminPage>
      <Header title="Payment activity" sub="Every payment, refund, dispute and payout across the program." sandbox={sandbox.data?.sandbox} />
      {demo && <Preview />}
      <form
        className="mb-4 grid gap-3 rounded-lg border border-card-border bg-card p-4 shadow-soft sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Activity filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="block">
          <span className={PANEL_LABEL}>Activity type</span>
          <select data-testid="select-activity-kind" className={`${field} mt-1 w-full`} value={filters.kind ?? ''} onChange={(e) => url.set('kind', e.target.value)}>
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={PANEL_LABEL}>Office</span>
          <select data-testid="select-activity-office" className={`${field} mt-1 w-full`} value={filters.provider_id ?? ''} onChange={(e) => url.set('provider_id', e.target.value)}>
            <option value="">All offices</option>
            {providerRows.map((provider) => (
              <option key={provider.provider_id} value={provider.provider_id}>
                {provider.office_name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={PANEL_LABEL}>From</span>
          <input data-testid="input-activity-from" type="date" className={`${field} mt-1 w-full bg-white`} value={filters.from ?? ''} onChange={(e) => url.set('from', e.target.value)} />
        </label>
        <label className="block">
          <span className={PANEL_LABEL}>To</span>
          <input data-testid="input-activity-to" type="date" className={`${field} mt-1 w-full bg-white`} value={filters.to ?? ''} onChange={(e) => url.set('to', e.target.value)} />
        </label>
      </form>
      <SectionCard
        title="Activity"
        sub={demo ? `${rows.length} demo entries` : query.data ? `${rows.length} loaded${query.hasNextPage ? ' · more available' : ''}` : undefined}
      >
        {!demo && query.isPending ? (
          <div className="p-5">
            <Skeleton className="h-48 w-full" />
          </div>
        ) : !demo && query.isError ? (
          <div className="p-5">
            <ErrorBox error={query.error} retry={() => void query.refetch()} />
          </div>
        ) : (
          <>
            <ActivityTable rows={rows} navigate={navigate} empty="No activity matches these filters." />
            {!demo && query.hasNextPage && (
              <div className="border-t border-border p-4 text-center">
                <button
                  type="button"
                  data-testid="button-activity-more"
                  className={`${BTN_SECONDARY} h-9 px-4`}
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </SectionCard>
      <ExportsPanel
        className="mt-5"
        officeOptions={providerRows.map((provider) => ({ id: provider.provider_id, name: provider.office_name }))}
        title="Payment reports"
        kinds={['billing_transactions', 'billing_subscriptions', 'billing_payouts']}
      />
    </AdminPage>
  );
}
