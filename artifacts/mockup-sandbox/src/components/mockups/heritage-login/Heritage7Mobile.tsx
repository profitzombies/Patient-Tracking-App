import { Card, Field, H, Kicker, PatientFooter, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, TextLink, Wordmark } from './HeritageKit';

const steps = ['Phone', 'Code', 'Today'];

/** 7 · Editorial Steps — a Playfair headline and a three-segment stepper above the ledger card. */
export function Heritage7Mobile() {
  return (
    <PhonePage>
      <PhoneStatusBar />
      <header className="flex items-center justify-between px-5 pb-3 pt-2">
        <Wordmark height={18} />
        <TextLink tone="muted">Help</TextLink>
      </header>

      <div className="flex flex-1 flex-col gap-3.5 px-5 pb-7 pt-6">
        <Kicker>Patient access</Kicker>
        <h1 className="max-w-[9ch] text-[40px] leading-[1.0] tracking-[-.02em]" style={{ fontFamily: SERIF, color: H.navy }}>
          Two taps to today.
        </h1>
        <p className="text-[13px] leading-5" style={{ color: H.body }}>
          Your cell number and password, then a quick text code. Your Today tab is right behind it.
        </p>

        <ol className="mt-1 grid grid-cols-3 gap-2" aria-label="Sign-in steps">
          {steps.map((label, index) => (
            <li key={label}>
              <i className="block h-1 rounded-full" style={{ background: index === 0 ? H.cobalt : H.line }} aria-hidden="true" />
              <p className="mt-1.5 text-[10px] font-bold uppercase tracking-[.12em]" style={{ color: index === 0 ? H.navy : H.muted }}>
                {String(index + 1).padStart(2, '0')} {label}
              </p>
            </li>
          ))}
        </ol>

        <Card className="mt-1">
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
