import { useState } from "react";
import { Link } from "wouter";
import { Trophy, ChevronRight } from "lucide-react";
import { MOCK_PATIENTS, MOCK_PROVIDERS } from "@/data/mock-data";

export default function Leaderboard() {
  const [metric, setMetric] = useState<'percent' | 'pounds' | 'goal' | 'adherence'>('percent');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [stageFilter, setStageFilter] = useState<'all' | 'protocol' | 'maintenance'>('all');

  const rankedPatients = [...MOCK_PATIENTS]
    .filter(p => (providerFilter === 'all' || p.providerId === providerFilter) && (stageFilter === 'all' || p.stage === stageFilter))
    .sort((a, b) => {
      if (metric === 'pounds') {
        const aLoss = a.startingWeight - a.currentWeight;
        const bLoss = b.startingWeight - b.currentWeight;
        return bLoss - aLoss;
      }
      if (metric === 'goal') {
        const aGoal = (a.startingWeight - a.currentWeight) / (a.startingWeight - a.goalWeight);
        const bGoal = (b.startingWeight - b.currentWeight) / (b.startingWeight - b.goalWeight);
        return bGoal - aGoal;
      }
      if (metric === 'adherence') {
        return b.adherence - a.adherence;
      }
      {
        const aPercent = ((a.startingWeight - a.currentWeight) / a.startingWeight) * 100;
        const bPercent = ((b.startingWeight - b.currentWeight) / b.startingWeight) * 100;
        return bPercent - aPercent;
      }
    });

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[32px] leading-none tracking-[-.04em] text-[#172c56] flex items-center gap-3">
            <Trophy className="text-[#315fc0]" size={28} />
            Patient Leaderboard
          </h1>
          <p className="mt-2 text-sm text-[#718099]">Recognize and monitor top performing patients.</p>
        </div>
        
        <div className="flex flex-wrap gap-2">
          <select 
            value={metric}
            onChange={(e) => setMetric(e.target.value as typeof metric)}
            className="h-9 border border-[#bdc9dc] bg-[#f8f9fc] px-3 text-xs font-semibold text-[#344c77] outline-none focus:border-[#315fc0]"
          >
            <option value="percent">% Weight Lost</option>
            <option value="pounds">Total Lbs Lost</option>
            <option value="goal">Goal Completion</option>
            <option value="adherence">Adherence</option>
          </select>
          
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="h-9 border border-[#bdc9dc] bg-[#f8f9fc] px-3 text-xs font-semibold text-[#344c77] outline-none focus:border-[#315fc0]"
          >
            <option value="all">All Providers</option>
            {MOCK_PROVIDERS.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            aria-label="Filter by program stage"
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value as typeof stageFilter)}
            className="h-9 border border-[#bdc9dc] bg-[#f8f9fc] px-3 text-xs font-semibold text-[#344c77] outline-none focus:border-[#315fc0]"
          >
            <option value="all">All Stages</option>
            <option value="protocol">6-Week Protocol</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </div>
      </div>

      <div className="border border-[#bdc9dc] bg-[#fbfcff]">
        <div className="p-5 border-b border-[#bdc9dc] bg-[#f8f9fc]">
          <h2 className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">Top Performers - Current Cohorts</h2>
        </div>
        
        <div className="divide-y divide-[#e4e8f0]">
          {rankedPatients.map((patient, idx) => {
            const provider = MOCK_PROVIDERS.find(p => p.id === patient.providerId);
            const weightLoss = patient.startingWeight - patient.currentWeight;
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
            const rankColors = [
              "bg-[#fff6e5] text-[#97631e] border-[#d7b889]", // 1st Gold
              "bg-[#f0f3f9] text-[#53698f] border-[#bdc9dc]", // 2nd Silver
              "bg-[#fdf4ee] text-[#b06132] border-[#e7bba3]"  // 3rd Bronze
            ];
            
            return (
              <div key={patient.id} className="group flex flex-wrap items-center gap-y-3 p-4 hover:bg-[#f0f3f9] transition-colors sm:flex-nowrap">
                <div className="w-12 text-center shrink-0">
                  <span className={`inline-block font-mono font-bold text-sm ${isTop3 ? `px-2 py-1 border ${rankColors[idx]}` : 'text-[#8793a8]'}`}>
                    #{idx + 1}
                  </span>
                </div>
                
                <div className="flex-1 flex items-center gap-4 ml-4">
                  <div className={`grid h-10 w-10 shrink-0 place-items-center text-xs font-bold ${isTop3 ? 'bg-[#172c56] text-white' : 'bg-[#dce6fa] text-[#3156a2]'}`}>
                    {patient.initials}
                  </div>
                  <div>
                    <Link href={`/patients/${patient.id}`} className="block font-semibold text-[#172c56] hover:text-[#315fc0] hover:underline">
                      {patient.name}
                    </Link>
                    <p className="text-[10px] text-[#7b879d] mt-0.5">
                      {provider?.name} • Wk {patient.protocolWeek}
                    </p>
                    <span className="mt-1 inline-block border border-[#c6d2ea] bg-[#eef3fc] px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[.08em] text-[#3156a2]">
                      {milestone}
                    </span>
                  </div>
                </div>
                
                <div className="text-right mr-6">
                  {metric === 'percent' ? (
                    <>
                      <p className="font-mono text-lg font-semibold text-[#315fc0]">{percentLoss}%</p>
                      <p className="text-[10px] text-[#8793a8]">{weightLoss.toFixed(1)} lbs lost</p>
                    </>
                  ) : metric === 'pounds' ? (
                    <>
                      <p className="font-mono text-lg font-semibold text-[#315fc0]">{weightLoss.toFixed(1)} lbs</p>
                      <p className="text-[10px] text-[#8793a8]">{percentLoss}% total</p>
                    </>
                  ) : metric === 'goal' ? (
                    <>
                      <p className="font-mono text-lg font-semibold text-[#315fc0]">{goalProgress.toFixed(0)}%</p>
                      <p className="text-[10px] text-[#8793a8]">goal complete</p>
                    </>
                  ) : (
                    <>
                      <p className="font-mono text-lg font-semibold text-[#315fc0]">{patient.adherence}/100</p>
                      <p className="text-[10px] text-[#8793a8]">adherence</p>
                    </>
                  )}
                </div>
                
                <Link href={`/patients/${patient.id}`} className="text-[#8793a8] group-hover:text-[#315fc0] p-2 hover:bg-[#e9eef8] transition-colors">
                  <ChevronRight size={16} />
                </Link>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
