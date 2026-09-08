import { useState } from 'react';
import { BackTile, Card, Field, H, Kicker, Mark, PatientFooter, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, Segmented, TextLink } from './HeritageKit';

type Channel = 'phone' | 'email';

/** 3 · Tinted Rail — the sidebar's pale-cobalt tint becomes a header band with a Phone / Email segmented control. */
export function Heritage3Mobile() {
  const [channel, setChannel] = useState<Channel>('phone');
  return (
    <PhonePage>
      <section className="border-b border-[#d8e0e9]" style={{ background: H.rail }}>
        <PhoneStatusBar />
        <header className="flex items-center justify-between px-4 pb-3 pt-2">
          <BackTile />
          <Mark size={34} tone="outline" />
          <TextLink tone="muted" className="w-11 text-right">
            Help
          </TextLink>
        </header>
        <div className="px-5 pb-5 pt-2">
          <Kicker>Patient access</Kicker>
          <h1 className="mt-1 text-[30px] font-bold leading-tight" style={{ fontFamily: SERIF, color: H.navy }}>
            Welcome back
          </h1>
          <Segmented
            className="mt-4"
            value={channel}
            onChange={setChannel}
            options={[
              ['phone', 'Cell phone'],
              ['email', 'Email'],
            ]}
          />
        </div>
      </section>

      <div className="flex flex-1 flex-col gap-3.5 px-5 pb-7 pt-5">
        <Card>
          <div className="p-[18px]">
            {channel === 'phone' ? (
              <Field key="phone" variant="mobile" label="Cell phone number" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your cell number" autoFocus />
            ) : (
              <Field key="email" variant="mobile" label="Email address" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" autoFocus />
            )}
            <Field wrapClassName="mt-4" variant="mobile" label="Password" type="password" autoComplete="current-password" placeholder="Your password" trailing={<TextLink size={11.5}>Forgot password?</TextLink>} />
            <PrimaryButton size="lg" className="mt-5">
              Continue
            </PrimaryButton>
          </div>
          <div className="flex items-center justify-between border-t border-[#e8e8e5] bg-[#f9faf8] px-[18px] py-3">
            <span className="text-[11.5px]" style={{ color: H.muted }}>
              Signing in from a new phone?
            </span>
            <TextLink>We’ll text a code</TextLink>
          </div>
        </Card>
        <PatientFooter className="mt-1" />
      </div>
    </PhonePage>
  );
}
