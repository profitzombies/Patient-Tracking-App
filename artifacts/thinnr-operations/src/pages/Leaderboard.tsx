import { useState } from "react";
import { Link } from "wouter";
import { Trophy, ChevronRight } from "lucide-react";
import { useScopedPatients, useScopedProviders } from "@/data/scoped-data";
import { usePatientSession } from "@/contexts/patient-session";

/** Shared Heritage control treatment for the native filter selects. */
const selectClass =
  "h-9 rounded-md border border-border bg-card px-3 text-xs font-semibold text-navy shadow-xs outline-none transition hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

export default function Leaderboard() {
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
          <p className="mt-2 text-sm text-muted-foreground">Recognize and monitor top performing patients.</p>
        </div>

        <div className="flex flex-wrap gap-2">
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
        </div>
      </div>

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
              // Medal tints are content semantics (podium places), kept as
              // literals but softened onto the Heritage cream paper.
              const rankColors = [
                "bg-[#fff6e5] text-[#97631e] border-[#d7b889]", // 1st Gold
                "bg-[#f0f3f9] text-[#53698f] border-[#bdc9dc]", // 2nd Silver
                "bg-[#fdf4ee] text-[#b06132] border-[#e7bba3]"  // 3rd Bronze
              ];

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
    </div>
  );
}
