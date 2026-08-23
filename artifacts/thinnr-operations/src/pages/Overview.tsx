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
import { MOCK_ANALYTICS, MOCK_PATIENTS, MOCK_PROVIDERS, MOCK_SUBSCRIPTIONS, getDailyRevenue } from "@/data/mock-data";
import { LAPSED_AFTER_DAYS, TODAY_KEY, formatDateKey, getLoggingStats, isLapsed } from "@/data/nutrition-data";
import { useToast } from "@/hooks/use-toast";
import { usePatientSession } from "@/contexts/patient-session";
import {
  addDaysToKey,
  formatRangeLabel,
  keyToDate,
  useDateRange,
  type OperationsDateRange,
} from "@/contexts/date-range";

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

function Metric({ icon, label, value, change, detail, warning = false }: { icon: ReactNode; label: string; value: string; change: string; detail: string; warning?: boolean }) {
  return (
    <div className="rounded-lg border border-card-border bg-card p-4 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lifted">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">
          <span className="text-primary">{icon}</span>{label}
        </span>
        <span className={`rounded-sm border px-2 py-1 text-[10px] font-bold ${warning ? "border-warn-border bg-warn-bg text-warn" : "border-accent-border bg-accent text-primary"}`}>
          {change}
        </span>
      </div>
      <p className="mt-4 font-mono text-[27px] font-semibold tracking-[-.07em] text-navy">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isHealthy = status === 'active' || status === 'graduated';
  const isWatch = status === 'paused';

  const styles = isHealthy
    ? "border-accent-border bg-accent text-primary"
    : isWatch
    ? "border-warn-border bg-warn-bg text-warn"
    : "border-destructive/40 bg-destructive/10 text-destructive";

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[.05em] ${styles}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
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

function buildRevenueView(range: OperationsDateRange): RevenueView {
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
      total: slice.reduce((sum, key) => sum + getDailyRevenue(key), 0),
    });
  }

  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  let previousTotal = 0;
  for (let i = 1; i <= dayCount; i++) previousTotal += getDailyRevenue(addDaysToKey(range.start, -i));
  const deltaPct = previousTotal > 0 ? ((total - previousTotal) / previousTotal) * 100 : 0;
  const axisMax = niceCeil(Math.max(...buckets.map((bucket) => bucket.total)));

  return { buckets, total, deltaPct, dayCount, axisMax };
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

