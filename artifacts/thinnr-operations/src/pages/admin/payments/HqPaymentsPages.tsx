import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useMutation } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import {
  AdminPage,
  MetricTile,
  copyText,
} from '@/components/admin/primitives';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import {
  DetailList,
  FeeBreakdown,
  MoneyCell,
  StatusPill,
  formatAddress,
} from '@/components/billing/primitives';
import { FulfillmentDialog } from '@/components/billing/hq/FulfillmentDialog';
import { AreaChart, CHART_COLORS, ChartCard, cumulative, hourLabel, hourlySeriesFrom, seriesFrom, shortDay } from '@/components/billing/hq/RevenueCharts';
import { ActivityTable } from '@/components/billing/hq/ActivityTable';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { useDateRange } from '@/contexts/date-range';
import { ProviderActivityTiles, ProviderRecentOrders } from '@/components/billing/hq/ProviderPaymentsSummary';
import { RefundDialog } from '@/components/billing/RefundDialog';
import { PaymentsHealthBanner } from '@/components/billing/PaymentsHealthBanner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  useHqFulfillment,
  useHqOverview,
  useHqProvider,
  useHqProviders,
  useHqSubscriptions,
  useHqToday,
  useHqTransaction,
  useHqTransactions,
  useInvalidateHqBilling,
  useUpdateFulfillment,
} from '@/hooks/use-billing';
import { hqBilling } from '@/lib/billing-api';
import {
  accountStatusLabel,
  formatCents,
  formatDate,
  formatDateTime,
  fulfillmentTone,
  FULFILLMENT_LABEL,
  humanizeRequirement,
  ORDER_KIND_LABEL,
  ORDER_STATUS_LABEL,
  orderStatusTone,
  SUBSCRIPTION_STATUS_LABEL,
  subscriptionTone,
} from '@/lib/billing-format';
import type { HqTodayOverview, OrderDetail, SubscriptionRow } from '@/lib/billing-types';
import {
  DEMO_FULFILLMENT,
  DEMO_ORDER_DETAILS,
  DEMO_ORDERS,
  DEMO_OVERVIEW,
  DEMO_PROVIDER_DETAILS,
  DEMO_PROVIDERS,
  DEMO_SUBSCRIPTIONS,
  DEMO_TODAY,
} from './demo-data';
import { useBillingSandbox } from './use-billing-sandbox';
import { ErrorBox, Gate, Header, Preview, RowLink, clickable, useUrlFilters } from './shared';

