/**
 * Office payments overview: balance and payout tiles, today's revenue by
 * hour, the daily revenue chart, and the latest activity, all scoped to the
 * office being viewed. Same shape as the HQ overview minus THINNR profit
 * (the office sees its own net instead).
 */
import { Link, useLocation } from 'wouter';
import { MetricTile } from '@/components/admin/primitives';
import { ActivityTable } from '@/components/billing/hq/ActivityTable';
import {
  AreaChart,
  CHART_COLORS,
  ChartCard,
  cumulative,
  hourLabel,
  hourlySeriesFrom,
  runningHourLabel,
  seriesFrom,
  shortDay,
} from '@/components/billing/hq/RevenueCharts';
import { BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';
import { Skeleton } from '@/components/ui/skeleton';
import { useDateRange } from '@/contexts/date-range';
import { useOfficeActivity, useOfficeDashboard, useOfficeToday } from '@/hooks/use-billing';
import { formatCents, formatDate } from '@/lib/billing-format';
import type { HqTodayOverview, OfficeBillingStatus, OfficeDashboard } from '@/lib/billing-types';
import { DEMO_ACTIVITY, DEMO_DASHBOARD, DEMO_TODAY } from './demo-data';
import { Boundary, DemoNotice, ErrorBox, Header, PAGE } from './shared';

const OFFICE_NET = '#2f7d4f';

export function OfficeOverview() {
  return (
    <Boundary demo={<OverviewView status={null} data={DEMO_DASHBOARD} demo />}>
      {(status) => <OverviewQuery status={status} />}
    </Boundary>
  );
}

function OverviewQuery({ status }: { status: OfficeBillingStatus }) {
  const { range } = useDateRange();
  const query = useOfficeDashboard({ from: range.start, to: range.end });
  if (query.isPending)
    return (
      <div className={PAGE}>
        <Header title="Payments overview" sub="Balances, sales, fees and payouts for your office." sandbox={status.sandbox} />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  if (query.isError || !query.data)
    return (
      <div className={PAGE}>
        <Header title="Payments overview" sub="Balances, sales, fees and payouts for your office." sandbox={status.sandbox} />
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return <OverviewView status={status} data={query.data} />;
}

function OverviewView({
  status,
  data,
  demo = false,
}: {
  status: OfficeBillingStatus | null;
  data: OfficeDashboard;
  demo?: boolean;
}) {
  const [, navigate] = useLocation();
  const series = seriesFrom(data.series);
  const netCollected = data.collected_cents - data.refunded_cents;
  return (
    <div className={PAGE}>
      <Header
        title="Payments overview"
        sub="Balances, sales, fees and payouts for your office."
        sandbox={status?.sandbox ?? demo}
      />
      {demo && <DemoNotice />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="office-overview-tiles">
        <MetricTile
          label="Available balance"
          value={formatCents(data.balance.available_cents)}
          detail={`${formatCents(data.balance.pending_cents)} pending`}
          testId="tile-available"
        />
        <MetricTile
          label="Next payout"
          value={data.next_payout ? formatCents(data.next_payout.amount_cents) : '—'}
          detail={data.next_payout ? `Arrives ${formatDate(data.next_payout.arrival_date)}` : 'Not scheduled'}
          testId="tile-next-payout"
        />
        <MetricTile
          label="Gross collected"
          value={formatCents(data.collected_cents)}
          detail={`${data.orders} payment${data.orders === 1 ? '' : 's'} in this range`}
          testId="tile-gross"
        />
        <MetricTile label="Refunds" value={formatCents(data.refunded_cents)} detail="Returned to patients" testId="tile-refunds" />
        <MetricTile label="THINNR fees" value={formatCents(data.thinnr_fee_cents)} detail="Program share of every sale" testId="tile-fees" />
        <MetricTile
          label="Office net"
          value={formatCents(data.net_cents)}
          detail={`After THINNR fees and ${formatCents(data.stripe_fee_cents)} in card fees`}
          testId="tile-office-net"
        />
        <MetricTile label="Active subscriptions" value={data.active_subscriptions} detail="Renewing every 4 weeks" testId="tile-subscriptions" />
        <MetricTile label="Waiting to ship" value={data.to_ship} detail="Packed and shipped by THINNR" testId="tile-to-ship" />
      </div>
      <Link href="/subscriptions?status=past_due" className="my-3 block">
        <SectionCard title="Subscriptions needing attention" sub="Failed renewal payments">
          <div className="p-5 font-serif text-2xl font-bold text-navy">{data.needs_attention_subscriptions}</div>
        </SectionCard>
      </Link>

      <TodayRevenue demo={demo} />

      <SectionCard title="Daily revenue" sub="Gross collected, net after refunds, THINNR fees and your office net by day">
        <div className="p-5">
          <AreaChart
            title="Daily revenue"
            dates={series.dates}
            unit="money"
            testId="chart-daily-revenue"
            emptyLabel="No payments in this range yet"
            formatLabelLong={(key) => `${shortDay(key)}, ${key.slice(0, 4)}`}
            series={[
              { key: 'gross', label: 'Gross collected', color: CHART_COLORS.gross, values: series.gross },
              { key: 'net', label: 'Net after refunds', color: CHART_COLORS.net, values: series.net },
              { key: 'fees', label: 'THINNR fees', color: CHART_COLORS.fees, values: series.fees },
              { key: 'office', label: 'Office net', color: OFFICE_NET, values: series.officeNet },
            ]}
          />
        </div>
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ChartCard label="Payments per day" value={String(data.orders)} detail="Processed in range" dates={series.dates} values={series.orders} unit="count" color={CHART_COLORS.count} testId="chart-payments" />
        <ChartCard label="Refunds per day" value={formatCents(data.refunded_cents)} detail="Returned in range" dates={series.dates} values={series.refunds} unit="money" color={CHART_COLORS.refunds} testId="chart-refunds" />
        <ChartCard label="Gross collections" value={formatCents(netCollected)} detail="Running total after refunds" dates={series.dates} values={cumulative(series.net)} unit="money" color={CHART_COLORS.gross} running testId="chart-gross" />
        <ChartCard label="Office net" value={formatCents(data.net_cents)} detail="Running total to your bank" dates={series.dates} values={cumulative(series.officeNet)} unit="money" color={OFFICE_NET} running testId="chart-office-net" />
      </div>

      <SectionCard
        title="Recent activity"
        sub="Latest payments, refunds, disputes and payouts for your office"
        action={
          <Link href="/activity" className={`${BTN_SECONDARY} h-8 px-3`} data-testid="link-view-activity">
            View all activity
          </Link>
        }
      >
        <RecentActivity demo={demo} navigate={navigate} />
      </SectionCard>
    </div>
  );
}

function RecentActivity({ demo, navigate }: { demo: boolean; navigate: (to: string) => void }) {
  const { range } = useDateRange();
  const query = useOfficeActivity(demo ? { limit: 6 } : { from: range.start, to: range.end, limit: 6 });
  if (demo) return <ActivityTable rows={DEMO_ACTIVITY.slice(0, 6)} navigate={navigate} showOffice={false} empty="No payment activity yet." />;
  if (query.isPending) return <Skeleton className="m-5 h-24" />;
  if (query.isError) return <div className="p-5"><ErrorBox error={query.error} retry={() => void query.refetch()} /></div>;
  const rows = query.data?.pages[0]?.items ?? [];
  return <ActivityTable rows={rows} navigate={navigate} showOffice={false} empty="No payment activity in this range yet." />;
}

/** Today's revenue by clock hour: gross, net after refunds, THINNR fees and the office net, refreshed every minute. */
function TodayRevenue({ demo }: { demo: boolean }) {
  const query = useOfficeToday();
  const data = demo ? DEMO_TODAY : query.data;
  const sub = data
    ? `${formatDate(data.date)} so far, running total by hour in ${data.time_zone.replace(/_/g, ' ')}`
    : 'Running total by hour in your local time';
  return (
    <SectionCard title="Today's revenue" sub={sub}>
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
                { label: 'Office net', value: data.profit_cents, color: OFFICE_NET, testId: 'today-office-net' },
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
      formatLabelLong={(key) => runningHourLabel(key, String(data.current_hour))}
      running
      labelCount={hourly.hours.length <= 8 ? hourly.hours.length : 8}
      emptyLabel="No payments yet today"
      series={[
        { key: 'gross', label: 'Gross collected', color: CHART_COLORS.gross, values: hourly.gross },
        { key: 'net', label: 'Net after refunds', color: CHART_COLORS.net, values: hourly.net },
        { key: 'fees', label: 'THINNR fees', color: CHART_COLORS.fees, values: hourly.fees },
        { key: 'office', label: 'Office net', color: OFFICE_NET, values: hourly.profit },
      ]}
    />
  );
}
