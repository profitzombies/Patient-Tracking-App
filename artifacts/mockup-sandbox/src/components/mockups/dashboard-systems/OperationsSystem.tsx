import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Bell,
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

function IconButton({ label, children, onClick }: { label: string; children: ReactNode; onClick?: () => void }) {
  return (
    <button aria-label={label} onClick={onClick} className="group inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#d8ddd9] bg-[#fbfcfa] text-[#65716c] transition hover:border-[#94aa9e] hover:bg-[#edf4ef] hover:text-[#173a2d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6aa58b]">
      {children}
    </button>
  );
}

function Metric({ icon, label, value, change, detail, tone = "green" }: { icon: React.ReactNode; label: string; value: string; change: string; detail: string; tone?: "green" | "amber" }) {
  return (
    <div className="min-w-0 rounded-xl border border-[#d8ddd9] bg-[#fbfcfa] p-4 shadow-[0_1px_2px_rgba(27,54,42,.04)] transition hover:-translate-y-0.5 hover:border-[#a6bdb0] hover:shadow-[0_8px_18px_rgba(27,54,42,.07)]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.1em] text-[#738079]">{icon}{label}</span>
        <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${tone === "amber" ? "bg-[#fbf0d8] text-[#9c6819]" : "bg-[#e2f3e9] text-[#26704a]"}`}>{change}</span>
      </div>
      <p className="mt-3 font-mono text-[27px] font-semibold tracking-[-.06em] text-[#18362b]">{value}</p>
      <p className="mt-1 text-xs text-[#87918c]">{detail}</p>
    </div>
  );
}

function HealthPill({ children, tone }: { children: ReactNode; tone: "good" | "watch" | "risk" }) {
  const colors = { good: "bg-[#e4f2e8] text-[#28704b]", watch: "bg-[#fbf0da] text-[#9a681b]", risk: "bg-[#f8e4e0] text-[#aa4d42]" };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${colors[tone]}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>;
}

function TrendChart({ range }: { range: Range }) {
  const values = range === "30 days" ? [66, 70, 68, 76, 82, 88, 94] : range === "6 months" ? trend.slice(6) : trend;
  const labels = range === "30 days" ? ["Apr 01", "Apr 06", "Apr 11", "Apr 16", "Apr 21", "Apr 26", "Apr 30"] : range === "6 months" ? months.slice(6) : months;
  const max = Math.max(...values);
  return (
    <div className="relative mt-5 h-[190px]">
      <div className="absolute inset-0 flex flex-col justify-between text-[10px] text-[#a0aaa5]">
        {[100, 75, 50, 25, 0].map((n) => <div key={n} className="flex items-center gap-3"><span className="w-7 text-right font-mono">{n === 0 ? "$0" : `$${(n * 30).toFixed(0)}k`}</span><div className="h-px flex-1 bg-[#e6ebe7]" /></div>)}
      </div>
      <div className="absolute bottom-0 left-11 right-0 top-1 flex items-end gap-[clamp(5px,1.2vw,16px)]">
        {values.map((v, i) => <div key={`${labels[i]}-${v}`} className="group relative flex h-full flex-1 items-end">
          <div className="w-full rounded-t-[5px] bg-[#cfe7d8] transition group-hover:bg-[#6da989]" style={{ height: `${(v / max) * 88 + 8}%` }} />
          <span className="absolute -top-6 left-1/2 hidden -translate-x-1/2 rounded bg-[#173a2d] px-1.5 py-1 text-[10px] text-[#f2f7f3] group-hover:block">${Math.round(v * 3.1)}k</span>
        </div>)}
      </div>
      <div className="absolute bottom-[-23px] left-11 right-0 flex justify-between text-[10px] text-[#8f9a94]">
        {labels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}

export function OperationsSystem() {
  const [range, setRange] = useState<Range>("12 months");
  const [active, setActive] = useState("Overview");
  const [showNotice, setShowNotice] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [toast, setToast] = useState("");
  const nav = ["Overview", "Revenue", "Customers", "Signals"];
  const accountRows = useMemo(() => [
    ["Latticeworks", "Maya Chen", "Enterprise", "healthy", "$184,200"],
    ["Arc & Line", "Jon Bell", "Growth", "watch", "$72,800"],
    ["Veridian Labs", "Priya Shah", "Enterprise", "healthy", "$151,400"],
    ["Northwind Studio", "Theo Grant", "Growth", "risk", "$48,600"],
  ] as const, []);

  const announce = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2200); };

  return (
    <main className="min-h-[100dvh] bg-[#f3f6f2] font-sans text-[#1d3028]">
      <div className="flex min-h-[100dvh]">
        <aside className="hidden w-[220px] shrink-0 border-r border-[#d9e0da] bg-[#e8efe9] px-4 py-5 md:flex md:flex-col">
          <button className="mb-8 flex items-center gap-2.5 px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6aa58b]" onClick={() => announce("Workspace switcher opened")}>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#173a2d] text-[#d9f1df]"><Sparkles size={15} /></span>
            <span><strong className="block text-sm tracking-[-.02em] text-[#173a2d]">northstar</strong><span className="text-[10px] uppercase tracking-[.1em] text-[#829087]">workspace</span></span>
            <ChevronDown size={14} className="ml-auto text-[#829087]" />
          </button>
          <p className="mb-2 px-2 text-[10px] font-bold uppercase tracking-[.14em] text-[#8a968e]">Workspace</p>
          <nav className="space-y-1">
            {nav.map((item) => <button key={item} onClick={() => { setActive(item); announce(`${item} view selected`); }} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6aa58b] ${active === item ? "bg-[#d2e6d8] font-semibold text-[#173a2d]" : "text-[#63726a] hover:bg-[#dde9df] hover:text-[#234b39]"}`}>
              {item === "Overview" ? <LayoutDashboard size={16} /> : item === "Revenue" ? <WalletCards size={16} /> : item === "Customers" ? <Users size={16} /> : <ShieldAlert size={16} />}{item}{item === "Signals" && <span className="ml-auto rounded bg-[#f4d6b7] px-1.5 py-0.5 text-[10px] font-bold text-[#8c5529]">7</span>}
            </button>)}
          </nav>
          <p className="mb-2 mt-8 px-2 text-[10px] font-bold uppercase tracking-[.14em] text-[#8a968e]">Manage</p>
          <button onClick={() => announce("Settings opened")} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-[#63726a] transition hover:bg-[#dde9df] hover:text-[#234b39] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6aa58b]"><Settings2 size={16} />Settings</button>
          <div className="mt-auto rounded-xl border border-[#cfdbd1] bg-[#dce9df] p-3">
            <div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-[.12em] text-[#6d7d72]">Data status</span><span className="h-2 w-2 rounded-full bg-[#4caa73]" /></div>
            <p className="mt-2 text-xs font-medium text-[#345443]">All systems reporting</p><p className="mt-1 text-[10px] text-[#789082]">Updated 4 min ago</p>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex h-[68px] items-center justify-between border-b border-[#d9e0da] bg-[#f7f9f6] px-5 md:px-8">
            <div className="flex items-center gap-3"><span className="text-xs text-[#91a099]">Operations</span><span className="text-[#c0c9c2]">/</span><strong className="text-sm text-[#294538]">{active}</strong></div>
            <div className="flex items-center gap-2">
              {searchOpen && <input autoFocus placeholder="Search workspace" className="h-9 w-40 rounded-lg border border-[#c9d7cc] bg-[#fbfcfa] px-3 text-xs outline-none focus:ring-2 focus:ring-[#a9cdb5]" onKeyDown={(e) => e.key === "Enter" && announce("Search submitted")} />}
              <IconButton label="Search" onClick={() => setSearchOpen(!searchOpen)}><Search size={16} /></IconButton>
              <IconButton label="Notifications" onClick={() => announce("No new notifications")}><Bell size={16} /></IconButton>
              <button onClick={() => announce("Account menu opened")} className="ml-1 flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-[#e8f0e9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6aa58b]"><span className="grid h-8 w-8 place-items-center rounded-full bg-[#e6c9a6] text-xs font-bold text-[#5e4228]">MC</span><span className="hidden text-left md:block"><b className="block text-xs text-[#294538]">Maya Chen</b><small className="text-[10px] text-[#8c9990]">Admin</small></span><ChevronDown size={13} className="text-[#7f8c83]" /></button>
            </div>
          </header>

          <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div><div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.14em] text-[#729080]"><Activity size={14} />Business pulse <span className="h-1 w-1 rounded-full bg-[#aabbb0]" /> Apr 30, 2024</div><h1 className="font-serif text-[32px] leading-none tracking-[-.04em] text-[#173a2d] md:text-[38px]">Good morning, Maya.</h1><p className="mt-2 text-sm text-[#77857d]">Here’s what changed while you were away.</p></div>
              <div className="relative flex items-center gap-2">
                <div className="relative"><button onClick={() => setRange(range === "12 months" ? "6 months" : range === "6 months" ? "30 days" : "12 months")} className="flex h-9 items-center gap-2 rounded-lg border border-[#cbd8ce] bg-[#fbfcfa] px-3 text-xs font-semibold text-[#365544] shadow-sm transition hover:border-[#7ca790] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6aa58b]"><span className="text-[#94a198]">Range</span>{range}<ChevronDown size={14} /></button></div>
                <IconButton label="Filter dashboard" onClick={() => setFilterOpen(!filterOpen)}><Filter size={15} /></IconButton>
                {filterOpen && <div className="absolute right-0 top-11 z-10 w-44 rounded-xl border border-[#ccd9cf] bg-[#fbfcfa] p-2 text-xs shadow-xl"><p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#91a099]">View filter</p>{["All segments", "Enterprise", "Growth"].map(x => <button key={x} onClick={() => { setFilterOpen(false); announce(`${x} filter applied`); }} className="block w-full rounded-md px-2 py-2 text-left text-[#456052] hover:bg-[#e8f1e9]">{x}</button>)}</div>}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric icon={<WalletCards size={14} />} label="MRR" value="$2.48M" change="+12.4%" detail="vs. $2.21M last month" />
              <Metric icon={<Users size={14} />} label="Active customers" value="12,842" change="+8.7%" detail="1,034 net new this quarter" />
              <Metric icon={<Activity size={14} />} label="Net revenue retention" value="114%" change="+3.2%" detail="Expansion continues to lead" />
              <Metric icon={<ShieldAlert size={14} />} label="Accounts at risk" value="7" change="Needs review" detail="$186k in contracted value" tone="amber" />
            </div>

            {showNotice && <div className="mt-5 flex items-center gap-3 rounded-xl border border-[#e5d8b9] bg-[#fbf4e4] px-4 py-3 text-sm text-[#73562b]"><ShieldAlert size={17} className="shrink-0 text-[#bc842f]" /><span><b>7 accounts need attention.</b> Two renewal conversations are due this week.</span><button onClick={() => { setActive("Signals"); announce("Signals queue opened"); }} className="ml-auto whitespace-nowrap text-xs font-bold underline decoration-[#cda766] underline-offset-4 hover:text-[#4e3c1f]">Review signals</button><button aria-label="Dismiss alert" onClick={() => setShowNotice(false)} className="ml-1 rounded p-1 hover:bg-[#f1e5cb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#bc842f]"><X size={15} /></button></div>}

            <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
              <section className="rounded-xl border border-[#d8ddd9] bg-[#fbfcfa] p-5 shadow-[0_1px_2px_rgba(27,54,42,.04)]">
                <div className="flex items-start justify-between"><div><p className="text-[11px] font-bold uppercase tracking-[.12em] text-[#829087]">Performance trend</p><div className="mt-1 flex items-end gap-3"><h2 className="font-mono text-2xl font-semibold tracking-[-.05em] text-[#173a2d]">$248.6k</h2><span className="mb-1 flex items-center gap-1 text-xs font-semibold text-[#3e8b61]"><ArrowUpRight size={14} />12.4%</span></div></div><button onClick={() => announce("Chart menu opened")} aria-label="More chart options" className="rounded-md p-1.5 text-[#8a9890] hover:bg-[#e8f0e9] hover:text-[#365544] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6aa58b]"><MoreHorizontal size={17} /></button></div>
                <TrendChart range={range} />
              </section>
              <section className="rounded-xl border border-[#d8ddd9] bg-[#fbfcfa] p-5 shadow-[0_1px_2px_rgba(27,54,42,.04)]"><div className="flex items-center justify-between"><div><p className="text-[11px] font-bold uppercase tracking-[.12em] text-[#829087]">Acquisition mix</p><h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#294538]">1,034 new customers</h2></div><button onClick={() => announce("Acquisition details opened")} className="text-xs font-semibold text-[#4b8766] hover:text-[#24573e]">Details <ArrowUpRight size={13} className="inline" /></button></div><div className="mt-6 space-y-4">{[["Product-led", "42%", "434", "bg-[#4f9570]"], ["Partners", "28%", "289", "bg-[#78ad8d]"], ["Outbound", "19%", "196", "bg-[#b2cdbb]"], ["Other", "11%", "115", "bg-[#dbe7dd]"]].map(([name, pct, count, color]) => <div key={name}><div className="mb-1.5 flex justify-between text-xs"><span className="font-medium text-[#53665a]">{name}</span><span className="font-mono text-[#829087]">{count} <b className="ml-2 text-[#294538]">{pct}</b></span></div><div className="h-2 overflow-hidden rounded-full bg-[#edf1ed]"><div className={`h-full rounded-full ${color}`} style={{ width: pct }} /></div></div>)}</div></section>
            </div>

            <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_1.45fr]">
              <section className="rounded-xl border border-[#d8ddd9] bg-[#fbfcfa] p-5"><div className="mb-3 flex items-center justify-between"><div><p className="text-[11px] font-bold uppercase tracking-[.12em] text-[#829087]">Priority signals</p><h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#294538]">Worth a closer look</h2></div><span className="rounded-full bg-[#f1e7d4] px-2 py-1 text-[10px] font-bold text-[#986a24]">3 open</span></div>{[["Renewal concentration", "2 enterprise renewals due in 14 days", "High", "risk"], ["Expansion velocity", "Upsell pipeline grew $38k this week", "Positive", "good"], ["Support load", "Median first response up 18 minutes", "Watch", "watch"]].map(([title, body, level, tone]) => <button key={title} onClick={() => announce(`${title} signal opened`)} className="group flex w-full items-start gap-3 border-t border-[#e8ece8] py-3 text-left first:border-0 hover:bg-[#f2f7f3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6aa58b]"><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone === "risk" ? "bg-[#c86d5d]" : tone === "watch" ? "bg-[#d3a34b]" : "bg-[#65a97c]"}`} /><span className="min-w-0 flex-1"><b className="block text-xs text-[#3a5144]">{title}</b><span className="mt-1 block text-[11px] leading-4 text-[#89958e]">{body}</span></span><span className={`text-[10px] font-bold ${tone === "risk" ? "text-[#ae594c]" : tone === "watch" ? "text-[#9c6c25]" : "text-[#43835e]"}`}>{level}</span></button>)}</section>
              <section className="rounded-xl border border-[#d8ddd9] bg-[#fbfcfa] p-5"><div className="mb-3 flex items-center justify-between"><div><p className="text-[11px] font-bold uppercase tracking-[.12em] text-[#829087]">Customer watchlist</p><h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#294538]">Accounts by health</h2></div><button onClick={() => announce("Customer list opened")} className="text-xs font-semibold text-[#4b8766] hover:text-[#24573e]">View all <ArrowUpRight size={13} className="inline" /></button></div><div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs"><thead className="border-b border-[#e5eae6] text-[10px] uppercase tracking-[.11em] text-[#8c9990]"><tr><th className="pb-2 font-semibold">Account</th><th className="pb-2 font-semibold">Owner</th><th className="pb-2 font-semibold">Plan</th><th className="pb-2 font-semibold">Health</th><th className="pb-2 text-right font-semibold">Value</th></tr></thead><tbody>{accountRows.map(([account, owner, plan, health, value]) => <tr key={account} className="group border-b border-[#edf0ed] last:border-0 hover:bg-[#f2f7f3]"><td className="py-3 font-semibold text-[#3b5145]">{account}</td><td className="py-3 text-[#7c8981]">{owner}</td><td className="py-3 text-[#7c8981]">{plan}</td><td className="py-3"><HealthPill tone={health === "healthy" ? "good" : health === "watch" ? "watch" : "risk"}>{health === "healthy" ? "Healthy" : health === "watch" ? "Watch" : "At risk"}</HealthPill></td><td className="py-3 text-right font-mono text-[#52675a]">{value}</td></tr>)}</tbody></table></div></section>
            </div>

            <section className="mt-5 rounded-xl border border-[#d8ddd9] bg-[#fbfcfa] p-5"><div className="flex items-center justify-between"><div><p className="text-[11px] font-bold uppercase tracking-[.12em] text-[#829087]">Recent activity</p><h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#294538]">Team movement</h2></div><button onClick={() => announce("Activity feed opened")} className="rounded-lg border border-[#d7e0d8] px-3 py-2 text-xs font-semibold text-[#577062] hover:bg-[#eaf2eb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6aa58b]">Full activity</button></div><div className="mt-4 grid gap-3 md:grid-cols-3">{[["PS", "Priya Shah", "moved Veridian Labs to renewal review", "12 min ago", "bg-[#d9e7ec] text-[#3e697c]"], ["TG", "Theo Grant", "logged a risk note on Northwind Studio", "46 min ago", "bg-[#eadbd3] text-[#85573f]"], ["JB", "Jon Bell", "closed a $24,800 expansion with Arc & Line", "2 hr ago", "bg-[#e3ecd7] text-[#527446]"]].map(([initials, name, action, time, color]) => <button key={name} onClick={() => announce(`${name}'s activity opened`)} className="flex items-center gap-3 rounded-lg border border-[#e7ece7] p-3 text-left transition hover:border-[#b4cbb9] hover:bg-[#f2f7f3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6aa58b]"><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[10px] font-bold ${color}`}>{initials}</span><span className="min-w-0"><b className="block truncate text-xs text-[#3a5144]">{name} <span className="font-normal text-[#87938b]">{action}</span></b><span className="mt-1 block text-[10px] text-[#a0aaa4]">{time}</span></span></button>)}</div></section>
          </div>
        </section>
      </div>
      {toast && <div role="status" className="fixed bottom-5 right-5 z-20 flex items-center gap-2 rounded-lg bg-[#173a2d] px-4 py-3 text-xs font-medium text-[#e2f2e7] shadow-xl"><Command size={14} />{toast}</div>}
    </main>
  );
}