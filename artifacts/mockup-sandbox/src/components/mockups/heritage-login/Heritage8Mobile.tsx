import { Utensils } from 'lucide-react';
import { BackTile, Card, Field, H, HERO, Kicker, PatientFooter, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, TextLink, Wordmark } from './HeritageKit';

/** 8 · Framed Plate — the food photo framed inside the ledger card itself, form beneath it. */
export function Heritage8Mobile() {
  return (
    <PhonePage>
      <PhoneStatusBar />
      <header className="flex items-center justify-between px-4 pb-3 pt-2">
        <BackTile />
        <Wordmark height={18} />
        <span className="w-11" aria-hidden="true" />
      </header>

      <div className="flex flex-1 flex-col gap-3.5 px-5 pb-7 pt-2">
        <Card lifted>
          <div className="relative h-[176px]">
            <img src={HERO} alt="Grilled salmon bowl with greens" className="absolute inset-0 h-full w-full object-cover object-center" />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(245,247,249,.1)_0%,rgba(245,247,249,0)_40%,#fdfcf9_100%)]" />
            <div className="absolute inset-x-0 bottom-0 px-[18px] pb-1">
              <span className="inline-flex items-center gap-1.5 rounded-[5px] border border-[#e8b47c] bg-[#fff4e6] px-2 py-1 text-[9px] font-bold uppercase tracking-wide" style={{ color: H.warn }}>
                <Utensils size={11} />
                Approved list
              </span>
              <p className="mt-1.5 text-[19px] leading-tight" style={{ fontFamily: SERIF, color: H.navy }}>
                Saturday’s plate is waiting on your Today tab.
              </p>
            </div>
          </div>
          <div className="px-[18px] pb-[18px] pt-3">
            <Kicker>Patient access</Kicker>
            <h1 className="mt-1 text-[26px] font-bold leading-tight" style={{ fontFamily: SERIF, color: H.navy }}>
              Welcome back
            </h1>
            <Field wrapClassName="mt-4" variant="mobile" label="Cell phone number" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your cell number" trailing={<TextLink size={11.5}>Use email instead</TextLink>} />
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
