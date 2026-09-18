export const patientState = { hydrated: true };

export function usePatient(): {
  hydrated: boolean;
  hydratedFlags: null;
  hydratedPrivacy: null;
  rehydrate: () => void;
} {
  return {
    hydrated: patientState.hydrated,
    hydratedFlags: null,
    hydratedPrivacy: null,
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