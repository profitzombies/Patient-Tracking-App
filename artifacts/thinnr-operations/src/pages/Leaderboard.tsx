import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Trophy, ChevronRight, RefreshCw } from "lucide-react";
import { useScopedPatients, useScopedProviders } from "@/data/scoped-data";
import { usePatientSession } from "@/contexts/patient-session";
import { useSession } from "@/contexts/session";
import { useHqData } from "@/contexts/hq-data";
import { useLiveOfficeScope } from "@/hooks/use-live-office-scope";
import {
  fetchOfficeLeaderboard,
  leaderboardQueryKey,
  OfficeRosterError,
  type LeaderboardMetric,
  type LeaderboardPeriod,
  type LeaderboardRow,
  type LeaderboardStage,
} from "@/lib/office-roster";

/** Shared Heritage control treatment for the native filter selects. */
const selectClass =
  "h-9 rounded-md border border-border bg-card px-3 text-xs font-semibold text-navy shadow-xs outline-none transition hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

// Medal tints are content semantics (podium places), kept as literals but
// softened onto the Heritage cream paper.
const rankColors = [
  "bg-[#fff6e5] text-[#97631e] border-[#d7b889]", // 1st Gold
  "bg-[#f0f3f9] text-[#53698f] border-[#bdc9dc]", // 2nd Silver
  "bg-[#fdf4ee] text-[#b06132] border-[#e7bba3]"  // 3rd Bronze
];

