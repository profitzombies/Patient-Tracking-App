/**
 * Node stand-in for @/context/PatientContext — just the hydration flag the
 * patient tab layout reads.
 */
let hydrated = true;

export function setPatientHydrated(value: boolean): void {
  hydrated = value;
}

export function usePatient(): { hydrated: boolean } {
  return { hydrated };
}
