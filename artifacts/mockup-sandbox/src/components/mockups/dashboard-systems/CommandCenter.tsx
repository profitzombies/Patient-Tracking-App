import { useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  BriefcaseBusiness,
  ChevronDown,
  CircleHelp,
  Command,
  Filter,
  LayoutDashboard,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  Target,
  Users,
  X,
  Zap,
} from "lucide-react";

const trend = [38, 44, 41, 48, 50, 56, 54, 63, 67, 73, 78, 86];
const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];

type Health = "Healthy" | "Watch" | "At risk";
type Account = { initials: string; name: string; owner: string; plan: string; health: Health; value: string };

const accounts: Account[] = [
  { initials: "AC", name: "Atlas Commerce", owner: "Mia Chen", plan: "Enterprise", health: "Healthy", value: "$184.2k" },
  { initials: "NV", name: "Noviant Labs", owner: "Theo Grant", plan: "Growth", health: "Watch", value: "$92.8k" },
  { initials: "PP", name: "Paperplane", owner: "Iris Wong", plan: "Enterprise", health: "At risk", value: "$71.4k" },
  { initials: "BK", name: "Bark & Kiln", owner: "Mia Chen", plan: "Growth", health: "Healthy", value: "$58.6k" },
];

function Metric({ label, value, change, note, alert }: { label: string; value: string; change?: string; note: string; alert?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_25px_rgba(18,42,57,0.08)] ${alert ? "border-[#e7c8b6] bg-[#fffaf6]" : "border-[#dce6e8] bg-[#fbfdfc]"}`}>
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.11em] text-[#6a7d82]">
        <span>{label}</span>{alert && <ShieldAlert size={15} className="text-[#c15d35]" />}
      </div>
      <div className="mt-3 flex items-end gap-2">
        <span className={`font-mono text-[27px] font-bold tracking-[-0.06em] ${alert ? "text-[#ad4d2d]" : "text-[#163743]"}`}>{value}</span>
        {change && <span className="mb-1 flex items-center text-xs font-semibold text-[#258267]"><ArrowUpRight size={14} />{change}</span>}
      </div>
      <p className="mt-1 text-xs text-[#819196]">{note}</p>
    </div>
  );
}

function HealthPill({ health }: { health: Health }) {
  const styles = health === "Healthy" ? "bg-[#e4f3ec] text-[#28785f]" : health === "Watch" ? "bg-[#fff1d7] text-[#9c6b18]" : "bg-[#fce8e1] text-[#ae4c2d]";
  return <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${styles}`}>{health}</span>;
}

