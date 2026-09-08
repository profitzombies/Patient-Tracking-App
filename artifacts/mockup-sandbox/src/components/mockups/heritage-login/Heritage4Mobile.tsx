import { useState } from 'react';
import { Check, Stethoscope, User } from 'lucide-react';
import { Card, Field, H, IconTile, Kicker, Mark, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, TextLink } from './HeritageKit';

type Role = 'patient' | 'provider';

const roles: Array<{ key: Role; icon: typeof User; title: string; detail: string }> = [
  { key: 'patient', icon: User, title: 'Patient', detail: 'Log meals, check in, message your coach.' },
  { key: 'provider', icon: Stethoscope, title: 'Provider', detail: 'Roster, deliveries, and today’s desk.' },
];

/** 4 · Two Doors — pick Patient or Provider first, then the ledger card adapts. */
export function Heritage4Mobile() {
  const [role, setRole] = useState<Role>('patient');
  return (
    <PhonePage>
      <PhoneStatusBar />
      <header className="flex items-center justify-center px-4 pb-4 pt-2">
        <Mark size={44} />
      </header>

      <div className="flex flex-1 flex-col gap-3.5 px-5 pb-7">
        <Kicker>Welcome to THINNR</Kicker>
        <h1 className="text-[30px] font-bold leading-tight" style={{ fontFamily: SERIF, color: H.navy }}>
          Who’s signing in?
        </h1>

        <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="Choose your role">
          {roles.map(({ key, icon: Icon, title, detail }) => {
            const on = key === role;
            return (
              <button key={key} type="button" role="radio" aria-checked={on} onClick={() => setRole(key)} className={`relative rounded-[9px] border bg-[#fdfcf9] p-3.5 text-left transition ${on ? 'border-[#315eae] ring-2 ring-[#315eae]/15' : 'border-[#d8e0e9] hover:border-[#b7cbe8]'}`} style={{ boxShadow: '0 6px 15px rgba(40,55,74,.06)' }}>
                {on ? (
                  <span className="absolute right-2.5 top-2.5 grid h-5 w-5 place-items-center rounded-full bg-[#315eae] text-white">
                    <Check size={12} strokeWidth={3} />
                  </span>
                ) : null}
                <IconTile size={36} tone={on ? 'chip' : 'card'}>
                  <Icon size={17} />
                </IconTile>
                <p className="mt-3 text-[17px]" style={{ fontFamily: SERIF, color: H.navy }}>
                  {title}
                </p>
                <p className="mt-0.5 text-[11px] leading-4" style={{ color: H.muted }}>
                  {detail}
                </p>
              </button>
            );
          })}
        </div>

        <Card accentTop>
          <div className="p-[18px]">
            {role === 'patient' ? (
              <>
                <Field key="phone" variant="mobile" label="Cell phone number" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your cell number" trailing={<TextLink size={11.5}>Use email instead</TextLink>} />
                <Field wrapClassName="mt-4" variant="mobile" label="Password" type="password" autoComplete="current-password" placeholder="Your password" trailing={<TextLink size={11.5}>Forgot password?</TextLink>} />
              </>
            ) : (
              <>
                <Field key="work" variant="mobile" label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" />
                <p className="mt-2 text-[11px] leading-relaxed" style={{ color: H.muted }}>
                  We’ll email you a 6-digit sign-in code. No password needed.
                </p>
              </>
            )}
            <PrimaryButton size="lg" className="mt-5">
              {role === 'patient' ? 'Continue' : 'Email me a code'}
            </PrimaryButton>
          </div>
        </Card>

        <div className="mt-1 flex flex-col items-center gap-3">
          <TextLink size={13.5} className="font-bold">
            Create new account
          </TextLink>
          <TextLink tone="muted">Explore demo</TextLink>
        </div>
      </div>
    </PhonePage>
  );
}
