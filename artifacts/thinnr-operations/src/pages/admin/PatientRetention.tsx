/**
 * HQ Patient retention — how many patients each practice has onboarded onto
 * the platform, and how many of those are still active, still buying, or
 * have gone quiet (and for how long).
 *
 * Onboarded = a real-account patient through a practice. Active = an
 * app-activity day in the trailing 30 days (the App usage rule); inactive is
 * the exact complement, tiered by days since the last activity. Buying = a
 * paid order in the trailing 90 days or a subscription active on the date.
 * Headline figures are as of the range end; the trend samples the range
 * start, week or month ends, and the range end.
 *
 * The page can be narrowed to one practice (dropdown or a row's Focus
 * button); narrowing is purely client-side — the tiles, chart and inactive
 * breakdown read that office's row from the same payload.
 *
 * Signed-in HQ polls the rollup every 30 seconds while the page is open and
 * shows when the figures last landed. Loading, failure, and "unavailable for
 * this range" are explicit — the page never falls back to seeded numbers.
 * The signed-out guided demo renders the same screen from the deterministic
 * seeded dataset (anchored to the demo date) and issues no live request.
 */
import { useMemo, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { PatientRetentionCounts, PatientRetentionPoint, PatientRetentionResult } from '@workspace/api-client-react';
import { getGetHqPatientRetentionQueryKey, useGetHqPatientRetention } from '@workspace/api-client-react';
import { INPUT_CLASS, SectionCard } from '@/components/patient/heritage';
import { AdminPage, MetricTile, PageHeader } from '@/components/admin/primitives';
import { PatientRetentionTable } from '@/components/admin/PatientRetentionTable';
import { AreaChart, CHART_COLORS } from '@/components/billing/hq/RevenueCharts';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { useSession } from '@/contexts/session';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { demoPatientRetention } from '@/data/hq/patient-retention-demo';
import { formatDateKey } from '@/data/nutrition-data';
import { DEMO_TODAY_KEY, type OperationsDateRange } from '@/lib/date-range-keys';
import { formatLocalDate } from '@/lib/local-time';
import { formatUpdatedAt } from '@/lib/app-usage';
import {
  ACTIVE_DEFINITION,
  BUYING_DEFINITION,
  INACTIVE_TIERS,
  ONBOARDED_DEFINITION,
  PATIENT_RETENTION_REFRESH_MS,
  countRetentionUnavailable,
  retentionChartSeries,
  retentionShare,
  shareOfOnboarded,
} from '@/lib/patient-retention';

const fmt = (value: number) => value.toLocaleString('en-US');

export type PatientRetentionViewState = 'loading' | 'error' | 'ready';

interface PatientRetentionViewProps {
  state: PatientRetentionViewState;
  data: PatientRetentionResult | undefined;
  range: OperationsDateRange;
  /** Header line under the title: the "as of" date for live, the anchor for the demo. */
  asOfLabel: string;
  /** "Updated 12:04:31 PM" for live reads; the demo shows its anchor instead. */
  updatedLabel: string | null;
  /** A refresh is in flight behind already-shown figures. */
  refreshing?: boolean;
  onRetry?: () => void;
}

/** What the tiles, chart and breakdown read: the network, or one focused practice. */
interface RetentionScope {
  label: string;
  available: boolean;
  metrics: PatientRetentionCounts | null;
  series: PatientRetentionPoint[];
}

function scopeFor(data: PatientRetentionResult | undefined, focused: string | null): RetentionScope {
  const office = focused ? data?.offices.find((row) => row.providerId === focused) : undefined;
  if (office) return { label: office.officeName, available: office.available, metrics: office.metrics, series: office.series };
  return { label: 'All practices', available: data?.network.available ?? false, metrics: data?.network.metrics ?? null, series: data?.network.series ?? [] };
}

/** Shared presentation for the live and demo branches — the data source is the only difference. */
export function PatientRetentionView({ state, data, range, asOfLabel, updatedLabel, refreshing = false, onRetry }: PatientRetentionViewProps) {
  const rangeLabel = formatRangeLabel(range);
  const loading = state === 'loading';
  const failed = state === 'error';
  const rows = data?.offices ?? [];
  const [focusedRaw, setFocused] = useState<string | null>(null);
  // A focused practice that is unavailable for the new range (or gone) falls back to all practices.
  const focused = focusedRaw && rows.some((row) => row.providerId === focusedRaw && row.available) ? focusedRaw : null;
  const scope = useMemo(() => scopeFor(data, focused), [data, focused]);
  const metrics = scope.metrics;
  const noData = state === 'ready' && !scope.available;
  const unavailable = countRetentionUnavailable(rows);
  const stepLabel = data?.step === 'month' ? 'month by month' : 'week by week';

  const tileValue = (value: number | null | undefined) =>
    loading ? '—' : failed ? 'Error' : value == null ? '—' : fmt(value);
  const tileDetail = (ready: string) =>
    loading ? 'Loading live data…' : failed ? 'Failed to load' : ready;

  const chart = useMemo(() => retentionChartSeries(scope.series), [scope.series]);
  const focusOptions = rows.filter((row) => row.available);

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR HQ"
        title="Patient retention"
        sub={
          <>
            <span data-testid="text-retention-asof">{asOfLabel}</span> · Patients onboarded, active, buying and quiet as of the end of{' '}
            <span className="font-semibold text-navy" data-testid="text-retention-range">{rangeLabel}</span>
            {updatedLabel && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1" data-testid="text-retention-updated" aria-live="polite">
                  {refreshing && <RefreshCw size={11} aria-hidden="true" className="animate-spin" />}
                  {updatedLabel}
                </span>
              </>
            )}
          </>
        }
        action={<DateRangeControl />}
      />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-[80ch] text-[11px] leading-relaxed text-muted-foreground" data-testid="text-retention-definition">
          {ONBOARDED_DEFINITION} {ACTIVE_DEFINITION} {BUYING_DEFINITION}
        </p>
        <label className="block min-w-[220px]">
          <span className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Practice</span>
          <select
            data-testid="select-retention-office"
            className={`${INPUT_CLASS} mt-1 h-9 w-full`}
            value={focused ?? ''}
            disabled={loading || failed}
            onChange={(event) => setFocused(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">All practices</option>
            {focusOptions.map((row) => (
              <option key={row.providerId} value={row.providerId}>
                {row.officeName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {focused && (
        <p className="mb-3 text-xs text-navy" data-testid="text-retention-focus">
          Showing <b>{scope.label}</b>.{' '}
          <button type="button" className="underline" onClick={() => setFocused(null)} data-testid="button-retention-focus-clear">
            Show all practices
          </button>
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={`${scope.label} patient retention`}>
        <MetricTile
          label="Onboarded"
          value={tileValue(metrics?.onboarded)}
          detail={tileDetail(metrics ? `${metrics.newInRange > 0 ? `+${fmt(metrics.newInRange)}` : 'None'} new in this range` : noData ? 'Unavailable for this range' : '')}
          testId="text-retention-onboarded"
        />
        <MetricTile
          label="Active"
          value={tileValue(metrics?.active)}
          detail={tileDetail(metrics ? `Last 30 days · ${shareOfOnboarded(metrics.activePct, metrics.onboarded)}` : noData ? 'Unavailable for this range' : '')}
          testId="text-retention-active"
        />
        <MetricTile
          label="Buying"
          value={tileValue(metrics?.buying)}
          detail={tileDetail(metrics ? `${shareOfOnboarded(metrics.buyingPct, metrics.onboarded)} · ${fmt(metrics.subscribed)} on a subscription` : noData ? 'Unavailable for this range' : '')}
          testId="text-retention-buying"
        />
        <MetricTile
          label="Inactive"
          value={tileValue(metrics?.inactive)}
          detail={tileDetail(metrics ? `Quiet 30+ days or never opened · ${shareOfOnboarded(metrics.inactivePct, metrics.onboarded)}` : noData ? 'Unavailable for this range' : '')}
          testId="text-retention-inactive"
        />
      </div>

      <div className="mt-5">
        <SectionCard
          title="Patients over time"
          sub={`Onboarded, active, buying and inactive patients for ${scope.label}, ${stepLabel}, across ${rangeLabel}. Hover a point for the exact figures.`}
        >
          <div className="px-5 py-4">
            {loading ? (
              <p className="py-8 text-center text-xs text-muted-foreground" data-testid="text-retention-chart-loading">Loading patient retention…</p>
            ) : failed ? (
              <ErrorNotice testId="text-retention-chart-error" onRetry={onRetry} />
            ) : noData ? (
              <p className="py-8 text-center text-xs text-muted-foreground" data-testid="text-retention-chart-unavailable">
                No patient had been onboarded by the end of this range — figures are unavailable, not zero. Try a later range.
              </p>
            ) : (
              <AreaChart
                title={`${scope.label} patients`}
                dates={chart.dates}
                series={[
                  { key: 'onboarded', label: 'Onboarded', color: CHART_COLORS.gross, values: chart.onboarded },
                  { key: 'active', label: 'Active', color: CHART_COLORS.count, values: chart.active },
                  { key: 'buying', label: 'Buying', color: CHART_COLORS.profit, values: chart.buying },
                  { key: 'inactive', label: 'Inactive', color: CHART_COLORS.fees, values: chart.inactive },
                ]}
                unit="count"
                height={240}
                labelCount={Math.min(8, chart.dates.length)}
                emptyLabel="No onboarded patients in this range yet"
                testId="chart-patient-retention"
              />
            )}
          </div>
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard
          title="How long inactive patients have been quiet"
          sub={`Every inactive patient for ${scope.label} falls in exactly one tier, counted from their last app activity (or from onboarding if they never opened the app).`}
        >
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="group-retention-tiers">
            {INACTIVE_TIERS.map((tier) => {
              const value = metrics ? metrics[tier.key] : null;
              const share = metrics && value != null ? retentionShare(value, metrics.inactive) : null;
              return (
                <MetricTile
                  key={tier.key}
                  label={tier.label}
                  value={tileValue(value)}
                  detail={tileDetail(metrics ? `${tier.help} · ${share == null ? 'No inactive patients' : `${Math.round(share)}% of inactive`}` : noData ? 'Unavailable for this range' : '')}
                  testId={`text-retention-${tier.key}`}
                />
              );
            })}
          </div>
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard
          title="By practice"
          sub={`Every practice as of ${formatDateKey(range.end, true)}. Sort any column; rank follows the sorted metric; the last row totals every practice with data.`}
        >
          {loading ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-retention-table-loading">Loading practices…</p>
          ) : failed ? (
            <div className="m-5">
              <ErrorNotice testId="text-retention-table-error" onRetry={onRetry} />
            </div>
          ) : (
            <>
              {unavailable > 0 && (
                <p className="border-b border-border bg-secondary px-5 py-2 text-[11px] text-muted-foreground" data-testid="text-retention-unavailable-note">
                  {unavailable === rows.length
                    ? 'No practice had a patient by the end of this range — figures are unavailable, not zero. Try a later range.'
                    : `${unavailable} of ${rows.length} practices had no patient by the end of this range and are shown as unavailable.`}
                </p>
              )}
              <PatientRetentionTable rows={rows} rangeEnd={range.end} focused={focused} onFocus={setFocused} />
            </>
          )}
        </SectionCard>
      </div>
    </AdminPage>
  );
}

function ErrorNotice({ testId, onRetry }: { testId: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid={testId}>
      <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        Patient retention could not be loaded.{' '}
        {onRetry && (
          <button type="button" className="underline" onClick={onRetry}>Try again</button>
        )}
      </span>
    </div>
  );
}

function LivePatientRetention() {
  const { authUser } = useSession();
  const { range } = useDateRange();
  const params = { start: range.start, end: range.end };
  const retention = useGetHqPatientRetention(params, {
    query: {
      queryKey: [...getGetHqPatientRetentionQueryKey(params), authUser?.id],
      retry: 1,
      refetchInterval: PATIENT_RETENTION_REFRESH_MS,
    },
  });
  // A failed poll is reported, never papered over with the previous figures.
  const state: PatientRetentionViewState = retention.isPending ? 'loading' : retention.isError ? 'error' : 'ready';
  const asOfLabel = retention.data?.asOf ? formatLocalDate(retention.data.asOf) : 'Live';
  return (
    <PatientRetentionView
      state={state}
      data={retention.data}
      range={range}
      asOfLabel={asOfLabel}
      updatedLabel={formatUpdatedAt(retention.dataUpdatedAt)}
      refreshing={retention.isFetching && !retention.isPending}
      onRetry={() => retention.refetch()}
    />
  );
}

function DemoPatientRetention() {
  const { range } = useDateRange();
  const data = useMemo(() => demoPatientRetention(range), [range]);
  return (
    <PatientRetentionView
      state="ready"
      data={data}
      range={range}
      asOfLabel={formatDateKey(DEMO_TODAY_KEY, true)}
      updatedLabel="Demo figures"
    />
  );
}

export default function PatientRetention() {
  const { authStatus } = useSession();
  return authStatus === 'signed-in' ? <LivePatientRetention /> : <DemoPatientRetention />;
}
