import { Field, H, Kicker, PatientFooter, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, TextLink, Wordmark } from './HeritageKit';

/** 9 · Quiet Paper — no card: underlined fields on bare paper with generous breathing room. */
export function Heritage9Mobile() {
  return (
    <PhonePage>
      <PhoneStatusBar />
      <header className="flex items-center justify-between px-6 pb-3 pt-3">
        <Wordmark height={20} />
        <TextLink tone="muted">Help</TextLink>
      </header>

      <div className="flex flex-1 flex-col px-6 pb-8 pt-14">
        <Kicker>Patient access</Kicker>
        <h1 className="mt-3 text-[44px] leading-[1.0] tracking-[-.025em]" style={{ fontFamily: SERIF, color: H.navy }}>
          Welcome back.
        </h1>
        <p className="mt-4 max-w-[30ch] text-[14px] leading-6" style={{ color: H.body }}>
          Your cell number and password. We’ll text a six-digit code to finish.
        </p>

        <div className="mt-10 space-y-8">
          <Field variant="underline" label="Cell phone number" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your cell number" trailing={<TextLink size={11.5}>Use email instead</TextLink>} />
          <Field variant="underline" label="Password" type="password" autoComplete="current-password" placeholder="Your password" trailing={<TextLink size={11.5}>Forgot password?</TextLink>} />
        </div>

        <PrimaryButton size="lg" className="mt-10">
          Continue
        </PrimaryButton>

        <PatientFooter className="mt-auto pt-10" />
      </div>
    </PhonePage>
  );
}
