import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  Clipboard,
  Grid2X2,
  MessageCircle,
  Minus,
  Plus,
  Sun,
  TrendingDown,
  UtensilsCrossed,
} from "lucide-react";

const meals = [
  ["Breakfast", "2 items · 322 cal"],
  ["Lunch", "1 item · 420 cal"],
  ["Dinner", "Nothing logged yet"],
  ["Snacks", "1 item · 190 cal"],
];

const macros = [
  ["Protein", "73", "120", "61%", "bg-[#e8763a]"],
  ["Carbs", "70", "130", "54%", "bg-[#ed9667]"],
  ["Fat", "43", "50", "86%", "bg-[#f4c3a7]"],
];

export default function WarmLedger() {
  const [water, setWater] = useState(4);
  const [checkedIn, setCheckedIn] = useState(false);
  const [dateOffset, setDateOffset] = useState(0);
  const date = dateOffset === 0 ? "Saturday, August 22, 2026" : dateOffset === -1 ? "Friday, August 21, 2026" : "Sunday, August 23, 2026";

  return (
    <main className="relative mx-auto h-[844px] w-full max-w-[390px] overflow-hidden bg-[#faf6ef] font-['Inter'] text-[#38261f]">
      <div className="h-full overflow-y-auto pb-[86px]">
        <section className="relative h-[288px] overflow-hidden">
          <img alt="Fresh composed meal on a sunlit table" src="/__mockup/images/home-hero.jpg" className="absolute inset-0 h-full w-full object-cover object-center" />
          <div className="absolute inset-0 bg-gradient-to-b from-[#fffaf4]/95 via-[#fff9f0]/70 to-[#faf6ef]/20" />
          <div className="relative px-5 pt-7">
            <header className="flex items-center justify-between">
              <span className="font-['Playfair_Display'] text-[27px] font-bold tracking-[0.17em] text-[#3a251d]">THINNR</span>
              <div className="flex items-center gap-2">
                <button aria-label="Message your coach" className="grid size-9 place-items-center rounded-xl border border-[#d8bba8] bg-[#fffaf4]/90 text-[#a74d29] transition active:scale-95"><MessageCircle size={17} /></button>
                <button aria-label="Open profile" className="grid size-9 place-items-center rounded-full bg-[#e8763a] text-[11px] font-bold text-[#fffaf4] transition active:scale-95">ES</button>
              </div>
            </header>
            <div className="mt-5 flex items-center gap-2 text-[#5b3930]">
              <button aria-label="Previous day" onClick={() => setDateOffset(-1)} className="grid size-7 place-items-center rounded-lg transition hover:bg-[#fff8ef]"><ArrowLeft size={16} /></button>
              <span className="flex-1 text-center text-[11px] font-semibold tracking-[0.01em]">{date}</span>
              <button aria-label="Next day" onClick={() => setDateOffset(1)} className="grid size-7 place-items-center rounded-lg transition hover:bg-[#fff8ef]"><ArrowRight size={16} /></button>
            </div>
            <h1 className="mt-2 font-['Playfair_Display'] text-[27px] font-semibold leading-none tracking-[-0.02em] text-[#3a251d]">Welcome back, Emma.</h1>
            <div className="mt-4 flex gap-2">
              <button className="flex h-10 flex-1 items-center gap-1.5 rounded-xl border border-[#d6baa8] bg-[#fffaf5]/90 px-2.5 text-left text-[11px] font-semibold text-[#604036] shadow-[0_4px_12px_rgba(104,59,37,.10)]"><UtensilsCrossed size={14} className="shrink-0 text-[#e8763a]" /><span className="flex-1">Restaurant guide</span><ChevronRight size={13} /></button>
              <button className="flex h-10 flex-1 items-center gap-1.5 rounded-xl border border-[#d6baa8] bg-[#fffaf5]/90 px-2.5 text-left text-[11px] font-semibold text-[#604036] shadow-[0_4px_12px_rgba(104,59,37,.10)]"><BookOpen size={14} className="shrink-0 text-[#e8763a]" /><span className="flex-1">Approved list</span><ChevronRight size={13} /></button>
            </div>
          </div>
          <button onClick={() => setCheckedIn(true)} className="absolute -bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-[#71402d] bg-[#4a2e25] px-4 py-2.5 text-[12px] font-semibold text-[#fff8f1] shadow-[0_7px_15px_rgba(70,39,27,.25)]"><span className="grid size-5 place-items-center rounded-full bg-[#e8763a]"><MessageCircle size={11} /></span>{checkedIn ? "Check-in complete" : "Getting enough sleep?"}<ChevronRight size={13} /></button>
        </section>

        <div className="space-y-3 px-4 pt-8">
          <button className="flex w-full items-center gap-3 rounded-[14px] border border-[#e5d2c3] bg-[#fffdf9] p-3.5 text-left shadow-[0_3px_10px_rgba(93,51,31,.05)]">
            <span className="grid size-9 place-items-center rounded-[10px] bg-[#fff0e6] text-[#e8763a]"><BookOpen size={16} /></span>
            <span className="min-w-0 flex-1"><span className="block text-[9px] font-bold tracking-[.14em] text-[#987b70]">PROGRAM INSTRUCTIONS</span><span className="mt-0.5 block truncate text-[12px] font-semibold text-[#55362c]">Day 94 - Metabolic Normalization Phase</span></span><ChevronRight size={17} className="text-[#9f8275]" />
          </button>

          <article className="rounded-[14px] border border-[#e5d2c3] bg-[#fffdf9] p-4 shadow-[0_3px_10px_rgba(93,51,31,.05)]">
            <p className="text-[9px] font-bold tracking-[.15em] text-[#987b70]">CALORIES REMAINING</p>
            <div className="mt-2 flex items-end justify-between">
              <strong className="font-['Inter'] text-[42px] font-semibold leading-none tracking-[-.08em] text-[#3d2922]">568</strong>
              <div className="mb-1 flex items-center gap-3 text-right"><div><b className="block text-[14px] font-semibold text-[#51352c]">1,500</b><span className="text-[8px] font-bold tracking-[.12em] text-[#a1887b]">GOAL</span></div><span className="mb-2 text-[#b09a8e]">−</span><div><b className="block text-[14px] font-semibold text-[#51352c]">932</b><span className="text-[8px] font-bold tracking-[.12em] text-[#a1887b]">FOOD</span></div></div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#f5e5d9]"><div className="h-full w-[62%] rounded-full bg-[#e8763a]" /></div>
            <p className="mt-2 text-[11px] text-[#92776b]">568 cal left for dinner and snacks.</p>
          </article>

          <article className="rounded-[14px] border border-[#e5d2c3] bg-[#fffdf9] p-4 shadow-[0_3px_10px_rgba(93,51,31,.05)]">
            <p className="text-[9px] font-bold tracking-[.15em] text-[#987b70]">MACROS</p>
            <div className="mt-3 space-y-3">
              {macros.map(([name, value, target, percent, color]) => <div key={name}><div className="mb-1 flex justify-between text-[11px]"><span className="font-bold tracking-[.08em] text-[#876b5e]">{name.toUpperCase()}</span><span className="font-semibold text-[#56372d]">{value}<span className="font-normal text-[#a1887b]"> of {target} g</span> <span className="ml-1 text-[#d16031]">{percent}</span></span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#f6e7dd]"><div className={`h-full rounded-full ${color}`} style={{ width: percent }} /></div></div>)}
            </div>
          </article>

          <Section title="Meals">
            <div className="rounded-[14px] border border-[#e5d2c3] bg-[#fffdf9] shadow-[0_3px_10px_rgba(93,51,31,.05)]">{meals.map(([title, meta], i) => <div key={title} className={`flex items-center justify-between px-4 py-3 ${i ? "border-t border-[#f0e3d9]" : ""}`}><div><p className="font-['Playfair_Display'] text-[18px] font-medium text-[#432b23]">{title}</p><p className="text-[11px] text-[#9b8074]">{meta}</p></div><button className="flex items-center gap-1 rounded-full border border-[#e8763a] px-3 py-1.5 text-[11px] font-bold text-[#d96632] transition active:scale-95"><Plus size={13} />Add</button></div>)}</div>
          </Section>

          <Section title="Water">
            <article className="rounded-[14px] border border-[#e5d2c3] bg-[#fffdf9] p-4 shadow-[0_3px_10px_rgba(93,51,31,.05)]">
              <div className="flex gap-1.5">{Array.from({ length: 8 }).map((_, i) => <button key={i} onClick={() => setWater(i + 1)} aria-label={`${i + 1} cups`} className={`h-8 flex-1 rounded-md border ${i < water ? "border-[#e8763a] bg-[#e8763a]" : "border-[#e4ccbc] bg-[#fff9f4]"}`}><span className={`mx-auto block h-3.5 w-2 rounded-b-md border-b ${i < water ? "border-[#fff6ee] bg-[#fff2e8]" : "border-[#d4ad96] bg-[#f9e6da]"}`} /></button>)}</div>
              <div className="mt-3 flex items-center justify-between"><p className="text-[12px] font-semibold text-[#56372d]">{water * 8}<span className="font-normal text-[#9b8074]"> of 64 fl oz</span></p><div className="flex gap-2"><button onClick={() => setWater(Math.max(0, water - 1))} className="grid size-7 place-items-center rounded-lg border border-[#e2cbbc] text-[#8d6f61]"><Minus size={14} /></button><button onClick={() => setWater(Math.min(8, water + 1))} className="grid size-7 place-items-center rounded-lg border border-[#e2cbbc] text-[#8d6f61]"><Plus size={14} /></button></div></div>
            </article>
          </Section>

          <Section title="Daily Check-In">
            <article className="rounded-[14px] border border-[#e5d2c3] bg-[#fffdf9] p-4 shadow-[0_3px_10px_rgba(93,51,31,.05)]">
              <h2 className="font-['Playfair_Display'] text-[19px] font-medium text-[#432b23]">{checkedIn ? "Your check-in is complete" : "You haven't checked in today"}</h2>
              <p className="mt-1 text-[11px] leading-4 text-[#92776b]">{checkedIn ? "Your care team has today's update." : "Log your weight, mood, and how the plan feels. It takes 30 seconds."}</p>
              <button onClick={() => setCheckedIn(true)} className="mt-3 w-full rounded-xl bg-[#e8763a] py-2.5 text-[12px] font-bold text-[#fff9f4] transition active:scale-[.98]">{checkedIn ? "View Check-In" : "Complete Check-In"}</button>
            </article>
          </Section>

          <Section title="Weight">
            <article className="rounded-[14px] border border-[#e5d2c3] bg-[#fffdf9] p-4 shadow-[0_3px_10px_rgba(93,51,31,.05)]"><div className="grid grid-cols-3 divide-x divide-[#f0e3d9]"><Metric value="167.2" label="CURRENT LBS" /><Metric value="-12.8" label="SINCE START" orange /><Metric value="150" label="GOAL LBS" /></div><button className="mt-4 flex items-center gap-1 text-[11px] font-bold text-[#d76633]">View full progress <ArrowRight size={13} /></button></article>
          </Section>
          <p className="border-t border-[#e7d6ca] bg-[#f4e9df] py-3 text-center text-[8px] font-bold tracking-[.15em] text-[#9a7d6e]">SYNTHETIC DEMO DATA&nbsp;&nbsp;•&nbsp;&nbsp;NOT MEDICAL ADVICE</p>
        </div>
      </div>
      <nav className="absolute inset-x-0 bottom-0 flex h-[76px] items-start justify-around border-t border-[#e3cdbd] bg-[#fffaf5]/95 px-2 pt-3 backdrop-blur">
        <Tab icon={<Sun size={18} />} label="Today" active /><Tab icon={<BookOpen size={18} />} label="Diary" /><Tab icon={<Grid2X2 size={18} />} label="Library" /><Tab icon={<TrendingDown size={18} />} label="Progress" /><Tab icon={<Clipboard size={18} />} label="Plan" />
      </nav>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section><p className="mb-2 pl-0.5 text-[9px] font-bold tracking-[.15em] text-[#987b70]">{title.toUpperCase()}</p>{children}</section>;
}

function Metric({ value, label, orange = false }: { value: string; label: string; orange?: boolean }) {
  return <div className="px-2 first:pl-0 last:pr-0"><p className={`text-[19px] font-semibold tracking-[-.05em] ${orange ? "text-[#df6f37]" : "text-[#50342a]"}`}>{value}</p><p className="mt-1 text-[8px] font-bold tracking-[.11em] text-[#9d8275]">{label}</p></div>;
}

function Tab({ icon, label, active = false }: { icon: ReactNode; label: string; active?: boolean }) {
  return <button className={`flex w-[57px] flex-col items-center gap-1 text-[9px] font-semibold ${active ? "text-[#df6f37]" : "text-[#a48b7d]"}`}>{icon}<span>{label}</span></button>;
}