import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  ClipboardList,
  Grid2X2,
  MessageCircle,
  Minus,
  Plus,
  Sun,
  TrendingDown,
  Utensils,
} from "lucide-react";

const navy = "#172c56";
const cobalt = "#315fc0";
const paper = "#eef1f6";
const card = "#fbfcff";
const line = "#dfe5ef";
const muted = "#74839d";
const orange = "#e8763a";

function IconButton({
  children,
  onClick,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      aria-label="Action"
      onClick={onClick}
      className={`grid h-8 w-8 place-items-center rounded-[10px] border border-[#d8e0ec] bg-[#fbfcff]/90 text-[#284675] shadow-[0_3px_10px_rgba(23,44,86,.08)] transition active:scale-95 ${className}`}
    >
      {children}
    </button>
  );
}

export default function CobaltThaw() {
  const [water, setWater] = useState(4);
  const [checkedIn, setCheckedIn] = useState(false);
  const [dayOffset, setDayOffset] = useState(0);
  const date =
    dayOffset === 0
      ? "Saturday, August 22, 2026"
      : dayOffset < 0
        ? "Friday, August 21, 2026"
        : "Sunday, August 23, 2026";
  const meals = [
    ["Breakfast", "2 items · 322 cal"],
    ["Lunch", "1 item · 420 cal"],
    ["Dinner", "Nothing logged yet"],
    ["Snacks", "1 item · 190 cal"],
  ];

  return (
    <main
      className="relative mx-auto min-h-[844px] w-full max-w-[390px] overflow-x-hidden bg-[#eef1f6] font-['Inter'] text-[#172c56]"
      style={{ backgroundColor: paper }}
    >
      <section className="relative h-[329px] overflow-hidden">
        <img
          src="/__mockup/images/home-hero.jpg"
          alt="A colorful prepared meal"
          className="absolute inset-0 h-full w-full scale-[1.05] object-cover object-center"
        />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,242,226,.84)_0%,rgba(246,234,222,.52)_38%,rgba(238,241,246,.08)_74%,#eef1f6_100%)]" />
        <div className="relative z-10 px-5 pt-7">
          <div className="flex items-center justify-between">
            <div
              className="font-['Playfair_Display'] text-[25px] font-bold tracking-[.18em]"
              style={{ color: navy }}
            >
              THINNR
            </div>
            <div className="flex items-center gap-2">
              <IconButton><MessageCircle size={16} strokeWidth={1.8} /></IconButton>
              <button
                aria-label="Emma's profile"
                className="grid h-8 w-8 place-items-center rounded-[10px] bg-[#315fc0] text-[10px] font-bold tracking-wide text-white shadow-[0_4px_12px_rgba(49,95,192,.22)] transition active:scale-95"
              >
                ES
              </button>
            </div>
          </div>

          <div className="mt-7 flex items-center gap-2">
            <button aria-label="Previous day" onClick={() => setDayOffset(-1)} className="p-1 text-[#284675]"><ArrowLeft size={17} /></button>
            <p className="flex-1 text-center text-[12px] font-semibold tracking-[.01em] text-[#284675]">{date}</p>
            <button aria-label="Next day" onClick={() => setDayOffset(1)} className="p-1 text-[#284675]"><ArrowRight size={17} /></button>
          </div>
          <h1 className="mt-2 font-['Playfair_Display'] text-[28px] font-semibold leading-tight tracking-[-.035em]" style={{ color: navy }}>
            Welcome back, Emma.
          </h1>
          <div className="mt-4 flex gap-2">
            <button className="flex h-10 flex-1 items-center gap-2 rounded-[10px] border border-[#d6ddeb] bg-[#fbfcff]/90 px-3 text-left text-[11px] font-semibold text-[#284675] shadow-[0_4px_12px_rgba(23,44,86,.09)]">
              <Utensils size={14} /><span className="flex-1">Restaurant guide</span><ChevronRight size={13} />
            </button>
            <button className="flex h-10 flex-1 items-center gap-2 rounded-[10px] border border-[#d6ddeb] bg-[#fbfcff]/90 px-3 text-left text-[11px] font-semibold text-[#284675] shadow-[0_4px_12px_rgba(23,44,86,.09)]">
              <BookOpen size={14} /><span className="flex-1">Approved list</span><ChevronRight size={13} />
            </button>
          </div>
        </div>
        {!checkedIn && (
          <button
            onClick={() => setCheckedIn(true)}
            className="absolute bottom-[-18px] left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-[#e8763a] bg-[#e8763a] px-4 py-2.5 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(144,68,39,.25)]"
          >
            <span className="grid h-5 w-5 place-items-center rounded-full bg-white/20"><MessageCircle size={12} /></span>
            Getting enough sleep?<ChevronRight size={14} />
          </button>
        )}
      </section>

      <div className="space-y-3.5 px-4 pb-[90px] pt-7">
        <button className="flex w-full items-center gap-3 rounded-[10px] border border-[#dfe5ef] bg-[#fbfcff] p-4 text-left shadow-[0_5px_16px_rgba(23,44,86,.055)]">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[#e8eef9] text-[#315fc0]"><BookOpen size={16} /></span>
          <span className="flex-1">
            <span className="block text-[9px] font-bold tracking-[.15em]" style={{ color: muted }}>PROGRAM INSTRUCTIONS</span>
            <span className="mt-1 block text-[13px] font-semibold text-[#284675]">Day 94 - Metabolic Normalization Phase</span>
          </span>
          <ChevronRight size={17} className="text-[#8793a8]" />
        </button>

        <section className="rounded-[10px] border border-[#dfe5ef] bg-[#fbfcff] p-[17px] shadow-[0_5px_16px_rgba(23,44,86,.055)]">
          <p className="text-[9px] font-bold tracking-[.15em]" style={{ color: muted }}>CALORIES REMAINING</p>
          <div className="mt-1.5 flex items-end justify-between">
            <p className="text-[42px] font-semibold leading-none tracking-[-.07em]" style={{ color: navy }}>568</p>
            <div className="mb-1 flex items-center gap-2 text-right">
              <div><b className="block text-[14px] text-[#284675]">1,500</b><span className="text-[8px] font-bold tracking-[.1em]" style={{ color: muted }}>GOAL</span></div>
              <span className="pb-2 text-[#8793a8]">−</span>
              <div><b className="block text-[14px] text-[#284675]">932</b><span className="text-[8px] font-bold tracking-[.1em]" style={{ color: muted }}>FOOD</span></div>
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#e3e8f1]"><div className="h-full w-[62%] rounded-full bg-[#315fc0]" /></div>
          <p className="mt-2 text-[11px] leading-relaxed text-[#74839d]">568 cal left for dinner and snacks.</p>
        </section>

        <section className="rounded-[10px] border border-[#dfe5ef] bg-[#fbfcff] p-[17px] shadow-[0_5px_16px_rgba(23,44,86,.055)]">
          <p className="text-[9px] font-bold tracking-[.15em]" style={{ color: muted }}>MACROS</p>
          <div className="mt-3.5 space-y-3">
            {[["Protein", "73 of 120 g", "61%", "61%", "#315fc0"], ["Carbs", "70 of 130 g", "54%", "54%", "#5576c2"], ["Fat", "43 of 50 g", "86%", "86%", "#8da4d6"]].map(([label, value, percent, width, color]) => (
              <div key={label}>
                <div className="mb-1.5 flex justify-between text-[11px]"><span className="font-semibold text-[#284675]">{label}</span><span className="text-[#74839d]">{value} <b className="text-[#284675]">{percent}</b></span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#e3e8f1]"><div className="h-full rounded-full" style={{ width, backgroundColor: color }} /></div>
              </div>
            ))}
          </div>
        </section>

        <p className="px-1 pt-1 text-[10px] font-bold tracking-[.15em]" style={{ color: muted }}>MEALS</p>
        <section className="overflow-hidden rounded-[10px] border border-[#dfe5ef] bg-[#fbfcff] shadow-[0_5px_16px_rgba(23,44,86,.055)]">
          {meals.map(([name, detail], index) => (
            <div key={name} className={`flex items-center justify-between px-4 py-3.5 ${index ? "border-t border-[#dfe5ef]" : ""}`}>
              <div><p className="text-[13px] font-semibold text-[#284675]">{name}</p><p className="mt-0.5 text-[11px] text-[#8793a8]">{detail}</p></div>
              <button className="flex items-center gap-1 rounded-[10px] border border-[#cbd7e9] bg-[#f9fbff] px-2.5 py-1.5 text-[11px] font-semibold text-[#315fc0]"><Plus size={13} />Add</button>
            </div>
          ))}
        </section>

        <p className="px-1 pt-1 text-[10px] font-bold tracking-[.15em]" style={{ color: muted }}>WATER</p>
        <section className="rounded-[10px] border border-[#dfe5ef] bg-[#fbfcff] p-4 shadow-[0_5px_16px_rgba(23,44,86,.055)]">
          <div className="flex gap-1.5">{Array.from({ length: 8 }, (_, i) => <button key={i} onClick={() => setWater(i + 1)} aria-label={`${i + 1} cups`} className={`h-8 flex-1 rounded-[8px] border ${i < water ? "border-[#315fc0] bg-[#315fc0]" : "border-[#d6dfed] bg-[#f4f6fa]"}`}><span className={`mx-auto block h-3 w-2 rounded-b-full border ${i < water ? "border-white bg-white/30" : "border-[#8da4d6]"}`} /></button>)}</div>
          <div className="mt-3 flex items-center justify-between"><p className="text-[12px] font-semibold text-[#284675]">{water * 8} <span className="font-normal text-[#8793a8]">of 64 fl oz</span></p><div className="flex gap-1.5"><IconButton onClick={() => setWater(Math.max(0, water - 1))}><Minus size={14} /></IconButton><IconButton onClick={() => setWater(Math.min(8, water + 1))}><Plus size={14} /></IconButton></div></div>
        </section>

        <p className="px-1 pt-1 text-[10px] font-bold tracking-[.15em]" style={{ color: muted }}>DAILY CHECK-IN</p>
        <section className="rounded-[10px] border border-[#dfe5ef] bg-[#fbfcff] p-[17px] shadow-[0_5px_16px_rgba(23,44,86,.055)]">
          <h2 className="font-['Playfair_Display'] text-[20px] font-semibold text-[#172c56]">{checkedIn ? "Today's check-in is complete" : "You haven't checked in today"}</h2>
          <p className="mt-1.5 text-[12px] leading-[1.55] text-[#74839d]">{checkedIn ? "Thanks for sharing how the plan feels today." : "Log your weight, mood, and how the plan feels. It takes 30 seconds."}</p>
          {!checkedIn && <button onClick={() => setCheckedIn(true)} className="mt-4 w-full rounded-[10px] bg-[#e8763a] py-3 text-[12px] font-bold text-white shadow-[0_6px_14px_rgba(144,68,39,.2)]">Complete Check-In</button>}
        </section>

        <p className="px-1 pt-1 text-[10px] font-bold tracking-[.15em]" style={{ color: muted }}>WEIGHT</p>
        <section className="rounded-[10px] border border-[#dfe5ef] bg-[#fbfcff] p-[17px] shadow-[0_5px_16px_rgba(23,44,86,.055)]">
          <div className="grid grid-cols-3 divide-x divide-[#dfe5ef]"><div><b className="block text-[23px] tracking-[-.05em]">167.2</b><span className="text-[8px] font-bold tracking-[.11em]" style={{ color: muted }}>CURRENT LBS</span></div><div className="pl-3"><b className="block text-[23px] tracking-[-.05em] text-[#315fc0]">-12.8</b><span className="text-[8px] font-bold tracking-[.11em]" style={{ color: muted }}>SINCE START</span></div><div className="pl-3"><b className="block text-[23px] tracking-[-.05em] text-[#284675]">150</b><span className="text-[8px] font-bold tracking-[.11em]" style={{ color: muted }}>GOAL LBS</span></div></div>
          <button className="mt-4 flex items-center gap-1 text-[12px] font-semibold text-[#315fc0]">View full progress <ArrowRight size={13} /></button>
        </section>
        <div className="border-t border-[#dfe5ef] bg-[#e3e8f1] py-3 text-center text-[8px] font-bold tracking-[.14em] text-[#74839d]">SYNTHETIC DEMO DATA&nbsp;&nbsp;•&nbsp;&nbsp;NOT MEDICAL ADVICE</div>
      </div>

      <nav className="sticky bottom-0 z-30 flex h-[72px] items-center justify-around border-t border-[#d5deeb] bg-[#fbfcff]/95 px-2 backdrop-blur">
        {[
          { Icon: Sun, label: "Today" },
          { Icon: BookOpen, label: "Diary" },
          { Icon: Grid2X2, label: "Library" },
          { Icon: TrendingDown, label: "Progress" },
          { Icon: ClipboardList, label: "Plan" },
        ].map(({ Icon, label }) => {
          const active = label === "Today";
          const TabIcon = Icon as typeof Sun;
          return <button key={label} className={`flex min-w-[50px] flex-col items-center gap-1 text-[9px] font-semibold ${active ? "text-[#315fc0]" : "text-[#8793a8]"}`}><TabIcon size={19} strokeWidth={active ? 2.4 : 1.8} /><span>{label}</span></button>;
        })}
      </nav>
    </main>
  );
}