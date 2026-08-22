import { useState, type ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  Command,
  Filter,
  LayoutDashboard,
  MoreHorizontal,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  Users,
  WalletCards,
  X,
} from "lucide-react";

type Range = "12 months" | "6 months" | "30 days";

const trend = [48, 52, 55, 53, 61, 66, 70, 68, 76, 82, 88, 94];
const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];
const accounts = [
  ["Latticeworks", "Maya Chen", "Enterprise", "healthy", "$184,200"],
  ["Arc & Line", "Jon Bell", "Growth", "watch", "$72,800"],
  ["Veridian Labs", "Priya Shah", "Enterprise", "healthy", "$151,400"],
  ["Northwind Studio", "Theo Grant", "Growth", "risk", "$48,600"],
] as const;

function IconButton({ label, children, onClick }: { label: string; children: ReactNode; onClick?: () => void }) {
  return <button aria-label={label} onClick={onClick} className="grid h-9 w-9 place-items-center border border-indigo-200/15 bg-indigo-950/50 text-indigo-100/65 transition hover:border-violet-300/60 hover:bg-violet-400/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">{children}</button>;
}

function Metric({ icon, label, value, change, detail, tone = "positive" }: { icon: ReactNode; label: string; value: string; change: string; detail: string; tone?: "positive" | "attention" }) {
  return <div className="group relative overflow-hidden border border-indigo-200/15 bg-[#171a44] p-4 shadow-[0_12px_30px_rgba(5,6,34,.22)] transition hover:-translate-y-0.5 hover:border-violet-300/40">
    <div className="absolute right-0 top-0 h-20 w-20 bg-violet-400/5 blur-2xl transition group-hover:bg-violet-300/15" />
    <div className="relative flex items-center justify-between">
      <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.16em] text-indigo-100/55">{icon}{label}</span>
      <span className={`px-2 py-1 text-[10px] font-bold tracking-wide ${tone === "attention" ? "bg-amber-300/15 text-amber-200" : "bg-violet-300/15 text-violet-200"}`}>{change}</span>
    </div>
    <p className="relative mt-4 font-mono text-[27px] font-semibold tracking-[-.06em] text-white">{value}</p>
    <p className="relative mt-1 text-[11px] text-indigo-100/45">{detail}</p>
  </div>;
}

function HealthPill({ children, tone }: { children: ReactNode; tone: "good" | "watch" | "risk" }) {
  const colors = { good: "bg-violet-300/15 text-violet-200", watch: "bg-amber-300/15 text-amber-200", risk: "bg-rose-300/15 text-rose-200" };
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${colors[tone]}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>;
}

function TrendChart({ range }: { range: Range }) {
  const values = range === "30 days" ? trend.slice(5) : range === "6 months" ? trend.slice(6) : trend;
  const labels = range === "30 days" ? ["Apr 01", "Apr 06", "Apr 11", "Apr 16", "Apr 21", "Apr 26", "Apr 30"] : range === "6 months" ? months.slice(6) : months;
  const max = Math.max(...values);
  return <div className="relative mt-5 h-[192px]">
    <div className="absolute inset-0 flex flex-col justify-between text-[10px] text-indigo-100/30">
      {[100, 75, 50, 25, 0].map((n) => <div key={n} className="flex items-center gap-3"><span className="w-7 text-right font-mono">{n === 0 ? "$0" : `$${n * 3}k`}</span><div className="h-px flex-1 bg-indigo-100/10" /></div>)}
    </div>
    <div className="absolute bottom-0 left-11 right-0 top-1 flex items-end gap-[clamp(5px,1.2vw,16px)]">
      {values.map((v, i) => <div key={`${labels[i]}-${v}`} className="group relative flex h-full flex-1 items-end">
        <div className="w-full bg-gradient-to-t from-violet-500 to-fuchsia-300/80 transition group-hover:from-violet-300 group-hover:to-white" style={{ height: `${(v / max) * 88 + 8}%` }} />
        <span className="absolute -top-6 left-1/2 hidden -translate-x-1/2 bg-[#0d1031] px-1.5 py-1 text-[10px] text-white shadow-lg group-hover:block">${Math.round(v * 3.1)}k</span>
      </div>)}
    </div>
    <div className="absolute bottom-[-23px] left-11 right-0 flex justify-between text-[10px] text-indigo-100/35">{labels.map((label) => <span key={label}>{label}</span>)}</div>
  </div>;
}

