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

const tabs = [
  [Sun, 'Today'],
  [BookOpen, 'Diary'],
  [Grid2X2, 'Library'],
  [TrendingDown, 'Progress'],
  [ClipboardList, 'Plan'],
] as const;

const meals = [
  ['Breakfast', '2 items · 322 cal'],
  ['Lunch', '1 item · 420 cal'],
  ['Dinner', 'Nothing logged yet'],
  ['Snacks', '1 item · 190 cal'],
];

const macros = [
  ['Protein', '73 of 120 g', '61%', 'w-[61%]', 'bg-[#365fa4]'],
  ['Carbs', '70 of 130 g', '54%', 'w-[54%]', 'bg-[#7393c0]'],
  ['Fat', '43 of 50 g', '86%', 'w-[86%]', 'bg-[#d38447]'],
];

export function HeritageHero() {
  return (
    <main className="relative mx-auto min-h-[100dvh] w-full max-w-[390px] overflow-x-hidden bg-[#f2f3f4] font-['Inter'] text-[#26364b]">
      <section className="relative h-[337px] overflow-hidden">
        <img
          src="/__mockup/images/home-hero.jpg"
          alt="Healthy salad bowl prepared for a balanced meal"
          className="absolute inset-0 h-full w-full object-cover object-center"
        />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(245,247,249,.94)_0%,rgba(245,247,249,.72)_36%,rgba(245,247,249,.18)_72%,#f2f3f4_100%)]" />
        <header className="relative z-10 px-5 pt-6">
          <div className="flex items-center justify-between">
            <div className="font-['Playfair_Display'] text-[25px] font-bold tracking-[.15em] text-[#203b64]">THINNR</div>
            <div className="flex gap-2">
              <button aria-label="Message your coach" className="grid h-9 w-9 place-items-center rounded-[7px] border border-[#cbd7e5] bg-[#fdfcf9]/90 text-[#315e9d]">
                <MessageCircle size={17} strokeWidth={1.8} />
              </button>
              <button aria-label="Your profile" className="grid h-9 w-9 place-items-center rounded-[7px] bg-[#315eae] text-[11px] font-bold text-white">ES</button>
            </div>
          </div>
          <div className="mt-5 flex items-center justify-between">
            <button aria-label="Previous day" className="p-1 text-[#355273]"><ArrowLeft size={18} /></button>
            <p className="border-y border-[#c5d3e1] bg-[#f9fafb]/55 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.09em] text-[#365373]">Saturday, August 22, 2026</p>
            <button aria-label="Next day" className="p-1 text-[#355273]"><ArrowRight size={18} /></button>
          </div>
          <h1 className="mt-3 font-['Playfair_Display'] text-[29px] leading-none text-[#203b64]">Welcome back, Emma</h1>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button className="flex items-center gap-2 rounded-[7px] border border-[#ced9e5] bg-[#fdfcf9]/90 px-3 py-2.5 text-left text-[11px] font-semibold text-[#334e6e] shadow-[0_5px_12px_rgba(35,61,95,.10)]">
              <Utensils size={14} className="text-[#df772c]" /><span className="flex-1">Restaurant guide</span><ChevronRight size={13} />
            </button>
            <button className="flex items-center gap-2 rounded-[7px] border border-[#ced9e5] bg-[#fdfcf9]/90 px-3 py-2.5 text-left text-[11px] font-semibold text-[#334e6e] shadow-[0_5px_12px_rgba(35,61,95,.10)]">
              <Sun size={14} className="text-[#df772c]" /><span className="flex-1">Approved list</span><ChevronRight size={13} />
            </button>
          </div>
        </header>
        <div className="absolute bottom-[-16px] left-5 right-5 z-20">
          <button className="flex w-full items-center gap-2 rounded-[8px] border border-[#c8d7e6] bg-[#e5edf7] px-3.5 py-3 text-left shadow-[0_9px_19px_rgba(34,58,88,.16)]">
            <Sparkles size={15} className="text-[#3664a5]" />
            <span className="text-[9px] font-bold tracking-[.12em] text-[#54708d]">TODAY'S FOCUS</span>
            <span className="ml-auto font-['Playfair_Display'] text-[17px] text-[#203b64]">Getting enough sleep?</span>
            <ChevronRight size={17} className="text-[#315e9d]" />
          </button>
        </div>
      </section>

      <div className="px-5 pb-[91px] pt-8">
        <section className="overflow-hidden rounded-[9px] border border-[#d8e0e9] bg-[#fdfcf9] shadow-[0_8px_20px_rgba(40,55,74,.075)]">
          <div className="h-1 bg-[#315eae]" />
          <div className="px-4 pb-3 pt-3">
            <div className="flex items-center justify-between">
              <h2 className="font-['Playfair_Display'] text-[19px] text-[#243f66]">Your day at a glance</h2>
              <span className="border border-[#e8b47c] bg-[#fff4e6] px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-[#b65c22]">7 of 7 logged</span>
            </div>
            <div className="mt-3 flex items-center justify-between border-y border-[#e8e8e5] py-2.5">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                <div key={`${day}${index}`} className="flex flex-col items-center gap-1">
                  <span className="text-[10px] text-[#7d8791]">{day}</span>
                  <span className={`h-2 w-2 ${index === 6 ? 'bg-[#315eae] ring-4 ring-[#dce8f4]' : 'bg-[#df772c]'}`} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <button className="mt-4 flex w-full items-center gap-3 rounded-[8px] border border-[#d8e0e9] bg-[#fdfcf9] px-4 py-3.5 text-left shadow-[0_6px_15px_rgba(40,55,74,.06)]">
          <span className="grid h-9 w-9 place-items-center rounded-[7px] bg-[#e3ecf7] text-[#315eae]"><BookOpen size={17} /></span>
          <span className="min-w-0 flex-1"><span className="block text-[9px] font-bold tracking-[.13em] text-[#7e8994]">PROGRAM STATUS</span><span className="block truncate pt-0.5 text-[12px] font-semibold text-[#314b6b]">Day 94 · Metabolic Normalization Phase</span></span>
          <ChevronRight size={17} className="text-[#8c98a4]" />
        </button>

        <section className="mt-4 rounded-[9px] border border-[#d8e0e9] bg-[#fdfcf9] px-4 pb-4 pt-4 shadow-[0_9px_20px_rgba(40,55,74,.075)]">
          <div className="flex items-start justify-between"><div><p className="text-[9px] font-bold tracking-[.13em] text-[#7e8994]">CALORIES FOR TODAY</p><h2 className="mt-1 font-['Playfair_Display'] text-[21px] text-[#243f66]">A well-paced day.</h2></div><span className="text-[11px] font-semibold text-[#56708e]">62% consumed</span></div>
          <div className="mx-auto mt-3 flex h-[142px] w-[244px] items-end justify-center overflow-hidden">
            <div className="relative h-[244px] w-[244px] -rotate-[45deg] rounded-full border-[22px] border-[#e3e7ea] border-b-[#df772c] border-l-[#315eae]">
              <div className="absolute inset-[18px] rotate-[45deg] text-center"><p className="mt-[58px] font-['Playfair_Display'] text-[46px] leading-none text-[#243f66]">568</p><p className="mt-1 text-[9px] font-bold uppercase tracking-[.14em] text-[#7e8994]">remaining</p></div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-center"><div><b className="block text-[16px] text-[#314b6b]">1,500</b><span className="text-[8px] font-bold tracking-[.1em] text-[#858d95]">GOAL</span></div><span className="h-7 w-px bg-[#e2e3e1]" /><div><b className="block text-[16px] text-[#314b6b]">932</b><span className="text-[8px] font-bold tracking-[.1em] text-[#858d95]">FOOD</span></div><span className="h-7 w-px bg-[#e2e3e1]" /><div><b className="block text-[16px] text-[#315eae]">568</b><span className="text-[8px] font-bold tracking-[.1em] text-[#858d95]">LEFT</span></div></div>
          <div className="mt-4 space-y-3 border-t border-[#e8e8e5] pt-3">{macros.map(([name, value, pct, width, color]) => <div key={name}><div className="mb-1 flex justify-between text-[11px]"><span className="font-semibold text-[#41536a]">{name}</span><span className="text-[#7d8791]">{value} <b className="ml-1 text-[#4a627d]">{pct}</b></span></div><div className="h-1.5 bg-[#e5e8eb]"><div className={`h-full ${width} ${color}`} /></div></div>)}</div>
        </section>

        <section className="mt-5"><h2 className="mb-2 ml-1 font-['Playfair_Display'] text-[21px] text-[#243f66]">Meals & hydration</h2><div className="overflow-hidden rounded-[9px] border border-[#d8e0e9] bg-[#fdfcf9] shadow-[0_8px_19px_rgba(40,55,74,.065)]">{meals.map(([name, detail], index) => <div key={name} className={`flex items-center justify-between px-4 py-3 ${index ? 'border-t border-[#e9e9e6]' : ''}`}><div><p className="font-['Playfair_Display'] text-[17px] text-[#33445a]">{name}</p><p className="text-[11px] text-[#858a8e]">{detail}</p></div><button className="flex items-center gap-1 rounded-[6px] border border-[#bad0e7] bg-[#f5f9fd] px-2.5 py-1.5 text-[11px] font-bold text-[#315eae]"><Plus size={13} />Add</button></div>)}<div className="border-t border-[#e9e9e6] p-4"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-[7px] bg-[#e3ecf7] text-[#315eae]"><Droplets size={16} /></span><div><p className="font-['Playfair_Display'] text-[17px] text-[#33445a]">Water</p><p className="text-[11px] text-[#858a8e]">32 of 64 fl oz · 4 of 8 cups</p></div></div><div className="mt-3 flex gap-1.5">{Array.from({ length: 8 }, (_, index) => <span key={index} className={`h-5 flex-1 ${index < 4 ? 'bg-[#6e9bc8]' : 'bg-[#e5edf3]'}`} />)}</div></div></div></section>

        <section className="mt-5 rounded-[9px] border border-[#d8e0e9] bg-[#fdfcf9] p-4 shadow-[0_8px_19px_rgba(40,55,74,.065)]"><p className="text-[9px] font-bold tracking-[.13em] text-[#7e8994]">DAILY CHECK-IN</p><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#243f66]">You haven't checked in today</h2><p className="mt-1 text-[12px] leading-5 text-[#6e7884]">Log your weight, mood, and how the plan feels. It takes 30 seconds.</p><button className="mt-3 w-full rounded-[6px] bg-[#315eae] py-3 text-[12px] font-bold text-white">Complete Check-In</button></section>

        <section className="mt-5 rounded-[9px] border border-[#d8e0e9] bg-[#fdfcf9] p-4 shadow-[0_8px_19px_rgba(40,55,74,.065)]"><div className="flex items-end justify-between"><h2 className="font-['Playfair_Display'] text-[21px] text-[#243f66]">Weight snapshot</h2><button className="text-[11px] font-bold text-[#315eae]">View full progress</button></div><div className="mt-4 grid grid-cols-3 divide-x divide-[#e7e8e6] text-center"><div><b className="block text-[20px] text-[#33445a]">167.2 lb</b><span className="text-[8px] font-bold tracking-[.1em] text-[#858a8e]">CURRENT</span></div><div><b className="block text-[20px] text-[#315eae]">-12.8 lb</b><span className="text-[8px] font-bold tracking-[.1em] text-[#858a8e]">TOTAL</span></div><div><b className="block text-[20px] text-[#33445a]">150 lb</b><span className="text-[8px] font-bold tracking-[.1em] text-[#858a8e]">GOAL</span></div></div></section>
        <p className="mt-6 text-center text-[8px] font-bold tracking-[.13em] text-[#8d9296]">SYNTHETIC DEMO DATA&nbsp; • &nbsp;NOT MEDICAL ADVICE</p>
      </div>
      <nav className="sticky bottom-0 z-30 flex h-[70px] items-center justify-around border-t border-[#d7e0e8] bg-[#fdfcf9]/95 px-2 backdrop-blur">
        {tabs.map(([Icon, label]) => <button key={label} className={`flex min-w-[54px] flex-col items-center gap-1 text-[9px] font-semibold ${label === 'Today' ? 'text-[#315eae]' : 'text-[#7d8997]'}`}><Icon size={18} strokeWidth={label === 'Today' ? 2.4 : 1.8} /><span>{label}</span>{label === 'Today' && <i className="h-1 w-4 bg-[#df772c]" />}</button>)}
      </nav>
    </main>
  );
}