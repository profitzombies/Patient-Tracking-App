import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Bell,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Filter,
  LayoutGrid,
  Menu,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  X,
} from "lucide-react";

type Range = "12 months" | "6 months" | "30 days";

const trend = [42, 48, 46, 54, 58, 62, 60, 67, 72, 78, 84, 91];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const accounts = [
  { name: "Figma", initials: "F", owner: "Maya Chen", plan: "Scale", health: "Healthy", value: "$184k", color: "bg-[#ef9f78]" },
  { name: "Vercel", initials: "V", owner: "Jon Bell", plan: "Growth", health: "Healthy", value: "$92k", color: "bg-[#98b7d2]" },
  { name: "Linear", initials: "L", owner: "Sofia Reyes", plan: "Scale", health: "Watch", value: "$76k", color: "bg-[#c2b3e2]" },
  { name: "Notion", initials: "N", owner: "Maya Chen", plan: "Growth", health: "At risk", value: "$54k", color: "bg-[#e7c46b]" },
];

function TrendChart({ range }: { range: Range }) {
  const visible = range === "30 days" ? trend.slice(-3) : range === "6 months" ? trend.slice(-6) : trend;
  const visibleMonths = range === "30 days" ? ["Oct", "Nov", "Dec"] : range === "6 months" ? months.slice(-6) : months;
  return (
    <div className="relative mt-5 h-[154px]">
      <div className="absolute inset-0 flex flex-col justify-between text-[10px] text-[#98a3a6]">
        {["$2.5M", "$2.0M", "$1.5M", "$1.0M"].map((label) => (
          <div key={label} className="flex items-center gap-3"><span className="w-9">{label}</span><div className="h-px flex-1 bg-[#e7ebe7]" /></div>
        ))}
      </div>
      <div className="absolute bottom-5 left-[52px] right-0 top-2 flex items-end gap-2">
        {visible.map((value, i) => (
          <div key={`${value}-${i}`} className="group relative flex h-full flex-1 items-end">
            <div className="absolute bottom-0 left-0 right-0 rounded-t-[3px] bg-[#cde4d7] transition-all duration-300 group-hover:bg-[#173f39]" style={{ height: `${value * 0.98}%` }} />
            <div className="absolute -top-5 left-1/2 hidden -translate-x-1/2 rounded bg-[#173f39] px-1.5 py-1 text-[10px] text-[#f8f7f1] group-hover:block">${(value * 27.2).toFixed(0)}k</div>
          </div>
        ))}
      </div>
      <div className="absolute bottom-0 left-[52px] right-0 flex justify-between text-[10px] text-[#98a3a6]">
        {visibleMonths.map((m) => <span key={m}>{m}</span>)}
      </div>
    </div>
  );
}

