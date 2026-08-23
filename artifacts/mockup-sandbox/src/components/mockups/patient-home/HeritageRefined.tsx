import { useState } from 'react';
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
];

const tabs = [
  [Sun, 'Today'],
  [BookOpen, 'Diary'],
  [Grid2X2, 'Library'],
  [TrendingDown, 'Progress'],
  [ClipboardList, 'Plan'],
] as const;

export default function HeritageRefined() {
  const [water, setWater] = useState(4);
  const [checkedIn, setCheckedIn] = useState(false);
  const [activeTab, setActiveTab] = useState('Today');
  const [toast, setToast] = useState('');

  const act = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 1500);
  };

  return (
    <main className="relative mx-auto min-h-[844px] w-full max-w-[390px] overflow-hidden bg-[#f5f2ee] font-['Inter'] text-[#273039]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[285px] bg-[linear-gradient(180deg,#e7f0f7_0%,#f5f2ee_92%)]" />
      <div className="relative px-5 pb-[92px] pt-6">
        <header>
          <div className="flex items-center justify-between">
            <div className="font-['Playfair_Display'] text-[25px] font-bold tracking-[0.13em] text-[#243955]">THINNR</div>
            <div className="flex items-center gap-2.5">
              <button aria-label="Message your coach" onClick={() => act('Opening your coach')} className="grid h-9 w-9 place-items-center rounded-full border border-[#d7e0e5] bg-[#fffdfa]/90 text-[#3c6792]">
                <MessageCircle size={17} strokeWidth={1.8} />
              </button>
              <button aria-label="Your profile" onClick={() => act('Profile selected')} className="grid h-9 w-9 place-items-center rounded-full bg-[#304e70] text-[11px] font-bold text-white">ES</button>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <button aria-label="Previous day" onClick={() => act('Previous day')} className="text-[#68757e]"><ArrowLeft size={18} /></button>
            <div className="rounded-full border border-[#f1c792] bg-[#fffaf3] px-3 py-1.5 text-center text-[10px] font-bold uppercase tracking-[0.08em] text-[#b76225]">
              Saturday, August 22, 2026
            </div>
            <button aria-label="Next day" onClick={() => act('Today is selected')} className="text-[#68757e]"><ArrowRight size={18} /></button>
          </div>
          <h1 className="mt-4 font-['Playfair_Display'] text-[29px] leading-none text-[#273b56]">Welcome back, Emma.</h1>

          <div className="mt-4 rounded-[17px] bg-[#dceaf7] px-4 py-3 shadow-[0_9px_20px_rgba(79,107,133,.09)]">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-[#345a80]"><Sparkles size={15} /> TODAY'S FOCUS</div>
            <button onClick={() => act('Check-in opened')} className="mt-1 flex w-full items-center justify-between text-left font-['Playfair_Display'] text-[18px] text-[#273b56]">
              <span>Getting enough sleep?</span><ChevronRight size={18} />
            </button>
          </div>

          <div className="mt-3 flex gap-2">
            <button onClick={() => act('Restaurant guide opened')} className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-[#e7dbce] bg-[#fffdfa] py-2 text-[11px] font-semibold text-[#4a5560]"><Utensils size={13} className="text-[#f6821f]" />Restaurant guide</button>
            <button onClick={() => act('Approved list opened')} className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-[#e7dbce] bg-[#fffdfa] py-2 text-[11px] font-semibold text-[#4a5560]"><Sun size={13} className="text-[#f6821f]" />Approved list</button>
          </div>
        </header>

        <section className="mt-5 overflow-hidden rounded-[20px] bg-[#fffdfa] shadow-[0_10px_26px_rgba(75,59,39,.10)]">
          <div className="h-1 bg-[#f6821f]" />
          <div className="px-4 pb-4 pt-3">
            <div className="flex items-center justify-between">
              <h2 className="font-['Playfair_Display'] text-[19px] text-[#273b56]">Your day at a glance</h2>
              <span className="rounded-full bg-[#fff0df] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[#c96516]">7 of 7 logged</span>
            </div>
            <div className="mt-3 flex items-center justify-between border-y border-[#eee8e1] py-2.5">
              {['S','M','T','W','T','F','S'].map((day, index) => <div key={`${day}${index}`} className="flex flex-col items-center gap-1"><span className="text-[10px] text-[#8b8982]">{day}</span><span className={`h-2 w-2 rounded-full ${index === 6 ? 'bg-[#4d9d6b] ring-4 ring-[#e1f1e5]' : 'bg-[#f6821f]'}`} /></div>)}
            </div>
          </div>
        </section>

        <button onClick={() => act('Program instructions opened')} className="mt-4 flex w-full items-center gap-3 rounded-[16px] bg-[#fffdfa] px-4 py-3.5 text-left shadow-[0_7px_18px_rgba(75,59,39,.08)]">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-[#e8f0f8] text-[#456e99]"><BookOpen size={17} /></div>
          <div className="min-w-0 flex-1"><p className="text-[9px] font-bold tracking-[.13em] text-[#8c8880]">PROGRAM INSTRUCTIONS</p><p className="truncate pt-0.5 text-[12px] font-semibold text-[#354a61]">Day 94 - Metabolic Normalization Phase</p></div><ChevronRight size={17} className="text-[#a8a49d]" />
        </button>

        <section className="mt-4 rounded-[20px] bg-[#fffdfa] px-4 pb-4 pt-4 shadow-[0_10px_26px_rgba(75,59,39,.10)]">
          <div className="flex items-start justify-between"><div><p className="text-[10px] font-bold tracking-[.12em] text-[#8c8880]">CALORIES FOR TODAY</p><h2 className="mt-1 font-['Playfair_Display'] text-[21px] text-[#273b56]">A well-paced day.</h2></div><span className="text-[11px] font-semibold text-[#6f7c87]">62% used</span></div>
          <div className="mx-auto mt-3 flex h-[145px] w-[250px] items-end justify-center overflow-hidden">
            <div className="relative h-[250px] w-[250px] rounded-full border-[23px] border-[#e9e6e0] border-b-[#f6821f] border-l-[#f6821f] -rotate-[45deg]">
              <div className="absolute inset-[18px] rotate-[45deg] text-center"><p className="mt-[61px] font-['Playfair_Display'] text-[47px] leading-none text-[#273b56]">568</p><p className="mt-1 text-[10px] font-bold uppercase tracking-[.14em] text-[#8b8980]">remaining</p></div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-center"><div><b className="block text-[16px] text-[#354a61]">1,500</b><span className="text-[9px] font-bold tracking-[.1em] text-[#918d86]">GOAL</span></div><span className="h-7 w-px bg-[#e6e0d8]" /><div><b className="block text-[16px] text-[#354a61]">932</b><span className="text-[9px] font-bold tracking-[.1em] text-[#918d86]">FOOD</span></div><span className="h-7 w-px bg-[#e6e0d8]" /><div><b className="block text-[16px] text-[#f6821f]">568</b><span className="text-[9px] font-bold tracking-[.1em] text-[#918d86]">LEFT</span></div></div>
          <p className="mt-3 text-center text-[11px] text-[#747a7b]">568 cal left for dinner and snacks.</p>
          <div className="mt-4 space-y-3 border-t border-[#eee8e1] pt-3">
            {[['Protein','73 of 120 g','61%','bg-[#597ea5]'],['Carbs','70 of 130 g','54%','bg-[#80a8bd]'],['Fat','43 of 50 g','86%','bg-[#d59a58]']].map(([name,value,pct,color]) => <div key={name}><div className="mb-1 flex justify-between text-[11px]"><span className="font-semibold text-[#43515c]">{name}</span><span className="text-[#82817c]">{value} <b className="ml-1 text-[#596a76]">{pct}</b></span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#ece9e4]"><div className={`h-full rounded-full ${color}`} style={{width:pct}} /></div></div>)}
          </div>
        </section>

        <section className="mt-5"><h2 className="mb-2 ml-1 font-['Playfair_Display'] text-[21px] text-[#273b56]">Meals & hydration</h2>
          <div className="overflow-hidden rounded-[18px] bg-[#fffdfa] shadow-[0_8px_21px_rgba(75,59,39,.09)]">
            {meals.map(([name, detail], i) => <div key={name} className={`flex items-center justify-between px-4 py-3 ${i ? 'border-t border-[#f0ebe5]' : ''}`}><div><p className="font-['Playfair_Display'] text-[17px] text-[#303c49]">{name}</p><p className="text-[11px] text-[#8b8983]">{detail}</p></div><button onClick={() => act(`${name} entry added`)} className="flex items-center gap-1 rounded-full bg-[#fff0df] px-3 py-1.5 text-[11px] font-bold text-[#d66d19]"><Plus size={13} />Add</button></div>)}
            <div className="border-t border-[#f0ebe5] p-4"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><div className="grid h-8 w-8 place-items-center rounded-full bg-[#e7f0f8] text-[#4b78a3]"><Droplets size={16} /></div><div><p className="font-['Playfair_Display'] text-[17px]">Water</p><p className="text-[11px] text-[#8b8983]">8 cups of 8 oz · {water * 8} of 64 fl oz</p></div></div><div className="flex gap-1.5"><button aria-label="Remove water" onClick={() => setWater(Math.max(0, water - 1))} className="grid h-7 w-7 place-items-center rounded-full border border-[#e6ddd4] text-[#6f7880]"><Minus size={14}/></button><button aria-label="Add water" onClick={() => setWater(Math.min(8, water + 1))} className="grid h-7 w-7 place-items-center rounded-full bg-[#f6821f] text-white"><Plus size={14}/></button></div></div><div className="mt-3 flex gap-1.5">{Array.from({length:8},(_,i)=><button key={i} onClick={() => setWater(i+1)} aria-label={`${i+1} cups`} className={`h-5 flex-1 rounded-md ${i < water ? 'bg-[#79a8c8]' : 'bg-[#e6eef3]'}`} />)}</div></div>
          </div>
        </section>

        <section className="mt-5 rounded-[19px] bg-[#fffdfa] p-4 shadow-[0_8px_21px_rgba(75,59,39,.09)]"><p className="text-[10px] font-bold tracking-[.12em] text-[#8c8880]">DAILY CHECK-IN</p><h2 className="mt-1 font-['Playfair_Display'] text-[20px] text-[#273b56]">{checkedIn ? 'Check-in complete.' : "You haven't checked in today"}</h2><p className="mt-1 text-[12px] leading-5 text-[#72767a]">{checkedIn ? 'Thank you for keeping your care team in the loop.' : 'Log your weight, mood, and how the plan feels. It takes 30 seconds.'}</p><button onClick={() => setCheckedIn(true)} className="mt-3 w-full rounded-full bg-[#f6821f] py-3 text-[12px] font-bold text-white">{checkedIn ? 'Check-In Complete' : 'Complete Check-In'}</button></section>

        <section className="mt-5 rounded-[19px] bg-[#fffdfa] p-4 shadow-[0_8px_21px_rgba(75,59,39,.09)]"><div className="flex items-end justify-between"><h2 className="font-['Playfair_Display'] text-[21px] text-[#273b56]">Weight snapshot</h2><button onClick={() => act('Progress opened')} className="text-[11px] font-bold text-[#c96516]">View full progress</button></div><div className="mt-4 grid grid-cols-3 divide-x divide-[#eee8e1] text-center"><div><b className="block text-[20px] text-[#303f51]">167.2</b><span className="text-[8px] font-bold tracking-[.11em] text-[#8b8980]">CURRENT LBS</span></div><div><b className="block text-[20px] text-[#4d9d6b]">-12.8</b><span className="text-[8px] font-bold tracking-[.11em] text-[#8b8980]">SINCE START</span></div><div><b className="block text-[20px] text-[#303f51]">150</b><span className="text-[8px] font-bold tracking-[.11em] text-[#8b8980]">GOAL LBS</span></div></div></section>

        <p className="mt-6 text-center text-[8px] font-bold tracking-[.13em] text-[#96918a]">SYNTHETIC DEMO DATA&nbsp; • &nbsp;NOT MEDICAL ADVICE</p>
      </div>
      {toast && <div className="fixed bottom-[83px] left-1/2 z-20 -translate-x-1/2 rounded-full bg-[#273b56] px-4 py-2 text-[11px] text-white shadow-lg">{toast}</div>}
      <nav className="sticky bottom-0 z-10 flex h-[70px] items-center justify-around border-t border-[#e2ddd5] bg-[#fffdfa]/95 px-2 backdrop-blur">
        {tabs.map(([Icon, label]) => <button key={label} onClick={() => {setActiveTab(label); act(`${label} selected`)}} className={`flex min-w-[54px] flex-col items-center gap-1 text-[9px] font-semibold ${activeTab === label ? 'text-[#d66d19]' : 'text-[#899099]'}`}><Icon size={18} strokeWidth={activeTab === label ? 2.3 : 1.8} /><span>{label}</span>{activeTab === label && <i className="-mt-0.5 h-1 w-1 rounded-full bg-[#f6821f]" />}</button>)}
      </nav>
    </main>
  );
}