export const DEMO_ACCOUNT_STATE = {
  resolving: false,
  account: { kind: 'demo' as const },
  accountNotice: null,
  retryResolve: () => {},
};

export function usePatientAccount() {
  return DEMO_ACCOUNT_STATE;
}