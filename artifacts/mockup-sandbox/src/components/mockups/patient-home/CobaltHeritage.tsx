import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  ClipboardList,
  Droplets,
  Grid2X2,
  MessageCircle,
  Plus,
  Sparkles,
  Sun,
  TrendingDown,
  Utensils,
} from 'lucide-react';

const meals = [
  ['Breakfast', '322 cal'],
  ['Lunch', '420 cal'],
  ['Dinner', 'Nothing logged yet'],
  ['Snacks', '190 cal'],
] as const;

const macros = [
  ['Protein', '73 of 120 g', '61%', 'w-[61%]', 'bg-[#315fc0]'],
  ['Carbs', '70 of 130 g', '54%', 'w-[54%]', 'bg-[#6d8dce]'],
  ['Fat', '43 of 50 g', '86%', 'w-[86%]', 'bg-[#a5b6d9]'],
] as const;

const tabs = [
  [Sun, 'Today'],
  [BookOpen, 'Diary'],
  [Grid2X2, 'Library'],
  [TrendingDown, 'Progress'],
  [ClipboardList, 'Plan'],
] as const;

export function CobaltHeritage() {
  return (
    <main className="relative mx-auto min-h-[844px] w-full max-w-[390px] overflow-hidden bg-[#eef3fa] font-['Inter'] text-[#172c56]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[296px] bg-[linear-gradient(165deg,#dce8fa_0%,#edf3fb_55%,#eef3fa_100%)]" />
      <div className="relative px-5 pb-[94px] pt-6">
        <header>
          <div className="flex items-center justify-between">
            <div className="font-['Playfair_Display'] text-[24px] font-bold tracking-[.17em] text-[#172c56]">THINNR</div>
            <div className="flex gap-2">
              <button aria-label="Message your coach" className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#c9d7ec] bg-[#f9fbff] text-[#315fc0] shadow-[0_4px_11px_rgba(23,44,86,.07)]">
                <MessageCircle size={17} strokeWidth={1.8} />
              </button>
              <button aria-label="Your profile" className="grid h-9 w-9 place-items-center rounded-[10px] bg-[#315fc0] text-[10px] font-bold tracking-wide text-[#f9fbff] shadow-[0_5px_12px_rgba(49,95,192,.20)]">ES</button>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <button aria-label="Previous day" className="p-1 text-[#55709b]"><ArrowLeft size={17} /></button>
            <div className="border-x-2 border-[#315fc0] px-3 py-1 text-center text-[10px] font-bold uppercase tracking-[.08em] text-[#284675]">Saturday, August 22, 2026</div>
            <button aria-label="Next day" className="p-1 text-[#55709b]"><ArrowRight size={17} /></button>
          </div>
          <h1 className="mt-3 font-['Playfair_Display'] text-[28px] leading-none tracking-[-.025em] text-[#172c56]">Welcome back, Emma</h1>

          <button className="mt-4 flex w-full items-center gap-3 rounded-[12px] border border-[#b9cdeb] bg-[#dce9fb] px-4 py-3 text-left shadow-[0_8px_18px_rgba(32,68,122,.08)]">
            <span className="grid h-7 w-7 place-items-center rounded-[7px] bg-[#315fc0] text-white"><Sparkles size={14} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[9px] font-bold tracking-[.14em] text-[#52719e]">TODAY&apos;S FOCUS</span>
              <span className="mt-0.5 block font-['Playfair_Display'] text-[18px] text-[#172c56]">Getting enough sleep?</span>
            </span>
            <ChevronRight size={18} className="text-[#315fc0]" />
          </button>

          <div className="mt-3 flex gap-2">
            <button className="flex flex-1 items-center justify-center gap-1.5 rounded-[9px] border border-[#cdd9ea] bg-[#f9fbff] py-2 text-[11px] font-semibold text-[#284675]"><Utensils size={13} className="text-[#315fc0]" />Restaurant guide</button>
            <button className="flex flex-1 items-center justify-center gap-1.5 rounded-[9px] border border-[#cdd9ea] bg-[#f9fbff] py-2 text-[11px] font-semibold text-[#284675]"><Sun size={13} className="text-[#315fc0]" />Approved list</button>
          </div>
        </header>

        <section className="mt-5 overflow-hidden rounded-[14px] border border-[#cdd9ea] bg-[#f9fbff] shadow-[0_8px_22px_rgba(23,44,86,.07)]">
          <div className="h-1 bg-[#315fc0]" />
          <div className="px-4 pb-3 pt-3">
            <div className="flex items-center justify-between">
              <h2 className="font-['Playfair_Display'] text-[19px] text-[#172c56]">Your week at a glance</h2>
              <span className="bg-[#e5effd] px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-[#315fc0]">7 of 7 logged</span>
            </div>
            <div className="mt-3 flex items-center justify-between border-y border-[#e2e9f3] py-2.5">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                <div key={`${day}-${index}`} className="flex flex-col items-center gap-1">
                  <span className="text-[9px] font-semibold text-[#798aa5]">{day}</span>
                  <span className={`h-2 w-2 ${index === 6 ? 'bg-[#e8763a] ring-4 ring-[#fff0e5]' : 'bg-[#315fc0]'}`} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <button className="mt-4 flex w-full items-center gap-3 rounded-[12px] border border-[#cdd9ea] bg-[#f9fbff] px-4 py-3 text-left shadow-[0_6px_17px_rgba(23,44,86,.05)]">
          <span className="grid h-9 w-9 place-items-center rounded-[8px] bg-[#e3edfc] text-[#315fc0]"><BookOpen size={16} /></span>
          <span className="min-w-0 flex-1"><span className="block text-[9px] font-bold tracking-[.14em] text-[#7488a6]">PROGRAM STATUS</span><span className="mt-0.5 block truncate text-[12px] font-semibold text-[#284675]">Day 94 · Metabolic Normalization Phase</span></span>
          <ChevronRight size={17} className="text-[#8798b0]" />
        </button>

        <section className="mt-4 rounded-[14px] border border-[#cdd9ea] bg-[#f9fbff] px-4 pb-4 pt-4 shadow-[0_8px_22px_rgba(23,44,86,.07)]">
          <div className="flex items-start justify-between"><div><p className="text-[9px] font-bold tracking-[.14em] text-[#7488a6]">CALORIES FOR TODAY</p><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#172c56]">A well-paced day.</h2></div><span className="border-l-2 border-[#e8763a] pl-2 text-[10px] font-bold text-[#b85825]">62% consumed</span></div>
          <div className="mx-auto mt-3 flex h-[137px] w-[238px] items-end justify-center overflow-hidden">
            <div className="relative h-[238px] w-[238px] rounded-full border-[21px] border-[#dce4f0] border-b-[#e8763a] border-l-[#e8763a] -rotate-[45deg]">
              <div className="absolute inset-[18px] rotate-[45deg] text-center"><p className="mt-[57px] font-['Playfair_Display'] text-[45px] leading-none text-[#172c56]">568</p><p className="mt-1 text-[9px] font-bold uppercase tracking-[.15em] text-[#7488a6]">remaining</p></div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 divide-x divide-[#dfe7f1] text-center"><div><b className="block text-[16px] text-[#284675]">1,500</b><span className="text-[8px] font-bold tracking-[.12em] text-[#8090a8]">GOAL</span></div><div><b className="block text-[16px] text-[#284675]">932</b><span className="text-[8px] font-bold tracking-[.12em] text-[#8090a8]">FOOD</span></div><div><b className="block text-[16px] text-[#e8763a]">568</b><span className="text-[8px] font-bold tracking-[.12em] text-[#8090a8]">LEFT</span></div></div>
          <p className="mt-3 text-center text-[11px] text-[#74839d]">568 cal left for dinner and snacks.</p>
          <div className="mt-4 space-y-3 border-t border-[#e2e9f3] pt-3">
            {macros.map(([name, value, percent, width, color]) => <div key={name}><div className="mb-1 flex justify-between text-[10px]"><span className="font-bold text-[#284675]">{name}</span><span className="text-[#74839d]">{value} <b className="text-[#315fc0]">{percent}</b></span></div><div className="h-1.5 overflow-hidden bg-[#e1e8f2]"><div className={`h-full ${width} ${color}`} /></div></div>)}
          </div>
        </section>

        <section className="mt-5"><h2 className="mb-2 ml-1 font-['Playfair_Display'] text-[20px] text-[#172c56]">Meals</h2><div className="overflow-hidden rounded-[13px] border border-[#cdd9ea] bg-[#f9fbff] shadow-[0_6px_17px_rgba(23,44,86,.05)]">{meals.map(([name, detail], index) => <div key={name} className={`flex items-center justify-between px-4 py-3 ${index ? 'border-t border-[#e2e9f3]' : ''}`}><div><p className="font-['Playfair_Display'] text-[16px] text-[#284675]">{name}</p><p className="text-[11px] text-[#7c8da6]">{detail}</p></div><button className="flex items-center gap-1 rounded-[7px] border border-[#b9cceb] bg-[#f7faff] px-2.5 py-1.5 text-[10px] font-bold text-[#315fc0]"><Plus size={13} />Add</button></div>)}</div></section>

        <section className="mt-5 rounded-[13px] border border-[#cdd9ea] bg-[#f9fbff] p-4 shadow-[0_6px_17px_rgba(23,44,86,.05)]"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-[7px] bg-[#e3edfc] text-[#315fc0]"><Droplets size={16} /></span><div><h2 className="font-['Playfair_Display'] text-[18px] text-[#172c56]">Water</h2><p className="text-[10px] text-[#74839d]">32 of 64 fl oz · 4 of 8 cups</p></div></div><span className="text-[11px] font-bold text-[#315fc0]">4 / 8</span></div><div className="mt-3 grid grid-cols-8 gap-1.5">{Array.from({ length: 8 }, (_, index) => <span key={index} className={`h-5 border ${index < 4 ? 'border-[#315fc0] bg-[#315fc0]' : 'border-[#cfdaea] bg-[#eff4fa]'}`} />)}</div></section>

        <section className="mt-5 rounded-[13px] border border-[#cdd9ea] bg-[#f9fbff] p-4 shadow-[0_6px_17px_rgba(23,44,86,.05)]"><p className="text-[9px] font-bold tracking-[.14em] text-[#7488a6]">DAILY CHECK-IN</p><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#172c56]">You haven&apos;t checked in today</h2><p className="mt-1 text-[12px] leading-5 text-[#74839d]">Log your weight, mood, and how the plan feels. It takes 30 seconds.</p><button className="mt-3 w-full rounded-[8px] bg-[#e8763a] py-3 text-[12px] font-bold text-white shadow-[0_6px_12px_rgba(190,88,37,.20)]">Complete Check-In</button></section>

        <section className="mt-5 rounded-[13px] border border-[#cdd9ea] bg-[#f9fbff] p-4 shadow-[0_6px_17px_rgba(23,44,86,.05)]"><div className="flex items-end justify-between"><h2 className="font-['Playfair_Display'] text-[20px] text-[#172c56]">Weight snapshot</h2><button className="text-[10px] font-bold text-[#315fc0]">View full progress</button></div><div className="mt-4 grid grid-cols-3 divide-x divide-[#dfe7f1] text-center"><div><b className="block text-[19px] text-[#284675]">167.2</b><span className="text-[8px] font-bold tracking-[.1em] text-[#8090a8]">CURRENT LBS</span></div><div><b className="block text-[19px] text-[#315fc0]">-12.8</b><span className="text-[8px] font-bold tracking-[.1em] text-[#8090a8]">DOWN TOTAL</span></div><div><b className="block text-[19px] text-[#284675]">150</b><span className="text-[8px] font-bold tracking-[.1em] text-[#8090a8]">GOAL LBS</span></div></div></section>
        <p className="mt-6 text-center text-[8px] font-bold tracking-[.13em] text-[#71839f]">SYNTHETIC DEMO DATA&nbsp; • &nbsp;NOT MEDICAL ADVICE</p>
      </div>
      <nav className="sticky bottom-0 z-10 flex h-[70px] items-center justify-around border-t border-[#cad7e9] bg-[#f9fbff]/95 px-2 backdrop-blur">
        {tabs.map(([Icon, label]) => { const active = label === 'Today'; return <button key={label} className={`flex min-w-[54px] flex-col items-center gap-1 text-[9px] font-semibold ${active ? 'text-[#315fc0]' : 'text-[#8292aa]'}`}><Icon size={18} strokeWidth={active ? 2.4 : 1.8} /><span>{label}</span>{active && <i className="-mt-0.5 h-1 w-4 bg-[#e8763a]" />}</button>; })}
      </nav>
    </main>
  );
}