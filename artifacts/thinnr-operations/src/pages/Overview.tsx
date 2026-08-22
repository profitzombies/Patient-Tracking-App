import { useMemo, useState, ReactNode } from "react";
import { Link } from "wouter";
import {
  Activity,
  ArrowUpRight,
  Filter,
  MoreHorizontal,
  ShieldAlert,
  Users,
  WalletCards,
  X,
  ChevronDown
} from "lucide-react";
import { MOCK_ANALYTICS, MOCK_PATIENTS, MOCK_PROVIDERS, MOCK_SUBSCRIPTIONS } from "@/data/mock-data";
import { useToast } from "@/hooks/use-toast";
import { usePatientSession } from "@/contexts/patient-session";

type Range = "12 months" | "6 months" | "30 days";

function ActionButton({ label, children, onClick }: { label: string; children: ReactNode; onClick: () => void }) {
  return (
    <button 
      aria-label={label} 
      onClick={onClick} 
      className="grid h-9 w-9 place-items-center border border-[#bdc9dc] bg-[#f8f9fc] text-[#344c77] transition hover:border-[#2450a3] hover:bg-[#e9eef8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0]"
    >
      {children}
    </button>
  );
}

function Metric({ icon, label, value, change, detail, warning = false }: { icon: ReactNode; label: string; value: string; change: string; detail: string; warning?: boolean }) {
  return (
    <div className="border border-[#bdc9dc] bg-[#fbfcff] p-4 transition hover:-translate-y-0.5 hover:border-[#315fc0]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.14em] text-[#687895]">
          {icon}{label}
        </span>
        <span className={`border px-2 py-1 text-[10px] font-bold ${warning ? "border-[#d7b889] bg-[#fff6e5] text-[#9a621d]" : "border-[#aec0e2] bg-[#edf2fc] text-[#3156a2]"}`}>
          {change}
        </span>
      </div>
      <p className="mt-4 font-mono text-[27px] font-semibold tracking-[-.07em] text-[#172c56]">{value}</p>
      <p className="mt-1 text-xs text-[#7b879d]">{detail}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isHealthy = status === 'active' || status === 'graduated';
  const isWatch = status === 'paused';
  const isRisk = status === 'overdue' || status === 'cancelled';
  
  const styles = isHealthy 
    ? "border-[#aebfe0] bg-[#eef3fc] text-[#3156a2]"
    : isWatch 
    ? "border-[#d7b889] bg-[#fff6e5] text-[#97631e]" 
    : "border-[#d5a7a7] bg-[#fff0f0] text-[#a04646]";
  
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] font-bold uppercase tracking-[.05em] ${styles}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

const trend = [48, 52, 55, 53, 61, 66, 70, 68, 76, 82, 88, 94];
const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];

