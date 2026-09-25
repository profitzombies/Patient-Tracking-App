import { InlinePhoneVerify } from '@/components/launch/InlinePhoneVerify';
import type { LaunchState } from '@/hooks/use-launch';
import { DoneRow, StepFrame, WizardFooter } from './ui';

export function securitySummary(security: LaunchState['security']) {
  const parts = [security.emailVerified ? 'Email verified' : null,
    security.phoneVerified ? `Phone verified${security.phoneMasked ? ` · ${security.phoneMasked}` : ''}` : security.phoneRequired ? null : 'A texted code is not required for your role'];
  return parts.filter(Boolean).join(' · ');
}

export function SecurityStep({ launch, readOnly, onBack, onNext }: {
  launch: LaunchState; readOnly: boolean; onBack: () => void; onNext: () => void;
}) {
  const { security } = launch;
  return <StepFrame testId="wizard-step-security" eyebrow="Step 2" title="Secure your account"
    sub={security.ready ? 'Your sign-in is already protected. Nothing to do here.' : 'Your role signs in with an emailed code and a texted code. Verify your mobile number here to finish this step.'}>
    {security.ready
      ? <DoneRow testId="wizard-security-done" title="Account security is set" detail={securitySummary(security) || 'Your sign-in meets the practice requirements.'} />
      : <div className="rounded-lg border border-card-border bg-card shadow-soft">
        <InlinePhoneVerify emailVerified={security.emailVerified} canVerify={!launch.hqInspection} onVerified={() => {}} />
      </div>}
    <WizardFooter onBack={onBack} onContinue={onNext} canContinue={security.ready || readOnly}
      hint="Verify your phone to continue." />
  </StepFrame>;
}
