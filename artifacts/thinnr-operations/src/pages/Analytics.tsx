import { ArrowDownRight, ArrowUpRight, Download, Target } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { getRangeDayCount } from '@/data/analytics-range';
import { useScopedAnalyticsRange, useScopedProviders } from '@/data/scoped-data';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { LiveAnalytics, useLiveAnalyticsScope } from '@/components/office/LiveAnalytics';

const formatDelta = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

/**
 * Signed-in office staff (and HQ drilling into a real office) get the live
 * engagement/outcomes page; the guided demo keeps its synthetic, labeled deck.
 * The branch is decided from auth state, never from whether data exists.
 */
export default function Analytics() {
  const { liveEnabled, liveOffice } = useLiveAnalyticsScope();
  if (liveEnabled) return <LiveAnalytics liveOffice={liveOffice} />;
  return <DemoAnalytics />;
}

function DemoAnalytics() {
  const { range, minKey } = useDateRange();
  // Range selectors for the current scope: the program-wide originals in the
  // office demo, one account's exact split inside the HQ drill-in.
  const analyticsRange = useScopedAnalyticsRange();
  const scopedProviders = useScopedProviders();

  // Everything below derives deterministically from the shared range — the
  // header's calendar control is the only period selector for this page.
  const revenue = analyticsRange.getRevenueSummary(range);
  const comparison = analyticsRange.getRevenueComparison(range);
  const outcomes = analyticsRange.getOutcomeSummary(range);
  const cohorts = analyticsRange.getCohortRows(range);
  const conversionDelta = analyticsRange.getMaintenanceConversionDelta(range);
  const dayCount = getRangeDayCount(range);
  const rangeLabel = formatRangeLabel(range);
  const rangeLabelShort = formatRangeLabel(range, 'short');
  const dayPhrase = dayCount === 1 ? '1 day' : `${dayCount} days`;
  const priorLabel = comparison ? formatRangeLabel(comparison.priorRange) : null;
  const dataStartLabel = formatRangeLabel({ start: minKey, end: minKey });

  const providers = [...scopedProviders].sort((a, b) => b.averageOutcomes - a.averageOutcomes);

  const downloadSnapshot = () => {
    const csvCell = (value: string | number) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const rows: [string, string | number][] = [
      ['Range', rangeLabel],
      ['Start date', range.start],
      ['End date', range.end],
      ['Days', dayCount],
      ['Total revenue', revenue.total],
      ['Recurring subscriptions', revenue.recurring],
      ['New enrollments', revenue.enrollment],
      ['Revenue vs prior period', comparison ? formatDelta(comparison.deltaPercent) : 'n/a'],
      ['Prior period', priorLabel ?? 'n/a'],
      ['Average goal completion', `${outcomes.goalCompletion.toFixed(1)}%`],
      ['Average pounds lost', outcomes.avgPoundsLost.toFixed(1)],
      ['Protocol retention', `${outcomes.retention.toFixed(1)}%`],
    ];
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `thinnr-demo-outcomes-${range.start}_${range.end}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <h1 className="font-serif text-[32px] font-bold leading-tight tracking-[-.01em] text-navy" data-testid="text-page-title">
            Revenue &amp; Outcomes
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Synthetic practice performance, cohort analysis, and outcome tracking for{' '}
            <span className="font-semibold text-navy" data-testid="text-analytics-range">{rangeLabel}</span> · {dayPhrase}.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label="Download synthetic analytics CSV"
            data-testid="button-download-csv"
            onClick={downloadSnapshot}
            className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-card px-3 text-xs font-semibold text-navy shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download size={15} className="text-primary" aria-hidden="true" />
            Download CSV
          </button>
        </div>
      </div>

      {/* Main stats */}
      <div className="mb-5 grid gap-5 md:grid-cols-3">
        <Card className="p-6">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Total revenue</p>
          <div className="flex flex-wrap items-end gap-3">
            <h2 className="font-mono text-3xl font-semibold tracking-[-.05em] text-navy" data-testid="text-total-revenue">
              ${revenue.total.toLocaleString()}
            </h2>
            {comparison && (
              <span
                className={`mb-1 flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-semibold ${
                  comparison.deltaPercent >= 0 ? 'bg-accent text-primary' : 'bg-destructive/10 text-destructive'
                }`}
                data-testid="text-revenue-delta"
              >
                {comparison.deltaPercent >= 0 ? <ArrowUpRight size={14} aria-hidden="true" /> : <ArrowDownRight size={14} aria-hidden="true" />}
                {formatDelta(comparison.deltaPercent)}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground" data-testid="text-revenue-compare">
            {comparison
              ? `vs ${priorLabel} (prior ${dayPhrase})`
              : `No prior-period comparison — synthetic data starts ${dataStartLabel}.`}
          </p>
          <div className="mt-5 space-y-2 border-t border-border pt-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Recurring subscriptions</span>
              <span className="font-mono font-medium text-navy" data-testid="text-recurring-revenue">
                ${revenue.recurring.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">New enrollments</span>
              <span className="font-mono font-medium text-navy" data-testid="text-enrollment-revenue">
                ${revenue.enrollment.toLocaleString()}
              </span>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Demo outcome summary</p>
          <div className="flex flex-wrap items-end gap-3">
            <h2 className="font-mono text-3xl font-semibold tracking-[-.05em] text-navy" data-testid="text-goal-completion">
              {outcomes.goalCompletion.toFixed(1)}%
            </h2>
            <span className="mb-1 text-xs font-semibold text-muted-foreground">Goal completion</span>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">Patients completing protocols in this period.</p>
          <div className="mt-5 space-y-2 border-t border-border pt-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Avg weight loss</span>
              <span className="font-mono font-medium text-navy" data-testid="text-avg-weight-loss">
                {outcomes.avgPoundsLost.toFixed(1)} lbs
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Protocol retention</span>
              <span className="font-mono font-medium text-navy" data-testid="text-retention">
                {outcomes.retention.toFixed(1)}%
              </span>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
              <Target size={20} />
            </span>
            <h3 className="font-serif text-[15px] font-bold text-navy">Growth opportunity</h3>
            <p className="max-w-[32ch] text-xs leading-relaxed text-muted-foreground" data-testid="text-growth-opportunity">
              Maintenance stack conversions are up{' '}
              <strong className="font-semibold text-navy">{conversionDelta}%</strong> in this period. Recommend
              focusing on the Week 5 cohort.
            </p>
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Cohort table */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary px-5 py-4">
            <h2 className="font-serif text-[15px] font-bold text-navy">Cohort outcomes</h2>
            <span className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground" data-testid="text-cohort-scope">
              {rangeLabelShort}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[400px] text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-[.11em] text-muted-foreground">
                  <th className="whitespace-nowrap px-4 py-3 font-semibold">Cohort month</th>
                  <th className="whitespace-nowrap px-4 py-3 font-semibold">Avg lbs lost</th>
                  <th className="whitespace-nowrap px-4 py-3 font-semibold">Retention</th>
                  <th className="whitespace-nowrap px-4 py-3 text-right font-semibold">Performance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {cohorts.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground" data-testid="text-cohort-empty">
                      No cohort months fall inside this range.
                    </td>
                  </tr>
                ) : (
                  cohorts.map((cohort) => (
                    <tr key={cohort.monthKey} className="transition-colors hover:bg-accent/40" data-testid={`row-cohort-${cohort.monthKey}`}>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="whitespace-nowrap font-semibold text-navy">{cohort.label}</span>
                          {cohort.inProgress && (
                            <span className="whitespace-nowrap rounded-sm bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.08em] text-primary">
                              In protocol
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4 font-mono text-foreground/90">{cohort.avgLost.toFixed(1)}</td>
                      <td className="px-4 py-4 font-mono text-foreground/90">{cohort.retention}%</td>
                      <td className="px-4 py-4 text-right">
                        <div className="ml-auto h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${cohort.retention}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Provider performance */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary px-5 py-4">
            <h2 className="font-serif text-[15px] font-bold text-navy">Provider outcomes</h2>
            <span className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Program to date</span>
          </div>
          <div className="space-y-5 p-5">
            {providers.map((provider) => (
              <div key={provider.id} data-testid={`row-provider-${provider.id}`}>
                <div className="mb-2 flex justify-between gap-3 text-xs">
                  <span className="font-semibold text-navy">{provider.name}</span>
                  <span className="whitespace-nowrap font-mono text-muted-foreground">{provider.averageOutcomes}% avg goal</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${provider.averageOutcomes}%` }} />
                  </div>
                  <span className="w-20 text-right text-[10px] text-muted-foreground">{provider.activePatientCount} patients</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
