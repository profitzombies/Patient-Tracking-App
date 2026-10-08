/**
 * Node stand-in for @/context/PatientContext: the tab layout reads the
 * hydration flag plus the admission facts of an onboarded, consented real
 * patient (the only account kind the layout admits), and the sync chip /
 * snackbar shelf read a disabled sync value.
 */
export const patientState = {
  hydrated: true,
  hydratedFlags: { onboardingComplete: true },
  hydratedPrivacy: { consent: { satisfied: true }, deletion: null as null },
};

export function usePatient() {
  return {
    hydrated: patientState.hydrated,
    hydratedFlags: patientState.hydratedFlags,
    hydratedPrivacy: patientState.hydratedPrivacy,
    rehydrate: () => undefined,
  };
}

export function usePatientSyncNotice() {
  return null;
}

/** The offline queue is disabled in this harness, so the chip never renders. */
export function usePatientSync() {
  return {
    enabled: false,
    online: true,
    status: 'idle' as const,
    items: [] as never[],
    pendingCount: 0,
    failedCount: 0,
    slowSync: false,
    justSynced: false,
    isPending: () => false,
    retry: () => undefined,
    retryAll: () => undefined,
    discard: async () => undefined,
  };
}
