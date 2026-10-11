export const SIGNED_OUT_ACCOUNT_STATE = {
  resolving: false,
  account: { kind: 'signed-out' as const },
  accountNotice: null,
  retryResolve: () => {},
};

export function usePatientAccount() {
  return SIGNED_OUT_ACCOUNT_STATE;
}
