export type TestAccount =
  | { kind: 'real'; patientId: string }
  | { kind: 'demo' }
  | { kind: 'unresolved' };

export const state: {
  account: TestAccount;
  resolving: boolean;
  retryCalls: number;
  getTokenCalls: number;
} = {
  account: { kind: 'real', patientId: 'patient-a' },
  resolving: false,
  retryCalls: 0,
  getTokenCalls: 0,
};

export function resetAccount(): void {
  state.account = { kind: 'real', patientId: 'patient-a' };
  state.resolving = false;
  state.retryCalls = 0;
  state.getTokenCalls = 0;
}

export function usePatientAccount() {
  return {
    account: state.account,
    resolving: state.resolving,
    retryResolve() {
      state.retryCalls += 1;
    },
    async getAccessToken() {
      state.getTokenCalls += 1;
      return 'test-access-token';
    },
  };
}