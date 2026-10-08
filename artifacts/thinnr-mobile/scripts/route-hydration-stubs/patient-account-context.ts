/** Controllable account seam: the layout admits only a resolved real account. */
export const accountState: {
  resolving: boolean;
  kind: 'demo' | 'unresolved' | 'real';
} = {
  resolving: false,
  kind: 'real',
};

export function usePatientAccount() {
  return {
    resolving: accountState.resolving,
    account: accountState.kind === 'real'
      ? { kind: 'real' as const, patientId: 'pat-live', api: {} as never }
      : { kind: accountState.kind },
    accountNotice: null,
    retryResolve: () => undefined,
    getAccessToken: accountState.kind === 'demo' ? undefined : async () => 'token',
  };
}
