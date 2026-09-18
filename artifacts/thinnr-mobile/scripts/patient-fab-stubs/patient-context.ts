/**
 * Node stand-in for @/context/PatientContext: the tab layout only reads
 * `hydrated` (it holds rendering until storage rehydrates), and the sync
 * chip / snackbar shelf read the (disabled, demo-style) sync value.
 */
export const patientState = { hydrated: true };

export function usePatient(): { hydrated: boolean } {
  return { hydrated: patientState.hydrated };
}

export function usePatientSyncNotice() {
  return null;
}

/** Demo posture: the offline queue is disabled, so the chip never renders. */
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
