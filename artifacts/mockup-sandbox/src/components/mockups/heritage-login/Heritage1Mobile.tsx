import { BackTile, Card, Field, H, Kicker, PatientFooter, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, TextLink, Wordmark } from './HeritageKit';

/** 1 · Paper Card — the current patient login, tidied: official wordmark in the header, cobalt-strip ledger card. */
export function Heritage1Mobile() {
  return (
    <PhonePage>
      <PhoneStatusBar />
      <header className="flex items-center justify-between px-4 pb-3 pt-2">
        <BackTile />
        <Wordmark height={18} />
        <span className="w-11" aria-hidden="true" />
      </header>

      <div className="flex flex-1 flex-col gap-3.5 px-5 pb-7 pt-2">
        <Kicker>Patient access</Kicker>
        <h1 className="text-[30px] font-bold leading-tight" style={{ fontFamily: SERIF, color: H.navy }}>
          Welcome back
        </h1>

        <Card accentTop>
          <div className="p-[18px]">
            <Field variant="mobile" label="Cell phone number" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your cell number" />
            <div className="mb-2.5 mt-1.5 flex justify-end">
              <TextLink>Use email instead</TextLink>
            </div>
            <Field variant="mobile" label="Password" type="password" autoComplete="current-password" placeholder="Your password" />
            <div className="mb-2.5 mt-1.5 flex justify-end">
              <TextLink>Forgot password?</TextLink>
            </div>
            <PrimaryButton size="lg" className="mt-3.5">
              Continue
            </PrimaryButton>
          </div>
        </Card>

        <PatientFooter className="mt-2" />
      </div>
    </PhonePage>
  );
}
