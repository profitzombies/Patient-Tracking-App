/**
 * Live office analytics — the signed-in replacement for the synthetic
 * Revenue & Outcomes page.
 *
 * Reads one office's range metrics + daily series from the API (own office
 * for provider staff, the drilled-in office for HQ), shows engagement,
 * enrollments, outcomes, and check-in adherence for the shared header range,
 * hosts the office's "When patients use the app" insights, and its Exports
 * panel. Financial figures are deliberately absent: there is no live revenue
 * source, so nothing is projected.
 */
import { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Sparkline } from '@/components/admin/Sparkline';
import { OfficeRangeMetricsGrid } from '@/components/office/OfficeRangeMetricsGrid';
import { LiveOfficeAppUsageInsights } from '@/components/office/OfficeAppUsageInsights';
import { ExportsPanel, type ExportOfficeOption } from '@/components/exports/ExportsPanel';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { useProviderScope } from '@/contexts/provider-scope';
import { useSession } from '@/contexts/session';
import { getRangeDayCount } from '@/data/analytics-range';
import { formatMetric, formatPercent, hqOfficeRoot, percentOf, seriesTotal, seriesValues, unavailableReason } from '@/lib/office-analytics';
import { useGetOfficeAnalytics, getGetOfficeAnalyticsQueryKey, type OfficeSeriesPoint } from '@workspace/api-client-react';

/** True when the current viewer should see live analytics instead of the synthetic deck. */
export function useLiveAnalyticsScope() {
  const { authStatus, authRole } = useSession();
  const scope = useProviderScope();
  const liveEnabled =
    authStatus === 'signed-in' &&
    (authRole === 'provider_staff' || (authRole === 'hq_admin' && Boolean(scope?.providerId)));
  const liveOffice = authRole === 'hq_admin' ? (scope?.providerId ?? null) : null;
  return { liveEnabled, liveOffice, scope };
}

function StatCard({
  label,
  value,
  detail,
  series,
  seriesLabel,
  testId,
}: {
  label: string;
  value: string;
  detail: string;
  series?: number[];
  seriesLabel?: string;
  testId: string;
}) {
  return (
    <Card className="p-6">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-mono text-3xl font-semibold tracking-[-.05em] text-navy" data-testid={testId}>{value}</h2>
        {series && seriesLabel && <Sparkline values={series} label={seriesLabel} width={110} height={28} testId={`${testId}-trend`} />}
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">{detail}</p>
    </Card>
  );
}

