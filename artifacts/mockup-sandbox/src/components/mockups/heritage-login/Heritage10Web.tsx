import { ArrowUpRight, Sparkles } from 'lucide-react';
import { Card, DemoFooter, Field, H, Kicker, Mark, PrimaryButton, SERIF, StaffFootnote, TextLink, WebPage } from './HeritageKit';

const tiles = [
  ['Active patients', '128', '+4 this week'],
  ['Check-ins today', '41', '62% of roster'],
  ['Deliveries to review', '6', '2 overdue'],
];

const bars = [34, 52, 46, 61, 58, 72, 66];

/** 10 · Desk Preview — the sign-in card sits in front of a faded, scrimmed preview of the Overview desk. */
export function Heritage10Web() {
  return (
    <WebPage className="overflow-hidden">
      <div className="pointer-events-none absolute inset-y-0 right-0 w-[62%] select-none" aria-hidden="true">
        <div className="absolute inset-0 origin-top-right px-10 pt-12" style={{ transform: 'scale(.94)', opacity: 0.92 }}>
          <div className="flex items-end justify-between">
            <div>
              <Kicker>Overview · Saturday, August 22</Kicker>
              <p className="mt-1 text-[28px]" style={{ fontFamily: SERIF, color: H.navy }}>
                Your desk, after sign-in
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-[7px] border border-[#c8d7e6] bg-[#e5edf7] px-3 py-2 text-[11px] font-semibold" style={{ color: H.navy }}>
              <Sparkles size={13} style={{ color: H.cobalt }} />
              6 priority signals
            </span>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3">
            {tiles.map(([label, value, delta]) => (
              <Card key={label} accentTop>
                <div className="px-4 pb-4 pt-3">
                  <Kicker>{label}</Kicker>
                  <p className="mt-2 text-[34px] leading-none" style={{ fontFamily: SERIF, color: H.navy }}>
                    {value}
                  </p>
                  <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: H.cobalt }}>
                    <ArrowUpRight size={12} />
                    {delta}
                  </p>
                </div>
              </Card>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-[1.4fr_1fr] gap-3">
            <Card>
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[18px]" style={{ fontFamily: SERIF, color: H.navy }}>
                    Check-ins this week
                  </p>
                  <span className="rounded-[5px] border border-[#e8b47c] bg-[#fff4e6] px-2 py-1 text-[9px] font-bold uppercase tracking-wide" style={{ color: H.warn }}>
                    7 of 7 days
                  </span>
                </div>
                <div className="mt-4 flex h-[120px] items-end gap-2">
                  {bars.map((height, index) => (
                    <span key={index} className="flex-1 rounded-t-[3px]" style={{ height: `${height}%`, background: index === bars.length - 1 ? H.orange : index % 2 ? H.cobaltLight : H.cobalt }} />
                  ))}
                </div>
                <div className="mt-2 flex justify-between text-[10px]" style={{ color: H.muted }}>
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                    <span key={`${day}${index}`}>{day}</span>
                  ))}
                </div>
              </div>
            </Card>
            <Card>
              <div className="p-4">
                <p className="text-[18px]" style={{ fontFamily: SERIF, color: H.navy }}>
                  Needs a look
                </p>
                <ul className="mt-3 space-y-2.5">
                  {['Emma S. · missed 2 check-ins', 'Order #4471 · address bounce', 'Priya R. · new message'].map((item) => (
                    <li key={item} className="flex items-center gap-2 text-[12px]" style={{ color: H.body }}>
                      <i className="h-2 w-2 rounded-full" style={{ background: H.orange }} />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          </div>
          <Card className="mt-3">
            <div className="flex items-center justify-between border-b border-[#e8e8e5] px-4 py-3">
              <p className="text-[18px]" style={{ fontFamily: SERIF, color: H.navy }}>
                Roster · phase 2
              </p>
              <span className="text-[10px] font-bold uppercase tracking-[.09em]" style={{ color: H.muted }}>
                Updated 6:42 am
              </span>
            </div>
            {[
              ['Emma Sandoval', 'Week 6', 'Check-in due', '-11.4 lb'],
              ['Priya Raman', 'Week 3', 'On track', '-6.2 lb'],
              ['Marcus Lyle', 'Week 9', 'Shipment pending', '-18.0 lb'],
            ].map(([name, week, status, delta]) => (
              <div key={name} className="grid grid-cols-[1.4fr_.7fr_1fr_.6fr] items-center border-b border-[#e8e8e5] px-4 py-2.5 text-[12px] last:border-b-0" style={{ color: H.body }}>
                <span className="font-semibold" style={{ color: H.navy }}>
                  {name}
                </span>
                <span>{week}</span>
                <span className="inline-flex w-fit rounded-[5px] bg-[#e3ecf7] px-2 py-0.5 text-[10px] font-bold" style={{ color: H.cobalt }}>
                  {status}
                </span>
                <span className="text-right font-semibold" style={{ fontFamily: SERIF, color: H.navy }}>
                  {delta}
                </span>
              </div>
            ))}
          </Card>
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(90deg,#f2f3f4_0%,rgba(242,243,244,.92)_18%,rgba(242,243,244,.55)_45%,rgba(242,243,244,.25)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-[linear-gradient(180deg,rgba(242,243,244,0),#f2f3f4)]" />
      </div>

      <main className="relative z-10 mx-auto flex w-full max-w-[1120px] flex-1 flex-col justify-center px-10 py-10">
        <Card lifted className="w-full max-w-[420px]">
          <div className="p-7">
            <div className="flex items-center gap-3">
              <Mark size={40} />
              <div className="leading-tight">
                <p className="text-[13px] font-semibold" style={{ color: H.navy }}>
                  THINNR Operations
                </p>
                <p className="text-[11px]" style={{ color: H.muted }}>
                  Staff sign-in
                </p>
              </div>
            </div>
            <h1 className="mt-6 text-[30px] font-bold leading-tight tracking-[-.02em]" style={{ fontFamily: SERIF, color: H.navy }}>
              Pick up where the desk left off.
            </h1>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: H.muted }}>
              Sign in with your work email — we’ll send a one-time code.
            </p>
            <Field wrapClassName="mt-5" label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" hint="We’ll email you a 6-digit sign-in code. No password needed." />
            <PrimaryButton className="mt-4" arrow>
              Email me a code
            </PrimaryButton>
            <div className="mt-4 text-center">
              <TextLink tone="muted">Browse the guided demo without an account</TextLink>
            </div>
          </div>
        </Card>
        <StaffFootnote className="mt-6 max-w-[420px] text-left" />
      </main>
      <DemoFooter className="relative z-10" />
    </WebPage>
  );
}