export function PaymentsOverview() {
  return <Gate>{(demo) => <OverviewBody demo={demo} />}</Gate>;
}
function OverviewBody({ demo }: { demo: boolean }) {
  const { range } = useDateRange();
  const query = useHqOverview(demo ? {} : { from: range.start, to: range.end });
  const sandbox = useBillingSandbox();
  const [, navigate] = useLocation();
  const data = demo ? DEMO_OVERVIEW : query.data;
  const series = data ? seriesFrom(data.series) : null;
  const netCollected = data ? data.collected_cents - data.refunded_cents : 0;
  return (
    <AdminPage>
      <Header
        title="Payments overview"
        sub="Program collections, fees, profit and provider payment activity."
        sandbox={sandbox.data?.sandbox}
        action={<DateRangeControl />}
      />
      {demo && <Preview />}
      {!demo && <PaymentsHealthBanner />}
      {!demo && query.isPending ? (
        <Skeleton className="h-44 w-full" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        data &&
        series && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="overview-tiles">
              <MetricTile label="Gross collected" value={formatCents(data.collected_cents)} detail={`${data.orders} payment${data.orders === 1 ? '' : 's'} processed`} />
              <MetricTile label="Refunds" value={formatCents(data.refunded_cents)} detail={data.disputed_cents ? `${formatCents(data.disputed_cents)} in open disputes` : 'No open disputes'} />
              <MetricTile label="Net collected" value={formatCents(netCollected)} detail="Gross minus refunds" />
              <MetricTile label="THINNR fees" value={formatCents(data.thinnr_fee_cents)} detail="Program share of every sale" />
              <MetricTile label="THINNR profit" value={formatCents(data.profit_cents)} detail="After product and shipping costs" />
              <MetricTile label="Payments processed" value={data.orders} detail={`${data.to_ship} to ship`} />
              <MetricTile label="Active subscriptions" value={data.active_subscriptions} />
              <MetricTile
                label="Providers active"
                value={data.providers_onboarded}
                detail={`${data.providers_pending} pending`}
              />
            </div>
            <Link href="/subscriptions?status=past_due" className="mt-3 block">
              <SectionCard title="Subscriptions needing attention" sub="Failed renewal payments">
                <div className="p-5 font-serif text-2xl font-bold text-navy">{data.needs_attention_subscriptions}</div>
              </SectionCard>
            </Link>
            <TodayRevenue demo={demo} />
            <SectionCard title="Daily revenue" sub="Gross collected, net after refunds, and THINNR fees by day" className="mt-5">
              <div className="p-5">
                <AreaChart
                  title="Daily revenue"
                  dates={series.dates}
                  unit="money"
                  testId="chart-daily-revenue"
                  formatLabelLong={(key) => `${shortDay(key)}, ${key.slice(0, 4)}`}
                  series={[
                    { key: 'gross', label: 'Gross collected', color: CHART_COLORS.gross, values: series.gross },
                    { key: 'net', label: 'Net after refunds', color: CHART_COLORS.net, values: series.net },
                    { key: 'fees', label: 'THINNR fees', color: CHART_COLORS.fees, values: series.fees },
                  ]}
                />
              </div>
            </SectionCard>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <ChartCard label="Payments per day" value={String(data.orders)} detail="Total processed in range" dates={series.dates} values={series.orders} unit="count" color={CHART_COLORS.count} testId="chart-payments" />
              <ChartCard label="Refunds per day" value={formatCents(data.refunded_cents)} detail="Total refunded in range" dates={series.dates} values={series.refunds} unit="money" color={CHART_COLORS.refunds} testId="chart-refunds" />
              <ChartCard label="Gross collections" value={formatCents(data.collected_cents)} detail="Running total" dates={series.dates} values={cumulative(series.gross)} unit="money" color={CHART_COLORS.gross} testId="chart-gross" />
              <ChartCard label="Net collections" value={formatCents(netCollected)} detail="Running total after refunds" dates={series.dates} values={cumulative(series.net)} unit="money" color={CHART_COLORS.net} testId="chart-net" />
            </div>
            <SectionCard
              title="Recent activity"
              sub="Latest payments, refunds, disputes and payouts across every office"
              className="mt-5"
              action={
                <Link href="/activity" className={`${BTN_SECONDARY} h-8 px-3`} data-testid="link-view-activity">
                  View all activity
                </Link>
              }
            >
              <ActivityTable rows={data.recent} navigate={navigate} empty="No payment activity in this range yet." />
            </SectionCard>
          </>
        )
      )}
    </AdminPage>
  );
}

