/**
 * HQ App usage — live weekly and monthly active app users, network-wide and
 * per practice.
 *
 * An active app user is a real-account patient who, on a given day, opened
 * the app (presence heartbeat) or performed any server-recorded action.
 * Weekly = trailing 7 days, monthly = trailing 30 days. The "now" tiles
 * (active now / today / weekly / monthly) end on each patient's local today;
 * the trend chart and the per-practice table end on the shared range end.
 *
 * Signed-in HQ polls the rollup every 30 seconds while the page is open and
 * shows when the figures last landed. Loading, failure, and "unavailable for
 * this range" are explicit — the page never falls back to seeded numbers.
 * The signed-out guided demo renders the same screen from the deterministic
 * seeded dataset (anchored to the demo date) and issues no live request.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { AppUsageResult } from '@workspace/api-client-react';
import { getGetHqAppUsageInsightsQueryKey, getGetHqAppUsageQueryKey, useGetHqAppUsage, useGetHqAppUsageInsights } from '@workspace/api-client-react';
import type { InsightsDataset } from '@workspace/app-usage-insights';
import { SectionCard } from '@/components/patient/heritage';
import { AdminPage, MetricTile, PageHeader } from '@/components/admin/primitives';
import { AppUsageTable } from '@/components/admin/AppUsageTable';
import { AppUsageInsightsSection, type InsightsOfficeOption } from '@/components/admin/AppUsageInsights';
import { AreaChart, CHART_COLORS } from '@/components/billing/hq/RevenueCharts';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { useSession } from '@/contexts/session';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { demoAppUsage } from '@/data/hq/app-usage-demo';
import { DEMO_INSIGHTS_OFFICES, demoAppUsageInsights } from '@/data/hq/app-usage-insights-demo';
import { formatDateKey } from '@/data/nutrition-data';
import { DEMO_TODAY_KEY, type OperationsDateRange } from '@/lib/date-range-keys';
import { formatLocalDate } from '@/lib/local-time';
import { APP_USAGE_REFRESH_MS, countUnavailable, formatUpdatedAt, shareDetail, usageChartSeries } from '@/lib/app-usage';

const fmt = (value: number) => value.toLocaleString('en-US');

export const ACTIVE_USER_DEFINITION =
  'A patient with a real account counts as active on a day they open the app or log anything (meal, water, check-in, weight, photo, or coach message). Staff use does not count.';

export type AppUsageViewState = 'loading' | 'error' | 'ready';

export const DEFAULT_INSIGHTS_DATASET: InsightsDataset = 'app_open';

interface AppUsageViewProps {
  state: AppUsageViewState;
  data: AppUsageResult | undefined;
  range: OperationsDateRange;
  /** Header line under the title: the "as of" date for live, the anchor for the demo. */
  asOfLabel: string;
  /** "Updated 12:04:31 PM" for live reads; the demo shows its anchor instead. */
  updatedLabel: string | null;
  /** A refresh is in flight behind already-shown figures. */
  refreshing?: boolean;
  onRetry?: () => void;
  /** The Insights section (live or demo), rendered under the by-practice table. */
  insights?: ReactNode;
}

