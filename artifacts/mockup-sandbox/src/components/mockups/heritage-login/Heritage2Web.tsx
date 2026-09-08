import { ChevronRight, ClipboardList, MessageCircle, Truck, Users } from 'lucide-react';
import { Card, DemoFooter, Field, H, HERO, Kicker, Mark, PrimaryButton, SERIF, StaffFootnote, TextLink, WebPage, Wordmark } from './HeritageKit';

const chips = [
  [Users, 'Roster'],
  [Truck, 'Deliveries'],
  [ClipboardList, 'Check-ins'],
  [MessageCircle, 'Messages'],
] as const;

/** 2 · Morning Hero — the patient home's food-photo hero and paper scrim, turned into a staff split sign-in. */
export function Heritage2Web() {
  return (
    <WebPage>
      <div className="grid flex-1 lg:grid-cols-[46%_54%]">
        <section className="relative hidden min-h-[560px] overflow-hidden lg:block">
          <img src={HERO} alt="A balanced salad bowl on a linen table" className="absolute inset-0 h-full w-full object-cover object-center" />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(245,247,249,.96)_0%,rgba(245,247,249,.9)_30%,rgba(245,247,249,.55)_48%,rgba(245,247,249,.1)_70%,rgba(242,243,244,.86)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(242,243,244,0)_70%,#f2f3f4_100%)]" />
          <div className="relative z-10 flex h-full flex-col justify-between p-10">
            <div>
              <div className="flex items-center justify-between">
                <Wordmark height={30} />
                <span className="rounded-[5px] border border-[#c5d3e1] bg-[#f9fafb]/70 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.09em]" style={{ color: '#365373' }}>
                  Saturday, August 22, 2026
                </span>
              </div>
              <Kicker className="mt-12" color="#54708d">
                Today at the office
              </Kicker>
              <h2 className="mt-2 max-w-[11ch] text-[44px] leading-[1.02]" style={{ fontFamily: SERIF, color: H.navy }}>
                A well-paced day starts at the desk.
              </h2>
            </div>
            <div className="grid max-w-[420px] grid-cols-2 gap-2">
              {chips.map(([Icon, label]) => (
                <span key={label} className="flex items-center gap-2 rounded-[7px] border border-[#ced9e5] bg-[#fdfcf9]/90 px-3 py-2.5 text-[11px] font-semibold" style={{ color: '#334e6e', boxShadow: '0 5px 12px rgba(35,61,95,.10)' }}>
                  <Icon size={14} style={{ color: H.orange }} />
                  <span className="flex-1">{label}</span>
                  <ChevronRight size={13} />
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="flex flex-col">
          <main className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center px-6 py-10">
            <div className="flex items-center gap-3">
              <Mark size={40} />
              <div>
                <Kicker>THINNR Operations</Kicker>
                <p className="text-[12px] font-semibold" style={{ color: H.body }}>
                  Staff sign-in
                </p>
              </div>
            </div>
            <h1 className="mt-7 text-[32px] font-bold leading-tight tracking-[-.02em]" style={{ fontFamily: SERIF, color: H.navy }}>
              Welcome back.
            </h1>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: H.muted }}>
              Enter your work email and we’ll send a one-time code. No password to remember.
            </p>
            <Card className="mt-6">
              <div className="p-5">
                <Field label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" />
                <PrimaryButton className="mt-4" arrow>
                  Email me a code
                </PrimaryButton>
                <p className="mt-3 text-center text-[11px]" style={{ color: H.muted }}>
                  Codes expire after 10 minutes.
                </p>
              </div>
            </Card>
            <div className="mt-5 flex items-center justify-center gap-4">
              <TextLink tone="muted">Browse the guided demo</TextLink>
              <span className="h-3 w-px bg-[#d8e0e9]" />
              <TextLink tone="muted">Need access?</TextLink>
            </div>
            <StaffFootnote className="mt-8" />
          </main>
        </section>
      </div>
      <DemoFooter />
    </WebPage>
  );
}