/** Today's revenue by clock hour: gross, net after refunds, THINNR fees and THINNR profit, refreshed every minute. */
function TodayRevenue({ demo }: { demo: boolean }) {
  const query = useHqToday();
  const data: HqTodayOverview | undefined = demo ? DEMO_TODAY : query.data;
  const zone = data
    ? new Intl.DateTimeFormat('en-US', { timeZone: data.time_zone, timeZoneName: 'short' }).formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value ?? data.time_zone
    : null;
  const sub = data ? `${shortDay(data.date)} so far, by the hour (${zone}). Refreshes every minute.` : 'By the hour. Refreshes every minute.';
  return (
    <SectionCard title="Today's revenue" sub={sub} className="mt-5">
      <div className="p-5" data-testid="section-today-revenue">
        {!demo && query.isPending ? (
          <Skeleton className="h-52 w-full" />
        ) : !demo && query.isError ? (
          <ErrorBox error={query.error} retry={() => void query.refetch()} />
        ) : data ? (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="today-totals">
              {[
                { label: 'Gross collected', value: data.collected_cents, color: CHART_COLORS.gross, testId: 'today-gross' },
                { label: 'Net after refunds', value: data.net_cents, color: CHART_COLORS.net, testId: 'today-net' },
                { label: 'THINNR fees', value: data.fee_cents, color: CHART_COLORS.fees, testId: 'today-fees' },
                { label: 'THINNR profit', value: data.profit_cents, color: CHART_COLORS.profit, testId: 'today-profit' },
              ].map((tile) => (
                <div key={tile.label} className="rounded-md border border-border bg-background/60 px-3 py-2.5">
                  <dt className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                    <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: tile.color }} />
                    {tile.label}
                  </dt>
                  <dd className="mt-1 font-serif text-[20px] font-bold leading-none tracking-[-.01em] text-navy" data-testid={tile.testId}>
                    {formatCents(tile.value)}
                  </dd>
                </div>
              ))}
            </dl>
            <HourlyChart data={data} />
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}
function HourlyChart({ data }: { data: HqTodayOverview }) {
  const hourly = hourlySeriesFrom(data.hours, data.current_hour);
  return (
    <AreaChart
      title="Today's revenue"
      dates={hourly.hours}
      unit="money"
      height={200}
      testId="chart-today-revenue"
      formatLabel={hourLabel}
      formatLabelLong={(key) => `${hourLabel(key)} to ${hourLabel(String((Number(key) + 1) % 24))}`}
      labelCount={hourly.hours.length <= 8 ? hourly.hours.length : 8}
      emptyLabel="No payments yet today"
      series={[
        { key: 'gross', label: 'Gross collected', color: CHART_COLORS.gross, values: hourly.gross },
        { key: 'net', label: 'Net after refunds', color: CHART_COLORS.net, values: hourly.net },
        { key: 'fees', label: 'THINNR fees', color: CHART_COLORS.fees, values: hourly.fees },
        { key: 'profit', label: 'THINNR profit', color: CHART_COLORS.profit, values: hourly.profit },
      ]}
    />
  );
}

export function PaymentsProviders() {
  return <Gate>{(demo) => <ProvidersBody demo={demo} />}</Gate>;
}
function ProvidersBody({ demo }: { demo: boolean }) {
  const query = useHqProviders();
  const sandbox = useBillingSandbox();
  const [, navigate] = useLocation();
  const rows = demo ? DEMO_PROVIDERS : query.data?.items;
  return (
    <AdminPage>
      <Header
        title="Payment providers"
        sub="Onboarding, pricing and recent collections by office."
        sandbox={sandbox.data?.sandbox}
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-60" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SectionCard title="All offices" sub={`${rows?.length ?? 0} payment profiles`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase text-muted-foreground">
                  <th className="p-4">Office</th>
                  <th>Status</th>
                  <th>Products</th>
                  <th>30-day collected</th>
                  <th>Fees</th>
                  <th>Pricing</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => {
                  const status = accountStatusLabel(row.account);
                  return (
                    <tr
                      key={row.provider_id}
                      onClick={clickable(navigate, `/providers/${row.provider_id}`)}
                      className="cursor-pointer border-b border-border hover:bg-accent/40"
                    >
                      <td className="p-4">
                        <b className="text-navy">{row.office_name}</b>
                        <small className="block text-muted-foreground">{row.provider_name}</small>
                      </td>
                      <td>
                        <StatusPill tone={status.tone}>{status.label}</StatusPill>
                      </td>
                      <td>{row.offered_products}</td>
                      <td>
                        <MoneyCell cents={row.collected_30d_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={row.fees_30d_cents} />
                      </td>
                      <td>
                        {row.below_minimum_count ? (
                          <StatusPill tone="warn">{row.below_minimum_count} below minimum</StatusPill>
                        ) : (
                          'Current'
                        )}
                      </td>
                      <td className="p-4 text-right">
                        <RowLink
                          href={`/providers/${row.provider_id}`}
                          label={`Open ${row.office_name} payments`}
                        />
                      </td>
                    </tr>
                  );
                })}
                {!rows?.length && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-muted-foreground">
                      No provider payment profiles yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </AdminPage>
  );
}

export function PaymentProviderDetail({ params }: { params: { providerId: string } }) {
  return <Gate>{(demo) => <ProviderDetailBody demo={demo} id={params.providerId} />}</Gate>;
}
function ProviderDetailBody({ demo, id }: { demo: boolean; id: string }) {
  const query = useHqProvider(demo ? null : id);
  const sandbox = useBillingSandbox();
  const data = demo ? DEMO_PROVIDER_DETAILS[id] : query.data;
  return (
    <AdminPage>
      <Header
        title={data?.office.office_name ?? 'Provider payment profile'}
        sub="Connected account, requirements, pricing and payment activity."
        sandbox={sandbox.data?.sandbox}
        tabs={false}
        back={{ href: '/providers', label: 'Back to providers' }}
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-64" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : data ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <ProviderActivityTiles activity={data.activity_30d} subscriptions={data.subscriptions} />
          </div>
          <SectionCard title="Connected account">
            {data.account ? (
              <>
                <StatusPill tone={accountStatusLabel(data.account).tone}>
                  {accountStatusLabel(data.account).label}
                </StatusPill>
                <DetailList
                  items={[
                    { label: 'Charges', value: data.account.charges_enabled ? 'Enabled' : 'Not enabled' },
                    { label: 'Payouts', value: data.account.payouts_enabled ? 'Enabled' : 'Not enabled' },
                    { label: 'Tax', value: data.account.tax_enabled ? 'Enabled' : 'Not enabled' },
                    { label: 'Last synced', value: formatDateTime(data.account.last_synced_at) },
                  ]}
                />
                {[...data.account.requirements.past_due, ...data.account.requirements.currently_due].length > 0 && (
                  <ul className="mt-3 list-disc pl-5 text-xs text-destructive">
                    {[...data.account.requirements.past_due, ...data.account.requirements.currently_due].map((x) => (
                      <li key={x}>{humanizeRequirement(x)}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="p-4 text-xs text-muted-foreground">This office has not connected Stripe.</p>
            )}
          </SectionCard>
          <SectionCard title="Onboarding timeline">
            <div className="divide-y divide-border">
              {data.events.map((e) => (
                <div className="p-3 text-xs" key={e.id}>
                  <b className="text-navy">{humanizeRequirement(e.kind)}</b>
                  <small className="block text-muted-foreground">{formatDateTime(e.created_at)}</small>
                </div>
              ))}
            </div>
          </SectionCard>
          <SectionCard title="Price list" className="lg:col-span-2">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className="p-3 text-left">Product</th>
                    <th>Floor</th>
                    <th>Minimum</th>
                    <th>Office price</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.prices.map((p) => (
                    <tr key={p.product_id} className="border-t">
                      <td className="p-3">{p.name}</td>
                      <td>
                        <MoneyCell cents={p.floor_price_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={p.break_even_minimum_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={p.sell_price_cents} />
                      </td>
                      <td>
                        {p.below_minimum ? (
                          <StatusPill tone="bad">Below minimum</StatusPill>
                        ) : p.offered ? (
                          'Offered'
                        ) : (
                          'Not offered'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
          <SectionCard title="Recent orders" sub="Newest first" className="lg:col-span-2">
            <ProviderRecentOrders
              orders={data.recent_orders}
              orderHref={(orderId) => `/transactions/${orderId}`}
              emptyMessage="This office has not taken an order yet."
            />
          </SectionCard>
          <SectionCard title="Subscriptions">
            <p className="p-4 text-xs">
              {data.subscriptions.active} active · {data.subscriptions.past_due} past due ·{' '}
              {data.subscriptions.canceled} canceled
            </p>
          </SectionCard>
          <SectionCard title="Payouts">
            {data.payouts.map((p) => (
              <div className="flex justify-between border-b p-3 text-xs" key={p.id}>
                <span>
                  {formatDate(p.arrival_date)} · {p.status}
                </span>
                <MoneyCell cents={p.amount_cents} />
              </div>
            ))}
          </SectionCard>
        </div>
      ) : demo ? (
        <p role="status" className="rounded-md border p-8 text-center text-xs text-muted-foreground">This demo provider could not be found.</p>
      ) : null}
    </AdminPage>
  );
}

export function PaymentsTransactions() {
  return <Gate>{(demo) => <TransactionsBody demo={demo} />}</Gate>;
}
function TransactionsBody({ demo }: { demo: boolean }) {
  const url = useUrlFilters('/transactions');
  const [, navigate] = useLocation();
  const filters = Object.fromEntries(url.params.entries());
  const query = useHqTransactions(filters);
  const sandbox = useBillingSandbox();
  const rows = demo ? DEMO_ORDERS : query.data?.items;
  return (
    <AdminPage>
      <Header title="Transactions" sub="Search and review all provider orders." sandbox={sandbox.data?.sandbox} />
      {demo && <Preview />}
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <label className="relative lg:col-span-2">
          <Search className="absolute left-3 top-2.5" size={14} />
          <input
            aria-label="Search transactions"
            className={`${INPUT_CLASS} h-9 w-full pl-9`}
            value={url.params.get('q') ?? ''}
            onChange={(e) => url.set('q', e.target.value)}
            placeholder="Order, office or payer"
          />
        </label>
        {['provider_id', 'status', 'kind', 'from', 'to'].map((key) =>
          key === 'provider_id' ? null : key === 'from' || key === 'to' ? (
            <input
              key={key}
              aria-label={key}
              type="date"
              className={`${INPUT_CLASS} h-9`}
              value={url.params.get(key) ?? ''}
              onChange={(e) => url.set(key, e.target.value)}
            />
          ) : (
            <select
              key={key}
              aria-label={key}
              className={`${INPUT_CLASS} h-9`}
              value={url.params.get(key) ?? ''}
              onChange={(e) => url.set(key, e.target.value)}
            >
              <option value="">All {key}</option>
              {(key === 'status'
                ? ['pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed', 'canceled']
                : ['one_time', 'subscription_initial', 'subscription_renewal']
              ).map((x) => (
                <option key={x} value={x}>
                  {humanizeRequirement(x)}
                </option>
              ))}
            </select>
          ),
        )}
      </div>
      {!demo && query.isPending ? (
        <Skeleton className="h-60" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SectionCard title="Orders">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr>
                  <th className="p-3 text-left">Order</th>
                  <th>Office</th>
                  <th>Payer</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Date</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => (
                  <tr
                    key={row.id}
                    onClick={clickable(navigate, `/transactions/${row.id}`)}
                    className="cursor-pointer border-t hover:bg-accent/40"
                  >
                    <td className="p-3 font-semibold">{row.order_number}</td>
                    <td>{row.office_name}</td>
                    <td>{row.payer.name}</td>
                    <td>{ORDER_KIND_LABEL[row.kind]}</td>
                    <td>
                      <StatusPill tone={orderStatusTone(row.status)}>{ORDER_STATUS_LABEL[row.status]}</StatusPill>
                    </td>
                    <td>
                      <MoneyCell cents={row.total_cents} />
                    </td>
                    <td>{formatDate(row.paid_at ?? row.created_at)}</td>
                    <td>
                      <RowLink
                        href={`/transactions/${row.id}`}
                        label={`Open order ${row.order_number}`}
                      />
                    </td>
                  </tr>
                ))}
                {!rows?.length && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted-foreground">
                      No transactions match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </AdminPage>
  );
}

export function PaymentTransactionDetail({ params }: { params: { orderId: string } }) {
  return (
    <Gate>{(demo, canWrite) => <TransactionDetailBody demo={demo} canWrite={canWrite} id={params.orderId} />}</Gate>
  );
}
function TransactionDetailBody({ demo, canWrite, id }: { demo: boolean; canWrite: boolean; id: string }) {
  const query = useHqTransaction(demo ? null : id);
  const sandbox = useBillingSandbox();
  const invalidate = useInvalidateHqBilling();
  const { toast } = useToast();
  const [refundOpen, setRefundOpen] = useState(false);
  const refund = useMutation({
    mutationFn: (body: { amount_cents?: number; reason: string }) => hqBilling.refund(id, body),
    onSuccess: () => {
      setRefundOpen(false);
      void invalidate();
      toast({ variant: 'success', title: 'Refund submitted' });
    },
  });
  const order = demo ? DEMO_ORDER_DETAILS.find((row) => row.id === id) : query.data;
  return (
    <AdminPage>
      <Header
        title={order ? `Order ${order.order_number}` : 'Transaction detail'}
        sub="Complete payment, fulfillment and Stripe record."
        sandbox={sandbox.data?.sandbox}
        tabs={false}
        back={{ href: '/transactions', label: 'Back to transactions' }}
        action={
          order && canWrite ? (
            <button className={`${BTN_PRIMARY} h-9 px-3.5`} onClick={() => setRefundOpen(true)}>
              Refund
            </button>
          ) : undefined
        }
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-80" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : order ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard title="Order" sub={`${order.items.reduce((sum, i) => sum + i.quantity, 0)} item(s) · ${ORDER_KIND_LABEL[order.kind]}`}>
            <div className="p-5">
              <DetailList
                items={[
                  { label: 'Office', value: order.office_name },
                  { label: 'Payer', value: `${order.payer.name} · ${order.payer.email ?? 'No email'}` },
                  {
                    label: 'Status',
                    value: (
                      <StatusPill tone={orderStatusTone(order.status)}>{ORDER_STATUS_LABEL[order.status]}</StatusPill>
                    ),
                  },
                  { label: 'Paid', value: formatDateTime(order.paid_at) },
                ]}
              />
            </div>
            <table className="w-full border-t border-border text-xs">
              <thead>
                <tr className="text-left">
                  <th className={`${PANEL_LABEL} px-5 py-2.5`}>Item</th>
                  <th className={`${PANEL_LABEL} px-5 py-2.5 text-right`}>Qty</th>
                  <th className={`${PANEL_LABEL} px-5 py-2.5 text-right`}>Unit price</th>
                  <th className={`${PANEL_LABEL} px-5 py-2.5 text-right`}>Line total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border border-t border-border">
                {order.items.map((i) => (
                  <tr key={i.id}>
                    <td className="px-5 py-2.5 font-semibold text-navy">{i.product_name}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{i.quantity}</td>
                    <td className="px-5 py-2.5 text-right"><MoneyCell cents={i.unit_price_cents} /></td>
                    <td className="px-5 py-2.5 text-right"><MoneyCell cents={i.unit_price_cents * i.quantity} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>
          <SectionCard title="Fees and profit">
            <div className="p-5">
              <FeeBreakdown fees={order.fees} profit={order.profit} perspective="hq" />
            </div>
          </SectionCard>
          <SectionCard title="Shipping and fulfillment">
            <div className="space-y-4 p-5">
              <div>
                <p className={PANEL_LABEL}>Ship to</p>
                <address className="mt-1 text-xs not-italic leading-relaxed">
                  {formatAddress(order.shipping_address).map((x) => (
                    <span className="block" key={x}>
                      {x}
                    </span>
                  ))}
                </address>
              </div>
              <DetailList
                items={[
                  { label: 'Status', value: <StatusPill tone={fulfillmentTone(order.fulfillment_status)}>{FULFILLMENT_LABEL[order.fulfillment_status]}</StatusPill> },
                  { label: 'Carrier', value: order.carrier ?? '—' },
                  { label: 'Tracking', value: order.tracking_number ?? '—' },
                  { label: 'Shipped', value: order.shipped_at ? formatDateTime(order.shipped_at) : '—' },
                  ...(order.canceled_reason ? [{ label: 'Canceled reason', value: order.canceled_reason }] : []),
                ]}
              />
            </div>
          </SectionCard>
          <SectionCard title="Refunds and disputes">
            <div className="p-5 text-xs">
              {order.refunds.length > 0 || order.disputes.length > 0 ? (
                <ul className="divide-y divide-border">
                  {order.refunds.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                      <span>
                        <b className="font-semibold text-navy">Refund</b>
                        <small className="block text-muted-foreground">
                          {formatDateTime(r.created_at)} · {r.status}{r.reason ? ` · ${r.reason}` : ''}
                        </small>
                      </span>
                      <MoneyCell cents={-r.amount_cents} />
                    </li>
                  ))}
                  {order.disputes.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                      <span>
                        <b className="font-semibold text-navy">Dispute {d.status}</b>
                        <small className="block text-muted-foreground">{formatDateTime(d.created_at)}</small>
                      </span>
                      <MoneyCell cents={d.amount_cents} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No refunds or disputes.</p>
              )}
            </div>
          </SectionCard>
          <SectionCard title="Stripe references" sub="Identifiers for reconciling this order inside Stripe." className="lg:col-span-2">
            <div className="p-5">
              <DetailList
                items={Object.entries(order.stripe).map(([k, v]) => ({
                  label: k.replace(/_/g, ' '),
                  value: <span className="break-all font-mono text-[11px]">{v ?? '—'}</span>,
                }))}
              />
            </div>
          </SectionCard>
          <RefundDialog
            order={order}
            open={refundOpen}
            onOpenChange={setRefundOpen}
            pending={refund.isPending}
            error={refund.error instanceof Error ? refund.error.message : null}
            onConfirm={(amount_cents, reason) => {
              if (demo) {
                toast({ title: 'Preview only', description: 'Sign in to issue a live refund.' });
                setRefundOpen(false);
                return;
              }
              refund.mutate({ amount_cents, reason });
            }}
          />
        </div>
      ) : demo ? (
        <p role="status" className="rounded-md border p-8 text-center text-xs text-muted-foreground">This demo transaction could not be found.</p>
      ) : null}
    </AdminPage>
  );
}

export function PaymentsFulfillment() {
  return <Gate>{(demo, canWrite) => <FulfillmentBody demo={demo} canWrite={canWrite} />}</Gate>;
}
function FulfillmentBody({ demo, canWrite }: { demo: boolean; canWrite: boolean }) {
  const url = useUrlFilters('/fulfillment');
  const status = url.params.get('status') || 'to_ship';
  const query = useHqFulfillment({ status });
  const sandbox = useBillingSandbox();
  const mutation = useUpdateFulfillment();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{ order: OrderDetail; mode: 'ship' | 'cancel' } | null>(null);
  const rows = demo ? DEMO_FULFILLMENT.filter((order) => order.fulfillment_status === status) : query.data?.items;
  const update = (value: { carrier?: string; tracking_number?: string; canceled_reason?: string }) => {
    if (!dialog) return;
    if (demo) {
      toast({ title: 'Preview only', description: 'Sign in to update live fulfillment.' });
      setDialog(null);
      return;
    }
    mutation.mutate(
      { orderId: dialog.order.id, status: dialog.mode === 'ship' ? 'shipped' : 'canceled', ...value },
      {
        onSuccess: () => {
          toast({
            variant: 'success',
            title: dialog.mode === 'ship' ? 'Shipped. The patient was emailed the tracking number.' : 'Order canceled.',
          });
          setDialog(null);
        },
      },
    );
  };
  return (
    <AdminPage>
      <Header title="Fulfillment" sub="Ship paid orders and keep patients informed." sandbox={sandbox.data?.sandbox} />
      {demo && <Preview />}
      <div className="mb-4 flex gap-2">
        {(['to_ship', 'shipped', 'canceled'] as const).map((x) => (
          <button
            key={x}
            onClick={() => url.set('status', x)}
            className={`${x === status ? BTN_PRIMARY : BTN_SECONDARY} h-9 px-3`}
          >
            {FULFILLMENT_LABEL[x]}
          </button>
        ))}
      </div>
      {!demo && query.isPending ? (
        <Skeleton className="h-64" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className="space-y-3">
          {rows?.map((order) => (
            <SectionCard
              key={order.id}
              title={`${order.order_number} · ${order.office_name}`}
              sub={`${order.payer.name} · paid ${formatDate(order.paid_at)}`}
              action={
                <StatusPill tone={fulfillmentTone(order.fulfillment_status)}>
                  {FULFILLMENT_LABEL[order.fulfillment_status]}
                </StatusPill>
              }
            >
              <div className="grid gap-4 p-4 md:grid-cols-3">
                <div className="text-xs">
                  {order.items.map((i) => (
                    <p key={i.id}>
                      {i.product_name} × {i.quantity}
                    </p>
                  ))}
                </div>
                <address className="not-italic text-xs">
                  {formatAddress(order.shipping_address).map((x) => (
                    <span key={x} className="block">
                      {x}
                    </span>
                  ))}
                  <button
                    className="mt-2 text-primary underline"
                    onClick={async () => {
                      const ok = await copyText(formatAddress(order.shipping_address).join('\n'));
                      toast({ title: ok ? 'Address copied' : 'Could not copy address' });
                    }}
                  >
                    Copy address
                  </button>
                </address>
                {canWrite && order.fulfillment_status === 'to_ship' && (
                  <div className="flex items-start justify-end gap-2">
                    <button className={`${BTN_SECONDARY} h-8 px-3`} onClick={() => setDialog({ order, mode: 'cancel' })}>
                      Cancel order
                    </button>
                    <button
                      data-testid={`button-ship-${order.id}`}
                      className={`${BTN_PRIMARY} h-9 px-3.5`}
                      onClick={() => setDialog({ order, mode: 'ship' })}
                    >
                      Mark shipped
                    </button>
                  </div>
                )}
              </div>
            </SectionCard>
          ))}
          {!rows?.length && (
            <p className="rounded-md border p-8 text-center text-xs text-muted-foreground">No orders in this queue.</p>
          )}
        </div>
      )}
      {dialog && (
        <FulfillmentDialog
          order={dialog.order}
          mode={dialog.mode}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          onConfirm={update}
          pending={mutation.isPending}
          error={mutation.error instanceof Error ? mutation.error.message : null}
        />
      )}
    </AdminPage>
  );
}

export function PaymentsSubscriptions() {
  return <Gate>{(demo, canWrite) => <SubscriptionsBody demo={demo} canWrite={canWrite} />}</Gate>;
}
function SubscriptionsBody({ demo, canWrite }: { demo: boolean; canWrite: boolean }) {
  const url = useUrlFilters('/subscriptions');
  const query = useHqSubscriptions(Object.fromEntries(url.params.entries()));
  const sandbox = useBillingSandbox();
  const invalidate = useInvalidateHqBilling();
  const { toast } = useToast();
  const cancel = useMutation({
    mutationFn: ({ id, at_period_end }: { id: string; at_period_end: boolean }) =>
      hqBilling.cancelSubscription(id, { at_period_end }),
    onSuccess: () => {
      void invalidate();
      toast({ variant: 'success', title: 'Subscription cancellation saved' });
    },
  });
  const retry = useMutation({
    mutationFn: (id: string) => hqBilling.retrySubscriptionPayment(id),
    onSuccess: () => {
      void invalidate();
      toast({ variant: 'success', title: 'Payment retry started' });
    },
    onError: (error: Error) => toast({ variant: 'destructive', title: 'Payment retry failed', description: error.message }),
  });
  const resend = useMutation({
    mutationFn: (id: string) => hqBilling.resendSubscriptionPaymentEmail(id),
    onSuccess: () => toast({ variant: 'success', title: 'Payment link emailed' }),
    onError: (error: Error) => toast({ variant: 'destructive', title: 'Email could not be sent', description: error.message }),
  });
  const [canceling, setCanceling] = useState<{ row: SubscriptionRow; atPeriodEnd: boolean } | null>(null);
  const demoStatus = url.params.get('status');
  const rows = demo
    ? DEMO_SUBSCRIPTIONS.filter((row) => !demoStatus || row.status === demoStatus)
    : query.data?.items;
  return (
    <AdminPage>
      <Header
        title="Subscriptions"
        sub="Four-week product subscriptions across every office."
        sandbox={sandbox.data?.sandbox}
      />
      {demo && <Preview />}
      <div className="mb-4 flex gap-2">
        <select
          className={`${INPUT_CLASS} h-9`}
          aria-label="Subscription status"
          value={url.params.get('status') ?? ''}
          onChange={(e) => url.set('status', e.target.value)}
        >
          <option value="">All statuses</option>
          {['incomplete', 'active', 'past_due', 'canceled', 'unpaid'].map((x) => (
            <option value={x} key={x}>
              {humanizeRequirement(x)}
            </option>
          ))}
        </select>
        <input
          className={`${INPUT_CLASS} h-9`}
          aria-label="Office filter"
          placeholder="Office id"
          value={url.params.get('provider_id') ?? ''}
          onChange={(e) => url.set('provider_id', e.target.value)}
        />
      </div>
      {!demo && query.isPending ? (
        <Skeleton className="h-60" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SectionCard title="Program subscriptions">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead>
                <tr>
                  <th className="p-3 text-left">Patient</th>
                  <th>Office</th>
                  <th>Product</th>
                  <th>Status</th>
                  <th>Renewal</th>
                  <th>Price</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="p-3">{row.payer.name}</td>
                    <td>{row.office_name}</td>
                    <td>{row.product_name}</td>
                    <td>
                      <StatusPill tone={subscriptionTone(row.status)}>
                        {SUBSCRIPTION_STATUS_LABEL[row.status]}
                      </StatusPill>
                      {(row.status === 'past_due' || row.status === 'unpaid') && (
                        <p className="mt-1 max-w-52 text-[11px] text-red-700">
                          Card declined {row.payment_failure_count} {row.payment_failure_count === 1 ? 'time' : 'times'}, last on {formatDate(row.last_payment_failed_at)}
                        </p>
                      )}
                    </td>
                    <td>
                      {row.cancel_at_period_end
                        ? `Ends ${formatDate(row.current_period_end)}`
                        : formatDate(row.current_period_end)}
                    </td>
                    <td>
                      <MoneyCell cents={row.unit_price_cents + row.shipping_charge_cents} />
                    </td>
                    <td>
                      {canWrite && row.status !== 'canceled' && (
                        <span className="flex flex-wrap justify-end gap-1">
                          {(row.status === 'past_due' || row.status === 'unpaid') && (
                            <>
                              <button className={`${BTN_SECONDARY} h-8 px-3`} disabled={demo || retry.isPending} onClick={() => retry.mutate(row.id)}>
                                Retry payment
                              </button>
                              <button className={`${BTN_SECONDARY} h-8 px-3`} disabled={demo || resend.isPending} onClick={() => resend.mutate(row.id)}>
                                Email patient a payment link
                              </button>
                            </>
                          )}
                          <button
                            className={`${BTN_SECONDARY} h-8 px-3`}
                            disabled={cancel.isPending}
                            onClick={() => setCanceling({ row, atPeriodEnd: true })}
                          >
                            Cancel at renewal
                          </button>
                          <button
                            className={`${BTN_SECONDARY} h-8 px-3`}
                            disabled={cancel.isPending}
                            onClick={() => setCanceling({ row, atPeriodEnd: false })}
                          >
                            Cancel now
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows?.length && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-muted-foreground">
                      No subscriptions match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
      <Dialog open={Boolean(canceling)} onOpenChange={(open) => !open && setCanceling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Cancel subscription</DialogTitle>
            <DialogDescription>
              {canceling?.atPeriodEnd
                ? `${canceling.row.payer.name}'s subscription will remain active through ${formatDate(canceling.row.current_period_end)}.`
                : `${canceling?.row.payer.name}'s subscription will end immediately.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button className={`${BTN_SECONDARY} h-8 px-3`} onClick={() => setCanceling(null)}>Back</button>
            <button
              className={`${BTN_PRIMARY} h-9 px-3.5`}
              disabled={cancel.isPending}
              onClick={() => {
                if (!canceling) return;
                if (demo) {
                  toast({ title: 'Preview only', description: 'Sign in to cancel a live subscription.' });
                  setCanceling(null);
                  return;
                }
                cancel.mutate(
                  { id: canceling.row.id, at_period_end: canceling.atPeriodEnd },
                  { onSuccess: () => setCanceling(null) },
                );
              }}
            >
              Confirm cancellation
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
