export function usePatientAccount() {
  return {
    resolving: false,
    account: { kind: 'demo' as const },
  };
}