function Signal({ tone, title, detail, action }: { tone: "amber" | "green" | "red"; title: string; detail: string; action: string }) {
  const tones = { amber: "bg-[#f1c768]", green: "bg-[#75b59a]", red: "bg-[#df806d]" };
  return (
    <button className="group flex w-full items-start gap-3 border-b border-[#e7ebe7] py-3 text-left transition-colors last:border-0 hover:bg-[#f5f6f0] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#e28162]">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tones[tone]}`} />
      <span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold text-[#24413c]">{title}</span><span className="mt-0.5 block text-[11px] leading-4 text-[#7d8988]">{detail}</span></span>
      <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[10px] font-medium text-[#7d8988] group-hover:text-[#24413c]">{action}<ChevronRight size={12} /></span>
    </button>
  );
}

export function NarrativeInsight() {
  const [range, setRange] = useState<Range>("12 months");
  const [rangeOpen, setRangeOpen] = useState(false);
  const [active, setActive] = useState("Overview");
  const [notice, setNotice] = useState("");
  const nav = useMemo(() => ["Overview", "Revenue", "Customers", "Signals"], []);
  const showNotice = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2200); };

  return (
    <div className="min-h-[100dvh] bg-[#f8f7f1] font-sans text-[#24413c]">
      <style>{`
        .northstar-font { font-family: Georgia, 'Times New Roman', serif; }
        .northstar-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      `}</style>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[218px] border-r border-[#dfe5df] bg-[#eef1e9] px-5 py-6 md:block">
        <div className="flex items-center gap-2.5"><div className="grid h-7 w-7 place-items-center rounded-[9px] bg-[#173f39] text-[#f8f7f1]"><Sparkles size={15} /></div><span className="text-[15px] font-bold tracking-[-0.02em]">northstar</span></div>
        <div className="mt-10 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#98a3a6]">Workspace</div>
        <nav className="mt-3 space-y-1">
          {nav.map((item, i) => <button key={item} onClick={() => setActive(item)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[12px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#e28162] ${active === item ? "bg-[#d9e7db] text-[#173f39]" : "text-[#687876] hover:bg-[#e2e9e0]"}`}><span className="w-4 text-center">{i === 0 ? <LayoutGrid size={15} /> : i === 1 ? <TrendingUp size={15} /> : i === 2 ? <Users size={15} /> : <Bell size={15} />}</span>{item}{item === "Signals" && <span className="ml-auto rounded-full bg-[#e28162] px-1.5 py-0.5 text-[9px] font-bold text-[#fff8f0]">7</span>}</button>)}
        </nav>
        <div className="mt-10 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#98a3a6]">Saved views</div>
        <button onClick={() => showNotice("Saved view opened")} className="mt-3 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[12px] text-[#687876] hover:bg-[#e2e9e0] focus:outline-none focus:ring-2 focus:ring-[#e28162]"><Target size={15} />Board meeting</button>
        <div className="absolute bottom-6 left-5 right-5 border-t border-[#d6dfd7] pt-4"><button onClick={() => showNotice("Workspace settings opened")} className="flex w-full items-center justify-between text-[11px] text-[#687876] hover:text-[#173f39]"><span className="flex items-center gap-2"><SlidersHorizontal size={14} />Workspace settings</span><ChevronRight size={13} /></button></div>
      </aside>
      <main className="md:pl-[218px]">
        <header className="flex h-[66px] items-center justify-between border-b border-[#dfe5df] px-5 sm:px-9">
          <button className="md:hidden" onClick={() => showNotice("Navigation available on desktop")} aria-label="Open navigation"><Menu size={19} /></button>
          <div className="hidden items-center gap-2 text-[11px] text-[#7d8988] sm:flex"><span>Workspace</span><ChevronRight size={13} /><span className="font-medium text-[#24413c]">Daily brief</span></div>
          <div className="flex items-center gap-2.5"><button onClick={() => showNotice("Search is ready")} className="rounded-lg p-2 text-[#687876] hover:bg-[#e8ece5] focus:outline-none focus:ring-2 focus:ring-[#e28162]" aria-label="Search"><Search size={17} /></button><button onClick={() => showNotice("No new notifications")} className="relative rounded-lg p-2 text-[#687876] hover:bg-[#e8ece5] focus:outline-none focus:ring-2 focus:ring-[#e28162]" aria-label="Notifications"><Bell size={17} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#e28162]" /></button><div className="ml-1 grid h-7 w-7 place-items-center rounded-full bg-[#173f39] text-[10px] font-bold text-[#e8f0e5]">MR</div></div>
        </header>
        <div className="mx-auto max-w-[1180px] px-5 py-7 sm:px-9 lg:py-9">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#e28162]"><span className="h-1.5 w-1.5 rounded-full bg-[#e28162]" />Tuesday, December 12, 2024</div><h1 className="northstar-font mt-2 text-[34px] leading-none tracking-[-0.04em] text-[#173f39] sm:text-[42px]">The business is moving well.</h1><p className="mt-3 max-w-[530px] text-[13px] leading-5 text-[#687876]">A clear read on momentum, with a few things worth your attention before the week gets away.</p></div>
            <div className="relative"><button onClick={() => setRangeOpen(!rangeOpen)} className="flex items-center gap-3 rounded-lg border border-[#cfd9d0] bg-[#fbfbf6] px-3.5 py-2.5 text-[12px] font-semibold shadow-[0_1px_2px_rgba(23,63,57,.04)] hover:border-[#9db5a3] focus:outline-none focus:ring-2 focus:ring-[#e28162]"><Clock3 size={14} className="text-[#7d8988]" />{range}<ChevronDown size={14} className="text-[#7d8988]" /></button>{rangeOpen && <div className="absolute right-0 top-12 z-10 w-36 overflow-hidden rounded-lg border border-[#cfd9d0] bg-[#fbfbf6] p-1 shadow-lg">{(["12 months", "6 months", "30 days"] as Range[]).map((r) => <button key={r} onClick={() => { setRange(r); setRangeOpen(false); }} className="block w-full rounded px-2.5 py-2 text-left text-[11px] hover:bg-[#e2e9e0]">{r}</button>)}</div>}</div>
          </div>
          <section className="mt-8 grid gap-px overflow-hidden rounded-xl border border-[#dfe5df] bg-[#dfe5df] sm:grid-cols-2 lg:grid-cols-4">
            {[["Monthly recurring revenue", "$2.48M", "+12.4%", "vs. last month", "up"], ["Active customers", "12,842", "+8.7%", "vs. last month", "up"], ["Net revenue retention", "114%", "+3.2%", "vs. last quarter", "up"], ["Accounts at risk", "7", "2 fewer", "than last week", "warn"]].map(([label, value, delta, compare, kind]) => <div key={label} className="bg-[#fbfbf6] p-5 transition-colors hover:bg-[#f4f5ee]"><div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.1em] text-[#8a9794]"><span>{label}</span>{kind === "warn" ? <Bell size={14} className="text-[#e28162]" /> : <ArrowUpRight size={14} className="text-[#75a98d]" />}</div><div className="mt-3 flex items-baseline gap-2"><span className="northstar-mono text-[25px] font-semibold tracking-[-0.06em] text-[#173f39]">{value}</span><span className={`text-[11px] font-bold ${kind === "warn" ? "text-[#75a98d]" : "text-[#4c9a78]"}`}>{delta}</span></div><div className="mt-1 text-[11px] text-[#9aa4a1]">{compare}</div></div>)}
          </section>
          <div className="mt-6 grid gap-6 lg:grid-cols-[1.45fr_1fr]">
            <section className="rounded-xl border border-[#dfe5df] bg-[#fbfbf6] p-5 sm:p-6"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><h2 className="northstar-font text-[20px] text-[#173f39]">Momentum, at a glance</h2><span className="rounded-full bg-[#d9e7db] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#4c8068]">Healthy</span></div><p className="mt-1 text-[11px] text-[#8a9794]">Revenue performance · trailing {range}</p></div><button onClick={() => showNotice("Chart filters opened")} className="rounded-lg p-2 text-[#7d8988] hover:bg-[#e8ece5] focus:outline-none focus:ring-2 focus:ring-[#e28162]}"><Filter size={15} /></button></div><TrendChart range={range} /><div className="mt-3 flex items-center gap-5 border-t border-[#e7ebe7] pt-3 text-[10px] text-[#7d8988]"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-[#cde4d7]" />MRR</span><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-[#e28162]" />Target</span><span className="ml-auto font-semibold text-[#4c9a78]">+12.4% year over year</span></div></section>
            <section className="rounded-xl border border-[#dfe5df] bg-[#fbfbf6] p-5 sm:p-6"><div className="flex items-start justify-between"><div><h2 className="northstar-font text-[20px] text-[#173f39]">What needs a look</h2><p className="mt-1 text-[11px] text-[#8a9794]">Signals ranked by urgency</p></div><button onClick={() => setActive("Signals")} className="text-[11px] font-semibold text-[#e28162] hover:underline">View all</button></div><div className="mt-3"><Signal tone="amber" title="Expansion slowed in Enterprise" detail="Pipeline coverage is 0.8× target this week." action="Review" /><Signal tone="red" title="7 accounts show risk signals" detail="Four have not had a touch in 14+ days." action="Open list" /><Signal tone="green" title="Product adoption is accelerating" detail="Weekly active teams up 18% since October." action="Explore" /></div></section>
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.45fr]">
            <section className="rounded-xl border border-[#dfe5df] bg-[#fbfbf6] p-5 sm:p-6"><div className="flex items-center justify-between"><div><h2 className="northstar-font text-[20px] text-[#173f39]">Acquisition mix</h2><p className="mt-1 text-[11px] text-[#8a9794]">New ARR this quarter</p></div><button onClick={() => showNotice("Acquisition report opened")} className="rounded-lg p-2 text-[#7d8988] hover:bg-[#e8ece5] focus:outline-none focus:ring-2 focus:ring-[#e28162]"><MoreHorizontal size={16} /></button></div><div className="mt-5 flex items-center gap-6"><div className="relative grid h-[112px] w-[112px] shrink-0 place-items-center rounded-full" style={{ background: "conic-gradient(#173f39 0 42%, #75b59a 42% 70%, #e28162 70% 87%, #e7c46b 87% 100%)" }}><div className="grid h-[70px] w-[70px] place-items-center rounded-full bg-[#fbfbf6]"><span className="northstar-mono text-[16px] font-semibold">$486k</span></div></div><div className="w-full space-y-3 text-[11px]">{[["Inbound", "42%", "#173f39"], ["Partner", "28%", "#75b59a"], ["Outbound", "17%", "#e28162"], ["Other", "13%", "#e7c46b"]].map(([name, pct, color]) => <div key={name} className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm" style={{ background: color }} /><span className="flex-1 text-[#687876]">{name}</span><span className="font-bold text-[#24413c]">{pct}</span></div>)}</div></div></section>
            <section className="rounded-xl border border-[#dfe5df] bg-[#fbfbf6] p-5 sm:p-6"><div className="flex items-center justify-between"><div><h2 className="northstar-font text-[20px] text-[#173f39]">Accounts to keep close</h2><p className="mt-1 text-[11px] text-[#8a9794]">Highest-value relationships · sorted by ARR</p></div><button onClick={() => showNotice("Customer list opened")} className="flex items-center gap-1 text-[11px] font-semibold text-[#e28162] hover:underline">View customers <ChevronRight size={13} /></button></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[510px] text-left text-[11px]"><thead className="border-b border-[#e7ebe7] text-[9px] uppercase tracking-[0.12em] text-[#98a3a6]"><tr><th className="pb-2 font-semibold">Account</th><th className="pb-2 font-semibold">Owner</th><th className="pb-2 font-semibold">Plan</th><th className="pb-2 font-semibold">Health</th><th className="pb-2 text-right font-semibold">ARR</th></tr></thead><tbody>{accounts.map((a) => <tr key={a.name} className="group border-b border-[#eef0eb] last:border-0"><td className="py-3"><span className="flex items-center gap-2.5 font-semibold text-[#24413c]"><span className={`grid h-6 w-6 place-items-center rounded-md text-[10px] font-bold text-[#24413c] ${a.color}`}>{a.initials}</span>{a.name}</span></td><td className="py-3 text-[#7d8988]">{a.owner}</td><td className="py-3 text-[#7d8988]">{a.plan}</td><td className="py-3"><span className={`rounded-full px-2 py-1 text-[9px] font-semibold ${a.health === "At risk" ? "bg-[#f8dfd5] text-[#a85843]" : a.health === "Watch" ? "bg-[#fbebc7] text-[#9d741d]" : "bg-[#d9e7db] text-[#4c8068]"}`}>{a.health}</span></td><td className="py-3 text-right font-semibold text-[#24413c]">{a.value}</td></tr>)}</tbody></table></div></section>
          </div>
          <footer className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-[#dfe5df] pt-4 text-[10px] text-[#98a3a6]"><span>Updated 8 minutes ago · Data through Dec 11, 2024</span><button onClick={() => showNotice("Help center opened")} className="flex items-center gap-1.5 hover:text-[#24413c] focus:outline-none focus:ring-2 focus:ring-[#e28162]"><CircleHelp size={13} />How Northstar calculates this</button></footer>
        </div>
      </main>
      {notice && <div className="fixed bottom-5 right-5 z-30 flex items-center gap-3 rounded-lg bg-[#173f39] px-4 py-3 text-[12px] text-[#f8f7f1] shadow-xl"><Sparkles size={14} className="text-[#e28162]" />{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} /></button></div>}
    </div>
  );
}