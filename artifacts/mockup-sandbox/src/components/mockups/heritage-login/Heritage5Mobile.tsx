import { BackTile, Card, Field, H, Kicker, Mark, PatientFooter, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, TextLink } from './HeritageKit';

/** 5 · Navy Band — a deep-navy masthead with cream type; the ledger card overlaps its lower edge. */
export function Heritage5Mobile() {
  return (
    <PhonePage>
      <section className="relative overflow-hidden" style={{ background: H.navy }}>
        <div className="pointer-events-none absolute -right-16 -top-20 h-[240px] w-[240px] rounded-full opacity-25" style={{ background: 'radial-gradient(closest-side, #5878b9, transparent)' }} aria-hidden="true" />
        <div className="relative">
          <PhoneStatusBar tone="light" />
          <header className="flex items-center justify-between px-4 pb-3 pt-2">
            <BackTile tone="navy" />
            <Mark size={34} tone="cream" />
            <span className="w-11" aria-hidden="true" />
          </header>
          <div className="px-5 pb-16 pt-4">
            <Kicker color={H.cobaltMuted}>Patient access</Kicker>
            <h1 className="mt-1.5 text-[34px] font-bold leading-none" style={{ fontFamily: SERIF, color: '#f4f6fa' }}>
              Welcome back.
            </h1>
            <p className="mt-2.5 text-[13px] leading-5" style={{ color: H.cobaltMuted }}>
              Sign in with your cell phone and password. We’ll text a code to finish.
            </p>
          </div>
        </div>
      </section>

      <div className="relative z-10 -mt-10 flex flex-1 flex-col gap-3.5 px-5 pb-7">
        <Card lifted>
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