export function OperationsUltravioletGrid() {
  const [range, setRange] = useState<Range>("12 months");
  const [active, setActive] = useState("Overview");
  const [showNotice, setShowNotice] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [toast, setToast] = useState("");
  const nav = ["Overview", "Revenue", "Customers", "Signals"];
  const announce = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2200); };
  const cycleRange = () => setRange(range === "12 months" ? "6 months" : range === "6 months" ? "30 days" : "12 months");

  return <main className="min-h-[100dvh] bg-[#0d1031] font-sans text-indigo-50 selection:bg-violet-300 selection:text-[#101238]">
    <div className="flex min-h-[100dvh]">
      <aside className="hidden w-[224px] shrink-0 border-r border-indigo-200/10 bg-[#10133b] px-4 py-5 md:flex md:flex-col">
        <button onClick={() => announce("Workspace switcher opened")} className="mb-9 flex items-center gap-2.5 px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
          <span className="grid h-8 w-8 place-items-center bg-violet-400 text-[#17143c]"><Sparkles size={15} /></span>
          <span><strong className="block text-sm tracking-[-.02em] text-white">northstar</strong><span className="text-[10px] uppercase tracking-[.16em] text-indigo-100/40">workspace</span></span><ChevronDown size={14} className="ml-auto text-indigo-100/40" />
        </button>
        <p className="mb-2 px-2 text-[10px] font-bold uppercase tracking-[.16em] text-indigo-100/35">Workspace</p>
        <nav className="space-y-1">
          {nav.map((item) => <button key={item} onClick={() => { setActive(item); announce(`${item} view selected`); }} className={`flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${active === item ? "border-violet-300 bg-violet-300/10 font-semibold text-white" : "border-transparent text-indigo-100/55 hover:bg-indigo-100/5 hover:text-indigo-50"}`}>
            {item === "Overview" ? <LayoutDashboard size={16} /> : item === "Revenue" ? <WalletCards size={16} /> : item === "Customers" ? <Users size={16} /> : <ShieldAlert size={16} />}{item}{item === "Signals" && <span className="ml-auto bg-rose-300/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-200">7</span>}
          </button>)}
        </nav>
        <p className="mb-2 mt-8 px-2 text-[10px] font-bold uppercase tracking-[.16em] text-indigo-100/35">Manage</p>
        <button onClick={() => announce("Settings opened")} className="flex items-center gap-3 px-3 py-2.5 text-sm text-indigo-100/55 transition hover:bg-indigo-100/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"><Settings2 size={16} />Settings</button>
        <div className="mt-auto border border-indigo-200/15 bg-indigo-200/5 p-3"><div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-[.12em] text-indigo-100/40">Data status</span><span className="h-2 w-2 rounded-full bg-violet-300" /></div><p className="mt-2 text-xs font-medium text-indigo-50">All systems reporting</p><p className="mt-1 text-[10px] text-indigo-100/35">Updated 4 min ago</p></div>
      </aside>
      <section className="min-w-0 flex-1">
        <header className="flex h-[68px] items-center justify-between border-b border-indigo-200/10 bg-[#11143c]/90 px-5 md:px-8">
          <div className="flex items-center gap-3"><span className="text-xs text-indigo-100/35">Operations</span><span className="text-indigo-100/20">/</span><strong className="text-sm text-indigo-50">{active}</strong></div>
          <div className="flex items-center gap-2">
            {searchOpen && <input autoFocus type="search" placeholder="Search workspace" className="h-9 w-40 border border-violet-300/30 bg-[#171a44] px-3 text-xs text-white outline-none placeholder:text-indigo-100/30 focus:ring-2 focus:ring-violet-300" onKeyDown={(e) => e.key === "Enter" && announce("Search submitted")} />}
            <IconButton label="Search" onClick={() => setSearchOpen(!searchOpen)}><Search size={16} /></IconButton><IconButton label="Notifications" onClick={() => announce("No new notifications")}><Bell size={16} /></IconButton>
            <button onClick={() => announce("Account menu opened")} className="ml-1 flex items-center gap-2 px-2 py-1.5 transition hover:bg-indigo-100/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"><span className="grid h-8 w-8 place-items-center rounded-full bg-violet-300 text-xs font-bold text-[#17143c]">MC</span><span className="hidden text-left md:block"><b className="block text-xs text-white">Maya Chen</b><small className="text-[10px] text-indigo-100/40">Admin</small></span><ChevronDown size={13} className="text-indigo-100/40" /></button>
          </div>
        </header>
        <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-violet-300"><Activity size={14} />Business pulse <span className="h-1 w-1 rounded-full bg-violet-300/50" /> Apr 30, 2024</div><h1 className="text-[32px] font-semibold leading-none tracking-[-.055em] text-white md:text-[40px]">Good morning, Maya.</h1><p className="mt-2 text-sm text-indigo-100/50">Here’s what changed while you were away.</p></div><div className="relative flex items-center gap-2"><button onClick={cycleRange} className="flex h-9 items-center gap-2 border border-indigo-200/20 bg-[#171a44] px-3 text-xs font-semibold text-indigo-50 transition hover:border-violet-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"><span className="text-indigo-100/40">Range</span>{range}<ChevronDown size={14} /></button><IconButton label="Filter dashboard" onClick={() => setFilterOpen(!filterOpen)}><Filter size={15} /></IconButton>{filterOpen && <div className="absolute right-0 top-11 z-10 w-44 border border-indigo-200/20 bg-[#171a44] p-2 text-xs shadow-xl"><p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-indigo-100/35">View filter</p>{["All segments", "Enterprise", "Growth"].map((x) => <button key={x} onClick={() => { setFilterOpen(false); announce(`${x} filter applied`); }} className="flex w-full items-center justify-between px-2 py-2 text-left text-indigo-50/70 hover:bg-violet-300/10 hover:text-white">{x}{x === "All segments" && <Check size={13} className="text-violet-300" />}</button>)}</div>}</div></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric icon={<WalletCards size={14} />} label="MRR" value="$2.48M" change="+12.4%" detail="vs. $2.21M last month" /><Metric icon={<Users size={14} />} label="Active customers" value="12,842" change="+8.7%" detail="1,034 net new this quarter" /><Metric icon={<Activity size={14} />} label="Net revenue retention" value="114%" change="+3.2%" detail="Expansion continues to lead" /><Metric icon={<ShieldAlert size={14} />} label="Accounts at risk" value="7" change="Needs review" detail="$186k in contracted value" tone="attention" /></div>
          {showNotice && <div className="mt-5 flex items-center gap-3 border border-amber-200/25 bg-amber-200/10 px-4 py-3 text-sm text-amber-100"><ShieldAlert size={17} className="shrink-0 text-amber-200" /><span><b>7 accounts need attention.</b> Two renewal conversations are due this week.</span><button onClick={() => { setActive("Signals"); announce("Signals queue opened"); }} className="ml-auto whitespace-nowrap text-xs font-bold underline underline-offset-4 hover:text-white">Review signals</button><button aria-label="Dismiss alert" onClick={() => setShowNotice(false)} className="ml-1 rounded p-1 hover:bg-amber-100/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200"><X size={15} /></button></div>}
          <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]"><section className="border border-indigo-200/15 bg-[#171a44] p-5 shadow-[0_12px_30px_rgba(5,6,34,.18)]"><div className="flex items-start justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-indigo-100/45">Performance trend</p><div className="mt-1 flex items-end gap-3"><h2 className="font-mono text-2xl font-semibold tracking-[-.05em] text-white">$248.6k</h2><span className="mb-1 flex items-center gap-1 text-xs font-semibold text-violet-200"><ArrowUpRight size={14} />12.4%</span></div></div><button onClick={() => announce("Chart menu opened")} aria-label="More chart options" className="p-1.5 text-indigo-100/40 hover:bg-violet-300/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"><MoreHorizontal size={17} /></button></div><TrendChart range={range} /></section><section className="border border-indigo-200/15 bg-[#171a44] p-5 shadow-[0_12px_30px_rgba(5,6,34,.18)]"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-indigo-100/45">Acquisition mix</p><h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-white">1,034 new customers</h2></div><button onClick={() => announce("Acquisition details opened")} className="text-xs font-semibold text-violet-200 hover:text-white">Details <ArrowUpRight size={13} className="inline" /></button></div><div className="mt-6 space-y-4">{[["Product-led", "42%", "434", "bg-violet-300"], ["Partners", "28%", "289", "bg-fuchsia-300"], ["Outbound", "19%", "196", "bg-indigo-300"], ["Other", "11%", "115", "bg-indigo-100/40"]].map(([name, pct, count, color]) => <div key={name}><div className="mb-1.5 flex justify-between text-xs"><span className="font-medium text-indigo-100/65">{name}</span><span className="font-mono text-indigo-100/45">{count} <b className="ml-2 text-indigo-50">{pct}</b></span></div><div className="h-2 overflow-hidden bg-indigo-100/10"><div className={`h-full ${color}`} style={{ width: pct }} /></div></div>)}</div></section></div>
          <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_1.45fr]"><section className="border border-indigo-200/15 bg-[#171a44] p-5"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-indigo-100/45">Priority signals</p><h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-white">Worth a closer look</h2></div><span className="bg-rose-300/15 px-2 py-1 text-[10px] font-bold text-rose-200">3 open</span></div>{[["Renewal concentration", "2 enterprise renewals due in 14 days", "High", "risk"], ["Expansion velocity", "Upsell pipeline grew $38k this week", "Positive", "good"], ["Support load", "Median first response up 18 minutes", "Watch", "watch"]].map(([title, body, level, tone]) => <button key={title} onClick={() => announce(`${title} signal opened`)} className="group flex w-full items-start gap-3 border-t border-indigo-100/10 py-3 text-left first:border-0 hover:bg-violet-300/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300"><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone === "risk" ? "bg-rose-300" : tone === "watch" ? "bg-amber-300" : "bg-violet-300"}`} /><span className="min-w-0 flex-1"><b className="block text-xs text-indigo-50">{title}</b><span className="mt-1 block text-[11px] leading-4 text-indigo-100/45">{body}</span></span><span className={`text-[10px] font-bold ${tone === "risk" ? "text-rose-200" : tone === "watch" ? "text-amber-200" : "text-violet-200"}`}>{level}</span></button>)}</section>
          <section className="border border-indigo-200/15 bg-[#171a44] p-5"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-indigo-100/45">Customer watchlist</p><h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-white">Accounts by health</h2></div><button onClick={() => announce("Customer list opened")} className="text-xs font-semibold text-violet-200 hover:text-white">View all <ArrowUpRight size={13} className="inline" /></button></div><div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs"><thead className="border-b border-indigo-100/10 text-[10px] uppercase tracking-[.11em] text-indigo-100/35"><tr><th className="pb-2 font-semibold">Account</th><th className="pb-2 font-semibold">Owner</th><th className="pb-2 font-semibold">Plan</th><th className="pb-2 font-semibold">Health</th><th className="pb-2 text-right font-semibold">Value</th></tr></thead><tbody>{accounts.map(([account, owner, plan, health, value]) => <tr key={account} className="group border-b border-indigo-100/10 last:border-0 hover:bg-violet-300/5"><td className="py-3 font-semibold text-indigo-50">{account}</td><td className="py-3 text-indigo-100/50">{owner}</td><td className="py-3 text-indigo-100/50">{plan}</td><td className="py-3"><HealthPill tone={health === "healthy" ? "good" : health === "watch" ? "watch" : "risk"}>{health === "healthy" ? "Healthy" : health === "watch" ? "Watch" : "At risk"}</HealthPill></td><td className="py-3 text-right font-mono text-indigo-100/65">{value}</td></tr>)}</tbody></table></div></section></div>
          <section className="mt-5 border border-indigo-200/15 bg-[#171a44] p-5"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-indigo-100/45">Recent activity</p><h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-white">Team movement</h2></div><button onClick={() => announce("Activity feed opened")} className="border border-indigo-200/20 px-3 py-2 text-xs font-semibold text-indigo-100/65 hover:bg-violet-300/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">Full activity</button></div><div className="mt-4 grid gap-3 md:grid-cols-3">{[["PS", "Priya Shah", "moved Veridian Labs to renewal review", "12 min ago", "bg-indigo-300/20 text-indigo-100"], ["TG", "Theo Grant", "logged a risk note on Northwind Studio", "46 min ago", "bg-rose-300/20 text-rose-100"], ["JB", "Jon Bell", "closed a $24,800 expansion with Arc & Line", "2 hr ago", "bg-violet-300/20 text-violet-100"]].map(([initials, name, action, time, color]) => <button key={name} onClick={() => announce(`${name}'s activity opened`)} className="flex items-center gap-3 border border-indigo-100/10 p-3 text-left transition hover:border-violet-300/35 hover:bg-violet-300/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[10px] font-bold ${color}`}>{initials}</span><span className="min-w-0"><b className="block truncate text-xs text-indigo-50">{name} <span className="font-normal text-indigo-100/45">{action}</span></b><span className="mt-1 block text-[10px] text-indigo-100/30">{time}</span></span></button>)}</div></section>
        </div>
      </section>
    </div>
    {toast && <div role="status" className="fixed bottom-5 right-5 z-20 flex items-center gap-2 border border-violet-300/30 bg-[#171a44] px-4 py-3 text-xs font-medium text-violet-100 shadow-xl"><Command size={14} className="text-violet-300" />{toast}</div>}
  </main>;
}