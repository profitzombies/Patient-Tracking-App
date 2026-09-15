/**
 * The office's read-only status pages, mirroring the HQ payments area but
 * scoped to one office:
 *   - Activity: every ledger line (payments, refunds, disputes, payouts).
 *   - Refunds: refunds issued and disputes opened, with the transaction the
 *     refund action lives on one click away.
 *   - Fulfillment: what THINNR still has to ship, what shipped (with
 *     tracking), and what was canceled. The office watches; HQ ships.
 */
import { Link, useLocation } from 'wouter';
import { ActivityTable } from '@/components/billing/hq/ActivityTable';
import { MoneyCell, StatusPill, formatAddress } from '@/components/billing/primitives';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { Skeleton } from '@/components/ui/skeleton';
import { ConnectDisputesList, ConnectEmbed } from '@/components/billing/ConnectEmbed';
import { ExportsPanel } from '@/components/exports/ExportsPanel';
import { useOfficeBillingScope } from '@/hooks/use-billing';
import { useDateRange } from '@/contexts/date-range';
import { useOfficeActivity, useOfficeFulfillment, useOfficeRefunds } from '@/hooks/use-billing';
import { FULFILLMENT_LABEL, formatDate, formatDateTime, fulfillmentTone, type PillTone } from '@/lib/billing-format';
import type { OfficeBillingStatus, OfficeRefundRow, OrderDetail } from '@/lib/billing-types';
import { DEMO_ACTIVITY, DEMO_FULFILLMENT, DEMO_REFUNDS } from './demo-data';
import { Boundary, DemoNotice, ErrorBox, Header, PAGE, RowLink, clickable, useUrlFilters } from './shared';

// ---------------------------------------------------------------- Activity

const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All activity' },
  { value: 'sale', label: 'Payments received' },
  { value: 'refund', label: 'Refunds' },
  { value: 'dispute_opened', label: 'Disputes opened' },
  { value: 'dispute_won', label: 'Disputes won' },
  { value: 'dispute_lost', label: 'Disputes lost' },
  { value: 'payout', label: 'Payouts to your bank' },
];

export function OfficeActivity() {
  return (
    <Boundary demo={<ActivityView status={null} demo />}>{(status) => <ActivityView status={status} />}</Boundary>
  );
}

function ActivityView({ status, demo = false }: { status: OfficeBillingStatus | null; demo?: boolean }) {
  const { office } = useOfficeBillingScope();
  const url = useUrlFilters('/activity');
  const [, navigate] = useLocation();
  const { range } = useDateRange();
  const kind = url.params.get('kind') ?? '';
  const query = useOfficeActivity({ kind: kind || undefined, from: range.start, to: range.end });
  const rows = demo
    ? DEMO_ACTIVITY.filter((row) => !kind || row.kind === kind)
    : (query.data?.pages.flatMap((page) => page.items) ?? []);
  return (
    <div className={PAGE}>
      <Header title="Payment activity" sub="Every payment, refund, dispute and payout for your office." sandbox={status?.sandbox ?? demo} />
      {demo && <DemoNotice />}
      <form
        className="grid gap-3 rounded-lg border border-card-border bg-card p-4 shadow-soft sm:max-w-sm"
        aria-label="Activity filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="block">
          <span className={PANEL_LABEL}>Activity type</span>
          <select
            data-testid="select-activity-kind"
            className={`${INPUT_CLASS} mt-1 h-9 w-full`}
            value={kind}
            onChange={(event) => url.set('kind', event.target.value)}
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </form>
      <SectionCard
        title="Activity"
        sub={demo ? `${rows.length} demo entries` : query.data ? `${rows.length} loaded${query.hasNextPage ? ' · more available' : ''}` : 'Uses the date range in the header'}
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
            <ActivityTable rows={rows} navigate={navigate} showOffice={false} empty="No activity matches these filters." />
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
        pinnedOffice={{ id: office ?? '', name: status?.office.office_name ?? 'Your office' }}
        title="Payment reports"
        kinds={['billing_transactions', 'billing_subscriptions', 'billing_payouts']}
      />
    </div>
  );
}

// ----------------------------------------------------------------- Refunds

const REFUND_STATUS_LABEL: Record<string, string> = {
  succeeded: 'Refunded',
  pending: 'Refund pending',
  failed: 'Refund failed',
  canceled: 'Refund canceled',
  needs_response: 'Needs response',
  warning_needs_response: 'Needs response',
  under_review: 'Under review',
  warning_under_review: 'Under review',
  won: 'Dispute won',
  lost: 'Dispute lost',
  charge_refunded: 'Refunded',
  warning_closed: 'Closed',
};

function refundTone(row: OfficeRefundRow): PillTone {
  if (row.kind === 'refund') return row.status === 'failed' ? 'bad' : row.status === 'succeeded' ? 'neutral' : 'warn';
  if (row.status === 'won') return 'good';
  if (row.status === 'lost') return 'bad';
  return 'warn';
}

