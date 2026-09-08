import { Utensils } from 'lucide-react';
import { DemoFooter, Field, H, HERO, Kicker, LIFTED, Mark, PrimaryButton, SERIF, StaffFootnote, TextLink, WebPage, Wordmark } from './HeritageKit';

/** 8 · Framed Plate — one wide cream card: the food photo framed on the left, the form on the right. */
export function Heritage8Web() {
  return (
    <WebPage>
      <header className="mx-auto flex w-full max-w-[1060px] items-center justify-between px-8 pt-7">
        <Wordmark height={26} />
        <TextLink tone="muted">Need access? Ask your office admin</TextLink>
      </header>

      <main className="mx-auto flex w-full max-w-[1060px] flex-1 items-center px-8 py-8">
        <section className="grid w-full overflow-hidden rounded-[9px] border border-[#d8e0e9] bg-[#fdfcf9] lg:grid-cols-[1fr_1fr]" style={{ boxShadow: LIFTED, minHeight: 540 }}>
          <div className="relative hidden lg:block">
            <img src={HERO} alt="Grilled chicken bowl with greens" className="absolute inset-0 h-full w-full object-cover object-center" />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(245,247,249,.15)_0%,rgba(245,247,249,0)_35%,rgba(253,252,249,.92)_100%)]" />
            <div className="absolute inset-x-0 bottom-0 p-7">
              <span className="inline-flex items-center gap-1.5 rounded-[5px] border border-[#e8b47c] bg-[#fff4e6] px-2 py-1 text-[9px] font-bold uppercase tracking-wide" style={{ color: H.warn }}>
                <Utensils size={11} />
                Approved list
              </span>
              <p className="mt-2 text-[24px] leading-tight" style={{ fontFamily: SERIF, color: H.navy }}>
                Saturday’s plate: grilled chicken, greens, and a slow afternoon.
              </p>
              <p className="mt-1 text-[11px]" style={{ color: H.body }}>
                From the restaurant guide your patients see on the Today tab.
              </p>
            </div>
          </div>

          <div className="flex flex-col justify-center p-10">
            <Mark size={44} />
            <Kicker className="mt-6">Staff sign-in</Kicker>
            <h1 className="mt-2 text-[32px] font-bold leading-tight tracking-[-.02em]" style={{ fontFamily: SERIF, color: H.navy }}>
              THINNR Operations
            </h1>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: H.muted }}>
              Sign in with your work email — we’ll send a one-time code.
            </p>
            <Field wrapClassName="mt-6" label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" hint="We’ll email you a 6-digit sign-in code. No password needed." />
            <PrimaryButton className="mt-4" arrow>
              Email me a code
            </PrimaryButton>
            <div className="mt-5 flex items-center gap-3 border-t border-[#e8e8e5] pt-4">
              <span className="text-[11px]" style={{ color: H.muted }}>
                Exploring?
              </span>
              <TextLink>Browse the guided demo without an account</TextLink>
            </div>
          </div>
        </section>
      </main>
      <StaffFootnote className="pb-6" />
      <DemoFooter />
    </WebPage>
  );
}
