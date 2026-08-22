import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  Filter,
  LayoutDashboard,
  MoreHorizontal,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  Target,
  Users,
  WalletCards,
  X,
} from "lucide-react";

type Range = "12 months" | "6 months" | "30 days";
type Health = "Healthy" | "Watch" | "At risk";

const trend = [51, 55, 54, 61, 65, 70, 68, 76, 79, 85, 89, 94];
const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];
const accounts = [
  { initials: "LW", name: "Latticeworks", owner: "Maya Chen", plan: "Enterprise", health: "Healthy" as Health, value: "$184.2k", tint: "#d8e8dd" },
  { initials: "AL", name: "Arc & Line", owner: "Jon Bell", plan: "Growth", health: "Watch" as Health, value: "$72.8k", tint: "#f0dfbf" },
  { initials: "VL", name: "Veridian Labs", owner: "Priya Shah", plan: "Enterprise", health: "Healthy" as Health, value: "$151.4k", tint: "#d8e4ed" },
  { initials: "NS", name: "Northwind Studio", owner: "Theo Grant", plan: "Growth", health: "At risk" as Health, value: "$48.6k", tint: "#ead8d1" },
];

function ActionButton({ label, onClick, children, className = "" }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return <button aria-label={label} onClick={onClick} className={`rounded-lg transition hover:bg-[#e6eee9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d] ${className}`}>{children}</button>;
}

function HealthPill({ health }: { health: Health }) {
  const tone = health === "Healthy" ? "bg-[#dcece1] text-[#397056]" : health === "Watch" ? "bg-[#f6e9c9] text-[#9b6d24]" : "bg-[#f2ddd7] text-[#a45142]";
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-bold ${tone}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{health}</span>;
}

function TrendChart({ range }: { range: Range }) {
  const values = range === "30 days" ? trend.slice(-4) : range === "6 months" ? trend.slice(-6) : trend;
  const labels = range === "30 days" ? ["Apr 01", "Apr 10", "Apr 20", "Apr 30"] : range === "6 months" ? months.slice(-6) : months;
  return <div className="relative mt-5 h-[178px]">
    <div className="absolute inset-0 flex flex-col justify-between text-[9px] text-[#9aa8a0]">
      {[2.5, 2, 1.5, 1].map((n) => <div key={n} className="flex items-center gap-3"><span className="w-8 text-right font-mono">${n.toFixed(1)}M</span><span className="h-px flex-1 bg-[#e2eae4]" /></div>)}
    </div>
    <div className="absolute bottom-6 left-12 right-0 top-1 flex items-end gap-2.5">
      {values.map((v, i) => <div key={`${v}-${i}`} className="group relative flex h-full flex-1 items-end">
        <div className={`w-full rounded-t-[4px] transition duration-200 group-hover:bg-[#d07159] ${i === values.length - 1 ? "bg-[#22594f]" : "bg-[#a9d1bd]"}`} style={{ height: `${v}%` }} />
        <span className="absolute -top-5 left-1/2 hidden -translate-x-1/2 rounded bg-[#183f3b] px-1.5 py-1 text-[9px] text-[#f7f5ed] group-hover:block">${(v * 0.0264).toFixed(2)}M</span>
      </div>)}
    </div>
    <div className="absolute bottom-0 left-12 right-0 flex justify-between text-[9px] text-[#9aa8a0]">{labels.map((label) => <span key={label}>{label}</span>)}</div>
  </div>;
}

