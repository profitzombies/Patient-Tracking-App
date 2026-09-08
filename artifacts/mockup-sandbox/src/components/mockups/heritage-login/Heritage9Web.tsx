import { Field, H, Kicker, PrimaryButton, SERIF, TextLink, WebPage, Wordmark } from './HeritageKit';

const notes = [
  ['Codes', 'Arrive from ops@getthinnr.com within a minute.'],
  ['Expiry', 'Ten minutes, then request a fresh one.'],
  ['Patients', 'Sign in on the THINNR mobile app, not here.'],
];

/** 9 · Quiet Paper — no card at all: underlined fields on bare paper, generous margins, a hairline notes column. */
export function Heritage9Web() {
  return (
    <WebPage>
      <header className="px-16 pt-10">
        <Wordmark height={28} />
      </header>

      <main className="grid flex-1 gap-20 px-16 pb-16 pt-14 lg:grid-cols-[minmax(0,520px)_1fr]">
        <section>
          <Kicker>Staff sign-in · Work email</Kicker>
          <h1 className="mt-4 text-[64px] leading-[0.98] tracking-[-.03em]" style={{ fontFamily: SERIF, color: H.navy }}>
            Sign in.
          </h1>
          <p className="mt-5 max-w-[42ch] text-[15px] leading-relaxed" style={{ color: H.body }}>
            Enter the work email your office admin invited. We’ll send a six-digit code — there is no password anywhere.
          </p>
          <div className="mt-10 max-w-[420px]">
            <Field variant="underline" label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" />
            <div className="mt-8 flex items-center gap-6">
              <PrimaryButton className="w-auto px-7" arrow>
                Email me a code
              </PrimaryButton>
              <TextLink tone="muted">Browse the guided demo</TextLink>
            </div>
          </div>
        </section>

        <aside className="hidden self-start pt-[104px] lg:block">
          <dl className="ml-auto max-w-[300px] border-l border-[#d8e0e9] pl-6">
            {notes.map(([term, detail]) => (
              <div key={term} className="py-3 first:pt-0 last:pb-0">
                <dt className="text-[10px] font-bold uppercase tracking-[.14em]" style={{ color: H.muted }}>
                  {term}
                </dt>
                <dd className="mt-1 text-[13px] leading-relaxed" style={{ color: H.body }}>
                  {detail}
                </dd>
              </div>
            ))}
          </dl>
        </aside>
      </main>

      <footer className="flex items-center justify-between px-16 pb-8">
        <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: H.muted }}>
          Synthetic Demo Data • Not Medical Advice
        </p>
        <p className="text-[11px]" style={{ color: H.muted }}>
          THINNR Operations · Willow &amp; Vale Med Spa
        </p>
      </footer>
    </WebPage>
  );
}