/** Shared presentation for the live and demo branches — the data source is the only difference. */
export function AppUsageView({ state, data, range, asOfLabel, updatedLabel, refreshing = false, onRetry, insights }: AppUsageViewProps) {
  const rangeLabel = formatRangeLabel(range);
  const loading = state === 'loading';
  const failed = state === 'error';
  const network = data?.network;
  const rows = data?.offices ?? [];
  const noData = state === 'ready' && (!network || !network.available);
  const unavailable = countUnavailable(rows);

  const tileValue = (value: number | undefined) =>
    loading ? '—' : failed ? 'Error' : value == null ? '—' : fmt(value);
  const tileDetail = (ready: string) =>
    loading ? 'Loading live data…' : failed ? 'Failed to load' : ready;

  const chart = useMemo(() => usageChartSeries(network?.series ?? []), [network?.series]);

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR HQ"
        title="App usage"
        sub={
          <>
            <span data-testid="text-app-usage-asof">{asOfLabel}</span> · Active app users for{' '}
            <span className="font-semibold text-navy" data-testid="text-app-usage-range">{rangeLabel}</span>
            {updatedLabel && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1" data-testid="text-app-usage-updated" aria-live="polite">
                  {refreshing && <RefreshCw size={11} aria-hidden="true" className="animate-spin" />}
                  {updatedLabel}
                </span>
              </>
            )}
          </>
        }
        action={<DateRangeControl />}
      />

      <p className="mb-4 max-w-[80ch] text-[11px] leading-relaxed text-muted-foreground" data-testid="text-app-usage-definition">
        {ACTIVE_USER_DEFINITION}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Network app usage">
        <MetricTile
          label="Active now"
          value={tileValue(network?.activeNow)}
          detail={tileDetail(network ? `Last 15 minutes · ${shareDetail(network.activeNowSharePct, network.activatedPatients)}` : '')}
          testId="text-usage-active-now"
        />
        <MetricTile
          label="Active today"
          value={tileValue(network?.activeToday)}
          detail={tileDetail(network ? `Each patient's local day · ${shareDetail(network.activeTodaySharePct, network.activatedPatients)}` : '')}
          testId="text-usage-active-today"
        />
        <MetricTile
          label="Weekly active"
          value={tileValue(network?.weeklyActive)}
          detail={tileDetail(network ? `Trailing 7 days · ${shareDetail(network.weeklySharePct, network.activatedPatients)}` : '')}
          testId="text-usage-weekly"
        />
        <MetricTile
          label="Monthly active"
          value={tileValue(network?.monthlyActive)}
          detail={tileDetail(network ? `Trailing 30 days · ${shareDetail(network.monthlySharePct, network.activatedPatients)}` : '')}
          testId="text-usage-monthly"
        />
      </div>

      <div className="mt-5">
        <SectionCard
          title="Active users over time"
          sub={`Rolling weekly and monthly active app users, day by day, for ${rangeLabel}. Hover a day for the exact figures.`}
        >
          <div className="px-5 py-4">
            {loading ? (
              <p className="py-8 text-center text-xs text-muted-foreground" data-testid="text-app-usage-chart-loading">Loading app usage…</p>
            ) : failed ? (
              <ErrorNotice testId="text-app-usage-chart-error" onRetry={onRetry} />
            ) : noData ? (
              <p className="py-8 text-center text-xs text-muted-foreground" data-testid="text-app-usage-chart-unavailable">
                No office has an activated patient in this range — figures are unavailable, not zero. Try a later range.
              </p>
            ) : (
              <AreaChart
                title="Active app users"
                dates={chart.dates}
                series={[
                  { key: 'weekly', label: 'Weekly active', color: CHART_COLORS.count, values: chart.weekly },
                  { key: 'monthly', label: 'Monthly active', color: CHART_COLORS.gross, values: chart.monthly },
                ]}
                unit="count"
                height={220}
                emptyLabel="No app activity in this range yet"
                testId="chart-app-usage"
              />
            )}
          </div>
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard
          title="By practice"
          sub={`Weekly and monthly active app users per office as of ${formatDateKey(range.end, true)}. Sort any column; rank follows the sorted metric.`}
        >
          {loading ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-app-usage-table-loading">Loading practices…</p>
          ) : failed ? (
            <div className="m-5">
              <ErrorNotice testId="text-app-usage-table-error" onRetry={onRetry} />
            </div>
          ) : (
            <>
              {unavailable > 0 && (
                <p className="border-b border-border bg-secondary px-5 py-2 text-[11px] text-muted-foreground" data-testid="text-app-usage-unavailable-note">
                  {unavailable === rows.length
                    ? 'No office has recorded data in this range — figures are unavailable, not zero. Try a later range.'
                    : `${unavailable} of ${rows.length} offices have no data in this range and are shown as unavailable.`}
                </p>
              )}
              <AppUsageTable rows={rows} rangeEnd={range.end} />
            </>
          )}
        </SectionCard>
      </div>

      {insights}
    </AdminPage>
  );
}

