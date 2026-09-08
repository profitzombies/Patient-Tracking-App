import { ChevronDown } from 'lucide-react';
import { Card, DemoFooter, Field, H, Kicker, PrimaryButton, SERIF, StaffFootnote, WebPage, Wordmark } from './HeritageKit';

/** 1 · Paper Card — the current staff sign-in, tidied: official wordmark, cobalt-strip card, step rail. */
export function Heritage1Web() {
  return (
    <WebPage>
      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-5 py-10">
        <header className="mb-8 flex flex-col items-center text-center">
          <Wordmark height={30} />
          <Kicker className="mt-3">Operations · Staff sign-in</Kicker>
          <h1 className="mt-3 text-[34px] font-bold leading-tight tracking-[-.02em]" style={{ fontFamily: SERIF, color: H.navy }}>
            Sign in to today’s desk
          </h1>
          <p className="mx-auto mt-2 max-w-[50ch] text-sm leading-relaxed" style={{ color: H.muted }}>
            Use your work email and we’ll send a one-time code. HQ admins land on the umbrella overview; office teams land on today’s desk.
          </p>
        </header>

        <Card accentTop className="mx-auto w-full max-w-[430px]">
          <div className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <Kicker>Step 1 of 2 · Work email</Kicker>
              <span className="flex gap-1" aria-hidden="true">
                <i className="h-1 w-5 rounded-full bg-[#315eae]" />
                <i className="h-1 w-5 rounded-full bg-[#d8e0e9]" />
              </span>
            </div>
            <Field label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" hint="We’ll email you a 6-digit sign-in code. No password needed." />
            <PrimaryButton className="mt-4" arrow>
              Email me a code
            </PrimaryButton>
          </div>
        </Card>

        <div className="mt-6 text-center">
          <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold transition hover:text-[#26364b]" style={{ color: H.muted }}>
            Exploring? Browse the guided demo without an account
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
        <StaffFootnote className="mt-6" />
      </main>
      <DemoFooter />
    </WebPage>
  );
}