function refundStatusLabel(row: OfficeRefundRow): string {
  return REFUND_STATUS_LABEL[row.status] ?? row.status.replace(/_/g, ' ');
}

function humanReason(reason: string | null): string {
  if (!reason) return '—';
  return reason.includes('_') ? reason.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : reason;
}

export function OfficeRefunds() {
  return <Boundary demo={<RefundsView status={null} demo />}>{(status) => <RefundsView status={status} />}</Boundary>;
}

function RefundsView({ status, demo = false }: { status: OfficeBillingStatus | null; demo?: boolean }) {
  const { office } = useOfficeBillingScope();
  const url = useUrlFilters('/refunds');
  const [, navigate] = useLocation();
  const { range } = useDateRange();
  const kind = url.params.get('kind') ?? '';
  const query = useOfficeRefunds({ kind: kind || undefined, from: range.start, to: range.end });
  const rows = demo ? DEMO_REFUNDS.filter((row) => !kind || row.kind === kind) : (query.data?.items ?? []);
  const openDisputes = rows.filter((row) => row.kind === 'dispute' && !row.closed_at && row.status !== 'won' && row.status !== 'lost');
  return (
    <div className={PAGE}>
      <Header
        title="Refunds and disputes"
        sub="Money returned to patients and card disputes on your orders. To issue a refund, open the transaction and choose Refund."
        sandbox={status?.sandbox ?? demo}
      />
      {demo && <DemoNotice />}
      {openDisputes.length > 0 && (
        <div role="status" data-testid="notice-open-disputes" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-foreground">
          {openDisputes.length === 1 ? 'One dispute needs attention' : `${openDisputes.length} disputes need attention`}. Respond to disputes below before the due date. Stripe collects the evidence and submits it to the card network.
        </div>
      )}
      <SectionCard title="Open disputes">
        <div className="p-5">
          {demo ? (
            <div data-testid="demo-disputes-placeholder" className="rounded-md border border-border bg-secondary p-5 text-xs text-muted-foreground">
              Sign in to review evidence and respond securely through Stripe.
            </div>
          ) : (
            <ConnectEmbed components={['disputes_list']} office={office}>
              <ConnectDisputesList />
            </ConnectEmbed>
          )}
        </div>
      </SectionCard>
      <div className="flex gap-2" role="group" aria-label="Show">
        {[
          { value: '', label: 'All' },
          { value: 'refund', label: 'Refunds' },
          { value: 'dispute', label: 'Disputes' },
        ].map((option) => (
          <button
            key={option.value}
            type="button"
            data-testid={`filter-refunds-${option.value || 'all'}`}
            aria-pressed={kind === option.value}
            className={`${kind === option.value ? BTN_PRIMARY : BTN_SECONDARY} h-9 px-3`}
            onClick={() => url.set('kind', option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <SectionCard title="Refunds and disputes" sub={demo ? `${rows.length} demo entries` : 'Uses the date range in the header'}>
        {!demo && query.isPending ? (
          <div className="p-5">
            <Skeleton className="h-48 w-full" />
          </div>
        ) : !demo && query.isError ? (
          <div className="p-5">
            <ErrorBox error={query.error} retry={() => void query.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <p role="status" className="p-8 text-center text-xs text-muted-foreground">
            No refunds or disputes in this range.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="table-refunds">
              <thead>
                <tr>
                  <th className={`${PANEL_LABEL} px-5 py-2.5`}>When</th>
                  <th className={`${PANEL_LABEL} px-5 py-2.5`}>Type</th>
                  <th className={`${PANEL_LABEL} px-5 py-2.5`}>Order</th>
                  <th className={`${PANEL_LABEL} px-5 py-2.5`}>Patient</th>
                  <th className={`${PANEL_LABEL} px-5 py-2.5`}>Reason</th>
                  <th className={`${PANEL_LABEL} px-5 py-2.5`}>Status</th>
                  <th className={`${PANEL_LABEL} px-5 py-2.5 text-right`}>Amount</th>
                  <th className="relative px-5 py-2.5">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border border-t border-border">
                {rows.map((row) => {
                  const href = `/transactions/${row.order_id}`;
                  return (
                    <tr
                      key={row.id}
                      data-testid={`row-refund-${row.id}`}
                      onClick={clickable(navigate, href)}
                      className="cursor-pointer transition hover:bg-secondary/60"
                    >
                      <td className="whitespace-nowrap px-5 py-3 tabular-nums text-muted-foreground">{formatDateTime(row.created_at)}</td>
                      <td className="px-5 py-3 font-semibold text-navy">{row.kind === 'refund' ? 'Refund' : 'Dispute'}</td>
                      <td className="px-5 py-3 tabular-nums">{row.order_number}</td>
                      <td className="max-w-[180px] truncate px-5 py-3">{row.payer_name ?? '—'}</td>
                      <td className="max-w-[220px] truncate px-5 py-3 text-muted-foreground">{humanReason(row.reason)}</td>
                      <td className="px-5 py-3">
                        <StatusPill tone={refundTone(row)}>{refundStatusLabel(row)}</StatusPill>
                        {row.kind === 'dispute' && row.evidence_due_by && !row.closed_at && (
                          <span className="mt-1 block text-[11px] text-muted-foreground">Response due {formatDate(row.evidence_due_by)}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <MoneyCell cents={-row.amount_cents} signed />
                      </td>
                      <td className="px-5 py-3 text-right">
                        <RowLink href={href} label={`Open order ${row.order_number} (${row.kind})`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ------------------------------------------------------------- Fulfillment

export function OfficeFulfillment() {
  return (
    <Boundary demo={<FulfillmentView status={null} demo />}>{(status) => <FulfillmentView status={status} />}</Boundary>
  );
}

function FulfillmentView({ status, demo = false }: { status: OfficeBillingStatus | null; demo?: boolean }) {
  const url = useUrlFilters('/fulfillment');
  const stage = (url.params.get('status') || 'to_ship') as OrderDetail['fulfillment_status'];
  const query = useOfficeFulfillment({ status: stage });
  const rows: OrderDetail[] | undefined = demo
    ? DEMO_FULFILLMENT.filter((order) => order.fulfillment_status === stage)
    : query.data?.items;
  return (
    <div className={PAGE}>
      <Header
        title="Fulfillment"
        sub="Where each paid order is on its way to the patient. THINNR packs and ships every order and emails the patient tracking."
        sandbox={status?.sandbox ?? demo}
      />
      {demo && <DemoNotice />}
      <div className="flex gap-2" role="group" aria-label="Fulfillment stage">
        {(['to_ship', 'shipped', 'canceled'] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`filter-fulfillment-${value}`}
            aria-pressed={value === stage}
            className={`${value === stage ? BTN_PRIMARY : BTN_SECONDARY} h-9 px-3`}
            onClick={() => url.set('status', value)}
          >
            {FULFILLMENT_LABEL[value]}
          </button>
        ))}
      </div>
      {!demo && query.isPending ? (
        <Skeleton className="h-64" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className="space-y-3" data-testid="fulfillment-list">
          {rows?.map((order) => (
            <SectionCard
              key={order.id}
              title={order.order_number}
              sub={`${order.payer.name} · paid ${formatDate(order.paid_at)}`}
              action={
                <StatusPill tone={fulfillmentTone(order.fulfillment_status)}>{FULFILLMENT_LABEL[order.fulfillment_status]}</StatusPill>
              }
            >
              <div className="grid gap-4 p-4 text-xs md:grid-cols-3">
                <div>
                  <p className={PANEL_LABEL}>Items</p>
                  {order.items.map((item) => (
                    <p key={item.id} className="mt-1">
                      {item.product_name} × {item.quantity}
                    </p>
                  ))}
                </div>
                <address className="not-italic">
                  <p className={PANEL_LABEL}>Ships to</p>
                  {formatAddress(order.shipping_address).map((line) => (
                    <span key={line} className="mt-1 block first:mt-1">
                      {line}
                    </span>
                  ))}
                </address>
                <div>
                  <p className={PANEL_LABEL}>{order.fulfillment_status === 'shipped' ? 'Shipped' : order.fulfillment_status === 'canceled' ? 'Canceled' : 'Status'}</p>
                  {order.fulfillment_status === 'shipped' ? (
                    <>
                      <p className="mt-1">{formatDateTime(order.shipped_at)}</p>
                      <p className="mt-1 text-muted-foreground">
                        {order.carrier ?? 'Carrier'} · <span className="tabular-nums">{order.tracking_number ?? 'No tracking number'}</span>
                      </p>
                    </>
                  ) : order.fulfillment_status === 'canceled' ? (
                    <p className="mt-1 text-muted-foreground">{order.canceled_reason ?? 'No reason recorded'}</p>
                  ) : (
                    <p className="mt-1 text-muted-foreground">Waiting for THINNR to pack and ship.</p>
                  )}
                  <Link href={`/transactions/${order.id}`} className="mt-3 inline-flex font-semibold text-primary hover:underline" data-testid={`link-fulfillment-order-${order.id}`}>
                    View transaction
                  </Link>
                </div>
              </div>
            </SectionCard>
          ))}
          {!rows?.length && (
            <p role="status" className="rounded-md border border-border p-8 text-center text-xs text-muted-foreground">
              {stage === 'to_ship' ? 'Nothing waiting to ship.' : stage === 'shipped' ? 'No shipped orders yet.' : 'No canceled orders.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
