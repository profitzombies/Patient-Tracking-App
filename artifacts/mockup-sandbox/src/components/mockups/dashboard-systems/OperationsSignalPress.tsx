import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Bell,
  ChevronDown,
  CircleDot,
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
type Tone = "healthy" | "watch" | "risk";

const trend = [48, 52, 55, 53, 61, 66, 70, 68, 76, 82, 88, 94];
const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];

function ActionButton({ label, children, onClick }: { label: string; children: ReactNode; onClick?: () => void }) {
  return (
    <button aria-label={label} onClick={onClick} className="inline-flex h-9 w-9 items-center justify-center border border-[#cfc8bd] bg-[#fbf8f2] text-[#51565c] transition-colors hover:border-[#b93629] hover:text-[#a42f25] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c74635] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f2eee6]">
      {children}
    </button>
  );
}

function Metric({ icon, label, value, change, detail, negative }: { icon: ReactNode; label: string; value: string; change: string; detail: string; negative?: boolean }) {
  return (
    <div className="group border-t-[3px] border-[#252c33] bg-[#fbf8f2] p-4 transition-transform hover:-translate-y-0.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.16em] text-[#73777a]">{icon}{label}</span>
        <span className={`font-mono text-[10px] font-bold ${negative ? "text-[#b43d30]" : "text-[#315f78]"}`}>{negative ? "!" : "↗"} {change}</span>
      </div>
      <p className="mt-3 font-mono text-[28px] font-bold tracking-[-.07em] text-[#20262b]">{value}</p>
      <p className="mt-1 text-[11px] text-[#85847e]">{detail}</p>
    </div>
  );
}

function HealthPill({ children, tone }: { children: ReactNode; tone: Tone }) {
  const colors = {
    healthy: "border-[#9db1bb] bg-[#e5edf0] text-[#315f78]",
    watch: "border-[#d7b47d] bg-[#f7edda] text-[#9a621c]",
    risk: "border-[#d8978e] bg-[#f8e2de] text-[#aa362c]",
  };
  return <span className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] font-bold uppercase tracking-[.08em] ${colors[tone]}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>;
}

function TrendChart({ range }: { range: Range }) {
  const values = range === "30 days" ? [66, 70, 68, 76, 82, 88, 94] : range === "6 months" ? trend.slice(6) : trend;
  const labels = range === "30 days" ? ["Apr 01", "Apr 06", "Apr 11", "Apr 16", "Apr 21", "Apr 26", "Apr 30"] : range === "6 months" ? months.slice(6) : months;
  const max = Math.max(...values);
  return (
    <div className="relative mt-6 h-[195px]">
      <div className="absolute inset-0 flex flex-col justify-between text-[9px] text-[#98958d]">
        {[100, 75, 50, 25, 0].map((n) => <div key={n} className="flex items-center gap-3"><span className="w-8 text-right font-mono">{n === 0 ? "$0" : `$${n * 30}k`}</span><div className="h-px flex-1 bg-[#ded8ce]" /></div>)}
      </div>
      <div className="absolute bottom-0 left-12 right-0 top-2 flex items-end gap-1.5 sm:gap-3">
        {values.map((v, i) => <div key={`${labels[i]}-${v}`} className="group relative flex h-full flex-1 items-end">
          <div className="w-full bg-[#315f78] transition-colors group-hover:bg-[#b93629]" style={{ height: `${(v / max) * 86 + 8}%` }} />
          <span className="absolute -top-7 left-1/2 hidden -translate-x-1/2 bg-[#20262b] px-1.5 py-1 font-mono text-[9px] text-[#fbf8f2] group-hover:block">${Math.round(v * 3.1)}k</span>
        </div>)}
      </div>
      <div className="absolute bottom-[-24px] left-12 right-0 flex justify-between font-mono text-[9px] text-[#898780]">{labels.map((label) => <span key={label}>{label}</span>)}</div>
    </div>
  );
}

