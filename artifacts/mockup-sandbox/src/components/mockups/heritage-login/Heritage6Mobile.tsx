import { MessageSquareText } from 'lucide-react';
import { BackTile, Card, H, IconTile, Kicker, Mark, Notice, OtpCells, PatientFooter, PhonePage, PhoneStatusBar, PrimaryButton, SERIF, TextLink } from './HeritageKit';

/** 6 · Code Step — the SMS verification phase: six large Heritage cells, resend timer, sent notice. */
export function Heritage6Mobile() {
  return (
    <PhonePage>
      <PhoneStatusBar />
      <header className="flex items-center justify-between px-4 pb-3 pt-2">
        <BackTile />
        <Mark size={34} tone="outline" />
        <span className="w-11" aria-hidden="true" />
      </header>

      <div className="flex flex-1 flex-col gap-3.5 px-5 pb-7 pt-2">
        <Kicker>Patient access</Kicker>
        <h1 className="text-[30px] font-bold leading-tight" style={{ fontFamily: SERIF, color: H.navy }}>
          Verify your sign-in
        </h1>

        <Card accentTop>
          <div className="p-[18px]">
            <div className="flex items-start gap-3">
              <IconTile size={40}>
                <MessageSquareText size={19} />
              </IconTile>
              <p className="text-[13.5px] leading-5" style={{ color: H.body }}>
                Enter the 6-digit code we texted to <span className="font-semibold" style={{ color: H.ink }}>(•••) •••-4821</span>. It expires in 10 minutes.
              </p>
            </div>
            <p className="mt-5 text-[10.5px] font-bold uppercase tracking-[.13em]" style={{ color: H.muted }}>
              Verification code
            </p>
            <OtpCells className="mt-2" value="48" size="lg" />
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[12px] font-semibold" style={{ color: H.muted }}>
                Resend code in 0:42
              </span>
              <TextLink size={12}>Didn’t get it?</TextLink>
            </div>
            <Notice tone="ok" className="mt-4">
              Code sent · 9:41 AM
            </Notice>
            <PrimaryButton size="lg" className="mt-4">
              Verify
            </PrimaryButton>
          </div>
        </Card>

        <PatientFooter className="mt-2" phase="other" />
      </div>
    </PhonePage>
  );
}