const PERIOD_LABELS: Record<LeaderboardPeriod, string> = {
  program: "Program to date",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

/**
 * Staff leaderboard. A signed-in office (or an HQ drill-in) ranks the
 * office's real patients from the live ranking endpoint; the guided demo
 * persona keeps its seeded board. Auth resolution shows a loading state
 * rather than briefly flashing seeded rows to a real user.
 */
export default function Leaderboard() {
  const { liveEnabled, liveOffice, isResolving, authUserId } = useLiveOfficeScope();
  const { authRole } = useSession();
  if (liveEnabled) {
    return <LiveLeaderboard office={liveOffice} isHq={authRole === "hq_admin"} authUserId={authUserId} />;
  }
  if (isResolving) {
    return (
      <LeaderboardFrame controls={null} subtitle="Recognize and monitor top performing patients.">
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
          <div className="px-6 py-14 text-center text-xs text-muted-foreground" data-testid="text-leaderboard-loading">
            Checking your session…
          </div>
        </div>
      </LeaderboardFrame>
    );
  }
  return <DemoLeaderboard />;
}

function LeaderboardFrame({ controls, subtitle, definitions, children }: { controls: ReactNode; subtitle: string; definitions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-serif text-[32px] leading-none tracking-[-.04em] text-navy">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
              <Trophy size={20} />
            </span>
            Patient Leaderboard
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
          {definitions}
        </div>

        {controls && <div className="flex flex-wrap gap-2">{controls}</div>}
      </div>
      {children}
    </div>
  );
}

// ─── Live branch ─────────────────────────────────────────────────────────────

function LiveLeaderboard({ office, isHq, authUserId }: { office: string | null; isHq: boolean; authUserId: string | null }) {
  const [metric, setMetric] = useState<LeaderboardMetric>("percent");
  const [period, setPeriod] = useState<LeaderboardPeriod>("program");
  const [stage, setStage] = useState<LeaderboardStage>("all");
  // HQ may widen the drilled-in office to the whole network; office staff
  // never send an office (the server scopes them).
  const [hqOffice, setHqOffice] = useState<string>(office ?? "all");
  const effectiveOffice = isHq ? hqOffice : null;
  const params = { office: effectiveOffice, period, stage };

  const query = useQuery({
    queryKey: leaderboardQueryKey(params, authUserId),
    queryFn: () => fetchOfficeLeaderboard(params),
    refetchInterval: 60_000,
    retry: (count, error) => !(error instanceof OfficeRosterError && [400, 401, 403, 404].includes(error.status)) && count < 2,
  });
  const data = query.data;

  const rows = data ? [...data.rows].sort((a, b) => a.ranks[metric] - b.ranks[metric] || a.name.localeCompare(b.name)) : [];
  const allOffices = isHq && effectiveOffice === "all";
  const boardName = data ? (data.office ? data.office.officeName : "All offices") : allOffices ? "All offices" : "Your office";

  const controls = (
    <>
      <select
        aria-label="Rank patients by metric"
        data-testid="select-leaderboard-metric"
        value={metric}
        onChange={(e) => setMetric(e.target.value as LeaderboardMetric)}
        className={selectClass}
      >
        <option value="percent">% Weight Lost</option>
        <option value="pounds">Total Lbs Lost</option>
        <option value="goal">Goal Completion</option>
        <option value="adherence">Adherence</option>
      </select>
      <select
        aria-label="Ranking period"
        data-testid="select-leaderboard-period"
        value={period}
        onChange={(e) => setPeriod(e.target.value as LeaderboardPeriod)}
        className={selectClass}
      >
        {(Object.keys(PERIOD_LABELS) as LeaderboardPeriod[]).map((key) => (
          <option key={key} value={key}>{PERIOD_LABELS[key]}</option>
        ))}
      </select>
      {isHq && <HqOfficeSelect value={hqOffice} onChange={setHqOffice} />}
      <select
        aria-label="Filter by program stage"
        data-testid="select-leaderboard-stage"
        value={stage}
        onChange={(e) => setStage(e.target.value as LeaderboardStage)}
        className={selectClass}
      >
        <option value="all">All Stages</option>
        <option value="protocol">6-Week Protocol</option>
        <option value="maintenance">Maintenance</option>
      </select>
    </>
  );

  const definitions = (
    <dl className="mt-3 max-w-[720px] space-y-1 text-[11px] leading-snug text-muted-foreground" data-testid="text-leaderboard-definitions">
      <div>
        <dt className="inline font-semibold text-navy">Adherence: </dt>
        <dd className="inline">{data?.definitions.adherence ?? "Loading the scoring definition…"}</dd>
      </div>
      {data && (
        <>
          <div>
            <dt className="inline font-semibold text-navy">Loss: </dt>
            <dd className="inline">{data.definitions.loss}</dd>
          </div>
          <div>
            <dt className="inline font-semibold text-navy">Who is ranked: </dt>
            <dd className="inline">{data.definitions.eligibility} {data.definitions.ties}</dd>
          </div>
        </>
      )}
    </dl>
  );

  const unauthorized = query.error instanceof OfficeRosterError && (query.error.status === 401 || query.error.status === 403);

  return (
    <LeaderboardFrame controls={controls} subtitle="Ranked from real weigh-ins, check-ins and diary activity." definitions={definitions}>
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border bg-secondary p-5">
          <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground" data-testid="text-leaderboard-board">
            Top Performers — {boardName}
          </h2>
          {/* The shell date range never filters this ranking; say so explicitly. */}
          <p className="text-[10px] text-muted-foreground" data-testid="text-leaderboard-scope">
            {PERIOD_LABELS[period]}{data ? ` — computed ${formatDay(data.asOf)} UTC, each patient on their own local day` : ""} — not filtered by the header date range
          </p>
        </div>

        {query.isPending ? (
          <div className="px-6 py-14 text-center text-xs text-muted-foreground" data-testid="text-leaderboard-loading" aria-live="polite">
            Ranking patients…
          </div>
        ) : query.isError ? (
          <div className="px-6 py-14 text-center" role="alert" data-testid="text-leaderboard-error">
            <p className="font-serif text-lg text-navy">
              {unauthorized ? "You don't have access to this leaderboard" : "The leaderboard could not be loaded"}
            </p>
            <p className="mt-1 text-xs text-destructive">{query.error instanceof Error ? query.error.message : "Unknown error."}</p>
            {!unauthorized && (
              <button
                type="button"
                onClick={() => void query.refetch()}
                data-testid="button-leaderboard-retry"
                className="mt-4 inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-semibold text-navy shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RefreshCw size={14} aria-hidden="true" /> Try again
              </button>
            )}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
              <Trophy size={18} />
            </span>
            <p className="mt-3 font-serif text-lg text-navy" data-testid="text-leaderboard-empty">
              {data && data.notRankable.total > 0 ? "No rankable patients yet" : "No patients to rank yet"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {data && data.notRankable.total > 0
                ? "Patients join the board once they are activated with a starting weight and at least one weigh-in in this period."
                : stage === "all"
                  ? "Rankings appear as soon as this office has activated patients with weigh-ins."
                  : "No patients in this stage. Try a different stage."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border" data-testid="list-leaderboard-live">
            {rows.map((row) => (
              <LiveRow key={row.id} row={row} metric={metric} period={period} showOffice={allOffices} href={rowHref(row, isHq, allOffices)} />
            ))}
          </div>
        )}

        {data && !query.isError && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-border bg-secondary px-5 py-3 text-[11px] text-muted-foreground">
            <p data-testid="text-leaderboard-ranked-count">
              <b className="font-semibold text-navy">{rows.length}</b> ranked
            </p>
            <p data-testid="text-leaderboard-not-rankable">
              <b className="font-semibold text-navy">{data.notRankable.total}</b> not yet rankable
              {data.notRankable.total > 0 && (
                <span> · {data.notRankable.reasons.map((reason) => `${reason.label} ${reason.count}`).join(" · ")}</span>
              )}
            </p>
          </div>
        )}
      </div>
    </LeaderboardFrame>
  );
}

function rowHref(row: LeaderboardRow, isHq: boolean, allOffices: boolean): string {
  // Inside an HQ drill-in the office app is nested, so relative links stay
  // in the drilled-in office; another office's patient needs its own
  // drill-in prefix (account ids are the provider ids).
  if (isHq && allOffices) return `~/admin/accounts/${encodeURIComponent(row.providerId)}/office/patients/${encodeURIComponent(row.id)}`;
  return `/patients/${encodeURIComponent(row.id)}`;
}

function formatDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function LiveRow({ row, metric, period, showOffice, href }: { row: LeaderboardRow; metric: LeaderboardMetric; period: LeaderboardPeriod; showOffice: boolean; href: string }) {
  const rank = row.ranks[metric];
  const isTop3 = rank <= 3;
  const stageLabel = row.program.stage === "maintenance"
    ? "Maintenance"
    : row.program.week != null
      ? `Week ${row.program.week}`
      : "Protocol";
  const adherence = row.adherence;
  const sub = [showOffice ? row.officeName : null, row.program.day != null ? `Day ${row.program.day}` : null, row.latestWeightDate ? `Weighed ${formatDay(row.latestWeightDate)}` : null]
    .filter(Boolean)
    .join(" • ");

  return (
    <div data-testid={`row-leaderboard-${row.id}`} className="group flex flex-wrap items-center gap-y-3 p-4 transition-colors hover:bg-accent/40 sm:flex-nowrap">
      <div className="w-12 shrink-0 text-center">
        <span data-testid={`text-rank-${row.id}`} className={`inline-block font-mono text-sm font-bold ${isTop3 ? `rounded-sm border px-2 py-1 ${rankColors[rank - 1]}` : "text-muted-foreground"}`}>
          #{rank}
        </span>
      </div>

      <div className="ml-4 flex flex-1 items-center gap-4">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-md text-xs font-bold ${isTop3 ? "bg-primary text-primary-foreground shadow-xs" : "bg-accent text-primary"}`}>
          {row.initials}
        </div>
        <div>
          <Link
            href={href}
            data-testid={`link-leaderboard-patient-${row.id}`}
            className="block rounded-sm font-semibold text-navy transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {row.name}
          </Link>
          <p className="mt-0.5 text-[10px] text-muted-foreground">{sub}</p>
          <span data-testid={`badge-stage-${row.id}`} className="mt-1 inline-block rounded-sm border border-accent-border bg-accent px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[.08em] text-primary">
            {stageLabel}
          </span>
        </div>
      </div>

      <div className="mr-6 text-right" data-testid={`text-metric-${row.id}`}>
        {metric === "percent" ? (
          <>
            <p className="font-mono text-lg font-semibold text-primary">{row.percentLost.toFixed(1)}%</p>
            <p className="text-[10px] text-muted-foreground">{row.poundsLost.toFixed(1)} lbs lost{period === "program" ? "" : ` · ${PERIOD_LABELS[period].toLowerCase()}`}</p>
          </>
        ) : metric === "pounds" ? (
          <>
            <p className="font-mono text-lg font-semibold text-primary">{row.poundsLost.toFixed(1)} lbs</p>
            <p className="text-[10px] text-muted-foreground">{row.percentLost.toFixed(1)}% of {row.baselineWeight.toFixed(0)} lb start</p>
          </>
        ) : metric === "goal" ? (
          <>
            <p className="font-mono text-lg font-semibold text-primary">{row.goalCompletion == null ? "—" : `${row.goalCompletion.toFixed(0)}%`}</p>
            <p className="text-[10px] text-muted-foreground">{row.goalCompletion == null ? "no goal weight set" : "goal complete (program to date)"}</p>
          </>
        ) : (
          <>
            <p className="font-mono text-lg font-semibold text-primary">{adherence.score == null ? "—" : `${adherence.score}/100`}</p>
            <p className="text-[10px] text-muted-foreground">
              {adherence.eligibleDays === 0
                ? "no scored days yet"
                : `logged ${adherence.loggedDays}/${adherence.eligibleDays} · check-ins ${adherence.checkInDays}/${adherence.eligibleDays} · water ${adherence.waterGoalDays}/${adherence.eligibleDays}`}
            </p>
          </>
        )}
      </div>

      <Link
        href={href}
        aria-label={`Open ${row.name}'s patient record`}
        data-testid={`link-leaderboard-open-${row.id}`}
        className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight size={16} />
      </Link>
    </div>
  );
}

/** HQ-only: the office picker reads the live provider directory, which only exists under the HQ data provider. */
function HqOfficeSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { accounts } = useHqData();
  const options = [...accounts].sort((a, b) => a.officeName.localeCompare(b.officeName));
  return (
    <select
      aria-label="Choose an office"
      data-testid="select-leaderboard-office"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={selectClass}
    >
      <option value="all">All offices</option>
      {options.map((account) => (
        <option key={account.id} value={account.id}>{account.officeName}</option>
      ))}
    </select>
  );
}

// ─── Guided demo (seeded board) ──────────────────────────────────────────────

function DemoLeaderboard() {
  const { getCurrentWeight } = usePatientSession();
  // One office's cohort inside the HQ drill-in; the full program otherwise.
  const patients = useScopedPatients();
  const providers = useScopedProviders();
  const [metric, setMetric] = useState<'percent' | 'pounds' | 'goal' | 'adherence'>('percent');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [stageFilter, setStageFilter] = useState<'all' | 'protocol' | 'maintenance'>('all');

  const rankedPatients = [...patients]
    .filter(p => (providerFilter === 'all' || p.providerId === providerFilter) && (stageFilter === 'all' || p.stage === stageFilter))
    .sort((a, b) => {
      if (metric === 'pounds') {
        const aLoss = a.startingWeight - getCurrentWeight(a);
        const bLoss = b.startingWeight - getCurrentWeight(b);
        return bLoss - aLoss;
      }
      if (metric === 'goal') {
        const aGoal = (a.startingWeight - getCurrentWeight(a)) / (a.startingWeight - a.goalWeight);
        const bGoal = (b.startingWeight - getCurrentWeight(b)) / (b.startingWeight - b.goalWeight);
        return bGoal - aGoal;
      }
      if (metric === 'adherence') {
        return b.adherence - a.adherence;
      }
      {
        const aPercent = ((a.startingWeight - getCurrentWeight(a)) / a.startingWeight) * 100;
        const bPercent = ((b.startingWeight - getCurrentWeight(b)) / b.startingWeight) * 100;
        return bPercent - aPercent;
      }
    });

  const controls = (
    <>
      <select
        aria-label="Rank patients by metric"
        data-testid="select-leaderboard-metric"
        value={metric}
        onChange={(e) => setMetric(e.target.value as typeof metric)}
        className={selectClass}
      >
        <option value="percent">% Weight Lost</option>
        <option value="pounds">Total Lbs Lost</option>
        <option value="goal">Goal Completion</option>
        <option value="adherence">Adherence</option>
      </select>

      <select
        aria-label="Filter by provider"
        data-testid="select-leaderboard-provider"
        value={providerFilter}
        onChange={(e) => setProviderFilter(e.target.value)}
        className={selectClass}
      >
        <option value="all">All Providers</option>
        {providers.map(p => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <select
        aria-label="Filter by program stage"
        data-testid="select-leaderboard-stage"
        value={stageFilter}
        onChange={(e) => setStageFilter(e.target.value as typeof stageFilter)}
        className={selectClass}
      >
        <option value="all">All Stages</option>
        <option value="protocol">6-Week Protocol</option>
        <option value="maintenance">Maintenance</option>
      </select>
    </>
  );

  return (
    <LeaderboardFrame controls={controls} subtitle="Recognize and monitor top performing patients.">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border bg-secondary p-5">
          <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground">Top Performers — Current Cohorts</h2>
          {/* The shell date range never filters this ranking; say so explicitly. */}
          <p className="text-[10px] text-muted-foreground" data-testid="text-leaderboard-scope">
            Ranked over each patient's full program to date — not filtered by the header date range
          </p>
        </div>

        {rankedPatients.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
              <Trophy size={18} />
            </span>
            <p className="mt-3 font-serif text-lg text-navy" data-testid="text-leaderboard-empty">No patients match these filters</p>
            <p className="mt-1 text-xs text-muted-foreground">Try a different provider or stage combination to see cohort standings.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rankedPatients.map((patient, idx) => {
              const provider = providers.find(p => p.id === patient.providerId);
              const weightLoss = patient.startingWeight - getCurrentWeight(patient);
              const percentLoss = ((weightLoss / patient.startingWeight) * 100).toFixed(1);
              const goalProgress = Math.max(0, Math.min(100, ((weightLoss / (patient.startingWeight - patient.goalWeight)) * 100)));
              const milestone = patient.stage === 'maintenance'
                ? 'Protocol graduate'
                : goalProgress >= 75
                  ? '75% goal reached'
                  : weightLoss >= 25
                    ? '25 lb milestone'
                    : patient.adherence >= 95
                      ? 'High adherence'
                      : `Week ${patient.protocolWeek}`;

              const isTop3 = idx < 3;

              return (
                <div key={patient.id} data-testid={`row-leaderboard-${patient.id}`} className="group flex flex-wrap items-center gap-y-3 p-4 transition-colors hover:bg-accent/40 sm:flex-nowrap">
                  <div className="w-12 shrink-0 text-center">
                    <span data-testid={`text-rank-${patient.id}`} className={`inline-block font-mono text-sm font-bold ${isTop3 ? `rounded-sm border px-2 py-1 ${rankColors[idx]}` : 'text-muted-foreground'}`}>
                      #{idx + 1}
                    </span>
                  </div>

                  <div className="ml-4 flex flex-1 items-center gap-4">
                    <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-md text-xs font-bold ${isTop3 ? 'bg-primary text-primary-foreground shadow-xs' : 'bg-accent text-primary'}`}>
                      {patient.initials}
                    </div>
                    <div>
                      <Link
                        href={`/patients/${patient.id}`}
                        data-testid={`link-leaderboard-patient-${patient.id}`}
                        className="block rounded-sm font-semibold text-navy transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {patient.name}
                      </Link>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {provider?.name} • Wk {patient.protocolWeek}
                      </p>
                      <span data-testid={`badge-milestone-${patient.id}`} className="mt-1 inline-block rounded-sm border border-accent-border bg-accent px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[.08em] text-primary">
                        {milestone}
                      </span>
                    </div>
                  </div>

                  <div className="mr-6 text-right" data-testid={`text-metric-${patient.id}`}>
                    {metric === 'percent' ? (
                      <>
                        <p className="font-mono text-lg font-semibold text-primary">{percentLoss}%</p>
                        <p className="text-[10px] text-muted-foreground">{weightLoss.toFixed(1)} lbs lost</p>
                      </>
                    ) : metric === 'pounds' ? (
                      <>
                        <p className="font-mono text-lg font-semibold text-primary">{weightLoss.toFixed(1)} lbs</p>
                        <p className="text-[10px] text-muted-foreground">{percentLoss}% total</p>
                      </>
                    ) : metric === 'goal' ? (
                      <>
                        <p className="font-mono text-lg font-semibold text-primary">{goalProgress.toFixed(0)}%</p>
                        <p className="text-[10px] text-muted-foreground">goal complete</p>
                      </>
                    ) : (
                      <>
                        <p className="font-mono text-lg font-semibold text-primary">{patient.adherence}/100</p>
                        <p className="text-[10px] text-muted-foreground">adherence</p>
                      </>
                    )}
                  </div>

                  <Link
                    href={`/patients/${patient.id}`}
                    aria-label={`Open ${patient.name}'s patient record`}
                    data-testid={`link-leaderboard-open-${patient.id}`}
                    className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight size={16} />
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </LeaderboardFrame>
  );
}
