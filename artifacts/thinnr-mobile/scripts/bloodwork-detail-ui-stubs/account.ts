export function usePatientAccount() {
  return { account: { kind: 'real' as const, patientId: 'patient-a' } };
}