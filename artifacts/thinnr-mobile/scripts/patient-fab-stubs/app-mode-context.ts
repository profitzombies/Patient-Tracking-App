/**
 * Node stand-in for @/context/AppModeContext — just the hook the patient
 * tab layout reads, with knobs for the suite's guard checks.
 */
let state: { mode: string; hydrated: boolean } = { mode: 'patient', hydrated: true };

export function setAppMode(next: Partial<typeof state>): void {
  state = { ...state, ...next };
}

export function useAppMode(): typeof state {
  return state;
}