function TrendChart({ range }: { range: Range }) {
  const values = range === "30 days" ? [66, 70, 68, 76, 82, 88, 94] : range === "6 months" ? trend.slice(6) : trend;
  const labels = range === "30 days" ? ["Apr 01", "Apr 06", "Apr 11", "Apr 16", "Apr 21", "Apr 26", "Apr 30"] : range === "6 months" ? months.slice(6) : months;
  const max = Math.max(...values);
  return (
    <div className="relative mt-5">
      <div className="relative h-[190px]">
        <div className="absolute inset-0 bottom-0 flex flex-col justify-between text-[10px] text-[#8793a8]">
        {[100, 75, 50, 25, 0].map((n) => (
          <div key={n} className="flex items-center gap-3">
            <span className="w-7 text-right font-mono">{n === 0 ? "$0" : `$${n * 30}k`}</span>
            <div className="h-px flex-1 bg-[#dbe2ee]" />
          </div>
        ))}
        </div>
        <div className="absolute bottom-0 left-11 right-0 top-1 flex items-end gap-[clamp(5px,1.2vw,16px)]">
          {values.map((v, i) => (
            <div key={`${labels[i]}-${v}`} className="group relative flex h-full flex-1 items-end">
              <div className="w-full bg-[#315fc0] transition group-hover:bg-[#172c56]" style={{ height: `${(v / max) * 88 + 8}%` }} />
              <span className="absolute -top-6 left-1/2 hidden -translate-x-1/2 border border-[#315fc0] bg-[#172c56] px-1.5 py-1 text-[10px] text-[#f8f9fc] group-hover:block whitespace-nowrap z-10">
                ${Math.round(v * 3.1)}k
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex justify-between pl-11 text-[10px] text-[#7d899f]">
        {labels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}

export default function Overview() {
  const { getCurrentWeight } = usePatientSession();
  const [range, setRange] = useState<Range>("12 months");
  const [showNotice, setShowNotice] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const [providerFilter, setProviderFilter] = useState('all');
  const { toast } = useToast();

  const cycleRange = () => setRange(range === "12 months" ? "6 months" : range === "6 months" ? "30 days" : "12 months");

  const filteredPatients = useMemo(
    () => MOCK_PATIENTS.filter((patient) => providerFilter === 'all' || patient.providerId === providerFilter),
    [providerFilter],
  );
  const overduePatients = filteredPatients.filter(p => p.status === 'overdue');
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
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.16em] text-[#3156a2]">
            <Activity size={14} /> Practice Pulse <span className="h-1 w-1 rounded-full bg-[#8b9aba]" /> {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
          <h1 className="font-serif text-[32px] leading-none tracking-[-.04em] text-[#172c56] md:text-[38px]">
            Good morning, Dr. Jenkins.
          </h1>
          <p className="mt-2 text-sm text-[#718099]">Here’s what changed since your last login.</p>
        </div>
        <div className="relative flex items-center gap-2">
          {selectedProvider && (
            <span className="hidden border border-[#aec0e2] bg-[#edf2fc] px-2 py-2 text-[10px] font-bold uppercase tracking-[.08em] text-[#3156a2] sm:inline">
              {selectedProvider.name}
            </span>
          )}
          <button 
            onClick={cycleRange} 
            className="flex h-9 items-center gap-2 border border-[#bdc9dc] bg-[#f8f9fc] px-3 text-xs font-semibold text-[#344c77] transition hover:border-[#315fc0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0]"
          >
            <span className="text-[#8793a8]">Range</span>
            {range}
            <ChevronDown size={14} />
          </button>
          <ActionButton label="Filter dashboard" onClick={() => setFilterOpen(!filterOpen)}>
            <Filter size={15} />
          </ActionButton>
          
          {filterOpen && (
            <div className="absolute right-0 top-11 z-10 w-44 border border-[#bdc9dc] bg-[#fbfcff] p-2 text-xs shadow-[0_10px_30px_rgba(34,55,93,.16)]">
              <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#8793a8]">View filter</p>
              {[{ id: 'all', name: 'All Providers' }, ...MOCK_PROVIDERS].map((provider) => (
                <button 
                  key={provider.id}
                  onClick={() => {
                    setProviderFilter(provider.id);
                    setFilterOpen(false);
                    toast({ title: `Filtered by ${provider.name}`, description: 'Patient-specific dashboard views now reflect this provider.' });
                  }}
                  className={`block w-full px-2 py-2 text-left hover:bg-[#e9eef8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#315fc0] ${providerFilter === provider.id ? 'bg-[#e9eef8] font-bold text-[#172c56]' : 'text-[#45618f]'}`}
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
        <div className="mt-5 flex items-center gap-3 border border-[#d7b889] bg-[#fff6e5] px-4 py-3 text-sm text-[#75501e]">
          <ShieldAlert size={17} className="shrink-0 text-[#a8691e]" />
          <span><b>{overduePatients.length} patients need attention.</b> Check-ins or subscription renewals are past due.</span>
          <Link href="/patients" className="ml-auto whitespace-nowrap text-xs font-bold underline underline-offset-4 hover:text-[#4d3518]">
            Review patients
          </Link>
          <button aria-label="Dismiss alert" onClick={() => setShowNotice(false)} className="ml-1 p-1 hover:bg-[#f4e7cc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a8691e]">
            <X size={15} />
          </button>
        </div>
      )}

      {/* Charts / Mid Section */}
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <section className="border border-[#bdc9dc] bg-[#fbfcff] p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">Revenue Trend</p>
              <div className="mt-1 flex items-end gap-3">
                <h2 className="font-mono text-2xl font-semibold tracking-[-.05em] text-[#172c56]">
                  ${(MOCK_ANALYTICS.monthlyRevenue / 1000).toFixed(1)}k
                </h2>
                <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-[#3156a2]">
                  <ArrowUpRight size={14} />12.4%
                </span>
              </div>
            </div>
            <button 
              onClick={() => toast({ title: "Chart menu opened" })} 
              aria-label="More chart options" 
              className="p-1.5 text-[#8390a6] hover:bg-[#e9eef8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0]"
            >
              <MoreHorizontal size={17} />
            </button>
          </div>
          <TrendChart range={range} />
        </section>

        <section className="border border-[#bdc9dc] bg-[#fbfcff] p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">Protocol Stages</p>
              <h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#284675]">{MOCK_ANALYTICS.activePatients} Active</h2>
            </div>
            <Link href="/analytics" className="text-xs font-semibold text-[#3156a2] hover:text-[#172c56]">
              Details <ArrowUpRight size={13} className="inline" />
            </Link>
          </div>
          <div className="mt-6 space-y-4">
            {[
              ["Maintenance", "65%", MOCK_ANALYTICS.stageCounts.maintenance, "bg-[#315fc0]"], 
              ["Protocol Weeks 1-3", "20%", MOCK_ANALYTICS.stageCounts.week1 + MOCK_ANALYTICS.stageCounts.week2 + MOCK_ANALYTICS.stageCounts.week3, "bg-[#5576c2]"], 
              ["Protocol Weeks 4-6", "15%", MOCK_ANALYTICS.stageCounts.week4 + MOCK_ANALYTICS.stageCounts.week5 + MOCK_ANALYTICS.stageCounts.week6, "bg-[#8da4d6]"]
            ].map(([name, pct, count, color]) => (
              <div key={name as string}>
                <div className="mb-1.5 flex justify-between text-xs">
                  <span className="font-medium text-[#53698f]">{name}</span>
                  <span className="font-mono text-[#8290a7]">{count} <b className="ml-2 text-[#284675]">{pct}</b></span>
                </div>
                <div className="h-2 overflow-hidden bg-[#e4e9f2]">
                  <div className={`h-full ${color}`} style={{ width: pct as string }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Watchlist and Signals */}
      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_1.45fr]">
        <section className="border border-[#bdc9dc] bg-[#fbfcff] p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">Priority items</p>
              <h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#284675]">Worth a closer look</h2>
            </div>
            <span className="border border-[#d7b889] bg-[#fff6e5] px-2 py-1 text-[10px] font-bold text-[#97631e]">
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
              className="group flex w-full items-start gap-3 border-t border-[#dfe5ef] py-3 text-left first:border-0 hover:bg-[#f0f3f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#315fc0]"
            >
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone === "risk" ? "bg-[#b65b5b]" : tone === "watch" ? "bg-[#bc821e]" : "bg-[#315fc0]"}`} />
              <span className="min-w-0 flex-1">
                <b className="block text-xs text-[#3b5686]">{title}</b>
                <span className="mt-1 block text-[11px] leading-4 text-[#8996ab]">{body}</span>
              </span>
              <span className={`text-[10px] font-bold ${tone === "risk" ? "text-[#a04646]" : tone === "watch" ? "text-[#97631e]" : "text-[#3156a2]"}`}>
                {level}
              </span>
            </button>
          ))}
        </section>

        <section className="border border-[#bdc9dc] bg-[#fbfcff] p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">Patient watchlist</p>
              <h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#284675]">Recent Check-ins & Overdue</h2>
            </div>
            <Link href="/patients" className="text-xs font-semibold text-[#3156a2] hover:text-[#172c56]">
              View all roster <ArrowUpRight size={13} className="inline" />
            </Link>
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[540px] text-left text-xs">
              <thead className="border-b border-[#d5deeb] text-[10px] uppercase tracking-[.11em] text-[#8290a7]">
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
                    <tr key={patient.id} className="group border-b border-[#e4e8f0] last:border-0 hover:bg-[#f0f3f9]">
                      <td className="py-3 font-semibold text-[#3b5686]">
                        <Link href={`/patients/${patient.id}`} className="hover:underline">{patient.name}</Link>
                      </td>
                      <td className="py-3 text-[#7b879d]">{provider?.name.split(',')[0]}</td>
                      <td className="py-3 text-[#7b879d] capitalize">{patient.stage === 'protocol' ? `Wk ${patient.protocolWeek}` : 'Maintenance'}</td>
                      <td className="py-3">
                        <StatusBadge status={patient.status} />
                      </td>
                      <td className="py-3 text-right font-mono text-[#53698f]">
                        {lbsLost.toFixed(1)} lbs
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="divide-y divide-[#e4e8f0] md:hidden">
            {filteredPatients.slice(0, 5).map((patient) => {
              const provider = MOCK_PROVIDERS.find((candidate) => candidate.id === patient.providerId);
               const lbsLost = patient.startingWeight - getCurrentWeight(patient);
              return (
                <Link
                  key={patient.id}
                  href={`/patients/${patient.id}`}
                  className="flex items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#315fc0]"
                >
                  <span className="min-w-0">
                    <b className="block truncate text-xs text-[#3b5686]">{patient.name}</b>
                    <span className="mt-1 block truncate text-[10px] text-[#8793a8]">{provider?.name.split(',')[0]} · {patient.stage === 'protocol' ? `Week ${patient.protocolWeek}` : 'Maintenance'}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <StatusBadge status={patient.status} />
                    <span className="mt-1 block font-mono text-[10px] text-[#53698f]">{lbsLost.toFixed(1)} lbs lost</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      </div>

      {/* Activity Feed */}
      <section className="mt-5 border border-[#bdc9dc] bg-[#fbfcff] p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#74839d]">Recent activity</p>
            <h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#284675]">Team movement</h2>
          </div>
          <button 
            onClick={() => toast({ title: "Full activity log opened" })} 
            className="border border-[#bdc9dc] px-3 py-2 text-xs font-semibold text-[#53698f] hover:bg-[#e9eef8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0]"
          >
            Full activity
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {[
            ["PS", "Elena Rostova", "completed week 4 check-in for Emma S.", "12 min ago", "bg-[#dce5f5] text-[#3156a2]"], 
            ["MC", "Michael Chen", "flagged overdue check-in for Liam J.", "46 min ago", "bg-[#f1ddd8] text-[#965452]"], 
            ["SJ", "Sarah Jenkins", "approved Maintenance Stack for Olivia W.", "2 hr ago", "bg-[#e0e4f0] text-[#53698f]"]
          ].map(([initials, name, action, time, color]) => (
            <button 
              key={name} 
              onClick={() => toast({ title: `${name}'s activity opened` })} 
              className="flex items-center gap-3 border border-[#dfe5ef] p-3 text-left transition hover:border-[#9eb2d9] hover:bg-[#f0f3f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315fc0]"
            >
              <span className={`grid h-8 w-8 shrink-0 place-items-center text-[10px] font-bold ${color}`}>{initials}</span>
              <span className="min-w-0">
                <b className="block truncate text-xs text-[#3b5686]">{name} <span className="font-normal text-[#8794a9]">{action}</span></b>
                <span className="mt-1 block text-[10px] text-[#9aa5b7]">{time}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
