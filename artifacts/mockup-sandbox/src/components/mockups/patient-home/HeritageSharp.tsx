import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  ClipboardList,
  Droplets,
  Grid2X2,
  MessageCircle,
  Minus,
  Plus,
  Sparkles,
  Sun,
  TrendingDown,
  Utensils,
} from 'lucide-react';

const meals = [
  ['Breakfast', '2 items · 322 cal'],
  ['Lunch', '1 item · 420 cal'],
  ['Dinner', 'Nothing logged yet'],
  ['Snacks', '1 item · 190 cal'],
] as const;

const tabs = [
  [Sun, 'Today'],
  [BookOpen, 'Diary'],
  [Grid2X2, 'Library'],
  [TrendingDown, 'Progress'],
  [ClipboardList, 'Plan'],
] as const;

const macros = [
  ['Protein', '73 of 120 g', '61%', '61%', '#2458c4'],
  ['Carbs', '70 of 130 g', '54%', '54%', '#587dc6'],
  ['Fat', '43 of 50 g', '86%', '86%', '#d87836'],
] as const;

export function HeritageSharp() {
  return (
    <main className="relative mx-auto min-h-screen w-full max-w-[390px] overflow-x-hidden bg-[#f1f4f8] font-['Inter'] text-[#162d59]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[300px] bg-[linear-gradient(180deg,#e5edf8_0%,#f1f4f8_88%)]" />
      <div className="relative px-4 pb-[88px] pt-6">
        <header>
          <div className="flex items-center justify-between">
            <div className="font-['Playfair_Display'] text-[24px] font-bold tracking-[.17em] text-[#142b58]">THINNR</div>
            <div className="flex gap-2">
              <button aria-label="Message your coach" className="grid h-9 w-9 place-items-center border border-[#bfcde1] bg-[#f9fbff] text-[#2458c4]">
                <MessageCircle size={17} />
              </button>
              <button aria-label="Emma Smith profile" className="grid h-9 w-9 place-items-center bg-[#2458c4] text-[10px] font-bold text-[#f9fbff]">ES</button>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-[30px_1fr_30px] items-center">
            <button aria-label="Previous day" className="grid h-8 place-items-center text-[#2458c4]"><ArrowLeft size={18} /></button>
            <p className="border-y border-[#c5d3e6] py-1.5 text-center text-[10px] font-bold tracking-[.075em] text-[#2458c4]">SATURDAY, AUGUST 22, 2026</p>
            <button aria-label="Next day" className="grid h-8 place-items-center text-[#2458c4]"><ArrowRight size={18} /></button>
          </div>
          <h1 className="mt-4 font-['Playfair_Display'] text-[29px] leading-none text-[#142b58]">Welcome back, Emma</h1>
          <section className="mt-4 border-l-4 border-[#2458c4] bg-[#dfeaf8] px-4 py-3">
            <div className="flex items-center gap-2 text-[10px] font-bold tracking-[.12em] text-[#2458c4]"><Sparkles size={14} /> TODAY&apos;S FOCUS</div>
            <button className="mt-1 flex w-full items-center justify-between text-left font-['Playfair_Display'] text-[18px] text-[#172f5c]">
              <span>Getting enough sleep?</span><ChevronRight size={18} />
            </button>
          </section>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button className="flex h-10 items-center justify-center gap-1.5 border border-[#c5d3e6] bg-[#f9fbff] text-[11px] font-bold text-[#284675]"><Utensils size={14} className="text-[#e87533]" />Restaurant guide</button>
            <button className="flex h-10 items-center justify-center gap-1.5 border border-[#c5d3e6] bg-[#f9fbff] text-[11px] font-bold text-[#284675]"><Sun size={14} className="text-[#e87533]" />Approved list</button>
          </div>
        </header>

        <section className="mt-5 border border-[#bfcde1] bg-[#f9fbff]">
          <div className="h-1 bg-[#e87533]" />
          <div className="p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-['Playfair_Display'] text-[20px] text-[#142b58]">Your week at a glance</h2>
              <span className="bg-[#fff0e8] px-2 py-1 text-[9px] font-bold tracking-[.09em] text-[#c85e20]">7 OF 7 LOGGED</span>
            </div>
            <div className="mt-3 grid grid-cols-7 border-y border-[#dce4ee] py-2.5">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                <div key={`${day}-${index}`} className="flex flex-col items-center gap-1.5">
                  <span className="text-[9px] font-semibold text-[#72809a]">{day}</span>
                  <span className={`h-2.5 w-2.5 ${index === 6 ? 'bg-[#2458c4]' : 'bg-[#e87533]'}`} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <button className="mt-4 flex w-full items-center gap-3 border border-[#bfcde1] bg-[#f9fbff] px-4 py-3 text-left">
          <span className="grid h-9 w-9 place-items-center bg-[#dfeaf8] text-[#2458c4]"><BookOpen size={17} /></span>
          <span className="min-w-0 flex-1"><span className="block text-[9px] font-bold tracking-[.14em] text-[#71809a]">PROGRAM STATUS</span><span className="block truncate pt-0.5 text-[12px] font-semibold text-[#284675]">Day 94 · Metabolic Normalization Phase</span></span>
          <ChevronRight size={17} className="text-[#71809a]" />
        </button>

        <section className="mt-4 border border-[#bfcde1] bg-[#f9fbff] p-4">
          <div className="flex items-start justify-between">
            <div><p className="text-[9px] font-bold tracking-[.14em] text-[#71809a]">CALORIES FOR TODAY</p><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#142b58]">A well-paced day.</h2></div>
            <span className="border border-[#bfcde1] px-2 py-1 text-[10px] font-bold text-[#2458c4]">62% CONSUMED</span>
          </div>
          <div className="mx-auto mt-2 flex h-[144px] w-[250px] items-end justify-center overflow-hidden">
            <div className="relative h-[250px] w-[250px] rounded-full border-[22px] border-[#dfe5ee] border-b-[#2458c4] border-l-[#2458c4] -rotate-[45deg]">
              <div className="absolute inset-[18px] rotate-[45deg] text-center"><p className="mt-[62px] font-['Playfair_Display'] text-[47px] leading-none text-[#142b58]">568</p><p className="mt-1 text-[9px] font-bold tracking-[.15em] text-[#71809a]">REMAINING</p></div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 divide-x divide-[#dce4ee] text-center">
            <div><b className="block text-[16px] text-[#284675]">1,500</b><span className="text-[8px] font-bold tracking-[.12em] text-[#71809a]">GOAL</span></div>
            <div><b className="block text-[16px] text-[#284675]">932</b><span className="text-[8px] font-bold tracking-[.12em] text-[#71809a]">FOOD</span></div>
            <div><b className="block text-[16px] text-[#e87533]">568</b><span className="text-[8px] font-bold tracking-[.12em] text-[#71809a]">LEFT</span></div>
          </div>
          <p className="mt-3 text-center text-[11px] text-[#71809a]">568 cal left for dinner and snacks.</p>
          <div className="mt-4 space-y-3 border-t border-[#dce4ee] pt-3">
            {macros.map(([name, value, percent, width, color]) => <div key={name}><div className="mb-1 flex justify-between text-[11px]"><span className="font-bold text-[#284675]">{name}</span><span className="text-[#71809a]">{value} <b className="text-[#284675]">{percent}</b></span></div><div className="h-1.5 bg-[#e1e7f0]"><div className="h-full" style={{ width, backgroundColor: color }} /></div></div>)}
          </div>
        </section>

        <section className="mt-5"><h2 className="mb-2 font-['Playfair_Display'] text-[20px] text-[#142b58]">Meals &amp; hydration</h2>
          <div className="border border-[#bfcde1] bg-[#f9fbff]">
            {meals.map(([name, detail], index) => <div key={name} className={`flex items-center justify-between px-4 py-3 ${index ? 'border-t border-[#dce4ee]' : ''}`}><div><p className="font-['Playfair_Display'] text-[17px] text-[#1d3764]">{name}</p><p className="text-[11px] text-[#71809a]">{detail}</p></div><button className="flex items-center gap-1 border border-[#b8c9e0] px-2.5 py-1.5 text-[11px] font-bold text-[#2458c4]"><Plus size={13} />Add</button></div>)}
            <div className="border-t border-[#dce4ee] p-4"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center bg-[#dfeaf8] text-[#2458c4]"><Droplets size={16} /></span><div><p className="font-['Playfair_Display'] text-[17px]">Water</p><p className="text-[11px] text-[#71809a]">32 of 64 fl oz · 4 of 8 cups</p></div></div><div className="flex gap-1.5"><button aria-label="Remove water" className="grid h-7 w-7 place-items-center border border-[#bfcde1] text-[#284675]"><Minus size={14} /></button><button aria-label="Add water" className="grid h-7 w-7 place-items-center bg-[#2458c4] text-white"><Plus size={14} /></button></div></div><div className="mt-3 grid grid-cols-8 gap-1">{Array.from({ length: 8 }, (_, i) => <span key={i} className={`h-5 border ${i < 4 ? 'border-[#2458c4] bg-[#2458c4]' : 'border-[#cfdae9] bg-[#edf2f8]'}`} />)}</div></div>
          </div>
        </section>

        <section className="mt-5 border border-[#bfcde1] bg-[#f9fbff] p-4"><p className="text-[9px] font-bold tracking-[.14em] text-[#71809a]">DAILY CHECK-IN</p><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#142b58]">You haven&apos;t checked in today</h2><p className="mt-1 text-[12px] leading-5 text-[#71809a]">Log your weight, mood, and how the plan feels. It takes 30 seconds.</p><button className="mt-3 w-full bg-[#e87533] py-3 text-[12px] font-bold text-white">Complete Check-In</button></section>

        <section className="mt-5 border border-[#bfcde1] bg-[#f9fbff] p-4"><div className="flex items-end justify-between"><h2 className="font-['Playfair_Display'] text-[20px] text-[#142b58]">Weight snapshot</h2><button className="text-[11px] font-bold text-[#2458c4]">View full progress</button></div><div className="mt-4 grid grid-cols-3 divide-x divide-[#dce4ee] text-center"><div><b className="block text-[20px] text-[#284675]">167.2 lb</b><span className="text-[8px] font-bold tracking-[.11em] text-[#71809a]">CURRENT</span></div><div><b className="block text-[20px] text-[#2458c4]">-12.8 lb</b><span className="text-[8px] font-bold tracking-[.11em] text-[#71809a]">DOWN TOTAL</span></div><div><b className="block text-[20px] text-[#284675]">150 lb</b><span className="text-[8px] font-bold tracking-[.11em] text-[#71809a]">GOAL</span></div></div></section>
        <p className="mt-6 text-center text-[8px] font-bold tracking-[.14em] text-[#71809a]">SYNTHETIC DEMO DATA&nbsp; • &nbsp;NOT MEDICAL ADVICE</p>
      </div>
      <nav className="sticky bottom-0 z-10 flex h-[70px] items-center justify-around border-t border-[#bfcde1] bg-[#f9fbff]/95 px-2 backdrop-blur">
        {tabs.map(([Icon, label]) => <button key={label} className={`flex min-w-[54px] flex-col items-center gap-1 text-[9px] font-semibold ${label === 'Today' ? 'text-[#2458c4]' : 'text-[#71809a]'}`}><Icon size={18} strokeWidth={label === 'Today' ? 2.5 : 1.8} /><span>{label}</span>{label === 'Today' && <i className="h-0.5 w-4 bg-[#e87533]" />}</button>)}
      </nav>
    </main>
  );
}