export default function Overview() {
  const { getCurrentWeight } = usePatientSession();
  const { range } = useDateRange();
  const [showNotice, setShowNotice] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const [providerFilter, setProviderFilter] = useState('all');
  const { toast } = useToast();

  const revenueView = useMemo(() => buildRevenueView(range), [range]);

  const filteredPatients = useMemo(
    () => MOCK_PATIENTS.filter((patient) => providerFilter === 'all' || patient.providerId === providerFilter),
    [providerFilter],
  );
  const overduePatients = filteredPatients.filter(p => p.status === 'overdue');
  const lapsedLoggers = useMemo(
    () => filteredPatients
      .map((patient) => ({ patient, stats: getLoggingStats(patient) }))
      .filter(({ stats }) => isLapsed(stats))
      .sort((a, b) => (b.stats.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER) - (a.stats.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER)),
    [filteredPatients],
  );
  const selectedProvider = MOCK_PROVIDERS.find((provider) => provider.id === providerFilter);
  const averagePoundsLost = filteredPatients.length
    ? filteredPatients.reduce((total, patient) => total + patient.startingWeight - getCurrentWeight(patient), 0) / filteredPatients.length
    : 0;
  const filteredMrr = MOCK_SUBSCRIPTIONS
    .filter((subscription) => filteredPatients.some((patient) => patient.id === subscription.patientId))
    .reduce((total, subscription) => total + subscription.monthlyValue, 0);

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      {/* Header Area */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.16em] text-primary">
            <Activity size={14} /> Practice Pulse <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <span data-testid="text-demo-date">{formatDateKey(TODAY_KEY, true)}</span>
          </div>
          <h1 className="font-serif text-[32px] leading-[1.08] tracking-[-.02em] text-navy md:text-[38px]">
            Good morning, Dr. Jenkins.
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">Here’s what changed since your last login.</p>
        </div>
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
              {[{ id: 'all', name: 'All Providers' }, ...MOCK_PROVIDERS].map((provider) => (
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
      </div>

      {/* Top Metrics */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          icon={<WalletCards size={14} />}
          label="MRR"
          value={providerFilter === 'all' ? `$${(MOCK_ANALYTICS.recurringRevenue / 1000).toFixed(1)}k` : `$${filteredMrr.toLocaleString()}`}
          change="+12.4%"
          detail="vs. last month"
        />
        <Metric
          icon={<Users size={14} />}
          label="Active Patients"
          value={(selectedProvider?.activePatientCount ?? MOCK_ANALYTICS.activePatients).toString()}
          change="+8.7%"
          detail={`${MOCK_ANALYTICS.newEnrollments} new this month`}
        />
        <Metric
          icon={<Activity size={14} />}
          label="Avg Pounds Lost"
          value={`${averagePoundsLost.toFixed(1)} lbs`}
          change="+3.2%"
          detail="Across all active cohorts"
        />
        <Metric
          icon={<ShieldAlert size={14} />}
          label="Check-ins Overdue"
          value={overduePatients.length.toString()}
          change="Needs review"
          detail="Patients at risk of dropping"
          warning
        />
      </div>

      {/* Notice Banner */}
      {showNotice && overduePatients.length > 0 && (
        <div data-testid="banner-overdue" className="mt-5 flex items-center gap-3 rounded-lg border border-warn-border bg-warn-bg px-4 py-3 text-sm text-foreground shadow-soft">
          <ShieldAlert size={17} className="shrink-0 text-warn" />
          <span><b className="text-navy">{overduePatients.length} patient{overduePatients.length === 1 ? ' needs' : 's need'} attention.</b> Check-ins or subscription renewals are past due.</span>
          <Link href="/patients" className="ml-auto whitespace-nowrap text-xs font-bold text-warn underline underline-offset-4 transition-colors hover:text-navy">
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
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Revenue Trend</p>
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

        <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Protocol Stages</p>
              <h2 className="mt-1 font-serif text-lg font-semibold tracking-[-.01em] text-navy">{MOCK_ANALYTICS.activePatients} Active</h2>
            </div>
            <Link href="/analytics" className="text-xs font-semibold text-primary transition-colors hover:text-navy">
              Details <ArrowUpRight size={13} className="inline" />
            </Link>
          </div>
          <div className="mt-6 space-y-4">
            {[
              ["Maintenance", "65%", MOCK_ANALYTICS.stageCounts.maintenance, "bg-chart-1"],
              ["Protocol Weeks 1-3", "20%", MOCK_ANALYTICS.stageCounts.week1 + MOCK_ANALYTICS.stageCounts.week2 + MOCK_ANALYTICS.stageCounts.week3, "bg-chart-2"],
              ["Protocol Weeks 4-6", "15%", MOCK_ANALYTICS.stageCounts.week4 + MOCK_ANALYTICS.stageCounts.week5 + MOCK_ANALYTICS.stageCounts.week6, "bg-chart-3"]
            ].map(([name, pct, count, color]) => (
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
              3 open
            </span>
          </div>
          {[
            ["Failed Subscription Payments", "2 recurring payments failed this week", "High", "risk"],
            ["Missed Check-ins", "4 patients missed their scheduled protocol check-in", "Watch", "watch"],
            ["High Adherence Cohort", "24 patients reached goal weight this week", "Positive", "healthy"]
          ].map(([title, body, level, tone]) => (
            <button
              key={title}
              onClick={() => toast({ title: `${title} signal opened` })}
              className="group flex w-full items-start gap-3 border-t border-border py-3 text-left transition first:border-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone === "risk" ? "bg-destructive" : tone === "watch" ? "bg-warn" : "bg-primary"}`} />
              <span className="min-w-0 flex-1">
                <b className="block text-xs text-foreground">{title}</b>
                <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{body}</span>
              </span>
              <span className={`text-[10px] font-bold ${tone === "risk" ? "text-destructive" : tone === "watch" ? "text-warn" : "text-primary"}`}>
                {level}
              </span>
            </button>
          ))}
        </section>

        <section className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Logging compliance</p>
              <h2 className="mt-1 font-serif text-lg font-semibold tracking-[-.01em] text-navy">Companion-app logging</h2>
            </div>
            <span className={`rounded-sm border px-2 py-1 text-[10px] font-bold ${lapsedLoggers.length > 0 ? "border-warn-border bg-warn-bg text-warn" : "border-accent-border bg-accent text-primary"}`}>
              {lapsedLoggers.length > 0 ? `${lapsedLoggers.length} lapsed` : "All current"}
            </span>
          </div>
          <div className="flex items-center gap-3 rounded-md border border-border bg-secondary p-3">
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border ${lapsedLoggers.length > 0 ? "border-warn-border bg-warn-bg text-warn" : "border-accent-border bg-accent text-primary"}`}>
              <ClipboardList size={16} />
            </span>
            <p className="text-[11px] leading-4 text-foreground">
              {lapsedLoggers.length > 0 ? (
                <><b className="font-mono text-base text-navy">{lapsedLoggers.length}</b> patient{lapsedLoggers.length === 1 ? " hasn't" : "s haven't"} logged meals in the companion app for {LAPSED_AFTER_DAYS}+ days.</>
              ) : (
                <>Every patient in this view has logged meals within the last {LAPSED_AFTER_DAYS} days.</>
              )}
            </p>
          </div>
          {lapsedLoggers.length > 0 && (
            <div className="mt-1">
              {lapsedLoggers.slice(0, 3).map(({ patient, stats }) => (
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
            href="/patients?logging=lapsed"
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
          {filteredPatients.length === 0 ? (
            <p className="rounded-md border border-border bg-secondary py-6 text-center text-xs text-muted-foreground">
              No patients in this provider view.
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
                    {filteredPatients.slice(0, 5).map((patient) => {
                      const provider = MOCK_PROVIDERS.find(p => p.id === patient.providerId);
                      const lbsLost = patient.startingWeight - getCurrentWeight(patient);
                      return (
                        <tr key={patient.id} className="group border-b border-border last:border-0 transition-colors hover:bg-secondary">
                          <td className="py-3 font-semibold text-foreground">
                            <Link href={`/patients/${patient.id}`} className="transition-colors hover:text-primary hover:underline">{patient.name}</Link>
                          </td>
                          <td className="py-3 text-muted-foreground">{provider?.name.split(',')[0]}</td>
                          <td className="py-3 capitalize text-muted-foreground">{patient.stage === 'protocol' ? `Wk ${patient.protocolWeek}` : 'Maintenance'}</td>
                          <td className="py-3">
                            <StatusBadge status={patient.status} />
                          </td>
                          <td className="py-3 text-right font-mono text-foreground">
                            {lbsLost.toFixed(1)} lbs
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="divide-y divide-border md:hidden">
                {filteredPatients.slice(0, 5).map((patient) => {
                  const provider = MOCK_PROVIDERS.find((candidate) => candidate.id === patient.providerId);
                  const lbsLost = patient.startingWeight - getCurrentWeight(patient);
                  return (
                    <Link
                      key={patient.id}
                      href={`/patients/${patient.id}`}
                      className="flex items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="min-w-0">
                        <b className="block truncate text-xs text-foreground">{patient.name}</b>
                        <span className="mt-1 block truncate text-[10px] text-muted-foreground">{provider?.name.split(',')[0]} · {patient.stage === 'protocol' ? `Week ${patient.protocolWeek}` : 'Maintenance'}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <StatusBadge status={patient.status} />
                        <span className="mt-1 block font-mono text-[10px] text-muted-foreground">{lbsLost.toFixed(1)} lbs lost</span>
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
          {[
            ["PS", "Elena Rostova", "completed week 4 check-in for Emma S.", "12 min ago", "bg-accent text-primary"],
            ["MC", "Michael Chen", "flagged overdue check-in for Liam J.", "46 min ago", "bg-warn-bg text-warn"],
            ["SJ", "Sarah Jenkins", "approved Maintenance Stack for Olivia W.", "2 hr ago", "bg-muted text-navy"]
          ].map(([initials, name, action, time, color]) => (
            <button
              key={name}
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
    </div>
  );
}
