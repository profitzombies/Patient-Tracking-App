export const localClearCalls = { patient: 0, coach: 0, mode: [] as string[] };
export const failures = { patient: false, coach: false, mode: false };

export function resetLocalClearCalls() {
  localClearCalls.patient = 0;
  localClearCalls.coach = 0;
  localClearCalls.mode.length = 0;
  failures.patient = false;
  failures.coach = false;
  failures.mode = false;
}

export function usePatient() {
  return { clearLocalState: async () => { localClearCalls.patient += 1; if (failures.patient) throw new Error('patient clear'); } };
}

export function useCoachChat() {
  return { clearLocalState: () => { localClearCalls.coach += 1; if (failures.coach) throw new Error('coach clear'); } };
}

export function useAppMode() {
  return {
    mode: 'patient' as const,
    hydrated: true,
    setMode: async (mode: string) => { localClearCalls.mode.push(mode); if (failures.mode) throw new Error('mode save'); },
  };
}