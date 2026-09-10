export function usePatient() {
  return {
    hydrated: true,
    hydratedFlags: { onboardingComplete: true },
    hydratedPrivacy: { consent: { satisfied: true } },
    rehydrate: () => undefined,
  };
}