export function CommandCenter() {
  const [range, setRange] = useState("Last 12 months");
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selectedNav, setSelectedNav] = useState("Command center");
  const visibleAccounts = showAll ? accounts : accounts.slice(0, 3);
  const action = (message: string) => setNotice(message);

  return (
    <main className="min-h-[100dvh] bg-[#f4f8f7] text-[#163743]" style={{ fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif" }}>
      <div className="flex min-h-[100dvh]">
        <aside className={`${collapsed ? "w-[76px]" : "w-[218px]"} sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[#d9e5e5] bg-[#eaf2f0] px-3 py-5 transition-all duration-300 md:flex`}>
          <div className={`flex items-center gap-3 px-3 ${collapsed ? "justify-center" : ""}`}>
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-[#153e49] text-[#d3f2e9]"><Command size={17} /></div>
            {!collapsed && <div><div className="text-[15px] font-bold tracking-[-0.03em]">northstar</div><div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-[#789097]">Revenue OS</div></div>}
          </div>
          <div className="mt-9 space-y-1">
            {!collapsed && <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[#8a9b9d]">Workspace</p>}
            {[
              { label: "Command center", icon: LayoutDashboard },
              { label: "Accounts", icon: BriefcaseBusiness },
              { label: "Signals", icon: Zap },
              { label: "Team activity", icon: Activity },
            ].map(({ label, icon: Icon }) => <button key={label} onClick={() => { setSelectedNav(label); action(`${label} view selected`); }} className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[#2b8d79] ${selectedNav === label ? "bg-[#d3e8e2] text-[#174d4d]" : "text-[#63787d] hover:bg-[#deebe8] hover:text-[#214b54]"} ${collapsed ? "justify-center" : ""}`} title={collapsed ? label : undefined}><Icon size={16} />{!collapsed && label}</button>)}
          </div>
          <div className="mt-auto space-y-1">
            <button onClick={() => action("Search opened")} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-semibold text-[#63787d] hover:bg-[#deebe8] focus:outline-none focus:ring-2 focus:ring-[#2b8d79] ${collapsed ? "justify-center" : ""}`} title="Search"><Search size={16} />{!collapsed && "Search"}</button>
            <button onClick={() => action("Settings opened")} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-semibold text-[#63787d] hover:bg-[#deebe8] focus:outline-none focus:ring-2 focus:ring-[#2b8d79] ${collapsed ? "justify-center" : ""}`} title="Settings"><Settings2 size={16} />{!collapsed && "Settings"}</button>
            <div className={`mt-4 flex items-center gap-2 border-t border-[#d3e1df] pt-4 ${collapsed ? "justify-center" : "px-2"}`}><div className="grid h-7 w-7 place-items-center rounded-full bg-[#d7b8a5] text-[10px] font-bold text-[#653d2d]">MC</div>{!collapsed && <div className="min-w-0"><p className="truncate text-[11px] font-bold">Mia Chen</p><p className="text-[10px] text-[#829397]">Admin</p></div>}</div>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex h-[72px] items-center justify-between border-b border-[#dce7e6] bg-[#f8fbfa] px-5 md:px-8">
            <div className="flex items-center gap-3"><button onClick={() => setCollapsed(!collapsed)} className="rounded-md p-2 text-[#71878a] hover:bg-[#e6f0ee] focus:outline-none focus:ring-2 focus:ring-[#2b8d79]" aria-label="Toggle sidebar"><PanelLeft size={18} /></button><div className="hidden text-xs text-[#849496] sm:block">Workspace <span className="mx-2 text-[#c3cfce]">/</span> <span className="font-semibold text-[#365761]">{selectedNav}</span></div></div>
            <div className="flex items-center gap-2"><button onClick={() => action("Invite flow opened")} className="hidden items-center gap-2 rounded-lg border border-[#ccdcda] bg-[#f8fbfa] px-3 py-2 text-xs font-bold text-[#315a61] transition hover:border-[#8fbcb1] hover:bg-[#edf6f3] focus:outline-none focus:ring-2 focus:ring-[#2b8d79] sm:flex"><Plus size={15} /> Invite teammate</button><button onClick={() => action("You have 3 unread notifications")} className="relative rounded-lg p-2 text-[#71878a] hover:bg-[#e6f0ee] focus:outline-none focus:ring-2 focus:ring-[#2b8d79]" aria-label="Notifications"><Bell size={18} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#d26742]" /></button><button onClick={() => action("Help center opened")} className="rounded-lg p-2 text-[#71878a] hover:bg-[#e6f0ee] focus:outline-none focus:ring-2 focus:ring-[#2b8d79]" aria-label="Help"><CircleHelp size={18} /></button></div>
          </header>
          <div className="mx-auto max-w-[1400px] px-5 py-7 md:px-8">
            <div className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div><div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#bc6748]"><span className="h-1.5 w-1.5 rounded-full bg-[#d26742]" /> Monday, April 29, 2024</div><h1 className="text-[29px] font-bold tracking-[-0.055em] text-[#163743]">Good morning, Mia.</h1><p className="mt-1 text-sm text-[#708488]">Here’s what deserves your attention today.</p></div><div className="flex items-center gap-2"><div className="relative"><select value={range} onChange={(e) => { setRange(e.target.value); action(`Range updated to ${e.target.value}`); }} className="appearance-none rounded-lg border border-[#ccdcd9] bg-[#fbfdfc] py-2 pl-3 pr-9 text-xs font-bold text-[#315a61] outline-none transition hover:border-[#8fbcb1] focus:ring-2 focus:ring-[#2b8d79]"><option>Last 12 months</option><option>Last 90 days</option><option>Year to date</option></select><ChevronDown size={14} className="pointer-events-none absolute right-3 top-2.5 text-[#668084]" /></div><button onClick={() => action("Filters panel opened")} className="rounded-lg border border-[#ccdcd9] bg-[#fbfdfc] p-2 text-[#668084] hover:border-[#8fbcb1] hover:bg-[#edf6f3] focus:outline-none focus:ring-2 focus:ring-[#2b8d79]" aria-label="Filter dashboard"><Filter size={16} /></button></div></div>
            {notice && <div className="mb-5 flex items-center justify-between rounded-lg border border-[#b8dcd1] bg-[#e5f4ef] px-3 py-2 text-xs font-semibold text-[#286b5c]"><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={14} /></button></div>}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Monthly recurring revenue" value="$2.48M" change="+12.4%" note="vs. previous period" /><Metric label="Active customers" value="12,842" change="+8.7%" note="net +1,028 this quarter" /><Metric label="Net revenue retention" value="114%" change="+3.2%" note="rolling 90-day average" /><Metric label="Accounts at risk" value="7" note="2 high-value accounts" alert /></div>

            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,0.8fr)]">
              <div className="rounded-xl border border-[#dce6e8] bg-[#fbfdfc] p-5"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><h2 className="text-sm font-bold">Performance pulse</h2><span className="rounded bg-[#e9f2f0] px-1.5 py-1 text-[9px] font-bold uppercase tracking-wider text-[#638184]">MRR</span></div><p className="mt-1 text-xs text-[#819196]">Recurring revenue movement over time</p></div><button onClick={() => action("Chart detail opened")} className="rounded p-1 text-[#839396] hover:bg-[#e6f0ee] focus:outline-none focus:ring-2 focus:ring-[#2b8d79]"><MoreHorizontal size={18} /></button></div><div className="mt-5 flex h-[174px] items-end gap-2 border-b border-l border-[#dce6e8] px-3 pb-0 pt-3">{trend.map((height, i) => <div key={months[i]} className="group relative flex h-full flex-1 items-end"><div className={`w-full rounded-t-[3px] transition-all duration-300 group-hover:bg-[#d26742] ${i === trend.length - 1 ? "bg-[#1e8a76]" : "bg-[#a7d6c9]"}`} style={{ height: `${height}%` }} /><span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[9px] text-[#90a0a2]">{months[i]}</span></div>)}</div><div className="mt-8 flex items-center justify-between text-[11px] text-[#819196]"><span><strong className="font-mono text-[#315a61]">$2.48M</strong> current MRR</span><span className="flex items-center gap-1 font-semibold text-[#288168]"><ArrowUpRight size={13} /> 12.4% growth</span></div></div>
              <div className="rounded-xl border border-[#e7c8b6] bg-[#fffaf6] p-5"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><ShieldAlert size={16} className="text-[#c15d35]" /><h2 className="text-sm font-bold">Needs attention</h2></div><p className="mt-1 text-xs text-[#897c76]">Priorities surfaced from your signals</p></div><span className="rounded-full bg-[#f6ddd2] px-2 py-1 text-[10px] font-bold text-[#ae4c2d]">3 open</span></div><div className="mt-4 space-y-2">{[["Expansion stalled", "Paperplane · $71.4k", "Review"], ["Usage drop detected", "Noviant Labs · 18% WoW", "Open"], ["Renewal in 14 days", "Fable Studio · $36.2k", "Prepare"]].map(([title, detail, cta]) => <div key={title} className="flex items-center justify-between gap-2 border-t border-[#f0dcd2] py-3 first:border-t-0"><div className="min-w-0"><p className="truncate text-xs font-bold">{title}</p><p className="mt-0.5 truncate text-[10px] text-[#967f76]">{detail}</p></div><button onClick={() => action(`${title} marked for follow-up`)} className="shrink-0 rounded-md border border-[#e6c7b8] bg-[#fffdfb] px-2 py-1.5 text-[10px] font-bold text-[#a45539] hover:bg-[#f8e6de] focus:outline-none focus:ring-2 focus:ring-[#c15d35]">{cta}</button></div>)}</div><button onClick={() => action("All signals opened")} className="mt-2 flex items-center gap-1 text-[11px] font-bold text-[#a45539] hover:text-[#783d2c]">View all signals <ArrowUpRight size={13} /></button></div>
            </div>

            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.8fr)]">
              <div className="overflow-hidden rounded-xl border border-[#dce6e8] bg-[#fbfdfc]"><div className="flex items-center justify-between border-b border-[#e1eaea] px-5 py-4"><div><h2 className="text-sm font-bold">Customer watchlist</h2><p className="mt-1 text-xs text-[#819196]">Accounts that shape this month’s number</p></div><button onClick={() => { setShowAll(!showAll); action(showAll ? "Showing priority accounts" : "Showing all accounts"); }} className="text-[11px] font-bold text-[#28786a] hover:text-[#1c574f] focus:outline-none focus:ring-2 focus:ring-[#2b8d79]">{showAll ? "Show priority" : "View all accounts"} <ArrowUpRight size={12} className="inline" /></button></div><div className="overflow-x-auto"><table className="w-full min-w-[590px] text-left"><thead className="bg-[#f3f8f6] text-[10px] uppercase tracking-[0.1em] text-[#809194]"><tr><th className="px-5 py-2.5 font-bold">Account</th><th className="py-2.5 font-bold">Owner</th><th className="py-2.5 font-bold">Plan</th><th className="py-2.5 font-bold">Health</th><th className="py-2.5 pr-5 text-right font-bold">Value</th></tr></thead><tbody>{visibleAccounts.map((account) => <tr key={account.name} onClick={() => action(`${account.name} account selected`)} className="cursor-pointer border-t border-[#e7eeee] transition hover:bg-[#f0f7f5] focus-within:bg-[#f0f7f5]"><td className="px-5 py-3"><div className="flex items-center gap-2.5"><div className="grid h-7 w-7 place-items-center rounded-md bg-[#dcebe7] text-[9px] font-bold text-[#3c746c]">{account.initials}</div><span className="text-xs font-bold">{account.name}</span></div></td><td className="py-3 text-xs text-[#718487]">{account.owner}</td><td className="py-3 text-xs text-[#718487]">{account.plan}</td><td className="py-3"><HealthPill health={account.health} /></td><td className="py-3 pr-5 text-right font-mono text-xs font-bold text-[#315a61]">{account.value}</td></tr>)}</tbody></table></div></div>
              <div className="rounded-xl border border-[#dce6e8] bg-[#fbfdfc] p-5"><div className="flex items-center justify-between"><div><h2 className="text-sm font-bold">Acquisition mix</h2><p className="mt-1 text-xs text-[#819196]">New ARR by channel</p></div><Target size={17} className="text-[#6a928b]" /></div><div className="mt-5 space-y-4">{[["Product-led", "42%", "#2b8d79"], ["Sales-led", "31%", "#d26742"], ["Partner", "17%", "#6e8bc0"], ["Other", "10%", "#b9c9c5"]].map(([label, percent, color]) => <div key={label}><div className="mb-1.5 flex justify-between text-xs"><span className="font-semibold text-[#536e73]">{label}</span><span className="font-mono font-bold text-[#315a61]">{percent}</span></div><div className="h-2 overflow-hidden rounded-full bg-[#e6efed]"><div className="h-full rounded-full transition-all duration-500" style={{ width: percent, background: color }} /></div></div>)}</div><div className="mt-5 flex items-center gap-2 border-t border-[#e4eceb] pt-4 text-[11px] text-[#819196]"><Users size={14} className="text-[#6a928b]" /> 286 new customers this period</div></div>
            </div>
            <div className="mt-5 flex items-center justify-between rounded-xl border border-[#dce6e8] bg-[#edf5f2] px-4 py-3 text-xs"><div className="flex items-center gap-2 text-[#4e6c70]"><Sparkles size={15} className="text-[#c46a49]" /><span><strong className="text-[#294f57]">Northstar signal:</strong> expansion revenue is outpacing new logo revenue for the third consecutive month.</span></div><button onClick={() => action("Signal saved to workspace")} className="shrink-0 rounded-md px-2 py-1 font-bold text-[#28786a] hover:bg-[#dcece7] focus:outline-none focus:ring-2 focus:ring-[#2b8d79]">Save signal</button></div>
          </div>
        </section>
      </div>
    </main>
  );
}