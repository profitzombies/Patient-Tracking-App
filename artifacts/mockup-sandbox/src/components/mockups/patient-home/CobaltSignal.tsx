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

function SignalLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[9px] font-bold tracking-[0.16em] text-[#74839d]">{children}</p>;
}

export function CobaltSignal() {
  return (
    <main className="relative mx-auto min-h-[844px] w-full max-w-[390px] overflow-x-hidden bg-[#eef2f8] font-['Inter'] text-[#172c56]">
      <header className="relative h-[316px] overflow-hidden">
        <img
          src="/__mockup/images/home-hero.jpg"
          alt="A precisely plated healthy salad bowl"
          className="absolute inset-0 h-full w-full object-cover object-center"
        />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(238,242,248,.97)_0%,rgba(238,242,248,.78)_35%,rgba(238,242,248,.12)_73%,#eef2f8_100%)]" />
        <div className="relative px-5 pt-6">
          <div className="flex items-center justify-between">
            <div className="font-['Playfair_Display'] text-[24px] font-bold tracking-[0.18em] text-[#172c56]">THINNR</div>
            <div className="flex gap-2">
              <button aria-label="Message your care team" className="grid h-9 w-9 place-items-center border border-[#bdc9dc] bg-[#fbfcff] text-[#315fc0]">
                <MessageCircle size={17} />
              </button>
              <button aria-label="Emma Smith profile" className="grid h-9 w-9 place-items-center bg-[#315fc0] text-[10px] font-bold text-[#fbfcff]">ES</button>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-[30px_1fr_30px] items-center">
            <button aria-label="Previous day" className="grid h-7 w-7 place-items-center text-[#284675]"><ArrowLeft size={17} /></button>
            <p className="text-center text-[11px] font-bold tracking-[0.02em] text-[#284675]">Saturday, August 22, 2026</p>
            <button aria-label="Next day" className="grid h-7 w-7 place-items-center text-[#284675]"><ArrowRight size={17} /></button>
          </div>
          <h1 className="mt-2 font-['Playfair_Display'] text-[28px] font-semibold leading-none tracking-[-0.035em] text-[#172c56]">Welcome back, Emma</h1>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button className="flex h-10 items-center gap-1.5 border border-[#bdc9dc] bg-[#fbfcff]/95 px-2.5 text-left text-[10px] font-bold text-[#284675]">
              <Utensils size={14} className="text-[#315fc0]" /><span className="flex-1">Restaurant guide</span><ChevronRight size={13} />
            </button>
            <button className="flex h-10 items-center gap-1.5 border border-[#bdc9dc] bg-[#fbfcff]/95 px-2.5 text-left text-[10px] font-bold text-[#284675]">
              <BookOpen size={14} className="text-[#315fc0]" /><span className="flex-1">Approved list</span><ChevronRight size={13} />
            </button>
          </div>
        </div>
        <button className="absolute bottom-[1px] left-5 right-5 flex items-center gap-2 bg-[#315fc0] px-4 py-3 text-left text-[#fbfcff] shadow-[0_8px_20px_rgba(23,44,86,.23)]">
          <span className="grid h-6 w-6 place-items-center border border-white/30"><Sparkles size={13} /></span>
          <span className="flex-1"><span className="block text-[8px] font-bold tracking-[0.15em] text-[#cbd8f3]">TODAY'S FOCUS</span><span className="text-[12px] font-semibold">Getting enough sleep?</span></span>
          <ChevronRight size={17} />
        </button>
      </header>

      <div className="space-y-4 px-4 pb-[94px] pt-3">
        <section className="border border-[#bdc9dc] bg-[#fbfcff] shadow-[0_6px_16px_rgba(23,44,86,.06)]">
          <div className="h-1 bg-[#315fc0]" />
          <div className="p-4">
            <div className="flex items-start justify-between">
              <div><SignalLabel>WEEK AT A GLANCE</SignalLabel><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#172c56]">Seven steady days.</h2></div>
              <span className="border border-[#315fc0] bg-[#e8eef9] px-2 py-1 text-[9px] font-bold tracking-[.08em] text-[#284675]">7 OF 7 LOGGED</span>
            </div>
            <div className="mt-3 grid grid-cols-7 border-y border-[#dfe5ef] py-2.5">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                <div key={`${day}-${index}`} className="flex flex-col items-center gap-1.5">
                  <span className="text-[9px] font-semibold text-[#74839d]">{day}</span>
                  <span className={`h-2.5 w-2.5 ${index === 6 ? 'border-2 border-[#172c56] bg-[#315fc0]' : 'bg-[#315fc0]'}`} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <button className="flex w-full items-center gap-3 border border-[#bdc9dc] bg-[#fbfcff] p-4 text-left shadow-[0_5px_14px_rgba(23,44,86,.05)]">
          <span className="grid h-9 w-9 place-items-center bg-[#e8eef9] text-[#315fc0]"><BookOpen size={17} /></span>
          <span className="min-w-0 flex-1"><SignalLabel>PROGRAM STATUS</SignalLabel><span className="mt-1 block truncate text-[12px] font-semibold text-[#284675]">Day 94 · Metabolic Normalization Phase</span></span>
          <ChevronRight size={17} className="text-[#74839d]" />
        </button>

        <section className="border border-[#bdc9dc] bg-[#fbfcff] p-4 shadow-[0_6px_16px_rgba(23,44,86,.06)]">
          <div className="flex items-start justify-between"><div><SignalLabel>CALORIE GAUGE</SignalLabel><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#172c56]">Your day, in balance.</h2></div><span className="text-[10px] font-bold text-[#315fc0]">62% CONSUMED</span></div>
          <div className="mx-auto mt-3 flex h-[130px] w-[238px] items-end justify-center overflow-hidden">
            <div className="relative h-[236px] w-[236px] rotate-[45deg] border-[21px] border-[#dfe5ef] border-b-[#f07832] border-r-[#f07832]">
              <div className="absolute inset-[17px] -rotate-[45deg] text-center"><p className="mt-[57px] text-[45px] font-semibold leading-none tracking-[-.07em] text-[#f07832]">568</p><p className="mt-1 text-[9px] font-bold tracking-[.16em] text-[#74839d]">REMAINING</p></div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 divide-x divide-[#dfe5ef] text-center">
            <div><b className="block text-[16px] text-[#172c56]">1,500</b><SignalLabel>GOAL</SignalLabel></div>
            <div><b className="block text-[16px] text-[#172c56]">932</b><SignalLabel>FOOD</SignalLabel></div>
            <div><b className="block text-[16px] text-[#f07832]">568</b><SignalLabel>LEFT</SignalLabel></div>
          </div>
          <p className="mt-3 text-center text-[11px] text-[#74839d]">568 cal left for dinner and snacks.</p>
          <div className="mt-3 space-y-3 border-t border-[#dfe5ef] pt-3">
            {[['Protein', '73 of 120 g', '61%', 'bg-[#315fc0]'], ['Carbs', '70 of 130 g', '54%', 'bg-[#597ac5]'], ['Fat', '43 of 50 g', '86%', 'bg-[#93a8d7]']].map(([name, value, width, color]) => (
              <div key={name}><div className="mb-1 flex justify-between text-[10px]"><span className="font-bold text-[#284675]">{name}</span><span className="text-[#74839d]">{value}</span></div><div className="h-1.5 bg-[#dfe5ef]"><div className={`h-full ${color}`} style={{ width }} /></div></div>
            ))}
          </div>
        </section>

        <section><div className="mb-2 flex items-center justify-between"><SignalLabel>MEALS</SignalLabel><span className="text-[10px] font-semibold text-[#315fc0]">932 CAL TOTAL</span></div>
          <div className="border border-[#bdc9dc] bg-[#fbfcff] shadow-[0_5px_14px_rgba(23,44,86,.05)]">
            {meals.map(([name, detail], index) => <div key={name} className={`flex items-center justify-between px-4 py-3 ${index ? 'border-t border-[#dfe5ef]' : ''}`}><div><p className="text-[13px] font-bold text-[#284675]">{name}</p><p className="mt-0.5 text-[10px] text-[#74839d]">{detail}</p></div><button className="flex items-center gap-1 border border-[#bdc9dc] px-2.5 py-1.5 text-[10px] font-bold text-[#315fc0]"><Plus size={13} />ADD</button></div>)}
          </div>
        </section>

        <section className="border border-[#bdc9dc] bg-[#fbfcff] p-4 shadow-[0_5px_14px_rgba(23,44,86,.05)]">
          <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Droplets size={18} className="text-[#315fc0]" /><div><SignalLabel>WATER</SignalLabel><p className="mt-0.5 text-[12px] font-bold text-[#284675]">32 of 64 fl oz <span className="font-normal text-[#74839d]">(4 of 8 cups)</span></p></div></div><button aria-label="Add water" className="grid h-8 w-8 place-items-center border border-[#315fc0] text-[#315fc0]"><Plus size={16} /></button></div>
          <div className="mt-3 grid grid-cols-8 gap-1">{Array.from({ length: 8 }, (_, index) => <span key={index} className={`h-5 border ${index < 4 ? 'border-[#315fc0] bg-[#315fc0]' : 'border-[#bdc9dc] bg-[#eef2f8]'}`} />)}</div>
        </section>

        <section className="border border-[#bdc9dc] bg-[#fbfcff] p-4 shadow-[0_5px_14px_rgba(23,44,86,.05)]">
          <SignalLabel>DAILY CHECK-IN</SignalLabel><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#172c56]">You haven't checked in today</h2><p className="mt-1 text-[11px] leading-5 text-[#74839d]">Log your weight, mood, and how the plan feels. It takes 30 seconds.</p>
          <button className="mt-3 w-full bg-[#f07832] py-3 text-[11px] font-bold tracking-[.04em] text-[#fffaf5]">COMPLETE CHECK-IN</button>
        </section>

        <section className="border border-[#bdc9dc] bg-[#fbfcff] p-4 shadow-[0_5px_14px_rgba(23,44,86,.05)]">
          <div className="flex items-end justify-between"><div><SignalLabel>WEIGHT</SignalLabel><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#172c56]">Weight snapshot</h2></div><button className="flex items-center gap-1 text-[10px] font-bold text-[#315fc0]">VIEW PROGRESS <ArrowRight size={12} /></button></div>
          <div className="mt-3 grid grid-cols-3 divide-x divide-[#dfe5ef]"><div><b className="block text-[20px] tracking-[-.05em]">167.2 lb</b><SignalLabel>CURRENT</SignalLabel></div><div className="pl-3"><b className="block text-[20px] tracking-[-.05em] text-[#315fc0]">-12.8 lb</b><SignalLabel>DOWN TOTAL</SignalLabel></div><div className="pl-3"><b className="block text-[20px] tracking-[-.05em]">150 lb</b><SignalLabel>GOAL</SignalLabel></div></div>
        </section>
        <p className="pt-2 text-center text-[8px] font-bold tracking-[.14em] text-[#74839d]">SYNTHETIC DEMO DATA&nbsp; • &nbsp;NOT MEDICAL ADVICE</p>
      </div>

      <nav className="sticky bottom-0 z-10 flex h-[72px] items-center justify-around border-t border-[#bdc9dc] bg-[#fbfcff]/95 px-2 backdrop-blur">
        {tabs.map(([Icon, label]) => { const active = label === 'Today'; return <button key={label} className={`flex min-w-[50px] flex-col items-center gap-1 text-[9px] font-semibold ${active ? 'text-[#315fc0]' : 'text-[#74839d]'}`}><Icon size={19} strokeWidth={active ? 2.4 : 1.8} /><span>{label}</span>{active && <i className="h-0.5 w-4 bg-[#315fc0]" />}</button>; })}
      </nav>
    </main>
  );
}