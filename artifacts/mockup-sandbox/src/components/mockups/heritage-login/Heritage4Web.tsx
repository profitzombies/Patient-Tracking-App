import { Building2, Stethoscope } from 'lucide-react';
import { Card, DemoFooter, Field, H, IconTile, Kicker, Mark, OutlineButton, PrimaryButton, SERIF, StaffFootnote, WebPage } from './HeritageKit';

const personas = [
  {
    icon: Building2,
    title: 'THINNR HQ admin',
    description: 'The umbrella above every office: rollups, provider accounts, and org tools.',
    cta: 'Enter HQ admin',
  },
  {
    icon: Stethoscope,
    title: 'Office staff',
    description: 'Today’s operations desk for the med spa team, exactly as it runs day to day.',
    cta: 'Enter the office',
  },
];

/** 4 · Two Doors — sign-in card beside the guided-demo persona cards, joined by an "or" hairline. */
export function Heritage4Web() {
  return (
    <WebPage>
      <main className="mx-auto flex w-full max-w-[960px] flex-1 flex-col justify-center px-6 py-10">
        <header className="mb-8 flex flex-col items-center text-center">
          <Mark size={52} />
          <h1 className="mt-4 text-[34px] font-bold leading-tight tracking-[-.02em]" style={{ fontFamily: SERIF, color: H.navy }}>
            THINNR Operations
          </h1>
          <p className="mt-2 max-w-[54ch] text-sm leading-relaxed" style={{ color: H.muted }}>
            Staff sign in with a one-time email code. Just looking? The guided demo opens either desk without an account.
          </p>
        </header>

        <div className="grid items-stretch gap-6 lg:grid-cols-[1fr_auto_1fr]">
          <Card accentTop>
            <div className="flex h-full flex-col p-6">
              <Kicker>Sign in</Kicker>
              <h2 className="mt-1.5 text-[22px] font-bold tracking-[-.01em]" style={{ fontFamily: SERIF, color: H.navy }}>
                Your work email
              </h2>
              <Field wrapClassName="mt-5" label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" hint="We’ll email you a 6-digit sign-in code. No password needed." />
              <ol className="mt-5 border-t border-[#e8e8e5]">
                {['We email a 6-digit code to that address', 'You type it here — it lasts 10 minutes', 'You land on the HQ overview or today’s desk'].map((step, index) => (
                  <li key={step} className="flex items-center gap-3 border-b border-[#e8e8e5] py-2.5 text-[12px]" style={{ color: H.body }}>
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#e3ecf7] text-[10px] font-bold" style={{ color: H.cobalt }}>
                      {index + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
              <PrimaryButton className="mt-auto" arrow>
                Email me a code
              </PrimaryButton>
            </div>
          </Card>

          <div className="relative hidden w-8 items-center justify-center lg:flex" aria-hidden="true">
            <span className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-[#d8e0e9]" />
            <span className="relative grid h-8 w-8 place-items-center rounded-full border border-[#d8e0e9] bg-[#f2f3f4] text-[10px] font-bold uppercase tracking-[.08em]" style={{ color: H.muted }}>
              or
            </span>
          </div>

          <div className="flex flex-col gap-3">
            <Kicker className="px-1">Browse the guided demo</Kicker>
            {personas.map(({ icon: Icon, title, description, cta }) => (
              <Card key={title} className="flex-1">
                <div className="flex h-full flex-col p-4">
                  <div className="flex items-center gap-2.5">
                    <IconTile size={32}>
                      <Icon size={17} />
                    </IconTile>
                    <h3 className="text-[16px] font-bold tracking-[-.01em]" style={{ fontFamily: SERIF, color: H.navy }}>
                      {title}
                    </h3>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed" style={{ color: H.muted }}>
                    {description}
                  </p>
                  <OutlineButton className="mt-auto" arrow>
                    {cta}
                  </OutlineButton>
                </div>
              </Card>
            ))}
          </div>
        </div>

        <StaffFootnote className="mt-8" />
      </main>
      <DemoFooter />
    </WebPage>
  );
}
