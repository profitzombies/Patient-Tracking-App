/**
 * Node stand-in for @/context/PatientContext: the tab layout only reads
 * `hydrated` (it holds rendering until storage rehydrates), so that is all
 * the stub provides.
 */
export const patientState = { hydrated: true };

export function usePatient(): { hydrated: boolean } {
  return { hydrated: patientState.hydrated };
}
