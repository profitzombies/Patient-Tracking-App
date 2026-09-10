export const state: {
  hydrated: boolean;
  onboardingComplete: boolean | null;
  consentSatisfied: boolean | null;
  rehydrateCalls: number;
} = {
  hydrated: true,
  onboardingComplete: true,
  consentSatisfied: true,
  rehydrateCalls: 0,
};

export function resetPatient(): void {
  state.hydrated = true;
  state.onboardingComplete = true;
  state.consentSatisfied = true;
  state.rehydrateCalls = 0;
}

export function usePatient() {
  return {
    hydrated: state.hydrated,
    hydratedFlags: { onboardingComplete: state.onboardingComplete },
    hydratedPrivacy: { consent: { satisfied: state.consentSatisfied } },
    rehydrate() {
      state.rehydrateCalls += 1;
    },
  };
}