export function OperationsSignalPress() {
  const [range, setRange] = useState<Range>("12 months");
  const [active, setActive] = useState("Overview");
  const [showNotice, setShowNotice] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [filter, setFilter] = useState("All segments");
  const nav = ["Overview", "Revenue", "Customers", "Signals"];
  const accountRows = useMemo(() => [
    ["Latticeworks", "Maya Chen", "Enterprise", "healthy", "$184,200"],
    ["Arc & Line", "Jon Bell", "Growth", "watch", "$72,800"],
    ["Veridian Labs", "Priya Shah", "Enterprise", "healthy", "$151,400"],
    ["Northwind Studio", "Theo Grant", "Growth", "risk", "$48,600"],
  ] as const, []);
  const announce = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2200); };

  return (
    <main className="min-h-[100dvh] bg-[#f2eee6] font-sans text-[#252b30]">
      <div className="flex min-h-[100dvh]">
        <aside className="hidden w-[226px] shrink-0 border-r border-[#cfc8bd] bg-[#e8e2d8] px-4 py-5 md:flex md:flex-col">
          <button className="mb-9 flex items-center gap-2.5 px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c74635]" onClick={() => announce("Workspace switcher opened")}>
            <span className="grid h-8 w-8 place-items-center bg-[#b93629] text-[#fbf8f2]"><Sparkles size={15} /></span>
            <span><strong className="block font-serif text-[16px] tracking-[-.03em] text-[#252b30]">signal press</strong><span className="font-mono text-[9px] uppercase tracking-[.13em] text-[#827f77]">workspace edition</span></span>
            <ChevronDown size={14} className="ml-auto text-[#77756f]" />
          </button>
          <p className="mb-2 border-b border-[#cfc8bd] px-2 pb-2 font-mono text-[9px] font-bold uppercase tracking-[.16em] text-[#918c82]">Desk / Operations</p>
          <nav className="space-y-0.5">
            {nav.map((item) => <button key={item} onClick={() => { setActive(item); announce(`${item} view selected`); }} className={`flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#c74635] ${active === item ? "border-[#b93629] bg-[#f2eee6] font-bold text-[#252b30]" : "border-transparent text-[#6f716f] hover:border-[#d58b80] hover:bg-[#ede7de] hover:text-[#252b30]"}`}>
              {item === "Overview" ? <LayoutDashboard size={16} /> : item === "Revenue" ? <WalletCards size={16} /> : item === "Customers" ? <Users size={16} /> : <ShieldAlert size={16} />}{item}{item === "Signals" && <span className="ml-auto bg-[#b93629] px-1.5 py-0.5 font-mono text-[9px] font-bold text-[#fbf8f2]">07</span>}
            </button>)}
          </nav>
          <p className="mb-2 mt-8 border-b border-[#cfc8bd] px-2 pb-2 font-mono text-[9px] font-bold uppercase tracking-[.16em] text-[#918c82]">Control room</p>
          <button onClick={() => announce("Settings opened")} className="flex items-center gap-3 border-l-2 border-transparent px-3 py-2.5 text-[13px] text-[#6f716f] transition-colors hover:border-[#d58b80] hover:bg-[#ede7de] hover:text-[#252b30] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c74635]"><Settings2 size={16} />Settings</button>
          <div className="mt-auto border-t-2 border-[#252c33] bg-[#f2eee6] p-3">
            <div className="flex items-center justify-between"><span className="font-mono text-[9px] font-bold uppercase tracking-[.13em] text-[#73736d]">Data status</span><CircleDot size={12} className="text-[#315f78]" /></div>
            <p className="mt-2 text-xs font-bold text-[#39434a]">All desks reporting</p><p className="mt-1 font-mono text-[9px] text-[#8c8981]">Updated 04 min ago</p>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex h-[68px] items-center justify-between border-b border-[#cfc8bd] bg-[#f7f3ec] px-5 md:px-8">
            <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[.12em]"><span className="text-[#99958b]">Operations</span><span className="text-[#c1bbb0]">/</span><strong className="text-[#3b454b]">{active}</strong></div>
            <div className="flex items-center gap-2">
              {searchOpen && <input autoFocus placeholder="Search workspace" className="h-9 w-40 border border-[#cfc8bd] bg-[#fbf8f2] px-3 text-xs outline-none focus:ring-2 focus:ring-[#c74635]" onKeyDown={(e) => e.key === "Enter" && announce("Search submitted")} />}
              <ActionButton label="Search" onClick={() => setSearchOpen(!searchOpen)}><Search size={16} /></ActionButton>
              <ActionButton label="Notifications" onClick={() => announce("No new notifications")}><Bell size={16} /></ActionButton>
              <button onClick={() => announce("Account menu opened")} className="ml-1 flex items-center gap-2 px-2 py-1.5 transition-colors hover:bg-[#ebe5dc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c74635]"><span className="grid h-8 w-8 place-items-center bg-[#315f78] font-mono text-[10px] font-bold text-[#f7f3ec]">MC</span><span className="hidden text-left md:block"><b className="block text-xs text-[#39434a]">Maya Chen</b><small className="font-mono text-[9px] uppercase text-[#8c8981]">Admin</small></span><ChevronDown size={13} className="text-[#77756f]" /></button>
            </div>
          </header>

          <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div><div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[.16em] text-[#b93629]"><Activity size={13} />The daily brief <span className="text-[#aaa59a]">•</span> Apr 30, 2024</div><h1 className="font-serif text-[38px] leading-[.95] tracking-[-.055em] text-[#20262b] md:text-[48px]">Good morning, Maya<span className="text-[#b93629]">.</span></h1><p className="mt-2 text-sm text-[#747773]">Here’s what changed while you were away.</p></div>
              <div className="relative flex items-center gap-2">
                <button onClick={() => setRange(range === "12 months" ? "6 months" : range === "6 months" ? "30 days" : "12 months")} className="flex h-9 items-center gap-2 border border-[#cfc8bd] bg-[#fbf8f2] px-3 font-mono text-[10px] font-bold uppercase text-[#4d5559] transition-colors hover:border-[#b93629] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c74635]"><span className="font-normal text-[#9b978e]">Range</span>{range}<ChevronDown size={13} /></button>
                <ActionButton label="Filter dashboard" onClick={() => setFilterOpen(!filterOpen)}><Filter size={15} /></ActionButton>
                {filterOpen && <div className="absolute right-0 top-11 z-10 w-44 border border-[#cfc8bd] bg-[#fbf8f2] p-2 text-xs shadow-[4px_4px_0_#cfc8bd]"><p className="px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-[#99958b]">View filter</p>{["All segments", "Enterprise", "Growth"].map((x) => <button key={x} onClick={() => { setFilter(x); setFilterOpen(false); announce(`${x} filter applied`); }} className={`block w-full px-2 py-2 text-left hover:bg-[#eee8df] ${filter === x ? "font-bold text-[#b93629]" : "text-[#596066]"}`}>{x}</button>)}</div>}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric icon={<WalletCards size={14} />} label="MRR" value="$2.48M" change="+12.4%" detail="vs. $2.21M last month" />
              <Metric icon={<Users size={14} />} label="Active customers" value="12,842" change="+8.7%" detail="1,034 net new this quarter" />
              <Metric icon={<Activity size={14} />} label="Net revenue retention" value="114%" change="+3.2%" detail="Expansion continues to lead" />
              <Metric icon={<ShieldAlert size={14} />} label="Accounts at risk" value="7" change="Needs review" detail="$186k in contracted value" negative />
            </div>

            {showNotice && <div className="mt-5 flex items-center gap-3 border-l-4 border-[#b93629] bg-[#f8e7df] px-4 py-3 text-sm text-[#65433e]"><ShieldAlert size={17} className="shrink-0 text-[#b93629]" /><span><b>7 accounts need attention.</b> Two renewal conversations are due this week.</span><button onClick={() => { setActive("Signals"); announce("Signals queue opened"); }} className="ml-auto whitespace-nowrap font-mono text-[10px] font-bold uppercase underline decoration-[#c74635] underline-offset-4 hover:text-[#a42f25]">Review signals</button><button aria-label="Dismiss alert" onClick={() => setShowNotice(false)} className="ml-1 p-1 hover:bg-[#f0d8d0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c74635]"><X size={15} /></button></div>}

            <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
              <section className="border border-[#cfc8bd] bg-[#fbf8f2] p-5"><div className="flex items-start justify-between"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[#85837c]">Performance trend</p><div className="mt-1 flex items-end gap-3"><h2 className="font-mono text-2xl font-bold tracking-[-.06em] text-[#20262b]">$248.6k</h2><span className="mb-1 flex items-center gap-1 font-mono text-[10px] font-bold text-[#315f78]"><ArrowUpRight size={13} />12.4%</span></div></div><button onClick={() => announce("Chart menu opened")} aria-label="More chart options" className="p-1.5 text-[#85837c] hover:bg-[#eee8df] hover:text-[#b93629] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c74635]"><MoreHorizontal size={17} /></button></div><TrendChart range={range} /></section>
              <section className="border border-[#cfc8bd] bg-[#fbf8f2] p-5"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[#85837c]">Acquisition mix</p><h2 className="mt-1 text-lg font-bold tracking-[-.03em] text-[#39434a]">1,034 new customers</h2></div><button onClick={() => announce("Acquisition details opened")} className="font-mono text-[10px] font-bold uppercase text-[#b93629] hover:text-[#8f271f]">Details <ArrowUpRight size={13} className="inline" /></button></div><div className="mt-6 space-y-4">{[["Product-led", "42%", "434", "bg-[#315f78]"], ["Partners", "28%", "289", "bg-[#63869a]"], ["Outbound", "19%", "196", "bg-[#a7b9c0]"], ["Other", "11%", "115", "bg-[#d4d9d5]"]].map(([name, pct, count, color]) => <div key={name}><div className="mb-1.5 flex justify-between text-xs"><span className="font-medium text-[#596066]">{name}</span><span className="font-mono text-[#85837c]">{count} <b className="ml-2 text-[#39434a]">{pct}</b></span></div><div className="h-2 overflow-hidden bg-[#e8e3da]"><div className={`h-full ${color}`} style={{ width: pct }} /></div></div>)}</div></section>
            </div>

            <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_1.45fr]">
              <section className="border border-[#cfc8bd] bg-[#fbf8f2] p-5"><div className="mb-3 flex items-center justify-between"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[#85837c]">Priority signals</p><h2 className="mt-1 text-lg font-bold tracking-[-.03em] text-[#39434a]">Worth a closer look</h2></div><span className="bg-[#f4dfd7] px-2 py-1 font-mono text-[9px] font-bold uppercase text-[#a42f25]">3 open</span></div>{[["Renewal concentration", "2 enterprise renewals due in 14 days", "High", "risk"], ["Expansion velocity", "Upsell pipeline grew $38k this week", "Positive", "healthy"], ["Support load", "Median first response up 18 minutes", "Watch", "watch"]].map(([title, body, level, tone]) => <button key={title} onClick={() => announce(`${title} signal opened`)} className="group flex w-full items-start gap-3 border-t border-[#e2ddd4] py-3 text-left first:border-0 hover:bg-[#f1ece4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#c74635]"><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone === "risk" ? "bg-[#b93629]" : tone === "watch" ? "bg-[#c18b3d]" : "bg-[#315f78]"}`} /><span className="min-w-0 flex-1"><b className="block text-xs text-[#414a4f]">{title}</b><span className="mt-1 block text-[11px] leading-4 text-[#85837c]">{body}</span></span><span className={`font-mono text-[9px] font-bold uppercase ${tone === "risk" ? "text-[#b93629]" : tone === "watch" ? "text-[#9a621c]" : "text-[#315f78]"}`}>{level}</span></button>)}</section>
              <section className="border border-[#cfc8bd] bg-[#fbf8f2] p-5"><div className="mb-3 flex items-center justify-between"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[#85837c]">Customer watchlist</p><h2 className="mt-1 text-lg font-bold tracking-[-.03em] text-[#39434a]">Accounts by health</h2></div><button onClick={() => announce("Customer list opened")} className="font-mono text-[10px] font-bold uppercase text-[#b93629] hover:text-[#8f271f]">View all <ArrowUpRight size={13} className="inline" /></button></div><div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs"><thead className="border-b border-[#d8d2c8] font-mono text-[9px] uppercase tracking-[.12em] text-[#8c8981]"><tr><th className="pb-2 font-semibold">Account</th><th className="pb-2 font-semibold">Owner</th><th className="pb-2 font-semibold">Plan</th><th className="pb-2 font-semibold">Health</th><th className="pb-2 text-right font-semibold">Value</th></tr></thead><tbody>{accountRows.map(([account, owner, plan, health, value]) => <tr key={account} className="group border-b border-[#ebe6de] last:border-0 hover:bg-[#f1ece4]"><td className="py-3 font-bold text-[#414a4f]">{account}</td><td className="py-3 text-[#85837c]">{owner}</td><td className="py-3 text-[#85837c]">{plan}</td><td className="py-3"><HealthPill tone={health}>{health === "healthy" ? "Healthy" : health === "watch" ? "Watch" : "At risk"}</HealthPill></td><td className="py-3 text-right font-mono text-[#596066]">{value}</td></tr>)}</tbody></table></div></section>
            </div>

            <section className="mt-5 border border-[#cfc8bd] bg-[#fbf8f2] p-5"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[.15em] text-[#85837c]">Recent activity</p><h2 className="mt-1 text-lg font-bold tracking-[-.03em] text-[#39434a]">Team movement</h2></div><button onClick={() => announce("Activity feed opened")} className="border border-[#cfc8bd] px-3 py-2 font-mono text-[10px] font-bold uppercase text-[#596066] hover:border-[#b93629] hover:text-[#b93629] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c74635]">Full activity</button></div><div className="mt-4 grid gap-3 md:grid-cols-3">{[["PS", "Priya Shah", "moved Veridian Labs to renewal review", "12 min ago", "bg-[#dce7eb] text-[#315f78]"], ["TG", "Theo Grant", "logged a risk note on Northwind Studio", "46 min ago", "bg-[#f0dcd7] text-[#a42f25]"], ["JB", "Jon Bell", "closed a $24,800 expansion with Arc & Line", "2 hr ago", "bg-[#e3e1dc] text-[#596066]"]].map(([initials, name, action, time, color]) => <button key={name} onClick={() => announce(`${name}'s activity opened`)} className="flex items-center gap-3 border border-[#e2ddd4] p-3 text-left transition-colors hover:border-[#c74635] hover:bg-[#f1ece4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c74635]"><span className={`grid h-8 w-8 shrink-0 place-items-center font-mono text-[10px] font-bold ${color}`}>{initials}</span><span className="min-w-0"><b className="block truncate text-xs text-[#414a4f]">{name} <span className="font-normal text-[#85837c]">{action}</span></b><span className="mt-1 block font-mono text-[9px] text-[#9a968d]">{time}</span></span></button>)}</div></section>
          </div>
        </section>
      </div>
      {toast && <div role="status" className="fixed bottom-5 right-5 z-20 flex items-center gap-2 bg-[#20262b] px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[.06em] text-[#fbf8f2] shadow-[4px_4px_0_#b93629]"><Command size={14} />{toast}</div>}
    </main>
  );
}