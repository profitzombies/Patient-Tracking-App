import { Sparkles } from 'lucide-react';
import { Card, Field, H, Kicker, Mark, PatientFooter, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, SerifWordmark, TextLink } from './HeritageKit';

/** 10 · Today Preview — the ledger card floats over a faded, scrimmed glimpse of the Today tab. */
export function Heritage10Mobile() {
  return (
    <PhonePage className="overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 select-none" aria-hidden="true">
        <div className="origin-top px-5 pt-14" style={{ transform: 'scale(.96)', opacity: 0.9 }}>
          <div className="flex items-center justify-between">
            <SerifWordmark size={22} />
            <span className="grid h-8 w-8 place-items-center rounded-[7px] bg-[#315eae] text-[10px] font-bold text-white">ES</span>
          </div>
          <p className="mt-5 text-[26px] leading-none" style={{ fontFamily: SERIF, color: H.navy }}>
            Welcome back, Emma
          </p>
          <div className="mt-4 flex items-center gap-2 rounded-[8px] border border-[#c8d7e6] bg-[#e5edf7] px-3.5 py-3" style={{ boxShadow: '0 9px 19px rgba(34,58,88,.16)' }}>
            <Sparkles size={15} style={{ color: '#3664a5' }} />
            <span className="text-[9px] font-bold tracking-[.12em]" style={{ color: '#54708d' }}>
              TODAY’S FOCUS
            </span>
            <span className="ml-auto text-[16px]" style={{ fontFamily: SERIF, color: H.navy }}>
              Getting enough sleep?
            </span>
          </div>
          <Card accentTop className="mt-4">
            <div className="px-4 pb-4 pt-3">
              <div className="flex items-center justify-between">
                <p className="text-[18px]" style={{ fontFamily: SERIF, color: '#243f66' }}>
                  Your day at a glance
                </p>
                <span className="rounded-[5px] border border-[#e8b47c] bg-[#fff4e6] px-2 py-1 text-[9px] font-bold uppercase tracking-wide" style={{ color: H.warn }}>
                  7 of 7 logged
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between border-y border-[#e8e8e5] py-2.5">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                  <div key={`${day}${index}`} className="flex flex-col items-center gap-1">
                    <span className="text-[10px]" style={{ color: '#7d8791' }}>
                      {day}
                    </span>
                    <span className={`h-2 w-2 ${index === 6 ? 'bg-[#315eae] ring-4 ring-[#dce8f4]' : 'bg-[#df772c]'}`} />
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-end justify-between">
                <div>
                  <Kicker>Calories for today</Kicker>
                  <p className="mt-1 text-[40px] leading-none" style={{ fontFamily: SERIF, color: '#243f66' }}>
                    568
                  </p>
                </div>
                <span className="text-[11px] font-semibold" style={{ color: H.body }}>
                  remaining
                </span>
              </div>
            </div>
          </Card>
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(242,243,244,.35)_0%,rgba(242,243,244,.65)_55%,#f2f3f4_100%)]" />
      </div>

      <div className="relative z-10 flex flex-1 flex-col">
        <PhoneStatusBar />
        <div className="mt-auto flex flex-col gap-3.5 px-5 pb-7 pt-[330px]">
          <Card lifted>
            <div className="p-[18px]">
              <div className="flex items-center gap-3">
                <Mark size={36} />
                <div className="leading-tight">
                  <Kicker>Patient access</Kicker>
                  <p className="text-[20px] font-bold" style={{ fontFamily: SERIF, color: H.navy }}>
                    Welcome back
                  </p>
                </div>
              </div>
              <Field wrapClassName="mt-4" variant="mobile" label="Cell phone number" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your cell number" trailing={<TextLink size={11.5}>Use email instead</TextLink>} />
              <Field wrapClassName="mt-4" variant="mobile" label="Password" type="password" autoComplete="current-password" placeholder="Your password" trailing={<TextLink size={11.5}>Forgot password?</TextLink>} />
              <PrimaryButton size="lg" className="mt-5">
                Continue
              </PrimaryButton>
            </div>
          </Card>
          <PatientFooter className="mt-1" />
        </div>
      </div>
    </PhonePage>
  );
}
