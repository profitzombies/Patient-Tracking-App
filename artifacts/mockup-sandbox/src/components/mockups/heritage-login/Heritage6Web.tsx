import { Clock3, MailCheck } from 'lucide-react';
import { Card, DemoFooter, H, IconTile, Kicker, Mark, Notice, OtpCells, PrimaryButton, SERIF, StaffFootnote, TextLink, WebPage } from './HeritageKit';

/** 6 · Code Step — the second phase of the passwordless flow: six Heritage cells, dev-mode notice, resend. */
export function Heritage6Web() {
  return (
    <WebPage>
      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-5 py-10">
        <header className="mb-8 flex flex-col items-center text-center">
          <Mark size={52} />
          <h1 className="mt-4 text-[34px] font-bold leading-tight tracking-[-.02em]" style={{ fontFamily: SERIF, color: H.navy }}>
            THINNR Operations
          </h1>
        </header>

        <Card accentTop className="mx-auto w-full max-w-[460px]">
          <div className="p-6">
            <div className="flex items-center justify-between">
              <Kicker>Step 2 of 2 · Verify</Kicker>
              <span className="flex gap-1" aria-hidden="true">
                <i className="h-1 w-5 rounded-full bg-[#315eae]" />
                <i className="h-1 w-5 rounded-full bg-[#315eae]" />
              </span>
            </div>
            <div className="mt-4 flex items-start gap-3">
              <IconTile size={40}>
                <MailCheck size={19} />
              </IconTile>
              <div>
                <h2 className="text-[20px] font-bold tracking-[-.01em]" style={{ fontFamily: SERIF, color: H.navy }}>
                  Enter the code we emailed
                </h2>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: H.muted }}>
                  If <span className="font-semibold" style={{ color: H.ink }}>dana@willowvale.clinic</span> has an account, a 6-digit code is on its way. It expires in 10 minutes.
                </p>
              </div>
            </div>

            <OtpCells className="mt-5" value="4821" />

            <div className="mt-3 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: H.body }}>
                <Clock3 size={13} />
                Expires in 09:41
              </span>
              <TextLink tone="muted" size={11.5}>
                Paste from clipboard
              </TextLink>
            </div>

            <Notice className="mt-4">Dev delivery mode — your code is 482 190.</Notice>

            <PrimaryButton className="mt-4">Verify and sign in</PrimaryButton>
            <div className="mt-3 flex items-center justify-center gap-4">
              <TextLink size={12}>Send a fresh code</TextLink>
              <TextLink tone="muted" size={12}>
                Use a different email
              </TextLink>
            </div>
          </div>
        </Card>

        <StaffFootnote className="mt-8" />
      </main>
      <DemoFooter />
    </WebPage>
  );
}