/** Daily bars: engaged over active, one column per day. Pure SVG, announced as a summary. */
function DailyEngagementChart({ series, rangeLabel }: { series: OfficeSeriesPoint[]; rangeLabel: string }) {
  if (series.length === 0) {
    return <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-analytics-series-empty">No daily points in this range.</p>;
  }
  const width = 640;
  const height = 140;
  const pad = 4;
  const max = Math.max(1, ...series.map((point) => point.activePatients));
  const slot = (width - pad * 2) / series.length;
  const barW = Math.max(1, slot * 0.6);
  const peakEngaged = Math.max(0, ...series.map((point) => point.engagedPatients));
  const lastEngaged = series[series.length - 1]?.engagedPatients ?? 0;
  const summary = `Daily active patients and rolling 7-day engaged patients for ${rangeLabel}: ${series.length} days, peak active ${max}, peak engaged ${peakEngaged}, ${lastEngaged} engaged in the final 7-day window.`;
  return (
    <div className="px-5 py-4">
      <svg role="img" aria-label={summary} viewBox={`0 0 ${width} ${height}`} className="h-[140px] w-full" data-testid="chart-analytics-daily">
        {series.map((point, index) => {
          const x = pad + index * slot + (slot - barW) / 2;
          const activeH = (point.activePatients / max) * (height - pad * 2);
          const engagedH = (point.engagedPatients / max) * (height - pad * 2);
          return (
            <g key={point.date}>
              <rect x={x} y={height - pad - activeH} width={barW} height={activeH} className="fill-primary/20" />
              <rect x={x} y={height - pad - engagedH} width={barW} height={engagedH} className="fill-primary" />
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-primary" aria-hidden="true" /> Engaged (7-day window)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-primary/20" aria-hidden="true" /> Active</span>
        <span className="ml-auto">{series[0].date} → {series[series.length - 1].date}</span>
      </div>
    </div>
  );
}

export function LiveAnalytics({ liveOffice }: { liveOffice: string | null }) {
  const { authUser, claimedWorkspace } = useSession();
  const { range } = useDateRange();
  const scope = useProviderScope();
  const params = { start: range.start, end: range.end, office: liveOffice ?? undefined };
  const analytics = useGetOfficeAnalytics(params, {
    query: { queryKey: [...getGetOfficeAnalyticsQueryKey(params), authUser?.id], retry: 1 },
  });

  const rangeLabel = formatRangeLabel(range);
  const dayCount = getRangeDayCount(range);
  const dayPhrase = dayCount === 1 ? '1 day' : `${dayCount} days`;
  const result = analytics.data;
  const status = analytics.isPending ? 'loading' : analytics.isError ? 'error' : 'ready';
  const metrics = result?.available ? result.metrics : null;
  const series = result?.available ? result.series : [];
  const officeRoot = liveOffice ? hqOfficeRoot(liveOffice) : '';

  const pinnedOffice: ExportOfficeOption = useMemo(() => {
    if (result?.office) return { id: liveOffice ? result.office.providerId : '', name: result.office.officeName };
    if (scope) return { id: scope.providerId, name: scope.officeName };
    return { id: '', name: claimedWorkspace?.officeName ?? 'your office' };
  }, [result, liveOffice, scope, claimedWorkspace]);

  const officeName = result?.office.officeName ?? scope?.officeName ?? claimedWorkspace?.officeName ?? 'this office';
  const engagementPct = metrics ? percentOf(metrics.engaged, metrics.activePatients) : null;
  const checkInsInRange = seriesTotal(series, 'checkIns');
  const stat = (ready: string) => (status === 'loading' ? '—' : status === 'error' ? 'Error' : !metrics ? 'Unavailable' : ready);

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <h1 className="font-serif text-[32px] font-bold leading-tight tracking-[-.01em] text-navy" data-testid="text-page-title">
            Engagement &amp; Outcomes
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Live figures for <span className="font-semibold text-navy" data-testid="text-analytics-office">{officeName}</span> over{' '}
            <span className="font-semibold text-navy" data-testid="text-analytics-range">{rangeLabel}</span> · {dayPhrase}. Change the range from the header calendar.
          </p>
        </div>
        <span className="inline-flex h-7 items-center rounded border border-accent-border bg-accent px-2 text-[10px] font-bold uppercase tracking-[.12em] text-primary" data-testid="badge-analytics-live">
          Live data
        </span>
      </div>

      {status === 'error' && (
        <div className="mb-5 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid="text-analytics-error">
          <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            Live analytics could not be loaded for this office.{' '}
            <button type="button" className="underline" onClick={() => analytics.refetch()}>Try again</button>
          </span>
        </div>
      )}
      {status === 'ready' && result && !metrics && (
        <div className="mb-5 rounded-md border border-border bg-secondary px-4 py-3 text-xs text-muted-foreground" role="status" data-testid="text-analytics-unavailable">
          <b className="font-semibold text-navy">Unavailable for this range.</b> {unavailableReason(result.firstPatientDate, range.end)}
        </div>
      )}

      <div className="mb-5 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Engagement"
          value={stat(formatPercent(engagementPct))}
          detail={metrics ? `${metrics.engaged} of ${metrics.activePatients} active patients engaged in the 7 days ending ${range.end}.` : 'Share of active patients engaging weekly.'}
          series={seriesValues(series, 'engagedPatients')}
          seriesLabel="engaged patients"
          testId="text-analytics-engagement"
        />
        <StatCard
          label="Enrollments"
          value={stat(formatMetric('enrollments', metrics?.enrollments ?? null))}
          detail={metrics ? `Patients who joined ${officeName} during this range.` : 'New patients in the range.'}
          series={seriesValues(series, 'enrollments')}
          seriesLabel="daily enrollments"
          testId="text-analytics-enrollments"
        />
        <StatCard
          label="Outcomes"
          value={stat(metrics?.avgPoundsLost == null ? '—' : `${metrics.avgPoundsLost.toFixed(1)} lbs`)}
          detail={metrics ? (metrics.avgPoundsLost == null ? 'No recorded weights yet for active patients.' : 'Average pounds lost across active patients with a recorded weight.') : 'Average pounds lost.'}
          testId="text-analytics-outcomes"
        />
        <StatCard
          label="Check-in adherence"
          value={stat(formatPercent(metrics?.checkInAdherencePct ?? null))}
          detail={metrics ? `${metrics.checkInPatients} of ${metrics.activePatients} active patients checked in during the last 7 days · ${checkInsInRange} check-ins across the range.` : 'Active patients checking in weekly.'}
          series={seriesValues(series, 'checkIns')}
          seriesLabel="daily check-ins"
          testId="text-analytics-checkins"
        />
      </div>

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary px-5 py-4">
            <h2 className="font-serif text-[15px] font-bold text-navy">Roster figures</h2>
            <span className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">As of {range.end}</span>
          </div>
          <OfficeRangeMetricsGrid
            status={status}
            result={result}
            rangeEnd={range.end}
            officeRoot={officeRoot}
            onRetry={() => analytics.refetch()}
            testIdPrefix="analytics-metric"
          />
        </Card>
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary px-5 py-4">
            <h2 className="font-serif text-[15px] font-bold text-navy">Daily engagement</h2>
            <span className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">{formatRangeLabel(range, 'short')}</span>
          </div>
          {status === 'loading' ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground">Loading daily series…</p>
          ) : status === 'error' ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground">Daily series unavailable while the office metrics fail to load.</p>
          ) : (
            <DailyEngagementChart series={series} rangeLabel={rangeLabel} />
          )}
        </Card>
      </div>

      <LiveOfficeAppUsageInsights liveOffice={liveOffice} />

      <ExportsPanel pinnedOffice={pinnedOffice} title="Exports" />
    </div>
  );
}
