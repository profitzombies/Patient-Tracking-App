import { useMemo, useState, ReactNode } from "react";
import { Link } from "wouter";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  ClipboardList,
  Filter,
  MoreHorizontal,
  ShieldAlert,
  Users,
  WalletCards,
  X
} from "lucide-react";
import { LAPSED_AFTER_DAYS, TODAY_KEY, formatDateKey, getLoggingStats, isLapsed } from "@/data/nutrition-data";
import { useProviderScope } from "@/contexts/provider-scope";
import {
  useScopedAnalytics,
  useScopedChangeBadges,
  useScopedDailyRevenue,
  useScopedPatients,
  useScopedProviders,
  useScopedSubscriptions,
} from "@/data/scoped-data";
import { useToast } from "@/hooks/use-toast";
import { usePatientSession } from "@/contexts/patient-session";
import { useDateRange, type OperationsDateRange, formatRangeLabel, addDaysToKey, keyToDate } from "@/contexts/date-range";
import { useSession } from "@/contexts/session";
import { useLiveRoster } from "@/hooks/use-live-roster";
import { useOfficeDashboard } from "@/hooks/use-billing";
import { useTimeOfDayGreeting } from "@/hooks/use-local-clock";
import { formatLocalDate } from "@/lib/local-time";
import { BillingApiError } from "@/lib/billing-api";
import { buildLiveRevenueView, liveRevenueWindow, rangeDayCount, type LiveRevenueView } from "@/lib/overview-live-revenue";
import { isActivatedRosterPatient, rosterActivityFor, rosterHasReason, rosterReasonHref } from "@/lib/roster-activity";
import { AreaChart, CHART_COLORS } from "@/components/billing/hq/RevenueCharts";
import { ChartSkeleton, LoadingRegion, RowsSkeleton } from "@/components/office/ProviderLoading";
import { Skeleton } from "@/components/ui/skeleton";
import { greetingName } from "@/lib/greeting-name";
import { useGetOfficeEngagementTrends, getGetOfficeEngagementTrendsQueryKey, type EngagementTrendPoint, useGetOfficeOverview, getGetOfficeOverviewQueryKey } from "@workspace/api-client-react";

