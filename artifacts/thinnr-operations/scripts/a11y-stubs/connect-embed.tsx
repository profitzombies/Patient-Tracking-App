import React, { type ReactNode } from 'react';

export function ConnectEmbed({ children }: { children: ReactNode }) { return <>{children}</>; }
/** The props the latest onboarding render received, so suites can play Stripe's callbacks. */
export const __onboarding: { onExit?: () => void; onStepChange?: (step: string) => void } = {};
export function ConnectOnboarding(props: { onExit?: () => void; onStepChange?: (step: string) => void }) {
  __onboarding.onExit = props.onExit; __onboarding.onStepChange = props.onStepChange;
  return <p>Stripe onboarding</p>;
}