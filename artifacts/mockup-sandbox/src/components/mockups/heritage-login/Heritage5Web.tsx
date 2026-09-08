import { Smartphone } from 'lucide-react';
import { Card, DemoFooter, Field, H, Kicker, PrimaryButton, SERIF, StaffFootnote, TextLink, WebPage, Wordmark } from './HeritageKit';

const stats = [
  ['128', 'active patients'],
  ['6', 'deliveries to review'],
  ['3', 'unread messages'],
];

/** 5 · Navy Band — deep-navy masthead with the cream wordmark; the sign-in card overlaps its lower edge. */
export function Heritage5Web() {
  return (
    <WebPage>
      <section className="relative overflow-hidden" style={{ background: H.navy }}>
        <div className="pointer-events-none absolute -right-24 -top-24 h-[360px] w-[360px] rounded-full opacity-20" style={{ background: 'radial-gradient(closest-side, #5878b9, transparent)' }} aria-hidden="true" />
        <div className="mx-auto w-full max-w-[1040px] px-8 pb-28 pt-8">
          <div className="flex items-center justify-between">
            <Wordmark height={30} color={H.brandFg} />
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: H.cobaltMuted }}>
              <Smartphone size={14} />
              Patients sign in on the THINNR mobile app
            </span>
          </div>
          <div className="mt-14 grid items-end gap-8 lg:grid-cols-[1fr_auto]">
            <div>
              <Kicker color={H.cobaltMuted}>Operations · Saturday, August 22</Kicker>
              <h1 className="mt-3 max-w-[14ch] text-[46px] leading-[1.02] tracking-[-.02em]" style={{ fontFamily: SERIF, color: '#f4f6fa' }}>
                The desk is ready when you are.
              </h1>
            </div>
            <div className="flex gap-2">
              {stats.map(([value, label]) => (
                <div key={label} className="rounded-[7px] border px-3.5 py-2.5" style={{ borderColor: 'rgba(255,255,255,.14)', background: 'rgba(255,255,255,.06)' }}>
                  <p className="text-[20px] leading-none" style={{ fontFamily: SERIF, color: '#f4f6fa' }}>
                    {value}
                  </p>
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-[.1em]" style={{ color: H.cobaltMuted }}>
                    {label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <main className="relative z-10 mx-auto -mt-20 flex w-full max-w-[1040px] flex-1 flex-col px-8 pb-10">
        <Card lifted className="w-full max-w-[460px]">
          <div className="p-7">
            <Kicker>Staff sign-in</Kicker>
            <h2 className="mt-1.5 text-[24px] font-bold tracking-[-.01em]" style={{ fontFamily: SERIF, color: H.navy }}>
              Sign in with your work email
            </h2>
            <Field wrapClassName="mt-5" label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" hint="We’ll email you a 6-digit sign-in code. No password needed." />
            <PrimaryButton className="mt-4" arrow>
              Email me a code
            </PrimaryButton>
            <div className="mt-4 flex items-center justify-between border-t border-[#e8e8e5] pt-3">
              <span className="text-[11px]" style={{ color: H.muted }}>
                No account yet?
              </span>
              <TextLink>Browse the guided demo</TextLink>
            </div>
          </div>
        </Card>
        <StaffFootnote className="mt-8 max-w-[460px] text-left" />
      </main>
      <DemoFooter />
    </WebPage>
  );
}
