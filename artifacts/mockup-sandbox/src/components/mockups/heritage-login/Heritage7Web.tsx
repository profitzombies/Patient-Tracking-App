import { Smartphone } from 'lucide-react';
import { Card, DemoFooter, Field, H, Kicker, Mark, PrimaryButton, SERIF, TextLink, WebPage, Wordmark } from './HeritageKit';

const steps = [
  ['01', 'Enter your work email', 'The address your office admin invited.'],
  ['02', 'Type the 6-digit code', 'It lands in your inbox within a minute and expires in ten.'],
  ['03', 'Land on your desk', 'HQ admins see the umbrella overview; office teams see today’s desk.'],
];

/** 7 · Editorial Steps — a Playfair headline and numbered three-step rail beside a compact card. */
export function Heritage7Web() {
  return (
    <WebPage>
      <header className="mx-auto flex w-full max-w-[1120px] items-center justify-between px-8 pt-7">
        <Wordmark height={26} />
        <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: H.muted }}>
          <Smartphone size={14} />
          Patients: THINNR mobile app
        </span>
      </header>

      <main className="mx-auto grid w-full max-w-[1120px] flex-1 items-center gap-16 px-8 pb-12 pt-6 lg:grid-cols-[1.15fr_1fr]">
        <section>
          <Kicker>Staff sign-in</Kicker>
          <h1 className="mt-3 max-w-[13ch] text-[56px] leading-[1.0] tracking-[-.025em]" style={{ fontFamily: SERIF, color: H.navy }}>
            Three steps between you and today’s desk.
          </h1>
          <ol className="mt-9 max-w-[520px]">
            {steps.map(([number, title, detail], index) => (
              <li key={number} className="grid grid-cols-[56px_1fr] gap-4 border-t border-[#e8e8e5] py-4" style={index === steps.length - 1 ? { borderBottom: `1px solid ${H.divider}` } : undefined}>
                <span className="text-[26px] leading-none" style={{ fontFamily: SERIF, color: index === 0 ? H.cobalt : H.cobaltMuted }}>
                  {number}
                </span>
                <div>
                  <p className="text-[14px] font-semibold" style={{ color: index === 0 ? H.navy : H.body }}>
                    {title}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed" style={{ color: H.muted }}>
                    {detail}
                  </p>
                  {index === 0 ? <i className="mt-2 block h-1 w-5" style={{ background: H.orange }} aria-hidden="true" /> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <Card accentTop className="w-full max-w-[420px] justify-self-end">
          <div className="p-6">
            <div className="flex items-center gap-3">
              <Mark size={36} />
              <div className="leading-tight">
                <p className="text-[13px] font-semibold" style={{ color: H.navy }}>
                  THINNR Operations
                </p>
                <p className="text-[11px]" style={{ color: H.muted }}>
                  Step 1 · Work email
                </p>
              </div>
            </div>
            <Field wrapClassName="mt-6" label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" hint="We’ll email you a 6-digit sign-in code. No password needed." />
            <PrimaryButton className="mt-4" arrow>
              Email me a code
            </PrimaryButton>
            <div className="mt-4 text-center">
              <TextLink tone="muted">Browse the guided demo without an account</TextLink>
            </div>
          </div>
        </Card>
      </main>
      <DemoFooter />
    </WebPage>
  );
}