/** Insights filters shared by the live and demo branches: dataset chip + practice, reset to "all" when the chosen office disappears. */
function useInsightsFilters(offices: InsightsOfficeOption[]) {
  const [dataset, setDataset] = useState<InsightsDataset>(DEFAULT_INSIGHTS_DATASET);
  const [office, setOffice] = useState<string | null>(null);
  const known = office !== null && offices.some((candidate) => candidate.id === office) ? office : null;
  return { dataset, setDataset, office: known, setOffice };
}

function ErrorNotice({ testId, onRetry }: { testId: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid={testId}>
      <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        App usage could not be loaded.{' '}
        {onRetry && (
          <button type="button" className="underline" onClick={onRetry}>Try again</button>
        )}
      </span>
    </div>
  );
}

function LiveAppUsage() {
  const { authUser } = useSession();
  const { range } = useDateRange();
  const params = { start: range.start, end: range.end };
  const usage = useGetHqAppUsage(params, {
    query: {
      queryKey: [...getGetHqAppUsageQueryKey(params), authUser?.id],
      retry: 1,
      refetchInterval: APP_USAGE_REFRESH_MS,
    },
  });

  // A failed poll is reported, never papered over with the previous figures.
  const state: AppUsageViewState = usage.isPending ? 'loading' : usage.isError ? 'error' : 'ready';
  const asOfLabel = usage.data?.asOf ? formatLocalDate(usage.data.asOf) : 'Live';

  // Practice options come from the same rollup the table shows (enabled offices only).
  const offices = useMemo<InsightsOfficeOption[]>(
    () => (usage.data?.offices ?? []).map((row) => ({ id: row.providerId, name: row.officeName })),
    [usage.data?.offices],
  );
  const filters = useInsightsFilters(offices);
  const insightsParams = { dataset: filters.dataset, start: range.start, end: range.end, ...(filters.office ? { office: filters.office } : {}) };
  const insights = useGetHqAppUsageInsights(insightsParams, {
    query: {
      queryKey: [...getGetHqAppUsageInsightsQueryKey(insightsParams), authUser?.id],
      retry: 1,
      refetchInterval: APP_USAGE_REFRESH_MS,
      placeholderData: (previous) => previous,
    },
  });
  const insightsState = insights.isPending ? 'loading' : insights.isError ? 'error' : 'ready';
  return (
    <AppUsageView
      state={state}
      data={usage.data}
      range={range}
      asOfLabel={asOfLabel}
      updatedLabel={formatUpdatedAt(usage.dataUpdatedAt)}
      refreshing={usage.isFetching && !usage.isPending}
      onRetry={() => usage.refetch()}
      insights={
        <AppUsageInsightsSection
          state={insightsState}
          data={insights.data}
          dataset={filters.dataset}
          onDataset={filters.setDataset}
          offices={offices}
          office={filters.office}
          onOffice={filters.setOffice}
          rangeLabel={formatRangeLabel(range)}
          onRetry={() => insights.refetch()}
        />
      }
    />
  );
}

function DemoAppUsage() {
  const { range } = useDateRange();
  const data = useMemo(() => demoAppUsage(range), [range]);
  const filters = useInsightsFilters(DEMO_INSIGHTS_OFFICES);
  const insights = useMemo(() => demoAppUsageInsights(filters.dataset, range, filters.office), [filters.dataset, filters.office, range]);
  return (
    <AppUsageView
      state="ready"
      data={data}
      range={range}
      asOfLabel={formatDateKey(DEMO_TODAY_KEY, true)}
      updatedLabel="Demo figures"
      insights={
        <AppUsageInsightsSection
          state="ready"
          data={insights}
          dataset={filters.dataset}
          onDataset={filters.setDataset}
          offices={DEMO_INSIGHTS_OFFICES}
          office={filters.office}
          onOffice={filters.setOffice}
          rangeLabel={formatRangeLabel(range)}
        />
      }
    />
  );
}

export default function AppUsage() {
  const { authStatus } = useSession();
  return authStatus === 'signed-in' ? <LiveAppUsage /> : <DemoAppUsage />;
}