function ActionButton({ label, testId, children, onClick }: { label: string; testId?: string; children: ReactNode; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-card text-primary shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function Metric({ icon, label, value, change, detail, warning = false, loading = false }: { icon: ReactNode; label: string; value: string; change: string; detail: string; warning?: boolean; loading?: boolean }) {
  return (
    <div className="rounded-lg border border-card-border bg-card p-4 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lifted">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">
          <span className="text-primary">{icon}</span>{label}
        </span>
        {loading ? <Skeleton className="h-6 w-20" aria-hidden="true" /> : (
          <span className={`rounded-sm border px-2 py-1 text-[10px] font-bold ${warning ? "border-warn-border bg-warn-bg text-warn" : "border-accent-border bg-accent text-primary"}`}>
            {change}
          </span>
        )}
      </div>
      {loading ? (
        <LoadingRegion label={`Loading ${label}`} className="mt-4 space-y-2" testId={`loading-metric-${label.toLowerCase().replace(/\s+/g, '-')}`}>
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-3 w-36 max-w-full" />
        </LoadingRegion>
      ) : (
        <>
          <p className="mt-4 font-mono text-[27px] font-semibold tracking-[-.07em] text-navy">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isHealthy = status === 'active' || status === 'graduated' || status === 'on_track';
  const isWatch = status === 'paused' || status === 'needs_attention' || status === 'invited';

  const styles = isHealthy
    ? "border-accent-border bg-accent text-primary"
    : isWatch
    ? "border-warn-border bg-warn-bg text-warn"
    : "border-destructive/40 bg-destructive/10 text-destructive";

  const displayStatus = status.replace('_', ' ');

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[.05em] ${styles}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {displayStatus}
    </span>
  );
}

// ─── Revenue trend derived from the shared date range ────────────────────────
// Buckets the selected demo days (≤12 bars) over the deterministic per-day
// revenue series; the headline totals the range and compares it against the
// prior window of the same length. Everything derives from date keys, never
// the viewer's clock.

interface RevenueBucket {
  startKey: string;
  endKey: string;
  label: string;
  total: number;
}

interface RevenueView {
  buckets: RevenueBucket[];
  total: number;
  deltaPct: number;
  dayCount: number;
  axisMax: number;
}

const dayLabel = (key: string) => keyToDate(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const formatMoney = (value: number): string =>
  value >= 1000 ? `$${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : `$${Math.round(value)}`;

/** Round a chart maximum up to a friendly axis ceiling (1/2/2.5/5 × 10^n). */
const niceCeil = (value: number): number => {
  if (value <= 0) return 1000;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
};

function buildRevenueView(range: OperationsDateRange, revenueOf: (dateKey: string) => number): RevenueView {
  const keys: string[] = [];
  for (let key = range.start; key <= range.end; key = addDaysToKey(key, 1)) keys.push(key);
  const dayCount = keys.length;

  const bucketSize = Math.ceil(dayCount / 12);
  const buckets: RevenueBucket[] = [];
  for (let i = 0; i < keys.length; i += bucketSize) {
    const slice = keys.slice(i, i + bucketSize);
    buckets.push({
      startKey: slice[0],
      endKey: slice[slice.length - 1],
      label: dayLabel(slice[0]),
      total: slice.reduce((sum, key) => sum + revenueOf(key), 0),
    });
  }

  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  let previousTotal = 0;
  for (let i = 1; i <= dayCount; i++) previousTotal += revenueOf(addDaysToKey(range.start, -i));
  const deltaPct = previousTotal > 0 ? ((total - previousTotal) / previousTotal) * 100 : 0;
  const axisMax = niceCeil(Math.max(...buckets.map((bucket) => bucket.total)));

  return { buckets, total, deltaPct, dayCount, axisMax };
}

/** Office subscriptions list filtered to failed renewal payments (past due + unpaid). */
const FAILED_PAYMENTS_HREF = '/payments/subscriptions?status=needs_attention';
/** Payments setup for an office that has not connected an account yet. */
const PAYMENTS_SETUP_HREF = '/payments/get-paid';

// ─── Live Revenue Trend (signed-in office) ───────────────────────────────────
// Real collected / net-after-refunds series from the office billing dashboard
// for the shared date range. Shares the payments area's AreaChart: readout
// only while hovered or focused, signed domain (a refund day can net below
// zero). The delta is shown only when the prior window has revenue.

function LiveRevenueSection({ range, view, pending, forbidden, error, accountConnected, retry }: {
  range: OperationsDateRange;
  view: LiveRevenueView | null;
  pending: boolean;
  forbidden: boolean;
  error: Error | null;
  accountConnected: boolean | null;
  retry: () => void;
}) {
  const dayCount = view?.dayCount ?? rangeDayCount(range);
  const priorLabel = dayCount === 1 ? 'day' : `${dayCount} days`;
  const total = view ? formatMoney(view.totalCents / 100) : pending ? '—' : forbidden ? '—' : 'Error';
  const empty = view !== null && view.gross.every((value) => value === 0) && view.net.every((value) => value === 0);
  return (
    <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft" data-testid="section-revenue-live">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Revenue Trend</p>
            <span className="rounded-sm border border-accent-border bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">Live billing</span>
          </div>
          <div className="mt-1 flex items-end gap-3">
            <h2 className="font-mono text-2xl font-semibold tracking-[-.05em] text-navy" data-testid="text-revenue-total">
              {total}
            </h2>
            {view && view.deltaPct !== null ? (
              <span
                data-testid="text-revenue-delta"
                className={`mb-1 flex items-center gap-1 text-xs font-semibold ${view.deltaPct >= 0 ? 'text-primary' : 'text-warn'}`}
              >
                {view.deltaPct >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {Math.abs(view.deltaPct).toFixed(1)}%
              </span>
            ) : view ? (
              <span data-testid="text-revenue-delta" className="mb-1 text-xs font-semibold text-muted-foreground">
                No prior period to compare
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="text-revenue-range">
            {formatRangeLabel(range)} · {view?.deltaPct !== null && view ? `vs prior ${priorLabel}` : 'Gross collected'}
          </p>
        </div>
        <Link href="/payments" className="text-xs font-semibold text-primary transition-colors hover:text-navy" data-testid="link-revenue-payments">
          Payments <ArrowUpRight size={13} className="inline" />
        </Link>
      </div>
      <div className="mt-5">
        {pending ? (
          <ChartSkeleton label="Loading revenue trend" height={220} testId="revenue-loading" />
        ) : forbidden ? (
          <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed border-border px-6 text-center text-xs text-muted-foreground" data-testid="revenue-forbidden">
            Payments reports are available to office owners and admins.
          </div>
        ) : error || !view ? (
          <div className="flex h-[220px] flex-col items-center justify-center gap-2 text-xs text-destructive" role="alert" data-testid="revenue-error">
            <span>{error instanceof Error && error.message ? error.message : 'Failed to load revenue.'}</span>
            <button type="button" onClick={retry} className="rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Try again
            </button>
          </div>
        ) : accountConnected === false ? (
          <div className="flex h-[220px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 text-center text-xs text-muted-foreground" data-testid="revenue-no-account">
            <span>No payments account is connected yet, so there is no revenue to show.</span>
            <Link href={PAYMENTS_SETUP_HREF} className="font-semibold text-primary underline underline-offset-4 transition-colors hover:text-navy" data-testid="link-payments-setup">
              Set up payments
            </Link>
          </div>
        ) : (
          <AreaChart
            title="Revenue trend"
            dates={view.dates}
            unit="money"
            testId="chart-revenue-live"
            emptyLabel={empty ? 'No payments in this range yet' : undefined}
            series={[
              { key: 'gross', label: 'Gross collected', color: CHART_COLORS.gross, values: view.gross },
              { key: 'net', label: 'Net after refunds', color: CHART_COLORS.net, values: view.net },
            ]}
          />
        )}
      </div>
    </section>
  );
}

function EngagementTrendChart({ points }: { points: EngagementTrendPoint[] }) {
  const axisMax = niceCeil(Math.max(10, ...points.map((pt) => pt.active_patients)));
  const crowdedLabels = points.length > 14;

  return (
    <div
      className="relative mt-5"
      role="img"
      aria-label={`Engagement trend over ${points.length} days`}
    >
      <div className="relative h-[190px]" aria-hidden="true">
        <div className="absolute inset-0 flex flex-col justify-between text-[10px] text-muted-foreground">
          {[1, 0.75, 0.5, 0.25, 0].map((step) => (
            <div key={step} className="flex items-center gap-3">
              <span className="w-9 text-right font-mono">{Math.round(axisMax * step)}</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          ))}
        </div>
        <div className="absolute bottom-0 left-12 right-0 top-1 flex items-end gap-[clamp(2px,0.5vw,8px)]">
          {points.map((pt) => {
            const dateStr = dayLabel(pt.date);
            return (
              <div key={pt.date} className="group relative flex h-full flex-1 items-end">
                {/* Background bar for active patients */}
                <div
                  className="absolute bottom-0 w-full rounded-t-sm bg-accent transition-colors group-hover:bg-accent/80"
                  style={{ height: `${Math.max(2, (pt.active_patients / axisMax) * 100)}%` }}
                />
                {/* Foreground bar for engaged patients */}
                <div
                  className="absolute bottom-0 w-full rounded-t-sm bg-primary transition-colors group-hover:bg-navy"
                  style={{ height: `${Math.max(2, (pt.engaged_patients / axisMax) * 100)}%` }}
                />
                <span className="absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-navy px-2 py-1 text-[10px] font-semibold text-primary-foreground shadow-lifted group-hover:block">
                  {dateStr} · {pt.engaged_patients} engaged ({pt.active_patients} active)
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex gap-[clamp(2px,0.5vw,8px)] pl-12 text-[10px] text-muted-foreground">
        {points.map((pt, index) => (
          <span
            key={pt.date}
            className={`min-w-0 flex-1 truncate text-center ${crowdedLabels && index % 3 !== 0 ? "invisible sm:visible" : ""}`}
          >
            {keyToDate(pt.date).toLocaleDateString('en-US', { day: 'numeric' })}
          </span>
        ))}
      </div>
    </div>
  );
}

function TrendChart({ view }: { view: RevenueView }) {
  const { buckets, axisMax } = view;
  const crowdedLabels = buckets.length > 9;

  return (
    <div
      className="relative mt-5"
      role="img"
      aria-label={`Revenue trend, ${buckets.length === 1 ? 'one period' : `${buckets.length} periods`}, total ${formatMoney(view.total)}`}
    >
      <div className="relative h-[190px]" aria-hidden="true">
        <div className="absolute inset-0 flex flex-col justify-between text-[10px] text-muted-foreground">
          {[1, 0.75, 0.5, 0.25, 0].map((step) => (
            <div key={step} className="flex items-center gap-3">
              <span className="w-9 text-right font-mono">{step === 0 ? "$0" : formatMoney(axisMax * step)}</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          ))}
        </div>
        <div className="absolute bottom-0 left-12 right-0 top-1 flex items-end gap-[clamp(4px,1vw,14px)]">
          {buckets.map((bucket) => (
            <div key={bucket.startKey} className="group relative flex h-full flex-1 items-end">
              <div
                className="w-full rounded-t-sm bg-primary transition-colors group-hover:bg-navy"
                style={{ height: `${Math.max(4, (bucket.total / axisMax) * 100)}%` }}
              />
              <span className="absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-navy px-2 py-1 text-[10px] font-semibold text-primary-foreground shadow-lifted group-hover:block">
                {bucket.startKey === bucket.endKey
                  ? `${dayLabel(bucket.startKey)} · ${formatMoney(bucket.total)}`
                  : `${dayLabel(bucket.startKey)} – ${dayLabel(bucket.endKey)} · ${formatMoney(bucket.total)}`}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex gap-[clamp(4px,1vw,14px)] pl-12 text-[10px] text-muted-foreground" data-testid="row-trend-labels">
        {buckets.map((bucket, index) => (
          <span
            key={bucket.startKey}
            className={`min-w-0 flex-1 truncate text-center ${crowdedLabels && index % 2 === 1 ? "invisible md:visible" : ""}`}
          >
            {bucket.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// "First name + last initial", mirroring the program literals ("Emma S.").
// Module-level so the live-roster memos above the component's first use can
// call it during render (a const declared later in the body is in its TDZ).
function shortName(patient?: { name: string }) {
  if (!patient) return 'a patient';
  const [first, ...rest] = patient.name.split(' ');
  const last = rest[rest.length - 1];
  return last ? `${first} ${last[0]}.` : first;
}

export default function Overview() {
  const { getCurrentWeight } = usePatientSession();
  const { range } = useDateRange();
  const [showNotice, setShowNotice] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const [providerFilter, setProviderFilter] = useState('all');
  const { toast } = useToast();
  // HQ drill-in scope: when present, every read below narrows to one office;
  // unscoped, the scoped hooks return the program-wide singletons unchanged.
  const scope = useProviderScope();
  const { data: liveRosterData, dataUpdatedAt: liveRosterUpdatedAt, isLoading: liveRosterIsLoading, isError: liveRosterIsError, liveEnabled, liveOffice } = useLiveRoster();
  const { authUser } = useSession();
  const localGreeting = useTimeOfDayGreeting();

  const { data: overviewData, isLoading: overviewIsLoading, isError: overviewIsError } = useGetOfficeOverview(
    { office: liveOffice ?? undefined },
    {
      query: {
        enabled: liveEnabled,
        queryKey: [...getGetOfficeOverviewQueryKey({ office: liveOffice ?? undefined }), authUser?.id]
      }
    }
  );

  const { data: engagementData, isLoading: engagementIsLoading, isError: engagementIsError, error: engagementError } = useGetOfficeEngagementTrends(
    { start: range.start, end: range.end, office: liveOffice ?? undefined },
    {
      query: {
        enabled: liveEnabled,
        queryKey: [...getGetOfficeEngagementTrendsQueryKey({ start: range.start, end: range.end, office: liveOffice ?? undefined }), authUser?.id]
      }
    }
  );

  // Live finance: one office billing dashboard request spanning the prior
  // window and the selected range feeds the MRR tile, the Revenue Trend and
  // the failed-payments card. Disabled (no request) for the demo persona.
  const revenueWindow = useMemo(() => liveRevenueWindow(range), [range]);
  const billing = useOfficeDashboard({ from: revenueWindow.from, to: revenueWindow.to });
  const billingForbidden = billing.isError && billing.error instanceof BillingApiError && billing.error.status === 403;
  const liveRevenueView = useMemo(
    () => (billing.data ? buildLiveRevenueView(range, billing.data.series) : null),
    [billing.data, range],
  );

  const analytics = useScopedAnalytics();
  const patients = useScopedPatients();
  const providers = useScopedProviders();
  const subscriptions = useScopedSubscriptions();
  const revenueOf = useScopedDailyRevenue();
  const badges = useScopedChangeBadges();

  const revenueView = useMemo(() => buildRevenueView(range, revenueOf), [range, revenueOf]);

  const filteredPatients = useMemo(
    () => patients.filter((patient) => providerFilter === 'all' || patient.providerId === providerFilter),
    [patients, providerFilter],
  );
  const overduePatients = filteredPatients.filter(p => p.status === 'overdue');
  const lapsedLoggers = useMemo(
    () => filteredPatients
      .map((patient) => ({ patient, stats: getLoggingStats(patient) }))
      .filter(({ stats }) => isLapsed(stats))
      .sort((a, b) => (b.stats.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER) - (a.stats.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER)),
    [filteredPatients],
  );
  const selectedProvider = providers.find((provider) => provider.id === providerFilter);
  // Live patient counts come from the SAME roster rows the Patients page
  // filters, with the shared predicates, so every tile, card and banner here
  // equals the list its link opens (the office rollup RPC is not used for
  // these; it can disagree with the roster's evaluator by a patient or two).
  const rosterRows = liveEnabled ? liveRosterData?.patients ?? null : null;
  const liveCounts = useMemo(() => rosterRows === null ? null : {
    active: rosterRows.filter(isActivatedRosterPatient).length,
    overdue: rosterRows.filter((patient) => rosterHasReason(patient, 'check_in_overdue')).length,
    lapsed: rosterRows.filter((patient) => rosterHasReason(patient, 'logging_lapsed')).length,
    inactive: rosterRows.filter((patient) => rosterHasReason(patient, 'no_activity_14d')).length,
  }, [rosterRows]);
  const liveCountText = (value: number | undefined) =>
    liveCounts ? String(value ?? 0) : liveRosterIsLoading ? '—' : 'Error';
  const rosterInitialLoading = liveEnabled && !liveRosterData && liveRosterIsLoading;
  const overviewInitialLoading = liveEnabled && !overviewData && overviewIsLoading;
  const billingInitialLoading = liveEnabled && !billing.data && billing.isPending;
  const activePatientsValue = liveEnabled
    ? liveCountText(liveCounts?.active)
    : (selectedProvider?.activePatientCount ?? analytics.activePatients).toString();

  const activePatientsChange = liveEnabled ? (liveRosterData && liveRosterUpdatedAt ? formatLocalDate(new Date(liveRosterUpdatedAt)) : 'Live roster') : badges.patients;
  const activePatientsDetail = liveEnabled
    ? (liveRosterData ? `${liveRosterData.summary.newEnrollments30d} new this month` : liveRosterIsLoading ? 'Loading…' : 'Failed to load')
    : `${analytics.newEnrollments} new this month`;

  const averagePoundsLostValue = useMemo(() => {
    if (liveEnabled) {
      if (overviewData?.metrics.avgPoundsLost != null) return overviewData.metrics.avgPoundsLost;
      if (!liveRosterData) return null;
      const valid = liveRosterData.patients.filter(p => p.program?.startingWeight != null && p.program?.currentWeight != null);
      if (valid.length === 0) return null;
      return valid.reduce((total, p) => total + (p.program!.startingWeight! - p.program!.currentWeight!), 0) / valid.length;
    }
    return filteredPatients.length
      ? filteredPatients.reduce((total, patient) => total + patient.startingWeight - getCurrentWeight(patient), 0) / filteredPatients.length
      : 0;
  }, [liveEnabled, overviewData, liveRosterData, filteredPatients, getCurrentWeight]);
  const averagePoundsLostFailed = liveEnabled
    && averagePoundsLostValue === null
    && overviewIsError
    && liveRosterIsError
    && !overviewData
    && !liveRosterData;

  const avgLostChange = liveEnabled ? 'Live roster' : badges.avgLost;

  const overduePatientsCount = liveEnabled
    ? liveCountText(liveCounts?.overdue)
    : overduePatients.length.toString();

  const overduePatientsList = useMemo(() => {
    if (liveEnabled) {
      if (!liveRosterData) return [];
      return liveRosterData.patients.filter((patient) => rosterHasReason(patient, 'check_in_overdue'));
    }
    return overduePatients;
  }, [liveEnabled, liveRosterData, overduePatients]);

  const lapsedLoggersList = useMemo(() => {
    if (liveEnabled) {
      if (!liveRosterData) return [];
      // Days since the last log on the patient's own calendar — the same
      // figure the roster's logging cell prints.
      return liveRosterData.patients
        .filter((patient) => rosterHasReason(patient, 'logging_lapsed'))
        .map(patient => {
          const activity = rosterActivityFor(patient);
          return {
            patient: { id: patient.id, initials: shortName(patient), name: patient.name },
            stats: { daysSinceLastLog: activity.kind === 'known' ? activity.daysSinceLastLog : null }
          };
        })
        .sort((a, b) => (b.stats.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER) - (a.stats.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER));
    }
    return lapsedLoggers.map(({ patient, stats }) => ({
      patient: { id: patient.id, initials: patient.initials, name: patient.name },
      stats: { daysSinceLastLog: stats.daysSinceLastLog }
    }));
  }, [liveEnabled, liveRosterData, lapsedLoggers]);

  const lapsedLoggersCount = liveEnabled
    ? (liveCounts?.lapsed ?? null)
    : lapsedLoggers.length;
  const filteredMrr = subscriptions
    .filter((subscription) => filteredPatients.some((patient) => patient.id === subscription.patientId))
    .reduce((total, subscription) => total + subscription.monthlyValue, 0);

  // MRR tile: live billing for a signed-in office (dash while loading,
  // "Error" on failure, never a seeded number); the demo keeps its seeded
  // projection and labels.
  const mrrTile = useMemo(() => {
    if (!liveEnabled) {
      return {
        value: providerFilter === 'all' ? `$${(analytics.recurringRevenue / 1000).toFixed(1)}k` : `$${filteredMrr.toLocaleString()}`,
        change: 'Demo projection',
        detail: 'Synthetic finance · not live',
      };
    }
    const change = 'Live billing';
    if (billingForbidden) return { value: '—', change, detail: 'Owners and admins only' };
    if (billing.data) {
      const active = billing.data.active_subscriptions;
      return {
        value: formatMoney(billing.data.mrr_cents / 100),
        change,
        detail: !billing.data.account_connected
          ? 'Payments not connected yet'
          : active === 0
            ? 'No active subscriptions'
            : `${active} active subscription${active === 1 ? '' : 's'}`,
      };
    }
    if (billing.isPending) return { value: '—', change, detail: 'Loading…' };
    return { value: 'Error', change, detail: 'Failed to load' };
  }, [liveEnabled, providerFilter, analytics.recurringRevenue, filteredMrr, billing.data, billing.isPending, billingForbidden]);

  // Stage mix from the analytics counts: unscoped this reproduces the
  // long-standing 65 / 20 / 15 split exactly; scoped it reflects one office.
  const stageRows = useMemo(() => {
    if (liveEnabled) {
      if (!liveRosterData) return [];
      const active = liveRosterData.patients.filter(p => ['on_track', 'needs_attention', 'inactive'].includes(p.operational?.status ?? ''));
      let maintenance = 0;
      let early = 0;
      let late = 0;
      active.forEach(p => {
        if (p.program?.stage === 'maintenance') maintenance++;
        else if (p.program?.stage === 'protocol') {
          if ((p.program?.week ?? 1) <= 3) early++;
          else late++;
        }
      });
      const total = maintenance + early + late;
      const pctOf = (count: number) => (total > 0 ? `${Math.round((count / total) * 100)}%` : '0%');
      return [
        ["Maintenance", pctOf(maintenance), maintenance, "bg-chart-1"],
        ["Protocol Weeks 1-3", pctOf(early), early, "bg-chart-2"],
        ["Protocol Weeks 4-6", pctOf(late), late, "bg-chart-3"],
      ] as const;
    }
    const maintenance = analytics.stageCounts.maintenance;
    const early = analytics.stageCounts.week1 + analytics.stageCounts.week2 + analytics.stageCounts.week3;
    const late = analytics.stageCounts.week4 + analytics.stageCounts.week5 + analytics.stageCounts.week6;
    const total = maintenance + early + late;
    const pctOf = (count: number) => (total > 0 ? `${Math.round((count / total) * 100)}%` : '0%');
    return [
      ["Maintenance", pctOf(maintenance), maintenance, "bg-chart-1"],
      ["Protocol Weeks 1-3", pctOf(early), early, "bg-chart-2"],
      ["Protocol Weeks 4-6", pctOf(late), late, "bg-chart-3"],
    ] as const;
  }, [liveEnabled, liveRosterData, analytics]);


  const failedPayments = subscriptions.filter((subscription) => subscription.paymentStatus === 'failed').length;
  const graduatedCount = liveEnabled && liveRosterData
    ? liveRosterData.patients.filter((p) => p.program?.stage === 'maintenance').length
    : patients.filter((patient) => patient.status === 'graduated').length;

  // [title, body, level, tone, href]; an empty href renders the demo's
  // toast button instead of a link.
  const priorityItems: [string, string, string, string, string][] | null = useMemo(() => {
    if (liveEnabled) {
      if (!liveCounts) return null;
      const items: [string, string, string, string, string][] = [];
      // Failed recurring payments from the office's billing tables; the link
      // opens the subscriptions list filtered to past due + unpaid.
      const failed = billingForbidden ? 0 : (billing.data?.needs_attention_subscriptions ?? 0);
      if (failed > 0) {
        items.push([
          "Failed Subscription Payments",
          `${failed} subscription${failed === 1 ? ' has' : 's have'} a failed renewal payment`,
          "High",
          "risk",
          FAILED_PAYMENTS_HREF
        ]);
      }
      const overdue = liveCounts.overdue;
      if (overdue > 0) {
        items.push([
          "Missed Check-ins",
          `${overdue} patient${overdue === 1 ? '' : 's'} missed their scheduled protocol check-in`,
          "Watch",
          "watch",
          rosterReasonHref('check_in_overdue')
        ]);
      }
      const lapsed = liveCounts.lapsed;
      if (lapsed > 0) {
        items.push([
          "Logging Lapsed",
          `${lapsed} patient${lapsed === 1 ? ' has' : 's have'} stopped logging in the companion app`,
          "Watch",
          "watch",
          rosterReasonHref('logging_lapsed')
        ]);
      }
      const inactive = liveCounts.inactive;
      if (inactive > 0) {
        items.push([
          "Inactive Patients",
          `${inactive} patient${inactive === 1 ? ' has' : 's have'} no recent activity`,
          "High",
          "risk",
          rosterReasonHref('no_activity_14d')
        ]);
      }
      return items;
    }

    return scope ? [
        ...(failedPayments > 0
          ? [[
              "Failed Subscription Payments",
              `${failedPayments} recurring payment${failedPayments === 1 ? '' : 's'} failed this week`,
              "High",
              "risk",
              ""
            ] as [string, string, string, string, string]]
          : []),
        [
          "Missed Check-ins",
          `${overduePatientsCount} patient${overduePatientsCount === '1' ? '' : 's'} missed their scheduled protocol check-in`,
          "Watch",
          "watch",
          ""
        ],
        [
          "Maintenance Cohort",
          `${graduatedCount} patient${graduatedCount === 1 ? '' : 's'} holding goal weight in maintenance`,
          "Positive",
          "healthy",
          ""
        ],
      ]
    : [
        ["Failed Subscription Payments", "2 recurring payments failed this week", "High", "risk", ""],
        ["Missed Check-ins", "4 patients missed their scheduled protocol check-in", "Watch", "watch", ""],
        ["High Adherence Cohort", "24 patients reached goal weight this week", "Positive", "healthy", ""],
      ];
  }, [liveEnabled, liveCounts, billing.data, billingForbidden, scope, failedPayments, overduePatientsCount, graduatedCount]);

  const scopedProviderLabel = scope ? scope.providerName.split(',')[0] : '';
  const scopedProviderInitials = scope
    ? scope.providerName
        .split(/[\s,]+/)
        .filter((word: string) => word && !/^(dr|np|rn|md|pa|do)\.?$/i.test(word))
        .map((word: string) => word[0]?.toUpperCase() ?? '')
        .slice(0, 2)
        .join('') || 'TH'
    : '';

  const getRecentPatientName = (index: number, fallback: string) => {
    if (liveEnabled) {
      if (!liveRosterData || liveRosterData.patients.length <= index) return fallback;
      return shortName(liveRosterData.patients[index]);
    }
    if (filteredPatients.length > index) {
      return shortName(filteredPatients[index]);
    }
    return fallback;
  };

  const getRecentOverdueName = (index: number, fallback: string) => {
    if (liveEnabled) {
      if (!liveRosterData || overduePatientsList.length <= index) return fallback;
      return shortName(overduePatientsList[index]);
    }
    if (overduePatients.length > index) {
      return shortName(overduePatients[index]);
    }
    return fallback;
  };

  const recentWatchlist = useMemo(() => {
    if (liveEnabled) {
      if (!liveRosterData) return [];
      const sortOrder = { 'inactive': 1, 'needs_attention': 2, 'on_track': 3 };
      return [...liveRosterData.patients]
        .filter(p => p.operational?.status && ['inactive', 'needs_attention', 'on_track'].includes(p.operational.status))
        .sort((a, b) => {
          const aStatus = a.operational?.status as string;
          const bStatus = b.operational?.status as string;
          return (sortOrder[aStatus as keyof typeof sortOrder] ?? 99) - (sortOrder[bStatus as keyof typeof sortOrder] ?? 99);
        })
        .slice(0, 5)
        .map(p => {
          const lbsLost = (p.program?.startingWeight != null && p.program?.currentWeight != null)
            ? p.program.startingWeight - p.program.currentWeight
            : 0;
          return {
            id: p.id,
            name: p.name,
            providerName: p.providerName?.split(',')[0] ?? '—',
            stage: p.program?.stage ? (p.program.stage === 'protocol' && p.program.week ? `Wk ${p.program.week}` : 'Maintenance') : (p.program?.id ? 'Enrolled' : '—'),
            status: p.operational?.status ?? p.status ?? 'invited',
            lbsLost,
            lbsLostDisplay: lbsLost ? `${lbsLost.toFixed(1)} lbs` : '—',
          };
        });
    }
    return filteredPatients.slice(0, 5).map(p => {
      const provider = providers.find(c => c.id === p.providerId);
      const lbsLost = p.startingWeight - getCurrentWeight(p);
      return {
        id: p.id,
        name: p.name,
        providerName: provider?.name.split(',')[0] ?? '—',
        stage: p.stage === 'protocol' ? `Wk ${p.protocolWeek}` : 'Maintenance',
        status: p.status,
        lbsLost,
        lbsLostDisplay: `${lbsLost.toFixed(1)} lbs`,
      };
    });
  }, [liveEnabled, liveRosterData, filteredPatients, providers, getCurrentWeight]);

  const activityItems: [string, string, string, string, string][] = (scope || liveEnabled)
    ? [
        [scopedProviderInitials, scopedProviderLabel, `completed week 4 check-in for ${getRecentPatientName(0, 'a patient')}`, "12 min ago", "bg-accent text-primary"],
        [scopedProviderInitials, scopedProviderLabel, `flagged overdue check-in for ${getRecentOverdueName(0, getRecentPatientName(1, 'a patient'))}`, "46 min ago", "bg-warn-bg text-warn"],
        ["TH", "THINNR HQ", `approved Maintenance Stack for ${getRecentPatientName(2, 'a patient')}`, "2 hr ago", "bg-muted text-navy"],
      ]
    : [
        ["PS", "Elena Rostova", "completed week 4 check-in for Emma S.", "12 min ago", "bg-accent text-primary"],
        ["MC", "Michael Chen", "flagged overdue check-in for Liam J.", "46 min ago", "bg-warn-bg text-warn"],
        ["SJ", "Sarah Jenkins", "approved Maintenance Stack for Olivia W.", "2 hr ago", "bg-muted text-navy"],
      ];

  // Live: the device-local day of the server's UTC "as of" instant. Demo: the fixed anchor.
  const pulseDate = liveEnabled && overviewData?.asOf
    ? formatLocalDate(overviewData.asOf)
    : formatDateKey(TODAY_KEY, true);

  const greetName = liveEnabled ? greetingName(authUser?.displayName) : (scope ? scope.greetingName : 'Dr. Jenkins');
  const greetingSubtitle = liveEnabled ? 'Here is your current practice overview.' : 'Here’s what changed since your last login.';

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      {/* Header Area */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.16em] text-primary">
            <Activity size={14} /> Practice Pulse <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <span data-testid="text-demo-date">{pulseDate}</span>
          </div>
          <h1 className="font-serif text-[32px] leading-[1.08] tracking-[-.02em] text-navy md:text-[38px]">
            {liveEnabled ? localGreeting : 'Good morning'}{greetName ? `, ${greetName}` : ''}.
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{greetingSubtitle}</p>
        </div>
        {/* The provider filter belongs to the multi-provider office demo; a
            drilled-in office is already a single provider's view. */}
        {(!scope && !liveEnabled) && (
        <div className="relative flex items-center gap-2">
          {selectedProvider && (
            <span
              data-testid="badge-provider-filter"
              className="hidden rounded-md border border-accent-border bg-accent px-2.5 py-2 text-[10px] font-bold uppercase tracking-[.08em] text-primary sm:inline"
            >
              {selectedProvider.name}
            </span>
          )}
          <ActionButton label="Filter dashboard" testId="button-filter-dashboard" onClick={() => setFilterOpen(!filterOpen)}>
            <Filter size={15} />
          </ActionButton>

          {filterOpen && (
            <div className="absolute right-0 top-11 z-10 w-48 rounded-lg border border-popover-border bg-popover p-2 text-xs shadow-lifted">
              <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">View filter</p>
              {[{ id: 'all', name: 'All Providers' }, ...providers].map((provider) => (
                <button
                  key={provider.id}
                  data-testid={`option-provider-${provider.id}`}
                  onClick={() => {
                    setProviderFilter(provider.id);
                    setFilterOpen(false);
                    toast({ title: `Filtered by ${provider.name}`, description: 'Patient-specific dashboard views now reflect this provider.' });
                  }}
                  className={`block w-full rounded-md px-2 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${providerFilter === provider.id ? 'bg-accent font-bold text-navy' : 'text-foreground'}`}
                >
                  {provider.name}
                </button>
              ))}
            </div>
          )}
        </div>
        )}
      </div>

      {/* Top Metrics */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          icon={<WalletCards size={14} />}
          label="MRR"
          value={mrrTile.value}
          change={mrrTile.change}
          detail={mrrTile.detail}
          loading={billingInitialLoading}
        />
        <Metric
          icon={<Users size={14} />}
          label="Active Patients"
          value={activePatientsValue}
          change={activePatientsChange}
          detail={activePatientsDetail}
          loading={rosterInitialLoading}
        />
        <Metric
          icon={<Activity size={14} />}
          label="Avg Pounds Lost"
          value={averagePoundsLostFailed ? 'Error' : averagePoundsLostValue === null ? '—' : `${averagePoundsLostValue.toFixed(1)} lbs`}
          change={avgLostChange}
          detail={averagePoundsLostFailed ? "Failed to load" : averagePoundsLostValue === null ? "No usable weights" : "Across all active cohorts"}
          loading={liveEnabled && averagePoundsLostValue === null && (overviewInitialLoading || rosterInitialLoading)}
        />
        <Metric
          icon={<ShieldAlert size={14} />}
          label="Check-ins Overdue"
          value={overduePatientsCount}
          change={liveEnabled ? 'Live roster' : 'Needs review'}
          detail="Patients at risk of dropping"
          warning
          loading={rosterInitialLoading}
        />
      </div>
      {liveEnabled && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Inbox overview">
          {overviewInitialLoading ? (
            <LoadingRegion label="Loading inbox overview" className="sm:col-span-2 lg:col-span-4" testId="loading-inbox">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="rounded-lg border border-card-border bg-card p-4 shadow-soft">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="mt-3 h-7 w-12" />
                  </div>
                ))}
              </div>
            </LoadingRegion>
          ) : [
            ['Open threads', overviewData?.metrics.inbox.openThreads, '/admin/conversations'],
            ['Unanswered', overviewData?.metrics.inbox.unanswered, '/admin/conversations?sort=waiting_longest'],
            ['Avg response', overviewData?.metrics.inbox.avgResponseMinutes == null ? '—' : overviewData.metrics.inbox.avgResponseMinutes < 60 ? `${Math.round(overviewData.metrics.inbox.avgResponseMinutes)} min` : `${(overviewData.metrics.inbox.avgResponseMinutes / 60).toFixed(1)} h`, '/admin/conversations'],
            ['Open escalations', overviewData?.metrics.inbox.openEscalations, '/admin/conversations'],
          ].map(([label, rawValue, href]) => (
            <Link key={label} href={href as string} className="block rounded-lg border border-card-border bg-card p-4 shadow-soft transition hover:border-primary/40">
              <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">{label}</p>
              <p className="mt-2 font-serif text-2xl font-bold text-navy">{overviewIsError && !overviewData ? 'Error' : rawValue ?? '—'}</p>
            </Link>
          ))}
        </div>
      )}

      {/* Notice Banner */}
      {showNotice && overduePatientsList.length > 0 && (
        <div data-testid="banner-overdue" className="mt-5 flex items-center gap-3 rounded-lg border border-warn-border bg-warn-bg px-4 py-3 text-sm text-foreground shadow-soft">
          <ShieldAlert size={17} className="shrink-0 text-warn" />
          <span><b className="text-navy">{overduePatientsList.length} patient{overduePatientsList.length === 1 ? ' needs' : 's need'} attention.</b> Check-ins{liveEnabled ? ' are' : ' or subscription renewals are'} past due.</span>
          <Link href={liveEnabled ? rosterReasonHref("check_in_overdue") : "/patients?status=overdue"} className="ml-auto whitespace-nowrap text-xs font-bold text-warn underline underline-offset-4 transition-colors hover:text-navy">
            Review patients
          </Link>
          <button
            aria-label="Dismiss alert"
            data-testid="button-dismiss-notice"
            onClick={() => setShowNotice(false)}
            className="ml-1 rounded-md p-1 text-warn transition hover:bg-warn-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* Charts / Mid Section */}
      {liveEnabled && (
        <div className="mt-5">
          <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">
                  Patient Engagement
                </p>
                <div className="mt-1 flex items-end gap-3">
                  <h2 className="font-mono text-2xl font-semibold tracking-[-.05em] text-navy">
                    {engagementData?.points.length ? engagementData.points[engagementData.points.length - 1].engaged_patients : "—"}
                  </h2>
                  {engagementData?.points.length ? (
                    <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                      patients engaged recently
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatRangeLabel(range)} · Daily active vs engaged patients
                </p>
              </div>
            </div>
            {!engagementData && engagementIsLoading ? (
              <ChartSkeleton label="Loading patient engagement" className="mt-5" height={190} testId="loading-engagement" />
            ) : !engagementData && engagementIsError ? (
              <div className="h-[190px] mt-5 flex items-center justify-center text-xs text-destructive">
                {engagementError instanceof Error ? engagementError.message : "Failed to load engagement data."}
              </div>
            ) : engagementData?.points && engagementData.points.length > 0 ? (
              <EngagementTrendChart points={engagementData.points} />
            ) : (
              <div className="h-[190px] mt-5 flex items-center justify-center text-xs text-muted-foreground">No engagement data available for this range.</div>
            )}
          </section>
        </div>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        {liveEnabled ? (
          <LiveRevenueSection
            range={range}
            view={liveRevenueView}
            pending={billingInitialLoading}
            forbidden={billingForbidden}
            error={billing.isError && !billingForbidden && !billing.data ? billing.error : null}
            accountConnected={billing.data?.account_connected ?? null}
            retry={() => void billing.refetch()}
          />
        ) : (
        <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Revenue Trend</p>
                <span className="rounded-sm border border-accent-border bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">Demo projection</span>
              </div>
              <div className="mt-1 flex items-end gap-3">
                <h2 className="font-mono text-2xl font-semibold tracking-[-.05em] text-navy" data-testid="text-revenue-total">
                  {formatMoney(revenueView.total)}
                </h2>
                <span
                  data-testid="text-revenue-delta"
                  className={`mb-1 flex items-center gap-1 text-xs font-semibold ${revenueView.deltaPct >= 0 ? 'text-primary' : 'text-warn'}`}
                >
                  {revenueView.deltaPct >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                  {Math.abs(revenueView.deltaPct).toFixed(1)}%
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="text-revenue-range">
                {formatRangeLabel(range)} · vs prior {revenueView.dayCount === 1 ? 'day' : `${revenueView.dayCount} days`}
              </p>
            </div>
            <button
              onClick={() => toast({ title: "Chart menu opened" })}
              aria-label="More chart options"
              className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MoreHorizontal size={17} />
            </button>
          </div>
          <TrendChart view={revenueView} />
        </section>
        )}

        <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Protocol Stages</p>
              {rosterInitialLoading
                ? <Skeleton className="mt-2 h-5 w-24" />
                : <h2 className="mt-1 font-serif text-lg font-semibold tracking-[-.01em] text-navy">{activePatientsValue} Active</h2>}
            </div>
            <Link href="/analytics" className="text-xs font-semibold text-primary transition-colors hover:text-navy">
              Details <ArrowUpRight size={13} className="inline" />
            </Link>
          </div>
          <div className="mt-6 space-y-4">
            {rosterInitialLoading ? (
              <RowsSkeleton label="Loading protocol stages" rows={3} compact testId="loading-protocol-stages" />
            ) : liveEnabled && liveRosterIsError && !liveRosterData ? (
              <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-xs text-destructive" role="alert">
                Failed to load live patients.
              </div>
            ) : stageRows.length === 0 ? (
              <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
                No active patients.
              </div>
            ) : stageRows.map(([name, pct, count, color]) => (
              <div key={name as string}>
                <div className="mb-1.5 flex justify-between text-xs">
                  <span className="font-medium text-foreground">{name}</span>
                  <span className="font-mono text-muted-foreground">{count} <b className="ml-2 text-navy">{pct}</b></span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full ${color}`} style={{ width: pct as string }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Watchlist and Signals */}
      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_1.45fr]">
        <div className="space-y-5">
        <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Priority items</p>
              <h2 className="mt-1 font-serif text-lg font-semibold tracking-[-.01em] text-navy">Worth a closer look</h2>
            </div>
            <span className="rounded-sm border border-warn-border bg-warn-bg px-2 py-1 text-[10px] font-bold text-warn">
              {priorityItems === null ? (liveRosterIsLoading ? "Loading…" : liveRosterIsError ? "Error" : "...") : `${priorityItems.length} open`}
            </span>
          </div>
          {priorityItems === null ? (
            rosterInitialLoading ? (
              <RowsSkeleton label="Loading priority items" rows={1} className="border-t border-border" testId="loading-priority-items" />
            ) : (
              <div className="flex h-20 items-center justify-center border-t border-border text-xs text-destructive" role="alert">
                Failed to load priority items.
              </div>
            )
          ) : priorityItems.length === 0 ? (
            <div className="flex h-20 items-center justify-center border-t border-border text-xs text-muted-foreground">
              0 open items.
            </div>
          ) : priorityItems.map(([title, body, level, tone, href]) => {
            const innerContent = (
              <>
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone === "risk" ? "bg-destructive" : tone === "watch" ? "bg-warn" : "bg-primary"}`} />
                <span className="min-w-0 flex-1">
                  <b className="block text-xs text-foreground group-hover:text-primary transition-colors">{title}</b>
                  <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{body}</span>
                </span>
                <span className={`text-[10px] font-bold ${tone === "risk" ? "text-destructive" : tone === "watch" ? "text-warn" : "text-primary"}`}>
                  {level}
                </span>
              </>
            );

            const className = "group flex w-full items-start gap-3 border-t border-border py-3 text-left transition first:border-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

            if (href) {
              return (
                <Link
                  key={title}
                  href={href}
                  className={className}
                >
                  {innerContent}
                </Link>
              );
            }

            return (
              <button
                key={title}
                onClick={() => toast({ title: `${title} signal opened` })}
                className={className}
              >
                {innerContent}
              </button>
            );
          })}
        </section>

        <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Logging compliance</p>
              <h2 className="mt-1 font-serif text-lg font-semibold tracking-[-.01em] text-navy">Companion-app logging</h2>
            </div>
            <span className={`rounded-sm border px-2 py-1 text-[10px] font-bold ${lapsedLoggersCount !== null && lapsedLoggersCount > 0 ? "border-warn-border bg-warn-bg text-warn" : "border-accent-border bg-accent text-primary"}`}>
              {(liveEnabled && liveRosterIsLoading) ? "Loading…" : (liveEnabled && liveRosterIsError && !liveRosterData) ? "Error" : lapsedLoggersCount === null ? "..." : lapsedLoggersCount > 0 ? `${lapsedLoggersCount} lapsed` : "All current"}
            </span>
          </div>
          {rosterInitialLoading ? (
            <RowsSkeleton label="Loading logging compliance" rows={1} className="mt-1" testId="loading-logging-compliance" />
          ) : <div className="flex items-center gap-3 rounded-md border border-border bg-secondary p-3">
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border ${lapsedLoggersCount !== null && lapsedLoggersCount > 0 ? "border-warn-border bg-warn-bg text-warn" : "border-accent-border bg-accent text-primary"}`}>
              <ClipboardList size={16} />
            </span>
            <p className="text-[11px] leading-4 text-foreground">
              {(liveEnabled && liveRosterIsLoading) ? (
                <>Loading compliance stats…</>
              ) : (liveEnabled && liveRosterIsError && !liveRosterData) ? (
                <>Could not load compliance stats.</>
              ) : lapsedLoggersCount !== null && lapsedLoggersCount > 0 ? (
                <><b className="font-mono text-base text-navy">{lapsedLoggersCount}</b> patient{lapsedLoggersCount === 1 ? " hasn't" : "s haven't"} logged meals in the companion app for {LAPSED_AFTER_DAYS}+ days.</>
              ) : lapsedLoggersCount !== null ? (
                <>Every patient in this view has logged meals within the last {LAPSED_AFTER_DAYS} days.</>
              ) : (
                <>Compliance stats unavailable.</>
              )}
            </p>
          </div>}
          {!(liveEnabled && (liveRosterIsLoading || (liveRosterIsError && !liveRosterData))) && lapsedLoggersList.length > 0 && (
            <div className="mt-1">
              {lapsedLoggersList.slice(0, 3).map(({ patient, stats }) => (
                <Link
                  key={patient.id}
                  href={`/patients/${patient.id}`}
                  className="flex items-center justify-between gap-3 border-t border-border py-2.5 transition first:border-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-accent text-[9px] font-bold text-primary">{patient.initials}</span>
                    <b className="truncate text-xs text-foreground">{patient.name}</b>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] font-bold text-destructive">
                    {stats.daysSinceLastLog === null ? "no logs" : `${stats.daysSinceLastLog}d silent`}
                  </span>
                </Link>
              ))}
            </div>
          )}
          <Link
            href={liveEnabled ? "/patients?reason=logging_lapsed" : "/patients?logging=lapsed"}
            className="mt-3 flex w-full items-center justify-center gap-1 rounded-md border border-border py-2 text-xs font-semibold text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Review lapsed loggers <ArrowUpRight size={13} />
          </Link>
        </section>
        </div>

        <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Patient watchlist</p>
              <h2 className="mt-1 font-serif text-lg font-semibold tracking-[-.01em] text-navy">Recent Check-ins & Overdue</h2>
            </div>
            <Link href="/patients" className="text-xs font-semibold text-primary transition-colors hover:text-navy">
              View all roster <ArrowUpRight size={13} className="inline" />
            </Link>
          </div>
          {rosterInitialLoading ? (
            <RowsSkeleton label="Loading patient watchlist" rows={3} testId="loading-watchlist" />
          ) : recentWatchlist.length === 0 ? (
            <p className="rounded-md border border-border bg-secondary py-6 text-center text-xs text-muted-foreground">
              {liveRosterIsLoading ? "Loading watchlist…" : liveRosterIsError ? "Error loading watchlist." : "No patients in this provider view."}
            </p>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[540px] text-left text-xs">
                  <thead className="border-b border-border text-[10px] uppercase tracking-[.11em] text-muted-foreground">
                    <tr>
                      <th className="pb-2 font-semibold">Patient</th>
                      <th className="pb-2 font-semibold">Provider</th>
                      <th className="pb-2 font-semibold">Stage</th>
                      <th className="pb-2 font-semibold">Status</th>
                      <th className="pb-2 text-right font-semibold">Weight Loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentWatchlist.map((patient) => {
                      return (
                        <tr key={patient.id} className="group border-b border-border last:border-0 transition-colors hover:bg-secondary">
                          <td className="py-3 font-semibold text-foreground">
                            <Link href={`/patients/${patient.id}`} className="transition-colors hover:text-primary hover:underline">{patient.name}</Link>
                          </td>
                          <td className="py-3 text-muted-foreground">{patient.providerName}</td>
                          <td className="py-3 capitalize text-muted-foreground">{patient.stage}</td>
                          <td className="py-3">
                            <StatusBadge status={patient.status} />
                          </td>
                          <td className="py-3 text-right font-mono text-foreground">
                            {patient.lbsLostDisplay}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="divide-y divide-border md:hidden">
                {recentWatchlist.map((patient) => {
                  return (
                    <Link
                      key={patient.id}
                      href={`/patients/${patient.id}`}
                      className="flex items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="min-w-0">
                        <b className="block truncate text-xs text-foreground">{patient.name}</b>
                        <span className="mt-1 block truncate text-[10px] text-muted-foreground">{patient.providerName} · {patient.stage}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <StatusBadge status={patient.status} />
                        <span className="mt-1 block font-mono text-[10px] text-muted-foreground">{patient.lbsLostDisplay} lost</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>

      {/* Activity Feed */}
      {!liveEnabled && (
      <section className="mt-5 rounded-lg border border-card-border bg-card p-5 shadow-soft">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Recent activity</p>
            <h2 className="mt-1 font-serif text-lg font-semibold tracking-[-.01em] text-navy">Team movement</h2>
          </div>
          <button
            onClick={() => toast({ title: "Full activity log opened" })}
            className="rounded-md border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Full activity
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {activityItems.map(([initials, name, action, time, color]) => (
            <button
              key={`${name}-${time}`}
              onClick={() => toast({ title: `${name}'s activity opened` })}
              className="flex items-center gap-3 rounded-md border border-border p-3 text-left transition hover:border-accent-border hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md text-[10px] font-bold ${color}`}>{initials}</span>
              <span className="min-w-0">
                <b className="block truncate text-xs text-foreground">{name} <span className="font-normal text-muted-foreground">{action}</span></b>
                <span className="mt-1 block text-[10px] text-muted-foreground">{time}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
      )}
    </div>
  );
}