export function HybridGuidedOperations() {
  const [range, setRange] = useState<Range>("12 months");
  const [rangeOpen, setRangeOpen] = useState(false);
  const [active, setActive] = useState("Overview");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const nav = useMemo(() => [{ label: "Overview", icon: LayoutDashboard }, { label: "Revenue", icon: WalletCards }, { label: "Customers", icon: Users }, { label: "Signals", icon: ShieldAlert }], []);
  const metrics: Array<{ label: string; value: string; delta: string; note: string; Icon: typeof WalletCards }> = [
    { label: "Monthly recurring revenue", value: "$2.48M", delta: "+12.4%", note: "vs. last month", Icon: WalletCards },
    { label: "Active customers", value: "12,842", delta: "+8.7%", note: "1,034 net new this quarter", Icon: Users },
    { label: "Net revenue retention", value: "114%", delta: "+3.2%", note: "expansion continues to lead", Icon: Activity },
    { label: "Accounts at risk", value: "7", delta: "2 high-value", note: "$186k contracted value", Icon: ShieldAlert },
  ];
  const announce = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2200); };

  return <main className="min-h-[100dvh] bg-[#f4f6f0] text-[#233f3a]" style={{ fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif" }}>
    <div className="flex min-h-[100dvh]">
      <aside className="hidden w-[224px] shrink-0 flex-col border-r border-[#d6e1d9] bg-[#e7efe8] px-4 py-5 md:flex">
        <button onClick={() => announce("Workspace switcher opened")} className="flex items-center gap-2.5 rounded-lg px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d]">
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-[#183f3b] text-[#e7f3e9]"><Command size={16} /></span>
          <span><b className="block text-[15px] tracking-[-.03em] text-[#183f3b]">northstar</b><small className="text-[9px] font-bold uppercase tracking-[.17em] text-[#789087]">Revenue workspace</small></span>
          <ChevronDown size={14} className="ml-auto text-[#7d9187]" />
        </button>
        <p className="mb-2 mt-10 px-2 text-[10px] font-bold uppercase tracking-[.16em] text-[#82958a]">Workspace</p>
        <nav className="space-y-1">{nav.map(({ label, icon: Icon }) => <button key={label} onClick={() => { setActive(label); announce(`${label} view selected`); }} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d] ${active === label ? "bg-[#cfe3d4] text-[#183f3b]" : "text-[#637870] hover:bg-[#dce9de]"}`}><Icon size={16} />{label}{label === "Signals" && <span className="ml-auto rounded-full bg-[#d07159] px-1.5 py-0.5 text-[9px] font-bold text-[#fff7ed]">7</span>}</button>)}</nav>
        <p className="mb-2 mt-9 px-2 text-[10px] font-bold uppercase tracking-[.16em] text-[#82958a]">Shortcuts</p>
        <button onClick={() => announce("Board meeting view opened")} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs text-[#637870] hover:bg-[#dce9de] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d]"><Target size={16} />Board meeting</button>
        <button onClick={() => announce("Settings opened")} className="mt-auto flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs text-[#637870] hover:bg-[#dce9de] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d]"><Settings2 size={16} />Settings</button>
        <div className="mt-3 border-t border-[#d0ded3] pt-4"><div className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-full bg-[#e1c5a5] text-[10px] font-bold text-[#67452f]">MC</span><span><b className="block text-[11px] text-[#35564b]">Maya Chen</b><small className="text-[10px] text-[#899d91]">Admin</small></span></div></div>
      </aside>
      <section className="min-w-0 flex-1">
        <header className="flex h-[68px] items-center justify-between border-b border-[#d9e3dc] bg-[#f8f9f4] px-5 md:px-8">
          <div className="flex items-center gap-2 text-[11px] text-[#8b9a92]"><span>Northstar</span><ChevronRight size={13} /><b className="text-[#36564c]">{active}</b></div>
          <div className="flex items-center gap-2">
            {searchOpen && <input autoFocus placeholder="Search accounts" onKeyDown={(e) => e.key === "Enter" && announce("Search submitted")} className="h-8 w-36 rounded-lg border border-[#cbdad0] bg-[#fbfcf8] px-2.5 text-[11px] outline-none focus:ring-2 focus:ring-[#cf765d]" />}
            <ActionButton label="Search" onClick={() => setSearchOpen(!searchOpen)} className="p-2 text-[#6d8278]"><Search size={16} /></ActionButton>
            <ActionButton label="Notifications" onClick={() => announce("No new notifications")} className="relative p-2 text-[#6d8278]"><Bell size={17} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#d07159]" /></ActionButton>
            <button onClick={() => announce("Account menu opened")} className="ml-1 flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[#e8eee8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d]"><span className="hidden text-right sm:block"><b className="block text-[11px] text-[#35564c]">Maya Chen</b><small className="text-[9px] text-[#8a9a91]">Admin</small></span><span className="grid h-8 w-8 place-items-center rounded-full bg-[#e1c5a5] text-[10px] font-bold text-[#67452f]">MC</span></button>
          </div>
        </header>
        <div className="mx-auto max-w-[1320px] px-5 py-7 md:px-8">
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div><div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.16em] text-[#c96850]"><span className="h-1.5 w-1.5 rounded-full bg-[#d07159]" />Tuesday, April 30, 2024</div><h1 className="text-[32px] font-bold leading-none tracking-[-.06em] text-[#183f3b] sm:text-[40px]">The business is moving well.</h1><p className="mt-3 max-w-[600px] text-[13px] leading-5 text-[#71847a]">Momentum is intact. Expansion is carrying the month; three signals deserve a human look before Friday.</p></div>
            <div className="flex items-center gap-2">
              <div className="relative"><button onClick={() => setRangeOpen(!rangeOpen)} className="flex h-9 items-center gap-2 rounded-lg border border-[#cbd9d0] bg-[#fbfcf8] px-3 text-[11px] font-bold text-[#3d5d52] shadow-sm hover:border-[#8fae9d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d]"><span className="text-[#91a199]">View</span>{range}<ChevronDown size={14} /></button>{rangeOpen && <div className="absolute right-0 top-11 z-20 w-36 rounded-lg border border-[#cbd9d0] bg-[#fbfcf8] p-1 shadow-xl">{(["12 months", "6 months", "30 days"] as Range[]).map((item) => <button key={item} onClick={() => { setRange(item); setRangeOpen(false); announce(`Showing ${item}`); }} className="block w-full rounded px-2.5 py-2 text-left text-[11px] hover:bg-[#e5eee7]">{item}</button>)}</div>}</div>
              <div className="relative"><ActionButton label="Filter dashboard" onClick={() => setFilterOpen(!filterOpen)} className="border border-[#cbd9d0] bg-[#fbfcf8] p-2 text-[#6e8279]"><Filter size={15} /></ActionButton>{filterOpen && <div className="absolute right-0 top-11 z-20 w-40 rounded-lg border border-[#cbd9d0] bg-[#fbfcf8] p-2 text-[11px] shadow-xl"><p className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-[#91a199]">Segment</p>{["All segments", "Enterprise", "Growth"].map((item) => <button key={item} onClick={() => { setFilterOpen(false); announce(`${item} filter applied`); }} className="block w-full rounded px-2 py-2 text-left hover:bg-[#e5eee7]">{item}</button>)}</div>}</div>
            </div>
          </div>

          <div className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map(({ label, value, delta, note, Icon }) => <div key={label} className={`rounded-xl border p-4 transition hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(33,67,56,.07)] ${label === "Accounts at risk" ? "border-[#ead2c6] bg-[#fffaf5]" : "border-[#d8e3da] bg-[#fbfcf8]"}`}><div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[.1em] text-[#84968b]"><span>{label}</span><Icon size={14} className={label === "Accounts at risk" ? "text-[#c96850]" : "text-[#6f9b81]"} /></div><div className="mt-3 flex items-end gap-2"><span className={`font-mono text-[26px] font-semibold tracking-[-.06em] ${label === "Accounts at risk" ? "text-[#a85141]" : "text-[#183f3b]"}`}>{value}</span><span className={`mb-1 text-[11px] font-bold ${label === "Accounts at risk" ? "text-[#b1663e]" : "text-[#4d956e]"}`}>{delta}</span></div><p className="mt-1 text-[11px] text-[#8b9a91]">{note}</p></div>)}
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-[1.45fr_.85fr]">
            <section className="rounded-xl border border-[#d8e3da] bg-[#fbfcf8] p-5 shadow-[0_1px_2px_rgba(33,67,56,.03)] sm:p-6"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><h2 className="text-[15px] font-bold tracking-[-.02em] text-[#274940]">Momentum, at a glance</h2><span className="rounded-full bg-[#dcece1] px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-[#397056]">On track</span></div><p className="mt-1 text-[11px] text-[#8a9a91]">Monthly recurring revenue · trailing {range}</p></div><ActionButton label="More chart options" onClick={() => announce("Chart options opened")} className="p-1.5 text-[#82948a]"><MoreHorizontal size={17} /></ActionButton></div><TrendChart range={range} /><div className="mt-3 flex items-center justify-between border-t border-[#e4ebe4] pt-3 text-[10px] text-[#84958b]"><span><b className="font-mono text-[#31594d]">$2.48M</b> current MRR</span><span className="flex items-center gap-1 font-bold text-[#4d956e]"><ArrowUpRight size={13} />12.4% year over year</span></div></section>
            <section className="rounded-xl border border-[#d8e3da] bg-[#fbfcf8] p-5 shadow-[0_1px_2px_rgba(33,67,56,.03)] sm:p-6"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><h2 className="text-[15px] font-bold tracking-[-.02em] text-[#274940]">What deserves a look</h2><span className="rounded-full bg-[#f5e5cf] px-2 py-1 text-[9px] font-bold text-[#9e682b]">3 open</span></div><p className="mt-1 text-[11px] text-[#8a9a91]">Signals ranked by consequence</p></div><ActionButton label="Open all signals" onClick={() => { setActive("Signals"); announce("Signals queue opened"); }} className="p-1.5 text-[#c96850]"><ChevronRight size={16} /></ActionButton></div><div className="mt-4 space-y-1">{[["Renewal concentration", "2 enterprise renewals due in 14 days", "High", "risk"], ["Expansion velocity", "Upsell pipeline grew $38k this week", "Positive", "good"], ["Support load", "First response is up 18 minutes", "Watch", "watch"]].map(([title, detail, level, tone]) => <button key={title} onClick={() => announce(`${title} opened`)} className="group flex w-full items-start gap-3 border-t border-[#e5ece6] py-3 text-left first:border-0 hover:bg-[#f1f6f1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#cf765d]"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone === "risk" ? "bg-[#cf765d]" : tone === "watch" ? "bg-[#d1a24e]" : "bg-[#6ca27f]"}`} /><span className="min-w-0 flex-1"><b className="block text-[11px] text-[#3b5a4e]">{title}</b><span className="mt-1 block text-[10px] leading-4 text-[#8c9b92]">{detail}</span></span><span className={`text-[10px] font-bold ${tone === "risk" ? "text-[#ad5b4d]" : tone === "watch" ? "text-[#a17428]" : "text-[#4d906c]"}`}>{level}</span></button>)}</div></section>
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-[.82fr_1.48fr]">
            <section className="rounded-xl border border-[#d8e3da] bg-[#fbfcf8] p-5 sm:p-6"><div className="flex items-start justify-between"><div><h2 className="text-[15px] font-bold tracking-[-.02em] text-[#274940]">Acquisition mix</h2><p className="mt-1 text-[11px] text-[#8a9a91]">1,034 new customers · this quarter</p></div><Target size={17} className="text-[#78998a]" /></div><div className="mt-5 space-y-4">{[["Product-led", "42%", "#276557"], ["Partners", "28%", "#6fa486"], ["Outbound", "19%", "#cf765d"], ["Other", "11%", "#c9d9ce"]].map(([name, pct, color]) => <div key={name}><div className="mb-1.5 flex justify-between text-[11px]"><span className="font-semibold text-[#536d61]">{name}</span><b className="font-mono text-[#31594d]">{pct}</b></div><div className="h-2 overflow-hidden rounded-full bg-[#e8efe9]"><div className="h-full rounded-full transition-all duration-500" style={{ width: pct, background: color }} /></div></div>)}</div><div className="mt-5 flex items-center gap-2 border-t border-[#e5ece6] pt-4 text-[10px] text-[#82948a]"><Users size={13} />Expansion-led revenue is outpacing new logo revenue.</div></section>
            <section className="overflow-hidden rounded-xl border border-[#d8e3da] bg-[#fbfcf8]"><div className="flex items-center justify-between border-b border-[#e1e9e2] px-5 py-4 sm:px-6"><div><h2 className="text-[15px] font-bold tracking-[-.02em] text-[#274940]">Accounts to keep close</h2><p className="mt-1 text-[11px] text-[#8a9a91]">Highest-value relationships · sorted by ARR</p></div><button onClick={() => announce("Customer list opened")} className="flex items-center gap-1 text-[10px] font-bold text-[#c96850] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d]">View all <ArrowUpRight size={12} /></button></div><div className="overflow-x-auto"><table className="w-full min-w-[590px] text-left text-[11px]"><thead className="bg-[#f1f6f1] text-[9px] uppercase tracking-[.12em] text-[#8a9a91]"><tr><th className="px-5 py-2.5 font-bold sm:px-6">Account</th><th className="py-2.5 font-bold">Owner</th><th className="py-2.5 font-bold">Plan</th><th className="py-2.5 font-bold">Health</th><th className="py-2.5 pr-5 text-right font-bold sm:pr-6">ARR</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.name} onClick={() => announce(`${account.name} account selected`)} className="cursor-pointer border-t border-[#e6ece6] transition hover:bg-[#f1f6f1]"><td className="px-5 py-3 sm:px-6"><span className="flex items-center gap-2.5 font-semibold text-[#3b5a4e]"><span className="grid h-7 w-7 place-items-center rounded-md text-[9px] font-bold text-[#3c6657]" style={{ background: account.tint }}>{account.initials}</span>{account.name}</span></td><td className="py-3 text-[#788c82]">{account.owner}</td><td className="py-3 text-[#788c82]">{account.plan}</td><td className="py-3"><HealthPill health={account.health} /></td><td className="py-3 pr-5 text-right font-mono font-bold text-[#31594d] sm:pr-6">{account.value}</td></tr>)}</tbody></table></div></section>
          </div>
          <section className="mt-5 rounded-xl border border-[#d5e4db] bg-[#e9f2e9] px-4 py-3.5"><div className="flex flex-wrap items-center gap-3"><Sparkles size={15} className="text-[#c96850]" /><span className="text-[11px] text-[#557267]"><b className="text-[#31594d]">Northstar read:</b> expansion revenue has outpaced new logos for the third consecutive month, while renewal concentration is the one near-term variable to manage.</span><button onClick={() => { setSaved(!saved); announce(saved ? "Signal removed" : "Signal saved to workspace"); }} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold text-[#397056] hover:bg-[#d7e9da] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d]">{saved ? <Check size={13} /> : <ArrowUpRight size={13} />}{saved ? "Saved" : "Save signal"}</button></div></section>
          <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[#dce6dd] pt-4 text-[10px] text-[#91a098]"><span>Updated 4 minutes ago · Data through Apr 30, 2024</span><button onClick={() => announce("Metric definitions opened")} className="flex items-center gap-1.5 hover:text-[#31594d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf765d]"><CircleHelp size={13} />How this view is calculated</button></footer>
        </div>
      </section>
    </div>
    {notice && <div role="status" className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-lg bg-[#183f3b] px-4 py-3 text-[11px] font-semibold text-[#eff7ef] shadow-xl"><Command size={14} className="text-[#d07159]" />{notice}<button onClick={() => setNotice("")} aria-label="Dismiss message" className="ml-2 rounded p-0.5 hover:bg-[#315c54]"><X size={13} /></button></div>}
  </main>;
}