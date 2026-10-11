/**
 * Payments overview — balance and payout tiles, today's revenue by hour
 * (running totals, refreshed every minute), the daily revenue chart, the
 * per-day cards and the latest activity, all scoped to the signed-in
 * staff member's office. Same figures and chart semantics as the office web
 * overview.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { ActivityList } from '@/components/payments/ActivityList';
import { Body, Button, ErrorBox, LoadingBox, MetricTile, MicroLabel, Panel } from '@/components/payments/primitives';
import { RangePicker, usePaymentsRange } from '@/components/payments/range';
import {
  AreaChart,
  CHART_COLORS,
  ChartCard,
  OFFICE_NET,
  cumulative,
  hourLabel,
  hourlySeriesFrom,
  runningHourLabel,
  seriesFrom,
  shortDay,
} from '@/components/payments/RevenueCharts';
import { useOfficeActivity, useOfficeDashboard, useOfficeToday } from '@/hooks/useOfficeBilling';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { formatCents, formatDate, mrrHint } from '@/lib/office-billing-format';
import type { HqTodayOverview, OfficeDashboard } from '@/lib/office-billing-types';

const TITLE = 'Payments overview';
const SUB = 'Balances, sales, fees and payouts for your office.';

export default function PaymentsOverviewScreen() {
  return (
    <PaymentsScreen
      section="overview"
      title={TITLE}
      sub={SUB}
      live={(ctx) => <LiveOverview ctx={ctx} />}
    />
  );
}

function LiveOverview({ ctx }: { ctx: PaymentsLive }) {
  const { range } = usePaymentsRange();
  const query = useOfficeDashboard(ctx.userId, { from: range.from, to: range.to });
  return (
    <>
      <RangePicker testIDPrefix="overview-range" />
      {query.isPending ? (
        <LoadingBox testID="overview-loading" />
      ) : query.isError || !query.data ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} testID="overview-error" />
      ) : (
        <OverviewView data={query.data} userId={ctx.userId} />
      )}
    </>
  );
}

/**
 * Tile grid + charts for one dashboard payload. The office sees live monthly
 * recurring revenue with the active count as its detail. MRR is server
 * computed (price × quantity normalized from cadence weeks, shipping
 * excluded) and is never derived on the phone, so it rides the dashboard
 * query's loading and error states like every other live tile.
 */
