export const patientState: {
  hydrated: boolean;
  hydratedFlags: { onboardingComplete: boolean } | null;
  hydratedPrivacy: { consent: { satisfied: boolean }; deletion: null } | null;
} = {
  hydrated: true,
  hydratedFlags: { onboardingComplete: true },
  hydratedPrivacy: { consent: { satisfied: true }, deletion: null },
};

export function usePatient() {
  return {
    hydrated: patientState.hydrated,
    hydratedFlags: patientState.hydratedFlags,
    hydratedPrivacy: patientState.hydratedPrivacy,
    rehydrate: () => undefined,
  };
}

export function usePatientSyncNotice(): null {
  return null;
}

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
