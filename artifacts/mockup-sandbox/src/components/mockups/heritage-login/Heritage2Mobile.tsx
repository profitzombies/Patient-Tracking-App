import { Card, Field, H, HERO, Kicker, PatientFooter, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, SerifWordmark, TextLink } from './HeritageKit';

/** 2 · Morning Hero — the Today tab's photo hero and paper scrim; the ledger card overlaps the hero's edge. */
export function Heritage2Mobile() {
  return (
    <PhonePage>
      <section className="relative h-[330px] overflow-hidden">
        <img src={HERO} alt="A balanced salad bowl prepared for a meal" className="absolute inset-0 h-full w-full object-cover object-[center_70%]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(245,247,249,.97)_0%,rgba(245,247,249,.94)_50%,rgba(245,247,249,.62)_66%,rgba(245,247,249,.14)_84%,#f2f3f4_100%)]" />
        <div className="relative z-10">
          <PhoneStatusBar />
          <div className="flex items-center justify-between px-5 pt-2">
            <SerifWordmark size={25} />
            <TextLink tone="muted" size={11.5} className="rounded-[7px] border border-[#cbd7e5] bg-[#fdfcf9]/90 px-2.5 py-1.5 hover:no-underline">
              Help
            </TextLink>
          </div>
          <div className="px-5 pt-7">
            <Kicker color="#54708d">Patient access</Kicker>
            <h1 className="mt-1.5 text-[32px] font-bold leading-none" style={{ fontFamily: SERIF, color: H.navy }}>
              Welcome back
            </h1>
            <p className="mt-2 max-w-[24ch] text-[12.5px] leading-5" style={{ color: '#4f6786' }}>
              Your plan, your plate, and your coach — right after you sign in.
            </p>
          </div>
        </div>
      </section>

      <div className="relative z-20 -mt-8 flex flex-1 flex-col gap-3.5 px-5 pb-7">
        <Card accentTop lifted>
          <div className="p-[18px]">
            <Field variant="mobile" label="Cell phone number" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your cell number" trailing={<TextLink size={11.5}>Use email instead</TextLink>} />
            <Field wrapClassName="mt-4" variant="mobile" label="Password" type="password" autoComplete="current-password" placeholder="Your password" trailing={<TextLink size={11.5}>Forgot password?</TextLink>} />
            <PrimaryButton size="lg" className="mt-5">
              Continue
            </PrimaryButton>
          </div>
        </Card>
        <PatientFooter className="mt-2" />
      </div>
    </PhonePage>
  );
}