function OverviewView({ data, userId }: { data: OfficeDashboard; userId: string }) {
  const colors = useColors();
  const series = seriesFrom(data.series);
  const netCollected = data.collected_cents - data.refunded_cents;
  return (
    <>
      <Panel
        title="Office payment methods"
        sub="View or replace the bank account and cards your office uses to pay THINNR."
        action={<Button small label="Manage" testID="link-payment-methods" onPress={() => router.navigate('/payments/payment-methods' as Href)} />}
      >
        <Body>Manage both cards, bank verification, and any outstanding office balance.</Body>
      </Panel>
      <View style={styles.tiles} testID="office-overview-tiles">
        <MetricTile label="Available balance" value={formatCents(data.balance.available_cents)} hint={`${formatCents(data.balance.pending_cents)} pending`} testID="tile-available" />
        <MetricTile
          label="Next payout"
          value={data.next_payout ? formatCents(data.next_payout.amount_cents) : '—'}
          hint={data.next_payout ? `Arrives ${formatDate(data.next_payout.arrival_date)}` : 'Not scheduled'}
          testID="tile-next-payout"
        />
        <MetricTile label="Gross collected" value={formatCents(data.collected_cents)} hint={`${data.orders} payment${data.orders === 1 ? '' : 's'} in this range`} testID="tile-gross" />
        <MetricTile label="Refunds" value={formatCents(data.refunded_cents)} hint="Returned to patients" testID="tile-refunds" />
        <MetricTile label="THINNR fees" value={formatCents(data.thinnr_fee_cents)} hint="Program share of every sale" testID="tile-fees" />
        <MetricTile label="Office net" value={formatCents(data.net_cents)} hint={`After THINNR fees and ${formatCents(data.stripe_fee_cents)} in card fees`} testID="tile-office-net" />
        <MetricTile label="Monthly recurring revenue" value={formatCents(data.mrr_cents)} hint={mrrHint(data)} testID="tile-mrr" />
        <MetricTile label="Waiting to ship" value={String(data.to_ship)} hint="Packed and shipped by THINNR" testID="tile-to-ship" />
      </View>

      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Subscriptions needing attention: ${data.needs_attention_subscriptions}. Open past-due subscriptions`}
        testID="link-needs-attention"
        onPress={() => router.navigate({ pathname: '/payments/subscriptions', params: { status: 'past_due' } })}
      >
        <Panel title="Subscriptions needing attention" sub="Failed renewal payments">
          <Text style={[styles.bigNumber, { color: colors.navy }]} testID="needs-attention-count">{data.needs_attention_subscriptions}</Text>
        </Panel>
      </Pressable>

      <LiveToday userId={userId} />

      <Panel title="Daily revenue" sub="Gross collected, net after refunds, THINNR fees and your office net by day">
        <AreaChart
          title="Daily revenue"
          dates={series.dates}
          unit="money"
          testID="chart-daily-revenue"
          emptyLabel="No payments in this range yet"
          formatLabelLong={(key) => `${shortDay(key)}, ${key.slice(0, 4)}`}
          series={[
            { key: 'gross', label: 'Gross collected', color: CHART_COLORS.gross, values: series.gross },
            { key: 'net', label: 'Net after refunds', color: CHART_COLORS.net, values: series.net },
            { key: 'fees', label: 'THINNR fees', color: CHART_COLORS.fees, values: series.fees },
            { key: 'office', label: 'Office net', color: OFFICE_NET, values: series.officeNet },
          ]}
        />
      </Panel>

      <ChartCard label="Payments per day" value={String(data.orders)} detail="Processed in range" dates={series.dates} values={series.orders} unit="count" color={CHART_COLORS.count} testID="chart-payments" />
      <ChartCard label="Refunds per day" value={formatCents(data.refunded_cents)} detail="Returned in range" dates={series.dates} values={series.refunds} unit="money" color={CHART_COLORS.refunds} testID="chart-refunds" />
      <ChartCard label="Gross collections" value={formatCents(netCollected)} detail="Running total after refunds" dates={series.dates} values={cumulative(series.net)} unit="money" color={CHART_COLORS.gross} running testID="chart-gross" />
      <ChartCard label="Office net" value={formatCents(data.net_cents)} detail="Running total to your bank" dates={series.dates} values={cumulative(series.officeNet)} unit="money" color={OFFICE_NET} running testID="chart-office-net" />

      <Panel
        title="Recent activity"
        sub="Latest payments, refunds, disputes and payouts for your office"
        action={<Button small label="View all" accessibilityLabel="View all activity" testID="link-view-activity" onPress={() => router.navigate('/payments/activity')} />}
      >
        <LiveRecentActivity userId={userId} />
      </Panel>
    </>
  );
}

function LiveRecentActivity({ userId }: { userId: string }) {
  const { range } = usePaymentsRange();
  const query = useOfficeActivity(userId, { from: range.from, to: range.to, limit: 6 });
  if (query.isPending) return <LoadingBox testID="recent-activity-loading" />;
  if (query.isError) return <ErrorBox error={query.error} retry={() => void query.refetch()} testID="recent-activity-error" />;
  const rows = query.data?.pages[0]?.items ?? [];
  return <ActivityList rows={rows} empty="No payment activity in this range yet." testID="recent-activity" />;
}

/** Today's revenue by clock hour in the device time zone, refreshed every minute. */
function LiveToday({ userId }: { userId: string }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const query = useOfficeToday(userId, tz);
  if (query.isPending) return <TodayPanel data={null} body={<LoadingBox testID="today-loading" />} />;
  if (query.isError || !query.data) return <TodayPanel data={null} body={<ErrorBox error={query.error} retry={() => void query.refetch()} testID="today-error" />} />;
  return <TodayPanel data={query.data} />;
}

function TodayPanel({ data, body }: { data: HqTodayOverview | null; body?: React.ReactNode }) {
  const colors = useColors();
  const sub = data
    ? `${formatDate(data.date)} so far, running total by hour in ${data.time_zone.replace(/_/g, ' ')}`
    : 'Running total by hour in your local time';
  return (
    <Panel title="Today's revenue" sub={sub} testID="section-today-revenue">
      {body ??
        (data ? (
          <>
            <View style={styles.tiles} testID="today-totals">
              {[
                { label: 'Gross collected', value: data.collected_cents, color: CHART_COLORS.gross, testID: 'today-gross' },
                { label: 'Net after refunds', value: data.net_cents, color: CHART_COLORS.net, testID: 'today-net' },
                { label: 'THINNR fees', value: data.fee_cents, color: CHART_COLORS.fees, testID: 'today-fees' },
                { label: 'Office net', value: data.profit_cents, color: OFFICE_NET, testID: 'today-office-net' },
              ].map((tile) => (
                <View key={tile.label} style={[styles.todayTile, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
                  <View style={styles.todayLabelRow}>
                    <View style={[styles.swatch, { backgroundColor: tile.color }]} />
                    <MicroLabel>{tile.label}</MicroLabel>
                  </View>
                  <Text style={[styles.todayValue, { color: colors.navy }]} testID={tile.testID}>{formatCents(tile.value)}</Text>
                </View>
              ))}
            </View>
            <HourlyChart data={data} />
          </>
        ) : null)}
    </Panel>
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
      testID="chart-today-revenue"
      formatLabel={hourLabel}
      formatLabelLong={(key) => runningHourLabel(key, String(data.current_hour))}
      running
      labelCount={hourly.hours.length <= 8 ? hourly.hours.length : 6}
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

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  bigNumber: { fontSize: 26, fontFamily: fonts.serifBold },
  todayTile: { flexGrow: 1, flexBasis: '46%', borderWidth: 1, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  todayLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  todayValue: { fontSize: 18, fontFamily: fonts.serifBold, fontVariant: ['tabular-nums'] },
});
